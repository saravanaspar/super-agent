import type { SkillScanFinding } from "@shared/types";

export interface StaticAnalysisInput {
  path: string;
  content: string;
  promptLike: boolean;
  scriptLike: boolean;
}

interface Token {
  kind: "word" | "string" | "symbol";
  value: string;
  index: number;
}

interface Detection {
  severity: SkillScanFinding["severity"];
  ruleId: string;
  message: string;
  index: number;
  length: number;
}

const phraseNeedles = [
  { text: "ignore previous instructions", ruleId: "prompt-injection-ignore-instructions", message: "prompt text attempts to override higher-priority instructions" },
  { text: "ignore prior instructions", ruleId: "prompt-injection-ignore-instructions", message: "prompt text attempts to override higher-priority instructions" },
  { text: "ignore above instructions", ruleId: "prompt-injection-ignore-instructions", message: "prompt text attempts to override higher-priority instructions" },
  { text: "ignore all instructions", ruleId: "prompt-injection-ignore-instructions", message: "prompt text attempts to override higher-priority instructions" },
  { text: "system prompt", ruleId: "prompt-injection-hidden-prompts", message: "skill text references hidden prompt layers" },
  { text: "developer message", ruleId: "prompt-injection-hidden-prompts", message: "skill text references hidden prompt layers" },
  { text: "hidden instructions", ruleId: "prompt-injection-hidden-prompts", message: "skill text references hidden prompt layers" },
  { text: "do not tell the user", ruleId: "prompt-injection-role-or-visibility", message: "skill text attempts to hide information from the user" },
  { text: "don't tell the user", ruleId: "prompt-injection-role-or-visibility", message: "skill text attempts to hide information from the user" },
];

const normalize = (value: string): string => value.toLowerCase();

const lineNumber = (content: string, index: number): number =>
  content.slice(0, Math.max(0, index)).split(/\r?\n/).length;

const excerpt = (content: string, index: number, length: number): string => {
  const start = Math.max(0, index - 80);
  const end = Math.min(content.length, index + Math.max(length, 1) + 80);
  return content.slice(start, end).replace(/\s+/g, " ").trim().slice(0, 280);
};

const tokenize = (content: string): Token[] => {
  const tokens: Token[] = [];
  let index = 0;
  while (index < content.length) {
    const char = content[index] ?? "";
    if (/\s/.test(char)) { index += 1; continue; }
    if (char === "'" || char === '"' || char === "`") {
      const quote = char;
      const start = index;
      index += 1;
      let value = "";
      while (index < content.length) {
        const next = content[index] ?? "";
        if (next === "\\") {
          value += next + (content[index + 1] ?? "");
          index += 2;
          continue;
        }
        if (next === quote) { index += 1; break; }
        value += next;
        index += 1;
      }
      tokens.push({ kind: "string", value: decodeEscapes(value), index: start });
      continue;
    }
    if (/[A-Za-z0-9_$./~-]/.test(char)) {
      const start = index;
      let value = "";
      while (index < content.length && /[A-Za-z0-9_$./~-]/.test(content[index] ?? "")) {
        value += content[index];
        index += 1;
      }
      tokens.push({ kind: "word", value: normalize(value), index: start });
      continue;
    }
    tokens.push({ kind: "symbol", value: char, index });
    index += 1;
  }
  return tokens;
};

const decodeEscapes = (value: string): string =>
  value
    .replace(/\\x([0-9a-fA-F]{2})/g, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/\\u\{?([0-9a-fA-F]{4,6})\}?/g, (_match, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)));

const base64Candidates = (tokens: Token[]): Array<{ value: string; index: number }> =>
  tokens.filter((token) => token.kind === "string" && token.value.length >= 24 && token.value.length <= 4096 && token.value.length % 4 === 0)
    .flatMap((token) => {
      try {
        const decoded = Buffer.from(token.value, "base64").toString("utf8");
        if (!decoded || decoded.replace(/[\x09\x0a\x0d\x20-\x7e]/g, "").length > decoded.length / 4) return [];
        return [{ value: decoded, index: token.index }];
      } catch {
        return [];
      }
    });

const hasAny = (tokens: Token[], values: string[]): boolean =>
  tokens.some((token) => values.includes(token.value));

const firstTokenIndex = (tokens: Token[], values: string[]): number =>
  tokens.find((token) => values.includes(token.value))?.index ?? 0;

const detectPrompts = (content: string): Detection[] => {
  const lower = normalize(content);
  const findings: Detection[] = [];
  for (const phrase of phraseNeedles) {
    const index = lower.indexOf(phrase.text);
    if (index >= 0) findings.push({ severity: "critical", ruleId: phrase.ruleId, message: phrase.message, index, length: phrase.text.length });
  }
  const without = lower.indexOf("without");
  if (without >= 0 && ["run", "execute", "invoke", "call"].some((verb) => lower.includes(verb)) && ["permission", "approval"].some((noun) => lower.includes(noun))) {
    findings.push({ severity: "critical", ruleId: "prompt-injection-tool-approval-bypass", message: "skill text encourages bypassing tool approval", index: without, length: 120 });
  }
  const hidden = lower.indexOf("display:none");
  if (lower.includes("<!--") && ["ignore", "override", "system", "secret", "hidden"].some((term) => lower.includes(term))) {
    findings.push({ severity: "critical", ruleId: "prompt-injection-hidden-html", message: "skill text contains hidden HTML instructions", index: lower.indexOf("<!--"), length: 160 });
  } else if (hidden >= 0 || lower.includes("display: none")) {
    findings.push({ severity: "critical", ruleId: "prompt-injection-hidden-html", message: "skill text contains hidden HTML instructions", index: Math.max(0, hidden), length: 80 });
  }
  return findings;
};

const detectScripts = (content: string): Detection[] => {
  const tokens = tokenize(content);
  const values = tokens.map((token) => token.value);
  const text = values.join(" ");
  const findings: Detection[] = [];
  const add = (ruleId: string, severity: SkillScanFinding["severity"], message: string, needles: string[], length = 120): void => {
    findings.push({ ruleId, severity, message, index: firstTokenIndex(tokens, needles), length });
  };
  const envReads = ["process.env", "os.environ", "getenv", "env", "dotenv" ];
  const netCalls = ["fetch", "axios", "request", "requests.get", "requests.post", "urllib.request.urlopen", "http.request", "https.request", "curl", "wget", "socket"];
  const evalCalls = ["eval", "function", "exec", "spawn", "subprocess.run", "subprocess.popen", "os.system", "child_process.exec", "child_process.spawn"];

  if ((values.includes("curl") || values.includes("wget")) && ["sh", "bash", "zsh"].some((shell) => values.includes(shell)) && content.includes("|")) {
    add("shell-pipe-to-shell", "critical", "skill content includes a pipe-to-shell install pattern", ["curl", "wget"]);
  }
  if (hasAny(tokens, envReads) && hasAny(tokens, netCalls)) {
    add("secret-exfiltration", "critical", "skill content may exfiltrate environment variables", envReads);
  }
  if (hasAny(tokens, evalCalls) && (hasAny(tokens, netCalls) || hasAny(tokens, envReads))) {
    add("dynamic-code-with-sensitive-or-network-input", "critical", "skill script combines dynamic execution with network or environment access", evalCalls);
  }
  if (hasAny(tokens, ["cat", "open", "readfilesync", "readfile"]) && [".env", "credentials", ".netrc", ".pgpass", ".npmrc", ".pypirc"].some((secret) => text.includes(secret))) {
    add("secret-file-read", "critical", "skill content reads known credential files", ["cat", "open", "readfilesync", "readfile"]);
  }
  if (["~/.ssh", "$home/.ssh", "~/.aws", "$home/.aws", "~/.gnupg", "~/.kube", "~/.docker"].some((path) => text.includes(path))) {
    add("ssh-or-cloud-credential-access", "critical", "skill content references user credential directories", ["~/.ssh", "~/.aws"]);
  }
  if ((values.includes("nc") || values.includes("ncat") || values.includes("bash") || values.includes("sh")) && (text.includes("/dev/tcp") || text.includes(" -e ") || text.includes(" --exec "))) {
    add("reverse-shell", "critical", "skill content appears to contain a reverse shell pattern", ["/dev/tcp", "nc", "ncat"]);
  }
  if (["crontab", "launchagents", "launchdaemons", "systemctl", "schtasks"].some((term) => text.includes(term))) {
    add("persistence-cron-or-launch-agent", "critical", "skill content appears to access or create persistence mechanisms", ["crontab", "systemctl", "schtasks"]);
  }
  if (["writefilesync", "writefile", "open", "tee"].some((term) => text.includes(term)) && ["/etc/", "/usr/", "/var/", "/root/", ".ssh", ".aws", ".kube", ".docker"].some((path) => text.includes(path))) {
    add("script-system-write", "critical", "skill script appears to write or modify sensitive host paths", ["writefilesync", "writefile", "tee"]);
  }
  if (text.includes("rm -rf /") || text.includes("rm -rf ~") || text.includes("rm -rf $home") || text.includes("rm -rf .")) {
    add("destructive-delete", "warn", "skill content contains a broad destructive delete command", ["rm"]);
  }
  if (text.includes("chmod 777") || text.includes("chmod -r 777")) {
    add("unsafe-permissions", "warn", "skill content contains unsafe permission changes", ["chmod"]);
  }
  for (const candidate of base64Candidates(tokens)) {
    const nested = detectScripts(candidate.value);
    if (nested.some((finding) => finding.severity === "critical")) {
      findings.push({ severity: "critical", ruleId: "obfuscated-payload-critical", message: "skill content contains encoded dangerous script content", index: candidate.index, length: Math.min(candidate.value.length, 160) });
      break;
    }
  }
  return findings;
};

export const analyzeSkillContent = (input: StaticAnalysisInput): SkillScanFinding[] => {
  const findings = [
    ...(input.promptLike ? detectPrompts(input.content) : []),
    ...(input.scriptLike || input.promptLike ? detectScripts(input.content) : []),
  ];
  const seen = new Set<string>();
  return findings.flatMap((finding): SkillScanFinding[] => {
    const key = `${finding.ruleId}:${finding.index}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{
      severity: finding.severity,
      ruleId: finding.ruleId,
      message: finding.message,
      path: input.path,
      line: lineNumber(input.content, finding.index),
      excerpt: excerpt(input.content, finding.index, finding.length),
    }];
  });
};

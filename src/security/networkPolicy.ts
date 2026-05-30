import dns from "node:dns/promises";
import net from "node:net";
import type { AgentBehaviorSettings } from "@shared/types";

export interface NetworkValidationOptions {
  allowLocalhost?: boolean;
  allowPrivateNetwork?: boolean;
}

export const normalizeHostname = (hostname: string): string => {
  let host = hostname.trim().toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  while (host.endsWith(".")) host = host.slice(0, -1);
  return host;
};

const ipv4Parts = (address: string): number[] | null => {
  const parts = address.split(".").map(Number);
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return null;
  }
  return parts;
};

const ipv4FromMappedIpv6 = (address: string): string | null => {
  const host = normalizeHostname(address);
  if (!host.startsWith("::ffff:")) return null;
  const mapped = host.slice("::ffff:".length);
  if (net.isIP(mapped) === 4) return mapped;

  const hexParts = mapped.split(":");
  if (hexParts.length !== 2) return null;
  const high = Number.parseInt(hexParts[0] ?? "", 16);
  const low = Number.parseInt(hexParts[1] ?? "", 16);
  if (!Number.isInteger(high) || !Number.isInteger(low)) return null;
  if (high < 0 || high > 0xffff || low < 0 || low > 0xffff) return null;

  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
};

export const isLoopbackIp = (address: string): boolean => {
  const host = normalizeHostname(address);
  const mapped = ipv4FromMappedIpv6(host);
  if (mapped) return isLoopbackIp(mapped);
  if (net.isIP(host) === 4) return host.startsWith("127.") || host === "0.0.0.0";
  return host === "::1";
};

export const isPrivateOrReservedIp = (address: string): boolean => {
  const host = normalizeHostname(address);
  const mapped = ipv4FromMappedIpv6(host);
  if (mapped) return isPrivateOrReservedIp(mapped);

  if (net.isIP(host) === 4) {
    const parts = ipv4Parts(host);
    if (!parts) return true;
    const [a = 0, b = 0] = parts;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 192 && b === 0) ||
      (a === 192 && b === 0 && parts[2] === 2) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && parts[2] === 100) ||
      (a === 203 && b === 0 && parts[2] === 113)
    );
  }

  if (net.isIP(host) === 6) {
    const value = host.toLowerCase();
    return (
      value === "::" ||
      value === "::1" ||
      value.startsWith("64:ff9b:") ||
      value.startsWith("fc") ||
      value.startsWith("fd") ||
      value.startsWith("fe80:") ||
      value.startsWith("2001:db8:") ||
      value.startsWith("ff")
    );
  }

  return true;
};

export const isLocalHostname = (hostname: string): boolean => {
  const host = normalizeHostname(hostname);
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "ip6-localhost" ||
    host === "ip6-loopback"
  );
};

export interface ResolvedHttpUrl {
  url: URL;
  hostname: string;
  address?: string;
  family?: 4 | 6;
}

const assertSafeAddress = (
  address: string,
  hostname: string,
  options: NetworkValidationOptions
): void => {
  if (isLoopbackIp(address)) {
    if (options.allowLocalhost === true) return;
    throw new Error(`Blocked hostname resolving to loopback address: ${address}`);
  }

  if (
    isPrivateOrReservedIp(address) &&
    options.allowPrivateNetwork !== true
  ) {
    throw new Error(
      `Blocked hostname resolving to private or reserved address: ${address}`
    );
  }

  if (!hostname) {
    throw new Error(`Blocked invalid network address: ${address}`);
  }
};

export const resolveHttpUrlForNetworkAccess = async (
  rawUrl: string,
  options: NetworkValidationOptions = {}
): Promise<ResolvedHttpUrl> => {
  const parsed = new URL(rawUrl);

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Only http and https URLs are supported");
  }

  if (parsed.username || parsed.password) {
    throw new Error("URLs with embedded credentials are not allowed");
  }

  const host = normalizeHostname(parsed.hostname);

  if (isLocalHostname(host)) {
    if (options.allowLocalhost === true) {
      return { url: parsed, hostname: host };
    }
    throw new Error(`Blocked local hostname: ${parsed.hostname}`);
  }

  const directIpFamily = net.isIP(host);
  if (directIpFamily) {
    if (isLoopbackIp(host)) {
      if (options.allowLocalhost === true) {
        return { url: parsed, hostname: host, address: host, family: directIpFamily as 4 | 6 };
      }
      throw new Error(`Blocked local IP address: ${host}`);
    }

    if (
      isPrivateOrReservedIp(host) &&
      options.allowPrivateNetwork !== true
    ) {
      throw new Error(`Blocked private or reserved IP address: ${host}`);
    }

    return { url: parsed, hostname: host, address: host, family: directIpFamily as 4 | 6 };
  }

  const records = await dns.lookup(host, { all: true, verbatim: true });
  if (!records.length) throw new Error(`Could not resolve hostname: ${host}`);

  for (const record of records) {
    assertSafeAddress(record.address, host, options);
  }

  const selected = records[0];
  if (!selected) throw new Error(`Could not resolve hostname: ${host}`);

  return {
    url: parsed,
    hostname: host,
    address: selected.address,
    family: selected.family === 6 ? 6 : 4
  };
};

export const validateHttpUrlForNetworkAccess = async (
  rawUrl: string,
  options: NetworkValidationOptions = {}
): Promise<URL> => {
  const resolved = await resolveHttpUrlForNetworkAccess(rawUrl, options);
  return resolved.url;
};

export const validateBrowserWorkspaceUrl = async (
  rawUrl: string,
  agentSettings?: AgentBehaviorSettings
): Promise<string> => {
  const value = rawUrl.trim();
  if (value === "about:blank") return value;
  try {
    const parsed = await validateHttpUrlForNetworkAccess(value, {
      allowLocalhost: agentSettings?.allowPrivateNetworkAccess === true,
      allowPrivateNetwork: agentSettings?.allowPrivateNetworkAccess === true
    });
    return parsed.href;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid URL";
    if (message.startsWith("Blocked")) {
      throw new Error(
        "Agent settings do not allow browser access to localhost, loopback, private, or reserved network targets.",
        { cause: error }
      );
    }
    throw error;
  }
};
import { Fragment, useMemo } from "react";
import type { ReactNode } from "react";

interface MarkdownContentProps {
  content: string;
}

type MarkdownBlock =
  | {
      type: "heading";
      level: 1 | 2 | 3;
      text: string;
    }
  | {
      type: "paragraph";
      text: string;
    }
  | {
      type: "unordered-list";
      items: string[];
    }
  | {
      type: "ordered-list";
      items: string[];
    }
  | {
      type: "blockquote";
      text: string;
    }
  | {
      type: "code";
      language: string;
      code: string;
    }
  | {
      type: "table";
      headers: string[];
      rows: string[][];
    };

interface InlineToken {
  type: "text" | "bold" | "italic" | "code" | "link";
  text: string;
  href?: string;
}

const CODE_FENCE = "```";

const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

const safeLinkHref = (href: string): string | null => {
  const value = href.trim();
  if (!value || CONTROL_CHARACTER_PATTERN.test(value)) return null;

  try {
    const parsed = new URL(value);
    if (parsed.protocol === "mailto:") return parsed.href;
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (parsed.username || parsed.password) return null;
    return parsed.href;
  } catch {
    return null;
  }
};

const stripListMarker = (line: string): string =>
  line.replace(/^\s*[-*]\s+/, "").replace(/^\s*\d+[.)]\s+/, "");

const isUnorderedListLine = (line: string): boolean => /^\s*[-*]\s+/.test(line);

const isOrderedListLine = (line: string): boolean =>
  /^\s*\d+[.)]\s+/.test(line);

const isHeadingLine = (line: string): boolean => /^#{1,3}\s+/.test(line);

const splitTableCells = (line: string): string[] => {
  const trimmed = line.trim();
  const withoutLeadingPipe = trimmed.startsWith("|")
    ? trimmed.slice(1)
    : trimmed;
  const withoutTrailingPipe = withoutLeadingPipe.endsWith("|")
    ? withoutLeadingPipe.slice(0, -1)
    : withoutLeadingPipe;

  return withoutTrailingPipe.split("|").map((cell) => cell.trim());
};

const isTableSeparatorCell = (cell: string): boolean =>
  /^:?-{3,}:?$/.test(cell.replace(/\s+/g, ""));

const isTableSeparatorRow = (cells: string[]): boolean =>
  cells.length > 1 && cells.every(isTableSeparatorCell);

const isTableLine = (line: string): boolean =>
  line.trim().startsWith("|") && splitTableCells(line).length > 1;

const normalizeTableRow = (cells: string[], width: number): string[] => {
  const row = cells.slice(0, width);
  while (row.length < width) row.push("");
  return row;
};

const parseCollapsedTableLine = (line: string): MarkdownBlock | null => {
  if (!isTableLine(line)) return null;

  const cells = splitTableCells(line).filter((cell) => cell.length > 0);
  const separatorStart = cells.findIndex(isTableSeparatorCell);

  if (separatorStart <= 0) return null;

  let separatorEnd = separatorStart;
  while (
    separatorEnd < cells.length &&
    isTableSeparatorCell(cells[separatorEnd] ?? "")
  ) {
    separatorEnd += 1;
  }

  const width = separatorEnd - separatorStart;
  const headers = cells.slice(0, separatorStart);

  if (width < 2 || headers.length !== width) return null;

  const bodyCells = cells.slice(separatorEnd);
  const rows: string[][] = [];

  for (let index = 0; index < bodyCells.length; index += width) {
    const row = bodyCells.slice(index, index + width);
    if (row.some((cell) => cell.trim().length > 0)) {
      rows.push(normalizeTableRow(row, width));
    }
  }

  return rows.length > 0 ? { type: "table", headers, rows } : null;
};

const readHeadingLevel = (line: string): 1 | 2 | 3 => {
  const marker = line.match(/^#{1,3}/)?.[0] ?? "#";

  if (marker.length === 1) return 1;
  if (marker.length === 2) return 2;
  return 3;
};

const readHeadingText = (line: string): string =>
  line.replace(/^#{1,3}\s+/, "").trim();

const trimBlock = (lines: string[]): string => lines.join("\n").trim();

const pushParagraph = (
  blocks: MarkdownBlock[],
  paragraphLines: string[],
): void => {
  const text = trimBlock(paragraphLines);

  if (text) {
    blocks.push({ type: "paragraph", text });
  }

  paragraphLines.length = 0;
};

const parseMarkdownBlocks = (content: string): MarkdownBlock[] => {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  const paragraphLines: string[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";

    if (line.trim().startsWith(CODE_FENCE)) {
      pushParagraph(blocks, paragraphLines);

      const language = line.trim().slice(CODE_FENCE.length).trim();
      const codeLines: string[] = [];
      index += 1;

      while (
        index < lines.length &&
        !(lines[index] ?? "").trim().startsWith(CODE_FENCE)
      ) {
        codeLines.push(lines[index] ?? "");
        index += 1;
      }

      blocks.push({
        type: "code",
        language,
        code: codeLines.join("\n"),
      });

      index += 1;
      continue;
    }

    if (!line.trim()) {
      pushParagraph(blocks, paragraphLines);
      index += 1;
      continue;
    }

    if (isTableLine(line)) {
      const collapsedTable = parseCollapsedTableLine(line);

      if (collapsedTable) {
        pushParagraph(blocks, paragraphLines);
        blocks.push(collapsedTable);
        index += 1;
        continue;
      }

      const headerCells = splitTableCells(line);
      const separatorCells = splitTableCells(lines[index + 1] ?? "");

      if (isTableSeparatorRow(separatorCells)) {
        pushParagraph(blocks, paragraphLines);
        index += 2;
        const rows: string[][] = [];

        while (index < lines.length && isTableLine(lines[index] ?? "")) {
          const rowCells = splitTableCells(lines[index] ?? "");
          if (!isTableSeparatorRow(rowCells)) {
            rows.push(normalizeTableRow(rowCells, headerCells.length));
          }
          index += 1;
        }

        blocks.push({
          type: "table",
          headers: headerCells,
          rows,
        });
        continue;
      }
    }

    if (isHeadingLine(line)) {
      pushParagraph(blocks, paragraphLines);
      blocks.push({
        type: "heading",
        level: readHeadingLevel(line),
        text: readHeadingText(line),
      });
      index += 1;
      continue;
    }

    if (isUnorderedListLine(line)) {
      pushParagraph(blocks, paragraphLines);

      const items: string[] = [];

      while (index < lines.length && isUnorderedListLine(lines[index] ?? "")) {
        items.push(stripListMarker(lines[index] ?? "").trim());
        index += 1;
      }

      blocks.push({ type: "unordered-list", items });
      continue;
    }

    if (isOrderedListLine(line)) {
      pushParagraph(blocks, paragraphLines);

      const items: string[] = [];

      while (index < lines.length && isOrderedListLine(lines[index] ?? "")) {
        items.push(stripListMarker(lines[index] ?? "").trim());
        index += 1;
      }

      blocks.push({ type: "ordered-list", items });
      continue;
    }

    if (line.trim().startsWith(">")) {
      pushParagraph(blocks, paragraphLines);

      const quoteLines: string[] = [];

      while (
        index < lines.length &&
        (lines[index] ?? "").trim().startsWith(">")
      ) {
        quoteLines.push((lines[index] ?? "").replace(/^\s*>\s?/, ""));
        index += 1;
      }

      blocks.push({
        type: "blockquote",
        text: quoteLines.join("\n").trim(),
      });
      continue;
    }

    paragraphLines.push(line);
    index += 1;
  }

  pushParagraph(blocks, paragraphLines);

  return blocks;
};

const findNextInlineMarker = (text: string, fromIndex: number): number => {
  const markers = ["**", "`", "[", "*"];
  const indexes = markers
    .map((marker) => text.indexOf(marker, fromIndex))
    .filter((index) => index >= 0);

  return indexes.length > 0 ? Math.min(...indexes) : -1;
};

const parseInlineTokens = (text: string): InlineToken[] => {
  const tokens: InlineToken[] = [];
  let index = 0;

  while (index < text.length) {
    const markerIndex = findNextInlineMarker(text, index);

    if (markerIndex === -1) {
      tokens.push({ type: "text", text: text.slice(index) });
      break;
    }

    if (markerIndex > index) {
      tokens.push({ type: "text", text: text.slice(index, markerIndex) });
    }

    const remaining = text.slice(markerIndex);

    if (remaining.startsWith("**")) {
      const endIndex = text.indexOf("**", markerIndex + 2);

      if (endIndex > markerIndex + 2) {
        tokens.push({
          type: "bold",
          text: text.slice(markerIndex + 2, endIndex),
        });
        index = endIndex + 2;
        continue;
      }
    }

    if (remaining.startsWith("`")) {
      const endIndex = text.indexOf("`", markerIndex + 1);

      if (endIndex > markerIndex + 1) {
        tokens.push({
          type: "code",
          text: text.slice(markerIndex + 1, endIndex),
        });
        index = endIndex + 1;
        continue;
      }
    }

    if (remaining.startsWith("[")) {
      const labelEnd = text.indexOf("]", markerIndex + 1);
      const hrefStart = labelEnd >= 0 ? text.indexOf("(", labelEnd) : -1;
      const hrefEnd = hrefStart >= 0 ? text.indexOf(")", hrefStart) : -1;

      if (
        labelEnd > markerIndex &&
        hrefStart === labelEnd + 1 &&
        hrefEnd > hrefStart
      ) {
        tokens.push({
          type: "link",
          text: text.slice(markerIndex + 1, labelEnd),
          href: text.slice(hrefStart + 1, hrefEnd),
        });
        index = hrefEnd + 1;
        continue;
      }
    }

    if (remaining.startsWith("*")) {
      const endIndex = text.indexOf("*", markerIndex + 1);

      if (endIndex > markerIndex + 1) {
        tokens.push({
          type: "italic",
          text: text.slice(markerIndex + 1, endIndex),
        });
        index = endIndex + 1;
        continue;
      }
    }

    tokens.push({ type: "text", text: text[markerIndex] ?? "" });
    index = markerIndex + 1;
  }

  return tokens;
};

const renderInline = (text: string): ReactNode[] =>
  parseInlineTokens(text).map((token, index) => {
    const key = `${token.type}-${index}`;

    if (token.type === "bold") {
      return <strong key={key}>{renderInline(token.text)}</strong>;
    }

    if (token.type === "italic") {
      return <em key={key}>{renderInline(token.text)}</em>;
    }

    if (token.type === "code") {
      return <code key={key}>{token.text}</code>;
    }

    if (token.type === "link" && token.href) {
      const href = safeLinkHref(token.href);
      if (href) {
        return (
          <a key={key} href={href} target="_blank" rel="noopener noreferrer">
            {renderInline(token.text)}
          </a>
        );
      }
    }

    return <Fragment key={key}>{token.text}</Fragment>;
  });

const renderBlock = (block: MarkdownBlock, index: number): ReactNode => {
  const key = `${block.type}-${index}`;

  if (block.type === "heading") {
    if (block.level === 1) {
      return <h1 key={key}>{renderInline(block.text)}</h1>;
    }

    if (block.level === 2) {
      return <h2 key={key}>{renderInline(block.text)}</h2>;
    }

    return <h3 key={key}>{renderInline(block.text)}</h3>;
  }

  if (block.type === "unordered-list") {
    return (
      <ul key={key}>
        {block.items.map((item: string, itemIndex: number) => (
          <li key={`${key}-${itemIndex}`}>{renderInline(item)}</li>
        ))}
      </ul>
    );
  }

  if (block.type === "ordered-list") {
    return (
      <ol key={key}>
        {block.items.map((item: string, itemIndex: number) => (
          <li key={`${key}-${itemIndex}`}>{renderInline(item)}</li>
        ))}
      </ol>
    );
  }

  if (block.type === "blockquote") {
    return <blockquote key={key}>{renderInline(block.text)}</blockquote>;
  }

  if (block.type === "table") {
    return (
      <div className="markdown-table-scroll" key={key}>
        <table>
          <thead>
            <tr>
              {block.headers.map((header, headerIndex) => (
                <th key={`${key}-header-${headerIndex}`}>
                  {renderInline(header)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {block.rows.map((row, rowIndex) => (
              <tr key={`${key}-row-${rowIndex}`}>
                {row.map((cell, cellIndex) => (
                  <td key={`${key}-row-${rowIndex}-cell-${cellIndex}`}>
                    {renderInline(cell)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  if (block.type === "code") {
    return (
      <pre key={key}>
        <code>{block.code}</code>
      </pre>
    );
  }

  return <p key={key}>{renderInline(block.text)}</p>;
};

export function MarkdownContent({ content }: MarkdownContentProps) {
  const blocks = useMemo(() => parseMarkdownBlocks(content), [content]);

  if (blocks.length === 0) {
    return null;
  }

  return (
    <div className="markdown-content">
      {blocks.map((block: MarkdownBlock, index: number) =>
        renderBlock(block, index),
      )}
    </div>
  );
}

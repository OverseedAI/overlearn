import type { GlossaryEntry } from "../course";

export type MarkdownRenderOptions = Readonly<{
  glossary?: readonly GlossaryEntry[];
}>;

const tick = String.fromCharCode(96);
const markdownFence = tick.repeat(3);
const inlineCodePattern = new RegExp(
  `(${tick}[^${tick}]*${tick})`,
  "g",
);
const htmlTagPattern = /<\/?([a-zA-Z][\w:-]*)\b[^>]*>/g;
const wordCharacterPattern = /[A-Za-z0-9_]/;
const skippedGlossaryTags = new Set(["a", "code", "pre"]);

type LinkableGlossaryTerm = Readonly<{
  term: string;
  escapedTerm: string;
  escapedTermKey: string;
  key: string;
}>;

const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const sanitizeHref = (value: string): string => {
  try {
    const url = new URL(value, "http://localhost/");
    if (["http:", "https:", "mailto:"].includes(url.protocol)) {
      return url.href;
    }
  } catch {
    return "#";
  }

  return "#";
};

const glossaryTermKey = (term: string): string => term.toLocaleLowerCase();

const isWordCharacter = (character: string | undefined): boolean =>
  character !== undefined && wordCharacterPattern.test(character);

const createLinkableGlossaryTerms = (
  entries: readonly GlossaryEntry[],
): readonly LinkableGlossaryTerm[] =>
  entries
    .flatMap((entry) => {
      const term = entry.term.trim();
      if (term.length === 0) {
        return [];
      }

      const escapedTerm = escapeHtml(term);
      return [
        {
          term,
          escapedTerm,
          escapedTermKey: escapedTerm.toLocaleLowerCase(),
          key: glossaryTermKey(term),
        },
      ];
    })
    .sort((left, right) => right.escapedTerm.length - left.escapedTerm.length);

const matchingTermAt = (
  text: string,
  index: number,
  terms: readonly LinkableGlossaryTerm[],
): LinkableGlossaryTerm | undefined => {
  if (isWordCharacter(text[index - 1])) {
    return undefined;
  }

  return terms.find((term) => {
    const endIndex = index + term.escapedTerm.length;
    if (isWordCharacter(text[endIndex])) {
      return false;
    }

    return (
      text.slice(index, endIndex).toLocaleLowerCase() === term.escapedTermKey
    );
  });
};

const linkGlossaryTermsInText = (
  text: string,
  terms: readonly LinkableGlossaryTerm[],
  linkedTermKeys: Set<string>,
): string => {
  if (terms.length === 0 || text.length === 0) {
    return text;
  }

  let html = "";
  let index = 0;

  while (index < text.length) {
    const term = matchingTermAt(text, index, terms);
    if (term === undefined) {
      html += text[index] ?? "";
      index += 1;
      continue;
    }

    const matchedText = text.slice(index, index + term.escapedTerm.length);
    if (linkedTermKeys.has(term.key)) {
      html += matchedText;
    } else {
      linkedTermKeys.add(term.key);
      html += `<span class="term" data-term="${escapeHtml(
        term.term,
      )}" tabindex="0">${matchedText}</span>`;
    }

    index += term.escapedTerm.length;
  }

  return html;
};

export const linkGlossaryTermsInHtml = (
  html: string,
  glossary: readonly GlossaryEntry[],
): string => {
  const terms = createLinkableGlossaryTerms(glossary);
  if (terms.length === 0) {
    return html;
  }

  const linkedTermKeys = new Set<string>();
  const skippedTagStack: string[] = [];
  let linkedHtml = "";
  let index = 0;

  for (const match of html.matchAll(htmlTagPattern)) {
    const tag = match[0];
    const tagName = match[1]?.toLocaleLowerCase();
    const matchIndex = match.index;

    if (matchIndex === undefined || tagName === undefined) {
      continue;
    }

    const text = html.slice(index, matchIndex);
    linkedHtml +=
      skippedTagStack.length === 0
        ? linkGlossaryTermsInText(text, terms, linkedTermKeys)
        : text;
    linkedHtml += tag;

    if (skippedGlossaryTags.has(tagName)) {
      if (tag.startsWith("</")) {
        const lastTagIndex = skippedTagStack.lastIndexOf(tagName);
        if (lastTagIndex !== -1) {
          skippedTagStack.splice(lastTagIndex, 1);
        }
      } else if (!tag.endsWith("/>")) {
        skippedTagStack.push(tagName);
      }
    }

    index = matchIndex + tag.length;
  }

  const text = html.slice(index);
  linkedHtml +=
    skippedTagStack.length === 0
      ? linkGlossaryTermsInText(text, terms, linkedTermKeys)
      : text;

  return linkedHtml;
};

const renderBlock = (
  html: string,
  glossary: readonly GlossaryEntry[],
): string => linkGlossaryTermsInHtml(html, glossary);

const renderPlainInline = (text: string): string => {
  const escaped = escapeHtml(text);

  return escaped.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
};

const renderLinkedInline = (text: string): string =>
  text.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_match, label, href) => {
    const safeHref = escapeHtml(sanitizeHref(String(href)));
    return `<a href="${safeHref}" rel="noreferrer" target="_blank">${String(
      label,
    )}</a>`;
  });

const renderInline = (text: string): string => {
  const parts = text.split(inlineCodePattern);

  return parts
    .map((part) => {
      if (part.startsWith(tick) && part.endsWith(tick) && part.length >= 2) {
        return `<code>${escapeHtml(part.slice(1, -1))}</code>`;
      }

      return renderLinkedInline(renderPlainInline(part));
    })
    .join("");
};

const stripOuterPipes = (line: string): string => {
  let value = line.trim();
  if (value.startsWith("|")) {
    value = value.slice(1);
  }
  if (value.endsWith("|")) {
    value = value.slice(0, -1);
  }

  return value;
};

const splitTableRow = (line: string): readonly string[] =>
  stripOuterPipes(line)
    .split("|")
    .map((cell) => cell.trim());

const isTableSeparator = (line: string): boolean =>
  /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);

const isListLine = (line: string): boolean =>
  /^\s*[-*+]\s+\S/.test(line) || /^\s*\d+\.\s+\S/.test(line);

const renderTable = (
  lines: readonly string[],
  startIndex: number,
): Readonly<{ html: string; nextIndex: number }> => {
  const header = splitTableRow(lines[startIndex] ?? "");
  const mutableRows: string[][] = [];
  let index = startIndex + 2;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (!line.includes("|") || line.trim().length === 0) {
      break;
    }

    mutableRows.push([...splitTableRow(line)]);
    index += 1;
  }

  const headCells = header
    .map((cell) => `<th scope="col">${renderInline(cell)}</th>`)
    .join("");
  const bodyRows = mutableRows
    .map((row) => {
      const cells = header
        .map((_cell, cellIndex) => `<td>${renderInline(row[cellIndex] ?? "")}</td>`)
        .join("");
      return `<tr>${cells}</tr>`;
    })
    .join("");

  return {
    html: `<div class="table-wrap"><table><thead><tr>${headCells}</tr></thead><tbody>${bodyRows}</tbody></table></div>`,
    nextIndex: index,
  };
};

const renderList = (
  lines: readonly string[],
  startIndex: number,
): Readonly<{ html: string; nextIndex: number }> => {
  const firstLine = lines[startIndex] ?? "";
  const ordered = /^\s*\d+\.\s+\S/.test(firstLine);
  const tag = ordered ? "ol" : "ul";
  const items: string[] = [];
  let index = startIndex;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    const matchesKind = ordered
      ? /^\s*\d+\.\s+\S/.test(line)
      : /^\s*[-*+]\s+\S/.test(line);

    if (!matchesKind) {
      break;
    }

    items.push(line.replace(ordered ? /^\s*\d+\.\s+/ : /^\s*[-*+]\s+/, ""));
    index += 1;
  }

  return {
    html: `<${tag}>${items
      .map((item) => `<li>${renderInline(item)}</li>`)
      .join("")}</${tag}>`,
    nextIndex: index,
  };
};

const renderParagraph = (
  lines: readonly string[],
  startIndex: number,
): Readonly<{ html: string; nextIndex: number }> => {
  const paragraphLines: string[] = [];
  let index = startIndex;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    const nextLine = lines[index + 1] ?? "";

    if (
      line.trim().length === 0 ||
      line.startsWith(markdownFence) ||
      isListLine(line) ||
      (line.includes("|") && isTableSeparator(nextLine))
    ) {
      break;
    }

    paragraphLines.push(line);
    index += 1;
  }

  return {
    html: `<p>${paragraphLines
      .map((line) => renderInline(line))
      .join("<br>")}</p>`,
    nextIndex: index,
  };
};

export const renderMarkdown = (
  markdown: string,
  options: MarkdownRenderOptions = {},
): string => {
  const glossary = options.glossary ?? [];
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const blocks: string[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";

    if (line.trim().length === 0) {
      index += 1;
      continue;
    }

    if (line.startsWith(markdownFence)) {
      const codeLines: string[] = [];
      index += 1;

      while (index < lines.length && !(lines[index] ?? "").startsWith(markdownFence)) {
        codeLines.push(lines[index] ?? "");
        index += 1;
      }

      if (index < lines.length) {
        index += 1;
      }

      blocks.push(
        renderBlock(
          `<pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`,
          glossary,
        ),
      );
      continue;
    }

    const nextLine = lines[index + 1] ?? "";
    if (line.includes("|") && isTableSeparator(nextLine)) {
      const table = renderTable(lines, index);
      blocks.push(renderBlock(table.html, glossary));
      index = table.nextIndex;
      continue;
    }

    if (isListLine(line)) {
      const list = renderList(lines, index);
      blocks.push(renderBlock(list.html, glossary));
      index = list.nextIndex;
      continue;
    }

    if (/^#{1,6}\s+\S/.test(line)) {
      const match = /^#+/.exec(line);
      const level = Math.min(match?.[0].length ?? 1, 6);
      const text = line.replace(/^#{1,6}\s+/, "");
      blocks.push(
        renderBlock(`<h${level}>${renderInline(text)}</h${level}>`, glossary),
      );
      index += 1;
      continue;
    }

    const paragraph = renderParagraph(lines, index);
    blocks.push(renderBlock(paragraph.html, glossary));
    index = paragraph.nextIndex;
  }

  return blocks.join("");
};

import { isValidDemoFileName, type GlossaryEntry } from "../course";

export type MarkdownRenderOptions = Readonly<{
  glossary?: readonly GlossaryEntry[];
  demoFiles?: ReadonlySet<string> | readonly string[];
  resolveDemoHref?: (file: string) => string;
  resolveLinkHref?: (href: string) => string;
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

type DemoDirective =
  | Readonly<{
      ok: true;
      file: string;
      title?: string;
    }>
  | Readonly<{
      ok: false;
      message: string;
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

const isStringArray = (
  value: ReadonlySet<string> | readonly string[],
): value is readonly string[] => Array.isArray(value);

const demoFileIsAvailable = (
  file: string,
  demoFiles: MarkdownRenderOptions["demoFiles"],
): boolean => {
  if (demoFiles === undefined) {
    return true;
  }

  if (isStringArray(demoFiles)) {
    return demoFiles.includes(file);
  }

  return demoFiles.has(file);
};

const renderDemoWarning = (message: string): string =>
  `<div class="demo-card demo-warning" role="note"><div class="demo-titlebar"><div class="demo-title">Demo unavailable</div></div><p>${escapeHtml(
    message,
  )}</p></div>`;

export const renderDemoEmbed = (
  file: string,
  title: string | undefined,
  options: MarkdownRenderOptions = {},
): string => {
  if (!isValidDemoFileName(file)) {
    return renderDemoWarning(
      `Invalid demo file "${file}". Demos must be .html files directly inside demos/.`,
    );
  }

  if (!demoFileIsAvailable(file, options.demoFiles)) {
    return renderDemoWarning(`Missing demo file: demos/${file}`);
  }

  const displayTitle = title ?? file;
  const href =
    options.resolveDemoHref?.(file) ?? `/demos/${encodeURIComponent(file)}`;

  return [
    `<article class="demo-card" data-demo-file="${escapeHtml(file)}">`,
    '<div class="demo-titlebar">',
    `<div class="demo-title"><span class="demo-badge">demo</span>${escapeHtml(
      displayTitle,
    )}</div>`,
    '<div class="demo-actions">',
    `<button class="demo-action" type="button" data-demo-fullscreen aria-label="Expand demo ${escapeHtml(
      displayTitle,
    )}" title="Expand">Expand</button>`,
    `<a class="demo-action" href="${escapeHtml(
      href,
    )}" target="_blank" rel="noopener noreferrer" title="Open in tab">Open in tab</a>`,
    "</div>",
    "</div>",
    // No allow-same-origin: the sandboxed document gets an opaque origin; the
    // demo response CSP blocks network fetches while allowing inline demos.
    `<iframe class="demo-frame" src="${escapeHtml(href)}" title="${escapeHtml(
      displayTitle,
    )}" sandbox="allow-scripts" loading="lazy"></iframe>`,
    "</article>",
  ].join("");
};

export const parseDemoDirective = (line: string): DemoDirective | undefined => {
  const trimmed = line.trim();
  if (!trimmed.startsWith(":::demo")) {
    return undefined;
  }

  const body = trimmed.slice(":::demo".length).trim();
  if (body.length === 0) {
    return {
      ok: false,
      message: "Invalid demo directive: expected :::demo <file.html>.",
    };
  }

  const match = /^(\S+)(?:\s+"([^"]+)")?\s*$/.exec(body);
  if (match === null) {
    return {
      ok: false,
      message: "Invalid demo directive: expected :::demo <file.html> \"Title\".",
    };
  }

  const file = match[1];
  const title = match[2];
  if (file === undefined) {
    return {
      ok: false,
      message: "Invalid demo directive: expected a file name.",
    };
  }

  if (title !== undefined && title.trim().length === 0) {
    return {
      ok: false,
      message: "Invalid demo directive: title cannot be empty.",
    };
  }

  return {
    ok: true,
    file,
    ...(title === undefined ? {} : { title: title.trim() }),
  };
};

const isDemoDirectiveLine = (line: string): boolean =>
  line.trim().startsWith(":::demo");

const renderPlainInline = (text: string): string => {
  const escaped = escapeHtml(text);

  return escaped.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
};

const renderLinkedInline = (
  text: string,
  options: MarkdownRenderOptions,
): string =>
  text.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_match, label, href) => {
    const safeHref = escapeHtml(
      options.resolveLinkHref?.(String(href)) ?? sanitizeHref(String(href)),
    );
    return `<a href="${safeHref}" rel="noreferrer" target="_blank">${String(
      label,
    )}</a>`;
  });

const renderInline = (
  text: string,
  options: MarkdownRenderOptions,
): string => {
  const parts = text.split(inlineCodePattern);

  return parts
    .map((part) => {
      if (part.startsWith(tick) && part.endsWith(tick) && part.length >= 2) {
        return `<code>${escapeHtml(part.slice(1, -1))}</code>`;
      }

      return renderLinkedInline(renderPlainInline(part), options);
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

const isBlockquoteLine = (line: string): boolean => line.startsWith(">");

const stripBlockquoteMarker = (line: string): string =>
  line.startsWith("> ") ? line.slice(2) : line.slice(1);

const renderTable = (
  lines: readonly string[],
  startIndex: number,
  options: MarkdownRenderOptions,
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
    .map((cell) => `<th scope="col">${renderInline(cell, options)}</th>`)
    .join("");
  const bodyRows = mutableRows
    .map((row) => {
      const cells = header
        .map(
          (_cell, cellIndex) =>
            `<td>${renderInline(row[cellIndex] ?? "", options)}</td>`,
        )
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
  options: MarkdownRenderOptions,
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
      .map((item) => `<li>${renderInline(item, options)}</li>`)
      .join("")}</${tag}>`,
    nextIndex: index,
  };
};

const renderBlockquote = (
  lines: readonly string[],
  startIndex: number,
  options: MarkdownRenderOptions,
): Readonly<{ html: string; nextIndex: number }> => {
  const quoteLines: string[] = [];
  let index = startIndex;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (!isBlockquoteLine(line)) {
      break;
    }

    quoteLines.push(stripBlockquoteMarker(line));
    index += 1;
  }

  return {
    html: `<blockquote>${quoteLines
      .map((line) => renderInline(line, options))
      .join("<br>")}</blockquote>`,
    nextIndex: index,
  };
};

const renderParagraph = (
  lines: readonly string[],
  startIndex: number,
  options: MarkdownRenderOptions,
): Readonly<{ html: string; nextIndex: number }> => {
  const paragraphLines: string[] = [];
  let index = startIndex;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    const nextLine = lines[index + 1] ?? "";

    if (
      line.trim().length === 0 ||
      line.startsWith(markdownFence) ||
      isDemoDirectiveLine(line) ||
      isBlockquoteLine(line) ||
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
      .map((line) => renderInline(line, options))
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

    const demoDirective = parseDemoDirective(line);
    if (demoDirective !== undefined) {
      blocks.push(
        renderBlock(
          demoDirective.ok
            ? renderDemoEmbed(demoDirective.file, demoDirective.title, options)
            : renderDemoWarning(demoDirective.message),
          glossary,
        ),
      );
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
      const table = renderTable(lines, index, options);
      blocks.push(renderBlock(table.html, glossary));
      index = table.nextIndex;
      continue;
    }

    if (isBlockquoteLine(line)) {
      const blockquote = renderBlockquote(lines, index, options);
      blocks.push(renderBlock(blockquote.html, glossary));
      index = blockquote.nextIndex;
      continue;
    }

    if (isListLine(line)) {
      const list = renderList(lines, index, options);
      blocks.push(renderBlock(list.html, glossary));
      index = list.nextIndex;
      continue;
    }

    if (/^#{1,6}\s+\S/.test(line)) {
      const match = /^#+/.exec(line);
      const level = Math.min(match?.[0].length ?? 1, 6);
      const text = line.replace(/^#{1,6}\s+/, "");
      blocks.push(
        renderBlock(
          `<h${level}>${renderInline(text, options)}</h${level}>`,
          glossary,
        ),
      );
      index += 1;
      continue;
    }

    const paragraph = renderParagraph(lines, index, options);
    blocks.push(renderBlock(paragraph.html, glossary));
    index = paragraph.nextIndex;
  }

  return blocks.join("");
};

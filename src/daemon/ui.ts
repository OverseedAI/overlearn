import type { TranscriptEntry } from "../course";

const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const escapeScriptJson = (value: unknown): string => {
  const replacements: Record<string, string> = {
    "&": "\\u0026",
    "<": "\\u003C",
    ">": "\\u003E",
    "\u2028": "\\u2028",
    "\u2029": "\\u2029",
  };

  return JSON.stringify(value).replace(
    /[&<>\u2028\u2029]/g,
    (character) => replacements[character] ?? character,
  );
};

const clientScript = String.raw`
const initialTranscript = __TRANSCRIPT__;

const form = document.querySelector("#turn-form");
const textarea = document.querySelector("#message");
const button = document.querySelector("#submit");
const statusLine = document.querySelector("#status");
const transcript = document.querySelector("#transcript");
const tick = String.fromCharCode(96);
const markdownFence = tick.repeat(3);
const inlineCodePattern = new RegExp("(" + tick + "[^" + tick + "]*" + tick + ")", "g");

const escapeHtml = (value) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const sanitizeHref = (value) => {
  try {
    const url = new URL(value, window.location.href);
    if (["http:", "https:", "mailto:"].includes(url.protocol)) {
      return url.href;
    }
  } catch {
    return "#";
  }

  return "#";
};

const renderPlainInline = (text) => {
  const escaped = escapeHtml(text);

  return escaped.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
};

const renderLinkedInline = (text) =>
  text.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_match, label, href) => {
    const safeHref = escapeHtml(sanitizeHref(href));
    return "<a href=\"" + safeHref + "\" rel=\"noreferrer\" target=\"_blank\">" + label + "</a>";
  });

const renderInline = (text) => {
  const parts = text.split(inlineCodePattern);

  return parts
    .map((part) => {
      if (part.startsWith(tick) && part.endsWith(tick) && part.length >= 2) {
        return "<code>" + escapeHtml(part.slice(1, -1)) + "</code>";
      }

      return renderLinkedInline(renderPlainInline(part));
    })
    .join("");
};

const stripOuterPipes = (line) => {
  let value = line.trim();
  if (value.startsWith("|")) value = value.slice(1);
  if (value.endsWith("|")) value = value.slice(0, -1);
  return value;
};

const splitTableRow = (line) =>
  stripOuterPipes(line)
    .split("|")
    .map((cell) => cell.trim());

const isTableSeparator = (line) =>
  /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);

const isListLine = (line) => /^\s*[-*+]\s+\S/.test(line) || /^\s*\d+\.\s+\S/.test(line);

const renderTable = (lines, startIndex) => {
  const header = splitTableRow(lines[startIndex]);
  const rows = [];
  let index = startIndex + 2;

  while (index < lines.length && lines[index].includes("|") && lines[index].trim().length > 0) {
    rows.push(splitTableRow(lines[index]));
    index += 1;
  }

  const headCells = header
    .map((cell) => "<th scope=\"col\">" + renderInline(cell) + "</th>")
    .join("");
  const bodyRows = rows
    .map((row) => {
      const cells = header
        .map((_cell, cellIndex) => "<td>" + renderInline(row[cellIndex] ?? "") + "</td>")
        .join("");
      return "<tr>" + cells + "</tr>";
    })
    .join("");

  return {
    html: "<div class=\"table-wrap\"><table><thead><tr>" + headCells + "</tr></thead><tbody>" + bodyRows + "</tbody></table></div>",
    nextIndex: index,
  };
};

const renderList = (lines, startIndex) => {
  const ordered = /^\s*\d+\.\s+\S/.test(lines[startIndex]);
  const tag = ordered ? "ol" : "ul";
  const items = [];
  let index = startIndex;

  while (index < lines.length) {
    const line = lines[index];
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
    html: "<" + tag + ">" + items.map((item) => "<li>" + renderInline(item) + "</li>").join("") + "</" + tag + ">",
    nextIndex: index,
  };
};

const renderParagraph = (lines, startIndex) => {
  const paragraphLines = [];
  let index = startIndex;

  while (index < lines.length) {
    const line = lines[index];
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
    html: "<p>" + paragraphLines.map((line) => renderInline(line)).join("<br>") + "</p>",
    nextIndex: index,
  };
};

const renderMarkdown = (markdown) => {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    if (line.trim().length === 0) {
      index += 1;
      continue;
    }

    if (line.startsWith(markdownFence)) {
      const codeLines = [];
      index += 1;

      while (index < lines.length && !lines[index].startsWith(markdownFence)) {
        codeLines.push(lines[index]);
        index += 1;
      }

      if (index < lines.length) {
        index += 1;
      }

      blocks.push("<pre><code>" + escapeHtml(codeLines.join("\n")) + "</code></pre>");
      continue;
    }

    const nextLine = lines[index + 1] ?? "";
    if (line.includes("|") && isTableSeparator(nextLine)) {
      const table = renderTable(lines, index);
      blocks.push(table.html);
      index = table.nextIndex;
      continue;
    }

    if (isListLine(line)) {
      const list = renderList(lines, index);
      blocks.push(list.html);
      index = list.nextIndex;
      continue;
    }

    if (/^#{1,6}\s+\S/.test(line)) {
      const level = Math.min(line.match(/^#+/)?.[0].length ?? 1, 6);
      blocks.push("<h" + level + ">" + renderInline(line.replace(/^#{1,6}\s+/, "")) + "</h" + level + ">");
      index += 1;
      continue;
    }

    const paragraph = renderParagraph(lines, index);
    blocks.push(paragraph.html);
    index = paragraph.nextIndex;
  }

  return blocks.join("");
};

const scrollTranscript = () => {
  transcript.scrollTop = transcript.scrollHeight;
};

const appendEntry = (entry) => {
  const article = document.createElement("article");
  article.className = "entry " + entry.role;

  const meta = document.createElement("div");
  meta.className = "entry-meta";
  meta.textContent = entry.role === "agent" ? "Agent" : "You";

  const body = document.createElement("div");
  body.className = "prose";
  body.innerHTML = renderMarkdown(entry.text);

  article.append(meta, body);
  transcript.append(article);
  scrollTranscript();
};

const applyStatus = (status) => {
  const waiting = status === "waiting-for-agent";
  statusLine.textContent = waiting ? "Waiting for your message" : "Agent is working…";
  textarea.disabled = !waiting;
  button.disabled = !waiting || textarea.value.trim().length === 0;

  if (waiting) {
    textarea.focus();
  }
};

const submitMessage = async () => {
  const text = textarea.value.trim();
  if (text.length === 0 || textarea.disabled) {
    return;
  }

  applyStatus("agent-working");
  textarea.value = "";

  const response = await fetch("/api/submit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });

  if (!response.ok) {
    statusLine.textContent = await response.text();
    applyStatus("waiting-for-agent");
  }
};

for (const entry of initialTranscript) {
  appendEntry(entry);
}

textarea.addEventListener("input", () => {
  button.disabled = textarea.disabled || textarea.value.trim().length === 0;
});

textarea.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    void submitMessage();
  }
});

form.addEventListener("submit", (event) => {
  event.preventDefault();
  void submitMessage();
});

const events = new EventSource("/api/events");
events.addEventListener("status", (event) => {
  applyStatus(JSON.parse(event.data).status);
});
events.addEventListener("message", (event) => {
  appendEntry(JSON.parse(event.data));
});
`;

export const renderPage = (
  courseName: string,
  transcript: readonly TranscriptEntry[],
): string => {
  const script = clientScript.replace(
    "__TRANSCRIPT__",
    escapeScriptJson(transcript),
  );

  return `<!doctype html>
<html lang="en" class="scheme-only-dark">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(courseName)} - overlearn</title>
  <style>
    :root {
      color-scheme: dark;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #11110f;
      color: #f4f4f1;
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      min-height: 100vh;
      background: #11110f;
    }

    .shell {
      display: grid;
      grid-template-rows: auto minmax(0, 1fr) auto;
      gap: 1rem;
      min-height: 100vh;
      width: min(100%, 58rem);
      margin: 0 auto;
      padding: 1rem;
    }

    header {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 1rem;
      border-bottom: 1px solid #2f302b;
      padding-bottom: 0.875rem;
    }

    h1 {
      margin: 0;
      color: #fafaf8;
      font-size: clamp(1.25rem, 2.5vw, 1.625rem);
      font-weight: 600;
    }

    #status {
      margin: 0;
      color: #b9c7a7;
      font-size: 0.95rem;
      white-space: nowrap;
    }

    #transcript {
      min-height: 16rem;
      overflow-y: auto;
      padding: 0.25rem 0.125rem 0.75rem;
    }

    .entry {
      display: grid;
      gap: 0.35rem;
      margin: 0 0 1rem;
    }

    .entry.learner {
      justify-items: end;
    }

    .entry-meta {
      color: #a1a19a;
      font-size: 0.8rem;
    }

    .prose {
      width: min(100%, 46rem);
      border: 1px solid #33342f;
      border-radius: 8px;
      background: #1a1b18;
      padding: 0.75rem 0.875rem;
      color: #eeeeea;
      font-size: 1rem;
      line-height: 1.65;
      overflow-wrap: anywhere;
    }

    .learner .prose {
      border-color: #44523c;
      background: #20261e;
    }

    .prose > * {
      margin: 0;
    }

    .prose > * + * {
      margin-top: 0.75rem;
    }

    .prose h1,
    .prose h2,
    .prose h3,
    .prose h4,
    .prose h5,
    .prose h6 {
      color: #fafaf8;
      font-size: 1rem;
      font-weight: 600;
    }

    .prose a {
      color: #9fcf86;
      text-decoration: underline;
      text-underline-offset: 0.2em;
    }

    .prose code {
      border-radius: 5px;
      background: #10110f;
      padding: 0.1rem 0.3rem;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
      font-size: 0.9em;
    }

    .prose pre {
      overflow-x: auto;
      border-radius: 8px;
      background: #0a0b0a;
      padding: 0.75rem;
      line-height: 1.55;
    }

    .prose pre code {
      display: block;
      background: transparent;
      padding: 0;
      white-space: pre;
    }

    .prose ul,
    .prose ol {
      padding-left: 1.25rem;
    }

    .table-wrap {
      overflow-x: auto;
    }

    .prose table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.95rem;
    }

    .prose th,
    .prose td {
      border-bottom: 1px solid #30312d;
      padding: 0.45rem 0.65rem;
      text-align: left;
      vertical-align: top;
    }

    .prose th {
      color: #fafaf8;
      font-weight: 600;
      white-space: nowrap;
    }

    .composer {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 0.75rem;
      border-top: 1px solid #2f302b;
      padding-top: 1rem;
    }

    textarea {
      min-height: 6rem;
      resize: vertical;
      border: 1px solid #3a3b35;
      border-radius: 8px;
      background: #191a17;
      color: #f4f4f1;
      padding: 0.8rem 0.875rem;
      font: inherit;
      line-height: 1.5;
    }

    textarea:focus {
      outline: 2px solid #8fbf73;
      outline-offset: 0;
    }

    textarea:disabled {
      color: #8d8e86;
      background: #151612;
      cursor: not-allowed;
    }

    button {
      align-self: end;
      min-height: 2.75rem;
      border: 0;
      border-radius: 8px;
      background: #9fcf86;
      color: #11110f;
      padding: 0 1rem;
      font: inherit;
      font-weight: 600;
      cursor: pointer;
    }

    button:disabled {
      opacity: 0.45;
      cursor: not-allowed;
    }

    @media (max-width: 640px) {
      .shell {
        padding: 0.75rem;
      }

      header {
        display: grid;
      }

      #status {
        white-space: normal;
      }

      .composer {
        grid-template-columns: 1fr;
      }

      button {
        width: 100%;
      }
    }
  </style>
</head>
<body>
  <main class="shell">
    <header>
      <h1>${escapeHtml(courseName)}</h1>
      <p id="status">Agent is working…</p>
    </header>

    <section id="transcript" aria-live="polite"></section>

    <form id="turn-form" class="composer">
      <textarea id="message" name="message" aria-label="Message" placeholder="Message" disabled></textarea>
      <button id="submit" type="submit" disabled>Send</button>
    </form>
  </main>

  <script>${script}</script>
</body>
</html>`;
};

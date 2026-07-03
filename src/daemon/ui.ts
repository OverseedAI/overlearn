import type { TranscriptEntry } from "../course";
import type { LessonSnapshot, RenderedLesson } from "./lessons";
import { renderMarkdown } from "./markdown";

type RenderedTranscriptEntry = TranscriptEntry &
  Readonly<{
    html: string;
  }>;

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
const initialLessons = __LESSONS__;

const form = document.querySelector("#turn-form");
const textarea = document.querySelector("#message");
const submitButton = document.querySelector("#submit");
const statusLine = document.querySelector("#status");
const transcript = document.querySelector("#transcript");
const lessonList = document.querySelector("#lesson-list");
const lessonContent = document.querySelector("#lesson-content");

let lessons = [...initialLessons.lessons];
let selectedLessonId = initialLessons.selectedLessonId;
let userPinnedLesson = false;

const scrollTranscript = () => {
  transcript.scrollTop = transcript.scrollHeight;
};

const latestLesson = () =>
  lessons.reduce((latest, lesson) => {
    if (latest === undefined) return lesson;
    if (lesson.modifiedAtMs > latest.modifiedAtMs) return lesson;
    if (lesson.modifiedAtMs === latest.modifiedAtMs && lesson.id.localeCompare(latest.id) > 0) return lesson;
    return latest;
  }, undefined);

const renderLessonList = () => {
  lessons.sort((left, right) => left.id.localeCompare(right.id));
  lessonList.replaceChildren();

  if (lessons.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "No lessons yet.";
    lessonList.append(empty);
    lessonContent.className = "lesson-content empty-lesson";
    lessonContent.textContent = "No lesson selected.";
    return;
  }

  let selected = lessons.find((lesson) => lesson.id === selectedLessonId);
  if (selected === undefined) {
    selected = latestLesson() ?? lessons[0];
    selectedLessonId = selected?.id;
  }

  for (const lesson of lessons) {
    const tab = document.createElement("button");
    tab.type = "button";
    tab.className = "lesson-tab" + (lesson.id === selectedLessonId ? " active" : "");
    tab.dataset.lessonId = lesson.id;
    tab.textContent = lesson.id;
    tab.addEventListener("click", () => {
      userPinnedLesson = true;
      selectedLessonId = lesson.id;
      renderLessonList();
    });
    lessonList.append(tab);
  }

  if (selected !== undefined) {
    lessonContent.className = "lesson-content prose";
    lessonContent.innerHTML = selected.html;
  }
};

const upsertLesson = (lesson) => {
  const existingIndex = lessons.findIndex((item) => item.id === lesson.id);
  if (existingIndex === -1) {
    lessons.push(lesson);
  } else {
    lessons[existingIndex] = lesson;
  }

  const selectedStillExists = lessons.some((item) => item.id === selectedLessonId);
  if (!userPinnedLesson || !selectedStillExists) {
    selectedLessonId = lesson.id;
    userPinnedLesson = false;
  }

  renderLessonList();
};

const deleteLesson = (id) => {
  lessons = lessons.filter((lesson) => lesson.id !== id);
  const selectedStillExists = lessons.some((lesson) => lesson.id === selectedLessonId);

  if (!selectedStillExists) {
    userPinnedLesson = false;
    selectedLessonId = latestLesson()?.id;
  }

  renderLessonList();
};

const applyLessonEvent = (event) => {
  if (event.action === "upsert") {
    upsertLesson(event.lesson);
    return;
  }

  if (event.action === "delete") {
    deleteLesson(event.id);
    return;
  }

  if (event.action === "snapshot") {
    lessons = [...event.snapshot.lessons];
    const selectedStillExists = lessons.some((lesson) => lesson.id === selectedLessonId);
    if (!userPinnedLesson || !selectedStillExists) {
      userPinnedLesson = false;
      selectedLessonId = event.snapshot.selectedLessonId;
    }
    renderLessonList();
  }
};

const appendEntry = (entry) => {
  const article = document.createElement("article");
  article.className = "entry " + entry.role;

  const meta = document.createElement("div");
  meta.className = "entry-meta";
  meta.textContent = entry.role === "agent" ? "Agent" : "You";

  const body = document.createElement("div");
  body.className = "message-body prose";
  body.innerHTML = entry.html;

  article.append(meta, body);
  transcript.append(article);
  scrollTranscript();
};

const applyStatus = (status) => {
  const waiting = status === "waiting-for-agent";
  statusLine.textContent = waiting ? "Waiting for your message" : "Agent is working…";
  textarea.disabled = !waiting;
  submitButton.disabled = !waiting || textarea.value.trim().length === 0;

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

renderLessonList();

for (const entry of initialTranscript) {
  appendEntry(entry);
}

textarea.addEventListener("input", () => {
  submitButton.disabled = textarea.disabled || textarea.value.trim().length === 0;
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
events.addEventListener("lesson", (event) => {
  applyLessonEvent(JSON.parse(event.data));
});
`;

const renderTranscript = (
  transcript: readonly TranscriptEntry[],
): readonly RenderedTranscriptEntry[] =>
  transcript.map((entry) => ({
    ...entry,
    html: renderMarkdown(entry.text),
  }));

const selectedLesson = (
  snapshot: LessonSnapshot,
): RenderedLesson | undefined => {
  const selectedById =
    snapshot.selectedLessonId === undefined
      ? undefined
      : snapshot.lessons.find((lesson) => lesson.id === snapshot.selectedLessonId);

  return selectedById ?? snapshot.lessons[0];
};

const renderLessonTabs = (snapshot: LessonSnapshot): string => {
  const selected = selectedLesson(snapshot);

  if (snapshot.lessons.length === 0) {
    return '<p class="empty-state">No lessons yet.</p>';
  }

  return snapshot.lessons
    .map((lesson) => {
      const activeClass = lesson.id === selected?.id ? " active" : "";
      return `<button class="lesson-tab${activeClass}" type="button" data-lesson-id="${escapeHtml(
        lesson.id,
      )}">${escapeHtml(lesson.id)}</button>`;
    })
    .join("");
};

const renderLessonContent = (snapshot: LessonSnapshot): string => {
  const lesson = selectedLesson(snapshot);
  if (lesson === undefined) {
    return '<div id="lesson-content" class="lesson-content empty-lesson" aria-live="polite">No lesson selected.</div>';
  }

  return `<div id="lesson-content" class="lesson-content prose" aria-live="polite">${lesson.html}</div>`;
};

export const renderPage = (
  courseName: string,
  transcript: readonly TranscriptEntry[],
  lessons: LessonSnapshot,
): string => {
  const script = clientScript
    .replace("__TRANSCRIPT__", escapeScriptJson(renderTranscript(transcript)))
    .replace("__LESSONS__", escapeScriptJson(lessons));

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
      grid-template-rows: auto minmax(0, 1fr);
      gap: 1rem;
      min-height: 100vh;
      width: min(100%, 92rem);
      margin: 0 auto;
      padding: 1rem;
    }

    header {
      border-bottom: 1px solid #2f302b;
      padding-bottom: 0.875rem;
    }

    h1,
    h2 {
      margin: 0;
      color: #fafaf8;
      font-weight: 600;
    }

    h1 {
      font-size: 1.5rem;
    }

    h2 {
      font-size: 1rem;
    }

    .workspace {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(20rem, 25rem);
      gap: 1rem;
      min-height: 0;
    }

    .lesson-pane {
      display: grid;
      grid-template-columns: minmax(11rem, 14rem) minmax(0, 1fr);
      gap: 1rem;
      min-height: 0;
    }

    .lesson-nav {
      min-height: 0;
      overflow-y: auto;
      border-right: 1px solid #2f302b;
      padding-right: 1rem;
    }

    .lesson-list {
      display: grid;
      gap: 0.4rem;
      margin-top: 0.75rem;
    }

    .lesson-tab {
      width: 100%;
      min-height: 2.25rem;
      border: 1px solid transparent;
      border-radius: 8px;
      background: transparent;
      color: #cfcfca;
      padding: 0.45rem 0.6rem;
      font: inherit;
      text-align: left;
      overflow-wrap: anywhere;
      cursor: pointer;
    }

    .lesson-tab:hover,
    .lesson-tab.active {
      border-color: #44523c;
      background: #20261e;
      color: #f4f4f1;
    }

    .lesson-content {
      min-height: 0;
      overflow-y: auto;
      border: 1px solid #33342f;
      border-radius: 8px;
      background: #151612;
      padding: 1rem 1.125rem;
    }

    .empty-state,
    .empty-lesson {
      margin: 0;
      color: #a1a19a;
      font-size: 0.95rem;
      line-height: 1.5;
    }

    .chat-pane {
      display: grid;
      grid-template-rows: auto minmax(0, 1fr) auto;
      gap: 0.75rem;
      min-height: 0;
      border-left: 1px solid #2f302b;
      padding-left: 1rem;
    }

    .chat-header {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 0.75rem;
    }

    #status {
      margin: 0;
      color: #b9c7a7;
      font-size: 0.9rem;
      white-space: nowrap;
    }

    #transcript {
      min-height: 12rem;
      overflow-y: auto;
      padding: 0.25rem 0.125rem 0.5rem;
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

    .message-body {
      width: min(100%, 46rem);
      border: 1px solid #33342f;
      border-radius: 8px;
      background: #1a1b18;
      padding: 0.75rem 0.875rem;
    }

    .learner .message-body {
      border-color: #44523c;
      background: #20261e;
    }

    .prose {
      color: #eeeeea;
      font-size: 1rem;
      line-height: 1.75;
      overflow-wrap: anywhere;
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
      font-weight: 600;
    }

    .lesson-content h1 {
      font-size: 1.45rem;
    }

    .lesson-content h2 {
      font-size: 1.2rem;
    }

    .lesson-content h3,
    .lesson-content h4,
    .lesson-content h5,
    .lesson-content h6,
    .message-body h1,
    .message-body h2,
    .message-body h3,
    .message-body h4,
    .message-body h5,
    .message-body h6 {
      font-size: 1rem;
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
      gap: 0.75rem;
      border-top: 1px solid #2f302b;
      padding-top: 0.75rem;
    }

    textarea {
      width: 100%;
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

    .send-button {
      justify-self: end;
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

    .send-button:disabled {
      opacity: 0.45;
      cursor: not-allowed;
    }

    @media (max-width: 980px) {
      .workspace {
        grid-template-columns: 1fr;
      }

      .chat-pane {
        border-left: 0;
        border-top: 1px solid #2f302b;
        padding-top: 1rem;
        padding-left: 0;
      }
    }

    @media (max-width: 640px) {
      .shell {
        padding: 0.75rem;
      }

      h1 {
        font-size: 1.25rem;
      }

      .lesson-pane {
        grid-template-columns: 1fr;
      }

      .lesson-nav {
        border-right: 0;
        border-bottom: 1px solid #2f302b;
        padding-right: 0;
        padding-bottom: 0.75rem;
      }

      .chat-header {
        display: grid;
      }

      #status {
        white-space: normal;
      }

      .send-button {
        width: 100%;
      }
    }
  </style>
</head>
<body>
  <main class="shell">
    <header>
      <h1>${escapeHtml(courseName)}</h1>
    </header>

    <div class="workspace">
      <section class="lesson-pane" aria-labelledby="lesson-heading">
        <nav class="lesson-nav" aria-labelledby="lesson-heading">
          <h2 id="lesson-heading">Lessons</h2>
          <div id="lesson-list" class="lesson-list">${renderLessonTabs(
            lessons,
          )}</div>
        </nav>

        ${renderLessonContent(lessons)}
      </section>

      <aside class="chat-pane" aria-label="Chat">
        <div class="chat-header">
          <h2>Chat</h2>
          <p id="status">Agent is working…</p>
        </div>

        <section id="transcript" aria-live="polite"></section>

        <form id="turn-form" class="composer">
          <textarea id="message" name="message" aria-label="Message" placeholder="Message" disabled></textarea>
          <button id="submit" class="send-button" type="submit" disabled>Send</button>
        </form>
      </aside>
    </div>
  </main>

  <script>${script}</script>
</body>
</html>`;
};

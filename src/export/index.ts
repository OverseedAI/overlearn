import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  getCoursePaths,
  isValidDemoFileName,
  readCourseManifest,
  readGlossary,
  readTranscript,
  resolveCourseDirForWait,
  type CourseManifest,
  type DemoEntry,
  type GlossaryEntry,
  type TopicNode,
  type TranscriptEntry,
} from "../course";
import { isLessonFileName, lessonIdFromFileName } from "../daemon/lessons";
import {
  parseDemoDirective,
  renderDemoEmbed,
  renderMarkdown,
  type MarkdownRenderOptions,
} from "../daemon/markdown";

export type StaticExportOptions = Readonly<{
  courseDir: string;
  outDir?: string;
  includeTranscript?: boolean;
  force?: boolean;
}>;

export type StaticExportResult = Readonly<{
  courseDir: string;
  outDir: string;
  files: readonly string[];
  includeTranscript: boolean;
}>;

type Env = Readonly<Record<string, string | undefined>>;

type LessonSource = Readonly<{
  id: string;
  title: string;
  markdown: string;
  directiveDemos: ReadonlySet<string>;
  modifiedAtMs: number;
}>;

type DemoListing = Readonly<{
  demo: DemoEntry;
  source: string;
  lesson?: string;
}>;

type PageKind = "index" | "lesson" | "glossary" | "transcript";

type PageContext = Readonly<{
  manifest: CourseManifest;
  outDir: string;
  pagePath: string;
  title: string;
  pageKind: PageKind;
  content: string;
  topics: readonly TopicNode[];
  lessons: readonly LessonSource[];
  glossary: readonly GlossaryEntry[];
  unassignedDemos: readonly DemoEntry[];
  includeTranscript: boolean;
  currentLessonId: string | undefined;
}>;

const SITE_CSS = String.raw`
:root {
  color-scheme: dark;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  background: #11110f;
  color: #f4f4f1;
}

* {
  box-sizing: border-box;
}

[hidden] {
  display: none !important;
}

body {
  margin: 0;
  min-height: 100vh;
  background: #11110f;
}

a {
  color: inherit;
}

.skip-link {
  position: fixed;
  top: 0.75rem;
  left: 0.75rem;
  z-index: 30;
  transform: translateY(-150%);
  border-radius: 6px;
  background: #9fcf86;
  color: #11110f;
  padding: 0.5rem 0.75rem;
}

.skip-link:focus {
  transform: translateY(0);
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

.site-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  border-bottom: 1px solid #2f302b;
  padding-bottom: 0.875rem;
}

.course-title {
  margin: 0;
  color: #fafaf8;
  font-size: 1.5rem;
  font-weight: 600;
}

.top-nav {
  display: flex;
  gap: 0.35rem;
  border: 1px solid #33342f;
  border-radius: 8px;
  background: #151612;
  padding: 0.25rem;
}

.top-nav a {
  min-height: 2rem;
  border-radius: 6px;
  color: #cfcfca;
  padding: 0.35rem 0.75rem;
  text-decoration: none;
}

.top-nav a:hover,
.top-nav a.active {
  background: #253020;
  color: #f4f4f1;
}

.workspace {
  display: grid;
  grid-template-columns: minmax(13rem, 17rem) minmax(0, 1fr);
  gap: 1rem;
  min-height: 0;
}

.sidebar {
  min-height: 0;
  overflow-y: auto;
  border-right: 1px solid #2f302b;
  padding-right: 1rem;
}

.sidebar h2,
.page-content h1,
.page-content h2,
.page-content h3 {
  color: #fafaf8;
  font-weight: 600;
}

.sidebar h2 {
  margin: 0 0 0.75rem;
  font-size: 1rem;
}

.page-content {
  min-width: 0;
  min-height: 0;
}

.content-panel {
  border: 1px solid #33342f;
  border-radius: 8px;
  background: #151612;
  padding: 1rem 1.125rem;
}

.content-panel + .content-panel,
.demo-section {
  margin-top: 1rem;
}

.topic-tree {
  display: grid;
  gap: 0.3rem;
  margin: 0;
  padding: 0;
  list-style: none;
}

.topic-children {
  margin-top: 0.3rem;
  padding-left: 0.85rem;
  border-left: 1px solid #30352d;
}

.topic-node {
  display: grid;
  gap: 0.3rem;
  min-width: 0;
}

.topic-row,
.demo-leaf,
.lesson-tab {
  display: flex;
  align-items: center;
  gap: 0.45rem;
  min-width: 0;
}

.tree-toggle {
  flex: 0 0 auto;
  width: 1.45rem;
  height: 1.45rem;
  border: 1px solid #30352d;
  border-radius: 6px;
  background: #151612;
  color: #cfcfca;
  font: inherit;
  line-height: 1;
  cursor: pointer;
}

.tree-toggle:hover {
  border-color: #71965f;
  color: #f4f4f1;
}

.tree-spacer {
  flex: 0 0 1.45rem;
}

.topic-link,
.topic-label,
.lesson-tab,
.demo-leaf {
  width: 100%;
  min-height: 2.25rem;
  border: 1px solid transparent;
  border-radius: 8px;
  background: transparent;
  color: #d5d5cf;
  padding: 0.45rem 0.6rem;
  text-align: left;
  text-decoration: none;
  overflow-wrap: anywhere;
}

.topic-label.no-lesson {
  color: #aeb0a8;
}

.topic-link:hover,
.topic-link.active,
.lesson-tab:hover,
.lesson-tab.active,
.demo-leaf:hover {
  border-color: #44523c;
  background: #20261e;
  color: #f4f4f1;
}

.topic-link.current,
.topic-label.current {
  border-color: #8fbf73;
  color: #f4f4f1;
}

.demo-leaf {
  min-height: 2rem;
  color: #c8d7bd;
  font-size: 0.92rem;
}

.demo-badge {
  flex: 0 0 auto;
  border: 1px solid #526747;
  border-radius: 999px;
  color: #bce5a4;
  padding: 0.04rem 0.3rem;
  font-size: 0.68rem;
  font-weight: 700;
  line-height: 1.35;
  text-transform: uppercase;
}

.sidebar-section {
  display: grid;
  gap: 0.4rem;
  margin-top: 0.85rem;
  border-top: 1px solid #2f302b;
  padding-top: 0.75rem;
}

.sidebar-section h3 {
  margin: 0 0 0.1rem;
  color: #a1a19a;
  font-size: 0.78rem;
  font-weight: 600;
  letter-spacing: 0;
  text-transform: uppercase;
}

.lesson-list,
.glossary-list,
.transcript-list,
.demo-grid {
  display: grid;
  gap: 0.75rem;
}

.lesson-row,
.glossary-entry,
.transcript-entry {
  display: grid;
  gap: 0.45rem;
  border: 1px solid #30312d;
  border-radius: 8px;
  background: #1a1b18;
  padding: 0.85rem 0.95rem;
}

.lesson-row a,
.glossary-entry a,
.term-card-link {
  color: #9fcf86;
  text-decoration: underline;
  text-underline-offset: 0.2em;
}

.lesson-row h2,
.glossary-entry h2,
.transcript-entry h2 {
  margin: 0;
  font-size: 1rem;
}

.lesson-meta,
.transcript-meta,
.empty-state {
  margin: 0;
  color: #a1a19a;
  font-size: 0.9rem;
  line-height: 1.5;
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

.prose h1 {
  font-size: 1.45rem;
}

.prose h2 {
  font-size: 1.2rem;
}

.prose h3,
.prose h4,
.prose h5,
.prose h6 {
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

.term {
  border-bottom: 1px dotted #b7dd88;
  color: #d9f6b3;
  cursor: help;
}

.term:focus {
  border-radius: 4px;
  outline: 2px solid #8fbf73;
  outline-offset: 2px;
}

.term-card {
  position: fixed;
  z-index: 20;
  width: max-content;
  max-width: min(22rem, calc(100vw - 1.5rem));
  border: 1px solid #4d6041;
  border-radius: 8px;
  background: #20231d;
  box-shadow: 0 1rem 2.5rem rgb(0 0 0 / 45%);
  color: #eeeeea;
  padding: 0.75rem 0.85rem;
  line-height: 1.45;
}

.term-card-title {
  color: #fafaf8;
  font-weight: 600;
}

.term-card p {
  margin: 0.35rem 0 0;
}

.term-card-link {
  display: inline-block;
  margin-top: 0.5rem;
}

.demo-card {
  display: grid;
  overflow: hidden;
  border: 1px solid #3a4933;
  border-radius: 8px;
  background: #121410;
}

.demo-titlebar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  border-bottom: 1px solid #2c3528;
  background: #1a1f17;
  padding: 0.55rem 0.65rem;
}

.demo-title {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  min-width: 0;
  color: #fafaf8;
  font-weight: 600;
  line-height: 1.3;
  overflow-wrap: anywhere;
}

.demo-actions {
  display: flex;
  flex: 0 0 auto;
  gap: 0.35rem;
}

.demo-action {
  min-height: 1.8rem;
  border: 1px solid #42513b;
  border-radius: 6px;
  background: #20261e;
  color: #f4f4f1;
  padding: 0 0.5rem;
  font: inherit;
  font-size: 0.82rem;
  line-height: 1;
  text-decoration: none;
  cursor: pointer;
}

a.demo-action {
  display: inline-flex;
  align-items: center;
}

.demo-action:hover {
  border-color: #71965f;
  background: #293422;
}

.demo-frame {
  display: block;
  width: 100%;
  min-height: 20rem;
  border: 0;
  background: #ffffff;
  aspect-ratio: 16 / 10;
}

.demo-warning {
  border-color: #7d5631;
  background: #21170f;
}

.demo-warning .demo-titlebar {
  border-bottom-color: #6b4828;
  background: #2a1b10;
}

.demo-warning p {
  margin: 0;
  padding: 0.75rem;
  color: #ffd8b0;
}

@media (max-width: 760px) {
  .shell {
    padding: 0.75rem;
  }

  .site-header {
    display: grid;
  }

  .top-nav {
    width: 100%;
  }

  .top-nav a {
    flex: 1;
    text-align: center;
  }

  .workspace {
    grid-template-columns: 1fr;
  }

  .sidebar {
    border-right: 0;
    border-bottom: 1px solid #2f302b;
    padding-right: 0;
    padding-bottom: 0.75rem;
  }
}
`;

const SITE_JS = String.raw`
(() => {
  const glossaryData = document.querySelector("#glossary-data");
  const termCard = document.querySelector("#term-card");
  const glossary = new Map();
  let currentTermElement = undefined;
  let hideTermCardTimer = undefined;

  if (glossaryData !== null && glossaryData.textContent !== null) {
    for (const entry of JSON.parse(glossaryData.textContent)) {
      glossary.set(entry.term.toLocaleLowerCase(), entry);
    }
  }

  const clearHideTermCardTimer = () => {
    if (hideTermCardTimer !== undefined) {
      clearTimeout(hideTermCardTimer);
      hideTermCardTimer = undefined;
    }
  };

  const hideTermCard = () => {
    if (!(termCard instanceof HTMLElement)) {
      return;
    }

    clearHideTermCardTimer();
    termCard.hidden = true;
    termCard.classList.remove("visible");
    currentTermElement = undefined;
  };

  const scheduleHideTermCard = () => {
    clearHideTermCardTimer();
    hideTermCardTimer = setTimeout(hideTermCard, 120);
  };

  const positionTermCard = (target) => {
    if (!(termCard instanceof HTMLElement)) {
      return;
    }

    const gap = 8;
    const margin = 12;
    const rect = target.getBoundingClientRect();
    const cardRect = termCard.getBoundingClientRect();
    const left = Math.min(
      Math.max(rect.left, margin),
      window.innerWidth - cardRect.width - margin,
    );
    const top =
      rect.bottom + gap + cardRect.height <= window.innerHeight - margin
        ? rect.bottom + gap
        : Math.max(rect.top - cardRect.height - gap, margin);

    termCard.style.left = left + "px";
    termCard.style.top = top + "px";
  };

  const showTermCard = (target) => {
    if (!(termCard instanceof HTMLElement)) {
      return;
    }

    const term = target.dataset.term;
    const entry = term === undefined ? undefined : glossary.get(term.toLocaleLowerCase());
    if (entry === undefined) {
      hideTermCard();
      return;
    }

    clearHideTermCardTimer();
    currentTermElement = target;
    termCard.replaceChildren();

    const title = document.createElement("div");
    title.className = "term-card-title";
    title.textContent = entry.term;

    const definition = document.createElement("p");
    definition.textContent = entry.def;

    termCard.append(title, definition);

    if (entry.lessonHref !== undefined) {
      const lessonLink = document.createElement("a");
      lessonLink.className = "term-card-link";
      lessonLink.href = entry.lessonHref;
      lessonLink.textContent = "first taught in " + entry.lesson;
      termCard.append(lessonLink);
    }

    termCard.hidden = false;
    termCard.classList.add("visible");
    positionTermCard(target);
  };

  const setExpanded = (button, expanded) => {
    const branchId = button.getAttribute("aria-controls");
    const branch =
      branchId === null ? undefined : document.getElementById(branchId);

    button.setAttribute("aria-expanded", expanded ? "true" : "false");
    button.textContent = expanded ? "-" : "+";
    if (branch !== undefined && branch !== null) {
      branch.hidden = !expanded;
    }
  };

  document.addEventListener("click", (event) => {
    if (!(event.target instanceof Element)) {
      return;
    }

    const toggle = event.target.closest("[data-tree-toggle]");
    if (toggle instanceof HTMLButtonElement) {
      const expanded = toggle.getAttribute("aria-expanded") === "true";
      setExpanded(toggle, !expanded);
      return;
    }

    const fullscreen = event.target.closest("[data-demo-fullscreen]");
    if (!(fullscreen instanceof HTMLElement)) {
      return;
    }

    const card = fullscreen.closest(".demo-card");
    const frame = card?.querySelector("iframe");
    if (frame instanceof HTMLIFrameElement && frame.requestFullscreen !== undefined) {
      void frame.requestFullscreen();
    }
  });

  document.addEventListener("pointerover", (event) => {
    if (!(event.target instanceof Element)) {
      return;
    }

    const term = event.target.closest(".term");
    if (term instanceof HTMLElement) {
      showTermCard(term);
    }
  });

  document.addEventListener("pointerout", (event) => {
    if (!(event.target instanceof Element)) {
      return;
    }

    if (event.target.closest(".term") instanceof HTMLElement) {
      scheduleHideTermCard();
    }
  });

  document.addEventListener("focusin", (event) => {
    if (event.target instanceof HTMLElement && event.target.classList.contains("term")) {
      showTermCard(event.target);
    }
  });

  document.addEventListener("focusout", (event) => {
    if (event.target instanceof HTMLElement && event.target.classList.contains("term")) {
      scheduleHideTermCard();
    }
  });

  if (termCard instanceof HTMLElement) {
    termCard.addEventListener("pointerover", clearHideTermCardTimer);
    termCard.addEventListener("pointerout", scheduleHideTermCard);
  }

  window.addEventListener("resize", () => {
    if (currentTermElement instanceof HTMLElement) {
      positionTermCard(currentTermElement);
    }
  });
})();
`;

const hasErrorCode = (error: unknown, code: string): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === code;

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

const pathExists = async (path: string): Promise<boolean> => {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return false;
    }

    throw error;
  }
};

const readDirectory = async (directory: string): Promise<readonly string[]> => {
  try {
    return await readdir(directory);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return [];
    }

    throw error;
  }
};

const assertWritableOutDir = async (
  outDir: string,
  force: boolean,
): Promise<void> => {
  try {
    const outStat = await stat(outDir);
    if (!outStat.isDirectory()) {
      throw new Error(`Export output path exists and is not a directory: ${outDir}`);
    }

    const entries = await readdir(outDir);
    if (entries.length > 0 && !force) {
      throw new Error(
        `Refusing to write into nonempty export directory: ${outDir}. Use --force to replace it.`,
      );
    }

    if (entries.length > 0) {
      await rm(outDir, { recursive: true, force: true });
    }
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) {
      throw error;
    }
  }

  await mkdir(outDir, { recursive: true });
};

const containsPath = (parentPath: string, childPath: string): boolean => {
  const relativePath = relative(parentPath, childPath);
  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !isAbsolute(relativePath))
  );
};

const assertSafeOutDir = (courseDir: string, outDir: string): void => {
  const paths = getCoursePaths(courseDir);

  if (containsPath(outDir, courseDir)) {
    throw new Error(
      `Refusing to export into ${outDir} because it contains the course directory.`,
    );
  }

  if (containsPath(paths.runtimeDir, outDir)) {
    throw new Error(
      `Refusing to export into runtime directory: ${paths.runtimeDir}.`,
    );
  }
};

const toSitePath = (path: string): string => path.split(sep).join("/");

const withRelativePrefix = (path: string): string =>
  path === "" ? "." : path.startsWith(".") ? path : `./${path}`;

const encodeRelativeUrl = (path: string): string =>
  path
    .split("/")
    .map((segment) =>
      segment === "." || segment === ".." ? segment : encodeURIComponent(segment),
    )
    .join("/");

const relativeUrl = (fromDir: string, targetPath: string): string =>
  encodeRelativeUrl(withRelativePrefix(toSitePath(relative(fromDir, targetPath))));

const pageDirectory = (outDir: string, pagePath: string): string =>
  dirname(join(outDir, pagePath));

const outputPath = (outDir: string, ...segments: readonly string[]): string =>
  join(outDir, ...segments);

const lessonOutputPath = (outDir: string, lessonId: string): string =>
  outputPath(outDir, "lessons", `${lessonId}.html`);

const demoOutputPath = (outDir: string, file: string): string =>
  outputPath(outDir, "demos", file);

const pageHref = (
  outDir: string,
  fromPageDir: string,
  ...targetSegments: readonly string[]
): string => relativeUrl(fromPageDir, outputPath(outDir, ...targetSegments));

const lessonHref = (
  outDir: string,
  fromPageDir: string,
  lessonId: string,
): string => relativeUrl(fromPageDir, lessonOutputPath(outDir, lessonId));

const demoHref = (outDir: string, fromPageDir: string, file: string): string =>
  relativeUrl(fromPageDir, demoOutputPath(outDir, file));

const isExternalHref = (href: string): boolean =>
  /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//");

const resolveStaticMarkdownHref = (href: string): string => {
  const trimmed = href.trim();
  if (trimmed.length === 0 || trimmed.startsWith("/") || isExternalHref(trimmed)) {
    return "#";
  }

  return trimmed;
};

const staticMarkdownOptions = (
  outDir: string,
  fromPageDir: string,
  glossary: readonly GlossaryEntry[],
  demoFiles: ReadonlySet<string>,
): MarkdownRenderOptions => ({
  glossary,
  demoFiles,
  // Chromium loads sandboxed file:// iframes from plain relative src values, so
  // export keeps demos as copied files instead of srcdoc to preserve them verbatim.
  resolveDemoHref: (file) => demoHref(outDir, fromPageDir, file),
  resolveLinkHref: resolveStaticMarkdownHref,
});

const slug = (value: string): string => {
  const slugged = value
    .trim()
    .toLocaleLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return slugged.length === 0 ? "item" : slugged;
};

const demoAnchor = (file: string): string => `demo-${slug(file)}`;

const firstHeading = (markdown: string): string | undefined => {
  for (const line of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    const match = /^#{1,6}\s+(.+?)\s*$/.exec(line);
    const title = match?.[1]?.trim();
    if (title !== undefined && title.length > 0) {
      return title;
    }
  }

  return undefined;
};

const collectDirectiveDemos = (markdown: string): ReadonlySet<string> => {
  const demos = new Set<string>();

  for (const line of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    const directive = parseDemoDirective(line);
    if (directive?.ok === true) {
      demos.add(directive.file);
    }
  }

  return demos;
};

const readLessonSources = async (lessonsDir: string): Promise<readonly LessonSource[]> => {
  const fileNames = (await readDirectory(lessonsDir))
    .filter(isLessonFileName)
    .sort((left, right) => left.localeCompare(right));

  const lessons = await Promise.all(
    fileNames.map(async (fileName) => {
      const filePath = join(lessonsDir, fileName);
      const [markdown, fileStat] = await Promise.all([
        readFile(filePath, "utf8"),
        stat(filePath),
      ]);
      const id = lessonIdFromFileName(fileName);

      return {
        id,
        title: firstHeading(markdown) ?? id,
        markdown,
        directiveDemos: collectDirectiveDemos(markdown),
        modifiedAtMs: fileStat.mtimeMs,
      };
    }),
  );

  return lessons;
};

const readDemoFileNames = async (demosDir: string): Promise<readonly string[]> =>
  (await readDirectory(demosDir))
    .filter(isValidDemoFileName)
    .sort((left, right) => left.localeCompare(right));

const walkTopics = (
  topics: readonly TopicNode[],
  visit: (topic: TopicNode) => void,
): void => {
  for (const topic of topics) {
    visit(topic);
    walkTopics(topic.children, visit);
  }
};

const currentTopicLessonId = (topics: readonly TopicNode[]): string | undefined => {
  let lessonId: string | undefined;

  walkTopics(topics, (topic) => {
    if (lessonId === undefined && topic.current && topic.lesson !== undefined) {
      lessonId = topic.lesson;
    }
  });

  return lessonId;
};

const assignedLessonIds = (topics: readonly TopicNode[]): ReadonlySet<string> => {
  const ids = new Set<string>();

  walkTopics(topics, (topic) => {
    if (topic.lesson !== undefined) {
      ids.add(topic.lesson);
    }
  });

  return ids;
};

const topicTitleForLesson = (
  topics: readonly TopicNode[],
  lessonId: string,
): string | undefined => {
  let title: string | undefined;

  walkTopics(topics, (topic) => {
    if (title === undefined && topic.lesson === lessonId) {
      title = topic.title;
    }
  });

  return title;
};

const collectDemoListings = (
  topics: readonly TopicNode[],
  unassignedDemos: readonly DemoEntry[],
): readonly DemoListing[] => {
  const listings: DemoListing[] = [];

  walkTopics(topics, (topic) => {
    for (const demo of topic.demos ?? []) {
      listings.push({
        demo,
        source: topic.title,
        ...(topic.lesson === undefined ? {} : { lesson: topic.lesson }),
      });
    }
  });

  for (const demo of unassignedDemos) {
    listings.push({ demo, source: "Unassigned demos" });
  }

  return listings;
};

const uniqueListingsByFile = (
  listings: readonly DemoListing[],
): readonly DemoListing[] => {
  const seen = new Set<string>();
  const unique: DemoListing[] = [];

  for (const listing of listings) {
    if (seen.has(listing.demo.file)) {
      continue;
    }

    seen.add(listing.demo.file);
    unique.push(listing);
  }

  return unique;
};

const listingsForLesson = (
  listings: readonly DemoListing[],
  lessonId: string,
  omittedFiles: ReadonlySet<string>,
): readonly DemoListing[] =>
  uniqueListingsByFile(
    listings.filter(
      (listing) =>
        listing.lesson === lessonId && !omittedFiles.has(listing.demo.file),
    ),
  );

const renderDemoLeafList = (
  demos: readonly DemoEntry[],
  outDir: string,
  fromPageDir: string,
): string => {
  if (demos.length === 0) {
    return "";
  }

  const indexHref = pageHref(outDir, fromPageDir, "index.html");

  return `<ul class="topic-tree topic-children">${demos
    .map(
      (demo) =>
        `<li class="topic-node"><a class="demo-leaf" href="${escapeHtml(
          `${indexHref}#${demoAnchor(demo.file)}`,
        )}"><span class="demo-badge">demo</span><span>${escapeHtml(
          demo.title ?? demo.file,
        )}</span></a></li>`,
    )
    .join("")}</ul>`;
};

const renderTopicTree = (
  topics: readonly TopicNode[],
  outDir: string,
  fromPageDir: string,
  lessonIds: ReadonlySet<string>,
  currentLessonId: string | undefined,
  nested = false,
): string => {
  if (topics.length === 0 && !nested) {
    return '<p class="empty-state">No topics yet.</p>';
  }

  const className = nested ? "topic-tree topic-children" : "topic-tree";

  return `<ul class="${className}">${topics
    .map((topic) => {
      const branchId = `branch-${slug(topic.path)}`;
      const hasBranch = topic.children.length > 0 || (topic.demos ?? []).length > 0;
      const toggle = hasBranch
        ? `<button class="tree-toggle" type="button" aria-expanded="true" aria-controls="${escapeHtml(
            branchId,
          )}" data-tree-toggle>-</button>`
        : '<span class="tree-spacer" aria-hidden="true"></span>';
      const active = topic.lesson === currentLessonId;
      const current = topic.current;
      const stateClass = `${active ? " active" : ""}${current ? " current" : ""}`;
      const label =
        topic.lesson !== undefined && lessonIds.has(topic.lesson)
          ? `<a class="topic-link${stateClass}" href="${escapeHtml(
              lessonHref(outDir, fromPageDir, topic.lesson),
            )}"${active ? ' aria-current="page"' : ""}>${escapeHtml(
              topic.title,
            )}</a>`
          : `<span class="topic-label no-lesson${stateClass}">${escapeHtml(
              topic.title,
            )}</span>`;
      const demos = renderDemoLeafList(topic.demos ?? [], outDir, fromPageDir);
      const children =
        topic.children.length === 0
          ? ""
          : renderTopicTree(
              topic.children,
              outDir,
              fromPageDir,
              lessonIds,
              currentLessonId,
              true,
            );
      const branch = hasBranch
        ? `<div id="${escapeHtml(branchId)}">${demos}${children}</div>`
        : "";

      return `<li class="topic-node"><div class="topic-row">${toggle}${label}</div>${branch}</li>`;
    })
    .join("")}</ul>`;
};

const renderUnassignedLessons = (
  topics: readonly TopicNode[],
  lessons: readonly LessonSource[],
  outDir: string,
  fromPageDir: string,
  currentLessonId: string | undefined,
): string => {
  const assigned = assignedLessonIds(topics);
  const unassigned = lessons.filter((lesson) => !assigned.has(lesson.id));

  if (unassigned.length === 0) {
    return "";
  }

  return `<section class="sidebar-section"><h3>Unassigned lessons</h3>${unassigned
    .map(
      (lesson) =>
        `<a class="lesson-tab${lesson.id === currentLessonId ? " active" : ""}" href="${escapeHtml(
          lessonHref(outDir, fromPageDir, lesson.id),
        )}">${escapeHtml(lesson.title)}</a>`,
    )
    .join("")}</section>`;
};

const renderUnassignedDemos = (
  demos: readonly DemoEntry[],
  outDir: string,
  fromPageDir: string,
): string =>
  demos.length === 0
    ? ""
    : `<section class="sidebar-section"><h3>Unassigned demos</h3>${renderDemoLeafList(
        demos,
        outDir,
        fromPageDir,
      )}</section>`;

const glossaryPayload = (
  glossary: readonly GlossaryEntry[],
  outDir: string,
  fromPageDir: string,
  lessonIds: ReadonlySet<string>,
): readonly unknown[] =>
  glossary.map((entry) => ({
    term: entry.term,
    def: entry.def,
    ...(entry.lesson !== undefined && lessonIds.has(entry.lesson)
      ? {
          lesson: entry.lesson,
          lessonHref: lessonHref(outDir, fromPageDir, entry.lesson),
        }
      : {}),
  }));

const renderTopNav = (
  context: PageContext,
  fromPageDir: string,
): string => {
  const navItems: readonly Readonly<{
    kind: PageKind;
    label: string;
    href: string;
  }>[] = [
    {
      kind: "index",
      label: "Overview",
      href: pageHref(context.outDir, fromPageDir, "index.html"),
    },
    {
      kind: "glossary",
      label: "Glossary",
      href: pageHref(context.outDir, fromPageDir, "glossary.html"),
    },
    ...(context.includeTranscript
      ? [
          {
            kind: "transcript" as const,
            label: "Transcript",
            href: pageHref(context.outDir, fromPageDir, "transcript.html"),
          },
        ]
      : []),
  ];

  return `<nav class="top-nav" aria-label="Site">${navItems
    .map(
      (item) =>
        `<a class="${item.kind === context.pageKind ? "active" : ""}" href="${escapeHtml(
          item.href,
        )}">${escapeHtml(item.label)}</a>`,
    )
    .join("")}</nav>`;
};

const renderPage = (context: PageContext): string => {
  const fromPageDir = pageDirectory(context.outDir, context.pagePath);
  const lessonIds = new Set(context.lessons.map((lesson) => lesson.id));
  const glossaryJson = escapeScriptJson(
    glossaryPayload(context.glossary, context.outDir, fromPageDir, lessonIds),
  );

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(context.title)}</title>
  <link rel="stylesheet" href="${escapeHtml(
    pageHref(context.outDir, fromPageDir, "assets", "site.css"),
  )}">
  <script id="glossary-data" type="application/json">${glossaryJson}</script>
  <script src="${escapeHtml(
    pageHref(context.outDir, fromPageDir, "assets", "site.js"),
  )}" defer></script>
</head>
<body>
  <a class="skip-link" href="#content">Skip to content</a>
  <main class="shell">
    <header class="site-header">
      <p class="course-title">${escapeHtml(context.manifest.name)}</p>
      ${renderTopNav(context, fromPageDir)}
    </header>
    <div class="workspace">
      <aside class="sidebar" aria-labelledby="topics-heading">
        <h2 id="topics-heading">Topics</h2>
        ${renderTopicTree(
          context.topics,
          context.outDir,
          fromPageDir,
          lessonIds,
          context.currentLessonId,
        )}
        ${renderUnassignedLessons(
          context.topics,
          context.lessons,
          context.outDir,
          fromPageDir,
          context.currentLessonId,
        )}
        ${renderUnassignedDemos(context.unassignedDemos, context.outDir, fromPageDir)}
      </aside>
      <section id="content" class="page-content" tabindex="-1">
        ${context.content}
      </section>
    </div>
    <div id="term-card" class="term-card" role="tooltip" hidden></div>
  </main>
</body>
</html>`;
};

const renderLessonList = (
  lessons: readonly LessonSource[],
  topics: readonly TopicNode[],
  outDir: string,
  fromPageDir: string,
): string => {
  if (lessons.length === 0) {
    return '<p class="empty-state">No lessons yet.</p>';
  }

  return `<div class="lesson-list">${lessons
    .map((lesson) => {
      const topicTitle = topicTitleForLesson(topics, lesson.id);
      return `<article class="lesson-row"><h2><a href="${escapeHtml(
        lessonHref(outDir, fromPageDir, lesson.id),
      )}">${escapeHtml(lesson.title)}</a></h2>${
        topicTitle === undefined
          ? ""
          : `<p class="lesson-meta">${escapeHtml(topicTitle)}</p>`
      }</article>`;
    })
    .join("")}</div>`;
};

const renderDemoCatalog = (
  listings: readonly DemoListing[],
  outDir: string,
  fromPageDir: string,
  glossary: readonly GlossaryEntry[],
  demoFiles: ReadonlySet<string>,
): string => {
  const uniqueListings = uniqueListingsByFile(listings);

  if (uniqueListings.length === 0) {
    return "";
  }

  const markdownOptions = staticMarkdownOptions(
    outDir,
    fromPageDir,
    glossary,
    demoFiles,
  );

  return `<section class="demo-section content-panel"><h1>Demos</h1><div class="demo-grid">${uniqueListings
    .map(
      (listing) =>
        `<section id="${escapeHtml(demoAnchor(listing.demo.file))}">${renderDemoEmbed(
          listing.demo.file,
          listing.demo.title,
          markdownOptions,
        )}<p class="lesson-meta">${escapeHtml(listing.source)}</p></section>`,
    )
    .join("")}</div></section>`;
};

const renderIndexContent = (
  manifest: CourseManifest,
  lessons: readonly LessonSource[],
  glossary: readonly GlossaryEntry[],
  listings: readonly DemoListing[],
  outDir: string,
  demoFiles: ReadonlySet<string>,
): string => {
  const fromPageDir = pageDirectory(outDir, "index.html");

  return [
    `<section class="content-panel"><h1>${escapeHtml(
      manifest.name,
    )}</h1>${renderLessonList(lessons, manifest.topics, outDir, fromPageDir)}</section>`,
    renderDemoCatalog(listings, outDir, fromPageDir, glossary, demoFiles),
  ]
    .filter((section) => section.length > 0)
    .join("");
};

const renderLessonContent = (
  lesson: LessonSource,
  listings: readonly DemoListing[],
  outDir: string,
  glossary: readonly GlossaryEntry[],
  demoFiles: ReadonlySet<string>,
): string => {
  const pagePath = join("lessons", `${lesson.id}.html`);
  const fromPageDir = pageDirectory(outDir, pagePath);
  const markdownOptions = staticMarkdownOptions(
    outDir,
    fromPageDir,
    glossary,
    demoFiles,
  );
  const lessonDemos = listingsForLesson(listings, lesson.id, lesson.directiveDemos);
  const demoSection =
    lessonDemos.length === 0
      ? ""
      : `<section class="demo-section content-panel"><h1>Demos</h1><div class="demo-grid">${lessonDemos
          .map(
            (listing) =>
              `<section id="${escapeHtml(
                demoAnchor(listing.demo.file),
              )}">${renderDemoEmbed(
                listing.demo.file,
                listing.demo.title,
                markdownOptions,
              )}</section>`,
          )
          .join("")}</div></section>`;

  return `<article class="content-panel prose">${renderMarkdown(
    lesson.markdown,
    markdownOptions,
  )}</article>${demoSection}`;
};

const sortedGlossary = (
  glossary: readonly GlossaryEntry[],
): readonly GlossaryEntry[] =>
  [...glossary].sort((left, right) => left.term.localeCompare(right.term));

const renderGlossaryContent = (
  glossary: readonly GlossaryEntry[],
  outDir: string,
  lessons: readonly LessonSource[],
): string => {
  const fromPageDir = pageDirectory(outDir, "glossary.html");
  const lessonIds = new Set(lessons.map((lesson) => lesson.id));
  const entries = sortedGlossary(glossary);

  if (entries.length === 0) {
    return '<section class="content-panel"><h1>Glossary</h1><p class="empty-state">No glossary terms yet.</p></section>';
  }

  return `<section class="content-panel"><h1>Glossary</h1><div class="glossary-list">${entries
    .map(
      (entry) =>
        `<article class="glossary-entry"><h2>${escapeHtml(
          entry.term,
        )}</h2><p>${escapeHtml(entry.def)}</p>${
          entry.lesson !== undefined && lessonIds.has(entry.lesson)
            ? `<a href="${escapeHtml(
                lessonHref(outDir, fromPageDir, entry.lesson),
              )}">first taught in ${escapeHtml(entry.lesson)}</a>`
            : ""
        }</article>`,
    )
    .join("")}</div></section>`;
};

const renderTranscriptEntry = (
  entry: TranscriptEntry,
  outDir: string,
  fromPageDir: string,
  glossary: readonly GlossaryEntry[],
  demoFiles: ReadonlySet<string>,
): string => {
  const markdownOptions = staticMarkdownOptions(
    outDir,
    fromPageDir,
    glossary,
    demoFiles,
  );
  const meta = `${entry.role === "agent" ? "Agent" : "Learner"} - ${entry.at}`;
  const body =
    entry.kind === "demo"
      ? renderDemoEmbed(entry.file, entry.title, markdownOptions)
      : renderMarkdown(entry.text, markdownOptions);

  return `<article class="transcript-entry ${escapeHtml(
    entry.role,
  )}"><p class="transcript-meta">${escapeHtml(
    meta,
  )}</p><div class="prose">${body}</div></article>`;
};

const renderTranscriptContent = (
  transcript: readonly TranscriptEntry[],
  outDir: string,
  glossary: readonly GlossaryEntry[],
  demoFiles: ReadonlySet<string>,
): string => {
  const fromPageDir = pageDirectory(outDir, "transcript.html");

  if (transcript.length === 0) {
    return '<section class="content-panel"><h1>Transcript</h1><p class="empty-state">No transcript entries yet.</p></section>';
  }

  return `<section class="content-panel"><h1>Transcript</h1><div class="transcript-list">${transcript
    .map((entry) =>
      renderTranscriptEntry(entry, outDir, fromPageDir, glossary, demoFiles),
    )
    .join("")}</div></section>`;
};

const writeOutputFile = async (
  outDir: string,
  relativeFile: string,
  contents: string,
  files: string[],
): Promise<void> => {
  const filePath = outputPath(outDir, ...relativeFile.split("/"));
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, contents, "utf8");
  files.push(relativeFile);
};

const copyDemoFiles = async (
  courseDemosDir: string,
  outDir: string,
  demoFileNames: readonly string[],
  files: string[],
): Promise<void> => {
  for (const fileName of demoFileNames) {
    const targetPath = demoOutputPath(outDir, fileName);
    await mkdir(dirname(targetPath), { recursive: true });
    await copyFile(join(courseDemosDir, fileName), targetPath);
    files.push(toSitePath(join("demos", fileName)));
  }
};

const defaultOutDir = (courseDir: string): string => join(courseDir, "export");

export const resolveStaticExportCourseDir = async (
  name: string | undefined,
  env: Env = process.env,
  cwd = process.cwd(),
): Promise<string> => {
  if (name === undefined) {
    return await resolveCourseDirForWait(undefined, env, cwd);
  }

  const candidate = resolve(cwd, name);
  const looksLikePath =
    name === "." ||
    name === ".." ||
    name.startsWith(".") ||
    name.includes("/") ||
    name.includes("\\");

  if (looksLikePath || (await pathExists(getCoursePaths(candidate).courseJson))) {
    await readCourseManifest(candidate);
    return candidate;
  }

  return await resolveCourseDirForWait(name, env, cwd);
};

export const exportCourse = async (
  options: StaticExportOptions,
): Promise<StaticExportResult> => {
  const courseDir = resolve(options.courseDir);
  const outDir = resolve(options.outDir ?? defaultOutDir(courseDir));
  const includeTranscript = options.includeTranscript === true;
  const force = options.force === true;
  const paths = getCoursePaths(courseDir);

  assertSafeOutDir(courseDir, outDir);

  const [manifest, glossary, lessons, demoFileNames] = await Promise.all([
    readCourseManifest(courseDir),
    readGlossary(courseDir),
    readLessonSources(paths.lessonsDir),
    readDemoFileNames(paths.demosDir),
  ]);
  const demoFiles = new Set(demoFileNames);
  const demoListings = collectDemoListings(
    manifest.topics,
    manifest.unassignedDemos,
  );
  const files: string[] = [];

  await assertWritableOutDir(outDir, force);
  await writeOutputFile(outDir, "assets/site.css", SITE_CSS.trimStart(), files);
  await writeOutputFile(outDir, "assets/site.js", SITE_JS.trimStart(), files);
  await copyDemoFiles(paths.demosDir, outDir, demoFileNames, files);

  const indexContent = renderIndexContent(
    manifest,
    lessons,
    glossary,
    demoListings,
    outDir,
    demoFiles,
  );
  await writeOutputFile(
    outDir,
    "index.html",
    renderPage({
      manifest,
      outDir,
      pagePath: "index.html",
      title: manifest.name,
      pageKind: "index",
      content: indexContent,
      topics: manifest.topics,
      lessons,
      glossary,
      unassignedDemos: manifest.unassignedDemos,
      includeTranscript,
      currentLessonId: currentTopicLessonId(manifest.topics),
    }),
    files,
  );

  for (const lesson of lessons) {
    const pagePath = toSitePath(join("lessons", `${lesson.id}.html`));
    await writeOutputFile(
      outDir,
      pagePath,
      renderPage({
        manifest,
        outDir,
        pagePath,
        title: `${lesson.title} - ${manifest.name}`,
        pageKind: "lesson",
        content: renderLessonContent(
          lesson,
          demoListings,
          outDir,
          glossary,
          demoFiles,
        ),
        topics: manifest.topics,
        lessons,
        glossary,
        unassignedDemos: manifest.unassignedDemos,
        includeTranscript,
        currentLessonId: lesson.id,
      }),
      files,
    );
  }

  await writeOutputFile(
    outDir,
    "glossary.html",
    renderPage({
      manifest,
      outDir,
      pagePath: "glossary.html",
      title: `Glossary - ${manifest.name}`,
      pageKind: "glossary",
      content: renderGlossaryContent(glossary, outDir, lessons),
      topics: manifest.topics,
      lessons,
      glossary,
      unassignedDemos: manifest.unassignedDemos,
      includeTranscript,
      currentLessonId: currentTopicLessonId(manifest.topics),
    }),
    files,
  );

  if (includeTranscript) {
    const transcript = await readTranscript(courseDir);
    await writeOutputFile(
      outDir,
      "transcript.html",
      renderPage({
        manifest,
        outDir,
        pagePath: "transcript.html",
        title: `Transcript - ${manifest.name}`,
        pageKind: "transcript",
        content: renderTranscriptContent(
          transcript,
          outDir,
          glossary,
          demoFiles,
        ),
        topics: manifest.topics,
        lessons,
        glossary,
        unassignedDemos: manifest.unassignedDemos,
        includeTranscript,
        currentLessonId: currentTopicLessonId(manifest.topics),
      }),
      files,
    );
  }

  return {
    courseDir,
    outDir,
    files: files.sort((left, right) => left.localeCompare(right)),
    includeTranscript,
  };
};

export const formatStaticExportResult = (
  result: StaticExportResult,
  json: boolean,
): string =>
  json
    ? JSON.stringify({
        ok: true,
        kind: "export",
        coursePath: result.courseDir,
        outDir: result.outDir,
        includeTranscript: result.includeTranscript,
        files: result.files,
      })
    : `Exported course to ${result.outDir}`;

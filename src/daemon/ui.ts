import {
  latestMasteryForTopic,
  type ActiveFeynmanCheck,
  type DemoEntry,
  type GlossaryEntry,
  type MasteryEntry,
  type TopicNode,
  type TranscriptEntry,
} from "../course";
import type { LessonSnapshot, RenderedLesson } from "./lessons";
import { renderDemoEmbed, renderMarkdown } from "./markdown";

type RenderedTranscriptEntry = TranscriptEntry &
  Readonly<{
    html: string;
    title?: string;
    lessonMissing?: boolean;
  }>;

type UiRenderStatus = "waiting-for-agent" | "agent-working";

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
const initialGlossary = __GLOSSARY__;
const initialTopics = __TOPICS__;
const initialUnassignedDemos = __UNASSIGNED_DEMOS__;
const initialMastery = __MASTERY__;
const initialActiveFeynman = __ACTIVE_FEYNMAN__ ?? undefined;
const initialStatus = __STATUS__;
const initialHasSeenWait = __HAS_SEEN_WAIT__;
const REVIEW_WEAK_NAV_PATH = "overlearn:review-weak";
const enabledComposerLabel = "Message the agent…";
const disabledComposerLabel = "The agent is teaching — you can reply when it pauses";

const form = document.querySelector("#turn-form");
const textarea = document.querySelector("#message");
const submitButton = document.querySelector("#submit");
const statusLine = document.querySelector("#status");
const statusIndicator = document.querySelector("#status-line");
const typingIndicator = document.querySelector("#typing");
const themeToggle = document.querySelector("#theme-toggle");
const feynmanPanel = document.querySelector("#feynman-panel");
const feynmanForm = document.querySelector("#feynman-form");
const feynmanTextarea = document.querySelector("#feynman-answer");
const feynmanSubmit = document.querySelector("#feynman-submit");
const feynmanConcept = document.querySelector("#feynman-concept");
const feynmanPrompt = document.querySelector("#feynman-prompt");
const feynmanReplacement = document.querySelector("#feynman-replacement");
const feynmanStatus = document.querySelector("#feynman-status");
const transcript = document.querySelector("#transcript");
const masterySummary = document.querySelector("#mastery-summary");
const lessonList = document.querySelector("#lesson-list");
const studyRail = document.querySelector("#study-rail");
const railToggle = document.querySelector("#rail-toggle");
const railBody = document.querySelector("#rail-body");
const railLessonDocument = document.querySelector("#rail-lesson-document");
const glossaryList = document.querySelector("#glossary-list");
const termCard = document.querySelector("#term-card");
const railTabs = [...document.querySelectorAll("[data-rail-tab]")];

let lessons = [...initialLessons.lessons];
let selectedLessonId = initialLessons.selectedLessonId;
let topics = [...initialTopics];
let unassignedDemos = [...initialUnassignedDemos];
let masteryScores = [...initialMastery];
let selectedTopicPath = undefined;
let userPinnedTopic = false;
let userPinnedLesson = false;
let transcriptEntries = [...initialTranscript];
let glossary = [...initialGlossary];
let activeFeynman = initialActiveFeynman;
let submittedFeynmanConcept = undefined;
let currentStatus = initialStatus;
let hasSeenWait = initialHasSeenWait;
let railOpen = false;
let activeRailTab = "lesson";
let lessonExpandedById = new Map();
let glossaryHighlightTimer = undefined;
let currentTermElement = undefined;
let hideTermCardTimer = undefined;

const scrollTranscript = () => {
  transcript.scrollTop = transcript.scrollHeight;
};

// Keep the transcript pinned to the latest message unless the learner has
// scrolled up to read history.
const transcriptNearBottom = () =>
  transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 96;

const latestLesson = () =>
  lessons.reduce((latest, lesson) => {
    if (latest === undefined) return lesson;
    if (lesson.modifiedAtMs > latest.modifiedAtMs) return lesson;
    if (lesson.modifiedAtMs === latest.modifiedAtMs && lesson.id.localeCompare(latest.id) > 0) return lesson;
    return latest;
  }, undefined);

const glossaryKey = (term) => term.toLocaleLowerCase();

const glossaryEntryForTerm = (term) =>
  glossary.find((entry) => glossaryKey(entry.term) === glossaryKey(term));

const sortedGlossary = () =>
  [...glossary].sort((left, right) => left.term.localeCompare(right.term));

const sortedLessons = () =>
  [...lessons].sort((left, right) => left.id.localeCompare(right.id));

const lessonForId = (lessonId) =>
  lessons.find((lesson) => lesson.id === lessonId);

const lessonTitleFromHtml = (html, fallback) => {
  const template = document.createElement("template");
  template.innerHTML = html;
  const heading = template.content.querySelector("h1, h2");
  const title = heading?.textContent?.trim();
  return title === undefined || title.length === 0 ? fallback : title;
};

const hideDerivedLessonHeading = (content) => {
  const heading = content.querySelector("h1, h2");
  if (heading instanceof HTMLElement) {
    heading.classList.add("lesson-card-derived-title");
    heading.setAttribute("aria-hidden", "true");
  }
};

const lessonTitleForId = (lessonId) => {
  const lesson = lessonForId(lessonId);
  return lesson === undefined
    ? lessonId
    : lessonTitleFromHtml(lesson.html, lesson.id);
};

const latestLessonEntryId = () => {
  let latest = undefined;
  for (const entry of transcriptEntries) {
    if (entry.kind === "lesson") {
      latest = entry.lesson;
    }
  }
  return latest;
};

const lessonExpanded = (lessonId, latestLessonId = latestLessonEntryId()) =>
  lessonExpandedById.has(lessonId)
    ? lessonExpandedById.get(lessonId) === true
    : lessonId === latestLessonId;

const setLessonCardExpanded = (card, expanded) => {
  card.classList.toggle("collapsed", !expanded);
  card.classList.toggle("expanded", expanded);
  const toggle = card.querySelector("[data-lesson-toggle]");
  const body = card.querySelector(".lesson-card-body");
  if (toggle instanceof HTMLElement) {
    toggle.setAttribute("aria-expanded", expanded ? "true" : "false");
  }
  if (body instanceof HTMLElement) {
    body.hidden = !expanded;
  }
};

const renderRail = () => {
  studyRail.classList.toggle("open", railOpen);
  studyRail.classList.toggle("collapsed", !railOpen);
  railToggle.setAttribute("aria-expanded", railOpen ? "true" : "false");
  railToggle.setAttribute(
    "aria-label",
    railOpen ? "Collapse review rail" : "Open review rail",
  );
  railBody.hidden = !railOpen;

  for (const tab of railTabs) {
    const selected = tab.dataset.railTab === activeRailTab;
    tab.classList.toggle("active", selected);
    tab.setAttribute("aria-selected", selected ? "true" : "false");
  }

  for (const panel of railBody.querySelectorAll("[data-rail-panel]")) {
    panel.hidden = panel.dataset.railPanel !== activeRailTab;
  }
};

const setRailOpen = (open) => {
  railOpen = open;
  renderRail();
};

const setActiveRailTab = (tab) => {
  activeRailTab = tab;
  railOpen = true;
  renderRail();
};

const walkTopics = (nodes, visit) => {
  for (const topic of nodes) {
    visit(topic);
    walkTopics(topic.children ?? [], visit);
  }
};

const findCurrentTopic = () => {
  let current = undefined;
  walkTopics(topics, (topic) => {
    if (topic.current === true) {
      current = topic;
    }
  });
  return current;
};

const findTopicForLesson = (lessonId) => {
  let match = undefined;
  walkTopics(topics, (topic) => {
    if (match === undefined && topic.lesson === lessonId) {
      match = topic;
    }
  });
  return match;
};

const referencedLessonIds = () => {
  const ids = new Set();
  walkTopics(topics, (topic) => {
    if (topic.lesson !== undefined) {
      ids.add(topic.lesson);
    }
  });
  return ids;
};

const masteryTimeMs = (entry) => {
  const parsed = Date.parse(entry.at);
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
};

const compareMasteryRecency = (left, right) => {
  const timeDelta = masteryTimeMs(left) - masteryTimeMs(right);
  if (timeDelta !== 0) return timeDelta;

  return left.at.localeCompare(right.at);
};

const topicConceptIds = (topic) => {
  const segments = topic.path.split("/");
  const slug = segments[segments.length - 1] ?? topic.path;
  return slug === topic.path ? [topic.path] : [topic.path, slug];
};

const masteryForTopic = (topic) => {
  const candidates = new Set(topicConceptIds(topic));
  return masteryScores.reduce((match, entry) => {
    if (!candidates.has(entry.concept)) return match;
    if (match === undefined || compareMasteryRecency(entry, match) > 0) {
      return entry;
    }
    return match;
  }, undefined);
};

const masteryLevel = (entry) => {
  if (entry === undefined) return "ungraded";
  if (entry.score < 50) return "low";
  if (entry.score < 80) return "medium";
  return "high";
};

const topicCount = () => {
  let count = 0;
  walkTopics(topics, () => {
    count += 1;
  });
  return count;
};

const topicMasteryRecords = () => {
  const records = [];
  walkTopics(topics, (topic) => {
    const entry = masteryForTopic(topic);
    if (entry !== undefined) {
      records.push({ topic, entry });
    }
  });
  return records;
};

const compareWeakestRecord = (left, right) => {
  const scoreDelta = left.entry.score - right.entry.score;
  if (scoreDelta !== 0) return scoreDelta;

  const timeDelta = masteryTimeMs(left.entry) - masteryTimeMs(right.entry);
  if (timeDelta !== 0) return timeDelta;

  return left.entry.concept.localeCompare(right.entry.concept);
};

const weakestTopicMastery = () =>
  topicMasteryRecords().sort(compareWeakestRecord)[0];

const renderMasterySummary = () => {
  masterySummary.replaceChildren();

  const total = topicCount();
  const records = topicMasteryRecords();
  const weakest = weakestTopicMastery();

  const line = document.createElement("div");
  line.className = "mastery-summary-line";

  const count = document.createElement("span");
  count.className = "mastery-count";
  count.textContent = records.length + "/" + total + " graded";

  const weak = document.createElement("span");
  weak.className = "mastery-weakest";
  weak.textContent =
    weakest === undefined
      ? "Weakest: none"
      : "Weakest: " + weakest.entry.concept + " (" + weakest.entry.score + ")";

  line.append(count, weak);

  const button = document.createElement("button");
  button.type = "button";
  button.className = "mastery-review";
  button.textContent = "Review weak areas";
  button.disabled = records.length === 0;
  button.addEventListener("click", () => {
    void submitNav(REVIEW_WEAK_NAV_PATH);
  });

  masterySummary.append(line, button);
};

const applyCurrentTopicSelection = () => {
  const topic = findCurrentTopic();
  if (topic === undefined) {
    return;
  }

  if (!userPinnedTopic) {
    selectedTopicPath = topic.path;
  }

  if (
    !userPinnedLesson &&
    topic.lesson !== undefined &&
    lessons.some((lesson) => lesson.id === topic.lesson)
  ) {
    selectedLessonId = topic.lesson;
  }
};

const submitNav = async (path) => {
  applyStatus("agent-working");

  const response = await fetch("/api/nav", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path }),
  });

  if (!response.ok) {
    statusLine.textContent = await response.text();
  }
};

const selectTopic = async (topic) => {
  selectedTopicPath = topic.path;
  userPinnedTopic = true;
  if (topic.lesson !== undefined) {
    selectedLessonId = topic.lesson;
    userPinnedLesson = true;
  }

  renderNavigation();
  await submitNav(topic.path);
};

const selectLesson = (lessonId) => {
  userPinnedLesson = true;
  selectedLessonId = lessonId;
  selectedTopicPath = findTopicForLesson(lessonId)?.path;
  userPinnedTopic = selectedTopicPath !== undefined;
  renderNavigation();
  setActiveRailTab("lesson");
  requestAnimationFrame(() => {
    document.getElementById("rail-lesson-" + lessonId)?.scrollIntoView({
      block: "start",
    });
  });
};

const openDemo = (file) => {
  window.open("/demos/" + encodeURIComponent(file), "_blank", "noopener");
};

const createDemoLeaf = (demo) => {
  const leaf = document.createElement("button");
  leaf.type = "button";
  leaf.className = "demo-leaf";
  leaf.dataset.demoFile = demo.file;

  const badge = document.createElement("span");
  badge.className = "demo-badge";
  badge.textContent = "demo";

  const label = document.createElement("span");
  label.textContent = demo.title ?? demo.file;

  leaf.append(badge, label);
  // Demo leaves open standalone so they remain reachable even without a lesson directive.
  leaf.addEventListener("click", () => {
    openDemo(demo.file);
  });

  return leaf;
};

const createDemoLeafList = (demos) => {
  const list = document.createElement("ul");
  list.className = "topic-tree topic-children demo-leaves";

  for (const demo of demos) {
    const item = document.createElement("li");
    item.className = "topic-node demo-node";
    item.append(createDemoLeaf(demo));
    list.append(item);
  }

  return list;
};

const createTopicList = (nodes, nested = false) => {
  const list = document.createElement("ul");
  list.className = nested ? "topic-tree topic-children" : "topic-tree";

  for (const topic of nodes) {
    const item = document.createElement("li");
    item.className = "topic-node";
    const masteryEntry = masteryForTopic(topic);
    const level = masteryLevel(masteryEntry);

    const button = document.createElement("button");
    button.type = "button";
    button.className =
      "topic-button" +
      (topic.path === selectedTopicPath ? " active" : "") +
      (topic.current === true ? " current" : "") +
      (topic.lesson === undefined ? " no-lesson" : "") +
      " mastery-" +
      level;
    button.dataset.topicPath = topic.path;
    button.title =
      masteryEntry === undefined
        ? topic.title + " - ungraded"
        : topic.title + " - mastery " + masteryEntry.score + "/100 (" + masteryEntry.concept + ")";

    const marker = document.createElement("span");
    marker.className = "mastery-dot";
    marker.setAttribute("aria-hidden", "true");

    const label = document.createElement("span");
    label.className = "topic-label";
    label.textContent = topic.title;

    const chip = document.createElement("span");
    chip.className = "mastery-chip";
    chip.textContent = masteryEntry === undefined ? "—" : String(masteryEntry.score);
    chip.setAttribute(
      "aria-label",
      masteryEntry === undefined
        ? "not graded yet"
        : "mastery score " + masteryEntry.score + " out of 100",
    );

    button.append(marker, label, chip);
    if (topic.current === true) {
      button.setAttribute("aria-current", "page");
    }
    button.addEventListener("click", () => {
      void selectTopic(topic);
    });

    item.append(button);
    if ((topic.demos ?? []).length > 0) {
      item.append(createDemoLeafList(topic.demos));
    }
    if ((topic.children ?? []).length > 0) {
      item.append(createTopicList(topic.children, true));
    }

    list.append(item);
  }

  return list;
};

const renderRailLessonDocument = () => {
  railLessonDocument.replaceChildren();
  const entries = sortedLessons();

  if (entries.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "No lessons yet.";
    railLessonDocument.append(empty);
    return;
  }

  for (const lesson of entries) {
    const section = document.createElement("section");
    section.className = "rail-lesson-section";
    section.id = "rail-lesson-" + lesson.id;
    section.dataset.lessonId = lesson.id;

    const content = document.createElement("div");
    content.className = "lesson-content rail-lesson-content prose";
    content.innerHTML = lesson.html;

    section.append(content);
    railLessonDocument.append(section);
  }
};

const renderNavigation = () => {
  hideTermCard();
  lessons = sortedLessons();
  lessonList.replaceChildren();
  applyCurrentTopicSelection();
  renderMasterySummary();

  if (topics.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "No topics yet.";
    lessonList.append(empty);
  } else {
    lessonList.append(createTopicList(topics));
  }

  const assignedLessonIds = referencedLessonIds();
  const unassignedLessons = lessons.filter((lesson) => !assignedLessonIds.has(lesson.id));

  if (unassignedLessons.length > 0) {
    const section = document.createElement("section");
    section.className = "unassigned-lessons";

    const heading = document.createElement("h3");
    heading.className = "unassigned-heading";
    heading.textContent = "Unassigned lessons";
    section.append(heading);

    for (const lesson of unassignedLessons) {
      const tab = document.createElement("button");
      tab.type = "button";
      tab.className = "lesson-tab" + (lesson.id === selectedLessonId ? " active" : "");
      tab.dataset.lessonId = lesson.id;
      tab.textContent = lesson.id;
      tab.addEventListener("click", () => {
        selectLesson(lesson.id);
      });
      section.append(tab);
    }

    lessonList.append(section);
  }

  if (unassignedDemos.length > 0) {
    const section = document.createElement("section");
    section.className = "unassigned-lessons";

    const heading = document.createElement("h3");
    heading.className = "unassigned-heading";
    heading.textContent = "Unassigned demos";
    section.append(heading);

    for (const demo of unassignedDemos) {
      section.append(createDemoLeaf(demo));
    }

    lessonList.append(section);
  }

  renderRailLessonDocument();
};

const renderGlossaryList = () => {
  glossaryList.replaceChildren();
  const entries = sortedGlossary();

  if (entries.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "No glossary terms yet.";
    glossaryList.append(empty);
    return;
  }

  for (const entry of entries) {
    const article = document.createElement("article");
    article.className = "glossary-entry";
    article.dataset.termKey = glossaryKey(entry.term);

    const title = document.createElement("h3");
    title.textContent = entry.term;

    const definition = document.createElement("p");
    definition.textContent = entry.def;

    article.append(title, definition);

    if (entry.lesson !== undefined) {
      const lessonButton = document.createElement("button");
      lessonButton.type = "button";
      lessonButton.className = "glossary-lesson-link";
      lessonButton.textContent = "first taught in " + entry.lesson;
      lessonButton.addEventListener("click", () => {
        selectLesson(entry.lesson);
      });
      article.append(lessonButton);
    }

    glossaryList.append(article);
  }
};

const highlightGlossaryEntry = (term) => {
  if (glossaryHighlightTimer !== undefined) {
    clearTimeout(glossaryHighlightTimer);
    glossaryHighlightTimer = undefined;
  }

  const key = glossaryKey(term);
  const entry = [...glossaryList.querySelectorAll(".glossary-entry")].find(
    (candidate) =>
      candidate instanceof HTMLElement && candidate.dataset.termKey === key,
  );

  if (!(entry instanceof HTMLElement)) {
    return;
  }

  entry.scrollIntoView({ block: "center" });
  entry.classList.add("highlight");
  glossaryHighlightTimer = setTimeout(() => {
    entry.classList.remove("highlight");
    glossaryHighlightTimer = undefined;
  }, 1400);
};

const openGlossaryTerm = (term) => {
  hideTermCard();
  setActiveRailTab("glossary");
  requestAnimationFrame(() => highlightGlossaryEntry(term));
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

  renderNavigation();
};

const deleteLesson = (id) => {
  lessons = lessons.filter((lesson) => lesson.id !== id);
  const selectedStillExists = lessons.some((lesson) => lesson.id === selectedLessonId);

  if (!selectedStillExists) {
    userPinnedLesson = false;
    selectedLessonId = latestLesson()?.id;
  }

  renderNavigation();
};

const applyLessonEvent = (event) => {
  const stick = transcriptNearBottom();

  if (event.action === "upsert") {
    upsertLesson(event.lesson);
    updateLessonCards(event.lesson.id);
    if (stick) {
      scrollTranscript();
    }
    return;
  }

  if (event.action === "delete") {
    deleteLesson(event.id);
    updateLessonCards(event.id);
    if (stick) {
      scrollTranscript();
    }
    return;
  }

  if (event.action === "snapshot") {
    lessons = [...event.snapshot.lessons];
    const selectedStillExists = lessons.some((lesson) => lesson.id === selectedLessonId);
    if (!userPinnedLesson || !selectedStillExists) {
      userPinnedLesson = false;
      selectedLessonId = event.snapshot.selectedLessonId;
    }
    renderNavigation();
    updateAllLessonCards();
    if (stick) {
      scrollTranscript();
    }
  }
};

const createLessonContentElement = (lessonId) => {
  const lesson = lessonForId(lessonId);
  if (lesson === undefined) {
    const removed = document.createElement("p");
    removed.className = "lesson-removed";
    removed.textContent = "Section removed. " + lessonId + " is no longer available.";
    return removed;
  }

  const content = document.createElement("div");
  content.className = "lesson-content prose";
  content.innerHTML = lesson.html;
  hideDerivedLessonHeading(content);
  return content;
};

const updateLessonCards = (lessonId) => {
  for (const card of transcript.querySelectorAll(".lesson-card")) {
    if (!(card instanceof HTMLElement) || card.dataset.lessonId !== lessonId) {
      continue;
    }

    const lessonMissing = lessonForId(lessonId) === undefined;
    const title = card.querySelector(".lesson-card-title");
    const body = card.querySelector(".lesson-card-body");

    card.classList.toggle("removed", lessonMissing);
    if (title instanceof HTMLElement) {
      title.textContent = lessonTitleForId(lessonId);
    }
    if (body instanceof HTMLElement) {
      body.replaceChildren(createLessonContentElement(lessonId));
    }
  }
};

const updateAllLessonCards = () => {
  const lessonIds = new Set();
  for (const entry of transcriptEntries) {
    if (entry.kind === "lesson") {
      lessonIds.add(entry.lesson);
    }
  }
  for (const lessonId of lessonIds) {
    updateLessonCards(lessonId);
  }
};

const createLessonCardElement = (entry, latestLessonId) => {
  const article = document.createElement("article");
  article.className = "entry lesson-card";
  article.dataset.lessonId = entry.lesson;
  const expanded = lessonExpanded(entry.lesson, latestLessonId);
  const lessonMissing = lessonForId(entry.lesson) === undefined;
  article.classList.toggle("removed", lessonMissing);

  const header = document.createElement("button");
  header.type = "button";
  header.className = "lesson-card-header";
  header.dataset.lessonToggle = entry.lesson;

  const headerText = document.createElement("span");
  headerText.className = "lesson-card-header-text";

  const kicker = document.createElement("span");
  kicker.className = "lesson-card-kicker";
  kicker.textContent = lessonMissing ? "Lesson section removed" : "Lesson section";

  const title = document.createElement("span");
  title.className = "lesson-card-title";
  title.textContent = lessonTitleForId(entry.lesson);

  headerText.append(kicker, title);

  const chevron = document.createElement("span");
  chevron.className = "lesson-card-chevron";
  chevron.setAttribute("aria-hidden", "true");
  chevron.textContent = "⌄";

  header.append(headerText, chevron);

  const body = document.createElement("div");
  body.className = "lesson-card-body";
  body.append(createLessonContentElement(entry.lesson));

  header.addEventListener("click", () => {
    const nextExpanded = article.classList.contains("collapsed");
    lessonExpandedById.set(entry.lesson, nextExpanded);
    setLessonCardExpanded(article, nextExpanded);
  });

  article.append(header, body);
  setLessonCardExpanded(article, expanded);
  return article;
};

const createFeynmanCheckElement = (entry) => {
  const article = document.createElement("article");
  article.className = "entry feynman-check-entry";

  const marker = document.createElement("div");
  marker.className = "feynman-marker";

  const heading = document.createElement("div");
  heading.className = "feynman-marker-heading";

  const title = document.createElement("div");
  title.className = "feynman-kicker";
  title.textContent = "Feynman check";

  const chip = document.createElement("span");
  chip.className = "concept-chip";
  chip.textContent = entry.concept;

  heading.append(title, chip);

  const prompt = document.createElement("div");
  prompt.className = "feynman-marker-prompt prose";
  if (entry.html !== undefined && entry.html.length > 0) {
    prompt.innerHTML = entry.html;
  } else {
    prompt.textContent = entry.prompt;
  }

  marker.append(heading, prompt);
  article.append(marker);
  return article;
};

const createMessageElement = (entry) => {
  const kind = entry.kind ?? "text";
  const article = document.createElement("article");
  const kindClass =
    kind === "feynman-answer"
      ? "feynman-answer-entry"
      : kind === "demo"
        ? "demo"
        : "text";
  article.className = "entry " + entry.role + " " + kindClass;

  const meta = document.createElement("div");
  meta.className = "entry-meta";
  meta.textContent =
    kind === "feynman-answer"
      ? "You · Check answer"
      : entry.role === "agent"
        ? "Agent"
        : "You";

  const body = document.createElement("div");
  body.className =
    "message-body prose" +
    (kind === "demo" ? " demo-message-body" : "") +
    (kind === "feynman-answer" ? " check-answer-body" : "");
  if (entry.html !== undefined && entry.html.length > 0) {
    body.innerHTML = entry.html;
  } else if ("text" in entry) {
    body.textContent = entry.text;
  }

  article.append(meta, body);
  return article;
};

const createEntryElement = (entry, latestLessonId = latestLessonEntryId()) => {
  if (entry.kind === "lesson") {
    return createLessonCardElement(entry, latestLessonId);
  }

  if (entry.kind === "feynman-check") {
    return createFeynmanCheckElement(entry);
  }

  return createMessageElement(entry);
};

const renderTranscript = (options = {}) => {
  hideTermCard();
  transcript.replaceChildren();
  const latestLessonId = latestLessonEntryId();
  for (const entry of transcriptEntries) {
    transcript.append(createEntryElement(entry, latestLessonId));
  }
  if (options.stick !== false) {
    scrollTranscript();
  }
};

const appendEntry = (entry) => {
  const stick = entry.role === "learner" || transcriptNearBottom();
  const previousLatestLessonId = latestLessonEntryId();
  transcriptEntries.push(entry);

  if (entry.kind === "lesson") {
    for (const card of transcript.querySelectorAll(".lesson-card")) {
      if (
        card instanceof HTMLElement &&
        card.dataset.lessonId === previousLatestLessonId &&
        !lessonExpandedById.has(card.dataset.lessonId)
      ) {
        setLessonCardExpanded(card, false);
      }
    }
  }

  transcript.append(createEntryElement(entry, latestLessonEntryId()));
  if (stick) {
    scrollTranscript();
  }
};

const clearHideTermCardTimer = () => {
  if (hideTermCardTimer !== undefined) {
    clearTimeout(hideTermCardTimer);
    hideTermCardTimer = undefined;
  }
};

const hideTermCard = () => {
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
  const term = target.dataset.term;
  const entry = term === undefined ? undefined : glossaryEntryForTerm(term);
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

  if (entry.lesson !== undefined) {
    const lessonButton = document.createElement("button");
    lessonButton.type = "button";
    lessonButton.className = "term-card-link";
    lessonButton.dataset.lessonId = entry.lesson;
    lessonButton.textContent = "first taught in " + entry.lesson;
    termCard.append(lessonButton);
  }

  termCard.hidden = false;
  termCard.classList.add("visible");
  positionTermCard(target);
};

const setFeynmanControls = () => {
  const canSubmit =
    activeFeynman !== undefined &&
    currentStatus === "waiting-for-agent" &&
    feynmanTextarea.value.trim().length > 0;

  feynmanTextarea.disabled =
    activeFeynman === undefined || currentStatus !== "waiting-for-agent";
  feynmanSubmit.disabled = !canSubmit;
};

const renderFeynmanPanel = () => {
  if (activeFeynman === undefined) {
    if (submittedFeynmanConcept === undefined) {
      feynmanPanel.hidden = true;
      feynmanPanel.classList.remove("submitted");
      return;
    }

    feynmanPanel.hidden = false;
    feynmanPanel.classList.add("submitted");
    feynmanConcept.textContent = submittedFeynmanConcept;
    feynmanPrompt.textContent = "Submitted - awaiting grading.";
    feynmanReplacement.hidden = true;
    feynmanStatus.textContent = "Submitted - awaiting grading";
    feynmanTextarea.value = "";
    feynmanForm.hidden = true;
    setFeynmanControls();
    return;
  }

  feynmanPanel.hidden = false;
  feynmanPanel.classList.remove("submitted");
  feynmanForm.hidden = false;
  feynmanConcept.textContent = activeFeynman.concept;
  feynmanPrompt.textContent = activeFeynman.prompt;
  feynmanStatus.textContent = "Answer in your own words.";

  if (activeFeynman.replaced !== undefined) {
    feynmanReplacement.hidden = false;
    feynmanReplacement.textContent =
      "Previous check for " + activeFeynman.replaced.concept + " was replaced.";
  } else {
    feynmanReplacement.hidden = true;
  }

  setFeynmanControls();
};

const statusText = (waiting) => {
  if (waiting) {
    return "Your turn — the agent is waiting";
  }

  return hasSeenWait
    ? "Agent is working…"
    : "Waiting for the agent to start teaching";
};

const applyComposerLabel = (waiting) => {
  const label = waiting ? enabledComposerLabel : disabledComposerLabel;
  textarea.placeholder = label;
  textarea.setAttribute("aria-label", label);
};

const applyStatus = (status, nextHasSeenWait = hasSeenWait) => {
  currentStatus = status;
  hasSeenWait = nextHasSeenWait;
  const waiting = status === "waiting-for-agent";
  statusLine.textContent = statusText(waiting);
  statusIndicator.classList.toggle("working", !waiting);
  typingIndicator.hidden = waiting;
  applyComposerLabel(waiting);
  textarea.disabled = !waiting;
  submitButton.disabled = !waiting || textarea.value.trim().length === 0;
  setFeynmanControls();

  // Auto-focus only on desktop layouts: on small screens it scrolls the page
  // to the composer and pops the keyboard while the learner may be reading.
  if (waiting && window.matchMedia("(min-width: 981px)").matches) {
    textarea.focus();
  }
};

const autosizeComposer = () => {
  textarea.style.height = "auto";
  textarea.style.height = Math.min(textarea.scrollHeight + 2, 200) + "px";
};

const submitMessage = async () => {
  const text = textarea.value.trim();
  if (text.length === 0 || textarea.disabled) {
    return;
  }

  applyStatus("agent-working");
  textarea.value = "";
  autosizeComposer();

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

const submitFeynmanAnswer = async () => {
  const check = activeFeynman;
  const text = feynmanTextarea.value.trim();
  if (check === undefined || text.length === 0 || feynmanTextarea.disabled) {
    return;
  }

  applyStatus("agent-working");

  const response = await fetch("/api/feynman-answer", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      concept: check.concept,
      text,
      keyPoints: check.keyPoints,
    }),
  });

  if (!response.ok) {
    feynmanStatus.textContent = await response.text();
    applyStatus("waiting-for-agent");
    return;
  }

  submittedFeynmanConcept = check.concept;
  activeFeynman = undefined;
  renderFeynmanPanel();
};

renderNavigation();
renderGlossaryList();
renderRail();
renderFeynmanPanel();
renderTranscript();
applyStatus(currentStatus, hasSeenWait);
autosizeComposer();

textarea.addEventListener("input", () => {
  submitButton.disabled = textarea.disabled || textarea.value.trim().length === 0;
  autosizeComposer();
});

themeToggle.addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem("overlearn-theme", next);
  } catch {
    // Persistence is best-effort; the toggle still works for this session.
  }
});

feynmanTextarea.addEventListener("input", setFeynmanControls);

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

feynmanForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void submitFeynmanAnswer();
});

document.addEventListener("click", (event) => {
  if (!(event.target instanceof Element)) {
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

railToggle.addEventListener("click", () => {
  setRailOpen(!railOpen);
});

for (const tab of railTabs) {
  tab.addEventListener("click", () => {
    const railTab = tab.dataset.railTab;
    if (railTab !== undefined) {
      setActiveRailTab(railTab);
    }
  });
}

document.addEventListener("click", (event) => {
  if (!(event.target instanceof Element)) {
    return;
  }

  const term = event.target.closest(".term");
  if (term instanceof HTMLElement && term.dataset.term !== undefined) {
    openGlossaryTerm(term.dataset.term);
  }
});

document.addEventListener("mouseover", (event) => {
  if (!(event.target instanceof Element)) {
    return;
  }

  const term = event.target.closest(".term");
  if (term instanceof HTMLElement) {
    showTermCard(term);
  }
});

document.addEventListener("focusin", (event) => {
  if (!(event.target instanceof HTMLElement) || !event.target.classList.contains("term")) {
    return;
  }

  showTermCard(event.target);
});

document.addEventListener("mouseout", (event) => {
  if (!(event.target instanceof Element) || currentTermElement === undefined) {
    return;
  }

  const term = event.target.closest(".term");
  if (term !== currentTermElement) {
    return;
  }

  if (event.relatedTarget instanceof Node && termCard.contains(event.relatedTarget)) {
    return;
  }

  scheduleHideTermCard();
});

document.addEventListener("focusout", (event) => {
  if (event.target === currentTermElement) {
    if (event.relatedTarget instanceof Node && termCard.contains(event.relatedTarget)) {
      return;
    }

    scheduleHideTermCard();
  }
});

termCard.addEventListener("mouseenter", clearHideTermCardTimer);
termCard.addEventListener("mouseleave", hideTermCard);
termCard.addEventListener("click", (event) => {
  if (!(event.target instanceof HTMLElement)) {
    return;
  }

  const lessonId = event.target.dataset.lessonId;
  if (lessonId !== undefined) {
    selectLesson(lessonId);
    hideTermCard();
  }
});

window.addEventListener("scroll", () => {
  if (currentTermElement !== undefined) {
    positionTermCard(currentTermElement);
  }
}, true);

window.addEventListener("resize", () => {
  if (currentTermElement !== undefined) {
    positionTermCard(currentTermElement);
  }
});

const events = new EventSource("/api/events");
events.addEventListener("status", (event) => {
  const payload = JSON.parse(event.data);
  applyStatus(payload.status, payload.hasSeenWait ?? hasSeenWait);
});
events.addEventListener("message", (event) => {
  appendEntry(JSON.parse(event.data));
});
events.addEventListener("lesson", (event) => {
  applyLessonEvent(JSON.parse(event.data));
});
events.addEventListener("glossary", (event) => {
  glossary = [...JSON.parse(event.data).entries];
  renderGlossaryList();

  if (currentTermElement !== undefined) {
    showTermCard(currentTermElement);
  }
});
events.addEventListener("topics", (event) => {
  const payload = JSON.parse(event.data);
  topics = [...payload.topics];
  unassignedDemos = [...(payload.unassignedDemos ?? [])];
  userPinnedTopic = false;
  userPinnedLesson = false;
  renderNavigation();
});
events.addEventListener("mastery", (event) => {
  masteryScores = [...JSON.parse(event.data).entries];
  renderNavigation();
});
events.addEventListener("feynman", (event) => {
  const payload = JSON.parse(event.data);
  const previous = activeFeynman;
  activeFeynman = payload.activeCheck ?? undefined;
  if (activeFeynman !== undefined) {
    submittedFeynmanConcept = undefined;
    if (
      previous === undefined ||
      previous.concept !== activeFeynman.concept ||
      previous.prompt !== activeFeynman.prompt
    ) {
      feynmanTextarea.value = "";
    }
  }
  renderFeynmanPanel();
});
events.addEventListener("transcript", (event) => {
  const stick = transcriptNearBottom();
  transcriptEntries = [...JSON.parse(event.data).entries];
  renderTranscript({ stick });
});
`;

const decodeBasicEntities = (value: string): string =>
  value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'");

const titleFromLessonHtml = (
  html: string,
  fallback: string,
): string => {
  const match = /<h[12](?:\s[^>]*)?>([\s\S]*?)<\/h[12]>/i.exec(html);
  if (match === null) {
    return fallback;
  }

  const title = decodeBasicEntities(
    match[1]?.replaceAll(/<[^>]*>/g, "").trim() ?? "",
  );
  return title.length === 0 ? fallback : title;
};

const addClassToTag = (tag: string, className: string): string => {
  if (/\sclass=/.test(tag)) {
    return tag.replace(
      /\sclass=(["'])(.*?)\1/i,
      (_match, quote: string, classes: string) =>
        ` class=${quote}${classes} ${className}${quote}`,
    );
  }

  return tag.replace(/>$/, ` class="${className}">`);
};

const addAttributeToTag = (
  tag: string,
  name: string,
  value: string,
): string => {
  if (new RegExp(`\\s${name}=`).test(tag)) {
    return tag;
  }

  return tag.replace(/>$/, ` ${name}="${escapeHtml(value)}">`);
};

const suppressDerivedLessonHeading = (html: string): string =>
  html.replace(/<h[12](?:\s[^>]*)?>/i, (tag) =>
    addAttributeToTag(
      addClassToTag(tag, "lesson-card-derived-title"),
      "aria-hidden",
      "true",
    ),
  );

const findLesson = (
  snapshot: LessonSnapshot,
  lessonId: string,
): RenderedLesson | undefined =>
  snapshot.lessons.find((lesson) => lesson.id === lessonId);

const removedLessonHtml = (lessonId: string): string =>
  `<p class="lesson-removed">Section removed. ${escapeHtml(
    lessonId,
  )} is no longer available.</p>`;

const renderTranscriptEntry = (
  entry: TranscriptEntry,
  glossary: readonly GlossaryEntry[],
  demoFiles: ReadonlySet<string>,
  lessons: LessonSnapshot,
): RenderedTranscriptEntry => {
  if (entry.kind === "demo") {
    return {
      ...entry,
      html: renderDemoEmbed(entry.file, entry.title, { demoFiles }),
    };
  }

  if (entry.kind === undefined || entry.kind === "text") {
    return {
      ...entry,
      html: renderMarkdown(entry.text, { glossary, demoFiles }),
    };
  }

  if (entry.kind === "lesson") {
    const lesson = findLesson(lessons, entry.lesson);
    return lesson === undefined
      ? {
          ...entry,
          html: removedLessonHtml(entry.lesson),
          title: entry.lesson,
          lessonMissing: true,
        }
      : {
          ...entry,
          html: lesson.html,
          title: titleFromLessonHtml(lesson.html, lesson.id),
          lessonMissing: false,
        };
  }

  if (entry.kind === "feynman-check") {
    return {
      ...entry,
      html: renderMarkdown(entry.prompt, { glossary, demoFiles }),
    };
  }

  return {
    ...entry,
    html: renderMarkdown(entry.text, { glossary, demoFiles }),
  };
};

const renderTranscript = (
  transcript: readonly TranscriptEntry[],
  glossary: readonly GlossaryEntry[],
  demoFiles: ReadonlySet<string>,
  lessons: LessonSnapshot,
): readonly RenderedTranscriptEntry[] =>
  transcript.map((entry) =>
    renderTranscriptEntry(entry, glossary, demoFiles, lessons),
  );

const renderLessonCardEntry = (
  entry: RenderedTranscriptEntry,
  expanded: boolean,
): string => {
  if (entry.kind !== "lesson") {
    return "";
  }

  const collapsedClass = expanded ? " expanded" : " collapsed";
  const removedClass = entry.lessonMissing ? " removed" : "";
  const hidden = expanded ? "" : " hidden";
  const expandedAttr = expanded ? "true" : "false";
  const kicker = entry.lessonMissing
    ? "Lesson section removed"
    : "Lesson section";
  const bodyHtml = entry.lessonMissing
    ? entry.html
    : suppressDerivedLessonHeading(entry.html);

  return `<article class="entry lesson-card${collapsedClass}${removedClass}" data-lesson-id="${escapeHtml(
    entry.lesson,
  )}"><button class="lesson-card-header" type="button" data-lesson-toggle="${escapeHtml(
    entry.lesson,
  )}" aria-expanded="${expandedAttr}"><span class="lesson-card-header-text"><span class="lesson-card-kicker">${kicker}</span><span class="lesson-card-title">${escapeHtml(
    entry.title ?? entry.lesson,
  )}</span></span><span class="lesson-card-chevron" aria-hidden="true">⌄</span></button><div class="lesson-card-body"${hidden}><div class="lesson-content prose">${bodyHtml}</div></div></article>`;
};

const renderFeynmanCheckEntry = (entry: RenderedTranscriptEntry): string => {
  if (entry.kind !== "feynman-check") {
    return "";
  }

  return `<article class="entry feynman-check-entry"><div class="feynman-marker"><div class="feynman-marker-heading"><div class="feynman-kicker">Feynman check</div><span class="concept-chip">${escapeHtml(
    entry.concept,
  )}</span></div><div class="feynman-marker-prompt prose">${entry.html}</div></div></article>`;
};

const renderMessageEntry = (entry: RenderedTranscriptEntry): string => {
  const kind = entry.kind ?? "text";
  const kindClass =
    kind === "feynman-answer"
      ? "feynman-answer-entry"
      : kind === "demo"
        ? "demo"
        : "text";
  const meta =
    kind === "feynman-answer"
      ? "You · Check answer"
      : entry.role === "agent"
        ? "Agent"
        : "You";
  const bodyClass = `message-body prose${
    kind === "demo" ? " demo-message-body" : ""
  }${kind === "feynman-answer" ? " check-answer-body" : ""}`;

  return `<article class="entry ${entry.role} ${kindClass}"><div class="entry-meta">${meta}</div><div class="${bodyClass}">${entry.html}</div></article>`;
};

const renderTranscriptHtml = (
  entries: readonly RenderedTranscriptEntry[],
): string => {
  const latestLessonIndex = entries.reduce(
    (latest, entry, index) => (entry.kind === "lesson" ? index : latest),
    -1,
  );

  return entries
    .map((entry, index) => {
      if (entry.kind === "lesson") {
        return renderLessonCardEntry(entry, index === latestLessonIndex);
      }

      if (entry.kind === "feynman-check") {
        return renderFeynmanCheckEntry(entry);
      }

      return renderMessageEntry(entry);
    })
    .join("");
};

const walkTopicTree = (
  topics: readonly TopicNode[],
  visit: (topic: TopicNode) => void,
): void => {
  for (const topic of topics) {
    visit(topic);
    walkTopicTree(topic.children, visit);
  }
};

const currentTopic = (topics: readonly TopicNode[]): TopicNode | undefined => {
  let current: TopicNode | undefined;
  walkTopicTree(topics, (topic) => {
    if (topic.current) {
      current = topic;
    }
  });

  return current;
};

const topicLessonIds = (topics: readonly TopicNode[]): ReadonlySet<string> => {
  const ids = new Set<string>();
  walkTopicTree(topics, (topic) => {
    if (topic.lesson !== undefined) {
      ids.add(topic.lesson);
    }
  });

  return ids;
};

const topicDemoHtml = (demos: readonly DemoEntry[] | undefined): string => {
  if (demos === undefined || demos.length === 0) {
    return "";
  }

  return `<ul class="topic-tree topic-children demo-leaves">${demos
    .map(
      (demo) =>
        `<li class="topic-node demo-node"><button class="demo-leaf" type="button" data-demo-file="${escapeHtml(
          demo.file,
        )}"><span class="demo-badge">demo</span><span>${escapeHtml(
          demo.title ?? demo.file,
        )}</span></button></li>`,
    )
    .join("")}</ul>`;
};

const masteryLevel = (entry: MasteryEntry | undefined): string => {
  if (entry === undefined) {
    return "ungraded";
  }

  if (entry.score < 50) {
    return "low";
  }

  return entry.score < 80 ? "medium" : "high";
};

const masteryTitle = (topic: TopicNode, entry: MasteryEntry | undefined): string =>
  entry === undefined
    ? `${topic.title} - ungraded`
    : `${topic.title} - mastery ${entry.score}/100 (${entry.concept})`;

const masteryChipHtml = (entry: MasteryEntry | undefined): string =>
  entry === undefined
    ? '<span class="mastery-chip" aria-label="not graded yet">—</span>'
    : `<span class="mastery-chip" aria-label="mastery score ${entry.score} out of 100">${entry.score}</span>`;

const masteryButtonContent = (
  topic: TopicNode,
  scores: readonly MasteryEntry[],
): string => {
  const entry = latestMasteryForTopic(topic, scores);

  return `<span class="mastery-dot" aria-hidden="true"></span><span class="topic-label">${escapeHtml(
    topic.title,
  )}</span>${masteryChipHtml(entry)}`;
};

type TopicMasteryRecord = Readonly<{
  topic: TopicNode;
  entry: MasteryEntry;
}>;

const topicCount = (topics: readonly TopicNode[]): number =>
  topics.reduce(
    (count, topic) => count + 1 + topicCount(topic.children),
    0,
  );

const topicMasteryRecords = (
  topics: readonly TopicNode[],
  scores: readonly MasteryEntry[],
): readonly TopicMasteryRecord[] =>
  topics.flatMap((topic) => {
    const entry = latestMasteryForTopic(topic, scores);
    return [
      ...(entry === undefined ? [] : [{ topic, entry }]),
      ...topicMasteryRecords(topic.children, scores),
    ];
  });

const masteryTimeMs = (entry: MasteryEntry): number => {
  const parsed = Date.parse(entry.at);
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
};

const compareWeakestRecord = (
  left: TopicMasteryRecord,
  right: TopicMasteryRecord,
): number => {
  const scoreDelta = left.entry.score - right.entry.score;
  if (scoreDelta !== 0) {
    return scoreDelta;
  }

  const timeDelta = masteryTimeMs(left.entry) - masteryTimeMs(right.entry);
  if (timeDelta !== 0) {
    return timeDelta;
  }

  return left.entry.concept.localeCompare(right.entry.concept);
};

const renderMasterySummary = (
  topics: readonly TopicNode[],
  scores: readonly MasteryEntry[],
): string => {
  const total = topicCount(topics);
  const records = topicMasteryRecords(topics, scores);
  const weakest = [...records].sort(compareWeakestRecord)[0];
  const disabled = records.length === 0 ? " disabled" : "";
  const weakestText =
    weakest === undefined
      ? "Weakest: none"
      : `Weakest: ${weakest.entry.concept} (${weakest.entry.score})`;

  return `<div class="mastery-summary-line"><span class="mastery-count">${records.length}/${total} graded</span><span class="mastery-weakest">${escapeHtml(
    weakestText,
  )}</span></div><button class="mastery-review" type="button"${disabled}>Review weak areas</button>`;
};

const selectedLesson = (
  snapshot: LessonSnapshot,
  topics: readonly TopicNode[],
): RenderedLesson | undefined => {
  const currentLessonId = currentTopic(topics)?.lesson;
  const selectedCurrent =
    currentLessonId === undefined
      ? undefined
      : snapshot.lessons.find((lesson) => lesson.id === currentLessonId);
  const selectedById =
    snapshot.selectedLessonId === undefined
      ? undefined
      : snapshot.lessons.find((lesson) => lesson.id === snapshot.selectedLessonId);

  return selectedCurrent ?? selectedById ?? snapshot.lessons[0];
};

const renderTopicTree = (
  topics: readonly TopicNode[],
  selected: RenderedLesson | undefined,
  masteryScores: readonly MasteryEntry[],
  nested = false,
): string => {
  if (topics.length === 0) {
    return '<p class="empty-state">No topics yet.</p>';
  }

  const className = nested ? "topic-tree topic-children" : "topic-tree";

  return `<ul class="${className}">${topics
    .map((topic) => {
      const activeClass = topic.lesson === selected?.id ? " active" : "";
      const currentClass = topic.current ? " current" : "";
      const noLessonClass = topic.lesson === undefined ? " no-lesson" : "";
      const masteryEntry = latestMasteryForTopic(topic, masteryScores);
      const masteryClass = ` mastery-${masteryLevel(masteryEntry)}`;
      const title = masteryTitle(topic, masteryEntry);
      const ariaCurrent = topic.current ? ' aria-current="page"' : "";
      const children =
        topic.children.length === 0
          ? ""
          : renderTopicTree(topic.children, selected, masteryScores, true);
      const demos = topicDemoHtml(topic.demos);

      return `<li class="topic-node"><button class="topic-button${activeClass}${currentClass}${noLessonClass}${masteryClass}" type="button" data-topic-path="${escapeHtml(
        topic.path,
      )}" title="${escapeHtml(title)}"${ariaCurrent}>${masteryButtonContent(
        topic,
        masteryScores,
      )}</button>${demos}${children}</li>`;
    })
    .join("")}</ul>`;
};

const renderUnassignedLessons = (
  snapshot: LessonSnapshot,
  topics: readonly TopicNode[],
  selected: RenderedLesson | undefined,
): string => {
  const assignedLessonIds = topicLessonIds(topics);
  const unassignedLessons = snapshot.lessons.filter(
    (lesson) => !assignedLessonIds.has(lesson.id),
  );

  if (unassignedLessons.length === 0) {
    return "";
  }

  return `<section class="unassigned-lessons"><h3 class="unassigned-heading">Unassigned lessons</h3>${unassignedLessons
    .map((lesson) => {
      const activeClass = lesson.id === selected?.id ? " active" : "";
      return `<button class="lesson-tab${activeClass}" type="button" data-lesson-id="${escapeHtml(
        lesson.id,
      )}">${escapeHtml(lesson.id)}</button>`;
    })
    .join("")}</section>`;
};

const renderUnassignedDemos = (demos: readonly DemoEntry[]): string => {
  if (demos.length === 0) {
    return "";
  }

  return `<section class="unassigned-lessons"><h3 class="unassigned-heading">Unassigned demos</h3>${demos
    .map(
      (demo) =>
        `<button class="demo-leaf" type="button" data-demo-file="${escapeHtml(
          demo.file,
        )}"><span class="demo-badge">demo</span><span>${escapeHtml(
          demo.title ?? demo.file,
        )}</span></button>`,
    )
    .join("")}</section>`;
};

const renderNavigation = (
  snapshot: LessonSnapshot,
  topics: readonly TopicNode[],
  unassignedDemos: readonly DemoEntry[],
  masteryScores: readonly MasteryEntry[],
): string => {
  const selected = selectedLesson(snapshot, topics);
  return `${renderTopicTree(topics, selected, masteryScores)}${renderUnassignedLessons(
    snapshot,
    topics,
    selected,
  )}${renderUnassignedDemos(unassignedDemos)}`;
};

const renderRailLessonDocument = (snapshot: LessonSnapshot): string => {
  if (snapshot.lessons.length === 0) {
    return '<p class="empty-state">No lessons yet.</p>';
  }

  return [...snapshot.lessons]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map(
      (lesson) =>
        `<section id="rail-lesson-${escapeHtml(
          lesson.id,
        )}" class="rail-lesson-section" data-lesson-id="${escapeHtml(
          lesson.id,
        )}"><div class="lesson-content rail-lesson-content prose">${lesson.html}</div></section>`,
    )
    .join("");
};

const renderGlossaryList = (glossary: readonly GlossaryEntry[]): string => {
  const entries = [...glossary].sort((left, right) =>
    left.term.localeCompare(right.term),
  );

  if (entries.length === 0) {
    return '<p class="empty-state">No glossary terms yet.</p>';
  }

  return entries
    .map((entry) => {
      const lessonLink =
        entry.lesson === undefined
          ? ""
          : `<button class="glossary-lesson-link" type="button">first taught in ${escapeHtml(
              entry.lesson,
            )}</button>`;

      return `<article class="glossary-entry" data-term-key="${escapeHtml(
        entry.term.toLocaleLowerCase(),
      )}"><h3>${escapeHtml(entry.term)}</h3><p>${escapeHtml(
        entry.def,
      )}</p>${lessonLink}</article>`;
    })
    .join("");
};

const renderStatusText = (
  status: UiRenderStatus,
  hasSeenWait: boolean,
): string => {
  if (status === "waiting-for-agent") {
    return "Your turn — the agent is waiting";
  }

  return hasSeenWait
    ? "Agent is working…"
    : "Waiting for the agent to start teaching";
};

const composerLabel = (status: UiRenderStatus): string =>
  status === "waiting-for-agent"
    ? "Message the agent…"
    : "The agent is teaching — you can reply when it pauses";

export const renderPage = (
  courseTitle: string,
  transcript: readonly TranscriptEntry[],
  lessons: LessonSnapshot,
  glossary: readonly GlossaryEntry[],
  topics: readonly TopicNode[],
  unassignedDemos: readonly DemoEntry[],
  masteryScores: readonly MasteryEntry[],
  demoFiles: ReadonlySet<string>,
  activeFeynmanCheck: ActiveFeynmanCheck | undefined,
  status: UiRenderStatus = "agent-working",
  hasSeenWait = false,
): string => {
  const working = status !== "waiting-for-agent";
  const statusLineClass = working ? "status-line working" : "status-line";
  const typingHidden = working ? "" : " hidden";
  const composerDisabled = status === "waiting-for-agent" ? "" : " disabled";
  const composerPlaceholder = composerLabel(status);
  const renderedTranscript = renderTranscript(
    transcript,
    glossary,
    demoFiles,
    lessons,
  );
  const script = clientScript
    .replace(
      "__TRANSCRIPT__",
      escapeScriptJson(renderedTranscript),
    )
    .replace("__LESSONS__", escapeScriptJson(lessons))
    .replace("__GLOSSARY__", escapeScriptJson(glossary))
    .replace("__TOPICS__", escapeScriptJson(topics))
    .replace("__UNASSIGNED_DEMOS__", escapeScriptJson(unassignedDemos))
    .replace("__MASTERY__", escapeScriptJson(masteryScores))
    .replace(
      "__ACTIVE_FEYNMAN__",
      escapeScriptJson(activeFeynmanCheck ?? null),
    )
    .replace("__STATUS__", escapeScriptJson(status))
    .replace("__HAS_SEEN_WAIT__", escapeScriptJson(hasSeenWait));

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(courseTitle)} - overlearn</title>
  <script>
    (() => {
      let theme;
      try {
        theme = localStorage.getItem("overlearn-theme");
      } catch {
        theme = undefined;
      }
      if (theme !== "light" && theme !== "dark") {
        theme = matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
      }
      document.documentElement.dataset.theme = theme;
    })();
  </script>
  <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Ccircle cx='32' cy='32' r='28' fill='%238fbf73'/%3E%3Cpath d='M22 43V21h6v8h8v-8h6v22h-6v-9h-8v9z' fill='%2311110f'/%3E%3C/svg%3E">
  <style>
    :root {
      color-scheme: dark;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;

      --bg: #11110f;
      --surface: #151612;
      --card: #1a1b18;
      --code-bg: #0a0b0a;
      --inline-code-bg: #10110f;
      --blockquote-bg: rgb(255 255 255 / 2%);

      --border: #2f302b;
      --border-surface: #33342f;
      --border-strong: #3a3b35;

      --text: #f4f4f1;
      --heading: #fafaf8;
      --body-text: #eeeeea;
      --secondary: #cfcfca;
      --muted: #a1a19a;
      --faint: #898b83;
      --disabled: #7e8078;

      --accent: #8fbf73;
      --accent-strong: #9fcf86;
      --on-accent: #11110f;
      --accent-soft-text: #b9c7a7;
      --accent-hover-bg: #20261e;
      --accent-active-bg: #253020;
      --accent-border: #44523c;
      --accent-border-strong: #71965f;
      --accent-button-text: #edf7e8;

      --ok: #73b66d;
      --ok-text: #c8f3bf;
      --warn: #d0a548;
      --warn-text: #ffe0a0;
      --bad: #d96257;
      --bad-text: #ffc4bd;

      --term-text: #d9f6b3;
      --term-underline: #b7dd88;
      --term-card-border: #4d6041;
      --term-card-bg: #20231d;

      --demo-text: #c8d7bd;
      --demo-badge-border: #526747;
      --demo-badge-text: #bce5a4;
      --demo-card-border: #3a4933;
      --demo-card-bg: #121410;
      --demo-titlebar-bg: #1a1f17;
      --demo-titlebar-border: #2c3528;
      --demo-action-border: #42513b;
      --demo-action-hover-bg: #293422;
      --demo-warning-border: #7d5631;
      --demo-warning-bg: #21170f;
      --demo-warning-titlebar-bg: #2a1b10;
      --demo-warning-titlebar-border: #6b4828;
      --demo-warning-text: #ffd8b0;

      --feynman-border: #b88745;
      --feynman-bg: #211b12;
      --feynman-kicker: #ffd79a;
      --feynman-prompt: #fff3df;
      --feynman-replacement: #f0c589;
      --feynman-chip-border: #9e743d;
      --feynman-chip-text: #ffe1ae;
      --feynman-answer-border: #75552d;
      --feynman-answer-bg: #17130e;
      --feynman-submit-bg: #f1b45b;
      --feynman-submit-text: #15100a;
      --feynman-done-border: #526747;
      --feynman-done-bg: #182017;

      --scrollbar: #3a3b35;
      --pop-shadow: 0 1rem 2.5rem rgb(0 0 0 / 45%);

      background: var(--bg);
      color: var(--text);
    }

    :root[data-theme="light"] {
      color-scheme: light;

      --bg: #f4f3ee;
      --surface: #fbfaf7;
      --card: #ffffff;
      --code-bg: #edebe2;
      --inline-code-bg: #ebe9df;
      --blockquote-bg: rgb(93 122 62 / 5%);

      --border: #dfddd2;
      --border-surface: #e2e0d6;
      --border-strong: #ccc9bc;

      --text: #23241e;
      --heading: #15160f;
      --body-text: #2c2d26;
      --secondary: #55564c;
      --muted: #6e6f63;
      --faint: #8b8c80;
      --disabled: #9b9c90;

      --accent: #5c8f3e;
      --accent-strong: #4c7a33;
      --on-accent: #ffffff;
      --accent-soft-text: #5b7345;
      --accent-hover-bg: #edf1e4;
      --accent-active-bg: #e1ead2;
      --accent-border: #c3d2ae;
      --accent-border-strong: #8fae76;
      --accent-button-text: #33531f;

      --ok: #4c8f45;
      --ok-text: #38702f;
      --warn: #c08c1c;
      --warn-text: #8a6412;
      --bad: #c74a3e;
      --bad-text: #a53a2f;

      --term-text: #47762a;
      --term-underline: #85ac60;
      --term-card-border: #c3d2ae;
      --term-card-bg: #ffffff;

      --demo-text: #566349;
      --demo-badge-border: #a9c295;
      --demo-badge-text: #4c7a33;
      --demo-card-border: #ccd6bf;
      --demo-card-bg: #ffffff;
      --demo-titlebar-bg: #eef1e6;
      --demo-titlebar-border: #dde3cf;
      --demo-action-border: #b9c9a6;
      --demo-action-hover-bg: #e1ead2;
      --demo-warning-border: #d9a856;
      --demo-warning-bg: #fdf4e1;
      --demo-warning-titlebar-bg: #f6e8c7;
      --demo-warning-titlebar-border: #e4ca92;
      --demo-warning-text: #7a5a1e;

      --feynman-border: #d9ab5c;
      --feynman-bg: #fdf6e7;
      --feynman-kicker: #9c6d17;
      --feynman-prompt: #4a3d26;
      --feynman-replacement: #8a6a33;
      --feynman-chip-border: #cfa261;
      --feynman-chip-text: #855c14;
      --feynman-answer-border: #dcc191;
      --feynman-answer-bg: #fffdf6;
      --feynman-submit-bg: #f1b45b;
      --feynman-submit-text: #15100a;
      --feynman-done-border: #b6cba4;
      --feynman-done-bg: #eff4e6;

      --scrollbar: #c9c7ba;
      --pop-shadow: 0 0.75rem 2rem rgb(40 42 30 / 18%);
    }

    * {
      box-sizing: border-box;
    }

    [hidden] {
      display: none !important;
    }

    button:focus-visible,
    a:focus-visible,
    .term:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 2px;
    }

    textarea:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 0;
    }

    html {
      height: 100%;
    }

    body {
      margin: 0;
      height: 100dvh;
      overflow: hidden;
      background: var(--bg);
    }

    .lesson-nav,
    .lesson-content,
    .rail-panel,
    .rail-body,
    #transcript,
    textarea,
    .prose pre,
    .table-wrap {
      scrollbar-width: thin;
      scrollbar-color: var(--scrollbar) transparent;
    }

    .shell {
      display: grid;
      grid-template-rows: auto minmax(0, 1fr);
      gap: 1rem;
      height: 100%;
      width: min(100%, 92rem);
      margin: 0 auto;
      padding: 1rem;
    }

    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 1rem;
      border-bottom: 1px solid var(--border);
      padding-bottom: 0.875rem;
    }

    .header-controls {
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }

    .theme-toggle {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex: 0 0 auto;
      width: 2.6rem;
      min-height: 2.6rem;
      border: 1px solid var(--border-surface);
      border-radius: 8px;
      background: var(--surface);
      color: var(--secondary);
      padding: 0;
      cursor: pointer;
    }

    .theme-toggle:hover {
      border-color: var(--accent-border);
      background: var(--accent-hover-bg);
      color: var(--text);
    }

    .theme-toggle svg {
      width: 1.1rem;
      height: 1.1rem;
    }

    :root[data-theme="light"] .icon-sun {
      display: none;
    }

    :root:not([data-theme="light"]) .icon-moon {
      display: none;
    }

    h1,
    h2 {
      margin: 0;
      color: var(--heading);
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
      grid-template-columns: minmax(11rem, 14rem) minmax(0, 1fr) auto;
      gap: 1rem;
      min-height: 0;
    }

    .lesson-nav {
      min-height: 0;
      overflow-y: auto;
      border-right: 1px solid var(--border);
      padding-right: 1rem;
    }

    .lesson-list {
      display: grid;
      gap: 0.4rem;
      margin-top: 0.75rem;
    }

    .mastery-summary {
      display: grid;
      gap: 0.55rem;
      margin-top: 0.75rem;
      border: 1px solid var(--border-surface);
      border-radius: 8px;
      background: var(--surface);
      padding: 0.65rem;
    }

    .mastery-summary-line {
      display: grid;
      gap: 0.25rem;
      min-width: 0;
    }

    .mastery-count {
      color: var(--heading);
      font-size: 0.9rem;
      font-weight: 600;
    }

    .mastery-weakest {
      color: var(--muted);
      font-size: 0.82rem;
      overflow-wrap: anywhere;
    }

    .mastery-review {
      min-height: 2rem;
      border: 1px solid var(--accent-border);
      border-radius: 6px;
      background: var(--accent-hover-bg);
      color: var(--accent-button-text);
      padding: 0 0.65rem;
      font: inherit;
      font-size: 0.86rem;
      font-weight: 600;
      cursor: pointer;
    }

    .mastery-review:hover {
      border-color: var(--accent-border-strong);
      background: var(--accent-active-bg);
    }

    .mastery-review:disabled {
      color: var(--disabled);
      border-color: var(--border-surface);
      background: var(--surface);
      cursor: not-allowed;
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
      border-left: 1px solid var(--border);
    }

    .topic-node {
      display: grid;
      gap: 0.3rem;
      min-width: 0;
    }

    .topic-button {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr) auto;
      align-items: center;
      gap: 0.45rem;
      width: 100%;
      min-height: 2.25rem;
      border: 1px solid transparent;
      border-left-width: 3px;
      border-radius: 8px;
      background: transparent;
      color: var(--secondary);
      padding: 0.45rem 0.6rem;
      font: inherit;
      text-align: left;
      overflow-wrap: anywhere;
      cursor: pointer;
    }

    .topic-label {
      min-width: 0;
      overflow-wrap: anywhere;
    }

    .mastery-dot {
      width: 0.68rem;
      height: 0.68rem;
      border: 1px solid var(--faint);
      border-radius: 999px;
      background: transparent;
    }

    .mastery-chip {
      min-width: 2.15rem;
      border: 1px solid var(--border-strong);
      border-radius: 999px;
      color: var(--secondary);
      padding: 0.08rem 0.34rem;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
      font-size: 0.8125rem;
      font-weight: 700;
      font-variant-numeric: tabular-nums;
      line-height: 1.4;
      text-align: center;
    }

    .topic-button.mastery-low {
      border-left-color: var(--bad);
    }

    .topic-button.mastery-low .mastery-dot,
    .topic-button.mastery-low .mastery-chip {
      border-color: var(--bad);
      color: var(--bad-text);
    }

    .topic-button.mastery-low .mastery-dot {
      background: var(--bad);
    }

    .topic-button.mastery-medium {
      border-left-color: var(--warn);
    }

    .topic-button.mastery-medium .mastery-dot,
    .topic-button.mastery-medium .mastery-chip {
      border-color: var(--warn);
      color: var(--warn-text);
    }

    .topic-button.mastery-medium .mastery-dot {
      background: var(--warn);
    }

    .topic-button.mastery-high {
      border-left-color: var(--ok);
    }

    .topic-button.mastery-high .mastery-dot,
    .topic-button.mastery-high .mastery-chip {
      border-color: var(--ok);
      color: var(--ok-text);
    }

    .topic-button.mastery-high .mastery-dot {
      background: var(--ok);
    }

    .topic-button.mastery-ungraded {
      border-left-color: var(--border-strong);
    }

    .topic-button.mastery-ungraded .mastery-chip {
      color: var(--faint);
    }

    .topic-button.no-lesson {
      color: var(--muted);
    }

    .topic-button:hover,
    .topic-button.active {
      border-color: var(--accent-border);
      background: var(--accent-hover-bg);
      color: var(--text);
    }

    .topic-button.current {
      border-color: var(--accent);
      color: var(--text);
    }

    .topic-button.mastery-low:hover,
    .topic-button.mastery-low.active,
    .topic-button.mastery-low.current {
      border-left-color: var(--bad);
    }

    .topic-button.mastery-medium:hover,
    .topic-button.mastery-medium.active,
    .topic-button.mastery-medium.current {
      border-left-color: var(--warn);
    }

    .topic-button.mastery-high:hover,
    .topic-button.mastery-high.active,
    .topic-button.mastery-high.current {
      border-left-color: var(--ok);
    }

    .topic-button.mastery-ungraded:hover,
    .topic-button.mastery-ungraded.active,
    .topic-button.mastery-ungraded.current {
      border-left-color: var(--border-strong);
    }

    .demo-leaves {
      gap: 0.25rem;
    }

    .demo-node {
      gap: 0;
    }

    .demo-leaf {
      display: flex;
      align-items: center;
      gap: 0.45rem;
      width: 100%;
      min-height: 2rem;
      border: 1px solid transparent;
      border-radius: 8px;
      background: transparent;
      color: var(--demo-text);
      padding: 0.35rem 0.55rem;
      font: inherit;
      font-size: 0.92rem;
      text-align: left;
      overflow-wrap: anywhere;
      cursor: pointer;
    }

    .demo-leaf:hover {
      border-color: var(--accent-border);
      background: var(--accent-hover-bg);
      color: var(--text);
    }

    .demo-badge {
      flex: 0 0 auto;
      border: 1px solid var(--demo-badge-border);
      border-radius: 999px;
      color: var(--demo-badge-text);
      padding: 0.04rem 0.3rem;
      font-size: 0.68rem;
      font-weight: 700;
      line-height: 1.35;
      text-transform: uppercase;
    }

    .unassigned-lessons {
      display: grid;
      gap: 0.4rem;
      margin-top: 0.85rem;
      border-top: 1px solid var(--border);
      padding-top: 0.75rem;
    }

    .unassigned-heading {
      margin: 0 0 0.1rem;
      color: var(--muted);
      font-size: 0.78rem;
      font-weight: 600;
      letter-spacing: 0;
      text-transform: uppercase;
    }

    .lesson-tab {
      width: 100%;
      min-height: 2.25rem;
      border: 1px solid transparent;
      border-radius: 8px;
      background: transparent;
      color: var(--secondary);
      padding: 0.45rem 0.6rem;
      font: inherit;
      text-align: left;
      overflow-wrap: anywhere;
      cursor: pointer;
    }

    .lesson-tab:hover,
    .lesson-tab.active {
      border-color: var(--accent-border);
      background: var(--accent-hover-bg);
      color: var(--text);
    }

    .lesson-content.prose {
      width: min(100%, 70ch);
      max-width: 70ch;
    }

    .rail-lesson-document {
      display: grid;
      gap: 1.25rem;
    }

    .rail-lesson-section {
      display: grid;
      gap: 0.65rem;
      border-bottom: 1px solid var(--border);
      padding-bottom: 1.1rem;
    }

    .rail-lesson-section:last-child {
      border-bottom: 0;
      padding-bottom: 0;
    }

    .rail-lesson-content.lesson-content.prose {
      width: 100%;
      max-width: none;
    }

    .rail-panel {
      min-height: 0;
      overflow-y: auto;
      padding-right: 0.15rem;
    }

    .glossary-list {
      display: grid;
      gap: 0.75rem;
      margin-top: 1rem;
    }

    .glossary-entry {
      display: grid;
      gap: 0.45rem;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--card);
      padding: 0.85rem 0.95rem;
    }

    .glossary-entry.highlight {
      border-color: var(--accent-border-strong);
      background: var(--accent-hover-bg);
    }

    .glossary-entry h3 {
      margin: 0;
      color: var(--heading);
      font-size: 1rem;
      font-weight: 600;
    }

    .glossary-entry p {
      margin: 0;
      color: var(--body-text);
      line-height: 1.55;
    }

    .glossary-lesson-link,
    .term-card-link {
      justify-self: start;
      border: 0;
      background: transparent;
      color: var(--accent-strong);
      padding: 0;
      font: inherit;
      font-size: 0.9rem;
      text-decoration: underline;
      text-underline-offset: 0.2em;
      cursor: pointer;
    }

    .empty-state,
    .empty-lesson {
      margin: 0;
      color: var(--muted);
      font-size: 0.95rem;
      line-height: 1.5;
    }

    .stream-pane {
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
      min-width: 0;
      min-height: 0;
    }

    .stream-pane > * {
      flex: 0 0 auto;
    }

    .stream-header,
    .stream-dock {
      width: min(100%, 54rem);
      margin: 0 auto;
    }

    .stream-header {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 0.75rem;
      min-width: 0;
    }

    .stream-dock {
      display: grid;
      gap: 0.75rem;
      border-top: 1px solid var(--border);
      background: var(--bg);
      padding-top: 0.75rem;
    }

    .study-rail {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr);
      gap: 0.75rem;
      width: 22rem;
      min-height: 0;
      border-left: 1px solid var(--border);
      padding-left: 1rem;
    }

    .study-rail.collapsed {
      grid-template-columns: auto;
      width: 3rem;
      padding-left: 0;
    }

    .rail-toggle {
      align-self: start;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 2.75rem;
      min-height: 2.75rem;
      border: 1px solid var(--border-surface);
      border-radius: 8px;
      background: var(--surface);
      color: var(--secondary);
      padding: 0;
      cursor: pointer;
    }

    .rail-toggle:hover {
      border-color: var(--accent-border);
      background: var(--accent-hover-bg);
      color: var(--text);
    }

    .rail-toggle svg {
      width: 1.1rem;
      height: 1.1rem;
    }

    .study-rail.open .rail-toggle svg {
      transform: rotate(180deg);
    }

    .rail-body {
      display: grid;
      grid-template-rows: auto minmax(0, 1fr);
      gap: 0.85rem;
      min-width: 0;
      min-height: 0;
      border: 1px solid var(--border-surface);
      border-radius: 8px;
      background: var(--surface);
      padding: 0.85rem;
    }

    .rail-tabs {
      display: flex;
      gap: 0.35rem;
      border: 1px solid var(--border-surface);
      border-radius: 8px;
      background: var(--card);
      padding: 0.25rem;
    }

    .rail-tab {
      flex: 1;
      min-height: 2rem;
      border: 0;
      border-radius: 6px;
      background: transparent;
      color: var(--secondary);
      padding: 0 0.65rem;
      font: inherit;
      cursor: pointer;
    }

    .rail-tab:hover,
    .rail-tab.active {
      background: var(--accent-active-bg);
      color: var(--text);
    }

    .status-line {
      display: flex;
      align-items: center;
      gap: 0.45rem;
      margin: 0;
      min-width: 0;
      color: var(--accent-soft-text);
      font-size: 0.9rem;
      white-space: nowrap;
    }

    #status {
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .status-dot {
      flex: 0 0 auto;
      width: 0.55rem;
      height: 0.55rem;
      border-radius: 999px;
      background: var(--accent);
    }

    .status-line.working {
      color: var(--muted);
    }

    .status-line.working .status-dot {
      background: var(--warn);
      animation: status-pulse 1.6s ease-in-out infinite;
    }

    @keyframes status-pulse {
      0% {
        box-shadow: 0 0 0 0 color-mix(in srgb, var(--warn) 45%, transparent);
      }

      70% {
        box-shadow: 0 0 0 0.45rem transparent;
      }

      100% {
        box-shadow: 0 0 0 0 transparent;
      }
    }

    #transcript {
      flex: 1 1 0;
      width: min(100%, 54rem);
      min-height: 0;
      margin: 0 auto;
      overflow-y: auto;
      padding: 0.25rem 0.125rem 0.75rem;
    }

    #transcript:empty::before {
      content: "Messages from your teacher will appear here.";
      display: block;
      margin-top: 0.25rem;
      color: var(--muted);
      font-size: 0.95rem;
    }

    .typing {
      display: flex;
      align-items: center;
      gap: 0.35rem;
      width: max-content;
      border: 1px solid var(--border-surface);
      border-radius: 8px 8px 8px 2px;
      background: var(--card);
      padding: 0.6rem 0.75rem;
    }

    .typing-dot {
      width: 0.42rem;
      height: 0.42rem;
      border-radius: 999px;
      background: var(--muted);
      animation: typing-bounce 1.2s ease-in-out infinite;
    }

    .typing-dot:nth-child(2) {
      animation-delay: 0.15s;
    }

    .typing-dot:nth-child(3) {
      animation-delay: 0.3s;
    }

    @keyframes typing-bounce {
      0%, 55%, 100% {
        opacity: 0.4;
        transform: none;
      }

      25% {
        opacity: 1;
        transform: translateY(-0.2rem);
      }
    }

    @media (prefers-reduced-motion: reduce) {
      .status-line.working .status-dot,
      .typing-dot {
        animation: none;
      }
    }

    .feynman-panel {
      display: grid;
      gap: 0.75rem;
      border: 1px solid var(--feynman-border);
      border-radius: 8px;
      background: var(--feynman-bg);
      padding: 0.85rem;
    }

    .feynman-panel.submitted {
      border-color: var(--feynman-done-border);
      background: var(--feynman-done-bg);
    }

    .feynman-heading {
      display: flex;
      align-items: start;
      justify-content: space-between;
      gap: 0.75rem;
    }

    .feynman-title {
      display: grid;
      gap: 0.15rem;
      min-width: 0;
    }

    .feynman-kicker {
      color: var(--feynman-kicker);
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
      font-size: 0.8125rem;
      font-weight: 700;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }

    .feynman-title h3 {
      margin: 0;
      color: var(--heading);
      font-size: 1rem;
      font-weight: 600;
    }

    .concept-chip {
      flex: 0 0 auto;
      max-width: 12rem;
      overflow: hidden;
      border: 1px solid var(--feynman-chip-border);
      border-radius: 999px;
      color: var(--feynman-chip-text);
      padding: 0.18rem 0.5rem;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
      font-size: 0.8125rem;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .feynman-prompt,
    .feynman-status,
    .feynman-replacement {
      margin: 0;
      line-height: 1.5;
    }

    .feynman-prompt {
      color: var(--feynman-prompt);
    }

    .feynman-status {
      color: var(--feynman-kicker);
      font-size: 0.9rem;
    }

    .feynman-replacement {
      border-left: 3px solid var(--feynman-border);
      color: var(--feynman-replacement);
      padding-left: 0.6rem;
      font-size: 0.9rem;
    }

    .feynman-form {
      display: grid;
      gap: 0.65rem;
    }

    .feynman-answer {
      min-height: 8rem;
      border-color: var(--feynman-answer-border);
      background: var(--feynman-answer-bg);
    }

    .feynman-submit {
      justify-self: end;
      min-height: 2.5rem;
      border: 0;
      border-radius: 8px;
      background: var(--feynman-submit-bg);
      color: var(--feynman-submit-text);
      padding: 0 0.9rem;
      font: inherit;
      font-weight: 600;
      cursor: pointer;
    }

    .feynman-submit:disabled {
      opacity: 0.45;
      cursor: not-allowed;
    }

    .entry {
      display: grid;
      gap: 0.35rem;
      margin: 0 0 1.1rem;
    }

    .entry.learner {
      justify-items: end;
    }

    .entry-meta {
      color: var(--muted);
      font-size: 0.8rem;
    }

    .message-body {
      width: min(100%, 46rem);
      border: 1px solid var(--border-surface);
      border-radius: 8px;
      background: var(--card);
      padding: 0.75rem 0.875rem;
    }

    .learner .message-body {
      border-color: var(--accent-border);
      background: var(--accent-hover-bg);
    }

    .demo-message-body {
      width: min(100%, 52rem);
      border: 0;
      background: transparent;
      padding: 0;
    }

    .check-answer-body {
      border-color: var(--feynman-answer-border);
      background: var(--feynman-answer-bg);
    }

    .lesson-card {
      overflow: hidden;
      border: 1px solid var(--border-surface);
      border-radius: 8px;
      background: var(--surface);
    }

    .lesson-card.removed {
      border-style: dashed;
    }

    .lesson-card-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.85rem;
      width: 100%;
      border: 0;
      border-bottom: 1px solid var(--border-surface);
      background: var(--card);
      color: var(--text);
      padding: 0.85rem 1rem;
      font: inherit;
      text-align: left;
      cursor: pointer;
    }

    .lesson-card.collapsed .lesson-card-header {
      border-bottom: 0;
    }

    .lesson-card-header:hover {
      background: var(--accent-hover-bg);
    }

    .lesson-card-header-text {
      display: grid;
      gap: 0.18rem;
      min-width: 0;
    }

    .lesson-card-kicker {
      color: var(--accent-soft-text);
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
      font-size: 0.78rem;
      font-weight: 700;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }

    .lesson-card-title {
      color: var(--heading);
      font-size: 1.08rem;
      font-weight: 600;
      line-height: 1.35;
      overflow-wrap: anywhere;
    }

    .lesson-card-chevron {
      flex: 0 0 auto;
      color: var(--muted);
      font-size: 1.25rem;
      line-height: 1;
    }

    .lesson-card.expanded .lesson-card-chevron {
      transform: rotate(180deg);
    }

    .lesson-card-body {
      display: flex;
      justify-content: center;
      padding: 1.2rem;
    }

    .lesson-card-body .lesson-content {
      width: min(100%, 70ch);
    }

    .lesson-card-body .lesson-card-derived-title {
      display: none;
    }

    .lesson-removed {
      margin: 0;
      color: var(--muted);
      line-height: 1.55;
    }

    .feynman-marker {
      display: grid;
      gap: 0.65rem;
      border: 1px solid var(--feynman-border);
      border-radius: 8px;
      background: var(--feynman-bg);
      padding: 0.85rem 0.95rem;
    }

    .feynman-marker-heading {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.75rem;
      min-width: 0;
    }

    .feynman-marker-prompt {
      color: var(--feynman-prompt);
    }

    .demo-card {
      display: grid;
      overflow: hidden;
      border: 1px solid var(--demo-card-border);
      border-radius: 8px;
      background: var(--demo-card-bg);
    }

    .demo-titlebar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.75rem;
      border-bottom: 1px solid var(--demo-titlebar-border);
      background: var(--demo-titlebar-bg);
      padding: 0.55rem 0.65rem;
    }

    .demo-title {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      min-width: 0;
      color: var(--heading);
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
      border: 1px solid var(--demo-action-border);
      border-radius: 6px;
      background: var(--accent-hover-bg);
      color: var(--text);
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
      border-color: var(--accent-border-strong);
      background: var(--demo-action-hover-bg);
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
      border-color: var(--demo-warning-border);
      background: var(--demo-warning-bg);
    }

    .demo-warning .demo-titlebar {
      border-bottom-color: var(--demo-warning-titlebar-border);
      background: var(--demo-warning-titlebar-bg);
    }

    .demo-warning p {
      margin: 0;
      padding: 0.75rem;
      color: var(--demo-warning-text);
    }

    .prose {
      color: var(--body-text);
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
      color: var(--heading);
      font-weight: 600;
    }

    .lesson-content h1 {
      font-size: 1.45rem;
    }

    .lesson-content h2 {
      font-size: 1.2rem;
    }

    .lesson-content h3 {
      font-size: 1.08rem;
    }

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
      color: var(--accent-strong);
      text-decoration: underline;
      text-underline-offset: 0.2em;
    }

    .term {
      border-bottom: 1px dotted var(--term-underline);
      color: var(--term-text);
      cursor: help;
    }

    .term:focus-visible {
      border-radius: 4px;
    }

    .term-card {
      position: fixed;
      z-index: 20;
      width: max-content;
      max-width: min(22rem, calc(100vw - 1.5rem));
      border: 1px solid var(--term-card-border);
      border-radius: 8px;
      background: var(--term-card-bg);
      box-shadow: var(--pop-shadow);
      color: var(--body-text);
      padding: 0.75rem 0.85rem;
      line-height: 1.45;
    }

    .term-card-title {
      color: var(--heading);
      font-weight: 600;
    }

    .term-card p {
      margin: 0.35rem 0 0;
    }

    .term-card-link {
      margin-top: 0.5rem;
    }

    .prose code {
      border-radius: 5px;
      background: var(--inline-code-bg);
      padding: 0.1rem 0.3rem;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
      font-size: 0.9em;
    }

    .prose blockquote {
      border-left: 3px solid var(--accent);
      border-radius: 0 6px 6px 0;
      background: var(--blockquote-bg);
      color: var(--body-text);
      padding: 0.05rem 0 0.05rem 0.85rem;
    }

    .prose pre {
      overflow-x: auto;
      border-radius: 8px;
      background: var(--code-bg);
      padding: 0.75rem;
      line-height: 1.55;
    }

    .prose pre code {
      display: block;
      background: transparent;
      padding: 0;
      font-size: 0.875rem;
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
      font-size: 0.96rem;
    }

    .prose th,
    .prose td {
      border-bottom: 1px solid var(--border);
      padding: 0.45rem 0.65rem;
      text-align: left;
      vertical-align: top;
    }

    .prose th {
      color: var(--heading);
      font-weight: 600;
      white-space: nowrap;
    }

    .composer {
      display: flex;
      align-items: flex-end;
      gap: 0.5rem;
    }

    textarea {
      width: 100%;
      min-height: 6rem;
      resize: vertical;
      border: 1px solid var(--border-strong);
      border-radius: 8px;
      background: var(--card);
      color: var(--text);
      padding: 0.8rem 0.875rem;
      font: inherit;
      line-height: 1.5;
    }

    textarea:disabled {
      color: var(--disabled);
      background: var(--surface);
      cursor: not-allowed;
    }

    #message {
      flex: 1;
      min-height: 3.25rem;
      max-height: 12.5rem;
      resize: none;
    }

    .send-button {
      flex: 0 0 auto;
      min-height: 2.75rem;
      max-height: 2.75rem;
      border: 0;
      border-radius: 8px;
      background: var(--accent-strong);
      color: var(--on-accent);
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
      body {
        overflow: auto;
      }

      .shell {
        height: auto;
        min-height: 100dvh;
      }

      .workspace {
        grid-template-columns: 1fr;
      }

      .lesson-nav {
        max-height: 18rem;
        border-right: 0;
        border-bottom: 1px solid var(--border);
        padding-right: 0;
        padding-bottom: 1rem;
      }

      .stream-pane {
        min-height: 70dvh;
      }

      .study-rail {
        position: fixed;
        top: 0.75rem;
        right: 0.75rem;
        bottom: 0.75rem;
        z-index: 15;
        width: min(22rem, calc(100vw - 1.5rem));
        border-left: 0;
        padding-left: 0;
      }

      .study-rail.collapsed {
        bottom: auto;
        width: 2.75rem;
      }

      .study-rail.open {
        grid-template-columns: auto minmax(0, 1fr);
      }

      .rail-body {
        box-shadow: var(--pop-shadow);
      }

      .stream-dock {
        position: sticky;
        bottom: 0;
        z-index: 4;
        margin-bottom: -1rem;
        padding-bottom: 1rem;
      }

      #transcript {
        min-height: 20rem;
        max-height: 65dvh;
      }
    }

    @media (max-width: 640px) {
      .shell {
        padding: 0.75rem;
      }

      h1 {
        font-size: 1.25rem;
      }

      header {
        display: grid;
      }

      .header-controls {
        width: 100%;
        justify-content: end;
      }

      .stream-header {
        display: grid;
      }

      .status-line {
        white-space: normal;
      }

      .lesson-card-header {
        align-items: start;
      }

      .lesson-card-body {
        padding: 1rem;
      }

      .feynman-heading,
      .feynman-marker-heading {
        display: grid;
      }

      .concept-chip {
        max-width: 100%;
      }

      .feynman-submit {
        width: 100%;
      }

      .composer {
        display: grid;
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
      <h1>${escapeHtml(courseTitle)}</h1>
      <div class="header-controls">
        <button id="theme-toggle" class="theme-toggle" type="button" aria-label="Toggle color theme" title="Toggle color theme">
          <svg class="icon-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.93 4.93l1.41 1.41m11.32 11.32 1.41 1.41M2 12h2m16 0h2M4.93 19.07l1.41-1.41m11.32-11.32 1.41-1.41"/></svg>
          <svg class="icon-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/></svg>
        </button>
      </div>
    </header>

    <div class="workspace">
      <nav class="lesson-nav" aria-labelledby="lesson-heading">
        <h2 id="lesson-heading">Topics</h2>
        <section id="mastery-summary" class="mastery-summary" aria-label="Mastery summary">${renderMasterySummary(
          topics,
          masteryScores,
        )}</section>
        <div id="lesson-list" class="lesson-list">${renderNavigation(
          lessons,
          topics,
          unassignedDemos,
          masteryScores,
        )}</div>
      </nav>

      <section class="stream-pane" aria-label="Teaching stream">
        <div class="stream-header">
          <h2>Teaching stream</h2>
          <p id="status-line" class="${statusLineClass}"><span class="status-dot" aria-hidden="true"></span><span id="status">${escapeHtml(renderStatusText(status, hasSeenWait))}</span></p>
        </div>

        <section id="transcript" aria-live="polite">${renderTranscriptHtml(
          renderedTranscript,
        )}</section>

        <div class="stream-dock">
          <section id="feynman-panel" class="feynman-panel" aria-labelledby="feynman-heading" hidden>
            <div class="feynman-heading">
              <div class="feynman-title">
                <div class="feynman-kicker">Feynman check</div>
                <h3 id="feynman-heading">Explain it back</h3>
              </div>
              <span id="feynman-concept" class="concept-chip"></span>
            </div>
            <p id="feynman-replacement" class="feynman-replacement" hidden></p>
            <p id="feynman-prompt" class="feynman-prompt"></p>
            <form id="feynman-form" class="feynman-form">
              <textarea id="feynman-answer" class="feynman-answer" name="feynman-answer" aria-label="Feynman answer" placeholder="Explain the idea in your own words"></textarea>
              <button id="feynman-submit" class="feynman-submit" type="submit" disabled>Submit answer</button>
            </form>
            <p id="feynman-status" class="feynman-status" aria-live="polite"></p>
          </section>

          <div id="typing" class="typing" aria-hidden="true"${typingHidden}>
            <span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span>
          </div>

          <form id="turn-form" class="composer">
            <textarea id="message" name="message" aria-label="${escapeHtml(
              composerPlaceholder,
            )}" placeholder="${escapeHtml(composerPlaceholder)}"${composerDisabled}></textarea>
            <button id="submit" class="send-button" type="submit" disabled>Send</button>
          </form>
        </div>
      </section>

      <aside id="study-rail" class="study-rail collapsed" aria-label="Review rail">
        <button id="rail-toggle" class="rail-toggle" type="button" aria-label="Open review rail" aria-expanded="false" title="Toggle review rail">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>
        </button>
        <div id="rail-body" class="rail-body" hidden>
          <nav class="rail-tabs" aria-label="Review view" role="tablist">
            <button class="rail-tab active" type="button" data-rail-tab="lesson" role="tab" aria-selected="true">Lesson</button>
            <button class="rail-tab" type="button" data-rail-tab="glossary" role="tab" aria-selected="false">Glossary</button>
          </nav>
          <section id="rail-lesson-panel" class="rail-panel" data-rail-panel="lesson" aria-label="Full lesson document">
            <div id="rail-lesson-document" class="rail-lesson-document">${renderRailLessonDocument(
              lessons,
            )}</div>
          </section>
          <section id="rail-glossary-panel" class="rail-panel" data-rail-panel="glossary" aria-label="Glossary" hidden>
            <div id="glossary-list" class="glossary-list">${renderGlossaryList(
              glossary,
            )}</div>
          </section>
        </div>
      </aside>
    </div>
    <div id="term-card" class="term-card" role="tooltip" hidden></div>
  </main>

  <script>${script}</script>
</body>
</html>`;
};

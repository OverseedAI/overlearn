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
const initialGlossary = __GLOSSARY__;
const initialTopics = __TOPICS__;
const initialUnassignedDemos = __UNASSIGNED_DEMOS__;
const initialMastery = __MASTERY__;
const initialActiveFeynman = __ACTIVE_FEYNMAN__ ?? undefined;
const REVIEW_WEAK_NAV_PATH = "overlearn:review-weak";

const form = document.querySelector("#turn-form");
const textarea = document.querySelector("#message");
const submitButton = document.querySelector("#submit");
const statusLine = document.querySelector("#status");
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
const lessonContent = document.querySelector("#lesson-content");
const lessonView = document.querySelector("#lesson-view");
const glossaryView = document.querySelector("#glossary-view");
const glossaryList = document.querySelector("#glossary-list");
const termCard = document.querySelector("#term-card");
const viewTabs = [...document.querySelectorAll("[data-view]")];

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
let currentStatus = "agent-working";
let activeView = "lessons";
let currentTermElement = undefined;
let hideTermCardTimer = undefined;

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

const glossaryKey = (term) => term.toLocaleLowerCase();

const glossaryEntryForTerm = (term) =>
  glossary.find((entry) => glossaryKey(entry.term) === glossaryKey(term));

const sortedGlossary = () =>
  [...glossary].sort((left, right) => left.term.localeCompare(right.term));

const renderViewTabs = () => {
  for (const tab of viewTabs) {
    const selected = tab.dataset.view === activeView;
    tab.classList.toggle("active", selected);
    tab.setAttribute("aria-selected", selected ? "true" : "false");
  }

  lessonView.hidden = activeView !== "lessons";
  glossaryView.hidden = activeView !== "glossary";
};

const setActiveView = (view) => {
  activeView = view;
  renderViewTabs();
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

  activeView = "lessons";
  renderNavigation();
  renderViewTabs();
  await submitNav(topic.path);
};

const selectLesson = (lessonId) => {
  userPinnedLesson = true;
  selectedLessonId = lessonId;
  selectedTopicPath = findTopicForLesson(lessonId)?.path;
  userPinnedTopic = selectedTopicPath !== undefined;
  activeView = "lessons";
  renderNavigation();
  renderViewTabs();
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
    chip.textContent = masteryEntry === undefined ? "--" : String(masteryEntry.score);
    chip.setAttribute(
      "aria-label",
      masteryEntry === undefined
        ? "ungraded"
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

const renderLessonContent = () => {
  let selected = lessons.find((lesson) => lesson.id === selectedLessonId);
  if (selected === undefined) {
    selected = latestLesson() ?? lessons[0];
    selectedLessonId = selected?.id;
  }

  if (selected === undefined) {
    lessonContent.className = "lesson-content empty-lesson";
    lessonContent.textContent = "No lesson selected.";
    return;
  }

  lessonContent.className = "lesson-content prose";
  lessonContent.innerHTML = selected.html;
};

const renderNavigation = () => {
  hideTermCard();
  lessons.sort((left, right) => left.id.localeCompare(right.id));
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

  renderLessonContent();
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
    renderNavigation();
  }
};

const createEntryElement = (entry) => {
  const article = document.createElement("article");
  article.className = "entry " + entry.role + " " + (entry.kind ?? "text");

  const meta = document.createElement("div");
  meta.className = "entry-meta";
  meta.textContent = entry.role === "agent" ? "Agent" : "You";

  const body = document.createElement("div");
  body.className = "message-body prose" + (entry.kind === "demo" ? " demo-message-body" : "");
  body.innerHTML = entry.html;

  article.append(meta, body);
  return article;
};

const renderTranscript = () => {
  hideTermCard();
  transcript.replaceChildren();
  for (const entry of transcriptEntries) {
    transcript.append(createEntryElement(entry));
  }
  scrollTranscript();
};

const appendEntry = (entry) => {
  transcriptEntries.push(entry);
  transcript.append(createEntryElement(entry));
  scrollTranscript();
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

const applyStatus = (status) => {
  currentStatus = status;
  const waiting = status === "waiting-for-agent";
  statusLine.textContent = waiting ? "Waiting for your message" : "Agent is working…";
  textarea.disabled = !waiting;
  submitButton.disabled = !waiting || textarea.value.trim().length === 0;
  setFeynmanControls();

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
renderViewTabs();
renderFeynmanPanel();
renderTranscript();

textarea.addEventListener("input", () => {
  submitButton.disabled = textarea.disabled || textarea.value.trim().length === 0;
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

for (const tab of viewTabs) {
  tab.addEventListener("click", () => {
    const view = tab.dataset.view;
    if (view !== undefined) {
      setActiveView(view);
    }
  });
}

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
  applyStatus(JSON.parse(event.data).status);
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
  transcriptEntries = [...JSON.parse(event.data).entries];
  renderTranscript();
});
`;

const renderTranscript = (
  transcript: readonly TranscriptEntry[],
  glossary: readonly GlossaryEntry[],
  demoFiles: ReadonlySet<string>,
): readonly RenderedTranscriptEntry[] =>
  transcript.map((entry) => ({
    ...entry,
    html:
      entry.kind === "demo"
        ? renderDemoEmbed(entry.file, entry.title, { demoFiles })
        : renderMarkdown(entry.text, { glossary, demoFiles }),
  }));

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
    ? '<span class="mastery-chip" aria-label="ungraded">--</span>'
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

const renderLessonContent = (
  snapshot: LessonSnapshot,
  topics: readonly TopicNode[],
): string => {
  const lesson = selectedLesson(snapshot, topics);
  if (lesson === undefined) {
    return '<div id="lesson-content" class="lesson-content empty-lesson" aria-live="polite">No lesson selected.</div>';
  }

  return `<div id="lesson-content" class="lesson-content prose" aria-live="polite">${lesson.html}</div>`;
};

export const renderPage = (
  courseName: string,
  transcript: readonly TranscriptEntry[],
  lessons: LessonSnapshot,
  glossary: readonly GlossaryEntry[],
  topics: readonly TopicNode[],
  unassignedDemos: readonly DemoEntry[],
  masteryScores: readonly MasteryEntry[],
  demoFiles: ReadonlySet<string>,
  activeFeynmanCheck: ActiveFeynmanCheck | undefined,
): string => {
  const script = clientScript
    .replace(
      "__TRANSCRIPT__",
      escapeScriptJson(renderTranscript(transcript, glossary, demoFiles)),
    )
    .replace("__LESSONS__", escapeScriptJson(lessons))
    .replace("__GLOSSARY__", escapeScriptJson(glossary))
    .replace("__TOPICS__", escapeScriptJson(topics))
    .replace("__UNASSIGNED_DEMOS__", escapeScriptJson(unassignedDemos))
    .replace("__MASTERY__", escapeScriptJson(masteryScores))
    .replace(
      "__ACTIVE_FEYNMAN__",
      escapeScriptJson(activeFeynmanCheck ?? null),
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

    [hidden] {
      display: none !important;
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
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 1rem;
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

    .view-tabs {
      display: flex;
      gap: 0.35rem;
      border: 1px solid #33342f;
      border-radius: 8px;
      background: #151612;
      padding: 0.25rem;
    }

    .view-tab {
      min-height: 2rem;
      border: 0;
      border-radius: 6px;
      background: transparent;
      color: #cfcfca;
      padding: 0 0.75rem;
      font: inherit;
      cursor: pointer;
    }

    .view-tab:hover,
    .view-tab.active {
      background: #253020;
      color: #f4f4f1;
    }

    .workspace {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(20rem, 25rem);
      gap: 1rem;
      min-height: 0;
    }

    .study-pane {
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

    .mastery-summary {
      display: grid;
      gap: 0.55rem;
      margin-top: 0.75rem;
      border: 1px solid #33342f;
      border-radius: 8px;
      background: #151612;
      padding: 0.65rem;
    }

    .mastery-summary-line {
      display: grid;
      gap: 0.25rem;
      min-width: 0;
    }

    .mastery-count {
      color: #fafaf8;
      font-size: 0.9rem;
      font-weight: 600;
    }

    .mastery-weakest {
      color: #bdbdb6;
      font-size: 0.82rem;
      overflow-wrap: anywhere;
    }

    .mastery-review {
      min-height: 2rem;
      border: 1px solid #4b5a43;
      border-radius: 6px;
      background: #20261e;
      color: #edf7e8;
      padding: 0 0.65rem;
      font: inherit;
      font-size: 0.86rem;
      font-weight: 600;
      cursor: pointer;
    }

    .mastery-review:hover {
      border-color: #71965f;
      background: #273120;
    }

    .mastery-review:disabled {
      color: #7e8078;
      border-color: #33342f;
      background: #181914;
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
      border-left: 1px solid #30352d;
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
      color: #d5d5cf;
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
      border: 1px solid #686a62;
      border-radius: 999px;
      background: transparent;
    }

    .mastery-chip {
      min-width: 2.15rem;
      border: 1px solid #454741;
      border-radius: 999px;
      color: #cfcfca;
      padding: 0.08rem 0.34rem;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
      font-size: 0.72rem;
      font-weight: 700;
      line-height: 1.4;
      text-align: center;
    }

    .topic-button.mastery-low {
      border-left-color: #d96257;
    }

    .topic-button.mastery-low .mastery-dot,
    .topic-button.mastery-low .mastery-chip {
      border-color: #d96257;
      color: #ffc4bd;
    }

    .topic-button.mastery-low .mastery-dot {
      background: #d96257;
    }

    .topic-button.mastery-medium {
      border-left-color: #d0a548;
    }

    .topic-button.mastery-medium .mastery-dot,
    .topic-button.mastery-medium .mastery-chip {
      border-color: #d0a548;
      color: #ffe0a0;
    }

    .topic-button.mastery-medium .mastery-dot {
      background: #d0a548;
    }

    .topic-button.mastery-high {
      border-left-color: #73b66d;
    }

    .topic-button.mastery-high .mastery-dot,
    .topic-button.mastery-high .mastery-chip {
      border-color: #73b66d;
      color: #c8f3bf;
    }

    .topic-button.mastery-high .mastery-dot {
      background: #73b66d;
    }

    .topic-button.mastery-ungraded {
      border-left-color: #3a3b35;
    }

    .topic-button.mastery-ungraded .mastery-chip {
      color: #898b83;
    }

    .topic-button.no-lesson {
      color: #aeb0a8;
    }

    .topic-button:hover,
    .topic-button.active {
      border-color: #44523c;
      background: #20261e;
      color: #f4f4f1;
    }

    .topic-button.current {
      border-color: #8fbf73;
      color: #f4f4f1;
    }

    .topic-button.mastery-low:hover,
    .topic-button.mastery-low.active,
    .topic-button.mastery-low.current {
      border-left-color: #d96257;
    }

    .topic-button.mastery-medium:hover,
    .topic-button.mastery-medium.active,
    .topic-button.mastery-medium.current {
      border-left-color: #d0a548;
    }

    .topic-button.mastery-high:hover,
    .topic-button.mastery-high.active,
    .topic-button.mastery-high.current {
      border-left-color: #73b66d;
    }

    .topic-button.mastery-ungraded:hover,
    .topic-button.mastery-ungraded.active,
    .topic-button.mastery-ungraded.current {
      border-left-color: #3a3b35;
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
      color: #c8d7bd;
      padding: 0.35rem 0.55rem;
      font: inherit;
      font-size: 0.92rem;
      text-align: left;
      overflow-wrap: anywhere;
      cursor: pointer;
    }

    .demo-leaf:hover {
      border-color: #44523c;
      background: #20261e;
      color: #f4f4f1;
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

    .unassigned-lessons {
      display: grid;
      gap: 0.4rem;
      margin-top: 0.85rem;
      border-top: 1px solid #2f302b;
      padding-top: 0.75rem;
    }

    .unassigned-heading {
      margin: 0 0 0.1rem;
      color: #a1a19a;
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

    .glossary-pane {
      min-height: 0;
      overflow-y: auto;
      border: 1px solid #33342f;
      border-radius: 8px;
      background: #151612;
      padding: 1rem 1.125rem;
    }

    .glossary-list {
      display: grid;
      gap: 0.75rem;
      margin-top: 1rem;
    }

    .glossary-entry {
      display: grid;
      gap: 0.45rem;
      border: 1px solid #30312d;
      border-radius: 8px;
      background: #1a1b18;
      padding: 0.85rem 0.95rem;
    }

    .glossary-entry h3 {
      margin: 0;
      color: #fafaf8;
      font-size: 1rem;
      font-weight: 600;
    }

    .glossary-entry p {
      margin: 0;
      color: #eeeeea;
      line-height: 1.55;
    }

    .glossary-lesson-link,
    .term-card-link {
      justify-self: start;
      border: 0;
      background: transparent;
      color: #9fcf86;
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
      color: #a1a19a;
      font-size: 0.95rem;
      line-height: 1.5;
    }

    .chat-pane {
      display: grid;
      grid-template-rows: auto auto minmax(0, 1fr) auto;
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

    .feynman-panel {
      display: grid;
      gap: 0.75rem;
      border: 1px solid #b88745;
      border-radius: 8px;
      background: #211b12;
      padding: 0.85rem;
      box-shadow: inset 0 0 0 1px rgb(255 219 163 / 8%);
    }

    .feynman-panel.submitted {
      border-color: #526747;
      background: #182017;
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
      color: #ffd79a;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
      font-size: 0.75rem;
      font-weight: 700;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }

    .feynman-title h3 {
      margin: 0;
      color: #fafaf8;
      font-size: 1rem;
      font-weight: 600;
    }

    .concept-chip {
      flex: 0 0 auto;
      max-width: 12rem;
      overflow: hidden;
      border: 1px solid #9e743d;
      border-radius: 999px;
      color: #ffe1ae;
      padding: 0.18rem 0.5rem;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
      font-size: 0.78rem;
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
      color: #fff3df;
    }

    .feynman-status {
      color: #ffd79a;
      font-size: 0.9rem;
    }

    .feynman-replacement {
      border-left: 3px solid #b88745;
      color: #f0c589;
      padding-left: 0.6rem;
      font-size: 0.9rem;
    }

    .feynman-form {
      display: grid;
      gap: 0.65rem;
    }

    .feynman-answer {
      min-height: 8rem;
      border-color: #75552d;
      background: #17130e;
    }

    .feynman-answer:focus {
      outline-color: #d49a4a;
    }

    .feynman-submit {
      justify-self: end;
      min-height: 2.5rem;
      border: 0;
      border-radius: 8px;
      background: #f1b45b;
      color: #15100a;
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

    .demo-message-body {
      width: min(100%, 52rem);
      border: 0;
      background: transparent;
      padding: 0;
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
      margin-top: 0.5rem;
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
      align-self: start;
      min-height: 2.75rem;
      max-height: 2.75rem;
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

      header {
        display: grid;
      }

      .view-tabs {
        width: 100%;
      }

      .view-tab {
        flex: 1;
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

      .feynman-heading {
        display: grid;
      }

      .concept-chip {
        max-width: 100%;
      }

      .feynman-submit {
        width: 100%;
      }
    }
  </style>
</head>
<body>
  <main class="shell">
    <header>
      <h1>${escapeHtml(courseName)}</h1>
      <nav class="view-tabs" aria-label="Study view" role="tablist">
        <button class="view-tab active" type="button" data-view="lessons" role="tab" aria-selected="true">Lessons</button>
        <button class="view-tab" type="button" data-view="glossary" role="tab" aria-selected="false">Glossary</button>
      </nav>
    </header>

    <div class="workspace">
      <div class="study-pane">
        <section id="lesson-view" class="lesson-pane" aria-labelledby="lesson-heading">
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

          ${renderLessonContent(lessons, topics)}
        </section>

        <section id="glossary-view" class="glossary-pane" aria-labelledby="glossary-heading" hidden>
          <h2 id="glossary-heading">Glossary</h2>
          <div id="glossary-list" class="glossary-list"></div>
        </section>
      </div>

      <aside class="chat-pane" aria-label="Chat">
        <div class="chat-header">
          <h2>Chat</h2>
          <p id="status">Agent is working…</p>
        </div>

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

        <section id="transcript" aria-live="polite"></section>

        <form id="turn-form" class="composer">
          <textarea id="message" name="message" aria-label="Message" placeholder="Message" disabled></textarea>
          <button id="submit" class="send-button" type="submit" disabled>Send</button>
        </form>
      </aside>
    </div>
    <div id="term-card" class="term-card" role="tooltip" hidden></div>
  </main>

  <script>${script}</script>
</body>
</html>`;
};

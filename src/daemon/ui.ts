import type { LessonSnapshot, RenderedLesson } from "./lessons";
import { renderDemoEmbed, renderMarkdown } from "./markdown";

export type DemoEntry = Readonly<{
  file: string;
  title?: string;
  addedAt: string;
}>;

export type GlossaryEntry = Readonly<{
  term: string;
  def: string;
  lesson?: string;
  addedAt: string;
}>;

export type MasteryEntry = Readonly<{
  concept: string;
  score: number;
  gaps?: string;
  at: string;
}>;

export type TopicNode = Readonly<{
  path: string;
  title: string;
  body?: string;
  lesson?: string;
  enteredAt?: string;
  current: boolean;
  demos?: readonly DemoEntry[];
  children: readonly TopicNode[];
}>;

export type ActiveFeynmanCheck = Readonly<{
  concept: string;
  prompt: string;
  keyPoints: readonly string[];
  issuedAt: string;
  replaced?: Readonly<{
    concept: string;
    issuedAt: string;
    replacedAt: string;
  }>;
}>;

export type TranscriptEntry =
  | Readonly<{
      role: "learner" | "agent";
      text: string;
      at: string;
      kind?: "text";
    }>
  | Readonly<{
      role: "agent";
      kind: "demo";
      file: string;
      title?: string;
      at: string;
    }>
  | Readonly<{
      role: "agent";
      kind: "lesson";
      lesson: string;
      at: string;
    }>
  | Readonly<{
      role: "agent";
      kind: "feynman-check";
      concept: string;
      prompt: string;
      at: string;
    }>
  | Readonly<{
      role: "learner";
      kind: "feynman-answer";
      concept: string;
      text: string;
      at: string;
    }>
  | Readonly<{
      role: "system";
      kind: "tool-call";
      text: string;
      at: string;
      tool: string;
    }>;

type RenderedTranscriptEntry = TranscriptEntry &
  Readonly<{
    html: string;
    title?: string;
    lessonMissing?: boolean;
  }>;

type UiRenderStatus =
  | "waiting-for-agent"
  | "agent-working"
  | "agent-failed"
  | "wrapping-up"
  | "session-ended";

type HarnessUiOption = Readonly<{
  id: string;
  name: string;
  installed: boolean;
  authenticated: boolean;
  version?: string;
  selected: boolean;
  login?: Readonly<{
    command: string;
    manual: boolean;
    note: string;
  }>;
  install?: Readonly<{
    command: string;
    docsUrl: string;
  }>;
}>;

type OnboardingUiState = "welcome" | "connect-agent" | "tutorial-offer" | "done";

type ProfileUi = Readonly<{
  name: string | null;
  onboardingState: OnboardingUiState;
  settings: Readonly<Record<string, unknown>>;
  preferredHarness: string | null;
  dataDir: string;
}>;

type RenderPageOptions = Readonly<{
  courseId?: number;
  orchestrated?: boolean;
  harnesses?: readonly HarnessUiOption[];
  profile?: ProfileUi;
  dataDir?: string;
  onboardingState?: OnboardingUiState;
}>;

const topicConceptIds = (topic: TopicNode): readonly string[] => {
  const slug = topic.path.split("/").at(-1) ?? topic.path;
  return slug === topic.path ? [topic.path] : [topic.path, slug];
};

const compareMasteryRecency = (
  left: MasteryEntry,
  right: MasteryEntry,
): number => {
  const timeDelta = Date.parse(left.at) - Date.parse(right.at);
  if (timeDelta !== 0 && !Number.isNaN(timeDelta)) {
    return timeDelta;
  }

  return left.at.localeCompare(right.at);
};

const latestMasteryForTopic = (
  topic: TopicNode,
  scores: readonly MasteryEntry[],
): MasteryEntry | undefined => {
  const candidates = new Set(topicConceptIds(topic));

  return scores.reduce<MasteryEntry | undefined>((match, entry) => {
    if (!candidates.has(entry.concept)) {
      return match;
    }

    return match === undefined || compareMasteryRecency(entry, match) > 0
      ? entry
      : match;
  }, undefined);
};

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

const libraryClientScript = String.raw`
(() => {
  const currentCourseId = __LIBRARY_COURSE_ID__;
  let onboardingState = __ONBOARDING_STATE__;
  let profile = __PROFILE__;
  const dataDir = __DATA_DIR__;
  const appShell = document.querySelector(".shell");
  const onboardingScreen = document.querySelector("#onboarding-screen");
  const onboardingPanels = [...document.querySelectorAll("[data-onboarding-step]")];
  const onboardingNameInput = document.querySelector("#onboarding-name");
  const onboardingWelcomeContinue = document.querySelector("#onboarding-welcome-continue");
  const onboardingHarnessList = document.querySelector("#onboarding-harness-list");
  const onboardingHarnessStatus = document.querySelector("#onboarding-harness-status");
  const onboardingRecheckButtons = [...document.querySelectorAll("[data-onboarding-recheck]")];
  const onboardingConnectContinue = document.querySelector("#onboarding-connect-continue");
  const onboardingSkip = document.querySelector("#onboarding-skip");
  const tutorialStart = document.querySelector("#tutorial-start");
  const tutorialLater = document.querySelector("#tutorial-later");
  const tutorialStatus = document.querySelector("#tutorial-status");
  const libraryScreen = document.querySelector("#library-screen");
  const settingsScreen = document.querySelector("#settings-screen");
  const settingsButton = document.querySelector("#library-settings");
  const settingsForm = document.querySelector("#settings-form");
  const settingsNameInput = document.querySelector("#settings-name");
  const settingsHarnessSelect = document.querySelector("#settings-harness");
  const settingsDataDir = document.querySelector("#settings-data-dir");
  const settingsStatus = document.querySelector("#settings-status");
  const settingsBack = document.querySelector("#settings-back");
  const rerunOnboarding = document.querySelector("#rerun-onboarding");
  const courseViewElements = [...document.querySelectorAll("[data-course-view]")];
  const libraryList = document.querySelector("#course-library-list");
  const libraryStatusText = document.querySelector("#library-status");
  const newCourseButton = document.querySelector("#new-course");
  const brainstormCourseButton = document.querySelector("#brainstorm-course");
  const importCourseButton = document.querySelector("#import-course");
  const importNotice = document.querySelector("#import-notice");
  const formPanel = document.querySelector("#library-form-panel");
  const formTitle = document.querySelector("#library-form-title");
  const courseForm = document.querySelector("#library-course-form");
  const titleInput = document.querySelector("#library-title-input");
  const descriptionInput = document.querySelector("#library-description-input");
  const harnessSelect = document.querySelector("#library-harness-select");
  const attachedDirInput = document.querySelector("#library-attached-dir-input");
  const saveButton = document.querySelector("#library-save-course");
  const cancelButton = document.querySelector("#library-cancel-course");
  const formStatus = document.querySelector("#library-form-status");
  const ideationPanel = document.querySelector("#course-ideation-panel");
  const ideationForm = document.querySelector("#course-ideation-form");
  const ideationSeedInput = document.querySelector("#course-ideation-seed");
  const startIdeationButton = document.querySelector("#start-course-ideation");
  const cancelIdeationButton = document.querySelector("#cancel-course-ideation");
  const ideationStatus = document.querySelector("#course-ideation-status");
  const draftsSection = document.querySelector("#drafts-section");
  const draftList = document.querySelector("#draft-course-list");
  const draftsStatus = document.querySelector("#drafts-status");
  const wizardPanel = document.querySelector("#course-wizard-panel");
  const wizardTitleInput = document.querySelector("#wizard-title-input");
  const wizardDescriptionInput = document.querySelector("#wizard-description-input");
  const wizardTopicTree = document.querySelector("#wizard-topic-tree");
  const wizardTranscript = document.querySelector("#wizard-transcript");
  const wizardReplyForm = document.querySelector("#wizard-reply-form");
  const wizardReplyInput = document.querySelector("#wizard-reply-input");
  const wizardReplyButton = document.querySelector("#wizard-reply-submit");
  const wizardAcceptButton = document.querySelector("#wizard-accept-plan");
  const wizardDiscardButton = document.querySelector("#wizard-discard-plan");
  const wizardCloseButton = document.querySelector("#wizard-close");
  const wizardStatus = document.querySelector("#wizard-status");
  const backToLibraryButton = document.querySelector("#back-to-library");
  const wordmarks = [...document.querySelectorAll(".wordmark")];
  const statusButtons = [...document.querySelectorAll("[data-library-status]")];

  if (
    libraryScreen === null ||
    libraryList === null ||
    libraryStatusText === null ||
    courseForm === null ||
    titleInput === null ||
    descriptionInput === null ||
    harnessSelect === null ||
    attachedDirInput === null ||
    saveButton === null ||
    formStatus === null ||
    ideationPanel === null ||
    ideationForm === null ||
    ideationSeedInput === null ||
    startIdeationButton === null ||
    ideationStatus === null ||
    draftList === null ||
    draftsStatus === null ||
    wizardPanel === null ||
    wizardTitleInput === null ||
    wizardDescriptionInput === null ||
    wizardTopicTree === null ||
    wizardTranscript === null ||
    wizardReplyForm === null ||
    wizardReplyInput === null ||
    wizardReplyButton === null ||
    wizardAcceptButton === null ||
    wizardDiscardButton === null ||
    wizardStatus === null
  ) {
    return;
  }

  let libraryStatus = "active";
  let libraryCourses = [];
  let draftCourses = [];
  let courseDetails = new Map();
  let harnesses = [];
  let editingCourseId = undefined;
  let wizardCourseId = undefined;
  let wizardPlanDirty = false;
  let wizardRenderedPlanKey = undefined;
  let libraryLoading = false;
  let draftsLoading = false;
  let libraryError = undefined;
  let draftsError = undefined;
  let formBusy = false;
  let ideationBusy = false;
  let wizardBusy = false;
  let loadedStatuses = new Set();
  let draftsLoaded = false;
  const refreshTimers = new Map();

  const isRecord = (value) =>
    value !== null && typeof value === "object" && !Array.isArray(value);

  const courseIdNumber = (value) => {
    const number = Number(value);
    return Number.isFinite(number) ? number : undefined;
  };

  const requestJson = async (url, options = {}) => {
    const response = await fetch(url, options);
    if (!response.ok) {
      const message = await response.text();
      throw new Error(message.length === 0 ? "Request failed." : message);
    }

    return response.json();
  };

  const harnessReady = (harness) =>
    harness.installed === true && harness.authenticated === true;

  const onboardingDone = () => onboardingState === "done";

  const patchProfile = async (body) => {
    profile = await requestJson("/api/profile", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return profile;
  };

  const setOnboardingState = async (state) => {
    const payload = await requestJson("/api/onboarding", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ state }),
    });
    onboardingState = payload.state;
    if (isRecord(payload.profile)) {
      profile = payload.profile;
    }
  };

  const openTutorialCourse = async () => {
    const payload = await requestJson("/api/tutorial", { method: "POST" });
    const courseId = courseIdNumber(payload?.courseId);
    if (courseId === undefined) {
      throw new Error("Tutorial course could not be opened.");
    }

    await patchProfile({ settings: { tutorialChoice: "start" } });
    if (!onboardingDone()) {
      await setOnboardingState("done");
    }

    openCourse(courseId);
  };

  const commandText = (command) =>
    typeof command === "string" && command.length > 0 ? command : "";

  const harnessLoginCommand = (harness) =>
    commandText(harness?.login?.command);

  const harnessInstallCommand = (harness) =>
    commandText(harness?.install?.command);

  const copyText = async (text, statusElement) => {
    if (text.length === 0) {
      return;
    }

    try {
      await navigator.clipboard.writeText(text);
      if (statusElement !== null) {
        statusElement.textContent = "Copied.";
      }
    } catch {
      if (statusElement !== null) {
        statusElement.textContent = text;
      }
    }
  };

  const harnessStateText = (harness) => {
    if (!isRecord(harness)) {
      return "ready";
    }

    if (harness.installed !== true) {
      return "not installed";
    }

    if (harness.authenticated !== true) {
      return "not logged in";
    }

    return typeof harness.version === "string" ? harness.version : "ready";
  };

  const onboardingHarnessState = (harness) => {
    if (!isRecord(harness) || harness.installed !== true) {
      return "not-installed";
    }

    if (harness.authenticated !== true) {
      return "installed-unauthenticated";
    }

    return "ready";
  };

  const createCommandRow = (command, statusElement) => {
    const row = document.createElement("div");
    row.className = "onboarding-command-row";

    const code = document.createElement("code");
    code.textContent = command;

    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "library-button secondary";
    copy.textContent = "Copy";
    copy.addEventListener("click", () => {
      void copyText(command, statusElement);
    });

    row.append(code, copy);
    return row;
  };

  const selectPreferredHarness = async (harness) => {
    if (!harnessReady(harness)) {
      return;
    }

    await patchProfile({ preferredHarness: harness.id });
    harnesses = harnesses.map((candidate) => ({
      ...candidate,
      selected: candidate.id === harness.id,
    }));
    renderLibraryHarnessPicker(harness.id);
    renderSettingsHarnessPicker();
    renderOnboardingHarnesses();
  };

  const loginHarness = async (harness, statusElement) => {
    const response = await fetch(
      "/api/harnesses/" + encodeURIComponent(String(harness.id)) + "/login",
      { method: "POST" },
    );
    const text = await response.text();
    const payload =
      text.length === 0
        ? undefined
        : (() => {
            try {
              return JSON.parse(text);
            } catch {
              return undefined;
            }
          })();
    if (!response.ok) {
      statusElement.textContent = text.length === 0 ? "Login failed." : text;
      return;
    }

    if (payload?.manual === true) {
      statusElement.textContent =
        "Run " + String(payload.command ?? harnessLoginCommand(harness)) + " in your terminal.";
      return;
    }

    statusElement.textContent = "Login launched. Re-check when it finishes.";
  };

  const renderOnboardingHarnesses = () => {
    if (onboardingHarnessList === null || onboardingHarnessStatus === null) {
      return;
    }

    onboardingHarnessList.replaceChildren();
    const readyHarnesses = harnesses.filter(harnessReady);
    if (onboardingConnectContinue !== null) {
      onboardingConnectContinue.disabled = readyHarnesses.length === 0;
    }
    onboardingHarnessStatus.textContent =
      readyHarnesses.length === 0
        ? "No ready agents yet. You can log in, install one, or skip for now."
        : "Ready agents can be used as your default.";

    for (const harness of harnesses) {
      const state = onboardingHarnessState(harness);
      const card = document.createElement("article");
      card.className = "onboarding-harness-card";
      card.dataset.harnessId = harness.id;
      card.dataset.harnessState = state;

      const header = document.createElement("div");
      header.className = "onboarding-harness-header";

      const title = document.createElement("h3");
      title.textContent = String(harness.name ?? harness.id);

      const badge = document.createElement("span");
      badge.className = "course-status-badge";
      badge.textContent =
        state === "ready"
          ? "ready"
          : state === "installed-unauthenticated"
            ? "not logged in"
            : "not installed";

      header.append(title, badge);

      const body = document.createElement("p");
      body.textContent =
        state === "ready"
          ? "Installed and authenticated."
          : state === "installed-unauthenticated"
            ? "Installed, but Overlearn did not find local auth."
            : "Overlearn did not find the agent command on PATH.";

      const status = document.createElement("p");
      status.className = "onboarding-card-status";

      const actions = document.createElement("div");
      actions.className = "library-form-actions";

      if (state === "ready") {
        const select = document.createElement("button");
        select.type = "button";
        select.className = "library-button primary";
        select.dataset.onboardingSelectHarness = harness.id;
        select.textContent = harness.selected ? "Preferred" : "Use as preferred";
        select.disabled = harness.selected === true;
        select.addEventListener("click", () => {
          void selectPreferredHarness(harness);
        });
        actions.append(select);
      } else if (state === "installed-unauthenticated") {
        const login = document.createElement("button");
        login.type = "button";
        login.className = "library-button primary";
        login.textContent = "Log in";
        login.addEventListener("click", () => {
          void loginHarness(harness, status);
        });
        actions.append(login);

        const command = harnessLoginCommand(harness);
        if (command.length > 0) {
          card.append(createCommandRow(command, status));
        }
      } else {
        const command = harnessInstallCommand(harness);
        if (command.length > 0) {
          card.append(createCommandRow(command, status));
        }

        if (typeof harness?.install?.docsUrl === "string") {
          const docs = document.createElement("a");
          docs.className = "onboarding-docs-link";
          docs.href = harness.install.docsUrl;
          docs.target = "_blank";
          docs.rel = "noreferrer";
          docs.textContent = "Docs";
          actions.append(docs);
        }
      }

      const recheck = document.createElement("button");
      recheck.type = "button";
      recheck.className = "library-button secondary";
      recheck.textContent = "Re-check";
      recheck.addEventListener("click", () => {
        void refreshLibraryHarnesses(true);
      });
      actions.append(recheck);

      card.prepend(header, body);
      card.append(actions, status);
      onboardingHarnessList.append(card);
    }
  };

  const renderLibraryHarnessPicker = (selectedId) => {
    harnessSelect.replaceChildren();

    const defaultOption = document.createElement("option");
    defaultOption.value = "";
    defaultOption.textContent = "Default harness";
    harnessSelect.append(defaultOption);

    for (const harness of harnesses) {
      if (!isRecord(harness) || typeof harness.id !== "string") {
        continue;
      }

      const option = document.createElement("option");
      option.value = harness.id;
      option.textContent =
        String(harness.name ?? harness.id) + " - " + harnessStateText(harness);
      option.disabled = !harnessReady(harness);
      harnessSelect.append(option);
    }

    harnessSelect.value =
      typeof selectedId === "string" && selectedId.length > 0 ? selectedId : "";
  };

  const refreshLibraryHarnesses = async (refresh = false) => {
    try {
      const payload = await requestJson("/api/harnesses" + (refresh ? "?refresh=1" : ""));
      harnesses = Array.isArray(payload)
        ? payload
        : Array.isArray(payload?.harnesses)
          ? payload.harnesses
          : [];
      renderLibraryHarnessPicker(harnessSelect.value);
      renderSettingsHarnessPicker();
      renderOnboardingHarnesses();
    } catch {
      harnesses = [];
      renderLibraryHarnessPicker();
      renderSettingsHarnessPicker();
      renderOnboardingHarnesses();
    }
  };

  const countTopics = (topics) =>
    Array.isArray(topics)
      ? topics.reduce(
          (count, topic) => count + 1 + countTopics(topic?.children),
          0,
        )
      : 0;

  const latestTimestamp = (course, detail) => {
    const times = [];
    const add = (value) => {
      if (typeof value !== "string" || value.length === 0) {
        return;
      }

      const parsed = Date.parse(value);
      if (!Number.isNaN(parsed)) {
        times.push(parsed);
      }
    };

    add(course?.updatedAt);
    add(course?.createdAt);
    add(detail?.course?.updatedAt);
    add(detail?.course?.createdAt);

    if (Array.isArray(detail?.transcript)) {
      for (const entry of detail.transcript) {
        add(entry?.at);
      }
    }

    if (Array.isArray(detail?.mastery)) {
      for (const entry of detail.mastery) {
        add(entry?.at);
      }
    }

    return times.length === 0 ? undefined : Math.max(...times);
  };

  const formatLastActivity = (course, detail) => {
    const timestamp = latestTimestamp(course, detail);
    if (timestamp === undefined) {
      return "No activity yet";
    }

    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(timestamp));
  };

  const masterySummaryText = (detail) => {
    const mastery = Array.isArray(detail?.mastery) ? detail.mastery : [];
    if (mastery.length === 0) {
      return "No mastery yet";
    }

    const scores = mastery
      .map((entry) => Number(entry?.score))
      .filter((score) => Number.isFinite(score));
    if (scores.length === 0) {
      return String(mastery.length) + " recorded";
    }

    const average = Math.round(
      scores.reduce((total, score) => total + score, 0) / scores.length,
    );
    const weakest = mastery.reduce((match, entry) => {
      const score = Number(entry?.score);
      if (!Number.isFinite(score)) {
        return match;
      }

      return match === undefined || score < Number(match.score) ? entry : match;
    }, undefined);

    return (
      String(scores.length) +
      " graded · avg " +
      String(average) +
      (weakest === undefined
        ? ""
        : " · weakest " + String(weakest.concept) + " " + String(weakest.score))
    );
  };

  const upsertVisibleCourse = (course) => {
    if (!isRecord(course) || typeof course.id !== "number") {
      return;
    }

    const nextStatus =
      course.status === "archived"
        ? "archived"
        : course.status === "draft"
          ? "draft"
          : "active";
    libraryCourses = libraryCourses.filter((item) => item.id !== course.id);
    draftCourses = draftCourses.filter((item) => item.id !== course.id);

    if (nextStatus === "draft") {
      draftCourses.push(course);
      draftCourses.sort((left, right) => {
        const leftTime = Date.parse(left.updatedAt ?? left.createdAt ?? "");
        const rightTime = Date.parse(right.updatedAt ?? right.createdAt ?? "");
        return (Number.isNaN(rightTime) ? 0 : rightTime) - (Number.isNaN(leftTime) ? 0 : leftTime);
      });
      return;
    }

    if (nextStatus === libraryStatus) {
      libraryCourses.push(course);
      libraryCourses.sort((left, right) => {
        const leftTime = Date.parse(left.updatedAt ?? left.createdAt ?? "");
        const rightTime = Date.parse(right.updatedAt ?? right.createdAt ?? "");
        return (Number.isNaN(rightTime) ? 0 : rightTime) - (Number.isNaN(leftTime) ? 0 : leftTime);
      });
    }
  };

  const refreshLibraryCourse = async (courseId, options = {}) => {
    const id = courseIdNumber(courseId);
    if (id === undefined) {
      return;
    }

    const detail = await requestJson("/api/courses/" + encodeURIComponent(String(id)));
    courseDetails.set(String(id), detail);
    if (isRecord(detail?.course)) {
      upsertVisibleCourse(detail.course);
    }

    if (options.render !== false) {
      renderLibrary();
      if (wizardCourseId === id) {
        renderWizard();
      }
    }
  };

  const queueLibraryCourseRefresh = (courseId) => {
    const id = courseIdNumber(courseId);
    if (id === undefined) {
      return;
    }

    const key = String(id);
    const existing = refreshTimers.get(key);
    if (existing !== undefined) {
      clearTimeout(existing);
    }

    refreshTimers.set(
      key,
      setTimeout(() => {
        refreshTimers.delete(key);
        void refreshLibraryCourse(id).catch(() => undefined);
      }, 160),
    );
  };

  const setLibraryMessage = (message) => {
    libraryStatusText.textContent = message;
  };

  const renderLibraryTabs = () => {
    for (const button of statusButtons) {
      const selected = button.dataset.libraryStatus === libraryStatus;
      button.classList.toggle("active", selected);
      button.setAttribute("aria-selected", selected ? "true" : "false");
    }
  };

  const createMetaItem = (label, value) => {
    const item = document.createElement("div");
    item.className = "course-card-stat";

    const labelElement = document.createElement("span");
    labelElement.className = "course-card-stat-label";
    labelElement.textContent = label;

    const valueElement = document.createElement("span");
    valueElement.className = "course-card-stat-value";
    valueElement.textContent = value;

    item.append(labelElement, valueElement);
    return item;
  };

  const courseDescriptionText = (course) => {
    const description = course?.description;
    return typeof description === "string" && description.trim().length > 0
      ? description.trim()
      : "No description yet.";
  };

  const openCourse = (courseId) => {
    const id = courseIdNumber(courseId);
    if (id === undefined) {
      return;
    }

    if (currentCourseId === id) {
      history.pushState({ screen: "course", courseId: id }, "", "#course");
      setLibraryVisible(false);
      return;
    }

    location.href = "/?course=" + encodeURIComponent(String(id)) + "#course";
  };

  const openCourseForm = (mode, course) => {
    closeIdeationPanel();
    closeWizard();
    editingCourseId = mode === "edit" ? course?.id : undefined;
    formPanel.hidden = false;
    formTitle.textContent = mode === "edit" ? "Edit course" : "New course";
    saveButton.textContent = mode === "edit" ? "Save changes" : "Create course";
    titleInput.value = mode === "edit" ? String(course?.title ?? "") : "";
    descriptionInput.value =
      mode === "edit" && typeof course?.description === "string"
        ? course.description
        : "";
    attachedDirInput.value =
      mode === "edit" && typeof course?.attachedDir === "string"
        ? course.attachedDir
        : "";
    renderLibraryHarnessPicker(
      mode === "edit" && typeof course?.harnessId === "string"
        ? course.harnessId
        : "",
    );
    formStatus.hidden = true;
    titleInput.focus();
  };

  const closeCourseForm = () => {
    editingCourseId = undefined;
    formPanel.hidden = true;
    formStatus.hidden = true;
    courseForm.reset();
  };

  const createCourseCard = (course) => {
    const id = courseIdNumber(course?.id);
    const detail = id === undefined ? undefined : courseDetails.get(String(id));
    const card = document.createElement("article");
    card.className = "course-card";
    if (id !== undefined) {
      card.dataset.courseId = String(id);
    }

    const header = document.createElement("div");
    header.className = "course-card-header";

    const titleGroup = document.createElement("div");
    titleGroup.className = "course-card-title-group";

    const title = document.createElement("h3");
    title.textContent = String(course?.title ?? "Untitled course");

    const description = document.createElement("p");
    description.textContent = courseDescriptionText(course);

    titleGroup.append(title, description);

    const badge = document.createElement("span");
    badge.className = "course-status-badge";
    badge.textContent = String(course?.status ?? libraryStatus);

    header.append(titleGroup, badge);

    const stats = document.createElement("div");
    stats.className = "course-card-stats";
    stats.append(
      createMetaItem("Topics", String(countTopics(detail?.topics))),
      createMetaItem("Mastery", masterySummaryText(detail)),
      createMetaItem("Last activity", formatLastActivity(course, detail)),
    );

    const actions = document.createElement("div");
    actions.className = "course-card-actions";

    const openButton = document.createElement("button");
    openButton.type = "button";
    openButton.className = "library-button primary";
    openButton.textContent = "Open";
    openButton.addEventListener("click", () => openCourse(id));
    actions.append(openButton);

    const editButton = document.createElement("button");
    editButton.type = "button";
    editButton.className = "library-button secondary";
    editButton.textContent = "Edit";
    editButton.addEventListener("click", () => openCourseForm("edit", course));
    actions.append(editButton);

    if (libraryStatus === "archived") {
      const unarchiveButton = document.createElement("button");
      unarchiveButton.type = "button";
      unarchiveButton.className = "library-button secondary";
      unarchiveButton.textContent = "Unarchive";
      unarchiveButton.addEventListener("click", () => {
        void unarchiveCourse(id);
      });
      actions.append(unarchiveButton);
    } else {
      const archiveButton = document.createElement("button");
      archiveButton.type = "button";
      archiveButton.className = "library-button danger";
      archiveButton.textContent = "Archive";
      archiveButton.addEventListener("click", () => {
        void archiveCourse(course);
      });
      actions.append(archiveButton);
    }

    card.append(header, stats, actions);
    return card;
  };

  const topicChildren = (topic) =>
    Array.isArray(topic?.children) ? topic.children : [];

  const topicBodyText = (topic) =>
    typeof topic?.body === "string"
      ? topic.body
      : typeof topic?.summary === "string"
        ? topic.summary
        : "";

  const planKey = (detail) => {
    if (!isRecord(detail?.course) || !Array.isArray(detail?.topics)) {
      return "";
    }

    return String(detail.course.updatedAt ?? "") + ":" + JSON.stringify(detail.topics);
  };

  const hasDraftPlan = (detail) =>
    isRecord(detail) && Array.isArray(detail.topics) && detail.topics.length > 0;

  const createDraftCard = (course) => {
    const id = courseIdNumber(course?.id);
    const detail = id === undefined ? undefined : courseDetails.get(String(id));
    const card = document.createElement("article");
    card.className = "course-card draft-course-card";
    if (id !== undefined) {
      card.dataset.courseId = String(id);
    }

    const header = document.createElement("div");
    header.className = "course-card-header";

    const titleGroup = document.createElement("div");
    titleGroup.className = "course-card-title-group";

    const title = document.createElement("h3");
    title.textContent = String(course?.title ?? "Draft course");

    const description = document.createElement("p");
    description.textContent = hasDraftPlan(detail)
      ? "A proposed plan is ready to review."
      : courseDescriptionText(course);

    titleGroup.append(title, description);

    const badge = document.createElement("span");
    badge.className = "course-status-badge";
    badge.textContent = "draft";
    header.append(titleGroup, badge);

    const stats = document.createElement("div");
    stats.className = "course-card-stats";
    stats.append(
      createMetaItem("Topics", String(countTopics(detail?.topics))),
      createMetaItem("Plan", hasDraftPlan(detail) ? "ready" : "in progress"),
      createMetaItem("Last activity", formatLastActivity(course, detail)),
    );

    const actions = document.createElement("div");
    actions.className = "course-card-actions";

    const resumeButton = document.createElement("button");
    resumeButton.type = "button";
    resumeButton.className = "library-button primary";
    resumeButton.textContent = hasDraftPlan(detail) ? "Review" : "Resume";
    resumeButton.addEventListener("click", () => {
      void openWizard(id);
    });
    actions.append(resumeButton);

    const discardButton = document.createElement("button");
    discardButton.type = "button";
    discardButton.className = "library-button danger";
    discardButton.textContent = "Discard";
    discardButton.addEventListener("click", () => {
      void discardDraftCourse(id);
    });
    actions.append(discardButton);

    card.append(header, stats, actions);
    return card;
  };

  const renderDrafts = () => {
    draftList.replaceChildren();

    if (draftsSection !== null) {
      draftsSection.hidden = false;
    }

    if (draftsError !== undefined) {
      const error = document.createElement("p");
      error.className = "library-empty";
      error.textContent = draftsError;
      draftList.append(error);
      draftsStatus.textContent = "Drafts could not load.";
      return;
    }

    if (draftsLoading && draftCourses.length === 0) {
      const loading = document.createElement("p");
      loading.className = "library-empty";
      loading.textContent = "Loading drafts...";
      draftList.append(loading);
      draftsStatus.textContent = "Loading draft courses.";
      return;
    }

    if (draftCourses.length === 0) {
      const empty = document.createElement("p");
      empty.className = "library-empty";
      empty.textContent = "No draft course plans.";
      draftList.append(empty);
      draftsStatus.textContent = "No drafts.";
      return;
    }

    for (const course of draftCourses) {
      draftList.append(createDraftCard(course));
    }

    draftsStatus.textContent =
      String(draftCourses.length) +
      " draft " +
      (draftCourses.length === 1 ? "course" : "courses");
  };

  const createPlanTopicEditor = (topic) => {
    const wrapper = document.createElement("section");
    wrapper.className = "plan-topic-editor";
    wrapper.dataset.planTopic = "true";
    wrapper.dataset.topicPath = String(topic?.path ?? "");

    const row = document.createElement("div");
    row.className = "plan-topic-row";

    const label = document.createElement("label");
    label.textContent = "Topic";

    const input = document.createElement("input");
    input.type = "text";
    input.name = "topicTitle";
    input.value = String(topic?.title ?? "Untitled topic");
    input.required = true;
    input.dataset.topicTitle = "true";

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "library-button danger";
    remove.textContent = "Remove";
    remove.addEventListener("click", () => {
      wizardPlanDirty = true;
      wrapper.remove();
    });

    row.append(label, input, remove);

    const summaryLabel = document.createElement("label");
    summaryLabel.textContent = "Summary";

    const summary = document.createElement("textarea");
    summary.name = "topicSummary";
    summary.rows = 2;
    summary.value = topicBodyText(topic);
    summary.dataset.topicSummary = "true";

    const children = document.createElement("div");
    children.className = "plan-topic-children";
    for (const child of topicChildren(topic)) {
      children.append(createPlanTopicEditor(child));
    }

    wrapper.append(row, summaryLabel, summary, children);
    return wrapper;
  };

  const renderPlanEditor = (detail) => {
    wizardTopicTree.replaceChildren();

    if (!hasDraftPlan(detail)) {
      const empty = document.createElement("p");
      empty.className = "library-empty";
      empty.textContent = "The agent has not proposed a course plan yet.";
      wizardTopicTree.append(empty);
      return;
    }

    for (const topic of detail.topics) {
      wizardTopicTree.append(createPlanTopicEditor(topic));
    }
  };

  const topicInputFromElement = (element) => {
    const title = element.querySelector("[data-topic-title]");
    const summary = element.querySelector("[data-topic-summary]");
    const childContainer = element.querySelector(":scope > .plan-topic-children");
    const children = [...(childContainer?.children ?? [])]
      .filter((child) => child.dataset.planTopic === "true")
      .map(topicInputFromElement);

    return {
      path: element.dataset.topicPath ?? "",
      title: title?.value.trim() ?? "",
      body: summary?.value.trim() ?? "",
      ...(children.length === 0 ? {} : { children }),
    };
  };

  const gatherPlanTopics = () =>
    [...wizardTopicTree.children]
      .filter((child) => child.dataset.planTopic === "true")
      .map(topicInputFromElement)
      .filter((topic) => topic.title.length > 0 && topic.path.length > 0);

  const renderWizardTranscript = (detail) => {
    wizardTranscript.replaceChildren();
    const entries = Array.isArray(detail?.transcript) ? detail.transcript : [];

    if (entries.length === 0) {
      const empty = document.createElement("p");
      empty.className = "library-empty";
      empty.textContent = "No ideation messages yet.";
      wizardTranscript.append(empty);
      return;
    }

    for (const entry of entries) {
      const message = document.createElement("article");
      message.className = "wizard-message " + String(entry?.role ?? "system");
      const role = document.createElement("strong");
      role.textContent =
        entry?.role === "agent"
          ? "Agent"
          : entry?.role === "system"
            ? "System"
            : "You";
      const text = document.createElement("p");
      text.textContent = String(entry?.text ?? "");
      message.append(role, text);
      wizardTranscript.append(message);
    }
  };

  const renderWizard = () => {
    const id = courseIdNumber(wizardCourseId);
    const detail = id === undefined ? undefined : courseDetails.get(String(id));
    wizardPanel.hidden = id === undefined;
    if (id === undefined) {
      return;
    }

    renderWizardTranscript(detail);
    const course = detail?.course;
    const nextPlanKey = planKey(detail);
    if (!wizardPlanDirty && nextPlanKey !== wizardRenderedPlanKey) {
      wizardTitleInput.value = String(course?.title ?? "Draft course");
      wizardDescriptionInput.value =
        typeof course?.description === "string" ? course.description : "";
      renderPlanEditor(detail);
      wizardRenderedPlanKey = nextPlanKey;
    }

    const ready = hasDraftPlan(detail);
    wizardAcceptButton.disabled = wizardBusy || !ready;
    wizardReplyButton.disabled = wizardBusy;
    wizardDiscardButton.disabled = wizardBusy;
    wizardStatus.textContent = ready
      ? "Review the draft plan, make edits, then accept when it is ready."
      : "Brainstorm with your agent until it proposes a plan.";
  };

  const closeIdeationPanel = () => {
    ideationPanel.hidden = true;
    ideationStatus.hidden = true;
    ideationForm.reset();
  };

  const openIdeationPanel = () => {
    closeCourseForm();
    wizardPanel.hidden = true;
    ideationPanel.hidden = false;
    ideationStatus.hidden = true;
    ideationSeedInput.focus();
  };

  const closeWizard = () => {
    wizardCourseId = undefined;
    wizardPlanDirty = false;
    wizardRenderedPlanKey = undefined;
    wizardPanel.hidden = true;
    wizardTranscript.replaceChildren();
    wizardTopicTree.replaceChildren();
  };

  const openWizard = async (courseId) => {
    const id = courseIdNumber(courseId);
    if (id === undefined) {
      return;
    }

    closeCourseForm();
    closeIdeationPanel();
    wizardCourseId = id;
    wizardPlanDirty = false;
    wizardRenderedPlanKey = undefined;
    wizardPanel.hidden = false;
    history.pushState({ screen: "draft", courseId: id }, "", "#draft-" + String(id));
    renderWizard();
    await refreshLibraryCourse(id).catch((error) => {
      wizardStatus.textContent =
        error instanceof Error ? error.message : "Draft could not load.";
    });
    renderWizard();
  };

  const loadDraftCourses = async () => {
    draftsLoading = true;
    draftsError = undefined;
    renderDrafts();

    try {
      const payload = await requestJson("/api/courses?status=draft");
      draftCourses = Array.isArray(payload) ? [...payload] : [];
      draftsLoaded = true;
      renderDrafts();

      await Promise.all(
        draftCourses.map((course) =>
          refreshLibraryCourse(course.id, { render: false }).catch(() => undefined),
        ),
      );
    } catch (error) {
      draftsError = error instanceof Error ? error.message : "Drafts failed to load.";
    } finally {
      draftsLoading = false;
      renderDrafts();
    }
  };

  const discardDraftCourse = async (courseId) => {
    const id = courseIdNumber(courseId);
    if (id === undefined) {
      return;
    }

    if (!confirm("Discard this draft course?")) {
      return;
    }

    wizardBusy = true;
    renderWizard();
    try {
      await requestJson("/api/courses/" + encodeURIComponent(String(id)), {
        method: "DELETE",
      });
      courseDetails.delete(String(id));
      draftCourses = draftCourses.filter((course) => course.id !== id);
      if (wizardCourseId === id) {
        closeWizard();
      }
      renderDrafts();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Discard failed.";
      if (wizardCourseId === id) {
        wizardStatus.textContent = message;
      } else {
        draftsError = message;
        renderDrafts();
      }
    } finally {
      wizardBusy = false;
      renderWizard();
    }
  };

  const startIdeation = async () => {
    const seed = ideationSeedInput.value.trim();
    if (seed.length === 0 || ideationBusy) {
      return;
    }

    ideationBusy = true;
    startIdeationButton.disabled = true;
    ideationStatus.hidden = false;
    ideationStatus.textContent = "Starting brainstorm...";

    try {
      const payload = await requestJson("/api/courses/ideate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ seed }),
      });
      if (isRecord(payload?.course)) {
        upsertVisibleCourse(payload.course);
        await openWizard(payload.course.id);
      }
      void loadDraftCourses();
    } catch (error) {
      ideationStatus.textContent =
        error instanceof Error ? error.message : "Brainstorm could not start.";
    } finally {
      ideationBusy = false;
      startIdeationButton.disabled = false;
    }
  };

  const submitWizardReply = async () => {
    const id = courseIdNumber(wizardCourseId);
    const text = wizardReplyInput.value.trim();
    if (id === undefined || text.length === 0 || wizardBusy) {
      return;
    }

    wizardBusy = true;
    renderWizard();
    try {
      await requestJson("/api/courses/" + encodeURIComponent(String(id)) + "/submit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
      wizardReplyInput.value = "";
      await refreshLibraryCourse(id);
    } catch (error) {
      wizardStatus.textContent =
        error instanceof Error ? error.message : "Reply could not be sent.";
    } finally {
      wizardBusy = false;
      renderWizard();
    }
  };

  const acceptWizardPlan = async () => {
    const id = courseIdNumber(wizardCourseId);
    if (id === undefined || wizardBusy) {
      return;
    }

    const topics = gatherPlanTopics();
    if (topics.length === 0) {
      wizardStatus.textContent = "Keep at least one topic in the plan.";
      return;
    }

    wizardBusy = true;
    renderWizard();
    try {
      const payload = await requestJson(
        "/api/courses/" + encodeURIComponent(String(id)) + "/accept-plan",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            title: wizardTitleInput.value.trim(),
            description:
              wizardDescriptionInput.value.trim().length === 0
                ? null
                : wizardDescriptionInput.value.trim(),
            topics,
          }),
        },
      );
      if (isRecord(payload?.course)) {
        upsertVisibleCourse(payload.course);
      }
      draftCourses = draftCourses.filter((course) => course.id !== id);
      openCourse(id);
    } catch (error) {
      wizardStatus.textContent =
        error instanceof Error ? error.message : "Plan could not be accepted.";
    } finally {
      wizardBusy = false;
      renderWizard();
    }
  };

  const renderLibrary = () => {
    renderLibraryTabs();
    renderDrafts();
    libraryList.replaceChildren();

    if (libraryError !== undefined) {
      const error = document.createElement("p");
      error.className = "library-empty";
      error.textContent = libraryError;
      libraryList.append(error);
      setLibraryMessage("Library could not load.");
      return;
    }

    if (libraryLoading && libraryCourses.length === 0) {
      const loading = document.createElement("p");
      loading.className = "library-empty";
      loading.textContent = "Loading courses...";
      libraryList.append(loading);
      setLibraryMessage("Loading " + libraryStatus + " courses.");
      return;
    }

    if (libraryCourses.length === 0) {
      const empty = document.createElement("section");
      empty.className = "library-empty";
      const heading = document.createElement("h3");
      heading.textContent =
        libraryStatus === "archived" ? "No archived courses" : "No courses yet";
      const body = document.createElement("p");
      body.textContent =
        libraryStatus === "archived"
          ? "Archived courses will appear here."
          : "Create a course to start learning with a course-scoped agent.";
      empty.append(heading, body);
      if (libraryStatus !== "archived") {
        const tutorialButton = document.createElement("button");
        tutorialButton.id = "open-tutorial-empty";
        tutorialButton.type = "button";
        tutorialButton.className = "library-button secondary";
        tutorialButton.textContent = "Open the tutorial";
        tutorialButton.addEventListener("click", () => {
          tutorialButton.disabled = true;
          setLibraryMessage("Opening tutorial...");
          void openTutorialCourse().catch((error) => {
            tutorialButton.disabled = false;
            libraryError =
              error instanceof Error ? error.message : "Tutorial could not open.";
            renderLibrary();
          });
        });
        empty.append(tutorialButton);
      }
      libraryList.append(empty);
      setLibraryMessage(
        libraryStatus === "archived"
          ? "No archived courses."
          : "No active courses yet.",
      );
      return;
    }

    for (const course of libraryCourses) {
      libraryList.append(createCourseCard(course));
    }

    setLibraryMessage(
      String(libraryCourses.length) +
        " " +
        (libraryStatus === "archived" ? "archived" : "active") +
        (libraryCourses.length === 1 ? " course" : " courses"),
    );
  };

  const loadLibraryCourses = async (status = libraryStatus) => {
    libraryLoading = true;
    libraryError = undefined;
    renderLibrary();

    try {
      const payload = await requestJson(
        "/api/courses?status=" + encodeURIComponent(status),
      );
      if (status !== libraryStatus) {
        return;
      }

      libraryCourses = Array.isArray(payload) ? [...payload] : [];
      loadedStatuses.add(status);
      renderLibrary();

      await Promise.all(
        libraryCourses.map((course) =>
          refreshLibraryCourse(course.id, { render: false }).catch(() => undefined),
        ),
      );
    } catch (error) {
      libraryError = error instanceof Error ? error.message : "Library failed to load.";
    } finally {
      if (status === libraryStatus) {
        libraryLoading = false;
        renderLibrary();
      }
    }
  };

  const setLibraryStatus = (status) => {
    if (status !== "active" && status !== "archived") {
      return;
    }

    libraryStatus = status;
    closeCourseForm();
    closeIdeationPanel();
    closeWizard();
    void loadLibraryCourses(status);
  };

  const ensureLibraryLoaded = () => {
    void refreshLibraryHarnesses();
    if (!draftsLoaded) {
      void loadDraftCourses();
    } else {
      renderDrafts();
    }
    if (!loadedStatuses.has(libraryStatus)) {
      void loadLibraryCourses(libraryStatus);
    } else {
      renderLibrary();
    }
  };

  const renderSettingsHarnessPicker = () => {
    if (settingsHarnessSelect === null) {
      return;
    }

    settingsHarnessSelect.replaceChildren();

    const empty = document.createElement("option");
    empty.value = "";
    empty.textContent = "No preference";
    settingsHarnessSelect.append(empty);

    for (const harness of harnesses) {
      if (!isRecord(harness) || typeof harness.id !== "string") {
        continue;
      }

      const option = document.createElement("option");
      option.value = harness.id;
      option.textContent =
        String(harness.name ?? harness.id) + " - " + harnessStateText(harness);
      option.disabled = !harnessReady(harness);
      settingsHarnessSelect.append(option);
    }

    settingsHarnessSelect.value =
      typeof profile?.preferredHarness === "string"
        ? profile.preferredHarness
        : "";
  };

  const populateSettings = () => {
    if (
      settingsNameInput === null ||
      settingsHarnessSelect === null ||
      settingsDataDir === null
    ) {
      return;
    }

    settingsNameInput.value =
      typeof profile?.name === "string" ? profile.name : "";
    settingsDataDir.value =
      typeof profile?.dataDir === "string" ? profile.dataDir : dataDir;
    renderSettingsHarnessPicker();
  };

  const hideAllPrimaryScreens = () => {
    if (onboardingScreen !== null) {
      onboardingScreen.hidden = true;
    }
    if (settingsScreen !== null) {
      settingsScreen.hidden = true;
    }
    if (libraryScreen !== null) {
      libraryScreen.hidden = true;
    }
    for (const element of courseViewElements) {
      element.hidden = true;
    }
  };

  const applyOnboardingStep = () => {
    if (onboardingScreen === null) {
      return;
    }

    for (const panel of onboardingPanels) {
      panel.hidden = panel.dataset.onboardingStep !== onboardingState;
    }

    if (onboardingNameInput !== null) {
      onboardingNameInput.value =
        typeof profile?.name === "string" ? profile.name : "";
    }

    renderOnboardingHarnesses();
  };

  const setOnboardingVisible = () => {
    hideAllPrimaryScreens();
    if (onboardingScreen !== null) {
      onboardingScreen.hidden = false;
    }
    appShell?.classList.add("library-mode");
    document.body.classList.add("library-open");
    applyOnboardingStep();
  };

  const setSettingsVisible = () => {
    hideAllPrimaryScreens();
    if (settingsScreen !== null) {
      settingsScreen.hidden = false;
    }
    appShell?.classList.add("library-mode");
    document.body.classList.add("library-open");
    populateSettings();
  };

  const setLibraryVisible = (visible) => {
    if (!onboardingDone()) {
      if (!location.hash.startsWith("#onboarding")) {
        history.replaceState({ screen: "onboarding" }, "", "#onboarding");
      }
      setOnboardingVisible();
      return;
    }

    libraryScreen.hidden = !visible;
    if (settingsScreen !== null) {
      settingsScreen.hidden = true;
    }
    if (onboardingScreen !== null) {
      onboardingScreen.hidden = true;
    }
    for (const element of courseViewElements) {
      element.hidden = visible;
    }

    appShell?.classList.toggle("library-mode", visible);
    document.body.classList.toggle("library-open", visible);

    if (visible) {
      ensureLibraryLoaded();
    }
  };

  const showLibrary = () => {
    history.pushState({ screen: "library" }, "", "#library");
    setLibraryVisible(true);
  };

  const showSettings = () => {
    if (!onboardingDone()) {
      history.replaceState({ screen: "onboarding" }, "", "#onboarding");
      setOnboardingVisible();
      return;
    }

    history.pushState({ screen: "settings" }, "", "#settings");
    setSettingsVisible();
  };

  const applyRoute = () => {
    if (!onboardingDone()) {
      if (!location.hash.startsWith("#onboarding")) {
        history.replaceState({ screen: "onboarding" }, "", "#onboarding");
      }
      setOnboardingVisible();
      return;
    }

    if (location.hash === "#settings") {
      setSettingsVisible();
      return;
    }

    if (location.hash.startsWith("#draft-")) {
      const id = courseIdNumber(location.hash.slice("#draft-".length));
      if (id !== undefined) {
        setLibraryVisible(true);
        wizardCourseId = id;
        renderWizard();
        void refreshLibraryCourse(id).then(renderWizard).catch(() => undefined);
        return;
      }
    }

    if (location.hash === "#library" || currentCourseId === null) {
      setLibraryVisible(true);
      return;
    }

    setLibraryVisible(false);
  };

  const submitCourseForm = async () => {
    const title = titleInput.value.trim();
    if (title.length === 0 || formBusy) {
      return;
    }

    formBusy = true;
    saveButton.disabled = true;
    formStatus.hidden = false;
    formStatus.textContent =
      editingCourseId === undefined ? "Creating course..." : "Saving course...";

    const body = {
      title,
      description:
        descriptionInput.value.trim().length === 0
          ? null
          : descriptionInput.value.trim(),
      harnessId: harnessSelect.value.length === 0 ? null : harnessSelect.value,
      attachedDir:
        attachedDirInput.value.trim().length === 0
          ? null
          : attachedDirInput.value.trim(),
    };

    try {
      if (editingCourseId === undefined) {
        const created = await requestJson("/api/courses", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        openCourse(created.id);
        return;
      }

      const patched = await requestJson(
        "/api/courses/" + encodeURIComponent(String(editingCourseId)),
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      upsertVisibleCourse(patched);
      closeCourseForm();
      await refreshLibraryCourse(patched.id).catch(() => undefined);
      void loadLibraryCourses(libraryStatus);
    } catch (error) {
      formStatus.textContent =
        error instanceof Error ? error.message : "Course could not be saved.";
    } finally {
      formBusy = false;
      saveButton.disabled = false;
    }
  };

  const archiveCourse = async (course) => {
    const id = courseIdNumber(course?.id);
    if (id === undefined) {
      return;
    }

    const title = String(course?.title ?? "this course");
    if (!confirm("Archive " + title + "?")) {
      return;
    }

    await requestJson("/api/courses/" + encodeURIComponent(String(id)), {
      method: "DELETE",
    }).catch((error) => {
      libraryError = error instanceof Error ? error.message : "Archive failed.";
    });
    void loadLibraryCourses(libraryStatus);
  };

  const unarchiveCourse = async (courseId) => {
    const id = courseIdNumber(courseId);
    if (id === undefined) {
      return;
    }

    await requestJson("/api/courses/" + encodeURIComponent(String(id)), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "active" }),
    }).catch((error) => {
      libraryError = error instanceof Error ? error.message : "Unarchive failed.";
    });
    void loadLibraryCourses(libraryStatus);
  };

  const applyCoursesPayload = (payload) => {
    if (!isRecord(payload) || !Array.isArray(payload.courses)) {
      return;
    }

    libraryCourses = payload.courses.filter((course) =>
      libraryStatus === "archived"
        ? course.status === "archived"
        : course.status === "active",
    );
    draftCourses = payload.courses.filter((course) => course.status === "draft");
    loadedStatuses.add(libraryStatus);
    draftsLoaded = true;
    renderLibrary();

    for (const course of libraryCourses) {
      queueLibraryCourseRefresh(course.id);
    }
    for (const course of draftCourses) {
      queueLibraryCourseRefresh(course.id);
    }
  };

  newCourseButton?.addEventListener("click", () => {
    openCourseForm("create");
  });

  brainstormCourseButton?.addEventListener("click", openIdeationPanel);

  importCourseButton?.addEventListener("click", () => {
    importNotice.hidden = false;
    importNotice.textContent = "Import is coming soon.";
  });

  onboardingWelcomeContinue?.addEventListener("click", () => {
    void (async () => {
      const name =
        onboardingNameInput === null ? "" : onboardingNameInput.value.trim();
      if (name.length > 0) {
        await patchProfile({ name });
      }
      await setOnboardingState("connect-agent");
      history.replaceState({ screen: "onboarding" }, "", "#onboarding");
      applyRoute();
    })().catch(() => undefined);
  });

  for (const button of onboardingRecheckButtons) {
    button.addEventListener("click", () => {
      void refreshLibraryHarnesses(true);
    });
  }

  onboardingConnectContinue?.addEventListener("click", () => {
    void (async () => {
      const ready = harnesses.filter(harnessReady);
      if (ready.length === 0) {
        return;
      }

      const selectedReady = ready.find((harness) => harness.selected === true);
      const preferred = selectedReady ?? ready[0];
      if (preferred !== undefined && profile?.preferredHarness !== preferred.id) {
        await patchProfile({ preferredHarness: preferred.id });
      }

      await setOnboardingState("tutorial-offer");
      applyRoute();
    })().catch(() => undefined);
  });

  onboardingSkip?.addEventListener("click", () => {
    void (async () => {
      await patchProfile({ settings: { skippedAgentConnect: true } });
      await setOnboardingState("tutorial-offer");
      applyRoute();
    })().catch(() => undefined);
  });

  tutorialStart?.addEventListener("click", () => {
    tutorialStart.disabled = true;
    if (tutorialStatus !== null) {
      tutorialStatus.hidden = false;
      tutorialStatus.textContent = "Opening the tutorial...";
    }
    void openTutorialCourse().catch((error) => {
      tutorialStart.disabled = false;
      if (tutorialStatus !== null) {
        tutorialStatus.hidden = false;
        tutorialStatus.textContent =
          error instanceof Error ? error.message : "Tutorial could not open.";
      }
    });
  });

  const finishOnboarding = (choice) => {
    void (async () => {
      await patchProfile({ settings: { tutorialChoice: choice } });
      await setOnboardingState("done");
      history.replaceState({ screen: "library" }, "", "#library");
      setLibraryVisible(true);
    })().catch(() => undefined);
  };

  tutorialLater?.addEventListener("click", () => {
    finishOnboarding("later");
  });

  settingsButton?.addEventListener("click", showSettings);
  settingsBack?.addEventListener("click", showLibrary);

  settingsForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    void (async () => {
      if (
        settingsNameInput === null ||
        settingsHarnessSelect === null ||
        settingsStatus === null
      ) {
        return;
      }

      settingsStatus.hidden = false;
      settingsStatus.textContent = "Saving settings...";
      await patchProfile({
        name:
          settingsNameInput.value.trim().length === 0
            ? null
            : settingsNameInput.value.trim(),
        preferredHarness:
          settingsHarnessSelect.value.length === 0
            ? null
            : settingsHarnessSelect.value,
      });
      settingsStatus.textContent = "Settings saved.";
      renderLibraryHarnessPicker();
      renderSettingsHarnessPicker();
      renderOnboardingHarnesses();
    })().catch((error) => {
      if (settingsStatus !== null) {
        settingsStatus.hidden = false;
        settingsStatus.textContent =
          error instanceof Error ? error.message : "Settings could not be saved.";
      }
    });
  });

  rerunOnboarding?.addEventListener("click", () => {
    void (async () => {
      await setOnboardingState("welcome");
      history.replaceState({ screen: "onboarding" }, "", "#onboarding");
      applyRoute();
    })().catch(() => undefined);
  });

  cancelButton?.addEventListener("click", closeCourseForm);
  cancelIdeationButton?.addEventListener("click", closeIdeationPanel);
  wizardCloseButton?.addEventListener("click", () => {
    closeWizard();
    history.pushState({ screen: "library" }, "", "#library");
  });

  courseForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void submitCourseForm();
  });

  ideationForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void startIdeation();
  });

  wizardReplyForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void submitWizardReply();
  });

  wizardAcceptButton.addEventListener("click", () => {
    void acceptWizardPlan();
  });

  wizardDiscardButton.addEventListener("click", () => {
    void discardDraftCourse(wizardCourseId);
  });

  wizardPanel.addEventListener("input", (event) => {
    const target = event.target;
    if (
      target === wizardTitleInput ||
      target === wizardDescriptionInput ||
      target?.dataset?.topicTitle === "true" ||
      target?.dataset?.topicSummary === "true"
    ) {
      wizardPlanDirty = true;
    }
  });

  backToLibraryButton?.addEventListener("click", showLibrary);
  for (const wordmark of wordmarks) {
    wordmark.addEventListener("click", (event) => {
      event.preventDefault();
      showLibrary();
    });
  }

  for (const button of statusButtons) {
    button.addEventListener("click", () => {
      setLibraryStatus(button.dataset.libraryStatus);
    });
  }

  window.addEventListener("popstate", applyRoute);
  window.addEventListener("hashchange", applyRoute);

  try {
    const libraryEvents = new EventSource("/api/events");
    const parsePayload = (event) => {
      try {
        return JSON.parse(event.data);
      } catch {
        return undefined;
      }
    };

    libraryEvents.addEventListener("courses", (event) => {
      applyCoursesPayload(parsePayload(event));
    });

    libraryEvents.addEventListener("harnesses", (event) => {
      const payload = parsePayload(event);
      harnesses = Array.isArray(payload)
        ? payload
        : Array.isArray(payload?.harnesses)
          ? payload.harnesses
          : harnesses;
      renderLibraryHarnessPicker(harnessSelect.value);
      renderSettingsHarnessPicker();
      renderOnboardingHarnesses();
    });

    const refreshFromCoursePayload = (event) => {
      const payload = parsePayload(event);
      if (payload?.courseId !== undefined) {
        queueLibraryCourseRefresh(payload.courseId);
      }
    };

    libraryEvents.addEventListener("tool-write", refreshFromCoursePayload);
    libraryEvents.addEventListener("message", refreshFromCoursePayload);
    libraryEvents.addEventListener("lesson", refreshFromCoursePayload);
    libraryEvents.addEventListener("topics", refreshFromCoursePayload);
    libraryEvents.addEventListener("mastery", refreshFromCoursePayload);
    libraryEvents.addEventListener("transcript", refreshFromCoursePayload);
  } catch {
    // Library stays usable through direct fetches if EventSource is unavailable.
  }

  renderLibraryHarnessPicker();
  renderSettingsHarnessPicker();
  renderOnboardingHarnesses();
  applyRoute();
})();
`;

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
const initialOrchestrated = __ORCHESTRATED__;
const initialHarnesses = __HARNESSES__;
const courseId = __COURSE_ID__;
const courseApiBase = "/api/courses/" + encodeURIComponent(String(courseId));
const courseDisplayTitle = __COURSE_TITLE__;
const REVIEW_WEAK_NAV_PATH = "overlearn:review-weak";
const enabledComposerLabel = "Message the agent…";
const disabledComposerLabel = "The agent is teaching — you can reply when it pauses";
const wrappingComposerLabel = "Session is wrapping up — the agent is writing the summary";
const endedComposerLabel = "Session ended — the daemon has stopped";

const topicSwitcher = document.querySelector("#topic-switcher");
const topicMenuButton = document.querySelector("#topic-menu-button");
const topicMenu = document.querySelector("#topic-menu");
const topicTitle = document.querySelector("#topic-title");
const topicProgress = document.querySelector("#topic-progress");
const harnessSelector = document.querySelector("#harness-selector");
const harnessMenuButton = document.querySelector("#harness-menu-button");
const harnessMenu = document.querySelector("#harness-menu");
const harnessSelectedName = document.querySelector("#harness-selected-name");
const harnessSelectedState = document.querySelector("#harness-selected-state");
const form = document.querySelector("#turn-form");
const textarea = document.querySelector("#message");
const submitButton = document.querySelector("#submit");
const statusLine = document.querySelector("#status");
const statusIndicator = document.querySelector("#status-line");
const typingIndicator = document.querySelector("#typing");
const doneLearningControl = document.querySelector("#done-learning-control");
const doneLearningButton = document.querySelector("#done-learning");
const doneConfirm = document.querySelector("#done-confirm");
const doneConfirmYes = document.querySelector("#done-confirm-yes");
const doneConfirmNo = document.querySelector("#done-confirm-no");
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
const sessionEndedBanner = document.querySelector("#session-ended");
const masterySummary = document.querySelector("#mastery-summary");
const lessonList = document.querySelector("#lesson-list");
const studyRail = document.querySelector("#study-rail");
const railToggle = document.querySelector("#rail-toggle");
const railBody = document.querySelector("#rail-body");
const railLessonDocument = document.querySelector("#rail-lesson-document");
const glossaryList = document.querySelector("#glossary-list");
const termCard = document.querySelector("#term-card");
const agentActivityElement = document.querySelector("#agent-activity");
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
let harnesses = [...initialHarnesses];
let activeFeynman = initialActiveFeynman;
let submittedFeynmanConcept = undefined;
let currentStatus = initialStatus;
let hasSeenWait = initialHasSeenWait;
let topicMenuOpen = false;
let harnessMenuOpen = false;
let harnessBusy = false;
let harnessSwitchNote = undefined;
let doneConfirmOpen = false;
let railOpen = false;
let activeRailTab = "lesson";
let lessonExpandedById = new Map();
let glossaryHighlightTimer = undefined;
let currentTermElement = undefined;
let hideTermCardTimer = undefined;
let eventsClosedIntentionally = false;
let lastAgentStreamTurn = undefined;
let lastAgentStreamSequence = undefined;
let agentActivityState = undefined;

const scrollTranscript = () => {
  transcript.scrollTop = transcript.scrollHeight;
};

const setTopicMenuOpen = (open, options = {}) => {
  topicMenuOpen = open;
  topicMenu.hidden = !open;
  topicMenuButton.setAttribute("aria-expanded", open ? "true" : "false");

  if (options.focusButton === true) {
    topicMenuButton.focus();
  }
};

const selectedHarness = () =>
  harnesses.find((harness) => harness.selected === true) ?? harnesses[0];

const harnessReady = (harness) =>
  harness.installed === true && harness.authenticated === true;

const harnessStateText = (harness) => {
  if (harness === undefined) {
    return "No harness";
  }

  if (!harness.installed) {
    return "not installed";
  }

  if (!harness.authenticated) {
    return "not logged in";
  }

  return harness.version === undefined ? "ready" : harness.version;
};

const harnessOptionLabel = (harness) => {
  if (harnessReady(harness)) {
    return harness.name + " ✓";
  }

  return harness.name + " — " + harnessStateText(harness);
};

const setHarnessMenuOpen = (open, options = {}) => {
  if (harnessMenu === null || harnessMenuButton === null) {
    return;
  }

  harnessMenuOpen = open;
  harnessMenu.hidden = !open;
  harnessMenuButton.setAttribute("aria-expanded", open ? "true" : "false");

  if (options.focusButton === true) {
    harnessMenuButton.focus();
  }
};

const renderHarnessSelector = () => {
  if (
    harnessSelector === null ||
    harnessMenu === null ||
    harnessSelectedName === null ||
    harnessSelectedState === null
  ) {
    return;
  }

  harnessSelector.hidden = !initialOrchestrated;
  const selected = selectedHarness();
  harnessSelectedName.textContent = selected?.name ?? "Harness";
  harnessSelectedState.textContent = harnessStateText(selected);
  harnessMenu.replaceChildren();

  for (const harness of harnesses) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "harness-option" + (harness.selected ? " selected" : "");
    button.dataset.harnessId = harness.id;
    button.disabled = harnessBusy || !harnessReady(harness);
    button.title = harnessReady(harness)
      ? harness.name
      : !harness.installed
        ? harness.name + " is not installed."
        : "Log in to " + harness.name + " from your terminal.";

    const label = document.createElement("span");
    label.className = "harness-option-label";
    label.textContent = harnessOptionLabel(harness);

    const state = document.createElement("span");
    state.className = "harness-option-state";
    state.textContent = harness.selected ? "selected" : harnessStateText(harness);

    button.append(label, state);
    button.addEventListener("click", () => {
      void selectHarness(harness.id);
    });
    harnessMenu.append(button);
  }
};

const refreshHarnesses = async (refresh = false) => {
  if (!initialOrchestrated) {
    return;
  }

  const harnessQuery = "?courseId=" + encodeURIComponent(String(courseId)) + (refresh ? "&refresh=1" : "");
  const response = await fetch("/api/harnesses" + harnessQuery);
  if (!response.ok) {
    return;
  }

  harnesses = [...await response.json()];
  renderHarnessSelector();
};

const selectHarness = async (id) => {
  if (harnessBusy) {
    return;
  }

  harnessBusy = true;
  renderHarnessSelector();

  const response = await fetch(courseApiBase + "/harness", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id }),
  });

  harnessBusy = false;
  if (!response.ok) {
    statusLine.textContent = await response.text();
    renderHarnessSelector();
    return;
  }

  setHarnessMenuOpen(false, { focusButton: true });
  renderHarnessSelector();
};

const setDoneConfirmOpen = (open, options = {}) => {
  doneConfirmOpen = open;
  doneConfirm.hidden = !open;
  doneLearningButton.setAttribute("aria-expanded", open ? "true" : "false");

  if (options.focusButton === true) {
    doneLearningButton.focus();
  }

  if (open) {
    doneConfirmYes.focus();
  }
};

const renderDoneLearningControl = () => {
  if (currentStatus === "wrapping-up") {
    setDoneConfirmOpen(false);
    doneLearningButton.disabled = true;
    doneLearningButton.textContent = "Wrapping up…";
    doneLearningButton.setAttribute("aria-label", "Session is wrapping up");
    return;
  }

  if (currentStatus === "session-ended") {
    setDoneConfirmOpen(false);
    doneLearningButton.disabled = true;
    doneLearningButton.textContent = "Session ended";
    doneLearningButton.setAttribute("aria-label", "Session ended");
    return;
  }

  doneLearningButton.disabled = false;
  doneLearningButton.textContent = "Done Learning";
  doneLearningButton.setAttribute("aria-label", "Done Learning");
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

const topicHeaderTitle = () => findCurrentTopic()?.title ?? courseDisplayTitle;

const masteryProgressText = () => {
  const total = topicCount();
  const records = topicMasteryRecords();
  const weakest = weakestTopicMastery();

  return (
    records.length +
    "/" +
    total +
    (weakest === undefined ? "" : " · " + weakest.entry.score)
  );
};

const updateTopicHeader = () => {
  topicTitle.textContent = topicHeaderTitle();
  const progress = masteryProgressText();
  topicProgress.textContent = progress;
  topicProgress.setAttribute("aria-label", "Mastery progress " + progress);
};

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
    setTopicMenuOpen(false);
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

  const response = await fetch(courseApiBase + "/nav", {
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
  setTopicMenuOpen(false);
  await submitNav(topic.path);
};

const selectLesson = (lessonId) => {
  userPinnedLesson = true;
  selectedLessonId = lessonId;
  selectedTopicPath = findTopicForLesson(lessonId)?.path;
  userPinnedTopic = selectedTopicPath !== undefined;
  renderNavigation();
  setTopicMenuOpen(false);
  setActiveRailTab("lesson");
  requestAnimationFrame(() => {
    document.getElementById("rail-lesson-" + lessonId)?.scrollIntoView({
      block: "start",
    });
  });
};

const openDemo = (file) => {
  window.open(courseApiBase + "/demos/" + encodeURIComponent(file), "_blank", "noopener");
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
    setTopicMenuOpen(false);
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
  updateTopicHeader();

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

const truncateInline = (value, maxLength = 84) => {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length <= maxLength
    ? collapsed
    : collapsed.slice(0, maxLength - 1).trimEnd() + "…";
};

const ensureAgentActivity = (turn) => {
  if (agentActivityState === undefined || agentActivityState.turn !== turn) {
    agentActivityState = {
      turn,
      thinking: "",
      text: "",
      tools: new Map(),
      permissions: [],
      latest: undefined,
    };
  }

  return agentActivityState;
};

const clearAgentActivity = () => {
  agentActivityState = undefined;
  renderAgentActivity();
};

const toolStatusLabel = (status) => {
  if (status === "delta") {
    return "running";
  }

  return status;
};

const agentActivitySummary = () => {
  if (agentActivityState === undefined) {
    return undefined;
  }

  return agentActivityState.latest;
};

const createAgentActivityLine = (className, labelText, detailText) => {
  const line = document.createElement("div");
  line.className = className;

  const label = document.createElement("span");
  label.className = "activity-line-label";
  label.textContent = labelText;

  const detail = document.createElement("span");
  detail.className = "activity-line-detail";
  detail.textContent = detailText;

  line.append(label, detail);
  return line;
};

const renderAgentActivity = () => {
  if (agentActivityElement === null) {
    return;
  }

  agentActivityElement.replaceChildren();
  const state = agentActivityState;
  if (state === undefined) {
    agentActivityElement.hidden = true;
    statusLine.textContent = statusText(currentStatus);
    return;
  }

  agentActivityElement.hidden = false;
  agentActivityElement.className = "entry agent-activity";

  const header = document.createElement("div");
  header.className = "agent-activity-header";

  const title = document.createElement("div");
  title.className = "agent-activity-title";
  title.textContent = "Agent activity";

  const meta = document.createElement("div");
  meta.className = "agent-activity-meta";
  meta.textContent = "turn " + state.turn;

  header.append(title, meta);
  agentActivityElement.append(header);

  if (state.thinking.length > 0) {
    const details = document.createElement("details");
    details.className = "activity-thinking";

    const summary = document.createElement("summary");
    summary.textContent = "Thinking · " + truncateInline(state.thinking, 72);

    const body = document.createElement("pre");
    body.textContent = state.thinking;

    details.append(summary, body);
    agentActivityElement.append(details);
  }

  if (state.text.length > 0) {
    const bubble = document.createElement("div");
    bubble.className = "activity-message";
    bubble.textContent = state.text;
    agentActivityElement.append(bubble);
  }

  if (state.tools.size > 0) {
    const list = document.createElement("div");
    list.className = "activity-lines";
    for (const tool of state.tools.values()) {
      const name = tool.name ?? tool.id;
      const detail =
        tool.text === undefined || tool.text.length === 0
          ? toolStatusLabel(tool.status)
          : toolStatusLabel(tool.status) + " · " + truncateInline(tool.text, 64);
      list.append(createAgentActivityLine("activity-line tool", name, detail));
    }
    agentActivityElement.append(list);
  }

  if (state.permissions.length > 0) {
    const list = document.createElement("div");
    list.className = "activity-lines";
    for (const permission of state.permissions) {
      const decision = permission.decision.allowed ? "allowed" : "denied";
      const resource =
        permission.request.resource === undefined
          ? "no resource"
          : permission.request.resource;
      list.append(
        createAgentActivityLine(
          "activity-line permission",
          permission.request.action,
          resource + " · " + decision,
        ),
      );
    }
    agentActivityElement.append(list);
  }

  statusLine.textContent = statusText(currentStatus);
};

const applyAgentStream = (payload) => {
  if (typeof payload.turn !== "number" || typeof payload.sequence !== "number") {
    return;
  }

  if (
    lastAgentStreamTurn !== undefined &&
    (payload.turn < lastAgentStreamTurn ||
      (payload.turn === lastAgentStreamTurn &&
        payload.sequence <= lastAgentStreamSequence))
  ) {
    return;
  }

  harnessSwitchNote = undefined;
  lastAgentStreamTurn = payload.turn;
  lastAgentStreamSequence = payload.sequence;

  const event = payload.event;
  if (event === undefined || typeof event.type !== "string") {
    return;
  }

  if (event.type === "done" || event.type === "error") {
    clearAgentActivity();
    return;
  }

  const stick = transcriptNearBottom();
  const state = ensureAgentActivity(payload.turn);

  if (event.type === "thinking" && typeof event.text === "string") {
    state.thinking += event.text;
    state.latest = "thinking: " + truncateInline(event.text);
  }

  if (event.type === "text" && typeof event.text === "string") {
    state.text += event.text;
    state.latest = truncateInline(event.text);
  }

  if (event.type === "tool-call" && typeof event.id === "string") {
    const existing = state.tools.get(event.id) ?? {
      id: event.id,
      name: undefined,
      status: "started",
      text: "",
    };
    const text =
      typeof event.text === "string" && event.text.length > 0
        ? event.text
        : existing.text;
    const tool = {
      id: event.id,
      name: typeof event.name === "string" ? event.name : existing.name,
      status: event.status ?? existing.status,
      text,
    };
    state.tools.set(event.id, tool);
    state.latest =
      "tool: " + (tool.name ?? tool.id) + " " + toolStatusLabel(tool.status);
  }

  if (
    event.type === "permission-request" &&
    event.request !== undefined &&
    event.decision !== undefined
  ) {
    state.permissions.push({
      request: event.request,
      decision: event.decision,
    });
    state.latest =
      "permission: " +
      event.request.action +
      " " +
      (event.decision.allowed ? "allowed" : "denied");
  }

  renderAgentActivity();
  if (stick) {
    scrollTranscript();
  }
};

const renderTranscript = (options = {}) => {
  hideTermCard();
  transcript.replaceChildren();
  const latestLessonId = latestLessonEntryId();
  for (const entry of transcriptEntries) {
    transcript.append(createEntryElement(entry, latestLessonId));
  }
  if (agentActivityElement !== null) {
    transcript.append(agentActivityElement);
    renderAgentActivity();
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
  const learnerReady =
    currentStatus === "waiting-for-agent" || currentStatus === "agent-failed";
  const canSubmit =
    activeFeynman !== undefined &&
    learnerReady &&
    feynmanTextarea.value.trim().length > 0;

  feynmanTextarea.disabled =
    activeFeynman === undefined || !learnerReady;
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

const statusText = (status) => {
  if (harnessSwitchNote !== undefined && agentActivitySummary() === undefined) {
    return harnessSwitchNote;
  }

  if (status === "waiting-for-agent") {
    return "Your turn — the agent is waiting";
  }

  if (status === "agent-failed") {
    return "Agent failed — you can submit again";
  }

  if (status === "wrapping-up") {
    return "Agent is writing your wrap-up";
  }

  if (status === "session-ended") {
    return endedComposerLabel;
  }

  const activity = agentActivitySummary();
  if (activity !== undefined && activity.length > 0) {
    return "Agent is working… " + activity;
  }

  return hasSeenWait ? "Agent is working…" : "Waiting for the agent to start teaching";
};

const composerLabelForStatus = (status) => {
  if (status === "waiting-for-agent") {
    return enabledComposerLabel;
  }

  if (status === "agent-failed") {
    return enabledComposerLabel;
  }

  if (status === "wrapping-up") {
    return wrappingComposerLabel;
  }

  if (status === "session-ended") {
    return endedComposerLabel;
  }

  return disabledComposerLabel;
};

const applyComposerLabel = (status) => {
  const label = composerLabelForStatus(status);
  textarea.placeholder = label;
  textarea.setAttribute("aria-label", label);
};

const applyStatus = (status, nextHasSeenWait = hasSeenWait) => {
  currentStatus = status;
  hasSeenWait = nextHasSeenWait;
  const waiting = status === "waiting-for-agent" || status === "agent-failed";
  const ended = status === "session-ended";
  const failed = status === "agent-failed";
  const working = status === "agent-working" || status === "wrapping-up";
  statusLine.textContent = statusText(status);
  statusIndicator.classList.toggle("working", working);
  statusIndicator.classList.toggle("ended", ended);
  statusIndicator.classList.toggle("failed", failed);
  typingIndicator.hidden = waiting || ended;
  sessionEndedBanner.hidden = !ended;
  applyComposerLabel(status);
  textarea.disabled = !waiting;
  submitButton.disabled = !waiting || textarea.value.trim().length === 0;
  setFeynmanControls();
  renderDoneLearningControl();

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

  const response = await fetch(courseApiBase + "/submit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });

  if (!response.ok) {
    statusLine.textContent = await response.text();
    applyStatus("waiting-for-agent");
  }
};

const submitDoneLearning = async () => {
  if (doneLearningButton.disabled) {
    return;
  }

  setDoneConfirmOpen(false);
  applyStatus("wrapping-up", hasSeenWait);

  const response = await fetch(courseApiBase + "/done", { method: "POST" });

  if (!response.ok) {
    const message = await response.text();
    applyStatus("waiting-for-agent", hasSeenWait);
    statusLine.textContent = message;
  }
};

const submitFeynmanAnswer = async () => {
  const check = activeFeynman;
  const text = feynmanTextarea.value.trim();
  if (check === undefined || text.length === 0 || feynmanTextarea.disabled) {
    return;
  }

  applyStatus("agent-working");

  const response = await fetch(courseApiBase + "/feynman-answer", {
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

renderHarnessSelector();
void refreshHarnesses();
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

doneLearningButton.addEventListener("click", () => {
  if (doneLearningButton.disabled) {
    return;
  }

  setDoneConfirmOpen(!doneConfirmOpen);
});

doneConfirmYes.addEventListener("click", () => {
  void submitDoneLearning();
});

doneConfirmNo.addEventListener("click", () => {
  setDoneConfirmOpen(false, { focusButton: true });
});

topicMenuButton.addEventListener("click", () => {
  setTopicMenuOpen(!topicMenuOpen);
});

harnessMenuButton?.addEventListener("click", () => {
  setHarnessMenuOpen(!harnessMenuOpen);
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") {
    return;
  }

  if (topicMenuOpen) {
    setTopicMenuOpen(false, { focusButton: true });
  }

  if (harnessMenuOpen) {
    setHarnessMenuOpen(false, { focusButton: true });
  }

  if (doneConfirmOpen) {
    setDoneConfirmOpen(false, { focusButton: true });
  }
});

document.addEventListener("click", (event) => {
  if (
    !topicMenuOpen ||
    !(event.target instanceof Node) ||
    topicSwitcher.contains(event.target)
  ) {
    return;
  }

  setTopicMenuOpen(false);
});

document.addEventListener("click", (event) => {
  if (
    !harnessMenuOpen ||
    harnessSelector === null ||
    !(event.target instanceof Node) ||
    harnessSelector.contains(event.target)
  ) {
    return;
  }

  setHarnessMenuOpen(false);
});

document.addEventListener("click", (event) => {
  if (
    !doneConfirmOpen ||
    !(event.target instanceof Node) ||
    doneLearningControl.contains(event.target)
  ) {
    return;
  }

  setDoneConfirmOpen(false);
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
const payloadForThisCourse = (event) => {
  const payload = JSON.parse(event.data);
  if (payload.courseId !== undefined && payload.courseId !== courseId) {
    return undefined;
  }

  return payload;
};

events.addEventListener("status", (event) => {
  const payload = payloadForThisCourse(event);
  if (payload === undefined) return;
  applyStatus(payload.status, payload.hasSeenWait ?? hasSeenWait);
  if (payload.status === "agent-failed" && payload.message !== undefined) {
    statusLine.textContent = payload.message;
  }

  if (payload.status === "session-ended") {
    eventsClosedIntentionally = true;
    events.close();
  }
});
events.addEventListener("harnesses", (event) => {
  const payload = payloadForThisCourse(event);
  if (payload === undefined) return;
  const nextHarnesses = Array.isArray(payload) ? payload : payload.harnesses;
  if (!Array.isArray(nextHarnesses)) {
    return;
  }

  harnesses = [...nextHarnesses];
  const selected = selectedHarness();
  if (!Array.isArray(payload) && payload.switched === true && selected !== undefined) {
    harnessSwitchNote = "Switched to " + selected.name;
    statusLine.textContent = harnessSwitchNote;
  }

  renderHarnessSelector();
});
events.addEventListener("message", (event) => {
  const payload = payloadForThisCourse(event);
  if (payload !== undefined) appendEntry(payload.entry ?? payload);
});
events.addEventListener("lesson", (event) => {
  const payload = payloadForThisCourse(event);
  if (payload !== undefined) applyLessonEvent(payload.event ?? payload);
});
events.addEventListener("glossary", (event) => {
  const payload = payloadForThisCourse(event);
  if (payload === undefined) return;
  glossary = [...payload.entries];
  renderGlossaryList();

  if (currentTermElement !== undefined) {
    showTermCard(currentTermElement);
  }
});
events.addEventListener("topics", (event) => {
  const payload = payloadForThisCourse(event);
  if (payload === undefined) return;
  topics = [...payload.topics];
  unassignedDemos = [...(payload.unassignedDemos ?? [])];
  userPinnedTopic = false;
  userPinnedLesson = false;
  renderNavigation();
});
events.addEventListener("mastery", (event) => {
  const payload = payloadForThisCourse(event);
  if (payload === undefined) return;
  masteryScores = [...payload.entries];
  renderNavigation();
});
events.addEventListener("feynman", (event) => {
  const payload = payloadForThisCourse(event);
  if (payload === undefined) return;
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
  const payload = payloadForThisCourse(event);
  if (payload === undefined) return;
  const stick = transcriptNearBottom();
  transcriptEntries = [...payload.entries];
  renderTranscript({ stick });
});
events.addEventListener("agent-stream", (event) => {
  const payload = payloadForThisCourse(event);
  if (payload !== undefined) applyAgentStream(payload);
});
events.addEventListener("error", () => {
  if (eventsClosedIntentionally || currentStatus === "session-ended") {
    return;
  }
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
  courseId: number | undefined,
): RenderedTranscriptEntry => {
  const demoOptions = {
    demoFiles,
    ...(courseId === undefined
      ? {}
      : {
          resolveDemoHref: (file: string) =>
            `/api/courses/${courseId}/demos/${encodeURIComponent(file)}`,
        }),
  };

  if (entry.kind === "demo") {
    return {
      ...entry,
      html: renderDemoEmbed(entry.file, entry.title, demoOptions),
    };
  }

  if (entry.kind === undefined || entry.kind === "text") {
    return {
      ...entry,
      html: renderMarkdown(entry.text, { glossary, ...demoOptions }),
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
      html: renderMarkdown(entry.prompt, { glossary, ...demoOptions }),
    };
  }

  return {
    ...entry,
    html: renderMarkdown(entry.text, { glossary, ...demoOptions }),
  };
};

const renderTranscript = (
  transcript: readonly TranscriptEntry[],
  glossary: readonly GlossaryEntry[],
  demoFiles: ReadonlySet<string>,
  lessons: LessonSnapshot,
  courseId: number | undefined,
): readonly RenderedTranscriptEntry[] =>
  transcript.map((entry) =>
    renderTranscriptEntry(entry, glossary, demoFiles, lessons, courseId),
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

const masteryProgressText = (
  topics: readonly TopicNode[],
  scores: readonly MasteryEntry[],
): string => {
  const total = topicCount(topics);
  const records = topicMasteryRecords(topics, scores);
  const weakest = [...records].sort(compareWeakestRecord)[0];

  return `${records.length}/${total}${
    weakest === undefined ? "" : ` · ${weakest.entry.score}`
  }`;
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

const selectedHarness = (
  harnesses: readonly HarnessUiOption[],
): HarnessUiOption | undefined =>
  harnesses.find((harness) => harness.selected) ?? harnesses[0];

const harnessReady = (harness: HarnessUiOption): boolean =>
  harness.installed && harness.authenticated;

const harnessStateText = (harness: HarnessUiOption | undefined): string => {
  if (harness === undefined) {
    return "No harness";
  }

  if (!harness.installed) {
    return "not installed";
  }

  if (!harness.authenticated) {
    return "not logged in";
  }

  return harness.version ?? "ready";
};

const harnessOptionLabel = (harness: HarnessUiOption): string =>
  harnessReady(harness)
    ? `${harness.name} ✓`
    : `${harness.name} — ${harnessStateText(harness)}`;

const harnessOptionTitle = (harness: HarnessUiOption): string => {
  if (harnessReady(harness)) {
    return harness.name;
  }

  return harness.installed
    ? `Log in to ${harness.name} from your terminal.`
    : `${harness.name} is not installed.`;
};

const renderHarnessOptions = (harnesses: readonly HarnessUiOption[]): string =>
  harnesses
    .map((harness) => {
      const selectedClass = harness.selected ? " selected" : "";
      const disabled = harnessReady(harness) ? "" : " disabled";
      const state = harness.selected ? "selected" : harnessStateText(harness);

      return `<button class="harness-option${selectedClass}" type="button" data-harness-id="${escapeHtml(
        harness.id,
      )}" title="${escapeHtml(harnessOptionTitle(harness))}"${disabled}><span class="harness-option-label">${escapeHtml(
        harnessOptionLabel(harness),
      )}</span><span class="harness-option-state">${escapeHtml(
        state,
      )}</span></button>`;
    })
    .join("");

const onboardingHarnessState = (harness: HarnessUiOption): string => {
  if (!harness.installed) {
    return "not-installed";
  }

  return harness.authenticated ? "ready" : "installed-unauthenticated";
};

const renderCommandRow = (command: string): string =>
  command.length === 0
    ? ""
    : `<div class="onboarding-command-row"><code>${escapeHtml(
        command,
      )}</code><button class="library-button secondary" type="button">Copy</button></div>`;

const renderOnboardingHarnessCards = (
  harnesses: readonly HarnessUiOption[],
): string =>
  harnesses
    .map((harness) => {
      const state = onboardingHarnessState(harness);
      const badge =
        state === "ready"
          ? "ready"
          : state === "installed-unauthenticated"
            ? "not logged in"
            : "not installed";
      const body =
        state === "ready"
          ? "Installed and authenticated."
          : state === "installed-unauthenticated"
            ? "Installed, but Overlearn did not find local auth."
            : "Overlearn did not find the agent command on PATH.";
      const selectButton =
        state !== "ready"
          ? ""
          : `<button class="library-button primary" type="button" data-onboarding-select-harness="${escapeHtml(
              harness.id,
            )}"${harness.selected ? " disabled" : ""}>${
              harness.selected ? "Preferred" : "Use as preferred"
            }</button>`;
      const loginCommand = harness.login?.command ?? "";
      const loginButton =
        state === "installed-unauthenticated"
          ? '<button class="library-button primary" type="button">Log in</button>'
          : "";
      const installCommand = harness.install?.command ?? "";
      const installDocs =
        state === "not-installed" && harness.install?.docsUrl !== undefined
          ? `<a class="onboarding-docs-link" href="${escapeHtml(
              harness.install.docsUrl,
            )}" target="_blank" rel="noreferrer">Docs</a>`
          : "";
      const command =
        state === "installed-unauthenticated"
          ? renderCommandRow(loginCommand)
          : state === "not-installed"
            ? renderCommandRow(installCommand)
            : "";

      return `<article class="onboarding-harness-card" data-harness-id="${escapeHtml(
        harness.id,
      )}" data-harness-state="${state}"><div class="onboarding-harness-header"><h3>${escapeHtml(
        harness.name,
      )}</h3><span class="course-status-badge">${badge}</span></div><p>${body}</p>${command}<div class="library-form-actions">${selectButton}${loginButton}${installDocs}<button class="library-button secondary" type="button">Re-check</button></div><p class="onboarding-card-status"></p></article>`;
    })
    .join("");

const renderStatusText = (
  status: UiRenderStatus,
  hasSeenWait: boolean,
): string => {
  if (status === "waiting-for-agent") {
    return "Your turn — the agent is waiting";
  }

  if (status === "agent-failed") {
    return "Agent failed — you can submit again";
  }

  if (status === "wrapping-up") {
    return "Agent is writing your wrap-up";
  }

  if (status === "session-ended") {
    return "Session ended — the daemon has stopped";
  }

  return hasSeenWait
    ? "Agent is working…"
    : "Waiting for the agent to start teaching";
};

const composerLabel = (status: UiRenderStatus): string => {
  if (status === "waiting-for-agent") {
    return "Message the agent…";
  }

  if (status === "agent-failed") {
    return "Message the agent…";
  }

  if (status === "wrapping-up") {
    return "Session is wrapping up — the agent is writing the summary";
  }

  if (status === "session-ended") {
    return "Session ended — the daemon has stopped";
  }

  return "The agent is teaching — you can reply when it pauses";
};

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
  options: RenderPageOptions = {},
): string => {
  const working = status === "agent-working" || status === "wrapping-up";
  const ended = status === "session-ended";
  const failed = status === "agent-failed";
  const statusLineClass = [
    "status-line",
    ...(working ? ["working"] : []),
    ...(ended ? ["ended"] : []),
    ...(failed ? ["failed"] : []),
  ].join(" ");
  const typingHidden = working ? "" : " hidden";
  const composerDisabled =
    status === "waiting-for-agent" || status === "agent-failed"
      ? ""
      : " disabled";
  const composerPlaceholder = composerLabel(status);
  const sessionEndedHidden = ended ? "" : " hidden";
  const doneButtonDisabled =
    status === "wrapping-up" || status === "session-ended" ? " disabled" : "";
  const doneButtonLabel =
    status === "wrapping-up"
      ? "Wrapping up…"
      : status === "session-ended"
        ? "Session ended"
        : "Done Learning";
  const orchestrated = options.orchestrated === true;
  const harnesses = options.harnesses ?? [];
  const hasReadyHarness = harnesses.some(harnessReady);
  const dataDir = options.dataDir ?? options.profile?.dataDir ?? "";
  const profile =
    options.profile ??
    ({
      name: null,
      onboardingState: "done",
      settings: {},
      preferredHarness: null,
      dataDir,
    } satisfies ProfileUi);
  const onboardingState =
    options.onboardingState ?? profile.onboardingState ?? "done";
  const onboardingHidden = onboardingState === "done" ? " hidden" : "";
  const libraryHidden =
    onboardingState === "done" && options.courseId === undefined ? "" : " hidden";
  const courseViewHidden =
    onboardingState === "done" && options.courseId !== undefined ? "" : " hidden";
  const selectedHarnessOption = selectedHarness(harnesses);
  const harnessHidden = orchestrated ? "" : " hidden";
  const agentActivitySkeleton = orchestrated
    ? '<article id="agent-activity" class="entry agent-activity" hidden></article>'
    : "";
  const currentHeaderTopic = currentTopic(topics);
  const headerTopicTitle = currentHeaderTopic?.title ?? courseTitle;
  const headerProgress = masteryProgressText(topics, masteryScores);
  const renderedTranscript = renderTranscript(
    transcript,
    glossary,
    demoFiles,
    lessons,
    options.courseId,
  );
  const libraryScript = libraryClientScript.replace(
    "__LIBRARY_COURSE_ID__",
    escapeScriptJson(options.courseId ?? null),
  )
    .replace("__ONBOARDING_STATE__", escapeScriptJson(onboardingState))
    .replace("__PROFILE__", escapeScriptJson(profile))
    .replace("__DATA_DIR__", escapeScriptJson(dataDir));
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
    .replace("__COURSE_TITLE__", escapeScriptJson(courseTitle))
    .replace(
      "__ACTIVE_FEYNMAN__",
      escapeScriptJson(activeFeynmanCheck ?? null),
    )
    .replace("__STATUS__", escapeScriptJson(status))
    .replace("__HAS_SEEN_WAIT__", escapeScriptJson(hasSeenWait))
    .replace("__ORCHESTRATED__", escapeScriptJson(options.orchestrated === true))
    .replace("__COURSE_ID__", escapeScriptJson(options.courseId ?? null))
    .replace("__HARNESSES__", escapeScriptJson(options.harnesses ?? []));

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

    body.library-open {
      height: auto;
      min-height: 100dvh;
      overflow: auto;
    }

    .topic-menu,
    .lesson-content,
    .rail-panel,
    .rail-body,
    .library-course-form textarea,
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

    .shell.library-mode {
      display: block;
      min-height: 100dvh;
      height: auto;
      width: min(100%, 76rem);
    }

    .library-screen {
      display: grid;
      gap: 1rem;
      padding-bottom: 2rem;
    }

    .library-header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 1rem;
      border-bottom: 1px solid var(--border);
      padding-bottom: 1rem;
    }

    .library-heading {
      display: flex;
      align-items: flex-start;
      gap: 1rem;
      min-width: 0;
    }

    .library-heading .wordmark {
      flex: 0 0 auto;
      margin-top: 0.35rem;
    }

    .library-heading h1 {
      margin: 0;
      font-size: 1.55rem;
      line-height: 1.2;
    }

    .library-status,
    .library-form-status,
    .library-notice {
      margin: 0.35rem 0 0;
      color: var(--muted);
      line-height: 1.45;
    }

    .library-actions,
    .library-form-actions,
    .course-card-actions {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.5rem;
    }

    .library-button,
    .back-to-library,
    .library-tab {
      min-height: 2.35rem;
      border: 1px solid var(--border-surface);
      border-radius: 8px;
      background: var(--surface);
      color: var(--secondary);
      padding: 0 0.75rem;
      font: inherit;
      font-size: 0.9rem;
      font-weight: 600;
      cursor: pointer;
      text-decoration: none;
      white-space: nowrap;
    }

    .library-button:hover,
    .back-to-library:hover,
    .library-tab:hover,
    .library-tab.active {
      border-color: var(--accent-border);
      background: var(--accent-hover-bg);
      color: var(--text);
    }

    .library-button.primary {
      border-color: var(--accent-strong);
      background: var(--accent-strong);
      color: var(--on-accent);
    }

    .library-button.secondary,
    .library-button.ghost {
      background: var(--surface);
    }

    .library-button.danger {
      border-color: var(--border-surface);
      background: var(--surface);
      color: var(--bad-text);
    }

    .library-button:disabled {
      border-color: var(--border-surface);
      background: var(--surface);
      color: var(--disabled);
      cursor: not-allowed;
    }

    .back-to-library {
      min-height: 2rem;
      padding: 0 0.6rem;
      font-size: 0.82rem;
    }

    .library-notice,
    .library-form-panel,
    .library-empty,
    .course-card {
      border: 1px solid var(--border-surface);
      border-radius: 8px;
      background: var(--surface);
    }

    .library-notice {
      padding: 0.75rem 0.85rem;
    }

    .library-form-panel {
      display: grid;
      gap: 0.85rem;
      padding: 1rem;
    }

    .library-form-heading {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 1rem;
    }

    .library-form-heading h2 {
      font-size: 1.05rem;
    }

    .library-course-form {
      display: grid;
      grid-template-columns: minmax(8rem, 11rem) minmax(0, 1fr);
      align-items: start;
      gap: 0.65rem 0.85rem;
    }

    .library-course-form label {
      color: var(--secondary);
      font-size: 0.9rem;
      font-weight: 600;
      line-height: 2.35rem;
    }

    .library-course-form input,
    .library-course-form select,
    .library-course-form textarea {
      width: 100%;
      min-height: 2.35rem;
      border: 1px solid var(--border-strong);
      border-radius: 8px;
      background: var(--card);
      color: var(--text);
      padding: 0.55rem 0.65rem;
      font: inherit;
      line-height: 1.45;
    }

    .library-course-form textarea {
      resize: vertical;
    }

    .library-course-form input:focus-visible,
    .library-course-form select:focus-visible,
    .library-course-form textarea:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 0;
    }

    .library-form-actions {
      grid-column: 2;
    }

    .library-section-heading {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 1rem;
      margin-bottom: 0.65rem;
    }

    .library-section-heading h2,
    .course-wizard-panel h2,
    .plan-review-heading h3 {
      margin: 0;
      color: var(--heading);
      font-size: 1.05rem;
      font-weight: 600;
    }

    .drafts-section {
      display: grid;
      gap: 0.65rem;
    }

    .course-wizard-panel {
      display: grid;
      gap: 0.85rem;
      border: 1px solid var(--border-surface);
      border-radius: 8px;
      background: var(--surface);
      padding: 1rem;
    }

    .course-wizard-layout {
      display: grid;
      grid-template-columns: minmax(0, 18rem) minmax(0, 1fr);
      gap: 1rem;
      align-items: start;
    }

    .wizard-conversation,
    .plan-review-screen {
      display: grid;
      gap: 0.75rem;
      min-width: 0;
    }

    .wizard-transcript {
      display: grid;
      gap: 0.55rem;
      max-height: 24rem;
      overflow-y: auto;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--card);
      padding: 0.75rem;
    }

    .wizard-message {
      display: grid;
      gap: 0.2rem;
      border-left: 3px solid var(--border-strong);
      padding-left: 0.65rem;
    }

    .wizard-message.agent {
      border-left-color: var(--accent-strong);
    }

    .wizard-message strong {
      color: var(--heading);
      font-size: 0.82rem;
      font-weight: 700;
    }

    .wizard-message p {
      margin: 0;
      color: var(--secondary);
      line-height: 1.45;
      overflow-wrap: anywhere;
    }

    .wizard-reply-form {
      display: grid;
      gap: 0.5rem;
    }

    .wizard-reply-form label,
    .plan-review-screen label,
    .plan-topic-editor label {
      color: var(--secondary);
      font-size: 0.9rem;
      font-weight: 700;
    }

    .wizard-reply-form textarea,
    .plan-review-screen input,
    .plan-review-screen textarea,
    .plan-topic-editor input,
    .plan-topic-editor textarea {
      width: 100%;
      min-height: 2.35rem;
      border: 1px solid var(--border-strong);
      border-radius: 8px;
      background: var(--card);
      color: var(--text);
      padding: 0.55rem 0.65rem;
      font: inherit;
      line-height: 1.45;
    }

    .wizard-reply-form textarea,
    .plan-review-screen textarea,
    .plan-topic-editor textarea {
      resize: vertical;
    }

    .plan-review-heading {
      display: grid;
      gap: 0.2rem;
      margin-top: 0.25rem;
    }

    .plan-review-heading p {
      margin: 0;
      color: var(--muted);
      line-height: 1.45;
    }

    .wizard-topic-tree,
    .plan-topic-children {
      display: grid;
      gap: 0.65rem;
    }

    .plan-topic-editor {
      display: grid;
      gap: 0.5rem;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--card);
      padding: 0.75rem;
    }

    .plan-topic-row {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr) auto;
      gap: 0.5rem;
      align-items: center;
    }

    .plan-topic-children {
      padding-left: 0.8rem;
      border-left: 1px solid var(--border);
    }

    .library-tabs {
      display: flex;
      gap: 0.45rem;
      overflow-x: auto;
      padding-bottom: 0.1rem;
    }

    .course-card-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(min(100%, 22rem), 1fr));
      gap: 0.85rem;
    }

    .course-card {
      display: grid;
      gap: 0.9rem;
      padding: 1rem;
    }

    .course-card-header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 0.85rem;
      min-width: 0;
    }

    .course-card-title-group {
      display: grid;
      gap: 0.35rem;
      min-width: 0;
    }

    .course-card h3 {
      margin: 0;
      color: var(--heading);
      font-size: 1.05rem;
      font-weight: 600;
      line-height: 1.3;
      overflow-wrap: anywhere;
    }

    .course-card p {
      margin: 0;
      color: var(--muted);
      line-height: 1.45;
      overflow-wrap: anywhere;
    }

    .course-status-badge {
      flex: 0 0 auto;
      border: 1px solid var(--accent-border);
      border-radius: 999px;
      color: var(--accent-soft-text);
      padding: 0.14rem 0.45rem;
      font-size: 0.78rem;
      font-weight: 700;
      line-height: 1.35;
    }

    .course-card-stats {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      border-top: 1px solid var(--border);
      border-bottom: 1px solid var(--border);
    }

    .course-card-stat {
      display: grid;
      gap: 0.2rem;
      min-width: 0;
      padding: 0.7rem 0.65rem;
    }

    .course-card-stat:first-child {
      padding-left: 0;
    }

    .course-card-stat + .course-card-stat {
      border-left: 1px solid var(--border);
    }

    .course-card-stat-label {
      color: var(--faint);
      font-size: 0.76rem;
      font-weight: 700;
    }

    .course-card-stat-value {
      min-width: 0;
      overflow: hidden;
      color: var(--secondary);
      font-size: 0.88rem;
      font-weight: 600;
      line-height: 1.35;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .library-empty {
      display: grid;
      gap: 0.4rem;
      padding: 1rem;
      color: var(--muted);
    }

    .library-empty h3,
    .library-empty p {
      margin: 0;
    }

    .library-empty h3 {
      color: var(--heading);
      font-size: 1.05rem;
      font-weight: 600;
    }

    .onboarding-screen,
    .settings-screen {
      display: grid;
      gap: 1rem;
      width: min(100%, 52rem);
      margin: 0 auto;
      padding: 1rem 0 2rem;
    }

    .onboarding-panel {
      display: grid;
      gap: 0.85rem;
      border: 1px solid var(--border-surface);
      border-radius: 8px;
      background: var(--surface);
      padding: 1.25rem;
    }

    .onboarding-kicker {
      margin: 0;
      color: var(--accent-soft-text);
      font-size: 0.78rem;
      font-weight: 800;
      letter-spacing: 0;
      text-transform: uppercase;
    }

    .onboarding-panel h1,
    .onboarding-panel h2 {
      margin: 0;
      color: var(--heading);
      font-size: 1.35rem;
      line-height: 1.2;
    }

    .onboarding-copy,
    .onboarding-warning,
    .onboarding-card-status {
      margin: 0;
      color: var(--muted);
      line-height: 1.5;
    }

    .onboarding-warning {
      color: var(--warn-text);
    }

    .onboarding-label {
      display: grid;
      gap: 0.25rem;
      color: var(--secondary);
      font-size: 0.9rem;
      font-weight: 700;
    }

    .onboarding-label span {
      color: var(--muted);
      font-weight: 500;
    }

    .onboarding-input,
    .settings-form input,
    .settings-form select {
      width: 100%;
      min-height: 2.35rem;
      border: 1px solid var(--border-strong);
      border-radius: 8px;
      background: var(--card);
      color: var(--text);
      padding: 0.55rem 0.65rem;
      font: inherit;
    }

    .onboarding-harness-list {
      display: grid;
      gap: 0.75rem;
    }

    .onboarding-harness-card {
      display: grid;
      gap: 0.7rem;
      border: 1px solid var(--border-surface);
      border-radius: 8px;
      background: var(--card);
      padding: 1rem;
    }

    .onboarding-harness-header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 0.75rem;
    }

    .onboarding-harness-header h3 {
      margin: 0;
      color: var(--heading);
      font-size: 1rem;
      line-height: 1.25;
    }

    .onboarding-harness-card p {
      margin: 0;
      color: var(--muted);
      line-height: 1.45;
    }

    .onboarding-command-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 0.5rem;
      align-items: center;
    }

    .onboarding-command-row code {
      overflow-x: auto;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--code-bg);
      color: var(--body-text);
      padding: 0.55rem 0.65rem;
      font-size: 0.86rem;
      white-space: nowrap;
    }

    .onboarding-docs-link {
      display: inline-flex;
      min-height: 2.35rem;
      align-items: center;
      border: 1px solid var(--border-surface);
      border-radius: 8px;
      color: var(--secondary);
      padding: 0 0.75rem;
      font-size: 0.9rem;
      font-weight: 600;
      text-decoration: none;
    }

    .settings-form {
      grid-template-columns: minmax(8rem, 12rem) minmax(0, 1fr);
      align-items: center;
    }

    .settings-form label {
      color: var(--secondary);
      font-size: 0.9rem;
      font-weight: 700;
    }

    .app-header {
      position: relative;
      display: grid;
      grid-template-columns: minmax(8rem, 1fr) minmax(0, 34rem) minmax(8rem, 1fr);
      align-items: center;
      gap: 1rem;
      border-bottom: 1px solid var(--border);
      padding-bottom: 0.875rem;
    }

    .header-brand {
      display: flex;
      align-items: center;
      justify-self: start;
      gap: 0.75rem;
      min-width: 0;
    }

    .wordmark {
      color: var(--heading);
      font-size: 1rem;
      line-height: 1;
      text-decoration: none;
    }

    .wordmark strong {
      font-weight: 700;
    }

    .topic-switcher {
      position: relative;
      display: grid;
      gap: 0.25rem;
      justify-self: center;
      width: min(100%, 34rem);
      min-width: 0;
    }

    .course-title {
      overflow: hidden;
      margin: 0;
      color: var(--muted);
      font-size: 0.78rem;
      font-weight: 600;
      line-height: 1.25;
      text-align: center;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .topic-menu-button {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 0.45rem;
      min-width: 0;
      min-height: 2.5rem;
      border: 1px solid var(--border-surface);
      border-radius: 8px;
      background: var(--surface);
      color: var(--text);
      padding: 0.35rem 0.45rem 0.35rem 0.75rem;
      font: inherit;
      cursor: pointer;
    }

    .topic-menu-button:hover {
      border-color: var(--accent-border);
      background: var(--accent-hover-bg);
    }

    .topic-title-text {
      min-width: 0;
      overflow: hidden;
      color: var(--heading);
      font-weight: 600;
      line-height: 1.25;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .topic-progress {
      flex: 0 0 auto;
      border: 1px solid var(--accent-border);
      border-radius: 999px;
      color: var(--accent-soft-text);
      padding: 0.12rem 0.42rem;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
      font-size: 0.78rem;
      font-weight: 700;
      font-variant-numeric: tabular-nums;
      line-height: 1.35;
    }

    .topic-menu-chevron {
      flex: 0 0 auto;
      width: 1rem;
      height: 1rem;
      color: var(--muted);
    }

    .topic-menu-button[aria-expanded="true"] .topic-menu-chevron {
      transform: rotate(180deg);
    }

    .topic-menu {
      position: absolute;
      top: calc(100% + 0.5rem);
      left: 50%;
      z-index: 30;
      display: grid;
      width: min(32rem, calc(100vw - 2rem));
      max-height: min(34rem, calc(100dvh - 7rem));
      overflow-y: auto;
      border: 1px solid var(--border-surface);
      border-radius: 8px;
      background: var(--card);
      box-shadow: var(--pop-shadow);
      padding: 0.85rem;
      transform: translateX(-50%);
    }

    .header-controls {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      justify-self: end;
      gap: 0.5rem;
      min-width: 8rem;
    }

    .harness-selector {
      position: relative;
      display: flex;
      align-items: center;
      min-width: 0;
    }

    .harness-menu-button {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      align-items: center;
      column-gap: 0.45rem;
      min-height: 2.6rem;
      max-width: 13rem;
      border: 1px solid var(--border-surface);
      border-radius: 8px;
      background: var(--surface);
      color: var(--secondary);
      padding: 0.28rem 0.45rem 0.28rem 0.65rem;
      font: inherit;
      cursor: pointer;
    }

    .harness-menu-button:hover {
      border-color: var(--accent-border);
      background: var(--accent-hover-bg);
      color: var(--text);
    }

    .harness-selected {
      display: grid;
      min-width: 0;
      text-align: left;
    }

    .harness-selected-name {
      overflow: hidden;
      color: var(--heading);
      font-size: 0.86rem;
      font-weight: 600;
      line-height: 1.2;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .harness-selected-state {
      overflow: hidden;
      color: var(--muted);
      font-size: 0.72rem;
      line-height: 1.2;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .harness-menu-chevron {
      width: 0.95rem;
      height: 0.95rem;
      color: var(--muted);
    }

    .harness-menu-button[aria-expanded="true"] .harness-menu-chevron {
      transform: rotate(180deg);
    }

    .harness-menu {
      position: absolute;
      top: calc(100% + 0.45rem);
      right: 0;
      z-index: 35;
      display: grid;
      gap: 0.35rem;
      width: min(18rem, calc(100vw - 1.5rem));
      border: 1px solid var(--border-surface);
      border-radius: 8px;
      background: var(--card);
      box-shadow: var(--pop-shadow);
      padding: 0.45rem;
    }

    .harness-option {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      align-items: center;
      gap: 0.6rem;
      min-height: 2.35rem;
      border: 1px solid transparent;
      border-radius: 6px;
      background: transparent;
      color: var(--secondary);
      padding: 0.4rem 0.5rem;
      font: inherit;
      text-align: left;
      cursor: pointer;
    }

    .harness-option:hover,
    .harness-option.selected {
      border-color: var(--accent-border);
      background: var(--accent-hover-bg);
      color: var(--text);
    }

    .harness-option:disabled {
      border-color: transparent;
      background: transparent;
      color: var(--disabled);
      cursor: not-allowed;
    }

    .harness-option-label {
      min-width: 0;
      overflow: hidden;
      font-size: 0.88rem;
      font-weight: 600;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .harness-option-state {
      color: var(--muted);
      font-size: 0.72rem;
      white-space: nowrap;
    }

    .done-learning-control {
      position: relative;
      display: flex;
      align-items: center;
    }

    .done-learning {
      min-height: 2.6rem;
      border: 1px solid var(--border-surface);
      border-radius: 8px;
      background: var(--surface);
      color: var(--secondary);
      padding: 0 0.75rem;
      font: inherit;
      font-size: 0.9rem;
      font-weight: 600;
      cursor: pointer;
      white-space: nowrap;
    }

    .done-learning:hover {
      border-color: var(--accent-border);
      background: var(--accent-hover-bg);
      color: var(--text);
    }

    .done-learning:disabled {
      border-color: var(--border-surface);
      background: var(--surface);
      color: var(--disabled);
      cursor: not-allowed;
    }

    .done-confirm {
      position: absolute;
      top: calc(100% + 0.45rem);
      right: 0;
      z-index: 35;
      display: grid;
      gap: 0.55rem;
      width: 13rem;
      border: 1px solid var(--border-surface);
      border-radius: 8px;
      background: var(--card);
      box-shadow: var(--pop-shadow);
      padding: 0.65rem;
    }

    .done-confirm p {
      margin: 0;
      color: var(--heading);
      font-size: 0.9rem;
      font-weight: 600;
    }

    .done-confirm-actions {
      display: flex;
      gap: 0.4rem;
    }

    .done-confirm-yes,
    .done-confirm-no {
      flex: 1;
      min-height: 2rem;
      border: 1px solid var(--border-surface);
      border-radius: 6px;
      padding: 0 0.55rem;
      font: inherit;
      font-size: 0.85rem;
      font-weight: 600;
      cursor: pointer;
    }

    .done-confirm-yes {
      border-color: var(--warn);
      background: var(--accent-hover-bg);
      color: var(--warn-text);
    }

    .done-confirm-no {
      background: var(--surface);
      color: var(--secondary);
    }

    .done-confirm-yes:hover,
    .done-confirm-no:hover {
      border-color: var(--accent-border-strong);
      background: var(--accent-active-bg);
      color: var(--text);
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
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 1rem;
      min-height: 0;
    }

    .lesson-list {
      display: grid;
      gap: 0.4rem;
      margin-top: 0.75rem;
    }

    .mastery-summary {
      display: grid;
      gap: 0.55rem;
      margin-top: 0;
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

    .status-line.ended {
      color: var(--muted);
    }

    .status-line.ended .status-dot {
      background: var(--disabled);
    }

    .status-line.failed {
      color: var(--danger, #b42318);
    }

    .status-line.failed .status-dot {
      background: var(--danger, #b42318);
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

    .session-ended {
      margin: 0;
      border: 1px solid var(--border-surface);
      border-radius: 8px;
      background: var(--surface);
      color: var(--muted);
      padding: 0.7rem 0.85rem;
      font-size: 0.92rem;
      line-height: 1.45;
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

    .agent-activity {
      border: 1px dashed var(--border-strong);
      border-radius: 8px;
      background: color-mix(in srgb, var(--surface) 78%, transparent);
      padding: 0.75rem;
    }

    .agent-activity-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.75rem;
      margin-bottom: 0.6rem;
    }

    .agent-activity-title {
      color: var(--heading);
      font-size: 0.9rem;
      font-weight: 600;
    }

    .agent-activity-meta {
      color: var(--muted);
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
      font-size: 0.78rem;
      font-variant-numeric: tabular-nums;
    }

    .activity-thinking {
      margin: 0 0 0.6rem;
      color: var(--muted);
      font-size: 0.88rem;
    }

    .activity-thinking summary {
      cursor: pointer;
      overflow-wrap: anywhere;
    }

    .activity-thinking pre {
      margin: 0.5rem 0 0;
      overflow-x: auto;
      border-left: 3px solid var(--border-strong);
      color: var(--muted);
      padding: 0.25rem 0 0.25rem 0.65rem;
      font: inherit;
      white-space: pre-wrap;
    }

    .activity-message {
      width: min(100%, 44rem);
      margin-bottom: 0.6rem;
      border: 1px solid var(--border-surface);
      border-radius: 8px 8px 8px 2px;
      background: var(--card);
      color: var(--body-text);
      padding: 0.65rem 0.75rem;
      line-height: 1.55;
      white-space: pre-wrap;
    }

    .activity-lines {
      display: grid;
      gap: 0.35rem;
      margin-top: 0.45rem;
    }

    .activity-line {
      display: grid;
      grid-template-columns: minmax(6rem, auto) minmax(0, 1fr);
      align-items: center;
      gap: 0.65rem;
      min-height: 1.8rem;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: var(--surface);
      padding: 0.25rem 0.5rem;
      color: var(--secondary);
      font-size: 0.84rem;
    }

    .activity-line-label {
      min-width: 0;
      overflow: hidden;
      color: var(--heading);
      font-weight: 600;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .activity-line-detail {
      min-width: 0;
      overflow: hidden;
      color: var(--muted);
      text-overflow: ellipsis;
      white-space: nowrap;
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

      .library-header,
      .library-heading,
      .library-form-heading,
      .course-card-header {
        display: grid;
      }

      .library-actions,
      .library-form-actions,
      .course-card-actions {
        width: 100%;
      }

      .library-button,
      .course-card-actions .library-button {
        flex: 1 1 auto;
      }

      .library-course-form,
      .settings-form {
        grid-template-columns: 1fr;
      }

      .course-wizard-layout,
      .plan-topic-row {
        grid-template-columns: 1fr;
      }

      .library-course-form label,
      .settings-form label {
        line-height: 1.25;
      }

      .library-form-actions {
        grid-column: 1;
      }

      .course-card-stats {
        grid-template-columns: 1fr;
      }

      .course-card-stat,
      .course-card-stat:first-child {
        padding: 0.65rem 0;
      }

      .course-card-stat + .course-card-stat {
        border-top: 1px solid var(--border);
        border-left: 0;
      }

      .course-card-stat-value {
        white-space: normal;
      }

      .plan-topic-children {
        padding-left: 0.5rem;
      }

      h1 {
        font-size: 1.25rem;
      }

      .app-header {
        grid-template-columns: minmax(0, 1fr) auto;
        grid-template-areas:
          "brand controls"
          "topic topic";
        align-items: start;
      }

      .header-brand {
        grid-area: brand;
        min-height: 2.6rem;
      }

      .header-controls {
        grid-area: controls;
        min-width: 0;
        gap: 0.35rem;
      }

      .harness-menu-button {
        max-width: 8.5rem;
        min-height: 2.4rem;
        padding-left: 0.55rem;
      }

      .harness-selected-name {
        font-size: 0.78rem;
      }

      .harness-selected-state {
        display: none;
      }

      .done-learning {
        min-height: 2.4rem;
        max-width: 8.5rem;
        overflow: hidden;
        padding: 0 0.6rem;
        font-size: 0.82rem;
        text-overflow: ellipsis;
      }

      .done-confirm {
        width: min(13rem, calc(100vw - 1.5rem));
      }

      .topic-switcher {
        grid-area: topic;
        justify-self: stretch;
        width: 100%;
      }

      .topic-menu-button {
        width: 100%;
      }

      .topic-menu {
        width: calc(100vw - 1.5rem);
        max-height: min(32rem, calc(100dvh - 7.5rem));
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
    <section id="onboarding-screen" class="onboarding-screen" aria-labelledby="onboarding-title"${onboardingHidden}>
      <a class="wordmark" href="/" aria-label="Homepage"><strong>overlearn</strong></a>

      <section class="onboarding-panel" data-onboarding-step="welcome"${onboardingState === "welcome" ? "" : " hidden"}>
        <p class="onboarding-kicker">Welcome</p>
        <h1 id="onboarding-title">Set up overlearn</h1>
        <p class="onboarding-copy">Overlearn turns your existing AI subscription into a local learning workspace: connect an agent, build course threads, and keep the durable notes, mastery checks, and demos on this machine.</p>
        <label class="onboarding-label" for="onboarding-name">Name <span>optional</span></label>
        <input id="onboarding-name" class="onboarding-input" name="name" type="text" autocomplete="name" value="${escapeHtml(
          profile.name ?? "",
        )}">
        <div class="library-form-actions">
          <button id="onboarding-welcome-continue" class="library-button primary" type="button">Continue</button>
        </div>
      </section>

      <section class="onboarding-panel" data-onboarding-step="connect-agent"${onboardingState === "connect-agent" ? "" : " hidden"}>
        <p class="onboarding-kicker">Connect your agent</p>
        <h2>Choose a default agent</h2>
        <p id="onboarding-harness-status" class="library-status" aria-live="polite">${hasReadyHarness ? "Ready agents can be used as your default." : "No ready agents yet. You can log in, install one, or skip for now."}</p>
        <div id="onboarding-harness-list" class="onboarding-harness-list">${renderOnboardingHarnessCards(
          harnesses,
        )}</div>
        <p class="onboarding-warning">Skipping means new courses will use the default agent once one is available.</p>
        <div class="library-form-actions">
          <button id="onboarding-connect-continue" class="library-button primary" type="button"${hasReadyHarness ? "" : " disabled"}>Continue</button>
          <button id="onboarding-skip" class="library-button secondary" type="button">Skip for now</button>
        </div>
      </section>

      <section class="onboarding-panel" data-onboarding-step="tutorial-offer"${onboardingState === "tutorial-offer" ? "" : " hidden"}>
        <p class="onboarding-kicker">Tutorial</p>
        <h2>Start with a quick tutorial?</h2>
        <p class="onboarding-copy">The guided tutorial opens a small course about Overlearn itself: dialogue turns, topic mastery, Feynman checks, review tools, and creating the next course.</p>
        <p id="tutorial-status" class="library-notice" hidden></p>
        <div class="library-form-actions">
          <button id="tutorial-start" class="library-button primary" type="button">Start tutorial</button>
          <button id="tutorial-later" class="library-button secondary" type="button">Maybe later</button>
        </div>
      </section>
    </section>

    <section id="settings-screen" class="settings-screen" aria-labelledby="settings-title" hidden>
      <header class="library-header">
        <div class="library-heading">
          <a class="wordmark" href="/" aria-label="Homepage"><strong>overlearn</strong></a>
          <div>
            <h1 id="settings-title">Settings</h1>
            <p id="settings-status" class="library-status" aria-live="polite" hidden></p>
          </div>
        </div>
        <div class="library-actions">
          <button id="settings-back" class="library-button secondary" type="button">Library</button>
        </div>
      </header>
      <form id="settings-form" class="library-form-panel settings-form">
        <label for="settings-name">Name</label>
        <input id="settings-name" name="name" type="text" autocomplete="name" value="${escapeHtml(
          profile.name ?? "",
        )}">

        <label for="settings-harness">Preferred agent</label>
        <select id="settings-harness" name="preferredHarness"></select>

        <label for="settings-data-dir">Data location</label>
        <input id="settings-data-dir" name="dataDir" type="text" value="${escapeHtml(
          dataDir,
        )}" readonly>

        <div class="library-form-actions">
          <button class="library-button primary" type="submit">Save settings</button>
          <button id="rerun-onboarding" class="library-button secondary" type="button">Re-run onboarding</button>
        </div>
      </form>
    </section>

    <section id="library-screen" class="library-screen" aria-labelledby="library-title"${libraryHidden}>
      <header class="library-header">
        <div class="library-heading">
          <a class="wordmark" href="/" aria-label="Homepage"><strong>overlearn</strong></a>
          <div>
            <h1 id="library-title">Course library</h1>
            <p id="library-status" class="library-status" aria-live="polite">Loading courses...</p>
          </div>
        </div>
        <div class="library-actions">
          <button id="library-settings" class="library-button secondary" type="button" aria-label="Settings" title="Settings">&#9881;</button>
          <button id="new-course" class="library-button primary" type="button">New course</button>
          <button id="brainstorm-course" class="library-button secondary" type="button">Brainstorm with your agent</button>
          <button id="import-course" class="library-button secondary" type="button">Import</button>
        </div>
      </header>

      <p id="import-notice" class="library-notice" hidden></p>

      <section id="library-form-panel" class="library-form-panel" aria-labelledby="library-form-title" hidden>
        <div class="library-form-heading">
          <h2 id="library-form-title">New course</h2>
          <button id="library-cancel-course" class="library-button ghost" type="button">Cancel</button>
        </div>
        <form id="library-course-form" class="library-course-form">
          <label for="library-title-input">Title</label>
          <input id="library-title-input" name="title" type="text" autocomplete="off" required>

          <label for="library-description-input">Description</label>
          <textarea id="library-description-input" name="description" rows="3"></textarea>

          <label for="library-harness-select">Harness</label>
          <select id="library-harness-select" name="harnessId"></select>

          <label for="library-attached-dir-input">Attached folder</label>
          <input id="library-attached-dir-input" name="attachedDir" type="text" placeholder="/path/to/project">

          <div class="library-form-actions">
            <button id="library-save-course" class="library-button primary" type="submit">Create course</button>
            <p id="library-form-status" class="library-form-status" aria-live="polite" hidden></p>
          </div>
        </form>
      </section>

      <section id="course-ideation-panel" class="library-form-panel course-ideation-panel" aria-labelledby="course-ideation-title" hidden>
        <div class="library-form-heading">
          <h2 id="course-ideation-title">Brainstorm with your agent</h2>
          <button id="cancel-course-ideation" class="library-button ghost" type="button">Cancel</button>
        </div>
        <form id="course-ideation-form" class="library-course-form">
          <label for="course-ideation-seed">Interest or goal</label>
          <textarea id="course-ideation-seed" name="seed" rows="4" required placeholder="I want to understand how databases work well enough to design one for my app."></textarea>

          <div class="library-form-actions">
            <button id="start-course-ideation" class="library-button primary" type="submit">Start brainstorm</button>
            <p id="course-ideation-status" class="library-form-status" aria-live="polite" hidden></p>
          </div>
        </form>
      </section>

      <section id="course-wizard-panel" class="course-wizard-panel" aria-labelledby="course-wizard-title" hidden data-wizard-review>
        <div class="library-form-heading">
          <div>
            <h2 id="course-wizard-title">Course plan review</h2>
            <p id="wizard-status" class="library-form-status" aria-live="polite">Brainstorm with your agent until it proposes a plan.</p>
          </div>
          <button id="wizard-close" class="library-button ghost" type="button">Close</button>
        </div>

        <div class="course-wizard-layout">
          <section class="wizard-conversation" aria-label="Ideation conversation">
            <div id="wizard-transcript" class="wizard-transcript"></div>
            <form id="wizard-reply-form" class="wizard-reply-form">
              <label for="wizard-reply-input">Reply to agent</label>
              <textarea id="wizard-reply-input" name="reply" rows="3" placeholder="Refine the goal, constraints, or pacing."></textarea>
              <button id="wizard-reply-submit" class="library-button secondary" type="submit">Send reply</button>
            </form>
          </section>

          <section id="plan-review-screen" class="plan-review-screen" aria-label="Draft course plan" data-plan-review>
            <label for="wizard-title-input">Title</label>
            <input id="wizard-title-input" name="title" type="text" autocomplete="off">

            <label for="wizard-description-input">Description</label>
            <textarea id="wizard-description-input" name="description" rows="3"></textarea>

            <div class="plan-review-heading">
              <h3>Topics</h3>
              <p>Rename or remove topics before accepting.</p>
            </div>
            <div id="wizard-topic-tree" class="wizard-topic-tree"></div>

            <div class="library-form-actions">
              <button id="wizard-accept-plan" class="library-button primary" type="button">Accept</button>
              <button id="wizard-discard-plan" class="library-button danger" type="button">Discard</button>
            </div>
          </section>
        </div>
      </section>

      <section id="drafts-section" class="drafts-section" aria-labelledby="drafts-title">
        <div class="library-section-heading">
          <h2 id="drafts-title">Drafts</h2>
          <p id="drafts-status" class="library-status" aria-live="polite">Loading drafts...</p>
        </div>
        <div id="draft-course-list" class="course-card-grid" aria-label="Draft courses" aria-live="polite">
          <p class="library-empty">Loading drafts...</p>
        </div>
      </section>

      <nav class="library-tabs" aria-label="Course status" role="tablist">
        <button class="library-tab active" type="button" role="tab" aria-selected="true" data-library-status="active">Active</button>
        <button class="library-tab" type="button" role="tab" aria-selected="false" data-library-status="archived">Archived</button>
      </nav>

      <section id="course-library-list" class="course-card-grid" aria-label="Courses" aria-live="polite">
        <p class="library-empty">Loading courses...</p>
      </section>
    </section>

    <header class="app-header" data-course-view${courseViewHidden}>
      <div class="header-brand">
        <a class="wordmark" href="/" aria-label="Homepage"><strong>overlearn</strong></a>
        <button id="back-to-library" class="back-to-library" type="button">Library</button>
      </div>
      <div id="topic-switcher" class="topic-switcher">
        <h1 class="course-title">${escapeHtml(courseTitle)}</h1>
        <button id="topic-menu-button" class="topic-menu-button" type="button" aria-haspopup="true" aria-expanded="false" aria-controls="topic-menu">
          <span id="topic-title" class="topic-title-text">${escapeHtml(headerTopicTitle)}</span>
          <span id="topic-progress" class="topic-progress" aria-label="Mastery progress ${escapeHtml(
            headerProgress,
          )}">${escapeHtml(headerProgress)}</span>
          <svg class="topic-menu-chevron" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 8 5 5 5-5"/></svg>
        </button>
        <div id="topic-menu" class="topic-menu" aria-label="Topic navigation" hidden>
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
        </div>
      </div>
      <div class="header-controls">
        <div id="harness-selector" class="harness-selector"${harnessHidden}>
          <button id="harness-menu-button" class="harness-menu-button" type="button" aria-haspopup="true" aria-expanded="false" aria-controls="harness-menu">
            <span class="harness-selected">
              <span id="harness-selected-name" class="harness-selected-name">${escapeHtml(
                selectedHarnessOption?.name ?? "Harness",
              )}</span>
              <span id="harness-selected-state" class="harness-selected-state">${escapeHtml(
                harnessStateText(selectedHarnessOption),
              )}</span>
            </span>
            <svg class="harness-menu-chevron" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 8 5 5 5-5"/></svg>
          </button>
          <div id="harness-menu" class="harness-menu" aria-label="Harness selection" hidden>${renderHarnessOptions(
            harnesses,
          )}</div>
        </div>
        <div id="done-learning-control" class="done-learning-control">
          <button id="done-learning" class="done-learning" type="button" aria-label="${escapeHtml(
            doneButtonLabel,
          )}" aria-expanded="false"${doneButtonDisabled}>${escapeHtml(
            doneButtonLabel,
          )}</button>
          <div id="done-confirm" class="done-confirm" role="dialog" aria-label="End learning session" hidden>
            <p>End session?</p>
            <div class="done-confirm-actions">
              <button id="done-confirm-yes" class="done-confirm-yes" type="button">End</button>
              <button id="done-confirm-no" class="done-confirm-no" type="button">Cancel</button>
            </div>
          </div>
        </div>
        <button id="theme-toggle" class="theme-toggle" type="button" aria-label="Toggle color theme" title="Toggle color theme">
          <svg class="icon-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.93 4.93l1.41 1.41m11.32 11.32 1.41 1.41M2 12h2m16 0h2M4.93 19.07l1.41-1.41m11.32-11.32 1.41-1.41"/></svg>
          <svg class="icon-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/></svg>
        </button>
      </div>
    </header>

    <div class="workspace" data-course-view${courseViewHidden}>
      <section class="stream-pane" aria-label="Teaching stream">
        <div class="stream-header">
          <h2>Teaching stream</h2>
          <p id="status-line" class="${statusLineClass}"><span class="status-dot" aria-hidden="true"></span><span id="status">${escapeHtml(renderStatusText(status, hasSeenWait))}</span></p>
        </div>

        <section id="transcript" aria-live="polite">${renderTranscriptHtml(
          renderedTranscript,
        )}${agentActivitySkeleton}</section>

        <div class="stream-dock">
          <p id="session-ended" class="session-ended"${sessionEndedHidden}>Session ended — the daemon has stopped.</p>
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

  <script>${libraryScript}</script>
  <script>${script}</script>
</body>
</html>`;
};

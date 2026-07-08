import manifestMarkdown from "../../assets/tutorial/manifest.md" with { type: "text" };
import dialogueLoopBody from "../../assets/tutorial/dialogue-loop.md" with { type: "text" };
import feynmanChecksBody from "../../assets/tutorial/feynman-checks.md" with { type: "text" };
import reviewRailGlossaryBody from "../../assets/tutorial/review-rail-glossary.md" with { type: "text" };
import topicsMasteryBody from "../../assets/tutorial/topics-mastery.md" with { type: "text" };
import {
  appendJournalEntry,
  createCourse,
  flattenTopicTree,
  listCourses,
  readTopicTree,
  replaceTopicTree,
  withStoreTransaction,
  type Course,
  type Store,
  type TopicTreeInput,
} from "../store";

export const TUTORIAL_SOURCE_NAME = "tutorial";

type TutorialManifest = Readonly<{
  title: string;
  description: string;
}>;

type TutorialTopicSource = Readonly<{
  path: string;
  title: string;
  position: number;
  enteredAt: string | null;
  isCurrent: boolean;
  journalEntries: readonly TutorialJournalEntrySeed[];
}>;

type TutorialJournalEntrySource = Readonly<{
  kind: "note" | "summary";
  bodyMarkdown: string;
}>;

type TutorialJournalEntrySeed = TutorialJournalEntrySource &
  Readonly<{
    turn: number;
    createdAt: string;
  }>;

const tutorialTimestamp = (minute: number): string =>
  `2026-01-01T00:${String(minute).padStart(2, "0")}:00.000Z`;

const tutorialJournalKind = (heading: string): TutorialJournalEntrySource["kind"] => {
  const normalized = heading.toLowerCase();
  if (normalized === "note" || normalized.startsWith("note ")) {
    return "note";
  }

  if (normalized === "summary" || normalized.startsWith("summary ")) {
    return "summary";
  }

  throw new Error(`Unsupported tutorial journal heading: ${heading}`);
};

const parseTutorialManifest = (markdown: string): TutorialManifest => {
  const lines = markdown.split(/\r?\n/);
  const title =
    lines
      .find((line) => line.startsWith("# "))
      ?.slice(2)
      .trim() ?? "Learning Overlearn";
  const descriptionLines: string[] = [];

  for (const line of lines.slice(1)) {
    if (line.startsWith("## ")) {
      break;
    }

    if (line.trim().length > 0) {
      descriptionLines.push(line.trim());
    }
  }

  return {
    title,
    description: descriptionLines.join(" "),
  };
};

const parseTutorialJournalEntries = (
  markdown: string,
): readonly TutorialJournalEntrySource[] => {
  const entries: TutorialJournalEntrySource[] = [];
  let current:
    | {
        kind: TutorialJournalEntrySource["kind"];
        lines: string[];
      }
    | undefined;

  const pushCurrent = (): void => {
    if (current === undefined) {
      return;
    }

    const bodyMarkdown = current.lines.join("\n").trim();
    if (bodyMarkdown.length === 0) {
      throw new Error("Tutorial journal entry is empty.");
    }

    entries.push({
      kind: current.kind,
      bodyMarkdown,
    });
  };

  for (const line of markdown.split(/\r?\n/)) {
    if (line.startsWith("## ")) {
      pushCurrent();
      current = {
        kind: tutorialJournalKind(line.slice(3).trim()),
        lines: [],
      };
      continue;
    }

    if (current !== undefined) {
      current.lines.push(line);
    }
  }

  pushCurrent();
  return entries;
};

const tutorialJournalEntries = (
  markdown: string,
  turns: readonly number[],
): readonly TutorialJournalEntrySeed[] => {
  const entries = parseTutorialJournalEntries(markdown);
  if (entries.length !== turns.length) {
    throw new Error(
      `Expected ${turns.length} tutorial journal entries, found ${entries.length}.`,
    );
  }

  return entries.map((entry, index) => {
    const turn = turns[index];
    if (turn === undefined) {
      throw new Error("Missing tutorial journal turn.");
    }

    return {
      ...entry,
      turn,
      createdAt: tutorialTimestamp(turn),
    };
  });
};

const tutorialManifest = parseTutorialManifest(manifestMarkdown);

const tutorialTopicSources: readonly TutorialTopicSource[] = [
  {
    path: "dialogue-loop",
    title: "Dialogue loop",
    position: 0,
    enteredAt: tutorialTimestamp(1),
    isCurrent: false,
    journalEntries: tutorialJournalEntries(dialogueLoopBody, [1, 2]),
  },
  {
    path: "topics-mastery",
    title: "Topics and mastery",
    position: 1,
    enteredAt: tutorialTimestamp(3),
    isCurrent: false,
    journalEntries: tutorialJournalEntries(topicsMasteryBody, [3, 4, 5]),
  },
  {
    path: "feynman-checks",
    title: "Feynman checks",
    position: 2,
    enteredAt: tutorialTimestamp(6),
    isCurrent: false,
    journalEntries: tutorialJournalEntries(feynmanChecksBody, [6, 7]),
  },
  {
    path: "review-rail-glossary",
    title: "Review rail and glossary",
    position: 3,
    enteredAt: tutorialTimestamp(8),
    isCurrent: true,
    journalEntries: tutorialJournalEntries(reviewRailGlossaryBody, [8, 9]),
  },
  {
    path: "next-course",
    title: "Creating your next course",
    position: 4,
    enteredAt: null,
    isCurrent: false,
    journalEntries: [],
  },
];

export const tutorialTopics: readonly TopicTreeInput[] =
  tutorialTopicSources.map((topic) => ({
    path: topic.path,
    title: topic.title,
    body: "",
    position: topic.position,
    enteredAt: topic.enteredAt,
    isCurrent: topic.isCurrent,
  }));

export const tutorialCourseContent = {
  title: tutorialManifest.title,
  description: tutorialManifest.description,
  topics: tutorialTopics,
} as const;

const findTutorialCourse = (store: Store): Course | undefined =>
  listCourses(store).find((course) => course.sourceName === TUTORIAL_SOURCE_NAME);

export const createTutorialCourse = (store: Store): Course =>
  withStoreTransaction(store, () => {
    // sourceName is the existing durable seed marker: it keeps the tutorial
    // idempotent without schema changes and without depending on mutable title text.
    const existing = findTutorialCourse(store);
    if (existing !== undefined) {
      return existing;
    }

    const course = createCourse(store, {
      title: tutorialCourseContent.title,
      description: tutorialCourseContent.description,
      status: "active",
      sourceName: TUTORIAL_SOURCE_NAME,
      manifestExtra: {
        tutorial: true,
        manifest: "assets/tutorial/manifest.md",
        topicCount: tutorialTopics.length,
      },
    });
    replaceTopicTree(store, course.id, tutorialTopics);
    const topicsByPath = new Map(
      flattenTopicTree(readTopicTree(store, course.id)).map((topic) => [
        topic.path,
        topic,
      ]),
    );

    for (const topicSource of tutorialTopicSources) {
      const topic = topicsByPath.get(topicSource.path);
      if (topic === undefined) {
        throw new Error(`Tutorial topic was not created: ${topicSource.path}`);
      }

      for (const entry of topicSource.journalEntries) {
        appendJournalEntry(store, course.id, {
          topicId: topic.id,
          kind: entry.kind,
          bodyMarkdown: entry.bodyMarkdown,
          turn: entry.turn,
          createdAt: entry.createdAt,
        });
      }
    }

    return course;
  });

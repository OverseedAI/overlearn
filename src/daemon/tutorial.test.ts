import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  flattenTopicTree,
  listCourses,
  listJournalEntries,
  openStore,
  readTopicTree,
  type Store,
} from "../store";
import {
  createTutorialCourse,
  TUTORIAL_SOURCE_NAME,
  tutorialCourseContent,
} from "./tutorial";

const withTempStore = async <T>(
  run: (input: Readonly<{ store: ReturnType<typeof openStore> }>) => T | Promise<T>,
): Promise<T> => {
  const dir = await mkdtemp(join(tmpdir(), "overlearn-tutorial-"));
  const store = openStore({ databasePath: join(dir, "store.sqlite") });

  try {
    return await run({ store });
  } finally {
    store.close();
    await rm(dir, { force: true, recursive: true });
  }
};

const countJournalEntries = (store: Store, courseId: number): number =>
  flattenTopicTree(readTopicTree(store, courseId)).reduce(
    (count, topic) =>
      count + listJournalEntries(store, courseId, topic.id).length,
    0,
  );

describe("createTutorialCourse", () => {
  test("seeds the authored tutorial course as an active emergent map", async () => {
    await withTempStore(({ store }) => {
      const course = createTutorialCourse(store);
      const topics = flattenTopicTree(readTopicTree(store, course.id));

      expect(course.title).toBe("Learning Overlearn");
      expect(course.status).toBe("active");
      expect(course.sourceName).toBe(TUTORIAL_SOURCE_NAME);
      expect(course.description).toContain("fog-of-war map");
      expect(topics).toHaveLength(5);
      expect(topics.map((topic) => topic.path)).toEqual(
        tutorialCourseContent.topics.map((topic) => topic.path),
      );
      expect(topics.every((topic) => topic.body === "")).toBe(true);

      const currentTopics = topics.filter((topic) => topic.isCurrent);
      expect(currentTopics).toHaveLength(1);
      expect(currentTopics[0]?.path).toBe("review-rail-glossary");
      expect(currentTopics[0]?.enteredAt).toBe("2026-01-01T00:08:00.000Z");
      expect(currentTopics[0]?.state).toBe("current");

      const frontierTopics = topics.filter((topic) => topic.enteredAt === null);
      expect(frontierTopics.map((topic) => topic.path)).toEqual(["next-course"]);
      const frontierTopic = frontierTopics[0];
      if (frontierTopic === undefined) {
        throw new Error("Missing tutorial frontier topic.");
      }

      expect(frontierTopic.isCurrent).toBe(false);
      expect(frontierTopic.state).toBe("frontier");
      expect(listJournalEntries(store, course.id, frontierTopic.id)).toEqual([]);

      const visitedTopics = topics.filter((topic) => topic.enteredAt !== null);
      expect(visitedTopics).toHaveLength(4);
      expect(
        visitedTopics.every(
          (topic) => topic.state === "visited" || topic.state === "current",
        ),
      ).toBe(true);

      const allJournalEntries = visitedTopics.flatMap((topic) =>
        listJournalEntries(store, course.id, topic.id),
      );
      const turns = allJournalEntries.map((entry) => entry.turn);
      expect(turns.every((turn) => typeof turn === "number")).toBe(true);
      expect(turns).toEqual(
        [...turns].sort((left, right) => (left ?? 0) - (right ?? 0)),
      );
      expect(allJournalEntries.some((entry) => entry.kind === "summary")).toBe(true);

      for (const topic of visitedTopics) {
        const journal = listJournalEntries(store, course.id, topic.id);
        expect(journal.length).toBeGreaterThanOrEqual(2);
        expect(
          journal.every(
            (entry) =>
              (entry.kind === "note" || entry.kind === "summary") &&
              typeof entry.bodyMarkdown === "string" &&
              entry.bodyMarkdown.length > 0,
          ),
        ).toBe(true);
      }

      const topicsMastery = topics.find((topic) => topic.path === "topics-mastery");
      if (topicsMastery === undefined) {
        throw new Error("Missing topics-mastery tutorial topic.");
      }

      const masteryJournal = listJournalEntries(store, course.id, topicsMastery.id);
      expect(masteryJournal.map((entry) => entry.kind)).toEqual([
        "note",
        "note",
        "summary",
      ]);
      expect(masteryJournal.at(-1)?.bodyMarkdown).toContain(
        "Mastery is a working signal",
      );
    });
  });

  test("returns the existing tutorial course instead of duplicating it", async () => {
    await withTempStore(({ store }) => {
      const first = createTutorialCourse(store);
      const firstJournalCount = countJournalEntries(store, first.id);
      const second = createTutorialCourse(store);
      const tutorialCourses = listCourses(store).filter(
        (course) => course.sourceName === TUTORIAL_SOURCE_NAME,
      );

      expect(second.id).toBe(first.id);
      expect(tutorialCourses).toHaveLength(1);
      expect(flattenTopicTree(readTopicTree(store, first.id))).toHaveLength(5);
      expect(countJournalEntries(store, first.id)).toBe(firstJournalCount);
    });
  });
});

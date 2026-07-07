import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { flattenTopicTree, listCourses, openStore, readTopicTree } from "../store";
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

describe("createTutorialCourse", () => {
  test("seeds the authored tutorial course as active with topics", async () => {
    await withTempStore(({ store }) => {
      const course = createTutorialCourse(store);
      const topics = flattenTopicTree(readTopicTree(store, course.id));

      expect(course).toMatchObject({
        title: "Learning Overlearn",
        status: "active",
        sourceName: TUTORIAL_SOURCE_NAME,
      });
      expect(course.description).toContain("topics and mastery scores");
      expect(topics).toHaveLength(5);
      expect(topics.map((topic) => topic.path)).toEqual(
        tutorialCourseContent.topics.map((topic) => topic.path),
      );
      expect(topics[0]).toMatchObject({
        path: "dialogue-loop",
        isCurrent: true,
      });
      expect(topics[0]?.body).toContain("Your connected agent teaches");
      expect(topics.at(-1)?.body).toContain("brainstorm wizard");
    });
  });

  test("returns the existing tutorial course instead of duplicating it", async () => {
    await withTempStore(({ store }) => {
      const first = createTutorialCourse(store);
      const second = createTutorialCourse(store);
      const tutorialCourses = listCourses(store).filter(
        (course) => course.sourceName === TUTORIAL_SOURCE_NAME,
      );

      expect(second.id).toBe(first.id);
      expect(tutorialCourses).toHaveLength(1);
      expect(flattenTopicTree(readTopicTree(store, first.id))).toHaveLength(5);
    });
  });
});

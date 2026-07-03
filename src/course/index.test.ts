import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ensureCourseScaffold,
  isValidTopicPath,
  readCourseManifest,
  readPendingEvents,
  requireCourse,
  resolveCourseDirForWait,
  upsertGlossaryEntry,
  upsertTopic,
  upsertTopicTree,
  writePendingEvents,
} from "./index";

describe("course resolution", () => {
  test("resolves the only course in OVERLEARN_COURSES_DIR for no-arg wait", async () => {
    const coursesDir = await mkdtemp(join(tmpdir(), "overlearn-courses-"));
    const env = { OVERLEARN_COURSES_DIR: coursesDir };

    try {
      const paths = await ensureCourseScaffold("single", env);

      await expect(resolveCourseDirForWait(undefined, env, tmpdir())).resolves.toBe(
        paths.courseDir,
      );
    } finally {
      await rm(coursesDir, { force: true, recursive: true });
    }
  });

  test("requires an existing course for resume", async () => {
    const coursesDir = await mkdtemp(join(tmpdir(), "overlearn-courses-"));
    const env = { OVERLEARN_COURSES_DIR: coursesDir };

    try {
      const paths = await ensureCourseScaffold("existing", env);

      await expect(requireCourse("existing", env)).resolves.toEqual(paths);
    } finally {
      await rm(coursesDir, { force: true, recursive: true });
    }
  });

  test("missing resume course reports available courses", async () => {
    const coursesDir = await mkdtemp(join(tmpdir(), "overlearn-courses-"));
    const env = { OVERLEARN_COURSES_DIR: coursesDir };

    try {
      await ensureCourseScaffold("alpha", env);
      await ensureCourseScaffold("beta", env);

      await expect(requireCourse("missing", env)).rejects.toThrow(
        [
          `Cannot resume course "missing": ${join(
            coursesDir,
            "missing",
            "course.json",
          )} does not exist.`,
          `Available courses in ${coursesDir}: alpha, beta.`,
        ].join("\n"),
      );
    } finally {
      await rm(coursesDir, { force: true, recursive: true });
    }
  });
});

describe("glossary storage", () => {
  test("creates and case-insensitively updates glossary entries", async () => {
    const coursesDir = await mkdtemp(join(tmpdir(), "overlearn-glossary-"));
    const env = { OVERLEARN_COURSES_DIR: coursesDir };

    try {
      const paths = await ensureCourseScaffold("glossary", env);
      await writeFile(join(paths.lessonsDir, "01-intro.md"), "# Intro\n", "utf8");

      const created = await upsertGlossaryEntry(
        paths.courseDir,
        {
          term: "State",
          def: "A remembered value.",
          lesson: "01-intro",
        },
        new Date("2026-01-01T00:00:00Z"),
      );

      expect(created).toEqual({
        action: "created",
        entry: {
          term: "State",
          def: "A remembered value.",
          lesson: "01-intro",
          addedAt: "2026-01-01T00:00:00.000Z",
        },
      });

      const updated = await upsertGlossaryEntry(paths.courseDir, {
        term: "state",
        def: "Updated definition.",
      });

      expect(updated).toEqual({
        action: "updated",
        entry: {
          term: "state",
          def: "Updated definition.",
          lesson: "01-intro",
          addedAt: "2026-01-01T00:00:00.000Z",
        },
      });

      const stored = JSON.parse(
        await readFile(paths.glossaryJson, "utf8"),
      ) as unknown;

      expect(stored).toEqual([
        {
          term: "state",
          def: "Updated definition.",
          lesson: "01-intro",
          addedAt: "2026-01-01T00:00:00.000Z",
        },
      ]);
    } finally {
      await rm(coursesDir, { force: true, recursive: true });
    }
  });

  test("rejects empty fields and missing lesson ids", async () => {
    const coursesDir = await mkdtemp(join(tmpdir(), "overlearn-glossary-"));
    const env = { OVERLEARN_COURSES_DIR: coursesDir };

    try {
      const paths = await ensureCourseScaffold("glossary", env);

      await expect(
        upsertGlossaryEntry(paths.courseDir, {
          term: " ",
          def: "Definition.",
        }),
      ).rejects.toThrow("Glossary term cannot be empty.");

      await expect(
        upsertGlossaryEntry(paths.courseDir, {
          term: "State",
          def: "Definition.",
          lesson: "missing",
        }),
      ).rejects.toThrow("Lesson does not exist: missing");
    } finally {
      await rm(coursesDir, { force: true, recursive: true });
    }
  });
});

describe("topic storage", () => {
  test("creates ancestors, moves current, and updates re-entered nodes", () => {
    const first = upsertTopicTree(
      [],
      {
        path: "indexes/btree",
        title: "B-tree",
        lesson: "02-btree",
      },
      new Date("2026-01-01T00:00:00Z"),
    );

    expect(first).toEqual({
      action: "created",
      topic: {
        path: "indexes/btree",
        title: "B-tree",
        lesson: "02-btree",
        enteredAt: "2026-01-01T00:00:00.000Z",
        current: true,
        children: [],
      },
      topics: [
        {
          path: "indexes",
          title: "indexes",
          current: false,
          children: [
            {
              path: "indexes/btree",
              title: "B-tree",
              lesson: "02-btree",
              enteredAt: "2026-01-01T00:00:00.000Z",
              current: true,
              children: [],
            },
          ],
        },
      ],
    });

    const second = upsertTopicTree(
      first.topics,
      {
        path: "indexes/hash",
        title: "Hash index",
        lesson: "03-hash",
      },
      new Date("2026-01-02T00:00:00Z"),
    );

    expect(second.topics).toEqual([
      {
        path: "indexes",
        title: "indexes",
        current: false,
        children: [
          {
            path: "indexes/btree",
            title: "B-tree",
            lesson: "02-btree",
            enteredAt: "2026-01-01T00:00:00.000Z",
            current: false,
            children: [],
          },
          {
            path: "indexes/hash",
            title: "Hash index",
            lesson: "03-hash",
            enteredAt: "2026-01-02T00:00:00.000Z",
            current: true,
            children: [],
          },
        ],
      },
    ]);

    const updated = upsertTopicTree(
      second.topics,
      {
        path: "indexes/btree",
        title: "B+ tree",
      },
      new Date("2026-01-03T00:00:00Z"),
    );

    expect(updated.action).toBe("updated");
    expect(updated.topic).toEqual({
      path: "indexes/btree",
      title: "B+ tree",
      lesson: "02-btree",
      enteredAt: "2026-01-03T00:00:00.000Z",
      current: true,
      children: [],
    });
    expect(updated.topics[0]?.children.map((topic) => topic.current)).toEqual([
      true,
      false,
    ]);
  });

  test("validates topic paths", () => {
    expect(isValidTopicPath("indexes/btree")).toBe(true);
    expect(isValidTopicPath("indexes")).toBe(true);
    expect(isValidTopicPath("")).toBe(false);
    expect(isValidTopicPath("/indexes")).toBe(false);
    expect(isValidTopicPath("indexes/")).toBe(false);
    expect(isValidTopicPath("indexes//btree")).toBe(false);
    expect(isValidTopicPath("indexes/..")).toBe(false);
    expect(isValidTopicPath("indexes\\btree")).toBe(false);

    expect(() => upsertTopicTree([], { path: " " })).toThrow(
      "Topic path cannot be empty.",
    );
    expect(() => upsertTopicTree([], { path: "indexes//btree" })).toThrow(
      "Invalid topic path: indexes//btree.",
    );
  });

  test("writes topic tree and validates lesson ids", async () => {
    const coursesDir = await mkdtemp(join(tmpdir(), "overlearn-topic-"));
    const env = { OVERLEARN_COURSES_DIR: coursesDir };

    try {
      const paths = await ensureCourseScaffold("topic", env);
      await writeFile(join(paths.lessonsDir, "02-btree.md"), "# B-tree\n", "utf8");

      await expect(
        upsertTopic(paths.courseDir, {
          path: "indexes/hash",
          lesson: "missing",
        }),
      ).rejects.toThrow("Lesson does not exist: missing");

      const mutation = await upsertTopic(
        paths.courseDir,
        {
          path: "indexes/btree",
          title: "B-tree",
          lesson: "02-btree",
        },
        new Date("2026-01-01T00:00:00Z"),
      );

      expect(mutation.action).toBe("created");
      await expect(readCourseManifest(paths.courseDir)).resolves.toMatchObject({
        topics: [
          {
            path: "indexes",
            children: [
              {
                path: "indexes/btree",
                title: "B-tree",
                lesson: "02-btree",
                current: true,
              },
            ],
          },
        ],
      });
    } finally {
      await rm(coursesDir, { force: true, recursive: true });
    }
  });

  test("rejects legacy non-empty flat topic arrays", async () => {
    const coursesDir = await mkdtemp(join(tmpdir(), "overlearn-topic-"));
    const env = { OVERLEARN_COURSES_DIR: coursesDir };

    try {
      const paths = await ensureCourseScaffold("legacy", env);
      await writeFile(
        paths.courseJson,
        JSON.stringify(
          {
            formatVersion: 1,
            name: "legacy",
            createdAt: "2026-01-01T00:00:00.000Z",
            topics: ["indexes"],
          },
          null,
          2,
        ),
        "utf8",
      );

      await expect(readCourseManifest(paths.courseDir)).rejects.toThrow(
        "legacy flat topic arrays are no longer supported",
      );
    } finally {
      await rm(coursesDir, { force: true, recursive: true });
    }
  });
});

describe("turn event storage", () => {
  test("parses message and nav events in stored order", async () => {
    const coursesDir = await mkdtemp(join(tmpdir(), "overlearn-events-"));
    const env = { OVERLEARN_COURSES_DIR: coursesDir };

    try {
      const paths = await ensureCourseScaffold("events", env);
      await writePendingEvents(paths.courseDir, [
        { type: "message", text: "hello" },
        { type: "nav", path: "indexes/btree" },
      ]);

      await expect(readPendingEvents(paths.courseDir)).resolves.toEqual([
        { type: "message", text: "hello" },
        { type: "nav", path: "indexes/btree" },
      ]);
    } finally {
      await rm(coursesDir, { force: true, recursive: true });
    }
  });
});

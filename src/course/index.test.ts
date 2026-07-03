import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  appendMasteryScore,
  clearActiveFeynmanCheck,
  ensureCourseScaffold,
  isValidConceptId,
  isValidDemoFileName,
  isValidTopicPath,
  parseKeyPointsText,
  readActiveFeynmanCheck,
  readCourseManifest,
  readMastery,
  readPendingEvents,
  registerFeynmanCheck,
  registerDemo,
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

describe("demo storage", () => {
  test("validates demo file names", () => {
    expect(isValidDemoFileName("growth.html")).toBe(true);
    expect(isValidDemoFileName("nested/growth.html")).toBe(false);
    expect(isValidDemoFileName("../growth.html")).toBe(false);
    expect(isValidDemoFileName("growth.htm")).toBe(false);
    expect(isValidDemoFileName("growth.html/extra")).toBe(false);
    expect(isValidDemoFileName("growth\\demo.html")).toBe(false);
  });

  test("registers demos under explicit, current, and unassigned topics", async () => {
    const coursesDir = await mkdtemp(join(tmpdir(), "overlearn-demo-"));
    const env = { OVERLEARN_COURSES_DIR: coursesDir };

    try {
      const paths = await ensureCourseScaffold("demos", env);
      await writeFile(join(paths.demosDir, "growth.html"), "<h1>Growth</h1>", "utf8");
      await writeFile(join(paths.demosDir, "rates.html"), "<h1>Rates</h1>", "utf8");
      await writeFile(join(paths.demosDir, "loose.html"), "<h1>Loose</h1>", "utf8");

      await expect(
        registerDemo(paths.courseDir, { file: "../secret.html" }),
      ).rejects.toThrow("Invalid demo file");

      await expect(
        registerDemo(paths.courseDir, { file: "missing.html" }),
      ).rejects.toThrow("Demo file does not exist: demos/missing.html");

      const unassigned = await registerDemo(
        paths.courseDir,
        { file: "loose.html", title: "Loose demo" },
        new Date("2026-01-01T00:00:00Z"),
      );

      expect(unassigned).toEqual({
        action: "created",
        demo: {
          file: "loose.html",
          title: "Loose demo",
          addedAt: "2026-01-01T00:00:00.000Z",
        },
        topics: [],
        unassignedDemos: [
          {
            file: "loose.html",
            title: "Loose demo",
            addedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      });

      await upsertTopic(
        paths.courseDir,
        { path: "finance/rule-of-72", title: "Rule of 72" },
        new Date("2026-01-02T00:00:00Z"),
      );

      const current = await registerDemo(
        paths.courseDir,
        { file: "growth.html", title: "Growth curve" },
        new Date("2026-01-03T00:00:00Z"),
      );

      expect(current.topic?.path).toBe("finance/rule-of-72");
      expect(current.demo).toEqual({
        file: "growth.html",
        title: "Growth curve",
        addedAt: "2026-01-03T00:00:00.000Z",
      });

      await upsertTopic(
        paths.courseDir,
        { path: "finance/rates", title: "Rates" },
        new Date("2026-01-04T00:00:00Z"),
      );

      const explicit = await registerDemo(
        paths.courseDir,
        { file: "rates.html", topic: "finance/rule-of-72" },
        new Date("2026-01-05T00:00:00Z"),
      );

      expect(explicit.topic?.path).toBe("finance/rule-of-72");
      expect(explicit.topic?.demos).toEqual([
        {
          file: "growth.html",
          title: "Growth curve",
          addedAt: "2026-01-03T00:00:00.000Z",
        },
        {
          file: "rates.html",
          addedAt: "2026-01-05T00:00:00.000Z",
        },
      ]);

      await expect(
        registerDemo(paths.courseDir, {
          file: "growth.html",
          topic: "finance/missing",
        }),
      ).rejects.toThrow("Topic does not exist: finance/missing");

      const manifest = await readCourseManifest(paths.courseDir);
      const finance = manifest.topics.find((topic) => topic.path === "finance");
      const ruleOf72 = finance?.children.find(
        (topic) => topic.path === "finance/rule-of-72",
      );

      expect(manifest.unassignedDemos).toEqual([
        {
          file: "loose.html",
          title: "Loose demo",
          addedAt: "2026-01-01T00:00:00.000Z",
        },
      ]);
      expect(ruleOf72?.demos).toEqual([
        {
          file: "growth.html",
          title: "Growth curve",
          addedAt: "2026-01-03T00:00:00.000Z",
        },
        {
          file: "rates.html",
          addedAt: "2026-01-05T00:00:00.000Z",
        },
      ]);
    } finally {
      await rm(coursesDir, { force: true, recursive: true });
    }
  });
});

describe("feynman and mastery storage", () => {
  test("validates concept ids and parses key point text", () => {
    expect(isValidConceptId("rule-of-72")).toBe(true);
    expect(isValidConceptId("rule-72")).toBe(true);
    expect(isValidConceptId("Rule-of-72")).toBe(false);
    expect(isValidConceptId("rule_of_72")).toBe(false);
    expect(isValidConceptId("rule/of/72")).toBe(false);
    expect(isValidConceptId("")).toBe(false);

    expect(parseKeyPointsText("mechanism, example; limitation")).toEqual([
      "mechanism",
      "example",
      "limitation",
    ]);
    expect(parseKeyPointsText(" , ; ")).toEqual([]);
  });

  test("persists active Feynman checks and records replacements", async () => {
    const coursesDir = await mkdtemp(join(tmpdir(), "overlearn-feynman-"));
    const env = { OVERLEARN_COURSES_DIR: coursesDir };

    try {
      const paths = await ensureCourseScaffold("feynman", env);

      const first = await registerFeynmanCheck(
        paths.courseDir,
        {
          concept: "rule-of-72",
          prompt: "Explain why 72 works.",
          keyPoints: ["growth rate", "doubling"],
        },
        new Date("2026-01-01T00:00:00Z"),
      );

      expect(first).toEqual({
        concept: "rule-of-72",
        prompt: "Explain why 72 works.",
        keyPoints: ["growth rate", "doubling"],
        issuedAt: "2026-01-01T00:00:00.000Z",
      });
      await expect(readActiveFeynmanCheck(paths.courseDir)).resolves.toEqual(
        first,
      );

      const second = await registerFeynmanCheck(
        paths.courseDir,
        {
          concept: "compound-growth",
          prompt: "Explain compounding.",
        },
        new Date("2026-01-02T00:00:00Z"),
      );

      expect(second).toEqual({
        concept: "compound-growth",
        prompt: "Explain compounding.",
        keyPoints: [],
        issuedAt: "2026-01-02T00:00:00.000Z",
        replaced: {
          concept: "rule-of-72",
          issuedAt: "2026-01-01T00:00:00.000Z",
          replacedAt: "2026-01-02T00:00:00.000Z",
        },
      });

      await clearActiveFeynmanCheck(paths.courseDir);
      await expect(
        readActiveFeynmanCheck(paths.courseDir),
      ).resolves.toBeUndefined();
    } finally {
      await rm(coursesDir, { force: true, recursive: true });
    }
  });

  test("appends mastery score history without overwriting entries", async () => {
    const coursesDir = await mkdtemp(join(tmpdir(), "overlearn-mastery-"));
    const env = { OVERLEARN_COURSES_DIR: coursesDir };

    try {
      const paths = await ensureCourseScaffold("mastery", env);

      const first = await appendMasteryScore(
        paths.courseDir,
        {
          concept: "rule-of-72",
          score: 72,
          gaps: "missed the logarithm approximation",
        },
        new Date("2026-01-01T00:00:00Z"),
      );
      const second = await appendMasteryScore(
        paths.courseDir,
        {
          concept: "rule-of-72",
          score: 85,
        },
        new Date("2026-01-01T00:00:00Z"),
      );

      expect(first).toEqual({
        concept: "rule-of-72",
        score: 72,
        gaps: "missed the logarithm approximation",
        at: "2026-01-01T00:00:00.000Z",
      });
      expect(second).toEqual({
        concept: "rule-of-72",
        score: 85,
        at: "2026-01-01T00:00:00.001Z",
      });
      await expect(readMastery(paths.courseDir)).resolves.toEqual([
        first,
        second,
      ]);

      await expect(
        appendMasteryScore(paths.courseDir, {
          concept: "rule-of-72",
          score: 101,
        }),
      ).rejects.toThrow("Mastery score must be an integer from 0 to 100.");
    } finally {
      await rm(coursesDir, { force: true, recursive: true });
    }
  });
});

describe("turn event storage", () => {
  test("parses message, nav, and feynman-answer events in stored order", async () => {
    const coursesDir = await mkdtemp(join(tmpdir(), "overlearn-events-"));
    const env = { OVERLEARN_COURSES_DIR: coursesDir };

    try {
      const paths = await ensureCourseScaffold("events", env);
      await writePendingEvents(paths.courseDir, [
        { type: "message", text: "hello" },
        { type: "nav", path: "indexes/btree" },
        {
          type: "feynman-answer",
          concept: "rule-of-72",
          text: "It estimates doubling time.",
          keyPoints: ["rate", "doubling"],
        },
      ]);

      await expect(readPendingEvents(paths.courseDir)).resolves.toEqual([
        { type: "message", text: "hello" },
        { type: "nav", path: "indexes/btree" },
        {
          type: "feynman-answer",
          concept: "rule-of-72",
          text: "It estimates doubling time.",
          keyPoints: ["rate", "doubling"],
        },
      ]);
    } finally {
      await rm(coursesDir, { force: true, recursive: true });
    }
  });
});

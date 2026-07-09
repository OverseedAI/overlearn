import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  appendJournalEntry,
  appendMasteryEvent,
  appendTranscriptEntry,
  appendTurnEvents,
  createCourse,
  flattenTopicTree,
  getCourse,
  getActiveFeynmanCheck,
  listDemos,
  listFeynmanChecks,
  listGlossary,
  listJournalEntries,
  listMasteryEvents,
  listTurnEvents,
  openStore,
  pageTranscript,
  readTopicTree,
  registerFeynmanCheck,
  replaceTopicTree,
  upsertDemo,
  upsertGlossaryEntry,
  type Store,
  type Topic,
} from "./index";
import { BUNDLE_FORMAT, exportCourseBundle, importCoursePath } from "./bundle";

const withTempStore = async (
  run: (store: Store, dir: string) => void | Promise<void>,
): Promise<void> => {
  const dir = await mkdtemp(join(tmpdir(), "overlearn-bundle-store-"));
  const store = openStore({ databasePath: join(dir, "overlearn.sqlite") });

  try {
    await run(store, dir);
  } finally {
    store.close();
    await rm(dir, { force: true, recursive: true });
  }
};

const writeJson = async (filePath: string, value: unknown): Promise<void> => {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
};

const allTranscriptEntries = (store: Store, courseId: number) => {
  let afterId: number | undefined;
  const entries = [];

  while (true) {
    const page = pageTranscript(store, courseId, {
      ...(afterId === undefined ? {} : { afterId }),
      limit: 50,
    });
    entries.push(...page.entries);
    if (page.nextAfterId === null) {
      return entries;
    }

    afterId = page.nextAfterId;
  }
};

const topicSnapshot = (topic: Topic): unknown => ({
  path: topic.path,
  title: topic.title,
  body: topic.body,
  status: topic.status,
  enteredAt: topic.enteredAt,
  isCurrent: topic.isCurrent,
  state: topic.state,
  masteryConcept: topic.masteryConcept,
  position: topic.position,
  children: topic.children.map(topicSnapshot),
});

const topicPathById = (store: Store, courseId: number): ReadonlyMap<number, string> =>
  new Map(
    flattenTopicTree(readTopicTree(store, courseId)).map((topic) => [
      topic.id,
      topic.path,
    ]),
  );

const courseSnapshot = (store: Store, courseId: number) => {
  const course = getCourse(store, courseId);
  if (course === undefined) {
    throw new Error(`Missing course ${courseId}.`);
  }

  const topics = readTopicTree(store, courseId);
  const flatTopics = flattenTopicTree(topics);
  const topicPaths = topicPathById(store, courseId);
  const demos = listDemos(store, courseId);
  const demoFileNameById = new Map(demos.map((demo) => [demo.id, demo.fileName]));

  return {
    course: {
      title: course.title,
      description: course.description,
      status: course.status,
      harnessId: course.harnessId,
      attachedDir: course.attachedDir,
      webSearchEnabled: course.webSearchEnabled,
      sourceName: course.sourceName,
      manifestExtra: course.manifestExtra,
    },
    topics: topics.map(topicSnapshot),
    journals: flatTopics.flatMap((topic) =>
      listJournalEntries(store, courseId, topic.id).map((entry) => ({
        topicPath: topic.path,
        kind: entry.kind,
        bodyMarkdown: entry.bodyMarkdown,
        demoFileName:
          entry.demoId === null ? null : demoFileNameById.get(entry.demoId) ?? null,
        turn: entry.turn,
        createdAt: entry.createdAt,
      })),
    ),
    glossary: listGlossary(store, courseId).map((entry) => ({
      term: entry.term,
      definition: entry.definition,
      topicPath: entry.topicId === null ? null : topicPaths.get(entry.topicId) ?? null,
      addedAt: entry.addedAt,
    })),
    mastery: listMasteryEvents(store, courseId).map((entry) => ({
      concept: entry.concept,
      score: entry.score,
      gaps: entry.gaps,
      ts: entry.ts,
      topicPath: entry.topicId === null ? null : topicPaths.get(entry.topicId) ?? null,
    })),
    feynman: listFeynmanChecks(store, courseId).map((check) => ({
      concept: check.concept,
      prompt: check.prompt,
      keyPoints: check.keyPoints,
      issuedAt: check.issuedAt,
      status: check.status,
      topicPath: check.topicId === null ? null : topicPaths.get(check.topicId) ?? null,
      replacedConcept: check.replacedConcept,
      replacedIssuedAt: check.replacedIssuedAt,
      replacedAt: check.replacedAt,
    })),
    demos: demos
      .map((demo) => ({
        fileName: demo.fileName,
        title: demo.title,
        body: demo.body,
        bodyFormat: demo.bodyFormat,
        addedAt: demo.addedAt,
        position: demo.position,
        topicPath: demo.topicId === null ? null : topicPaths.get(demo.topicId) ?? null,
      }))
      .sort((left, right) =>
        [
          left.topicPath ?? "",
          String(left.position),
          left.fileName ?? "",
          left.title ?? "",
        ]
          .join("\0")
          .localeCompare(
            [
              right.topicPath ?? "",
              String(right.position),
              right.fileName ?? "",
              right.title ?? "",
            ].join("\0"),
          ),
      ),
    transcript: allTranscriptEntries(store, courseId).map((entry) => ({
      turn: entry.turn,
      role: entry.role,
      kind: entry.kind,
      content: entry.content,
      payload: entry.payload,
      topicPath: entry.topicId === null ? null : topicPaths.get(entry.topicId) ?? null,
      ts: entry.ts,
    })),
    turnEvents: listTurnEvents(store, courseId).map((entry) => ({
      turn: entry.turn,
      status: entry.status,
      createdAt: entry.createdAt,
      events: entry.events,
      importedFrom: entry.importedFrom,
    })),
  };
};

describe("course bundle export/import", () => {
  test("round-trips full course state through a portable directory", async () => {
    await withTempStore(async (store) => {
      const course = createCourse(store, {
        title: "Rule of 72",
        description: "Mental compound-interest math.",
        harnessId: "codex",
        model: "gpt-5.6-sol",
        effort: "high",
        attachedDir: "/tmp/source",
        webSearchEnabled: true,
        status: "active",
        sourceName: "rule-of-72",
        manifestExtra: { preserved: true },
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      });

      replaceTopicTree(store, course.id, [
        {
          path: "finance",
          title: "Finance",
          body: "Finance foundations.",
          masteryConcept: "finance",
          position: 0,
          children: [
            {
              path: "finance/rule-of-72",
              title: "Rule of 72",
              body: "Estimate doubling time.",
              enteredAt: "2026-01-02T00:00:00.000Z",
              isCurrent: true,
              masteryConcept: "rule-of-72",
              position: 0,
            },
          ],
        },
      ]);
      const topics = flattenTopicTree(readTopicTree(store, course.id));
      const ruleTopic = topics.find((topic) => topic.path === "finance/rule-of-72");
      if (ruleTopic === undefined) {
        throw new Error("Missing test topic.");
      }

      appendMasteryEvent(store, course.id, {
        concept: "custom-rule",
        topicId: ruleTopic.id,
        score: 66,
        gaps: "missed percentage conversion",
        ts: "2026-01-03T00:00:00.000Z",
      });
      appendMasteryEvent(store, course.id, {
        concept: "rule-of-72",
        score: 88,
        ts: "2026-01-04T00:00:00.000Z",
      });
      upsertGlossaryEntry(store, course.id, {
        term: "Doubling time",
        definition: "How long until a quantity doubles.",
        topicId: ruleTopic.id,
        addedAt: "2026-01-05T00:00:00.000Z",
      });
      registerFeynmanCheck(store, course.id, {
        concept: "rule-of-72",
        prompt: "Explain the estimate.",
        keyPoints: ["72", "rate"],
        topicId: ruleTopic.id,
        issuedAt: "2026-01-06T00:00:00.000Z",
      });
      registerFeynmanCheck(store, course.id, {
        concept: "compound-growth",
        prompt: "Explain compounding.",
        keyPoints: ["rate", "time"],
        topicId: ruleTopic.id,
        issuedAt: "2026-01-07T00:00:00.000Z",
      });
      expect(getActiveFeynmanCheck(store, course.id)?.concept).toBe(
        "compound-growth",
      );

      const growthDemo = upsertDemo(store, course.id, {
        topicId: ruleTopic.id,
        fileName: "growth.html",
        title: "Growth curve",
        body: "<h1>Growth</h1>",
        bodyFormat: "html",
        addedAt: "2026-01-08T00:00:00.000Z",
        position: 0,
      });
      appendJournalEntry(store, course.id, {
        topicId: ruleTopic.id,
        kind: "note",
        bodyMarkdown: "# Rule of 72\n\nDivide 72 by the growth rate.\n",
        turn: 1,
        createdAt: "2026-01-08T00:01:00.000Z",
      });
      appendJournalEntry(store, course.id, {
        topicId: ruleTopic.id,
        kind: "demo",
        demoId: growthDemo.id,
        turn: 1,
        createdAt: "2026-01-08T00:02:00.000Z",
      });
      upsertDemo(store, course.id, {
        fileName: "loose.md",
        title: "Loose demo",
        body: "# Loose\n",
        bodyFormat: "markdown",
        addedAt: "2026-01-09T00:00:00.000Z",
        position: 1,
      });
      appendTranscriptEntry(store, course.id, {
        turn: 1,
        role: "learner",
        kind: "text",
        content: "Teach me.",
        payload: { role: "learner", text: "Teach me." },
        ts: "2026-01-10T00:00:00.000Z",
      });
      appendTranscriptEntry(store, course.id, {
        turn: 1,
        role: "agent",
        kind: "lesson",
        content: "01-rule-of-72",
        payload: { role: "agent", kind: "lesson", lesson: "01-rule-of-72" },
        ts: "2026-01-10T00:01:00.000Z",
      });
      appendTurnEvents(store, course.id, {
        turn: 1,
        status: "completed",
        createdAt: "2026-01-11T00:00:00.000Z",
        events: [{ type: "message", text: "Teach me." }],
        importedFrom: null,
      });

      const original = courseSnapshot(store, course.id);
      const exported = await exportCourseBundle(store, course.id, {
        includeTranscript: true,
      });
      const secondExport = await exportCourseBundle(store, course.id);

      expect(exported.path).toBe(
        join(store.dataDir, "exports", "overlearn-rule-of-72-1"),
      );
      expect(secondExport.path).toBe(
        join(store.dataDir, "exports", "overlearn-rule-of-72-2"),
      );

      const manifest = JSON.parse(
        await readFile(join(exported.path, "course.json"), "utf8"),
      ) as Record<string, unknown>;
      expect(manifest["format"]).toBe(BUNDLE_FORMAT);
      expect(
        (manifest["course"] as Record<string, unknown>)["webSearchEnabled"],
      ).toBe(true);
      expect(manifest["lessons"]).toBeUndefined();
      expect(manifest["journals"]).toEqual([
        expect.objectContaining({
          topicPath: "finance/rule-of-72",
          kind: "note",
          bodyMarkdown: "# Rule of 72\n\nDivide 72 by the growth rate.\n",
          demoFile: null,
        }),
        expect.objectContaining({
          topicPath: "finance/rule-of-72",
          kind: "demo",
          bodyMarkdown: null,
          demoFile: "demos/002-growth.html",
        }),
      ]);
      expect(await readdir(join(exported.path, "topics"))).toContain(
        "001-finance.md",
      );
      expect(await readdir(join(exported.path, "demos"))).toEqual(
        expect.arrayContaining(["001-loose.md", "002-growth.html"]),
      );
      expect(await readFile(join(exported.path, "transcript.jsonl"), "utf8")).toContain(
        '"content":"Teach me."',
      );

      const imported = await importCoursePath(store, exported.path);

      expect(imported.source).toBe("bundle");
      expect(imported.warnings).toEqual([]);
      expect(courseSnapshot(store, imported.course.id)).toEqual(original);
    });
  });

  test("auto-detects legacy folders and validates import paths", async () => {
    await withTempStore(async (store, dir) => {
      const legacy = join(dir, "legacy-course");
      await mkdir(legacy, { recursive: true });
      await writeJson(join(legacy, "course.json"), {
        title: "Legacy Course",
        name: "legacy-course",
        topics: [{ path: "intro", title: "Intro", current: false }],
      });

      const result = await importCoursePath(store, legacy);

      expect(result.source).toBe("legacy");
      expect(result.course.title).toBe("Legacy Course");
      expect(result.warnings).toContain("Imported topic tree has no current topic.");
      await expect(importCoursePath(store, "relative/path")).rejects.toThrow(
        "path must be an absolute directory path.",
      );
      await expect(importCoursePath(store, join(dir, "missing"))).rejects.toThrow(
        "path does not exist:",
      );
    });
  });
});

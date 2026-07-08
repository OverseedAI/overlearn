import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

import {
  appendJournalEntry,
  appendMasteryEvent,
  appendTranscriptEntry,
  clearActiveFeynmanCheck,
  createCourse,
  deleteCourse,
  endSession,
  flattenTopicTree,
  getActiveFeynmanCheck,
  getProfile,
  getStorePath,
  importCourseFolder,
  latestMasteryForTopic,
  listJournalEntries,
  listCourses,
  listDemos,
  listFeynmanChecks,
  listGlossary,
  listLatestMasteryScores,
  listSessions,
  listTopicsDueForReview,
  listTurnEvents,
  openStore,
  pageTranscript,
  pageTranscriptBefore,
  patchCourse,
  patchProfile,
  readTopicTree,
  registerFeynmanCheck,
  replaceTopicTree,
  startSession,
  STORE_SCHEMA_VERSION,
  upsertDemo,
  upsertGlossaryEntry,
  upsertTopic,
  withStoreTransaction,
  type Store,
} from "./index";

const withTempStore = async (
  run: (store: Store, dir: string) => void | Promise<void>,
): Promise<void> => {
  const dir = await mkdtemp(join(tmpdir(), "overlearn-store-"));
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

describe("store migrations", () => {
  test("fresh open creates the app-data database, WAL, profile, and migrations", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "overlearn-data-dir-"));
    const store = openStore({ env: { OVERLEARN_DATA_DIR: dataDir } });

    try {
      expect(store.path).toBe(join(dataDir, "overlearn.sqlite"));
      expect(getStorePath({ OVERLEARN_DATA_DIR: dataDir })).toBe(store.path);

      const journal = store.db.query("PRAGMA journal_mode").get() as {
        journal_mode: string;
      };
      expect(journal.journal_mode).toBe("wal");

      const migrations = store.db
        .query("SELECT id, name FROM migrations ORDER BY id")
        .all();
      expect(migrations).toEqual([
        { id: STORE_SCHEMA_VERSION, name: "store_schema_v2" },
      ]);

      expect(getProfile(store)).toMatchObject({
        name: null,
        onboardingState: "new",
        settings: {},
        preferredHarness: null,
      });
    } finally {
      store.close();
      await rm(dataDir, { force: true, recursive: true });
    }
  });

  test("re-open is idempotent and preserves data", async () => {
    const dir = await mkdtemp(join(tmpdir(), "overlearn-reopen-"));
    const databasePath = join(dir, "store.sqlite");
    const first = openStore({ databasePath });
    const course = createCourse(first, {
      title: "Reopen Course",
      status: "active",
    });
    first.close();

    const second = openStore({ databasePath });
    try {
      const migrationCount = second.db
        .query("SELECT COUNT(*) AS count FROM migrations")
        .get() as { count: number };

      expect(migrationCount.count).toBe(1);
      expect(listCourses(second)).toMatchObject([
        {
          id: course.id,
          title: "Reopen Course",
          status: "active",
        },
      ]);
    } finally {
      second.close();
      await rm(dir, { force: true, recursive: true });
    }
  });

  test("wipes an old-version database on open with a clear warning", async () => {
    const dir = await mkdtemp(join(tmpdir(), "overlearn-wipe-"));
    const databasePath = join(dir, "store.sqlite");
    const old = new Database(databasePath, { create: true, strict: true });
    old.exec(`
      CREATE TABLE migrations (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
      INSERT INTO migrations (id, name, applied_at)
      VALUES (1, 'initial_store', '2026-01-01T00:00:00.000Z');
      CREATE TABLE lessons (
        id INTEGER PRIMARY KEY,
        body_markdown TEXT NOT NULL
      );
      INSERT INTO lessons (id, body_markdown) VALUES (1, 'legacy');
    `);
    old.close();

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message?: unknown) => {
      warnings.push(String(message));
    };

    const store = openStore({ databasePath });
    try {
      expect(warnings).toEqual([
        `Overlearn store schema changed to v${STORE_SCHEMA_VERSION}; wiping old database and recreating.`,
      ]);
      expect(
        store.db
          .query("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'lessons'")
          .all(),
      ).toEqual([]);
      expect(getProfile(store).onboardingState).toBe("new");
    } finally {
      console.warn = originalWarn;
      store.close();
      await rm(dir, { force: true, recursive: true });
    }
  });
});

describe("store query API", () => {
  test("round-trips CRUD, topic trees, mastery review, and satellite records", async () => {
    await withTempStore((store) => {
      const profile = patchProfile(store, {
        name: "Hal",
        onboardingState: "complete",
        preferredHarness: "codex",
        settings: { reviewLimit: 3 },
      });
      expect(profile).toMatchObject({
        name: "Hal",
        onboardingState: "complete",
        preferredHarness: "codex",
        settings: { reviewLimit: 3 },
      });

      const course = createCourse(store, {
        title: "Finance",
        description: "Mental math",
        status: "active",
        harnessId: "codex",
      });
      const activeCourse = patchCourse(store, course.id, { description: "Mental math." });
      expect(activeCourse.status).toBe("active");

      const firstTopic = upsertTopic(store, course.id, {
        path: "finance/rule-of-72",
        title: "Rule of 72",
        body: "Estimate doubling time.",
      });
      const secondTopic = upsertTopic(store, course.id, {
        path: "finance/rates",
        title: "Rates",
      });

      expect(firstTopic.path).toBe("finance/rule-of-72");
      expect(secondTopic.isCurrent).toBe(true);

      const tree = readTopicTree(store, course.id);
      expect(tree).toMatchObject([
        {
          path: "finance",
          state: "frontier",
          children: [
            {
              path: "finance/rule-of-72",
              isCurrent: false,
              state: "visited",
            },
            { path: "finance/rates", isCurrent: true, state: "current" },
          ],
        },
      ]);

      appendMasteryEvent(store, course.id, {
        concept: "finance",
        score: 40,
        ts: "2026-01-01T00:00:00.000Z",
      });
      appendMasteryEvent(store, course.id, {
        concept: "rule-of-72",
        score: 70,
        gaps: "forgot rate as a percentage",
        ts: "2026-01-02T00:00:00.000Z",
      });
      appendMasteryEvent(store, course.id, {
        concept: "rule-of-72",
        score: 85,
        ts: "2026-01-03T00:00:00.000Z",
      });
      appendMasteryEvent(store, course.id, {
        concept: "finance/rates",
        score: 50,
        ts: "2026-01-03T12:00:00.000Z",
      });

      expect(listLatestMasteryScores(store, course.id)).toMatchObject([
        { concept: "finance", score: 40 },
        { concept: "finance/rates", score: 50 },
        { concept: "rule-of-72", score: 85 },
      ]);
      expect(
        latestMasteryForTopic(store, course.id, "finance/rule-of-72"),
      ).toMatchObject({ concept: "rule-of-72", score: 85 });
      expect(
        listTopicsDueForReview(store, course.id, {
          includeUnscored: false,
          masteryThreshold: 80,
          limit: 3,
        }).map((entry) => entry.topic.path),
      ).toEqual(["finance/rates"]);

      expect(
        upsertGlossaryEntry(store, course.id, {
          term: "Doubling time",
          definition: "Time for a quantity to double.",
          topicId: firstTopic.id,
          addedAt: "2026-01-04T00:00:00.000Z",
        }),
      ).toMatchObject({ term: "Doubling time", topicId: firstTopic.id });
      expect(
        upsertGlossaryEntry(store, course.id, {
          term: "doubling time",
          definition: "Updated.",
        }),
      ).toMatchObject({
        term: "doubling time",
        definition: "Updated.",
        topicId: firstTopic.id,
      });
      expect(listGlossary(store, course.id)).toHaveLength(1);

      const activeCheck = registerFeynmanCheck(store, course.id, {
        concept: "rule-of-72",
        prompt: "Explain why 72 works.",
        keyPoints: ["rate", "doubling"],
        issuedAt: "2026-01-05T00:00:00.000Z",
      });
      expect(activeCheck.status).toBe("active");
      expect(getActiveFeynmanCheck(store, course.id)?.concept).toBe("rule-of-72");
      clearActiveFeynmanCheck(store, course.id);
      expect(getActiveFeynmanCheck(store, course.id)).toBeNull();

      const demo = upsertDemo(store, course.id, {
        topicId: firstTopic.id,
        fileName: "growth.html",
        title: "Growth curve",
        body: "<h1>Growth</h1>",
        bodyFormat: "html",
        addedAt: "2026-01-06T00:00:00.000Z",
      });
      expect(listDemos(store, course.id)).toMatchObject([
        {
          fileName: "growth.html",
          title: "Growth curve",
          bodyFormat: "html",
        },
      ]);

      appendJournalEntry(store, course.id, {
        topicId: firstTopic.id,
        kind: "note",
        bodyMarkdown: "# Rule of 72\n",
        turn: 1,
        createdAt: "2026-01-06T00:01:00.000Z",
      });
      appendJournalEntry(store, course.id, {
        topicId: firstTopic.id,
        kind: "demo",
        demoId: demo.id,
        turn: 1,
        createdAt: "2026-01-06T00:02:00.000Z",
      });
      appendJournalEntry(store, course.id, {
        topicId: firstTopic.id,
        kind: "summary",
        bodyMarkdown: "Divide 72 by the percent rate.",
        turn: 2,
        createdAt: "2026-01-06T00:03:00.000Z",
      });
      expect(listJournalEntries(store, course.id, firstTopic.id)).toMatchObject([
        {
          kind: "note",
          bodyMarkdown: "# Rule of 72\n",
          demoId: null,
          turn: 1,
        },
        {
          kind: "demo",
          bodyMarkdown: null,
          demoId: demo.id,
          turn: 1,
        },
        {
          kind: "summary",
          bodyMarkdown: "Divide 72 by the percent rate.",
          demoId: null,
          turn: 2,
        },
      ]);
      expect(() =>
        store.db
          .query(
            `
              INSERT INTO topic_journal_entries (
                course_id,
                topic_id,
                kind,
                body_markdown,
                demo_id,
                created_at
              )
              VALUES (?1, ?2, 'demo', ?3, NULL, ?4)
            `,
          )
          .run(
            course.id,
            firstTopic.id,
            "demo bodies are invalid",
            "2026-01-06T00:04:00.000Z",
          ),
      ).toThrow();

      const firstTranscriptEntry = appendTranscriptEntry(store, course.id, {
        role: "learner",
        content: "What is the rule?",
        ts: "2026-01-07T00:00:00.000Z",
      });
      const secondTranscriptEntry = appendTranscriptEntry(store, course.id, {
        role: "agent",
        kind: "lesson",
        content: "01-rule-of-72",
        payload: {
          role: "agent",
          kind: "lesson",
          lesson: "01-rule-of-72",
          at: "2026-01-07T00:01:00.000Z",
        },
        ts: "2026-01-07T00:01:00.000Z",
      });
      const transcriptPage = pageTranscript(store, course.id, { limit: 1 });
      expect(transcriptPage.entries).toHaveLength(1);
      expect(transcriptPage.entries[0]?.topicId).toBe(secondTopic.id);
      expect(transcriptPage.nextAfterId).not.toBeNull();
      expect(
        pageTranscript(store, course.id, {
          afterId: transcriptPage.nextAfterId ?? 0,
          limit: 10,
        }).entries,
      ).toHaveLength(1);
      const beforeTranscriptPage = pageTranscriptBefore(store, course.id, {
        beforeId: secondTranscriptEntry.id,
        limit: 1,
      });
      expect(beforeTranscriptPage.entries).toEqual([firstTranscriptEntry]);
      expect(beforeTranscriptPage.hasMore).toBe(false);
      expect(beforeTranscriptPage.nextBeforeId).toBe(firstTranscriptEntry.id);

      const session = startSession(store, {
        courseId: course.id,
        harnessId: "codex",
        startedAt: "2026-01-08T00:00:00.000Z",
      });
      expect(
        endSession(
          store,
          session.id,
          "complete",
          "2026-01-08T00:30:00.000Z",
        ),
      ).toMatchObject({ endReason: "complete" });
      expect(listSessions(store, course.id)).toHaveLength(1);

      deleteCourse(store, course.id);
      expect(listCourses(store)).toEqual([]);
    });
  });

  test("replaceTopicTree writes nested positions atomically", async () => {
    await withTempStore((store) => {
      const course = createCourse(store, { title: "Tree" });
      replaceTopicTree(store, course.id, [
        {
          path: "a",
          title: "A",
          children: [
            { path: "a/b", title: "B", isCurrent: true },
            { path: "a/c", title: "C" },
          ],
        },
      ]);

      expect(
        flattenTopicTree(readTopicTree(store, course.id)).map((topic) => [
          topic.path,
          topic.position,
          topic.isCurrent,
          topic.state,
        ]),
      ).toEqual([
        ["a", 0, false, "frontier"],
        ["a/b", 0, true, "current"],
        ["a/c", 1, false, "frontier"],
      ]);
    });
  });

  test("transaction rolls back a forced mid-write failure", async () => {
    await withTempStore((store) => {
      expect(() =>
        withStoreTransaction(store, () => {
          createCourse(store, { title: "Half-written" });
          createCourse(store, { title: "Also half-written" });
          throw new Error("forced failure");
        }),
      ).toThrow("forced failure");

      expect(listCourses(store)).toEqual([]);
    });
  });
});

describe("folder importer", () => {
  test("imports a real course folder layout without dropping stored data", async () => {
    await withTempStore(async (store, dir) => {
      const fixture = join(dir, "rule-of-72-course");
      await mkdir(join(fixture, "lessons"), { recursive: true });
      await mkdir(join(fixture, "demos"), { recursive: true });
      await mkdir(join(fixture, ".overlearn", "turns"), { recursive: true });

      await writeJson(join(fixture, "course.json"), {
        formatVersion: 1,
        name: "rule-of-72",
        title: "Rule of 72",
        description: "Mental compound-interest math.",
        createdAt: "2026-01-01T00:00:00.000Z",
        harness: "codex",
        workingDirectory: "../finance-app",
        preservedUnknown: { yes: true },
        topics: [
          {
            path: "finance",
            title: "Finance",
            current: false,
            children: [
              {
                path: "finance/rule-of-72",
                title: "Rule of 72",
                lesson: "01-rule-of-72",
                enteredAt: "2026-01-02T00:00:00.000Z",
                current: true,
                demos: [
                  {
                    file: "growth.html",
                    title: "Growth curve",
                    addedAt: "2026-01-03T00:00:00.000Z",
                  },
                ],
                children: [],
              },
            ],
          },
        ],
        unassignedDemos: [
          {
            file: "loose.html",
            title: "Loose demo",
            addedAt: "2026-01-04T00:00:00.000Z",
          },
        ],
      });
      await writeFile(
        join(fixture, "lessons", "01-rule-of-72.md"),
        "# Rule of 72\n\nDivide 72 by the growth rate.\n",
        "utf8",
      );
      await writeFile(
        join(fixture, "demos", "growth.html"),
        "<h1>Growth</h1>",
        "utf8",
      );
      await writeFile(
        join(fixture, "demos", "loose.html"),
        "<h1>Loose</h1>",
        "utf8",
      );
      await writeJson(join(fixture, "glossary.json"), [
        {
          term: "Doubling time",
          def: "How long until a quantity doubles.",
          lesson: "01-rule-of-72",
          addedAt: "2026-01-05T00:00:00.000Z",
        },
      ]);
      await writeJson(join(fixture, "mastery.json"), [
        {
          concept: "finance/rule-of-72",
          score: 55,
          gaps: "missed percentage conversion",
          at: "2026-01-06T00:00:00.000Z",
        },
        {
          concept: "rule-of-72",
          score: 80,
          at: "2026-01-07T00:00:00.000Z",
        },
      ]);
      await writeFile(
        join(fixture, "transcript.jsonl"),
        [
          {
            role: "learner",
            text: "Teach me the rule of 72.",
            at: "2026-01-08T00:00:00.000Z",
          },
          {
            role: "agent",
            kind: "lesson",
            lesson: "01-rule-of-72",
            at: "2026-01-08T00:01:00.000Z",
          },
          {
            role: "agent",
            kind: "demo",
            file: "growth.html",
            title: "Growth curve",
            at: "2026-01-08T00:02:00.000Z",
          },
          {
            role: "agent",
            kind: "feynman-check",
            concept: "rule-of-72",
            prompt: "Explain it back.",
            at: "2026-01-08T00:03:00.000Z",
          },
          {
            role: "learner",
            kind: "feynman-answer",
            concept: "rule-of-72",
            text: "It estimates doubling time.",
            at: "2026-01-08T00:04:00.000Z",
          },
        ]
          .map((entry) => JSON.stringify(entry))
          .join("\n")
          .concat("\n"),
        "utf8",
      );
      await writeJson(join(fixture, ".overlearn", "active-feynman.json"), {
        concept: "compound-growth",
        prompt: "Explain compounding.",
        keyPoints: ["rate", "time"],
        issuedAt: "2026-01-09T00:00:00.000Z",
        replaced: {
          concept: "rule-of-72",
          issuedAt: "2026-01-08T00:03:00.000Z",
          replacedAt: "2026-01-09T00:00:00.000Z",
        },
      });
      await writeJson(join(fixture, ".overlearn", "pending-events.json"), [
        { type: "message", text: "pending" },
      ]);
      await writeJson(join(fixture, ".overlearn", "turns", "turn-1.json"), {
        turn: 1,
        createdAt: "2026-01-10T00:00:00.000Z",
        events: [
          { type: "message", text: "hello" },
          { type: "nav", path: "finance/rule-of-72" },
        ],
      });

      const result = await importCourseFolder(store, fixture);

      expect(result.warnings).toEqual([
        "Skipped legacy lessons/ data; topic journals replace lessons.",
      ]);
      expect(result.course).toMatchObject({
        title: "Rule of 72",
        description: "Mental compound-interest math.",
        harnessId: "codex",
        attachedDir: "../finance-app",
        sourceName: "rule-of-72",
        manifestExtra: { preservedUnknown: { yes: true } },
      });

      const topics = readTopicTree(store, result.course.id);
      expect(topics).toMatchObject([
        {
          path: "finance",
          children: [
            {
              path: "finance/rule-of-72",
              enteredAt: "2026-01-02T00:00:00.000Z",
              isCurrent: true,
              state: "current",
            },
          ],
        },
      ]);

      expect(listGlossary(store, result.course.id)).toMatchObject([
        {
          term: "Doubling time",
          definition: "How long until a quantity doubles.",
          topicId: null,
        },
      ]);
      expect(listLatestMasteryScores(store, result.course.id)).toMatchObject([
        { concept: "finance/rule-of-72", score: 55 },
        { concept: "rule-of-72", score: 80 },
      ]);
      expect(
        latestMasteryForTopic(store, result.course.id, "finance/rule-of-72"),
      ).toMatchObject({ concept: "rule-of-72", score: 80 });

      const importedDemos = listDemos(store, result.course.id);
      expect(importedDemos).toHaveLength(2);
      expect(importedDemos).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            topicId: null,
            fileName: "loose.html",
            title: "Loose demo",
            body: "<h1>Loose</h1>",
            bodyFormat: "html",
          }),
          expect.objectContaining({
            fileName: "growth.html",
            title: "Growth curve",
            body: "<h1>Growth</h1>",
            bodyFormat: "html",
          }),
        ]),
      );
      expect(
        importedDemos.find((demo) => demo.fileName === "growth.html")?.topicId,
      ).toBe(
        flattenTopicTree(topics).find(
          (topic) => topic.path === "finance/rule-of-72",
        )?.id,
      );

      const feynmanChecks = listFeynmanChecks(store, result.course.id);
      expect(feynmanChecks.map((check) => check.status)).toEqual([
        "replaced",
        "active",
      ]);
      expect(getActiveFeynmanCheck(store, result.course.id)).toMatchObject({
        concept: "compound-growth",
        keyPoints: ["rate", "time"],
      });

      expect(pageTranscript(store, result.course.id, { limit: 10 }).entries).toMatchObject([
        { role: "learner", kind: "text", content: "Teach me the rule of 72." },
        { role: "agent", kind: "lesson", content: "01-rule-of-72" },
        { role: "agent", kind: "demo", content: "growth.html" },
        { role: "agent", kind: "feynman-check", content: "Explain it back." },
        {
          role: "learner",
          kind: "feynman-answer",
          content: "It estimates doubling time.",
        },
      ]);

      expect(listTurnEvents(store, result.course.id)).toMatchObject([
        {
          turn: 1,
          status: "completed",
          events: [
            { type: "message", text: "hello" },
            { type: "nav", path: "finance/rule-of-72" },
          ],
        },
        {
          turn: null,
          status: "pending",
          events: [{ type: "message", text: "pending" }],
        },
      ]);
    });
  });
});

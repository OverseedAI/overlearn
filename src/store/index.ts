import { mkdirSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import { Database } from "bun:sqlite";

export type StoreEnv = Readonly<Record<string, string | undefined>>;

export type JsonRecord = Readonly<Record<string, unknown>>;

export type Store = Readonly<{
  db: Database;
  path: string;
  dataDir: string;
  close: () => void;
}>;

type StoreState = {
  transactionDepth: number;
};

type StoreHandle = Store &
  Readonly<{
    state: StoreState;
  }>;

export type OpenStoreOptions = Readonly<{
  env?: StoreEnv;
  databasePath?: string;
  platform?: NodeJS.Platform;
  homeDir?: string;
}>;

export type Profile = Readonly<{
  name: string | null;
  onboardingState: string;
  settings: JsonRecord;
  preferredHarness: string | null;
  createdAt: string;
  updatedAt: string;
}>;

export type ProfilePatch = Readonly<{
  name?: string | null;
  onboardingState?: string;
  settings?: JsonRecord;
  preferredHarness?: string | null;
}>;

export type CourseStatus = "active" | "archived";

export type Course = Readonly<{
  id: number;
  title: string;
  description: string | null;
  harnessId: string | null;
  attachedDir: string | null;
  status: CourseStatus;
  sourceName: string | null;
  manifestExtra: JsonRecord;
  createdAt: string;
  updatedAt: string;
}>;

export type CourseInput = Readonly<{
  title: string;
  description?: string | null;
  harnessId?: string | null;
  attachedDir?: string | null;
  status?: CourseStatus;
  sourceName?: string | null;
  manifestExtra?: JsonRecord;
  createdAt?: string;
  updatedAt?: string;
}>;

export type CoursePatch = Readonly<{
  title?: string;
  description?: string | null;
  harnessId?: string | null;
  attachedDir?: string | null;
  status?: CourseStatus;
  sourceName?: string | null;
  manifestExtra?: JsonRecord;
}>;

export type TopicStatus = "active" | "archived";
export type TopicNodeState = "frontier" | "visited" | "current";

export type Topic = Readonly<{
  id: number;
  courseId: number;
  parentId: number | null;
  position: number;
  path: string;
  title: string;
  body: string;
  status: TopicStatus;
  enteredAt: string | null;
  isCurrent: boolean;
  state: TopicNodeState;
  masteryConcept: string | null;
  createdAt: string;
  updatedAt: string;
  children: readonly Topic[];
}>;

export type TopicInput = Readonly<{
  path: string;
  title?: string;
  body?: string;
  status?: TopicStatus;
  enteredAt?: string | null;
  isCurrent?: boolean;
  masteryConcept?: string | null;
}>;

export type TopicTreeInput = Readonly<{
  path: string;
  title: string;
  body?: string;
  status?: TopicStatus;
  enteredAt?: string | null;
  isCurrent?: boolean;
  masteryConcept?: string | null;
  position?: number;
  children?: readonly TopicTreeInput[];
}>;

export type MasteryEvent = Readonly<{
  id: number;
  courseId: number;
  topicId: number | null;
  concept: string;
  score: number;
  gaps: string | null;
  ts: string;
  createdAt: string;
}>;

export type MasteryInput = Readonly<{
  concept: string;
  score: number;
  topicId?: number | null;
  gaps?: string | null;
  ts?: string;
}>;

export type TopicReviewDue = Readonly<{
  topic: Topic;
  latestScore: MasteryEvent | null;
}>;

export type ReviewDueOptions = Readonly<{
  masteryThreshold?: number;
  includeUnscored?: boolean;
  limit?: number;
}>;

export type GlossaryEntry = Readonly<{
  id: number;
  courseId: number;
  term: string;
  definition: string;
  topicId: number | null;
  addedAt: string;
  createdAt: string;
  updatedAt: string;
}>;

export type GlossaryInput = Readonly<{
  term: string;
  definition: string;
  topicId?: number | null;
  addedAt?: string;
}>;

export type TopicJournalEntryKind = "note" | "demo" | "summary";

export type TopicJournalEntry = Readonly<{
  id: number;
  courseId: number;
  topicId: number;
  kind: TopicJournalEntryKind;
  bodyMarkdown: string | null;
  demoId: number | null;
  turn: number | null;
  createdAt: string;
}>;

export type TopicJournalEntryInput =
  | Readonly<{
      topicId: number;
      kind: "note" | "summary";
      bodyMarkdown: string;
      turn?: number | null;
      createdAt?: string;
    }>
  | Readonly<{
      topicId: number;
      kind: "demo";
      demoId: number;
      turn?: number | null;
      createdAt?: string;
    }>;

export type FeynmanCheckStatus = "active" | "replaced" | "cleared";

export type FeynmanCheck = Readonly<{
  id: number;
  courseId: number;
  topicId: number | null;
  concept: string;
  prompt: string;
  keyPoints: readonly string[];
  issuedAt: string;
  status: FeynmanCheckStatus;
  replacedConcept: string | null;
  replacedIssuedAt: string | null;
  replacedAt: string | null;
  createdAt: string;
  updatedAt: string;
}>;

export type FeynmanInput = Readonly<{
  concept: string;
  prompt: string;
  keyPoints?: readonly string[];
  topicId?: number | null;
  issuedAt?: string;
}>;

export type DemoBodyFormat = "markdown" | "html" | "text";

export type Demo = Readonly<{
  id: number;
  courseId: number;
  topicId: number | null;
  fileName: string | null;
  title: string | null;
  body: string;
  bodyFormat: DemoBodyFormat;
  addedAt: string;
  position: number;
  createdAt: string;
  updatedAt: string;
}>;

export type DemoInput = Readonly<{
  topicId?: number | null;
  fileName?: string | null;
  title?: string | null;
  body: string;
  bodyFormat?: DemoBodyFormat;
  addedAt?: string;
  position?: number;
}>;

export const demoFileKey = (demo: Pick<Demo, "id" | "fileName">): string =>
  demo.fileName !== null && demo.fileName.endsWith(".html")
    ? demo.fileName
    : `demo-${demo.id}.html`;

export type TranscriptRole = "learner" | "agent" | "system";

export type TranscriptEntry = Readonly<{
  id: number;
  courseId: number;
  topicId: number | null;
  turn: number;
  role: TranscriptRole;
  kind: string;
  content: string;
  payload: JsonRecord;
  ts: string;
  createdAt: string;
}>;

export type TranscriptInput = Readonly<{
  topicId?: number | null;
  turn?: number;
  role: TranscriptRole;
  kind?: string;
  content: string;
  payload?: JsonRecord;
  ts?: string;
}>;

export type TranscriptPageOptions = Readonly<{
  afterId?: number;
  limit?: number;
}>;

export type TranscriptPage = Readonly<{
  entries: readonly TranscriptEntry[];
  nextAfterId: number | null;
}>;

export type TranscriptBeforePageOptions = Readonly<{
  beforeId?: number;
  limit?: number;
}>;

export type TranscriptBeforePage = Readonly<{
  entries: readonly TranscriptEntry[];
  hasMore: boolean;
  nextBeforeId: number | null;
}>;

export type Session = Readonly<{
  id: number;
  courseId: number;
  harnessId: string;
  startedAt: string;
  endedAt: string | null;
  endReason: string | null;
  createdAt: string;
  updatedAt: string;
}>;

export type SessionInput = Readonly<{
  courseId: number;
  harnessId: string;
  startedAt?: string;
}>;

export type TurnEventRecord = Readonly<{
  id: number;
  courseId: number;
  turn: number | null;
  status: "completed" | "pending";
  createdAt: string;
  events: readonly JsonRecord[];
  importedFrom: string | null;
}>;

export type ImportCourseFolderResult = Readonly<{
  course: Course;
  warnings: readonly string[];
}>;

type Migration = Readonly<{
  id: number;
  name: string;
  up: (db: Database) => void;
}>;

type CourseRow = Readonly<{
  id: number;
  title: string;
  description: string | null;
  harness_id: string | null;
  attached_dir: string | null;
  status: CourseStatus;
  source_name: string | null;
  manifest_extra_json: string;
  created_at: string;
  updated_at: string;
}>;

type ProfileRow = Readonly<{
  name: string | null;
  onboarding_state: string;
  settings_json: string;
  preferred_harness: string | null;
  created_at: string;
  updated_at: string;
}>;

type TopicRow = Readonly<{
  id: number;
  course_id: number;
  parent_id: number | null;
  position: number;
  path: string;
  title: string;
  body: string;
  status: TopicStatus;
  entered_at: string | null;
  is_current: number;
  mastery_concept: string | null;
  created_at: string;
  updated_at: string;
}>;

type MasteryEventRow = Readonly<{
  id: number;
  course_id: number;
  topic_id: number | null;
  concept: string;
  score: number;
  gaps: string | null;
  ts: string;
  created_at: string;
}>;

type GlossaryRow = Readonly<{
  id: number;
  course_id: number;
  term: string;
  definition: string;
  topic_id: number | null;
  added_at: string;
  created_at: string;
  updated_at: string;
}>;

type TopicJournalEntryRow = Readonly<{
  id: number;
  course_id: number;
  topic_id: number;
  kind: TopicJournalEntryKind;
  body_markdown: string | null;
  demo_id: number | null;
  turn: number | null;
  created_at: string;
}>;

type FeynmanRow = Readonly<{
  id: number;
  course_id: number;
  topic_id: number | null;
  concept: string;
  prompt: string;
  key_points_json: string;
  issued_at: string;
  status: FeynmanCheckStatus;
  replaced_concept: string | null;
  replaced_issued_at: string | null;
  replaced_at: string | null;
  created_at: string;
  updated_at: string;
}>;

type DemoRow = Readonly<{
  id: number;
  course_id: number;
  topic_id: number | null;
  file_name: string | null;
  title: string | null;
  body: string;
  body_format: DemoBodyFormat;
  added_at: string;
  position: number;
  created_at: string;
  updated_at: string;
}>;

type TranscriptRow = Readonly<{
  id: number;
  course_id: number;
  topic_id: number | null;
  turn: number;
  role: TranscriptRole;
  kind: string;
  content: string;
  payload_json: string;
  ts: string;
  created_at: string;
}>;

type SessionRow = Readonly<{
  id: number;
  course_id: number;
  harness_id: string;
  started_at: string;
  ended_at: string | null;
  end_reason: string | null;
  created_at: string;
  updated_at: string;
}>;

type TurnEventRow = Readonly<{
  id: number;
  course_id: number;
  turn: number | null;
  status: "completed" | "pending";
  created_at: string;
  events_json: string;
  imported_from: string | null;
}>;

type TopicBuilder = {
  id: number;
  courseId: number;
  parentId: number | null;
  position: number;
  path: string;
  title: string;
  body: string;
  status: TopicStatus;
  enteredAt: string | null;
  isCurrent: boolean;
  masteryConcept: string | null;
  createdAt: string;
  updatedAt: string;
  children: TopicBuilder[];
};

type FolderDemoEntry = Readonly<{
  topicPath: string | null;
  fileName: string;
  title: string | null;
  addedAt: string;
  position: number;
}>;

type ImportedFeynmanReplacement = Readonly<{
  input: FeynmanInput;
  replacedAt: string | null;
}>;

type FolderImportPayload = Readonly<{
  course: CourseInput;
  topics: readonly TopicTreeInput[];
  demos: readonly FolderDemoEntry[];
  glossary: readonly GlossaryInput[];
  mastery: readonly MasteryInput[];
  feynman: FeynmanInput | null;
  replacedFeynman: ImportedFeynmanReplacement | null;
  transcript: readonly TranscriptInput[];
  turnEvents: readonly Omit<TurnEventRecord, "id" | "courseId">[];
}>;

const STORE_FILE_NAME = "overlearn.sqlite";
export const STORE_SCHEMA_VERSION = 3;
const courseStatusCheckSql =
  "status TEXT NOT NULL CHECK (status IN ('active', 'archived'))";

const migrations: readonly Migration[] = [
  {
    id: STORE_SCHEMA_VERSION,
    name: "store_schema_v3",
    up: (db) => {
      db.exec(`
        CREATE TABLE profile (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          name TEXT,
          onboarding_state TEXT NOT NULL DEFAULT 'new',
          settings_json TEXT NOT NULL DEFAULT '{}',
          preferred_harness TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE courses (
          id INTEGER PRIMARY KEY,
          title TEXT NOT NULL,
          description TEXT,
          harness_id TEXT,
          attached_dir TEXT,
          ${courseStatusCheckSql},
          source_name TEXT,
          manifest_extra_json TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE INDEX courses_status_idx ON courses(status);

        CREATE TABLE topics (
          id INTEGER PRIMARY KEY,
          course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
          parent_id INTEGER REFERENCES topics(id) ON DELETE CASCADE,
          position INTEGER NOT NULL DEFAULT 0,
          path TEXT NOT NULL,
          title TEXT NOT NULL,
          body TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
          entered_at TEXT,
          is_current INTEGER NOT NULL DEFAULT 0 CHECK (is_current IN (0, 1)),
          mastery_concept TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(course_id, path)
        );

        CREATE INDEX topics_course_parent_position_idx
          ON topics(course_id, parent_id, position, id);

        CREATE UNIQUE INDEX topics_one_current_per_course_idx
          ON topics(course_id)
          WHERE is_current = 1;

        CREATE TABLE mastery_events (
          id INTEGER PRIMARY KEY,
          course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
          topic_id INTEGER REFERENCES topics(id) ON DELETE SET NULL,
          concept TEXT NOT NULL,
          score INTEGER NOT NULL CHECK (score >= 0 AND score <= 100),
          gaps TEXT,
          ts TEXT NOT NULL,
          created_at TEXT NOT NULL
        );

        CREATE INDEX mastery_events_course_concept_ts_idx
          ON mastery_events(course_id, concept, ts, id);

        CREATE INDEX mastery_events_topic_ts_idx
          ON mastery_events(topic_id, ts, id);

        CREATE TABLE glossary (
          id INTEGER PRIMARY KEY,
          course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
          term TEXT NOT NULL,
          term_key TEXT NOT NULL,
          definition TEXT NOT NULL,
          topic_id INTEGER REFERENCES topics(id) ON DELETE SET NULL,
          added_at TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE INDEX glossary_course_term_key_idx
          ON glossary(course_id, term_key);

        CREATE TABLE feynman_checks (
          id INTEGER PRIMARY KEY,
          course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
          topic_id INTEGER REFERENCES topics(id) ON DELETE SET NULL,
          concept TEXT NOT NULL,
          prompt TEXT NOT NULL,
          key_points_json TEXT NOT NULL,
          issued_at TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('active', 'replaced', 'cleared')),
          replaced_concept TEXT,
          replaced_issued_at TEXT,
          replaced_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE UNIQUE INDEX feynman_one_active_per_course_idx
          ON feynman_checks(course_id)
          WHERE status = 'active';

        CREATE INDEX feynman_checks_course_issued_idx
          ON feynman_checks(course_id, issued_at, id);

        CREATE TABLE demos (
          id INTEGER PRIMARY KEY,
          course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
          topic_id INTEGER REFERENCES topics(id) ON DELETE SET NULL,
          file_name TEXT,
          title TEXT,
          body TEXT NOT NULL,
          body_format TEXT NOT NULL CHECK (body_format IN ('markdown', 'html', 'text')),
          added_at TEXT NOT NULL,
          position INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE INDEX demos_course_topic_position_idx
          ON demos(course_id, topic_id, position, id);

        CREATE TABLE topic_journal_entries (
          id INTEGER PRIMARY KEY,
          course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
          topic_id INTEGER NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
          kind TEXT NOT NULL CHECK (kind IN ('note', 'demo', 'summary')),
          body_markdown TEXT,
          demo_id INTEGER REFERENCES demos(id) ON DELETE CASCADE,
          turn INTEGER,
          created_at TEXT NOT NULL,
          CHECK (
            (
              kind = 'demo'
              AND demo_id IS NOT NULL
              AND body_markdown IS NULL
            )
            OR (
              kind IN ('note', 'summary')
              AND demo_id IS NULL
              AND body_markdown IS NOT NULL
            )
          )
        );

        CREATE INDEX topic_journal_entries_topic_idx
          ON topic_journal_entries(topic_id, id);

        CREATE TABLE transcript (
          id INTEGER PRIMARY KEY,
          course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
          topic_id INTEGER REFERENCES topics(id) ON DELETE SET NULL,
          turn INTEGER NOT NULL,
          role TEXT NOT NULL CHECK (role IN ('learner', 'agent', 'system')),
          kind TEXT NOT NULL,
          content TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          ts TEXT NOT NULL,
          created_at TEXT NOT NULL
        );

        CREATE INDEX transcript_course_turn_idx
          ON transcript(course_id, turn, id);

        CREATE TABLE sessions (
          id INTEGER PRIMARY KEY,
          course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
          harness_id TEXT NOT NULL,
          started_at TEXT NOT NULL,
          ended_at TEXT,
          end_reason TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE INDEX sessions_course_started_idx
          ON sessions(course_id, started_at, id);

        CREATE TABLE turn_events (
          id INTEGER PRIMARY KEY,
          course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
          turn INTEGER,
          status TEXT NOT NULL CHECK (status IN ('completed', 'pending')),
          created_at TEXT NOT NULL,
          events_json TEXT NOT NULL,
          imported_from TEXT
        );

        CREATE INDEX turn_events_course_turn_idx
          ON turn_events(course_id, turn, id);
      `);

      const now = new Date().toISOString();
      db.query(
        `
          INSERT INTO profile (
            id,
            name,
            onboarding_state,
            settings_json,
            preferred_harness,
            created_at,
            updated_at
          )
          VALUES (1, NULL, 'new', '{}', NULL, ?1, ?1)
        `,
      ).run(now);
    },
  },
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isMissingRow = <T>(
  value: T | null | undefined,
): value is null | undefined => value === null || value === undefined;

const hasErrorCode = (error: unknown, code: string): boolean =>
  isRecord(error) && error["code"] === code;

const nowIso = (): string => new Date().toISOString();

const normalizeText = (value: string, label: string): string => {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(`${label} cannot be empty.`);
  }

  return normalized;
};

const nullableText = (value: string | null | undefined): string | null => {
  if (value === undefined || value === null) {
    return null;
  }

  const normalized = value.trim();
  return normalized.length === 0 ? null : normalized;
};

const stringifyJson = (value: unknown): string => `${JSON.stringify(value)}\n`;

const parseJson = (text: string): unknown => JSON.parse(text) as unknown;

const parseJsonRecord = (text: string): JsonRecord => {
  const value = parseJson(text);
  return isRecord(value) ? value : {};
};

const parseJsonArray = (text: string): readonly unknown[] => {
  const value = parseJson(text);
  return Array.isArray(value) ? value : [];
};

const parseStringArray = (text: string): readonly string[] => {
  const value = parseJson(text);
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === "string");
};

const toNumber = (value: number | bigint): number =>
  typeof value === "bigint" ? Number(value) : value;

const asStoreHandle = (store: Store): StoreHandle => store as StoreHandle;

const migrationTableSql = `
  CREATE TABLE IF NOT EXISTS migrations (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )
`;

const quoteSqlIdentifier = (value: string): string =>
  `"${value.replaceAll('"', '""')}"`;

const userSchemaObjects = (
  db: Database,
): readonly { type: "table" | "view" | "trigger"; name: string }[] =>
  db
    .query(
      `
        SELECT type, name
        FROM sqlite_schema
        WHERE type IN ('table', 'view', 'trigger')
          AND name NOT LIKE 'sqlite_%'
        ORDER BY
          CASE type
            WHEN 'trigger' THEN 0
            WHEN 'view' THEN 1
            ELSE 2
          END,
          name
      `,
    )
    .all() as readonly { type: "table" | "view" | "trigger"; name: string }[];

const wipeDatabase = (db: Database): void => {
  const objects = userSchemaObjects(db);
  if (objects.length === 0) {
    return;
  }

  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const object of objects) {
      const objectName = quoteSqlIdentifier(object.name);
      if (object.type === "trigger") {
        db.exec(`DROP TRIGGER IF EXISTS ${objectName}`);
      } else if (object.type === "view") {
        db.exec(`DROP VIEW IF EXISTS ${objectName}`);
      } else {
        db.exec(`DROP TABLE IF EXISTS ${objectName}`);
      }
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
};

const applyMigrations = (db: Database): void => {
  const hadUserSchema = userSchemaObjects(db).some(
    (object) => object.name !== "migrations",
  );
  db.exec(migrationTableSql);

  let appliedRows = db
    .query("SELECT id FROM migrations ORDER BY id")
    .all() as readonly { id: number }[];
  let applied = new Set(appliedRows.map((row) => row.id));
  const latestKnown = migrations.at(-1)?.id ?? 0;
  const unknown = appliedRows.find((row) => row.id > latestKnown);

  if (unknown !== undefined) {
    throw new Error(
      `Database migration ${unknown.id} is newer than this Overlearn build supports.`,
    );
  }

  if (
    latestKnown > 0 &&
    ((appliedRows.length > 0 && !applied.has(latestKnown)) ||
      (appliedRows.length === 0 && hadUserSchema))
  ) {
    console.warn(
      `Overlearn store schema changed to v${latestKnown}; wiping old database and recreating.`,
    );
    wipeDatabase(db);
    db.exec(migrationTableSql);
    appliedRows = [];
    applied = new Set();
  }

  for (const migration of migrations) {
    if (applied.has(migration.id)) {
      continue;
    }

    db.exec("BEGIN IMMEDIATE");
    try {
      migration.up(db);
      db.query(
        "INSERT INTO migrations (id, name, applied_at) VALUES (?1, ?2, ?3)",
      ).run(migration.id, migration.name, nowIso());
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
};

export const getStoreDataDir = (
  env: StoreEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  homeDir = homedir(),
): string => {
  const override = nullableText(env["OVERLEARN_DATA_DIR"]);
  if (override !== null) {
    return resolve(override);
  }

  if (platform === "darwin") {
    return join(homeDir, "Library", "Application Support", "overlearn");
  }

  const xdgDataHome = nullableText(env["XDG_DATA_HOME"]);
  return join(xdgDataHome ?? join(homeDir, ".local", "share"), "overlearn");
};

export const getStorePath = (
  env: StoreEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  homeDir = homedir(),
): string => join(getStoreDataDir(env, platform, homeDir), STORE_FILE_NAME);

export const openStore = (options: OpenStoreOptions = {}): Store => {
  const env = options.env ?? process.env;
  const databasePath =
    options.databasePath ??
    getStorePath(env, options.platform ?? process.platform, options.homeDir);
  const dataDir = dirname(databasePath);

  mkdirSync(dataDir, { recursive: true });

  const db = new Database(databasePath, { create: true, strict: true });
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA journal_mode = WAL");
  applyMigrations(db);
  db.exec("PRAGMA foreign_keys = ON");

  const store: StoreHandle = {
    db,
    path: databasePath,
    dataDir,
    state: { transactionDepth: 0 },
    close: () => {
      db.close();
    },
  };

  return store;
};

export const withStoreTransaction = <T>(
  store: Store,
  operation: () => T,
): T => {
  const handle = asStoreHandle(store);
  if (handle.state.transactionDepth > 0) {
    handle.state.transactionDepth += 1;
    try {
      return operation();
    } finally {
      handle.state.transactionDepth -= 1;
    }
  }

  handle.db.exec("BEGIN IMMEDIATE");
  handle.state.transactionDepth = 1;
  try {
    const result = operation();
    handle.db.exec("COMMIT");
    return result;
  } catch (error) {
    handle.db.exec("ROLLBACK");
    throw error;
  } finally {
    handle.state.transactionDepth = 0;
  }
};

const courseFromRow = (row: CourseRow): Course => ({
  id: toNumber(row.id),
  title: row.title,
  description: row.description,
  harnessId: row.harness_id,
  attachedDir: row.attached_dir,
  status: row.status,
  sourceName: row.source_name,
  manifestExtra: parseJsonRecord(row.manifest_extra_json),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const profileFromRow = (row: ProfileRow): Profile => ({
  name: row.name,
  onboardingState: row.onboarding_state,
  settings: parseJsonRecord(row.settings_json),
  preferredHarness: row.preferred_harness,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export const deriveTopicNodeState = (
  topic: Readonly<{ enteredAt: string | null; isCurrent: boolean }>,
): TopicNodeState => {
  if (topic.isCurrent) {
    return "current";
  }

  return topic.enteredAt === null ? "frontier" : "visited";
};

const topicBuilderFromRow = (row: TopicRow): TopicBuilder => ({
  id: toNumber(row.id),
  courseId: toNumber(row.course_id),
  parentId: row.parent_id === null ? null : toNumber(row.parent_id),
  position: toNumber(row.position),
  path: row.path,
  title: row.title,
  body: row.body,
  status: row.status,
  enteredAt: row.entered_at,
  isCurrent: row.is_current === 1,
  masteryConcept: row.mastery_concept,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  children: [],
});

const topicFromBuilder = (builder: TopicBuilder): Topic => ({
  id: builder.id,
  courseId: builder.courseId,
  parentId: builder.parentId,
  position: builder.position,
  path: builder.path,
  title: builder.title,
  body: builder.body,
  status: builder.status,
  enteredAt: builder.enteredAt,
  isCurrent: builder.isCurrent,
  state: deriveTopicNodeState(builder),
  masteryConcept: builder.masteryConcept,
  createdAt: builder.createdAt,
  updatedAt: builder.updatedAt,
  children: builder.children
    .sort(compareTopicPosition)
    .map((child) => topicFromBuilder(child)),
});

const masteryEventFromRow = (row: MasteryEventRow): MasteryEvent => ({
  id: toNumber(row.id),
  courseId: toNumber(row.course_id),
  topicId: row.topic_id === null ? null : toNumber(row.topic_id),
  concept: row.concept,
  score: toNumber(row.score),
  gaps: row.gaps,
  ts: row.ts,
  createdAt: row.created_at,
});

const glossaryEntryFromRow = (row: GlossaryRow): GlossaryEntry => ({
  id: toNumber(row.id),
  courseId: toNumber(row.course_id),
  term: row.term,
  definition: row.definition,
  topicId: row.topic_id === null ? null : toNumber(row.topic_id),
  addedAt: row.added_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const journalEntryFromRow = (
  row: TopicJournalEntryRow,
): TopicJournalEntry => ({
  id: toNumber(row.id),
  courseId: toNumber(row.course_id),
  topicId: toNumber(row.topic_id),
  kind: row.kind,
  bodyMarkdown: row.body_markdown,
  demoId: row.demo_id === null ? null : toNumber(row.demo_id),
  turn: row.turn === null ? null : toNumber(row.turn),
  createdAt: row.created_at,
});

const feynmanCheckFromRow = (row: FeynmanRow): FeynmanCheck => ({
  id: toNumber(row.id),
  courseId: toNumber(row.course_id),
  topicId: row.topic_id === null ? null : toNumber(row.topic_id),
  concept: row.concept,
  prompt: row.prompt,
  keyPoints: parseStringArray(row.key_points_json),
  issuedAt: row.issued_at,
  status: row.status,
  replacedConcept: row.replaced_concept,
  replacedIssuedAt: row.replaced_issued_at,
  replacedAt: row.replaced_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const demoFromRow = (row: DemoRow): Demo => ({
  id: toNumber(row.id),
  courseId: toNumber(row.course_id),
  topicId: row.topic_id === null ? null : toNumber(row.topic_id),
  fileName: row.file_name,
  title: row.title,
  body: row.body,
  bodyFormat: row.body_format,
  addedAt: row.added_at,
  position: toNumber(row.position),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const transcriptEntryFromRow = (row: TranscriptRow): TranscriptEntry => ({
  id: toNumber(row.id),
  courseId: toNumber(row.course_id),
  topicId: row.topic_id === null ? null : toNumber(row.topic_id),
  turn: toNumber(row.turn),
  role: row.role,
  kind: row.kind,
  content: row.content,
  payload: parseJsonRecord(row.payload_json),
  ts: row.ts,
  createdAt: row.created_at,
});

const sessionFromRow = (row: SessionRow): Session => ({
  id: toNumber(row.id),
  courseId: toNumber(row.course_id),
  harnessId: row.harness_id,
  startedAt: row.started_at,
  endedAt: row.ended_at,
  endReason: row.end_reason,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const turnEventFromRow = (row: TurnEventRow): TurnEventRecord => ({
  id: toNumber(row.id),
  courseId: toNumber(row.course_id),
  turn: row.turn === null ? null : toNumber(row.turn),
  status: row.status,
  createdAt: row.created_at,
  events: parseJsonArray(row.events_json).filter(isRecord),
  importedFrom: row.imported_from,
});

const compareTopicPosition = (left: TopicBuilder, right: TopicBuilder): number => {
  const positionDelta = left.position - right.position;
  if (positionDelta !== 0) {
    return positionDelta;
  }

  return left.id - right.id;
};

const requireCourse = (store: Store, courseId: number): Course => {
  const course = getCourse(store, courseId);
  if (course === undefined) {
    throw new Error(`Course does not exist: ${courseId}`);
  }

  return course;
};

const insertCourse = (store: Store, input: CourseInput): Course => {
  const createdAt = input.createdAt ?? nowIso();
  const updatedAt = input.updatedAt ?? createdAt;
  const result = store.db
    .query(
      `
        INSERT INTO courses (
          title,
          description,
          harness_id,
          attached_dir,
          status,
          source_name,
          manifest_extra_json,
          created_at,
          updated_at
        )
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
      `,
    )
    .run(
      normalizeText(input.title, "Course title"),
      nullableText(input.description),
      nullableText(input.harnessId),
      nullableText(input.attachedDir),
      input.status ?? "active",
      nullableText(input.sourceName),
      stringifyJson(input.manifestExtra ?? {}),
      createdAt,
      updatedAt,
    );

  return requireCourse(store, toNumber(result.lastInsertRowid));
};

export const createCourse = (store: Store, input: CourseInput): Course =>
  insertCourse(store, input);

export const getCourse = (
  store: Store,
  courseId: number,
): Course | undefined => {
  const row = store.db
    .query("SELECT * FROM courses WHERE id = ?1")
    .get(courseId) as CourseRow | undefined;

  return isMissingRow(row) ? undefined : courseFromRow(row);
};

export const listCourses = (
  store: Store,
  status?: CourseStatus,
): readonly Course[] => {
  const rows =
    status === undefined
      ? (store.db
          .query("SELECT * FROM courses ORDER BY updated_at DESC, id DESC")
          .all() as readonly CourseRow[])
      : (store.db
          .query(
            "SELECT * FROM courses WHERE status = ?1 ORDER BY updated_at DESC, id DESC",
          )
          .all(status) as readonly CourseRow[]);

  return rows.map(courseFromRow);
};

export const patchCourse = (
  store: Store,
  courseId: number,
  patch: CoursePatch,
): Course => {
  const existing = requireCourse(store, courseId);
  const updatedAt = nowIso();

  store.db
    .query(
      `
        UPDATE courses
        SET
          title = ?1,
          description = ?2,
          harness_id = ?3,
          attached_dir = ?4,
          status = ?5,
          source_name = ?6,
          manifest_extra_json = ?7,
          updated_at = ?8
        WHERE id = ?9
      `,
    )
    .run(
      patch.title === undefined
        ? existing.title
        : normalizeText(patch.title, "Course title"),
      patch.description === undefined
        ? existing.description
        : nullableText(patch.description),
      patch.harnessId === undefined
        ? existing.harnessId
        : nullableText(patch.harnessId),
      patch.attachedDir === undefined
        ? existing.attachedDir
        : nullableText(patch.attachedDir),
      patch.status ?? existing.status,
      patch.sourceName === undefined
        ? existing.sourceName
        : nullableText(patch.sourceName),
      stringifyJson(patch.manifestExtra ?? existing.manifestExtra),
      updatedAt,
      courseId,
    );

  return requireCourse(store, courseId);
};

export const deleteCourse = (store: Store, courseId: number): void => {
  store.db.query("DELETE FROM courses WHERE id = ?1").run(courseId);
};

export const getProfile = (store: Store): Profile => {
  const row = store.db
    .query("SELECT * FROM profile WHERE id = 1")
    .get() as ProfileRow | undefined;

  if (isMissingRow(row)) {
    throw new Error("Profile row is missing.");
  }

  return profileFromRow(row);
};

export const patchProfile = (store: Store, patch: ProfilePatch): Profile => {
  const existing = getProfile(store);
  const settings =
    patch.settings === undefined
      ? existing.settings
      : { ...existing.settings, ...patch.settings };
  const updatedAt = nowIso();

  store.db
    .query(
      `
        UPDATE profile
        SET
          name = ?1,
          onboarding_state = ?2,
          settings_json = ?3,
          preferred_harness = ?4,
          updated_at = ?5
        WHERE id = 1
      `,
    )
    .run(
      patch.name === undefined ? existing.name : nullableText(patch.name),
      patch.onboardingState === undefined
        ? existing.onboardingState
        : normalizeText(patch.onboardingState, "Onboarding state"),
      stringifyJson(settings),
      patch.preferredHarness === undefined
        ? existing.preferredHarness
        : nullableText(patch.preferredHarness),
      updatedAt,
    );

  return getProfile(store);
};

const topicRowsForCourse = (
  store: Store,
  courseId: number,
): readonly TopicRow[] =>
  store.db
    .query(
      `
        SELECT *
        FROM topics
        WHERE course_id = ?1
        ORDER BY parent_id IS NOT NULL, parent_id, position, id
      `,
    )
    .all(courseId) as readonly TopicRow[];

export const readTopicTree = (
  store: Store,
  courseId: number,
): readonly Topic[] => {
  requireCourse(store, courseId);

  const builders = new Map<number, TopicBuilder>();
  for (const row of topicRowsForCourse(store, courseId)) {
    const builder = topicBuilderFromRow(row);
    builders.set(builder.id, builder);
  }

  const roots: TopicBuilder[] = [];
  for (const builder of builders.values()) {
    if (builder.parentId === null) {
      roots.push(builder);
      continue;
    }

    const parent = builders.get(builder.parentId);
    if (parent === undefined) {
      roots.push(builder);
      continue;
    }

    parent.children.push(builder);
  }

  return roots.sort(compareTopicPosition).map((root) => topicFromBuilder(root));
};

export const flattenTopicTree = (topics: readonly Topic[]): readonly Topic[] =>
  topics.flatMap((topic) => [topic, ...flattenTopicTree(topic.children)]);

export const getTopicByPath = (
  store: Store,
  courseId: number,
  path: string,
): Topic | undefined => {
  const row = store.db
    .query("SELECT * FROM topics WHERE course_id = ?1 AND path = ?2")
    .get(courseId, path) as TopicRow | undefined;

  if (isMissingRow(row)) {
    return undefined;
  }

  return topicFromBuilder(topicBuilderFromRow(row));
};

const nextTopicPosition = (
  store: Store,
  courseId: number,
  parentId: number | null,
): number => {
  const row =
    parentId === null
      ? (store.db
          .query(
            `
              SELECT COALESCE(MAX(position), -1) + 1 AS position
              FROM topics
              WHERE course_id = ?1 AND parent_id IS NULL
            `,
          )
          .get(courseId) as { position: number } | undefined)
      : (store.db
          .query(
            `
              SELECT COALESCE(MAX(position), -1) + 1 AS position
              FROM topics
              WHERE course_id = ?1 AND parent_id = ?2
            `,
          )
          .get(courseId, parentId) as { position: number } | undefined);

  return row?.position ?? 0;
};

const insertTopicRow = (
  store: Store,
  courseId: number,
  parentId: number | null,
  position: number,
  input: TopicTreeInput,
  createdAt: string,
): number => {
  const result = store.db
    .query(
      `
        INSERT INTO topics (
          course_id,
          parent_id,
          position,
          path,
          title,
          body,
          status,
          entered_at,
          is_current,
          mastery_concept,
          created_at,
          updated_at
        )
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11)
      `,
    )
    .run(
      courseId,
      parentId,
      position,
      normalizeText(input.path, "Topic path"),
      normalizeText(input.title, "Topic title"),
      input.body ?? "",
      input.status ?? "active",
      nullableText(input.enteredAt),
      input.isCurrent === true ? 1 : 0,
      nullableText(input.masteryConcept),
      createdAt,
    );

  return toNumber(result.lastInsertRowid);
};

const insertTopicTree = (
  store: Store,
  courseId: number,
  parentId: number | null,
  topics: readonly TopicTreeInput[],
  createdAt: string,
): void => {
  topics.forEach((topic, index) => {
    const topicId = insertTopicRow(
      store,
      courseId,
      parentId,
      topic.position ?? index,
      topic,
      createdAt,
    );

    insertTopicTree(store, courseId, topicId, topic.children ?? [], createdAt);
  });
};

export const replaceTopicTree = (
  store: Store,
  courseId: number,
  topics: readonly TopicTreeInput[],
): readonly Topic[] =>
  withStoreTransaction(store, () => {
    requireCourse(store, courseId);
    store.db.query("DELETE FROM topics WHERE course_id = ?1").run(courseId);
    insertTopicTree(store, courseId, null, topics, nowIso());
    return readTopicTree(store, courseId);
  });

export const upsertTopic = (
  store: Store,
  courseId: number,
  input: TopicInput,
): Topic => {
  const normalizedPath = normalizeText(input.path, "Topic path");
  const segments = normalizedPath.split("/");
  if (segments.some((segment) => segment.trim().length === 0)) {
    throw new Error(`Invalid topic path: ${input.path}`);
  }

  return withStoreTransaction(store, () => {
    requireCourse(store, courseId);
    if (input.isCurrent !== false) {
      store.db
        .query("UPDATE topics SET is_current = 0 WHERE course_id = ?1")
        .run(courseId);
    }

    let parentId: number | null = null;
    let targetTopicId: number | null = null;
    let currentPath = "";

    segments.forEach((segment, index) => {
      currentPath = currentPath.length === 0 ? segment : `${currentPath}/${segment}`;
      const existing = store.db
        .query("SELECT * FROM topics WHERE course_id = ?1 AND path = ?2")
        .get(courseId, currentPath) as TopicRow | undefined;
      const isTarget = index === segments.length - 1;
      const timestamp = nowIso();

      if (isMissingRow(existing)) {
        const title = isTarget ? input.title ?? segment : segment;
        const treeInput: TopicTreeInput = {
          path: currentPath,
          title,
          body: isTarget ? input.body ?? "" : "",
          status: isTarget ? input.status ?? "active" : "active",
          enteredAt:
            isTarget && input.isCurrent !== false
              ? input.enteredAt ?? timestamp
              : null,
          isCurrent: isTarget && input.isCurrent !== false,
          masteryConcept: isTarget ? input.masteryConcept ?? null : null,
        };
        targetTopicId = insertTopicRow(
          store,
          courseId,
          parentId,
          nextTopicPosition(store, courseId, parentId),
          treeInput,
          timestamp,
        );
        parentId = targetTopicId;
        return;
      }

      const existingId = toNumber(existing.id);
      if (isTarget) {
        store.db
          .query(
            `
              UPDATE topics
              SET
                title = ?1,
                body = ?2,
                status = ?3,
                entered_at = ?4,
                is_current = ?5,
                mastery_concept = ?6,
                updated_at = ?7
              WHERE id = ?8
            `,
          )
          .run(
            input.title === undefined
              ? existing.title
              : normalizeText(input.title, "Topic title"),
            input.body ?? existing.body,
            input.status ?? existing.status,
            input.enteredAt === undefined
              ? input.isCurrent === false
                ? existing.entered_at
                : timestamp
              : nullableText(input.enteredAt),
            input.isCurrent === false ? 0 : 1,
            input.masteryConcept === undefined
              ? existing.mastery_concept
              : nullableText(input.masteryConcept),
            timestamp,
            existingId,
          );
        targetTopicId = existingId;
      }

      parentId = existingId;
    });

    if (targetTopicId === null) {
      throw new Error(`Unable to upsert topic: ${normalizedPath}`);
    }

    const topic = getTopicByPath(store, courseId, normalizedPath);
    if (topic === undefined) {
      throw new Error(`Unable to read topic after upsert: ${normalizedPath}`);
    }

    return topic;
  });
};

export const topicConceptIds = (topicPath: string): readonly string[] => {
  const slug = topicPath.split("/").at(-1) ?? topicPath;
  return slug === topicPath ? [topicPath] : [topicPath, slug];
};

const resolveTopicForConcept = (
  store: Store,
  courseId: number,
  concept: string,
): number | null => {
  const pathMatch = store.db
    .query("SELECT id FROM topics WHERE course_id = ?1 AND path = ?2")
    .get(courseId, concept) as { id: number } | undefined;

  if (!isMissingRow(pathMatch)) {
    return toNumber(pathMatch.id);
  }

  const rows = store.db
    .query("SELECT id, path FROM topics WHERE course_id = ?1")
    .all(courseId) as readonly { id: number; path: string }[];
  const slugMatch = rows.find((row) => row.path.split("/").at(-1) === concept);

  return slugMatch === undefined ? null : toNumber(slugMatch.id);
};

export const appendMasteryEvent = (
  store: Store,
  courseId: number,
  input: MasteryInput,
): MasteryEvent => {
  requireCourse(store, courseId);
  const concept = normalizeText(input.concept, "Mastery concept");
  if (!Number.isInteger(input.score) || input.score < 0 || input.score > 100) {
    throw new Error("Mastery score must be an integer from 0 to 100.");
  }

  const ts = input.ts ?? nowIso();
  const topicId =
    input.topicId === undefined
      ? resolveTopicForConcept(store, courseId, concept)
      : input.topicId;
  const result = store.db
    .query(
      `
        INSERT INTO mastery_events (
          course_id,
          topic_id,
          concept,
          score,
          gaps,
          ts,
          created_at
        )
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
      `,
    )
    .run(
      courseId,
      topicId ?? null,
      concept,
      input.score,
      nullableText(input.gaps),
      ts,
      nowIso(),
    );

  const row = store.db
    .query("SELECT * FROM mastery_events WHERE id = ?1")
    .get(toNumber(result.lastInsertRowid)) as MasteryEventRow | undefined;

  if (isMissingRow(row)) {
    throw new Error("Unable to append mastery event.");
  }

  return masteryEventFromRow(row);
};

export const listMasteryEvents = (
  store: Store,
  courseId: number,
): readonly MasteryEvent[] => {
  const rows = store.db
    .query(
      `
        SELECT *
        FROM mastery_events
        WHERE course_id = ?1
        ORDER BY ts, id
      `,
    )
    .all(courseId) as readonly MasteryEventRow[];

  return rows.map(masteryEventFromRow);
};

const compareMasteryRecency = (
  left: MasteryEvent,
  right: MasteryEvent,
): number => {
  const timeDelta = Date.parse(left.ts) - Date.parse(right.ts);
  if (timeDelta !== 0 && !Number.isNaN(timeDelta)) {
    return timeDelta;
  }

  const stringDelta = left.ts.localeCompare(right.ts);
  if (stringDelta !== 0) {
    return stringDelta;
  }

  return left.id - right.id;
};

export const listLatestMasteryScores = (
  store: Store,
  courseId: number,
): readonly MasteryEvent[] => {
  const latest = new Map<string, MasteryEvent>();

  for (const event of listMasteryEvents(store, courseId)) {
    const existing = latest.get(event.concept);
    if (
      existing === undefined ||
      compareMasteryRecency(event, existing) > 0
    ) {
      latest.set(event.concept, event);
    }
  }

  return [...latest.values()].sort((left, right) =>
    left.concept.localeCompare(right.concept),
  );
};

export const latestMasteryForTopic = (
  store: Store,
  courseId: number,
  topicPath: string,
): MasteryEvent | null => {
  const conceptIds = new Set(topicConceptIds(topicPath));
  let latest: MasteryEvent | null = null;

  for (const event of listLatestMasteryScores(store, courseId)) {
    if (!conceptIds.has(event.concept)) {
      continue;
    }

    if (latest === null || compareMasteryRecency(event, latest) > 0) {
      latest = event;
    }
  }

  return latest;
};

export const listTopicsDueForReview = (
  store: Store,
  courseId: number,
  options: ReviewDueOptions = {},
): readonly TopicReviewDue[] => {
  const threshold = options.masteryThreshold ?? 80;
  const includeUnscored = options.includeUnscored ?? true;
  const limit = options.limit ?? 3;

  if (limit <= 0) {
    return [];
  }

  const due: TopicReviewDue[] = [];
  for (const topic of flattenTopicTree(readTopicTree(store, courseId))) {
    if (topic.state === "frontier") {
      continue;
    }

    const latestScore = latestMasteryForTopic(store, courseId, topic.path);
    if (latestScore === null) {
      if (includeUnscored) {
        due.push({ topic, latestScore });
      }
      continue;
    }

    if (latestScore.score <= threshold) {
      due.push({ topic, latestScore });
    }
  }

  return due
    .sort((left, right) => {
      if (left.latestScore === null && right.latestScore !== null) {
        return -1;
      }

      if (left.latestScore !== null && right.latestScore === null) {
        return 1;
      }

      if (left.latestScore !== null && right.latestScore !== null) {
        const scoreDelta = left.latestScore.score - right.latestScore.score;
        if (scoreDelta !== 0) {
          return scoreDelta;
        }

        const recencyDelta = compareMasteryRecency(
          left.latestScore,
          right.latestScore,
        );
        if (recencyDelta !== 0) {
          return recencyDelta;
        }
      }

      return left.topic.path.localeCompare(right.topic.path);
    })
    .slice(0, limit);
};

export const upsertGlossaryEntry = (
  store: Store,
  courseId: number,
  input: GlossaryInput,
): GlossaryEntry => {
  requireCourse(store, courseId);

  const term = normalizeText(input.term, "Glossary term");
  const definition = normalizeText(input.definition, "Glossary definition");
  const termKey = term.toLocaleLowerCase();
  const addedAt = input.addedAt ?? nowIso();
  const existing = store.db
    .query("SELECT * FROM glossary WHERE course_id = ?1 AND term_key = ?2 LIMIT 1")
    .get(courseId, termKey) as GlossaryRow | undefined;

  if (isMissingRow(existing)) {
    const result = store.db
      .query(
        `
          INSERT INTO glossary (
            course_id,
            term,
            term_key,
            definition,
            topic_id,
            added_at,
            created_at,
            updated_at
          )
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
        `,
      )
      .run(
        courseId,
        term,
        termKey,
        definition,
        input.topicId ?? null,
        addedAt,
        nowIso(),
      );

    const row = store.db
      .query("SELECT * FROM glossary WHERE id = ?1")
      .get(toNumber(result.lastInsertRowid)) as GlossaryRow | undefined;

    if (isMissingRow(row)) {
      throw new Error("Unable to create glossary entry.");
    }

    return glossaryEntryFromRow(row);
  }

  store.db
    .query(
      `
        UPDATE glossary
        SET term = ?1,
            term_key = ?2,
            definition = ?3,
            topic_id = ?4,
            updated_at = ?5
        WHERE id = ?6
      `,
    )
    .run(
      term,
      termKey,
      definition,
      input.topicId === undefined ? existing.topic_id : input.topicId,
      nowIso(),
      existing.id,
    );

  const row = store.db
    .query("SELECT * FROM glossary WHERE id = ?1")
    .get(existing.id) as GlossaryRow | undefined;

  if (isMissingRow(row)) {
    throw new Error("Unable to update glossary entry.");
  }

  return glossaryEntryFromRow(row);
};

const insertGlossaryEntry = (
  store: Store,
  courseId: number,
  input: GlossaryInput,
): GlossaryEntry => {
  requireCourse(store, courseId);

  const term = normalizeText(input.term, "Glossary term");
  const definition = normalizeText(input.definition, "Glossary definition");
  const result = store.db
    .query(
      `
        INSERT INTO glossary (
          course_id,
          term,
          term_key,
          definition,
          topic_id,
          added_at,
          created_at,
          updated_at
        )
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
      `,
    )
    .run(
      courseId,
      term,
      term.toLocaleLowerCase(),
      definition,
      input.topicId ?? null,
      input.addedAt ?? nowIso(),
      nowIso(),
    );

  const row = store.db
    .query("SELECT * FROM glossary WHERE id = ?1")
    .get(toNumber(result.lastInsertRowid)) as GlossaryRow | undefined;

  if (isMissingRow(row)) {
    throw new Error("Unable to import glossary entry.");
  }

  return glossaryEntryFromRow(row);
};

export const listGlossary = (
  store: Store,
  courseId: number,
): readonly GlossaryEntry[] => {
  const rows = store.db
    .query("SELECT * FROM glossary WHERE course_id = ?1 ORDER BY term_key, id")
    .all(courseId) as readonly GlossaryRow[];

  return rows.map(glossaryEntryFromRow);
};

export const registerFeynmanCheck = (
  store: Store,
  courseId: number,
  input: FeynmanInput,
): FeynmanCheck =>
  withStoreTransaction(store, () => {
    requireCourse(store, courseId);
    const concept = normalizeText(input.concept, "Feynman concept");
    const prompt = normalizeText(input.prompt, "Feynman prompt");
    const issuedAt = input.issuedAt ?? nowIso();
    const existing = getActiveFeynmanCheck(store, courseId);

    if (existing !== null) {
      store.db
        .query(
          `
            UPDATE feynman_checks
            SET status = 'replaced',
                updated_at = ?1
            WHERE id = ?2
          `,
        )
        .run(issuedAt, existing.id);
    }

    const result = store.db
      .query(
        `
          INSERT INTO feynman_checks (
            course_id,
            topic_id,
            concept,
            prompt,
            key_points_json,
            issued_at,
            status,
            replaced_concept,
            replaced_issued_at,
            replaced_at,
            created_at,
            updated_at
          )
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'active', ?7, ?8, ?9, ?10, ?10)
        `,
      )
      .run(
        courseId,
        input.topicId ?? null,
        concept,
        prompt,
        stringifyJson(input.keyPoints ?? []),
        issuedAt,
        existing?.concept ?? null,
        existing?.issuedAt ?? null,
        existing === null ? null : issuedAt,
        nowIso(),
      );

    const row = store.db
      .query("SELECT * FROM feynman_checks WHERE id = ?1")
      .get(toNumber(result.lastInsertRowid)) as FeynmanRow | undefined;

    if (isMissingRow(row)) {
      throw new Error("Unable to register Feynman check.");
    }

    return feynmanCheckFromRow(row);
  });

const insertHistoricalFeynmanCheck = (
  store: Store,
  courseId: number,
  input: FeynmanInput,
  status: FeynmanCheckStatus,
): FeynmanCheck => {
  const issuedAt = input.issuedAt ?? nowIso();
  const result = store.db
    .query(
      `
        INSERT INTO feynman_checks (
          course_id,
          topic_id,
          concept,
          prompt,
          key_points_json,
          issued_at,
          status,
          replaced_concept,
          replaced_issued_at,
          replaced_at,
          created_at,
          updated_at
        )
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, NULL, NULL, ?8, ?8)
      `,
    )
    .run(
      courseId,
      input.topicId ?? null,
      normalizeText(input.concept, "Feynman concept"),
      normalizeText(input.prompt, "Feynman prompt"),
      stringifyJson(input.keyPoints ?? []),
      issuedAt,
      status,
      nowIso(),
    );

  const row = store.db
    .query("SELECT * FROM feynman_checks WHERE id = ?1")
    .get(toNumber(result.lastInsertRowid)) as FeynmanRow | undefined;

  if (isMissingRow(row)) {
    throw new Error("Unable to insert Feynman check.");
  }

  return feynmanCheckFromRow(row);
};

export const getActiveFeynmanCheck = (
  store: Store,
  courseId: number,
): FeynmanCheck | null => {
  const row = store.db
    .query(
      "SELECT * FROM feynman_checks WHERE course_id = ?1 AND status = 'active'",
    )
    .get(courseId) as FeynmanRow | undefined;

  return isMissingRow(row) ? null : feynmanCheckFromRow(row);
};

export const clearActiveFeynmanCheck = (
  store: Store,
  courseId: number,
): void => {
  const existing = getActiveFeynmanCheck(store, courseId);
  if (existing === null) {
    return;
  }

  store.db
    .query(
      `
        UPDATE feynman_checks
        SET status = 'cleared',
            updated_at = ?1
        WHERE id = ?2
      `,
    )
    .run(nowIso(), existing.id);
};

export const listFeynmanChecks = (
  store: Store,
  courseId: number,
): readonly FeynmanCheck[] => {
  const rows = store.db
    .query(
      `
        SELECT *
        FROM feynman_checks
        WHERE course_id = ?1
        ORDER BY issued_at, id
      `,
    )
    .all(courseId) as readonly FeynmanRow[];

  return rows.map(feynmanCheckFromRow);
};

export const upsertDemo = (
  store: Store,
  courseId: number,
  input: DemoInput,
): Demo => {
  requireCourse(store, courseId);

  const topicId = input.topicId ?? null;
  const fileName = nullableText(input.fileName);
  const bodyFormat = input.bodyFormat ?? "markdown";
  const position = input.position ?? 0;
  const addedAt = input.addedAt ?? nowIso();
  const existing =
    topicId === null
      ? (store.db
          .query(
            `
              SELECT *
              FROM demos
              WHERE course_id = ?1
                AND topic_id IS NULL
                AND COALESCE(file_name, '') = COALESCE(?2, '')
              LIMIT 1
            `,
          )
          .get(courseId, fileName) as DemoRow | undefined)
      : (store.db
          .query(
            `
              SELECT *
              FROM demos
              WHERE course_id = ?1
                AND topic_id = ?2
                AND COALESCE(file_name, '') = COALESCE(?3, '')
              LIMIT 1
            `,
          )
          .get(courseId, topicId, fileName) as DemoRow | undefined);

  if (isMissingRow(existing)) {
    const result = store.db
      .query(
        `
          INSERT INTO demos (
            course_id,
            topic_id,
            file_name,
            title,
            body,
            body_format,
            added_at,
            position,
            created_at,
            updated_at
          )
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)
        `,
      )
      .run(
        courseId,
        topicId,
        fileName,
        nullableText(input.title),
        input.body,
        bodyFormat,
        addedAt,
        position,
        nowIso(),
      );

    const row = store.db
      .query("SELECT * FROM demos WHERE id = ?1")
      .get(toNumber(result.lastInsertRowid)) as DemoRow | undefined;

    if (isMissingRow(row)) {
      throw new Error("Unable to create demo.");
    }

    return demoFromRow(row);
  }

  store.db
    .query(
      `
        UPDATE demos
        SET title = ?1,
            body = ?2,
            body_format = ?3,
            added_at = ?4,
            position = ?5,
            updated_at = ?6
        WHERE id = ?7
      `,
    )
    .run(
      input.title === undefined ? existing.title : nullableText(input.title),
      input.body,
      bodyFormat,
      addedAt,
      position,
      nowIso(),
      existing.id,
    );

  const row = store.db
    .query("SELECT * FROM demos WHERE id = ?1")
    .get(existing.id) as DemoRow | undefined;

  if (isMissingRow(row)) {
    throw new Error("Unable to update demo.");
  }

  return demoFromRow(row);
};

export const listDemos = (store: Store, courseId: number): readonly Demo[] => {
  const rows = store.db
    .query(
      `
        SELECT *
        FROM demos
        WHERE course_id = ?1
        ORDER BY topic_id IS NOT NULL, topic_id, position, id
      `,
    )
    .all(courseId) as readonly DemoRow[];

  return rows.map(demoFromRow);
};

const requireTopicId = (
  store: Store,
  courseId: number,
  topicId: number,
): void => {
  const row = store.db
    .query("SELECT id FROM topics WHERE course_id = ?1 AND id = ?2")
    .get(courseId, topicId) as { id: number } | undefined;
  if (isMissingRow(row)) {
    throw new Error(`Topic does not exist in course ${courseId}: ${topicId}`);
  }
};

const requireDemoId = (
  store: Store,
  courseId: number,
  demoId: number,
): void => {
  const row = store.db
    .query("SELECT id FROM demos WHERE course_id = ?1 AND id = ?2")
    .get(courseId, demoId) as { id: number } | undefined;
  if (isMissingRow(row)) {
    throw new Error(`Demo does not exist in course ${courseId}: ${demoId}`);
  }
};

export const appendJournalEntry = (
  store: Store,
  courseId: number,
  input: TopicJournalEntryInput,
): TopicJournalEntry => {
  requireCourse(store, courseId);
  requireTopicId(store, courseId, input.topicId);

  const createdAt = input.createdAt ?? nowIso();
  const bodyMarkdown =
    input.kind === "demo" ? null : input.bodyMarkdown;
  const demoId = input.kind === "demo" ? input.demoId : null;

  if (input.kind === "demo") {
    requireDemoId(store, courseId, input.demoId);
  }

  const result = store.db
    .query(
      `
        INSERT INTO topic_journal_entries (
          course_id,
          topic_id,
          kind,
          body_markdown,
          demo_id,
          turn,
          created_at
        )
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
      `,
    )
    .run(
      courseId,
      input.topicId,
      input.kind,
      bodyMarkdown,
      demoId,
      input.turn ?? null,
      createdAt,
    );

  const row = store.db
    .query("SELECT * FROM topic_journal_entries WHERE id = ?1")
    .get(toNumber(result.lastInsertRowid)) as TopicJournalEntryRow | undefined;

  if (isMissingRow(row)) {
    throw new Error("Unable to append journal entry.");
  }

  return journalEntryFromRow(row);
};

export const upsertJournalDemoPin = (
  store: Store,
  courseId: number,
  input: Readonly<{
    topicId: number;
    demoId: number;
    turn?: number | null;
    createdAt?: string;
  }>,
): TopicJournalEntry => {
  requireCourse(store, courseId);
  requireTopicId(store, courseId, input.topicId);
  requireDemoId(store, courseId, input.demoId);

  const existing = store.db
    .query(
      `
        SELECT *
        FROM topic_journal_entries
        WHERE course_id = ?1
          AND topic_id = ?2
          AND kind = 'demo'
          AND demo_id = ?3
        LIMIT 1
      `,
    )
    .get(courseId, input.topicId, input.demoId) as
    | TopicJournalEntryRow
    | null
    | undefined;

  if (isMissingRow(existing)) {
    return appendJournalEntry(store, courseId, {
      topicId: input.topicId,
      kind: "demo",
      demoId: input.demoId,
      ...(input.turn === undefined ? {} : { turn: input.turn }),
      ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt }),
    });
  }

  const createdAt = input.createdAt ?? nowIso();
  store.db
    .query(
      `
        UPDATE topic_journal_entries
        SET turn = ?1,
            created_at = ?2
        WHERE id = ?3
      `,
    )
    .run(input.turn ?? null, createdAt, existing.id);

  const row = store.db
    .query("SELECT * FROM topic_journal_entries WHERE id = ?1")
    .get(existing.id) as TopicJournalEntryRow | null | undefined;

  if (isMissingRow(row)) {
    throw new Error("Unable to update journal demo pin.");
  }

  return journalEntryFromRow(row);
};

export const listJournalEntries = (
  store: Store,
  courseId: number,
  topicId: number,
): readonly TopicJournalEntry[] => {
  requireCourse(store, courseId);
  requireTopicId(store, courseId, topicId);

  const rows = store.db
    .query(
      `
        SELECT *
        FROM topic_journal_entries
        WHERE course_id = ?1
          AND topic_id = ?2
        ORDER BY created_at, id
      `,
    )
    .all(courseId, topicId) as readonly TopicJournalEntryRow[];

  return rows.map(journalEntryFromRow);
};

const currentTopicIdForCourse = (
  store: Store,
  courseId: number,
): number | null => {
  const row = store.db
    .query(
      `
        SELECT id
        FROM topics
        WHERE course_id = ?1
          AND is_current = 1
        LIMIT 1
      `,
    )
    .get(courseId) as { id: number } | undefined;

  return isMissingRow(row) ? null : toNumber(row.id);
};

const nextTranscriptTurn = (store: Store, courseId: number): number => {
  const row = store.db
    .query(
      "SELECT COALESCE(MAX(turn), 0) + 1 AS turn FROM transcript WHERE course_id = ?1",
    )
    .get(courseId) as { turn: number } | undefined;

  return row?.turn ?? 1;
};

export const appendTranscriptEntry = (
  store: Store,
  courseId: number,
  input: TranscriptInput,
): TranscriptEntry => {
  requireCourse(store, courseId);
  const turn = input.turn ?? nextTranscriptTurn(store, courseId);
  const kind = input.kind ?? "text";
  const ts = input.ts ?? nowIso();
  const topicId =
    input.topicId === undefined
      ? currentTopicIdForCourse(store, courseId)
      : input.topicId;
  if (topicId !== null) {
    requireTopicId(store, courseId, topicId);
  }
  const payload = input.payload ?? {
    role: input.role,
    kind,
    text: input.content,
    at: ts,
  };
  const result = store.db
    .query(
      `
        INSERT INTO transcript (
          course_id,
          topic_id,
          turn,
          role,
          kind,
          content,
          payload_json,
          ts,
          created_at
        )
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
      `,
    )
    .run(
      courseId,
      topicId,
      turn,
      input.role,
      kind,
      input.content,
      stringifyJson(payload),
      ts,
      nowIso(),
    );

  const row = store.db
    .query("SELECT * FROM transcript WHERE id = ?1")
    .get(toNumber(result.lastInsertRowid)) as TranscriptRow | undefined;

  if (isMissingRow(row)) {
    throw new Error("Unable to append transcript entry.");
  }

  return transcriptEntryFromRow(row);
};

export const pageTranscript = (
  store: Store,
  courseId: number,
  options: TranscriptPageOptions = {},
): TranscriptPage => {
  const limit = Math.max(1, Math.min(options.limit ?? 50, 200));
  const rows = store.db
    .query(
      `
        SELECT *
        FROM transcript
        WHERE course_id = ?1
          AND id > ?2
        ORDER BY id
        LIMIT ?3
      `,
    )
    .all(courseId, options.afterId ?? 0, limit + 1) as readonly TranscriptRow[];
  const pageRows = rows.slice(0, limit);
  const extra = rows.at(limit);

  return {
    entries: pageRows.map(transcriptEntryFromRow),
    nextAfterId: extra === undefined ? null : toNumber(pageRows.at(-1)?.id ?? 0),
  };
};

export const pageTranscriptBefore = (
  store: Store,
  courseId: number,
  options: TranscriptBeforePageOptions = {},
): TranscriptBeforePage => {
  const limit = Math.max(1, Math.min(options.limit ?? 50, 200));
  const rows = store.db
    .query(
      `
        SELECT *
        FROM transcript
        WHERE course_id = ?1
          AND id < ?2
        ORDER BY id DESC
        LIMIT ?3
      `,
    )
    .all(
      courseId,
      options.beforeId ?? Number.MAX_SAFE_INTEGER,
      limit + 1,
    ) as readonly TranscriptRow[];
  const pageRows = [...rows.slice(0, limit)].reverse();

  return {
    entries: pageRows.map(transcriptEntryFromRow),
    hasMore: rows.length > limit,
    nextBeforeId:
      pageRows.length === 0 ? null : toNumber(pageRows[0]?.id ?? 0),
  };
};

export const startSession = (
  store: Store,
  input: SessionInput,
): Session => {
  requireCourse(store, input.courseId);
  const startedAt = input.startedAt ?? nowIso();
  const result = store.db
    .query(
      `
        INSERT INTO sessions (
          course_id,
          harness_id,
          started_at,
          ended_at,
          end_reason,
          created_at,
          updated_at
        )
        VALUES (?1, ?2, ?3, NULL, NULL, ?4, ?4)
      `,
    )
    .run(
      input.courseId,
      normalizeText(input.harnessId, "Harness id"),
      startedAt,
      nowIso(),
    );

  const row = store.db
    .query("SELECT * FROM sessions WHERE id = ?1")
    .get(toNumber(result.lastInsertRowid)) as SessionRow | undefined;

  if (isMissingRow(row)) {
    throw new Error("Unable to start session.");
  }

  return sessionFromRow(row);
};

export const endSession = (
  store: Store,
  sessionId: number,
  endReason: string,
  endedAt = nowIso(),
): Session => {
  store.db
    .query(
      `
        UPDATE sessions
        SET ended_at = ?1,
            end_reason = ?2,
            updated_at = ?3
        WHERE id = ?4
      `,
    )
    .run(
      endedAt,
      normalizeText(endReason, "Session end reason"),
      nowIso(),
      sessionId,
    );

  const row = store.db
    .query("SELECT * FROM sessions WHERE id = ?1")
    .get(sessionId) as SessionRow | undefined;

  if (isMissingRow(row)) {
    throw new Error(`Session does not exist: ${sessionId}`);
  }

  return sessionFromRow(row);
};

export const listSessions = (
  store: Store,
  courseId: number,
): readonly Session[] => {
  const rows = store.db
    .query(
      "SELECT * FROM sessions WHERE course_id = ?1 ORDER BY started_at, id",
    )
    .all(courseId) as readonly SessionRow[];

  return rows.map(sessionFromRow);
};

export const appendTurnEvents = (
  store: Store,
  courseId: number,
  input: Omit<TurnEventRecord, "id" | "courseId">,
): TurnEventRecord => {
  requireCourse(store, courseId);
  const result = store.db
    .query(
      `
        INSERT INTO turn_events (
          course_id,
          turn,
          status,
          created_at,
          events_json,
          imported_from
        )
        VALUES (?1, ?2, ?3, ?4, ?5, ?6)
      `,
    )
    .run(
      courseId,
      input.turn,
      input.status,
      input.createdAt,
      stringifyJson(input.events),
      input.importedFrom,
    );

  const row = store.db
    .query("SELECT * FROM turn_events WHERE id = ?1")
    .get(toNumber(result.lastInsertRowid)) as TurnEventRow | undefined;

  if (isMissingRow(row)) {
    throw new Error("Unable to append turn events.");
  }

  return turnEventFromRow(row);
};

export const listTurnEvents = (
  store: Store,
  courseId: number,
): readonly TurnEventRecord[] => {
  const rows = store.db
    .query(
      "SELECT * FROM turn_events WHERE course_id = ?1 ORDER BY status, turn, id",
    )
    .all(courseId) as readonly TurnEventRow[];

  return rows.map(turnEventFromRow);
};

const readOptionalJson = async (
  filePath: string,
  warnings: string[],
): Promise<unknown | undefined> => {
  try {
    return parseJson(await readFile(filePath, "utf8"));
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return undefined;
    }

    warnings.push(`Could not read ${filePath}: ${String(error)}`);
    return undefined;
  }
};

const readOptionalText = async (
  filePath: string,
  warnings: string[],
): Promise<string | undefined> => {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return undefined;
    }

    warnings.push(`Could not read ${filePath}: ${String(error)}`);
    return undefined;
  }
};

const readDirectoryNames = async (
  directoryPath: string,
  warnings: string[],
): Promise<readonly string[]> => {
  try {
    return (await readdir(directoryPath)).sort((left, right) =>
      left.localeCompare(right),
    );
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return [];
    }

    warnings.push(`Could not list ${directoryPath}: ${String(error)}`);
    return [];
  }
};

const stringField = (record: Record<string, unknown>, key: string): string | null => {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
};

const importCourseInput = (
  dir: string,
  manifest: unknown,
  warnings: string[],
): CourseInput => {
  const record = isRecord(manifest) ? manifest : {};
  if (!isRecord(manifest)) {
    warnings.push("course.json is missing or invalid; imported using folder name.");
  }

  const sourceName = stringField(record, "name") ?? basename(resolve(dir));
  const title = stringField(record, "title") ?? sourceName;
  const createdAt = stringField(record, "createdAt") ?? nowIso();
  const extra: Record<string, unknown> = {};
  const knownKeys = new Set([
    "name",
    "createdAt",
    "harness",
    "topics",
    "unassignedDemos",
    "title",
    "description",
    "workingDirectory",
  ]);

  for (const [key, value] of Object.entries(record)) {
    if (!knownKeys.has(key)) {
      extra[key] = value;
    }
  }

  return {
    title,
    description: stringField(record, "description"),
    harnessId: stringField(record, "harness"),
    attachedDir: stringField(record, "workingDirectory"),
    status: "active",
    sourceName,
    manifestExtra: extra,
    createdAt,
    updatedAt: createdAt,
  };
};

const warnSkippedLegacyLessons = async (
  dir: string,
  warnings: string[],
): Promise<void> => {
  const lessonsDir = join(dir, "lessons");
  const names = await readDirectoryNames(lessonsDir, warnings);
  if (names.some((name) => name.endsWith(".md"))) {
    warnings.push("Skipped legacy lessons/ data; topic journals replace lessons.");
  }
};

const importDemoEntry = (
  value: unknown,
  topicPath: string | null,
  position: number,
  warnings: string[],
): FolderDemoEntry | undefined => {
  if (!isRecord(value)) {
    warnings.push("Skipped invalid demo entry.");
    return undefined;
  }

  const fileName = stringField(value, "file");
  const addedAt = stringField(value, "addedAt");
  if (fileName === null || addedAt === null) {
    warnings.push("Skipped demo entry without file or addedAt.");
    return undefined;
  }

  return {
    topicPath,
    fileName,
    title: stringField(value, "title"),
    addedAt,
    position,
  };
};

const importTopicTree = (
  value: unknown,
  warnings: string[],
): Readonly<{
  topics: readonly TopicTreeInput[];
  demos: readonly FolderDemoEntry[];
}> => {
  if (!Array.isArray(value)) {
    return { topics: [], demos: [] };
  }

  const demos: FolderDemoEntry[] = [];
  const currentSeen = { value: false };

  const convertNode = (
    node: unknown,
    position: number,
    parentPath: string | null,
  ): TopicTreeInput | undefined => {
    if (!isRecord(node)) {
      warnings.push("Skipped invalid topic node.");
      return undefined;
    }

    const path = stringField(node, "path");
    const title = stringField(node, "title");
    if (path === null || title === null) {
      warnings.push("Skipped topic node without path or title.");
      return undefined;
    }

    if (parentPath !== null && !path.startsWith(`${parentPath}/`)) {
      warnings.push(`Imported topic ${path} despite parent/path mismatch.`);
    }

    const rawCurrent = node["current"] === true;
    const isCurrent = rawCurrent && !currentSeen.value;
    if (rawCurrent && currentSeen.value) {
      warnings.push(`Topic ${path} was current, but another current topic was already imported.`);
    }
    if (rawCurrent) {
      currentSeen.value = true;
    }

    const rawDemos = node["demos"];
    if (Array.isArray(rawDemos)) {
      rawDemos.forEach((demo, demoIndex) => {
        const imported = importDemoEntry(demo, path, demoIndex, warnings);
        if (imported !== undefined) {
          demos.push(imported);
        }
      });
    }

    const children = Array.isArray(node["children"])
      ? node["children"].flatMap((child, childIndex) => {
          const imported = convertNode(child, childIndex, path);
          return imported === undefined ? [] : [imported];
        })
      : [];

    return {
      path,
      title,
      enteredAt: stringField(node, "enteredAt"),
      isCurrent,
      position,
      children,
    };
  };

  const topics = value.flatMap((node, index) => {
    const imported = convertNode(node, index, null);
    return imported === undefined ? [] : [imported];
  });

  if (topics.length > 0 && !currentSeen.value) {
    warnings.push("Imported topic tree has no current topic.");
  }

  return { topics, demos };
};

const importUnassignedDemos = (
  manifest: unknown,
  warnings: string[],
): readonly FolderDemoEntry[] => {
  if (!isRecord(manifest) || !Array.isArray(manifest["unassignedDemos"])) {
    return [];
  }

  return manifest["unassignedDemos"].flatMap((demo, index) => {
    const imported = importDemoEntry(demo, null, index, warnings);
    return imported === undefined ? [] : [imported];
  });
};

const importGlossary = (
  glossaryJson: unknown,
  warnings: string[],
): readonly GlossaryInput[] => {
  if (glossaryJson === undefined) {
    return [];
  }

  if (!Array.isArray(glossaryJson)) {
    warnings.push("Skipped glossary.json because it was not an array.");
    return [];
  }

  return glossaryJson.flatMap((entry) => {
    if (!isRecord(entry)) {
      warnings.push("Skipped invalid glossary entry.");
      return [];
    }

    const term = stringField(entry, "term");
    const definition = stringField(entry, "def");
    const addedAt = stringField(entry, "addedAt");
    if (term === null || definition === null || addedAt === null) {
      warnings.push("Skipped glossary entry without term, def, or addedAt.");
      return [];
    }

    return [
      {
        term,
        definition,
        addedAt,
      },
    ];
  });
};

const importMastery = (
  masteryJson: unknown,
  warnings: string[],
): readonly MasteryInput[] => {
  if (masteryJson === undefined) {
    return [];
  }

  if (!Array.isArray(masteryJson)) {
    warnings.push("Skipped mastery.json because it was not an array.");
    return [];
  }

  return masteryJson.flatMap((entry) => {
    if (!isRecord(entry)) {
      warnings.push("Skipped invalid mastery entry.");
      return [];
    }

    const concept = stringField(entry, "concept");
    const score = entry["score"];
    const ts = stringField(entry, "at");
    if (
      concept === null ||
      typeof score !== "number" ||
      !Number.isInteger(score) ||
      ts === null
    ) {
      warnings.push("Skipped mastery entry without concept, integer score, or at.");
      return [];
    }

    return [
      {
        concept,
        score,
        gaps: stringField(entry, "gaps"),
        ts,
      },
    ];
  });
};

const transcriptInputFromPayload = (
  payload: JsonRecord,
  turn: number,
  warnings: string[],
): TranscriptInput | undefined => {
  const roleValue = payload["role"];
  if (roleValue !== "learner" && roleValue !== "agent" && roleValue !== "system") {
    warnings.push(`Skipped transcript line ${turn}: invalid role.`);
    return undefined;
  }

  const kind = typeof payload["kind"] === "string" ? payload["kind"] : "text";
  const ts = stringField(payload, "at") ?? nowIso();
  const content =
    stringField(payload, "text") ??
    stringField(payload, "prompt") ??
    stringField(payload, "file") ??
    stringField(payload, "lesson") ??
    stringField(payload, "concept") ??
    stringifyJson(payload).trim();

  return {
    turn,
    role: roleValue,
    kind,
    content,
    payload,
    ts,
  };
};

const importTranscript = async (
  dir: string,
  warnings: string[],
): Promise<readonly TranscriptInput[]> => {
  const text = await readOptionalText(join(dir, "transcript.jsonl"), warnings);
  if (text === undefined || text.trim().length === 0) {
    return [];
  }

  return text
    .split("\n")
    .flatMap((line, index) => {
      if (line.trim().length === 0) {
        return [];
      }

      try {
        const payload = parseJson(line);
        if (!isRecord(payload)) {
          warnings.push(`Skipped transcript line ${index + 1}: not an object.`);
          return [];
        }

        const input = transcriptInputFromPayload(payload, index + 1, warnings);
        return input === undefined ? [] : [input];
      } catch (error) {
        warnings.push(`Skipped transcript line ${index + 1}: ${String(error)}`);
        return [];
      }
    });
};

const importFeynman = (
  value: unknown,
  warnings: string[],
): Readonly<{
  active: FeynmanInput | null;
  replaced: ImportedFeynmanReplacement | null;
}> => {
  if (value === undefined) {
    return { active: null, replaced: null };
  }

  if (!isRecord(value)) {
    warnings.push("Skipped active Feynman check because it was invalid.");
    return { active: null, replaced: null };
  }

  const concept = stringField(value, "concept");
  const prompt = stringField(value, "prompt");
  const issuedAt = stringField(value, "issuedAt");
  if (concept === null || prompt === null || issuedAt === null) {
    warnings.push("Skipped active Feynman check without concept, prompt, or issuedAt.");
    return { active: null, replaced: null };
  }

  const keyPoints = Array.isArray(value["keyPoints"])
    ? value["keyPoints"].filter(
        (point): point is string =>
          typeof point === "string" && point.trim().length > 0,
      )
    : [];
  const replacedValue = value["replaced"];
  const replaced =
    isRecord(replacedValue) &&
    stringField(replacedValue, "concept") !== null &&
    stringField(replacedValue, "issuedAt") !== null
      ? {
          input: {
            concept: stringField(replacedValue, "concept") ?? concept,
            prompt: "(imported replaced Feynman check)",
            keyPoints: [],
            issuedAt: stringField(replacedValue, "issuedAt") ?? issuedAt,
          },
          replacedAt: stringField(replacedValue, "replacedAt"),
        }
      : null;

  return {
    active: { concept, prompt, keyPoints, issuedAt },
    replaced,
  };
};

const importTurnEvents = async (
  dir: string,
  warnings: string[],
): Promise<readonly Omit<TurnEventRecord, "id" | "courseId">[]> => {
  const runtimeDir = join(dir, ".overlearn");
  const turnsDir = join(runtimeDir, "turns");
  const turnFiles = await readDirectoryNames(turnsDir, warnings);
  const records: Omit<TurnEventRecord, "id" | "courseId">[] = [];

  for (const fileName of turnFiles) {
    const match = /^turn-(\d+)\.json$/.exec(fileName);
    if (match === null) {
      continue;
    }

    const value = await readOptionalJson(join(turnsDir, fileName), warnings);
    if (!isRecord(value) || !Array.isArray(value["events"])) {
      warnings.push(`Skipped invalid turn file ${fileName}.`);
      continue;
    }

    records.push({
      turn: Number.parseInt(match[1] ?? "0", 10),
      status: "completed",
      createdAt: stringField(value, "createdAt") ?? nowIso(),
      events: value["events"].filter(isRecord),
      importedFrom: join(".overlearn", "turns", fileName),
    });
  }

  const pending = await readOptionalJson(join(runtimeDir, "pending-events.json"), warnings);
  if (Array.isArray(pending)) {
    records.push({
      turn: null,
      status: "pending",
      createdAt: nowIso(),
      events: pending.filter(isRecord),
      importedFrom: join(".overlearn", "pending-events.json"),
    });
  }

  return records;
};

const readDemoBodies = async (
  dir: string,
  demos: readonly FolderDemoEntry[],
  warnings: string[],
): Promise<ReadonlyMap<string, string>> => {
  const demosDir = join(dir, "demos");
  const referenced = new Set(demos.map((demo) => demo.fileName));
  const fileNames = await readDirectoryNames(demosDir, warnings);
  const bodies = new Map<string, string>();

  for (const fileName of fileNames) {
    if (!fileName.endsWith(".html") || fileName !== basename(fileName)) {
      continue;
    }

    const body = await readOptionalText(join(demosDir, fileName), warnings);
    if (body === undefined) {
      continue;
    }

    bodies.set(fileName, body);
    if (!referenced.has(fileName)) {
      warnings.push(`Demo file ${fileName} was present but not referenced by course.json.`);
    }
  }

  for (const demo of demos) {
    if (!bodies.has(demo.fileName)) {
      warnings.push(`Demo file ${demo.fileName} was referenced but missing from demos/.`);
    }
  }

  return bodies;
};

const readCourseFolder = async (
  dir: string,
): Promise<Readonly<{ payload: FolderImportPayload; warnings: readonly string[] }>> => {
  const warnings: string[] = [];
  const absoluteDir = resolve(dir);
  const manifest = await readOptionalJson(join(absoluteDir, "course.json"), warnings);
  const course = importCourseInput(absoluteDir, manifest, warnings);
  await warnSkippedLegacyLessons(absoluteDir, warnings);
  const topicImport = importTopicTree(
    isRecord(manifest) ? manifest["topics"] : undefined,
    warnings,
  );
  const demos = [...importUnassignedDemos(manifest, warnings), ...topicImport.demos];
  const demoBodies = await readDemoBodies(absoluteDir, demos, warnings);
  const glossary = importGlossary(
    await readOptionalJson(join(absoluteDir, "glossary.json"), warnings),
    warnings,
  );
  const mastery = importMastery(
    await readOptionalJson(join(absoluteDir, "mastery.json"), warnings),
    warnings,
  );
  const transcript = await importTranscript(absoluteDir, warnings);
  const feynman = importFeynman(
    await readOptionalJson(
      join(absoluteDir, ".overlearn", "active-feynman.json"),
      warnings,
    ),
    warnings,
  );
  const turnEvents = await importTurnEvents(absoluteDir, warnings);

  const demosWithBody = demos.filter((demo) => {
    if (demoBodies.has(demo.fileName)) {
      return true;
    }

    return false;
  });

  return {
    warnings,
    payload: {
      course,
      topics: topicImport.topics,
      demos: demosWithBody,
      glossary,
      mastery,
      feynman: feynman.active,
      replacedFeynman: feynman.replaced,
      transcript,
      turnEvents,
    },
  };
};

export const importCourseFolder = async (
  store: Store,
  dir: string,
): Promise<ImportCourseFolderResult> => {
  const { payload, warnings } = await readCourseFolder(dir);
  const absoluteDir = resolve(dir);
  const demoBodies = await readDemoBodies(absoluteDir, payload.demos, [...warnings]);

  const course = withStoreTransaction(store, () => {
    const importedCourse = createCourse(store, payload.course);

    replaceTopicTree(store, importedCourse.id, payload.topics);

    const topicsByPath = new Map(
      flattenTopicTree(readTopicTree(store, importedCourse.id)).map((topic) => [
        topic.path,
        topic,
      ]),
    );

    payload.glossary.forEach((entry) => {
      insertGlossaryEntry(store, importedCourse.id, entry);
    });

    payload.mastery.forEach((entry) => {
      appendMasteryEvent(store, importedCourse.id, entry);
    });

    payload.demos.forEach((demo) => {
      const topicId =
        demo.topicPath === null ? null : topicsByPath.get(demo.topicPath)?.id ?? null;
      upsertDemo(store, importedCourse.id, {
        topicId,
        fileName: demo.fileName,
        title: demo.title,
        body: demoBodies.get(demo.fileName) ?? "",
        bodyFormat: "html",
        addedAt: demo.addedAt,
        position: demo.position,
      });
    });

    if (payload.replacedFeynman !== null) {
      insertHistoricalFeynmanCheck(
        store,
        importedCourse.id,
        payload.replacedFeynman.input,
        "replaced",
      );
    }

    if (payload.feynman !== null) {
      const active = registerFeynmanCheck(store, importedCourse.id, payload.feynman);
      if (payload.replacedFeynman !== null) {
        store.db
          .query(
            `
              UPDATE feynman_checks
              SET replaced_concept = ?1,
                  replaced_issued_at = ?2,
                  replaced_at = ?3,
                  updated_at = ?4
              WHERE id = ?5
            `,
          )
          .run(
            payload.replacedFeynman.input.concept,
            payload.replacedFeynman.input.issuedAt ?? null,
            payload.replacedFeynman.replacedAt,
            nowIso(),
            active.id,
          );
      }
    }

    payload.transcript.forEach((entry) => {
      appendTranscriptEntry(store, importedCourse.id, entry);
    });

    payload.turnEvents.forEach((entry) => {
      appendTurnEvents(store, importedCourse.id, entry);
    });

    return requireCourse(store, importedCourse.id);
  });

  return { course, warnings };
};

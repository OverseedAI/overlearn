import { randomUUID } from "node:crypto";

import {
  appendJournalEntry,
  appendMasteryEvent,
  demoFileKey,
  flattenTopicTree,
  getActiveFeynmanCheck,
  getCourse,
  getTopicByPath,
  latestMasteryForTopic,
  listDemos,
  listGlossary,
  listJournalEntries,
  listTopicsDueForReview,
  pageTranscript,
  patchCourse,
  readTopicTree,
  registerFeynmanCheck,
  upsertDemo,
  upsertGlossaryEntry,
  upsertJournalDemoPin,
  upsertTopic,
  withStoreTransaction,
  type Course,
  type Demo,
  type DemoBodyFormat,
  type Store,
  type Topic,
  type TopicJournalEntry,
  type TopicStatus,
  type TranscriptEntry,
} from "../store";
import {
  createMcpHttpHandler,
  textMcpResult,
  type McpJsonObject,
  type McpServerDefinition,
  type McpServerTool,
  type McpToolCallResult,
} from "./protocol";

export const teachingMcpServerName = "overlearn-teaching";

export type TeachingToolName =
  | "get_course_state"
  | "upsert_topic"
  | "propose_topics"
  | "emit_demo"
  | "append_lesson_note"
  | "record_mastery"
  | "feynman_check"
  | "upsert_glossary_entry"
  | "update_course_info";

export type ActiveTeachingTurn = Readonly<{
  turn: number;
  topicId: number | null;
  topicPath: string | null;
}>;

export type TeachingSessionScope = Readonly<{
  courseId: number;
  sessionToken?: string;
  getActiveTurn?: () => ActiveTeachingTurn | null | undefined;
}>;

// Structured detail for writes that surface as rich transcript entries
// (inline demo cards, journal cards) instead of a plain tool-call row.
export type TeachingWriteAttachment =
  | Readonly<{ kind: "demo"; file: string; title?: string }>
  | Readonly<{
      kind: "journal-note";
      entryId: number;
      topicId: number;
      markdown: string;
    }>
  | Readonly<{
      kind: "topic-proposals";
      cardId: string;
      topics: readonly TopicProposal[];
    }>
  | Readonly<{
      kind: "feynman";
      cardId: string;
      concept: string;
      prompt: string;
      keyPoints: readonly string[];
    }>;

export type TeachingWriteEvent = Readonly<{
  tool: TeachingToolName;
  courseId: number;
  summary: string;
  activeTurn?: ActiveTeachingTurn;
  attachment?: TeachingWriteAttachment;
}>;

export type TeachingServerOptions = Readonly<{
  store: Store;
  scope: TeachingSessionScope;
  onWrite?: (event: TeachingWriteEvent) => void | Promise<void>;
}>;

export type ResolveTeachingScope = (
  sessionToken: string,
) =>
  | TeachingSessionScope
  | null
  | undefined
  | Promise<TeachingSessionScope | null | undefined>;

export type TeachingHttpHandlerOptions = Readonly<{
  store: Store;
  resolveScope: ResolveTeachingScope;
  onWrite?: (event: TeachingWriteEvent) => void | Promise<void>;
  tokenFromRequest?: (request: Request) => string | undefined;
}>;

type JsonRecord = Record<string, unknown>;

type TopicPlacementRow = Readonly<{
  id: number | bigint;
  parent_id: number | bigint | null;
  path: string;
  position: number | bigint;
}>;

type TopicProposal = Readonly<{
  path: string;
  title: string;
  blurb: string;
}>;

type TeachingToolOutput = Readonly<{
  result: McpToolCallResult;
  writeSummary?: string;
  writeAttachment?: TeachingWriteAttachment;
}>;

const jsonSchema = (schema: McpJsonObject): McpJsonObject => schema;

const objectSchema = (
  properties: McpJsonObject,
  required: readonly string[] = [],
): McpJsonObject =>
  jsonSchema({
    type: "object",
    additionalProperties: false,
    properties,
    required,
  });

const stringSchema = (description: string): McpJsonObject =>
  jsonSchema({
    type: "string",
    minLength: 1,
    description,
  });

const nullableStringSchema = (description: string): McpJsonObject =>
  jsonSchema({
    type: ["string", "null"],
    description,
  });

const inputSchemas: Record<TeachingToolName, McpJsonObject> = {
  get_course_state: objectSchema({
    transcriptLimit: {
      type: "integer",
      minimum: 1,
      maximum: 200,
      default: 20,
      description: "Maximum number of recent transcript turns to include.",
    },
  }),
  upsert_topic: objectSchema(
    {
      path: stringSchema("Stable slash-delimited topic path."),
      title: stringSchema("Topic title. Defaults to the final path segment."),
      body: {
        type: "string",
        description: "Topic body or notes.",
      },
      parentPath: nullableStringSchema(
        "Optional parent topic path. Null moves the topic to the root.",
      ),
      parent: nullableStringSchema(
        "Alias for parentPath. Null moves the topic to the root.",
      ),
      position: {
        type: "integer",
        minimum: 0,
        description: "Sibling ordering position.",
      },
      setCurrent: {
        type: "boolean",
        description: "When true, marks the topic as the current topic.",
      },
      status: {
        type: "string",
        enum: ["active", "archived"],
        description: "Topic lifecycle status.",
      },
      masteryConcept: nullableStringSchema(
        "Optional concept id used for mastery lookup.",
      ),
    },
    ["path"],
  ),
  propose_topics: objectSchema(
    {
      topics: {
        type: "array",
        minItems: 1,
        maxItems: 3,
        items: objectSchema(
          {
            path: stringSchema("Stable slash-delimited frontier topic path."),
            title: stringSchema("Learner-facing topic card title."),
            blurb: stringSchema("One-sentence reason this topic is a useful next step."),
          },
          ["path", "title", "blurb"],
        ),
      },
    },
    ["topics"],
  ),
  emit_demo: objectSchema(
    {
      title: stringSchema("Demo title."),
      body: stringSchema("Demo body."),
      format: {
        type: "string",
        enum: ["markdown", "html", "text"],
        default: "markdown",
      },
      topicPath: stringSchema("Optional topic path to attach the demo to."),
      fileName: stringSchema("Optional stable file name for idempotent updates."),
    },
    ["title", "body"],
  ),
  append_lesson_note: objectSchema(
    {
      markdown: stringSchema("Study note markdown to append to the topic journal."),
      topicPath: stringSchema(
        "Optional topic path override for tangents. Defaults to the running turn's snapshot topic.",
      ),
    },
    ["markdown"],
  ),
  record_mastery: objectSchema(
    {
      concept: stringSchema("Concept id or topic slug."),
      score: {
        type: "integer",
        minimum: 0,
        maximum: 100,
      },
      gaps: {
        oneOf: [
          { type: "string" },
          {
            type: "array",
            items: { type: "string" },
          },
        ],
        description: "Optional gap notes.",
      },
      topicPath: stringSchema("Optional topic path to bind the score to."),
    },
    ["concept", "score"],
  ),
  feynman_check: objectSchema(
    {
      concept: stringSchema("Concept being checked."),
      prompt: stringSchema("Prompt the learner should answer."),
      keyPoints: {
        type: "array",
        minItems: 1,
        items: { type: "string", minLength: 1 },
      },
      topicPath: stringSchema("Optional topic path to bind the check to."),
    },
    ["concept", "prompt", "keyPoints"],
  ),
  upsert_glossary_entry: objectSchema(
    {
      term: stringSchema("Glossary term."),
      definition: stringSchema("Glossary definition."),
      topicPath: stringSchema(
        "Optional topic path for this glossary entry. Defaults to the current topic.",
      ),
    },
    ["term", "definition"],
  ),
  update_course_info: objectSchema(
    {
      title: stringSchema("Course title."),
      description: nullableStringSchema("Course description."),
    },
    [],
  ),
};

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asNumber = (value: number | bigint): number =>
  typeof value === "bigint" ? Number(value) : value;

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const jsonResult = (value: unknown): McpToolCallResult =>
  textMcpResult(JSON.stringify(value, null, 2));

const errorResult = (message: string): McpToolCallResult =>
  textMcpResult(
    JSON.stringify(
      {
        ok: false,
        error: message,
      },
      null,
      2,
    ),
    { isError: true },
  );

const hasKey = (args: McpJsonObject, key: string): boolean =>
  Object.hasOwn(args, key);

const assertKnownKeys = (
  args: McpJsonObject,
  tool: TeachingToolName,
  knownKeys: readonly string[],
): void => {
  const known = new Set(knownKeys);

  for (const key of Object.keys(args)) {
    if (!known.has(key)) {
      throw new Error(`${tool} does not accept input field "${key}".`);
    }
  }
};

const normalizeRequiredString = (value: unknown, label: string): string => {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string.`);
  }

  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(`${label} cannot be empty.`);
  }

  return normalized;
};

const requireString = (args: McpJsonObject, key: string): string =>
  normalizeRequiredString(args[key], key);

const requireBodyString = (args: McpJsonObject, key: string): string => {
  const value = args[key];
  if (typeof value !== "string") {
    throw new Error(`${key} must be a string.`);
  }

  if (value.trim().length === 0) {
    throw new Error(`${key} cannot be empty.`);
  }

  return value;
};

const optionalString = (
  args: McpJsonObject,
  key: string,
): string | undefined => {
  if (!hasKey(args, key)) {
    return undefined;
  }

  return normalizeRequiredString(args[key], key);
};

const optionalBodyString = (
  args: McpJsonObject,
  key: string,
): string | undefined => {
  if (!hasKey(args, key)) {
    return undefined;
  }

  const value = args[key];
  if (typeof value !== "string") {
    throw new Error(`${key} must be a string.`);
  }

  return value;
};

const optionalStringOrNull = (
  args: McpJsonObject,
  key: string,
): string | null | undefined => {
  if (!hasKey(args, key)) {
    return undefined;
  }

  const value = args[key];
  if (value === null) {
    return null;
  }

  return normalizeRequiredString(value, key);
};

const optionalBoolean = (
  args: McpJsonObject,
  key: string,
): boolean | undefined => {
  if (!hasKey(args, key)) {
    return undefined;
  }

  const value = args[key];
  if (typeof value !== "boolean") {
    throw new Error(`${key} must be a boolean.`);
  }

  return value;
};

const optionalInteger = (
  args: McpJsonObject,
  key: string,
  options: Readonly<{ min?: number; max?: number }> = {},
): number | undefined => {
  if (!hasKey(args, key)) {
    return undefined;
  }

  const value = args[key];
  if (!Number.isInteger(value)) {
    throw new Error(`${key} must be an integer.`);
  }

  const integer = value as number;
  if (options.min !== undefined && integer < options.min) {
    throw new Error(`${key} must be at least ${options.min}.`);
  }

  if (options.max !== undefined && integer > options.max) {
    throw new Error(`${key} must be at most ${options.max}.`);
  }

  return integer;
};

const requireInteger = (
  args: McpJsonObject,
  key: string,
  options: Readonly<{ min?: number; max?: number }> = {},
): number => {
  const value = optionalInteger(args, key, options);
  if (value === undefined) {
    throw new Error(`${key} is required.`);
  }

  return value;
};

const optionalTopicStatus = (
  args: McpJsonObject,
  key: string,
): TopicStatus | undefined => {
  if (!hasKey(args, key)) {
    return undefined;
  }

  const value = args[key];
  if (value !== "active" && value !== "archived") {
    throw new Error(`${key} must be "active" or "archived".`);
  }

  return value;
};

const optionalDemoFormat = (
  args: McpJsonObject,
  key: string,
): DemoBodyFormat => {
  if (!hasKey(args, key)) {
    return "markdown";
  }

  const value = args[key];
  if (value !== "markdown" && value !== "html" && value !== "text") {
    throw new Error(`${key} must be "markdown", "html", or "text".`);
  }

  return value;
};

const requireStringArray = (
  args: McpJsonObject,
  key: string,
): readonly string[] => {
  const value = args[key];
  if (!Array.isArray(value)) {
    throw new Error(`${key} must be an array of strings.`);
  }

  const strings = value.map((item, index) =>
    normalizeRequiredString(item, `${key}[${index}]`),
  );

  if (strings.length === 0) {
    throw new Error(`${key} cannot be empty.`);
  }

  return strings;
};

const requireTopicProposals = (args: McpJsonObject): readonly TopicProposal[] => {
  const value = args["topics"];
  if (!Array.isArray(value)) {
    throw new Error("topics must be an array.");
  }

  if (value.length < 1 || value.length > 3) {
    throw new Error("topics must contain 1 to 3 items.");
  }

  return value.map((item, index) => {
    if (!isRecord(item)) {
      throw new Error(`topics[${index}] must be an object.`);
    }

    return {
      path: normalizeTopicPath(
        normalizeRequiredString(item["path"], `topics[${index}].path`),
      ),
      title: normalizeRequiredString(item["title"], `topics[${index}].title`),
      blurb: normalizeRequiredString(item["blurb"], `topics[${index}].blurb`),
    };
  });
};

const optionalGaps = (args: McpJsonObject): string | undefined => {
  if (!hasKey(args, "gaps")) {
    return undefined;
  }

  const value = args["gaps"];
  if (typeof value === "string") {
    return value.trim().length === 0 ? undefined : value;
  }

  if (!Array.isArray(value)) {
    throw new Error("gaps must be a string or an array of strings.");
  }

  const gaps = value.map((item, index) =>
    normalizeRequiredString(item, `gaps[${index}]`),
  );

  return gaps.join("\n");
};

const normalizeTopicPath = (path: string): string => {
  const normalized = path
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
    .join("/");

  if (normalized.length === 0) {
    throw new Error("Topic path cannot be empty.");
  }

  return normalized;
};

const topicSlug = (path: string): string => path.split("/").at(-1) ?? path;

const parentOfPath = (path: string): string | null => {
  const segments = path.split("/");
  if (segments.length <= 1) {
    return null;
  }

  return segments.slice(0, -1).join("/");
};

const joinParentPath = (
  parentPath: string | null | undefined,
  path: string,
): string => {
  if (parentPath === undefined) {
    return path;
  }

  const slug = topicSlug(path);
  return parentPath === null ? slug : `${parentPath}/${slug}`;
};

const resolveParentPath = (
  args: McpJsonObject,
): string | null | undefined => {
  const parentPath = optionalStringOrNull(args, "parentPath");
  const parent = optionalStringOrNull(args, "parent");

  if (
    parentPath !== undefined &&
    parent !== undefined &&
    parentPath !== parent
  ) {
    throw new Error("parent and parentPath cannot disagree.");
  }

  const resolved = parentPath ?? parent;
  return typeof resolved === "string" ? normalizeTopicPath(resolved) : resolved;
};

const getTopicPlacement = (
  store: Store,
  courseId: number,
  path: string,
): TopicPlacementRow | undefined =>
  store.db
    .query(
      `
        SELECT id, parent_id, path, position
        FROM topics
        WHERE course_id = ?1 AND path = ?2
      `,
    )
    .get(courseId, path) as TopicPlacementRow | undefined;

const getTopicPlacementById = (
  store: Store,
  topicId: number,
): TopicPlacementRow | undefined =>
  store.db
    .query(
      `
        SELECT id, parent_id, path, position
        FROM topics
        WHERE id = ?1
      `,
    )
    .get(topicId) as TopicPlacementRow | undefined;

const findCurrentTopicId = (store: Store, courseId: number): number | null => {
  const current = flattenTopicTree(readTopicTree(store, courseId)).find(
    (topic) => topic.isCurrent,
  );

  return current?.id ?? null;
};

const getActiveTurn = (
  scope: TeachingSessionScope,
): ActiveTeachingTurn | undefined => scope.getActiveTurn?.() ?? undefined;

const defaultTopicId = (
  store: Store,
  scope: TeachingSessionScope,
): number | null => {
  const activeTurn = getActiveTurn(scope);
  if (activeTurn !== undefined) {
    return activeTurn.topicId;
  }

  return findCurrentTopicId(store, scope.courseId);
};

const markCurrentTopic = (
  store: Store,
  courseId: number,
  topicId: number,
): void => {
  const timestamp = new Date().toISOString();

  store.db
    .query("UPDATE topics SET is_current = 0 WHERE course_id = ?1")
    .run(courseId);
  store.db
    .query(
      `
        UPDATE topics
        SET is_current = 1,
            entered_at = COALESCE(entered_at, ?1),
            updated_at = ?1
        WHERE id = ?2 AND course_id = ?3
      `,
    )
    .run(timestamp, topicId, courseId);
};

const ensureParentTopic = (
  store: Store,
  courseId: number,
  parentPath: string | null | undefined,
): void => {
  if (parentPath === undefined || parentPath === null) {
    return;
  }

  if (getTopicByPath(store, courseId, parentPath) !== undefined) {
    return;
  }

  upsertTopic(store, courseId, {
    path: parentPath,
    title: topicSlug(parentPath),
    isCurrent: false,
  });
};

const updateTopicPlacement = (
  store: Store,
  courseId: number,
  originalPath: string,
  parentPath: string | null | undefined,
  position: number | undefined,
): Topic => {
  const topic = getTopicByPath(store, courseId, originalPath);
  if (topic === undefined) {
    throw new Error(`Topic does not exist: ${originalPath}`);
  }

  const targetParentPath =
    parentPath === undefined ? parentOfPath(topic.path) : parentPath;
  const newPath = joinParentPath(parentPath, topic.path);

  if (
    targetParentPath !== null &&
    (targetParentPath === topic.path ||
      targetParentPath.startsWith(`${topic.path}/`))
  ) {
    throw new Error("A topic cannot be moved under itself or its descendants.");
  }

  const parent =
    targetParentPath === null
      ? undefined
      : getTopicPlacement(store, courseId, targetParentPath);
  if (targetParentPath !== null && parent === undefined) {
    throw new Error(`Parent topic does not exist: ${targetParentPath}`);
  }

  const placement = getTopicPlacementById(store, topic.id);
  if (placement === undefined) {
    throw new Error(`Topic does not exist: ${topic.id}`);
  }

  const oldPath = placement.path;
  if (newPath !== oldPath) {
    const collision = store.db
      .query(
        `
          SELECT path
          FROM topics
          WHERE course_id = ?1
            AND (path = ?2 OR path LIKE ?3)
            AND NOT (path = ?4 OR path LIKE ?5)
          LIMIT 1
        `,
      )
      .get(
        courseId,
        newPath,
        `${newPath}/%`,
        oldPath,
        `${oldPath}/%`,
      ) as { path: string } | undefined;

    if (collision !== undefined) {
      throw new Error(`Topic path already exists: ${collision.path}`);
    }

    const movingRows = store.db
      .query(
        `
          SELECT id, path
          FROM topics
          WHERE course_id = ?1
            AND (path = ?2 OR path LIKE ?3)
          ORDER BY length(path), id
        `,
      )
      .all(courseId, oldPath, `${oldPath}/%`) as readonly {
      id: number | bigint;
      path: string;
    }[];
    const timestamp = new Date().toISOString();

    for (const row of movingRows) {
      const suffix = row.path.slice(oldPath.length);
      store.db
        .query("UPDATE topics SET path = ?1, updated_at = ?2 WHERE id = ?3")
        .run(`${newPath}${suffix}`, timestamp, row.id);
    }
  }

  const refreshed = getTopicPlacement(store, courseId, newPath);
  if (refreshed === undefined) {
    throw new Error(`Unable to read moved topic: ${newPath}`);
  }

  store.db
    .query(
      `
        UPDATE topics
        SET parent_id = ?1,
            position = ?2,
            updated_at = ?3
        WHERE id = ?4
      `,
    )
    .run(
      parent === undefined ? null : parent.id,
      position ?? asNumber(refreshed.position),
      new Date().toISOString(),
      refreshed.id,
    );

  const updated = getTopicByPath(store, courseId, newPath);
  if (updated === undefined) {
    throw new Error(`Unable to read topic after placement update: ${newPath}`);
  }

  return updated;
};

const resolveTopicId = (
  store: Store,
  courseId: number,
  topicPath: string | undefined,
): number | undefined => {
  if (topicPath === undefined) {
    return undefined;
  }

  const topic = getTopicByPath(store, courseId, normalizeTopicPath(topicPath));
  if (topic === undefined) {
    throw new Error(`Topic does not exist: ${topicPath}`);
  }

  return topic.id;
};

const resolveTopicIdOrDefault = (
  store: Store,
  scope: TeachingSessionScope,
  topicPath: string | undefined,
): number | null | undefined =>
  topicPath === undefined
    ? defaultTopicId(store, scope)
    : resolveTopicId(store, scope.courseId, topicPath);

const extensionForFormat = (format: DemoBodyFormat): string => {
  if (format === "html") {
    return "html";
  }

  if (format === "text") {
    return "txt";
  }

  return "md";
};

const slugify = (value: string): string => {
  const slug = value
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return slug.length === 0 ? "demo" : slug;
};

const generatedDemoFileName = (
  title: string,
  format: DemoBodyFormat,
): string =>
  `${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}-${slugify(title)}.${extensionForFormat(format)}`;

const publicCourse = (course: Course): McpJsonObject => ({
  id: course.id,
  title: course.title,
  description: course.description,
  status: course.status,
  attachedDir: course.attachedDir,
  harness: course.harnessId,
});

const journalEntriesPerTopicLimit = 5;

const publicJournalEntry = (
  entry: TopicJournalEntry,
  demosById: ReadonlyMap<number, Demo>,
): McpJsonObject => {
  const base = {
    id: entry.id,
    kind: entry.kind,
    topicId: entry.topicId,
    turn: entry.turn,
    createdAt: entry.createdAt,
  };

  if (entry.kind === "demo") {
    const demo = entry.demoId === null ? undefined : demosById.get(entry.demoId);
    return {
      ...base,
      demoId: entry.demoId,
      demo:
        demo === undefined
          ? null
          : {
              id: demo.id,
              title: demo.title,
              fileName: demo.fileName,
              file: demoFileKey(demo),
              format: demo.bodyFormat,
              addedAt: demo.addedAt,
            },
    };
  }

  return {
    ...base,
    bodyMarkdown: entry.bodyMarkdown ?? "",
  };
};

const publicJournalWindow = (
  store: Store,
  courseId: number,
  topic: Topic,
  demosById: ReadonlyMap<number, Demo>,
): McpJsonObject => {
  const entries = listJournalEntries(store, courseId, topic.id);
  const visibleEntries = topic.isCurrent
    ? entries
    : entries.slice(-journalEntriesPerTopicLimit);

  return {
    totalCount: entries.length,
    limit: topic.isCurrent ? null : journalEntriesPerTopicLimit,
    entries: visibleEntries.map((entry) => publicJournalEntry(entry, demosById)),
  };
};

const publicTopic = (
  store: Store,
  courseId: number,
  topic: Topic,
  demosById: ReadonlyMap<number, Demo>,
): McpJsonObject => {
  const latestMastery = latestMasteryForTopic(store, courseId, topic.path);

  return {
    id: topic.id,
    path: topic.path,
    title: topic.title,
    body: topic.body,
    status: topic.status,
    position: topic.position,
    state: topic.state,
    current: topic.isCurrent,
    mastery:
      latestMastery === null
        ? null
        : {
            concept: latestMastery.concept,
            score: latestMastery.score,
            gaps: latestMastery.gaps,
            ts: latestMastery.ts,
          },
    journal: publicJournalWindow(store, courseId, topic, demosById),
    children: topic.children.map((child) =>
      publicTopic(store, courseId, child, demosById),
    ),
  };
};

const publicTranscriptEntry = (entry: TranscriptEntry): McpJsonObject => ({
  id: entry.id,
  topicId: entry.topicId,
  turn: entry.turn,
  role: entry.role,
  kind: entry.kind,
  content: entry.content,
  ts: entry.ts,
});

const readTranscriptTail = (
  store: Store,
  courseId: number,
  limit: number,
): readonly McpJsonObject[] => {
  let afterId: number | undefined;
  let tail: readonly TranscriptEntry[] = [];

  while (true) {
    const page = pageTranscript(store, courseId, {
      ...(afterId === undefined ? {} : { afterId }),
      limit: 200,
    });
    tail = [...tail, ...page.entries].slice(-limit);

    if (page.nextAfterId === null) {
      break;
    }

    afterId = page.nextAfterId;
  }

  return tail.map(publicTranscriptEntry);
};

const courseStatePayload = (
  store: Store,
  courseId: number,
  transcriptLimit: number,
): McpJsonObject => {
  const course = getCourse(store, courseId);
  if (course === undefined) {
    throw new Error(`Course does not exist: ${courseId}`);
  }

  const demos = listDemos(store, courseId);
  const demosById = new Map(demos.map((demo) => [demo.id, demo]));
  const topicTree = readTopicTree(store, courseId);
  const flatTopics = flattenTopicTree(topicTree);
  const activeFeynman = getActiveFeynmanCheck(store, courseId);

  return {
    server: teachingMcpServerName,
    course: publicCourse(course),
    currentTopicPath: flatTopics.find((topic) => topic.isCurrent)?.path ?? null,
    topics: topicTree.map((topic) =>
      publicTopic(store, courseId, topic, demosById),
    ),
    dueForReview: listTopicsDueForReview(store, courseId, { limit: 5 }).map(
      (entry) => ({
        path: entry.topic.path,
        title: entry.topic.title,
        latestScore: entry.latestScore?.score ?? null,
      }),
    ),
    glossary: listGlossary(store, courseId).map((entry) => ({
      term: entry.term,
      definition: entry.definition,
      topicId: entry.topicId,
    })),
    activeFeynmanCheck:
      activeFeynman === null
        ? null
        : {
            concept: activeFeynman.concept,
            prompt: activeFeynman.prompt,
            keyPoints: activeFeynman.keyPoints,
            issuedAt: activeFeynman.issuedAt,
          },
    demos: demos.map((demo) => ({
      id: demo.id,
      topicId: demo.topicId,
      title: demo.title,
      fileName: demo.fileName,
      file: demoFileKey(demo),
      format: demo.bodyFormat,
      addedAt: demo.addedAt,
    })),
    transcriptTail: readTranscriptTail(store, courseId, transcriptLimit),
  };
};

const notifyWrite = async (
  onWrite: TeachingServerOptions["onWrite"],
  courseId: number,
  tool: TeachingToolName,
  summary: string,
  activeTurn: ActiveTeachingTurn | undefined,
  attachment?: TeachingWriteAttachment,
): Promise<void> => {
  if (onWrite === undefined) {
    return;
  }

  try {
    await onWrite({
      tool,
      courseId,
      summary,
      ...(activeTurn === undefined ? {} : { activeTurn }),
      ...(attachment === undefined ? {} : { attachment }),
    });
  } catch {
    // Notification failures should not hide a committed teaching write.
  }
};

const createTeachingTool = (
  options: TeachingServerOptions,
  tool: Readonly<{
    name: TeachingToolName;
    description: string;
    knownKeys: readonly string[];
    call: (args: McpJsonObject) => TeachingToolOutput | Promise<TeachingToolOutput>;
  }>,
): McpServerTool => ({
  name: tool.name,
  description: tool.description,
  inputSchema: inputSchemas[tool.name],
  call: async (args) => {
    try {
      assertKnownKeys(args, tool.name, tool.knownKeys);
      const activeTurn = getActiveTurn(options.scope);
      const output = await tool.call(args);

      if (output.result.isError !== true && output.writeSummary !== undefined) {
        await notifyWrite(
          options.onWrite,
          options.scope.courseId,
          tool.name,
          output.writeSummary,
          activeTurn,
          output.writeAttachment,
        );
      }

      return output.result;
    } catch (error) {
      return errorResult(errorMessage(error));
    }
  },
});

const getCourseStateTool = (
  options: TeachingServerOptions,
): McpServerTool =>
  createTeachingTool(options, {
    name: "get_course_state",
    description:
      "Returns compact rebuild-from-truth course state for resuming a teaching session. Topic journals include all entries for the current topic and the last 5 entries plus totalCount for every other topic.",
    knownKeys: ["transcriptLimit"],
    call: (args) => {
      const transcriptLimit =
        optionalInteger(args, "transcriptLimit", { min: 1, max: 200 }) ?? 20;

      return {
        result: jsonResult(
          courseStatePayload(options.store, options.scope.courseId, transcriptLimit),
        ),
      };
    },
  });

const upsertTopicTool = (options: TeachingServerOptions): McpServerTool =>
  createTeachingTool(options, {
    name: "upsert_topic",
    description:
      "Creates or updates a topic by path, optionally moving it and marking it current.",
    knownKeys: [
      "path",
      "title",
      "body",
      "parentPath",
      "parent",
    "position",
    "setCurrent",
    "status",
    "masteryConcept",
  ],
    call: (args) => {
      const requestedPath = normalizeTopicPath(requireString(args, "path"));
      const parentPath = resolveParentPath(args);
      const finalPath = joinParentPath(parentPath, requestedPath);
      const title = optionalString(args, "title");
      const body = optionalBodyString(args, "body");
      const position = optionalInteger(args, "position", { min: 0 });
      const setCurrent = optionalBoolean(args, "setCurrent");
      const status = optionalTopicStatus(args, "status");
      const masteryConcept = optionalStringOrNull(args, "masteryConcept");
      const courseId = options.scope.courseId;

      const topic = withStoreTransaction(options.store, () => {
        const currentTopicId =
          setCurrent === undefined
            ? findCurrentTopicId(options.store, courseId)
            : null;

        ensureParentTopic(options.store, courseId, parentPath);

        const existingRequested = getTopicByPath(
          options.store,
          courseId,
          requestedPath,
        );
        const upsertPath =
          existingRequested === undefined ? finalPath : requestedPath;

        upsertTopic(options.store, courseId, {
          path: upsertPath,
          ...(title === undefined ? {} : { title }),
          ...(body === undefined ? {} : { body }),
          ...(status === undefined ? {} : { status }),
          ...(masteryConcept === undefined ? {} : { masteryConcept }),
          isCurrent: setCurrent === true,
        });

        const placed =
          parentPath === undefined && position === undefined
            ? getTopicByPath(options.store, courseId, upsertPath)
            : updateTopicPlacement(
                options.store,
                courseId,
                upsertPath,
                parentPath,
                position,
              );

        if (placed === undefined) {
          throw new Error(`Unable to read topic after upsert: ${upsertPath}`);
        }

        if (setCurrent === undefined && currentTopicId !== null) {
          markCurrentTopic(options.store, courseId, currentTopicId);
        }

        return getTopicByPath(options.store, courseId, placed.path) ?? placed;
      });

      const demosById = new Map(
        listDemos(options.store, courseId).map((demo) => [demo.id, demo]),
      );

      return {
        result: jsonResult({
          ok: true,
          topic: publicTopic(options.store, courseId, topic, demosById),
        }),
        writeSummary: `upserted topic ${topic.path}`,
      };
    },
  });

const proposeTopicsTool = (options: TeachingServerOptions): McpServerTool =>
  createTeachingTool(options, {
    name: "propose_topics",
    description:
      "Propose 1 to 3 adjacent next topics as clickable learner cards. Use when a natural next-step choice appears, either at a topic conclusion or at a genuine mid-topic fork. These are local frontier suggestions, not a syllabus; do not call twice in a row without teaching in between.",
    knownKeys: ["topics"],
    call: (args) => {
      const proposals = requireTopicProposals(args);
      const courseId = options.scope.courseId;

      const topics = withStoreTransaction(options.store, () =>
        proposals.map((proposal) => {
          const existing = getTopicByPath(options.store, courseId, proposal.path);
          if (existing !== undefined) {
            return existing;
          }

          return upsertTopic(options.store, courseId, {
            path: proposal.path,
            title: proposal.title,
            body: "",
            isCurrent: false,
          });
        }),
      );
      const cardId = `topic-proposals-${randomUUID()}`;

      return {
        result: jsonResult({
          ok: true,
          cardId,
          topics: proposals.map((proposal, index) => ({
            ...proposal,
            topicId: topics[index]?.id ?? null,
          })),
        }),
        writeSummary: `proposed ${proposals.length} topic${proposals.length === 1 ? "" : "s"}`,
        writeAttachment: {
          kind: "topic-proposals",
          cardId,
          topics: proposals,
        },
      };
    },
  });

const emitDemoTool = (options: TeachingServerOptions): McpServerTool =>
  createTeachingTool(options, {
    name: "emit_demo",
    description:
      "Stores a teaching demo body and emits a chat attachment. If topicPath is omitted, the demo defaults to the running turn's snapshot topic; when no topic can be resolved, the demo is emitted to chat only and no journal pin is written.",
    knownKeys: ["title", "body", "format", "topicPath", "fileName"],
    call: (args) => {
      const title = requireString(args, "title");
      const body = requireBodyString(args, "body");
      const bodyFormat = optionalDemoFormat(args, "format");
      const topicPath = optionalString(args, "topicPath");
      const explicitFileName = optionalString(args, "fileName");
      const fileName =
        explicitFileName ?? generatedDemoFileName(title, bodyFormat);
      const activeTurn = getActiveTurn(options.scope);
      const resolvedTopicId = resolveTopicIdOrDefault(
        options.store,
        options.scope,
        topicPath,
      );

      const demo = withStoreTransaction(options.store, () => {
        const storedDemo = upsertDemo(options.store, options.scope.courseId, {
          ...(resolvedTopicId === null || resolvedTopicId === undefined
            ? {}
            : { topicId: resolvedTopicId }),
          fileName,
          title,
          body,
          bodyFormat,
        });

        if (resolvedTopicId !== null && resolvedTopicId !== undefined) {
          upsertJournalDemoPin(options.store, options.scope.courseId, {
            topicId: resolvedTopicId,
            demoId: storedDemo.id,
            turn: activeTurn?.turn ?? null,
          });
        }

        return storedDemo;
      });

      return {
        result: jsonResult({
          ok: true,
          demo: {
            id: demo.id,
            topicId: demo.topicId,
            title: demo.title,
            fileName: demo.fileName,
            file: demoFileKey(demo),
            format: demo.bodyFormat,
          },
        }),
        writeSummary: `emitted demo ${title}`,
        writeAttachment: { kind: "demo", file: demoFileKey(demo), title },
      };
    },
  });

const appendLessonNoteTool = (options: TeachingServerOptions): McpServerTool =>
  createTeachingTool(options, {
    name: "append_lesson_note",
    description:
      "Appends a short study note to a topic journal. topicPath defaults to the running turn's snapshot topic; pass topicPath explicitly for tangents.",
    knownKeys: ["markdown", "topicPath"],
    call: (args) => {
      const markdown = requireBodyString(args, "markdown");
      const topicPath = optionalString(args, "topicPath");
      const topicId = resolveTopicIdOrDefault(
        options.store,
        options.scope,
        topicPath,
      );

      if (topicId === null || topicId === undefined) {
        throw new Error(
          "append_lesson_note needs a topicPath because there is no current topic for this turn.",
        );
      }

      const activeTurn = getActiveTurn(options.scope);
      const entry = appendJournalEntry(options.store, options.scope.courseId, {
        topicId,
        kind: "note",
        bodyMarkdown: markdown,
        turn: activeTurn?.turn ?? null,
      });

      return {
        result: jsonResult({
          ok: true,
          entry: {
            id: entry.id,
            topicId: entry.topicId,
            kind: entry.kind,
            bodyMarkdown: entry.bodyMarkdown,
            turn: entry.turn,
            createdAt: entry.createdAt,
          },
        }),
        writeSummary: `appended study note to topic ${topicId}`,
        writeAttachment: {
          kind: "journal-note",
          entryId: entry.id,
          topicId: entry.topicId,
          markdown,
        },
      };
    },
  });

const recordMasteryTool = (options: TeachingServerOptions): McpServerTool =>
  createTeachingTool(options, {
    name: "record_mastery",
    description: "Appends a mastery score from 0 to 100 for a concept.",
    knownKeys: ["concept", "score", "gaps", "topicPath"],
    call: (args) => {
      const concept = requireString(args, "concept");
      const score = requireInteger(args, "score", { min: 0, max: 100 });
      const gaps = optionalGaps(args);
      const topicPath = optionalString(args, "topicPath");
      const topicId = resolveTopicId(
        options.store,
        options.scope.courseId,
        topicPath,
      );
      const event = appendMasteryEvent(options.store, options.scope.courseId, {
        concept,
        score,
        ...(gaps === undefined ? {} : { gaps }),
        ...(topicId === undefined ? {} : { topicId }),
      });

      return {
        result: jsonResult({
          ok: true,
          mastery: {
            id: event.id,
            concept: event.concept,
            score: event.score,
            gaps: event.gaps,
            topicId: event.topicId,
            ts: event.ts,
          },
        }),
        writeSummary: `recorded mastery ${concept}=${score}`,
      };
    },
  });

const feynmanCheckTool = (options: TeachingServerOptions): McpServerTool =>
  createTeachingTool(options, {
    name: "feynman_check",
    description: "Issues a new active Feynman check, replacing any active check.",
    knownKeys: ["concept", "prompt", "keyPoints", "topicPath"],
    call: (args) => {
      const concept = requireString(args, "concept");
      const prompt = requireString(args, "prompt");
      const keyPoints = requireStringArray(args, "keyPoints");
      const topicPath = optionalString(args, "topicPath");
      const topicId = resolveTopicId(
        options.store,
        options.scope.courseId,
        topicPath,
      );
      const check = registerFeynmanCheck(options.store, options.scope.courseId, {
        concept,
        prompt,
        keyPoints,
        ...(topicId === undefined ? {} : { topicId }),
      });
      const cardId = `feynman-${check.id}`;

      return {
        result: jsonResult({
          ok: true,
          cardId,
          feynmanCheck: {
            id: check.id,
            concept: check.concept,
            prompt: check.prompt,
            keyPoints: check.keyPoints,
            topicId: check.topicId,
            issuedAt: check.issuedAt,
          },
        }),
        writeSummary: `issued feynman check for ${concept}`,
        writeAttachment: {
          kind: "feynman",
          cardId,
          concept: check.concept,
          prompt: check.prompt,
          keyPoints: check.keyPoints,
        },
      };
    },
  });

const upsertGlossaryEntryTool = (
  options: TeachingServerOptions,
): McpServerTool =>
  createTeachingTool(options, {
    name: "upsert_glossary_entry",
    description: "Creates or updates a glossary entry scoped to the course.",
    knownKeys: ["term", "definition", "topicPath"],
    call: (args) => {
      const term = requireString(args, "term");
      const definition = requireString(args, "definition");
      const topicPath = optionalString(args, "topicPath");
      const topicId =
        topicPath === undefined
          ? defaultTopicId(options.store, options.scope)
          : resolveTopicId(options.store, options.scope.courseId, topicPath);
      const entry = upsertGlossaryEntry(
        options.store,
        options.scope.courseId,
        {
          term,
          definition,
          topicId: topicId ?? null,
        },
      );

      return {
        result: jsonResult({
          ok: true,
          glossaryEntry: {
            id: entry.id,
            term: entry.term,
            definition: entry.definition,
            topicId: entry.topicId,
          },
        }),
        writeSummary: `upserted glossary entry ${term}`,
      };
    },
  });

const updateCourseInfoTool = (
  options: TeachingServerOptions,
): McpServerTool =>
  createTeachingTool(options, {
    name: "update_course_info",
    description: "Updates the course title and/or description.",
    knownKeys: ["title", "description"],
    call: (args) => {
      const course = getCourse(options.store, options.scope.courseId);
      if (course === undefined) {
        throw new Error(`Course does not exist: ${options.scope.courseId}`);
      }

      const title = optionalString(args, "title");
      const description = optionalStringOrNull(args, "description");
      if (title === undefined && description === undefined) {
        throw new Error("update_course_info requires title or description.");
      }

      const updated = patchCourse(options.store, course.id, {
        ...(title === undefined ? {} : { title }),
        ...(description === undefined ? {} : { description }),
      });

      return {
        result: jsonResult({
          ok: true,
          course: publicCourse(updated),
        }),
        writeSummary: `updated course info for ${updated.title}`,
      };
    },
  });

export const createTeachingMcpServer = (
  options: TeachingServerOptions,
): McpServerDefinition => ({
  name: teachingMcpServerName,
  version: "0.0.0",
  tools: [
    getCourseStateTool(options),
    upsertTopicTool(options),
    proposeTopicsTool(options),
    emitDemoTool(options),
    appendLessonNoteTool(options),
    recordMasteryTool(options),
    feynmanCheckTool(options),
    upsertGlossaryEntryTool(options),
    updateCourseInfoTool(options),
  ],
});

// The daemon mounts this handler at /mcp/<token>; the token is the path segment
// immediately following "mcp", falling back to the final path segment for tests.
export const teachingTokenFromRequestPath = (
  request: Request,
): string | undefined => {
  const pathSegments = new URL(request.url).pathname
    .split("/")
    .filter((segment) => segment.length > 0);
  const mcpIndex = pathSegments.lastIndexOf("mcp");
  const tokenSegment =
    mcpIndex === -1 ? pathSegments.at(-1) : pathSegments.at(mcpIndex + 1);

  return tokenSegment === undefined || tokenSegment.length === 0
    ? undefined
    : decodeURIComponent(tokenSegment);
};

export const createTeachingMcpHttpHandler = (
  options: TeachingHttpHandlerOptions,
): ((request: Request) => Promise<Response>) => {
  const tokenFromRequest =
    options.tokenFromRequest ?? teachingTokenFromRequestPath;

  return async (request) => {
    const sessionToken = tokenFromRequest(request);
    if (sessionToken === undefined) {
      return new Response("Missing teaching session token.", { status: 404 });
    }

    const resolvedScope = await options.resolveScope(sessionToken);
    if (resolvedScope === undefined || resolvedScope === null) {
      return new Response("Unknown teaching session token.", { status: 404 });
    }

    const definition = createTeachingMcpServer({
      store: options.store,
      scope: {
        ...resolvedScope,
        sessionToken: resolvedScope.sessionToken ?? sessionToken,
      },
      ...(options.onWrite === undefined ? {} : { onWrite: options.onWrite }),
    });
    const handler = createMcpHttpHandler(definition, {
      sessionId: `mcp-${sessionToken}`,
    });

    return await handler(request);
  };
};

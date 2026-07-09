import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  resolve,
} from "node:path";

import {
  appendJournalEntry,
  appendMasteryEvent,
  appendTranscriptEntry,
  appendTurnEvents,
  createCourse,
  flattenTopicTree,
  getCourse,
  importCourseFolder,
  listDemos,
  listFeynmanChecks,
  listGlossary,
  listJournalEntries,
  listMasteryEvents,
  listTurnEvents,
  pageTranscript,
  readTopicTree,
  replaceTopicTree,
  withStoreTransaction,
  type Course,
  type CourseInput,
  type CourseStatus,
  type DemoBodyFormat,
  type FeynmanCheckStatus,
  type JsonRecord,
  type Store,
  type Topic,
  type TopicJournalEntryKind,
  type TopicStatus,
  type TopicTreeInput,
  type TranscriptInput,
  type TranscriptRole,
  type TurnEventRecord,
} from "./index";

export const BUNDLE_FORMAT = "overlearn.course.bundle";
export const BUNDLE_FORMAT_VERSION = 1;

export type ExportCourseBundleOptions = Readonly<{
  includeTranscript?: boolean;
}>;

export type ExportCourseBundleResult = Readonly<{
  path: string;
}>;

export type ImportCoursePathResult = Readonly<{
  course: Course;
  warnings: readonly string[];
  source: "bundle" | "legacy";
}>;

type BundleCourse = Readonly<{
  title: string;
  description: string | null;
  status: CourseStatus;
  harnessId: string | null;
  model: string | null;
  effort: string | null;
  attachedDir: string | null;
  webSearchEnabled: boolean;
  sourceName: string | null;
  manifestExtra: JsonRecord;
  createdAt: string;
  updatedAt: string;
}>;

type BundleTopic = Readonly<{
  path: string;
  title: string;
  bodyFile: string;
  body: string;
  status: TopicStatus;
  enteredAt: string | null;
  isCurrent: boolean;
  masteryConcept: string | null;
  position: number;
  children: readonly BundleTopic[];
}>;

type BundleGlossary = Readonly<{
  term: string;
  definition: string;
  topicPath: string | null;
  addedAt: string;
}>;

type BundleJournalEntry = Readonly<{
  topicPath: string;
  kind: TopicJournalEntryKind;
  bodyMarkdown: string | null;
  demoFile: string | null;
  turn: number | null;
  createdAt: string;
}>;

type BundleMastery = Readonly<{
  concept: string;
  score: number;
  gaps: string | null;
  ts: string;
  topicPath: string | null;
}>;

type BundleFeynmanCheck = Readonly<{
  concept: string;
  prompt: string;
  keyPoints: readonly string[];
  issuedAt: string;
  status: FeynmanCheckStatus;
  topicPath: string | null;
  replacedConcept: string | null;
  replacedIssuedAt: string | null;
  replacedAt: string | null;
  createdAt: string;
  updatedAt: string;
}>;

type BundleDemo = Readonly<{
  fileName: string | null;
  file: string;
  title: string | null;
  bodyFormat: DemoBodyFormat;
  topicPath: string | null;
  addedAt: string;
  position: number;
}>;

type BundleTranscript = Readonly<{
  file: string;
  count: number;
}>;

type BundleTurnEvent = Readonly<Omit<TurnEventRecord, "id" | "courseId">>;

type BundleManifest = Readonly<{
  format: typeof BUNDLE_FORMAT;
  formatVersion: typeof BUNDLE_FORMAT_VERSION;
  exportedAt: string;
  course: BundleCourse;
  topics: readonly BundleTopic[];
  journals: readonly BundleJournalEntry[];
  glossary: readonly BundleGlossary[];
  mastery: readonly BundleMastery[];
  feynmanChecks: readonly BundleFeynmanCheck[];
  demos: readonly BundleDemo[];
  turnEvents: readonly BundleTurnEvent[];
  transcript?: BundleTranscript;
}>;

type ImportedBundleDemo = Readonly<{
  fileName: string | null;
  file: string;
  title: string | null;
  body: string;
  bodyFormat: DemoBodyFormat;
  topicPath: string | null;
  addedAt: string;
  position: number;
}>;

type ImportedBundleFeynman = BundleFeynmanCheck;

type ImportedBundleMastery = Readonly<{
  concept: string;
  score: number;
  gaps: string | null;
  ts: string;
  topicPath: string | null;
}>;

type ImportedBundleJournalEntry = BundleJournalEntry;

type ImportedBundleGlossary = BundleGlossary;

type ImportedBundlePayload = Readonly<{
  course: CourseInput;
  topics: readonly TopicTreeInput[];
  journals: readonly ImportedBundleJournalEntry[];
  glossary: readonly ImportedBundleGlossary[];
  mastery: readonly ImportedBundleMastery[];
  feynmanChecks: readonly ImportedBundleFeynman[];
  demos: readonly ImportedBundleDemo[];
  transcript: readonly ImportedTranscriptInput[];
  turnEvents: readonly BundleTurnEvent[];
}>;

type ImportedTranscriptInput = TranscriptInput &
  Readonly<{
    payload: JsonRecord;
    topicPath: string | null;
  }>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasErrorCode = (error: unknown, code: string): boolean =>
  isRecord(error) && error["code"] === code;

const nowIso = (): string => new Date().toISOString();

const stringifyJson = (value: unknown): string =>
  `${JSON.stringify(value, null, 2)}\n`;

const stringifyJsonLine = (value: unknown): string => JSON.stringify(value);

const parseJson = (text: string): unknown => JSON.parse(text) as unknown;

const slugify = (value: string, fallback: string): string => {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72);

  return slug.length === 0 ? fallback : slug;
};

const numberedName = (
  index: number,
  name: string,
  extension: string,
): string =>
  `${String(index + 1).padStart(3, "0")}-${slugify(name, "item")}${extension}`;

const bodyExtension = (format: DemoBodyFormat): string => {
  if (format === "html") {
    return ".html";
  }

  return format === "markdown" ? ".md" : ".txt";
};

const manifestPath = (dir: string): string => join(dir, "course.json");

const relativeBundlePath = (...segments: readonly string[]): string =>
  segments.join("/");

const bundleFilePath = (root: string, relativePath: string): string => {
  if (isAbsolute(relativePath)) {
    throw new Error(`Bundle file path must be relative: ${relativePath}`);
  }

  const normalized = relativePath.replaceAll("\\", "/");
  const segments = normalized.split("/");
  if (
    segments.length === 0 ||
    segments.some((segment) => segment.length === 0 || segment === "..")
  ) {
    throw new Error(`Bundle file path is invalid: ${relativePath}`);
  }

  return join(root, ...segments);
};

const writeBundleText = async (
  root: string,
  relativePath: string,
  text: string,
): Promise<void> => {
  const filePath = bundleFilePath(root, relativePath);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, text, "utf8");
};

const readBundleText = async (
  root: string,
  relativePath: string,
): Promise<string> => readFile(bundleFilePath(root, relativePath), "utf8");

const jsonRecord = (value: unknown): JsonRecord =>
  isRecord(value) ? { ...value } : {};

const stringValue = (
  record: Record<string, unknown>,
  key: string,
  label: string,
): string => {
  const value = record[key];
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string.`);
  }

  return value;
};

const optionalStringValue = (
  record: Record<string, unknown>,
  key: string,
): string | null => {
  const value = record[key];
  return typeof value === "string" ? value : null;
};

const numberValue = (
  record: Record<string, unknown>,
  key: string,
  fallback: number,
): number => {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
};

const stringArrayValue = (value: unknown): readonly string[] =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];

const arrayValue = (
  record: Record<string, unknown>,
  key: string,
): readonly unknown[] => {
  const value = record[key];
  return Array.isArray(value) ? value : [];
};

const parseCourseStatus = (value: unknown): CourseStatus => {
  if (value === "active" || value === "archived") {
    return value;
  }

  return "active";
};

const parseTopicStatus = (value: unknown): TopicStatus =>
  value === "archived" ? "archived" : "active";

const parseDemoBodyFormat = (value: unknown): DemoBodyFormat => {
  if (value === "html" || value === "text" || value === "markdown") {
    return value;
  }

  return "markdown";
};

const parseFeynmanStatus = (value: unknown): FeynmanCheckStatus => {
  if (
    value === "active" ||
    value === "replaced" ||
    value === "cleared" ||
    value === "skipped"
  ) {
    return value;
  }

  return "cleared";
};

const parseTranscriptRole = (value: unknown): TranscriptRole | undefined => {
  if (value === "learner" || value === "agent" || value === "system") {
    return value;
  }

  return undefined;
};

const courseForManifest = (course: Course): BundleCourse => ({
  title: course.title,
  description: course.description,
  status: course.status,
  harnessId: course.harnessId,
  model: course.model,
  effort: course.effort,
  attachedDir: course.attachedDir,
  webSearchEnabled: course.webSearchEnabled,
  sourceName: course.sourceName,
  manifestExtra: course.manifestExtra,
  createdAt: course.createdAt,
  updatedAt: course.updatedAt,
});

const bundleTopicFromTopic = (
  topic: Topic,
  index: { value: number },
): BundleTopic => {
  const bodyFile = relativeBundlePath(
    "topics",
    numberedName(index.value, topic.path, ".md"),
  );
  index.value += 1;

  return {
    path: topic.path,
    title: topic.title,
    bodyFile,
    body: topic.body,
    status: topic.status,
    enteredAt: topic.enteredAt,
    isCurrent: topic.isCurrent,
    masteryConcept: topic.masteryConcept,
    position: topic.position,
    children: topic.children.map((child) => bundleTopicFromTopic(child, index)),
  };
};

const writeTopicBodies = async (
  root: string,
  topics: readonly BundleTopic[],
): Promise<void> => {
  for (const topic of topics) {
    await writeBundleText(root, topic.bodyFile, topic.body);
    await writeTopicBodies(root, topic.children);
  }
};

const topicPathById = (topics: readonly Topic[]): ReadonlyMap<number, string> =>
  new Map(flattenTopicTree(topics).map((topic) => [topic.id, topic.path]));

const transcriptEntriesForCourse = (store: Store, courseId: number) => {
  let afterId: number | undefined;
  const entries = [];

  while (true) {
    const page = pageTranscript(store, courseId, {
      ...(afterId === undefined ? {} : { afterId }),
      limit: 200,
    });
    entries.push(...page.entries);

    if (page.nextAfterId === null) {
      return entries;
    }

    afterId = page.nextAfterId;
  }
};

const allocateExportDir = async (
  store: Store,
  course: Course,
): Promise<string> => {
  const exportsDir = join(store.dataDir, "exports");
  await mkdir(exportsDir, { recursive: true });

  const slug = slugify(course.title, `course-${course.id}`);
  for (let index = 1; index < 10_000; index += 1) {
    const candidate = join(exportsDir, `overlearn-${slug}-${index}`);
    try {
      await mkdir(candidate);
      return candidate;
    } catch (error) {
      if (hasErrorCode(error, "EEXIST")) {
        continue;
      }

      throw error;
    }
  }

  throw new Error(`Could not allocate export directory for ${course.title}.`);
};

const demoExportName = (
  index: number,
  fileName: string | null,
  title: string | null,
  format: DemoBodyFormat,
): string => {
  const source = fileName ?? title ?? "demo";
  const extension = extname(basename(source)) || bodyExtension(format);
  const stem = extension.length === 0 ? source : basename(source, extension);

  return numberedName(index, stem, extension);
};

export const exportCourseBundle = async (
  store: Store,
  courseId: number,
  options: ExportCourseBundleOptions = {},
): Promise<ExportCourseBundleResult> => {
  const course = getCourse(store, courseId);
  if (course === undefined) {
    throw new Error(`Course does not exist: ${courseId}`);
  }

  const exportDir = await allocateExportDir(store, course);

  try {
    const topics = readTopicTree(store, courseId);
    const topicPaths = topicPathById(topics);
    const topicIndex = { value: 0 };
    const bundleTopics = topics.map((topic) => bundleTopicFromTopic(topic, topicIndex));
    await writeTopicBodies(exportDir, bundleTopics);

    const demos: BundleDemo[] = [];
    const demoFilesById = new Map<number, string>();
    for (const [index, demo] of listDemos(store, courseId).entries()) {
      const file = relativeBundlePath(
        "demos",
        demoExportName(index, demo.fileName, demo.title, demo.bodyFormat),
      );
      await writeBundleText(exportDir, file, demo.body);
      demoFilesById.set(demo.id, file);
      demos.push({
        fileName: demo.fileName,
        file,
        title: demo.title,
        bodyFormat: demo.bodyFormat,
        topicPath: demo.topicId === null ? null : topicPaths.get(demo.topicId) ?? null,
        addedAt: demo.addedAt,
        position: demo.position,
      });
    }

    const journals = flattenTopicTree(topics).flatMap((topic) =>
      listJournalEntries(store, courseId, topic.id).map((entry) => ({
        topicPath: topic.path,
        kind: entry.kind,
        bodyMarkdown: entry.bodyMarkdown,
        demoFile:
          entry.demoId === null ? null : demoFilesById.get(entry.demoId) ?? null,
        turn: entry.turn,
        createdAt: entry.createdAt,
      })),
    );

    const transcript = transcriptEntriesForCourse(store, courseId);
    const transcriptFile = relativeBundlePath("transcript.jsonl");
    if (options.includeTranscript === true) {
      await writeBundleText(
        exportDir,
        transcriptFile,
        transcript
          .map((entry) =>
            stringifyJsonLine({
              turn: entry.turn,
              role: entry.role,
              kind: entry.kind,
              content: entry.content,
              payload: entry.payload,
              topicPath:
                entry.topicId === null ? null : topicPaths.get(entry.topicId) ?? null,
              ts: entry.ts,
              createdAt: entry.createdAt,
            }),
          )
          .join("\n")
          .concat(transcript.length === 0 ? "" : "\n"),
      );
    }

    const manifest: BundleManifest = {
      format: BUNDLE_FORMAT,
      formatVersion: BUNDLE_FORMAT_VERSION,
      exportedAt: nowIso(),
      course: courseForManifest(course),
      topics: bundleTopics,
      journals,
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
      feynmanChecks: listFeynmanChecks(store, courseId).map((check) => ({
        concept: check.concept,
        prompt: check.prompt,
        keyPoints: check.keyPoints,
        issuedAt: check.issuedAt,
        status: check.status,
        topicPath: check.topicId === null ? null : topicPaths.get(check.topicId) ?? null,
        replacedConcept: check.replacedConcept,
        replacedIssuedAt: check.replacedIssuedAt,
        replacedAt: check.replacedAt,
        createdAt: check.createdAt,
        updatedAt: check.updatedAt,
      })),
      demos,
      turnEvents: listTurnEvents(store, courseId).map((entry) => ({
        turn: entry.turn,
        status: entry.status,
        createdAt: entry.createdAt,
        events: entry.events,
        importedFrom: entry.importedFrom,
      })),
      ...(options.includeTranscript === true
        ? { transcript: { file: transcriptFile, count: transcript.length } }
        : {}),
    };

    await writeBundleText(exportDir, "course.json", stringifyJson(manifest));
    return { path: exportDir };
  } catch (error) {
    await rm(exportDir, { force: true, recursive: true });
    throw error;
  }
};

const readBodyWithFallback = async (
  root: string,
  relativePath: string | null,
  fallback: string,
  warnings: string[],
  label: string,
): Promise<string> => {
  if (relativePath === null) {
    return fallback;
  }

  try {
    return await readBundleText(root, relativePath);
  } catch (error) {
    warnings.push(`Could not read ${label} ${relativePath}: ${String(error)}`);
    return fallback;
  }
};

const parseBundleCourse = (value: unknown): CourseInput => {
  if (!isRecord(value)) {
    throw new Error("Bundle course metadata is missing.");
  }

  const title = stringValue(value, "title", "course.title");
  const createdAt = optionalStringValue(value, "createdAt") ?? nowIso();
  const updatedAt = optionalStringValue(value, "updatedAt") ?? createdAt;
  const webSearchEnabled = value["webSearchEnabled"];
  if (webSearchEnabled !== undefined && typeof webSearchEnabled !== "boolean") {
    throw new Error("course.webSearchEnabled must be a boolean.");
  }

  return {
    title,
    description: optionalStringValue(value, "description"),
    status: parseCourseStatus(value["status"]),
    harnessId: optionalStringValue(value, "harnessId"),
    model: optionalStringValue(value, "model"),
    effort: optionalStringValue(value, "effort"),
    attachedDir: optionalStringValue(value, "attachedDir"),
    webSearchEnabled: webSearchEnabled ?? false,
    sourceName: optionalStringValue(value, "sourceName"),
    manifestExtra: jsonRecord(value["manifestExtra"]),
    createdAt,
    updatedAt,
  };
};

const parseBundleTopic = async (
  root: string,
  value: unknown,
  index: number,
  warnings: string[],
): Promise<TopicTreeInput | undefined> => {
  if (!isRecord(value)) {
    warnings.push("Skipped invalid bundle topic.");
    return undefined;
  }

  const path = optionalStringValue(value, "path");
  const title = optionalStringValue(value, "title");
  if (path === null || title === null) {
    warnings.push("Skipped bundle topic without path or title.");
    return undefined;
  }

  const bodyFile = optionalStringValue(value, "bodyFile");
  const body = await readBodyWithFallback(
    root,
    bodyFile,
    optionalStringValue(value, "body") ?? "",
    warnings,
    "topic body",
  );
  const children: TopicTreeInput[] = [];
  for (const [childIndex, child] of arrayValue(value, "children").entries()) {
    const parsed = await parseBundleTopic(root, child, childIndex, warnings);
    if (parsed !== undefined) {
      children.push(parsed);
    }
  }

  return {
    path,
    title,
    body,
    status: parseTopicStatus(value["status"]),
    enteredAt: optionalStringValue(value, "enteredAt"),
    isCurrent: value["isCurrent"] === true,
    masteryConcept: optionalStringValue(value, "masteryConcept"),
    position: numberValue(value, "position", index),
    ...(children.length === 0 ? {} : { children }),
  };
};

const parseBundleGlossary = (
  value: unknown,
  warnings: string[],
): ImportedBundleGlossary | undefined => {
  if (!isRecord(value)) {
    warnings.push("Skipped invalid bundle glossary entry.");
    return undefined;
  }

  const term = optionalStringValue(value, "term");
  const definition = optionalStringValue(value, "definition");
  const addedAt = optionalStringValue(value, "addedAt");
  if (term === null || definition === null || addedAt === null) {
    warnings.push("Skipped bundle glossary entry without term, definition, or addedAt.");
    return undefined;
  }

  return {
    term,
    definition,
    topicPath: optionalStringValue(value, "topicPath"),
    addedAt,
  };
};

const parseJournalKind = (
  value: unknown,
): TopicJournalEntryKind | undefined => {
  if (value === "note" || value === "demo" || value === "summary") {
    return value;
  }

  return undefined;
};

const parseBundleJournalEntry = (
  value: unknown,
  warnings: string[],
): ImportedBundleJournalEntry | undefined => {
  if (!isRecord(value)) {
    warnings.push("Skipped invalid bundle journal entry.");
    return undefined;
  }

  const topicPath = optionalStringValue(value, "topicPath");
  const kind = parseJournalKind(value["kind"]);
  const createdAt = optionalStringValue(value, "createdAt");
  if (topicPath === null || kind === undefined || createdAt === null) {
    warnings.push("Skipped bundle journal entry without topicPath, kind, or createdAt.");
    return undefined;
  }

  const bodyMarkdown = optionalStringValue(value, "bodyMarkdown");
  const demoFile = optionalStringValue(value, "demoFile");
  if (kind === "demo") {
    if (demoFile === null || bodyMarkdown !== null) {
      warnings.push("Skipped bundle demo journal entry with invalid payload.");
      return undefined;
    }
  } else if (bodyMarkdown === null || demoFile !== null) {
    warnings.push("Skipped bundle text journal entry with invalid payload.");
    return undefined;
  }

  return {
    topicPath,
    kind,
    bodyMarkdown,
    demoFile,
    turn:
      typeof value["turn"] === "number" && Number.isInteger(value["turn"])
        ? value["turn"]
        : null,
    createdAt,
  };
};

const parseBundleMastery = (
  value: unknown,
  warnings: string[],
): ImportedBundleMastery | undefined => {
  if (!isRecord(value)) {
    warnings.push("Skipped invalid bundle mastery event.");
    return undefined;
  }

  const concept = optionalStringValue(value, "concept");
  const score = value["score"];
  const ts = optionalStringValue(value, "ts");
  if (
    concept === null ||
    typeof score !== "number" ||
    !Number.isInteger(score) ||
    score < 0 ||
    score > 100 ||
    ts === null
  ) {
    warnings.push("Skipped bundle mastery event without concept, score, or ts.");
    return undefined;
  }

  return {
    concept,
    score,
    gaps: optionalStringValue(value, "gaps"),
    ts,
    topicPath: optionalStringValue(value, "topicPath"),
  };
};

const parseBundleFeynman = (
  value: unknown,
  warnings: string[],
): ImportedBundleFeynman | undefined => {
  if (!isRecord(value)) {
    warnings.push("Skipped invalid bundle Feynman check.");
    return undefined;
  }

  const concept = optionalStringValue(value, "concept");
  const prompt = optionalStringValue(value, "prompt");
  const issuedAt = optionalStringValue(value, "issuedAt");
  if (concept === null || prompt === null || issuedAt === null) {
    warnings.push("Skipped bundle Feynman check without concept, prompt, or issuedAt.");
    return undefined;
  }

  const createdAt = optionalStringValue(value, "createdAt") ?? nowIso();

  return {
    concept,
    prompt,
    keyPoints: stringArrayValue(value["keyPoints"]),
    issuedAt,
    status: parseFeynmanStatus(value["status"]),
    topicPath: optionalStringValue(value, "topicPath"),
    replacedConcept: optionalStringValue(value, "replacedConcept"),
    replacedIssuedAt: optionalStringValue(value, "replacedIssuedAt"),
    replacedAt: optionalStringValue(value, "replacedAt"),
    createdAt,
    updatedAt: optionalStringValue(value, "updatedAt") ?? createdAt,
  };
};

const parseBundleDemo = async (
  root: string,
  value: unknown,
  index: number,
  warnings: string[],
): Promise<ImportedBundleDemo | undefined> => {
  if (!isRecord(value)) {
    warnings.push("Skipped invalid bundle demo.");
    return undefined;
  }

  const file = optionalStringValue(value, "file");
  if (file === null) {
    warnings.push("Skipped bundle demo without file.");
    return undefined;
  }

  const bodyFormat = parseDemoBodyFormat(value["bodyFormat"]);
  const body = await readBodyWithFallback(root, file, "", warnings, "demo");

  return {
    fileName: optionalStringValue(value, "fileName"),
    file,
    title: optionalStringValue(value, "title"),
    body,
    bodyFormat,
    topicPath: optionalStringValue(value, "topicPath"),
    addedAt: optionalStringValue(value, "addedAt") ?? nowIso(),
    position: numberValue(value, "position", index),
  };
};

const parseTranscriptLine = (
  line: string,
  index: number,
  warnings: string[],
): ImportedTranscriptInput | undefined => {
  try {
    const value = parseJson(line);
    if (!isRecord(value)) {
      warnings.push(`Skipped bundle transcript line ${index + 1}: not an object.`);
      return undefined;
    }

    const role = parseTranscriptRole(value["role"]);
    const content = optionalStringValue(value, "content");
    const ts = optionalStringValue(value, "ts");
    if (role === undefined || content === null || ts === null) {
      warnings.push(
        `Skipped bundle transcript line ${index + 1}: missing role, content, or ts.`,
      );
      return undefined;
    }

    return {
      turn: numberValue(value, "turn", index + 1),
      role,
      kind: optionalStringValue(value, "kind") ?? "text",
      content,
      payload: jsonRecord(value["payload"]),
      topicPath: optionalStringValue(value, "topicPath"),
      ts,
    };
  } catch (error) {
    warnings.push(`Skipped bundle transcript line ${index + 1}: ${String(error)}`);
    return undefined;
  }
};

const parseBundleTranscript = async (
  root: string,
  manifest: Record<string, unknown>,
  warnings: string[],
): Promise<readonly ImportedTranscriptInput[]> => {
  const transcript = manifest["transcript"];
  if (!isRecord(transcript)) {
    return [];
  }

  const file = optionalStringValue(transcript, "file");
  if (file === null) {
    warnings.push("Skipped bundle transcript without file.");
    return [];
  }

  let text: string;
  try {
    text = await readBundleText(root, file);
  } catch (error) {
    warnings.push(`Could not read bundle transcript ${file}: ${String(error)}`);
    return [];
  }

  return text
    .split("\n")
    .flatMap((line, index) => {
      if (line.trim().length === 0) {
        return [];
      }

      const parsed = parseTranscriptLine(line, index, warnings);
      return parsed === undefined ? [] : [parsed];
    });
};

const parseBundleTurnEvent = (
  value: unknown,
  warnings: string[],
): BundleTurnEvent | undefined => {
  if (!isRecord(value)) {
    warnings.push("Skipped invalid bundle turn event.");
    return undefined;
  }

  const status = value["status"];
  if (status !== "completed" && status !== "pending") {
    warnings.push("Skipped bundle turn event with invalid status.");
    return undefined;
  }

  return {
    turn:
      typeof value["turn"] === "number" && Number.isInteger(value["turn"])
        ? value["turn"]
        : null,
    status,
    createdAt: optionalStringValue(value, "createdAt") ?? nowIso(),
    events: arrayValue(value, "events").filter(isRecord),
    importedFrom: optionalStringValue(value, "importedFrom"),
  };
};

const readBundlePayload = async (
  dir: string,
  manifest: Record<string, unknown>,
): Promise<Readonly<{ payload: ImportedBundlePayload; warnings: readonly string[] }>> => {
  const warnings: string[] = [];
  const topics: TopicTreeInput[] = [];
  const journals: ImportedBundleJournalEntry[] = [];
  const glossary: ImportedBundleGlossary[] = [];
  const mastery: ImportedBundleMastery[] = [];
  const feynmanChecks: ImportedBundleFeynman[] = [];
  const demos: ImportedBundleDemo[] = [];
  const turnEvents: BundleTurnEvent[] = [];

  if (arrayValue(manifest, "lessons").length > 0) {
    warnings.push("Skipped bundle lessons; topic journals replace lessons.");
  }

  for (const [index, topic] of arrayValue(manifest, "topics").entries()) {
    const parsed = await parseBundleTopic(dir, topic, index, warnings);
    if (parsed !== undefined) {
      topics.push(parsed);
    }
  }

  for (const entry of arrayValue(manifest, "journals")) {
    const parsed = parseBundleJournalEntry(entry, warnings);
    if (parsed !== undefined) {
      journals.push(parsed);
    }
  }

  for (const entry of arrayValue(manifest, "glossary")) {
    const parsed = parseBundleGlossary(entry, warnings);
    if (parsed !== undefined) {
      glossary.push(parsed);
    }
  }

  for (const entry of arrayValue(manifest, "mastery")) {
    const parsed = parseBundleMastery(entry, warnings);
    if (parsed !== undefined) {
      mastery.push(parsed);
    }
  }

  for (const entry of arrayValue(manifest, "feynmanChecks")) {
    const parsed = parseBundleFeynman(entry, warnings);
    if (parsed !== undefined) {
      feynmanChecks.push(parsed);
    }
  }

  for (const [index, demo] of arrayValue(manifest, "demos").entries()) {
    const parsed = await parseBundleDemo(dir, demo, index, warnings);
    if (parsed !== undefined) {
      demos.push(parsed);
    }
  }

  for (const entry of arrayValue(manifest, "turnEvents")) {
    const parsed = parseBundleTurnEvent(entry, warnings);
    if (parsed !== undefined) {
      turnEvents.push(parsed);
    }
  }

  return {
    warnings,
    payload: {
      course: parseBundleCourse(manifest["course"]),
      topics,
      journals,
      glossary,
      mastery,
      feynmanChecks,
      demos,
      transcript: await parseBundleTranscript(dir, manifest, warnings),
      turnEvents,
    },
  };
};

const insertGlossaryEntry = (
  store: Store,
  courseId: number,
  input: ImportedBundleGlossary,
  topicId: number | null,
): void => {
  const termKey = input.term.toLocaleLowerCase();
  const timestamp = nowIso();
  store.db
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
      input.term,
      termKey,
      input.definition,
      topicId,
      input.addedAt ?? timestamp,
      timestamp,
    );
};

const insertDemo = (
  store: Store,
  courseId: number,
  input: ImportedBundleDemo,
  topicId: number | null,
): number => {
  const timestamp = nowIso();
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
      input.fileName,
      input.title,
      input.body,
      input.bodyFormat,
      input.addedAt,
      input.position,
      timestamp,
    );

  return Number(result.lastInsertRowid);
};

const insertFeynmanCheck = (
  store: Store,
  courseId: number,
  input: ImportedBundleFeynman,
  topicId: number | null,
): void => {
  store.db
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
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
      `,
    )
    .run(
      courseId,
      topicId,
      input.concept,
      input.prompt,
      stringifyJson(input.keyPoints),
      input.issuedAt,
      input.status,
      input.replacedConcept,
      input.replacedIssuedAt,
      input.replacedAt,
      input.createdAt,
      input.updatedAt,
    );
};

const topicsByPath = (store: Store, courseId: number): ReadonlyMap<string, Topic> =>
  new Map(
    flattenTopicTree(readTopicTree(store, courseId)).map((topic) => [
      topic.path,
      topic,
    ]),
  );

const importBundleDirectory = async (
  store: Store,
  dir: string,
  manifest: Record<string, unknown>,
): Promise<ImportCoursePathResult> => {
  const { payload, warnings } = await readBundlePayload(dir, manifest);
  const importWarnings = [...warnings];
  const course = withStoreTransaction(store, () => {
    const importedCourse = createCourse(store, payload.course);

    replaceTopicTree(store, importedCourse.id, payload.topics);
    const topicMap = topicsByPath(store, importedCourse.id);

    payload.glossary.forEach((entry) => {
      const topicId =
        entry.topicPath === null ? null : topicMap.get(entry.topicPath)?.id ?? null;
      insertGlossaryEntry(store, importedCourse.id, entry, topicId);
    });

    payload.mastery.forEach((entry) => {
      const topicId =
        entry.topicPath === null ? null : topicMap.get(entry.topicPath)?.id ?? null;
      appendMasteryEvent(store, importedCourse.id, {
        concept: entry.concept,
        score: entry.score,
        gaps: entry.gaps,
        ts: entry.ts,
        topicId,
      });
    });

    const demoIdsByBundleFile = new Map<string, number>();
    payload.demos.forEach((demo) => {
      const topicId =
        demo.topicPath === null ? null : topicMap.get(demo.topicPath)?.id ?? null;
      const demoId = insertDemo(store, importedCourse.id, demo, topicId);
      demoIdsByBundleFile.set(demo.file, demoId);
    });

    payload.journals.forEach((entry) => {
      const topic = topicMap.get(entry.topicPath);
      if (topic === undefined) {
        importWarnings.push(`Skipped journal entry for missing topic ${entry.topicPath}.`);
        return;
      }

      if (entry.kind === "demo") {
        const demoId =
          entry.demoFile === null ? undefined : demoIdsByBundleFile.get(entry.demoFile);
        if (demoId === undefined) {
          importWarnings.push(
            `Skipped demo journal entry for missing demo ${entry.demoFile ?? "unknown"}.`,
          );
          return;
        }

        appendJournalEntry(store, importedCourse.id, {
          topicId: topic.id,
          kind: "demo",
          demoId,
          turn: entry.turn,
          createdAt: entry.createdAt,
        });
        return;
      }

      appendJournalEntry(store, importedCourse.id, {
        topicId: topic.id,
        kind: entry.kind,
        bodyMarkdown: entry.bodyMarkdown ?? "",
        turn: entry.turn,
        createdAt: entry.createdAt,
      });
    });

    payload.feynmanChecks.forEach((check) => {
      const topicId =
        check.topicPath === null ? null : topicMap.get(check.topicPath)?.id ?? null;
      insertFeynmanCheck(store, importedCourse.id, check, topicId);
    });

    payload.transcript.forEach((entry) => {
      const topicId =
        entry.topicPath === null ? null : topicMap.get(entry.topicPath)?.id ?? null;
      appendTranscriptEntry(store, importedCourse.id, {
        ...entry,
        topicId,
      });
    });

    payload.turnEvents.forEach((entry) => {
      appendTurnEvents(store, importedCourse.id, entry);
    });

    const imported = getCourse(store, importedCourse.id);
    if (imported === undefined) {
      throw new Error("Imported course could not be read.");
    }

    return imported;
  });

  return { course, warnings: importWarnings, source: "bundle" };
};

const readManifest = async (dir: string): Promise<unknown | undefined> => {
  try {
    return parseJson(await readFile(manifestPath(dir), "utf8"));
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return undefined;
    }

    return undefined;
  }
};

const validateImportDirectory = async (path: string): Promise<string> => {
  if (!isAbsolute(path)) {
    throw new Error("path must be an absolute directory path.");
  }

  const absolutePath = resolve(path);
  let pathStat: Awaited<ReturnType<typeof stat>>;
  try {
    pathStat = await stat(absolutePath);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      throw new Error(`path does not exist: ${absolutePath}`, { cause: error });
    }

    throw error;
  }

  if (!pathStat.isDirectory()) {
    throw new Error(`path must be a directory: ${absolutePath}`);
  }

  return absolutePath;
};

export const importCoursePath = async (
  store: Store,
  path: string,
): Promise<ImportCoursePathResult> => {
  const absolutePath = await validateImportDirectory(path);
  const manifest = await readManifest(absolutePath);

  if (
    isRecord(manifest) &&
    manifest["format"] === BUNDLE_FORMAT &&
    manifest["formatVersion"] === BUNDLE_FORMAT_VERSION
  ) {
    return importBundleDirectory(store, absolutePath, manifest);
  }

  const result = await importCourseFolder(store, absolutePath);
  return { course: result.course, warnings: result.warnings, source: "legacy" };
};

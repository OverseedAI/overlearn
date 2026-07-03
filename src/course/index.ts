import {
  appendFile,
  mkdir,
  readdir,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export const COURSE_FORMAT_VERSION = 1;
export const DEFAULT_COURSE_NAME = "default";

export type CourseManifest = Readonly<{
  formatVersion: typeof COURSE_FORMAT_VERSION;
  name: string;
  createdAt: string;
  topics: readonly TopicNode[];
}>;

export type TopicNode = Readonly<{
  path: string;
  title: string;
  lesson?: string;
  enteredAt?: string;
  current: boolean;
  children: readonly TopicNode[];
}>;

export type CourseFileLayout = Readonly<{
  courseJson: "course.json";
  lessonsDir: "lessons";
  glossaryJson: "glossary.json";
  masteryJson: "mastery.json";
  demosDir: "demos";
  transcriptJsonl: "transcript.jsonl";
}>;

export type CoursePaths = Readonly<{
  courseDir: string;
  courseJson: string;
  transcriptJsonl: string;
  glossaryJson: string;
  masteryJson: string;
  lessonsDir: string;
  demosDir: string;
  runtimeDir: string;
  daemonJson: string;
  turnsDir: string;
  pendingEventsJson: string;
}>;

export type DaemonMetadata = Readonly<{
  pid: number;
  port: number;
  startedAt: string;
}>;

export type MessageTurnEvent = Readonly<{
  type: "message";
  text: string;
}>;

export type NavTurnEvent = Readonly<{
  type: "nav";
  path: string;
}>;

export type TurnEvent = MessageTurnEvent | NavTurnEvent;

export type TurnFile = Readonly<{
  turn: number;
  createdAt: string;
  events: readonly TurnEvent[];
}>;

export type TranscriptEntry = Readonly<{
  role: "learner" | "agent";
  text: string;
  at: string;
}>;

export type GlossaryEntry = Readonly<{
  term: string;
  def: string;
  lesson?: string;
  addedAt: string;
}>;

export type GlossaryEntryInput = Readonly<{
  term: string;
  def: string;
  lesson?: string;
}>;

export type GlossaryMutation = Readonly<{
  action: "created" | "updated";
  entry: GlossaryEntry;
}>;

export type TopicInput = Readonly<{
  path: string;
  title?: string;
  lesson?: string;
}>;

export type TopicMutation = Readonly<{
  action: "created" | "updated";
  topic: TopicNode;
  topics: readonly TopicNode[];
}>;

type Env = Readonly<Record<string, string | undefined>>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasErrorCode = (error: unknown, code: string): boolean =>
  isRecord(error) && error["code"] === code;

const directoryExists = async (directoryPath: string): Promise<boolean> => {
  try {
    return (await stat(directoryPath)).isDirectory();
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return false;
    }

    throw error;
  }
};

const readJson = async (filePath: string): Promise<unknown> => {
  try {
    return JSON.parse(await Bun.file(filePath).text()) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid JSON in ${filePath}: ${error.message}`, {
        cause: error,
      });
    }

    throw error;
  }
};

const tempJsonPath = (filePath: string): string =>
  join(
    dirname(filePath),
    `.${basename(filePath)}.${process.pid}.${Date.now()}.${Math.random()
      .toString(36)
      .slice(2)}.tmp`,
  );

const writeJson = async (filePath: string, value: unknown): Promise<void> => {
  await Bun.write(filePath, `${JSON.stringify(value, null, 2)}\n`);
};

const writeJsonAtomic = async (
  filePath: string,
  value: unknown,
): Promise<void> => {
  const temporaryPath = tempJsonPath(filePath);

  try {
    await Bun.write(temporaryPath, `${JSON.stringify(value, null, 2)}\n`);
    await rename(temporaryPath, filePath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
};

const writeIfMissing = async (
  filePath: string,
  contents: string,
): Promise<void> => {
  if (await Bun.file(filePath).exists()) {
    return;
  }

  await Bun.write(filePath, contents);
};

export const isValidCourseName = (name: string): boolean =>
  name.length > 0 &&
  name !== "." &&
  name !== ".." &&
  !name.includes("/") &&
  !name.includes("\\");

export const isValidTopicPath = (path: string): boolean =>
  path.length > 0 &&
  !path.startsWith("/") &&
  !path.endsWith("/") &&
  path.split("/").every(isValidCourseName);

const invalidTopicMessage = (filePath: string): string =>
  `Invalid course topics in ${filePath}: expected topic tree nodes.`;

const directChildPath = (path: string, parentPath: string): boolean => {
  if (!path.startsWith(`${parentPath}/`)) {
    return false;
  }

  return path.split("/").length === parentPath.split("/").length + 1;
};

const parseTopicNode = (
  value: unknown,
  filePath: string,
  location: string,
  parentPath: string | undefined,
  seenPaths: Set<string>,
  currentCount: { value: number },
): TopicNode => {
  if (!isRecord(value)) {
    throw new Error(invalidTopicMessage(filePath));
  }

  const path = value["path"];
  const title = value["title"];
  const lesson = value["lesson"];
  const enteredAt = value["enteredAt"];
  const current = value["current"];
  const children = value["children"];

  if (
    typeof path !== "string" ||
    !isValidTopicPath(path) ||
    (parentPath === undefined && path.includes("/")) ||
    (parentPath !== undefined && !directChildPath(path, parentPath)) ||
    typeof title !== "string" ||
    title.trim().length === 0 ||
    (lesson !== undefined &&
      (typeof lesson !== "string" || lesson.trim().length === 0)) ||
    (enteredAt !== undefined &&
      (typeof enteredAt !== "string" || enteredAt.trim().length === 0)) ||
    (current !== undefined && typeof current !== "boolean") ||
    !Array.isArray(children)
  ) {
    throw new Error(`${invalidTopicMessage(filePath)} Invalid node at ${location}.`);
  }

  if (seenPaths.has(path)) {
    throw new Error(
      `${invalidTopicMessage(filePath)} Duplicate path: ${path}.`,
    );
  }
  seenPaths.add(path);

  const isCurrent = current === true;
  if (isCurrent) {
    currentCount.value += 1;
  }

  return {
    path,
    title: title.trim(),
    ...(lesson === undefined ? {} : { lesson: lesson.trim() }),
    ...(enteredAt === undefined ? {} : { enteredAt: enteredAt.trim() }),
    current: isCurrent,
    children: children.map((child, index) =>
      parseTopicNode(
        child,
        filePath,
        `${location}.children[${index}]`,
        path,
        seenPaths,
        currentCount,
      ),
    ),
  };
};

const parseTopicTree = (
  value: unknown,
  filePath: string,
): readonly TopicNode[] => {
  if (!Array.isArray(value)) {
    throw new Error(invalidTopicMessage(filePath));
  }

  if (value.length > 0 && value.every((topic) => typeof topic === "string")) {
    throw new Error(
      `Invalid course topics in ${filePath}: legacy flat topic arrays are no longer supported; expected topic tree nodes.`,
    );
  }

  const seenPaths = new Set<string>();
  const currentCount = { value: 0 };
  const topics = value.map((topic, index) =>
    parseTopicNode(
      topic,
      filePath,
      `topics[${index}]`,
      undefined,
      seenPaths,
      currentCount,
    ),
  );

  if (topics.length > 0 && currentCount.value !== 1) {
    throw new Error(
      `Invalid course topics in ${filePath}: expected exactly one current topic.`,
    );
  }

  return topics;
};

const parseCourseManifest = (
  value: unknown,
  filePath: string,
): CourseManifest => {
  if (!isRecord(value)) {
    throw new Error(`Invalid course manifest in ${filePath}`);
  }

  const formatVersion = value["formatVersion"];
  if (formatVersion !== COURSE_FORMAT_VERSION) {
    throw new Error(
      `Unsupported course formatVersion ${String(
        formatVersion,
      )} in ${filePath}; expected ${COURSE_FORMAT_VERSION}`,
    );
  }

  const name = value["name"];
  const createdAt = value["createdAt"];
  const topics = value["topics"];

  if (
    typeof name !== "string" ||
    typeof createdAt !== "string"
  ) {
    throw new Error(`Invalid course manifest in ${filePath}`);
  }

  return {
    formatVersion,
    name,
    createdAt,
    topics: parseTopicTree(topics, filePath),
  };
};

const parseDaemonMetadata = (
  value: unknown,
  filePath: string,
): DaemonMetadata => {
  if (!isRecord(value)) {
    throw new Error(`Invalid daemon metadata in ${filePath}`);
  }

  const pid = value["pid"];
  const port = value["port"];
  const startedAt = value["startedAt"];

  if (
    typeof pid !== "number" ||
    !Number.isInteger(pid) ||
    typeof port !== "number" ||
    !Number.isInteger(port) ||
    typeof startedAt !== "string"
  ) {
    throw new Error(`Invalid daemon metadata in ${filePath}`);
  }

  return { pid, port, startedAt };
};

const parseTurnEvent = (value: unknown, filePath: string): TurnEvent => {
  if (!isRecord(value)) {
    throw new Error(`Invalid pending event in ${filePath}`);
  }

  const type = value["type"];

  if (type === "message") {
    const text = value["text"];
    if (typeof text !== "string") {
      throw new Error(`Invalid pending event in ${filePath}`);
    }

    return { type, text };
  }

  if (type === "nav") {
    const path = value["path"];
    if (typeof path !== "string" || !isValidTopicPath(path)) {
      throw new Error(`Invalid pending event in ${filePath}`);
    }

    return { type, path };
  }

  if (type !== "message" && type !== "nav") {
    throw new Error(`Invalid pending event in ${filePath}`);
  }

  throw new Error(`Invalid pending event in ${filePath}`);
};

const parseTranscriptEntry = (
  value: unknown,
  filePath: string,
  lineNumber: number,
): TranscriptEntry => {
  if (!isRecord(value)) {
    throw new Error(`Invalid transcript entry in ${filePath}:${lineNumber}`);
  }

  const role = value["role"];
  const text = value["text"];
  const at = value["at"];

  if (
    (role !== "learner" && role !== "agent") ||
    typeof text !== "string" ||
    typeof at !== "string"
  ) {
    throw new Error(`Invalid transcript entry in ${filePath}:${lineNumber}`);
  }

  return { role, text, at };
};

const parseGlossaryEntry = (
  value: unknown,
  filePath: string,
  index: number,
): GlossaryEntry => {
  if (!isRecord(value)) {
    throw new Error(`Invalid glossary entry in ${filePath}:${index + 1}`);
  }

  const term = value["term"];
  const def = value["def"];
  const lesson = value["lesson"];
  const addedAt = value["addedAt"];

  if (
    typeof term !== "string" ||
    term.trim().length === 0 ||
    typeof def !== "string" ||
    def.trim().length === 0 ||
    typeof addedAt !== "string" ||
    addedAt.trim().length === 0 ||
    (lesson !== undefined &&
      (typeof lesson !== "string" || lesson.trim().length === 0))
  ) {
    throw new Error(`Invalid glossary entry in ${filePath}:${index + 1}`);
  }

  return lesson === undefined
    ? {
        term: term.trim(),
        def: def.trim(),
        addedAt,
      }
    : {
        term: term.trim(),
        def: def.trim(),
        lesson: lesson.trim(),
        addedAt,
      };
};

const turnNumberFromFileName = (fileName: string): number | undefined => {
  const match = /^turn-(\d+)\.json$/.exec(fileName);
  if (match === null) {
    return undefined;
  }

  const [numberText] = match.slice(1);
  if (numberText === undefined) {
    return undefined;
  }

  return Number.parseInt(numberText, 10);
};

export const getCoursesDir = (env: Env = process.env): string => {
  const override = env["OVERLEARN_COURSES_DIR"];
  return resolve(override ?? join(homedir(), "courses"));
};

export const getCoursePaths = (courseDir: string): CoursePaths => {
  const absoluteCourseDir = resolve(courseDir);
  const runtimeDir = join(absoluteCourseDir, ".overlearn");

  return {
    courseDir: absoluteCourseDir,
    courseJson: join(absoluteCourseDir, "course.json"),
    transcriptJsonl: join(absoluteCourseDir, "transcript.jsonl"),
    glossaryJson: join(absoluteCourseDir, "glossary.json"),
    masteryJson: join(absoluteCourseDir, "mastery.json"),
    lessonsDir: join(absoluteCourseDir, "lessons"),
    demosDir: join(absoluteCourseDir, "demos"),
    runtimeDir,
    daemonJson: join(runtimeDir, "daemon.json"),
    turnsDir: join(runtimeDir, "turns"),
    pendingEventsJson: join(runtimeDir, "pending-events.json"),
  };
};

export const resolveNamedCourseDir = (
  name: string,
  env: Env = process.env,
): string => {
  if (!isValidCourseName(name)) {
    throw new Error(
      `Invalid course name: ${name}. Use a plain directory name without path separators.`,
    );
  }

  return join(getCoursesDir(env), name);
};

export const ensureCourseScaffold = async (
  name = DEFAULT_COURSE_NAME,
  env: Env = process.env,
): Promise<CoursePaths> => {
  const courseDir = resolveNamedCourseDir(name, env);
  const paths = getCoursePaths(courseDir);

  await mkdir(paths.lessonsDir, { recursive: true });
  await mkdir(paths.demosDir, { recursive: true });
  await mkdir(paths.turnsDir, { recursive: true });

  if (await Bun.file(paths.courseJson).exists()) {
    await readCourseManifest(paths.courseDir);
  } else {
    const manifest: CourseManifest = {
      formatVersion: COURSE_FORMAT_VERSION,
      name,
      createdAt: new Date().toISOString(),
      topics: [],
    };

    await writeJsonAtomic(paths.courseJson, manifest);
  }

  await writeIfMissing(paths.transcriptJsonl, "");
  await writeIfMissing(paths.glossaryJson, "[]\n");
  await writeIfMissing(paths.masteryJson, "[]\n");

  return paths;
};

export const readCourseManifest = async (
  courseDir: string,
): Promise<CourseManifest> => {
  const paths = getCoursePaths(courseDir);
  return parseCourseManifest(await readJson(paths.courseJson), paths.courseJson);
};

const writeCourseManifest = async (
  courseDir: string,
  manifest: CourseManifest,
): Promise<void> => {
  const paths = getCoursePaths(courseDir);
  await writeJsonAtomic(paths.courseJson, manifest);
};

export const readDaemonMetadata = async (
  courseDir: string,
): Promise<DaemonMetadata | undefined> => {
  const paths = getCoursePaths(courseDir);
  if (!(await Bun.file(paths.daemonJson).exists())) {
    return undefined;
  }

  return parseDaemonMetadata(await readJson(paths.daemonJson), paths.daemonJson);
};

export const writeDaemonMetadata = async (
  courseDir: string,
  metadata: DaemonMetadata,
): Promise<void> => {
  const paths = getCoursePaths(courseDir);
  await mkdir(paths.runtimeDir, { recursive: true });
  await writeJson(paths.daemonJson, metadata);
};

export const clearDaemonMetadata = async (courseDir: string): Promise<void> => {
  const paths = getCoursePaths(courseDir);
  await rm(paths.daemonJson, { force: true });
};

export const readPendingEvents = async (
  courseDir: string,
): Promise<readonly TurnEvent[]> => {
  const paths = getCoursePaths(courseDir);
  if (!(await Bun.file(paths.pendingEventsJson).exists())) {
    return [];
  }

  const value = await readJson(paths.pendingEventsJson);
  if (!Array.isArray(value)) {
    throw new Error(`Invalid pending events in ${paths.pendingEventsJson}`);
  }

  return value.map((event) => parseTurnEvent(event, paths.pendingEventsJson));
};

export const writePendingEvents = async (
  courseDir: string,
  events: readonly TurnEvent[],
): Promise<void> => {
  const paths = getCoursePaths(courseDir);

  if (events.length === 0) {
    await rm(paths.pendingEventsJson, { force: true });
    return;
  }

  await mkdir(paths.runtimeDir, { recursive: true });
  await writeJson(paths.pendingEventsJson, events);
};

export const readTranscript = async (
  courseDir: string,
): Promise<readonly TranscriptEntry[]> => {
  const paths = getCoursePaths(courseDir);
  if (!(await Bun.file(paths.transcriptJsonl).exists())) {
    return [];
  }

  const contents = await Bun.file(paths.transcriptJsonl).text();
  if (contents.trim().length === 0) {
    return [];
  }

  return contents
    .split("\n")
    .flatMap((line, index) =>
      line.trim().length === 0
        ? []
        : [
            parseTranscriptEntry(
              JSON.parse(line) as unknown,
              paths.transcriptJsonl,
              index + 1,
            ),
          ],
    );
};

export const appendTranscriptEntry = async (
  courseDir: string,
  entry: TranscriptEntry,
): Promise<void> => {
  const paths = getCoursePaths(courseDir);
  await appendFile(paths.transcriptJsonl, `${JSON.stringify(entry)}\n`);
};

export const appendLearnerTranscript = async (
  courseDir: string,
  text: string,
  at: string,
): Promise<TranscriptEntry> => {
  const entry: TranscriptEntry = {
    role: "learner",
    text,
    at,
  };

  await appendTranscriptEntry(courseDir, entry);
  return entry;
};

export const appendAgentTranscript = async (
  courseDir: string,
  text: string,
  at: string,
): Promise<TranscriptEntry> => {
  const entry: TranscriptEntry = {
    role: "agent",
    text,
    at,
  };

  await appendTranscriptEntry(courseDir, entry);
  return entry;
};

export const readGlossary = async (
  courseDir: string,
): Promise<readonly GlossaryEntry[]> => {
  const paths = getCoursePaths(courseDir);
  if (!(await Bun.file(paths.glossaryJson).exists())) {
    return [];
  }

  const value = await readJson(paths.glossaryJson);
  if (!Array.isArray(value)) {
    throw new Error(`Invalid glossary in ${paths.glossaryJson}`);
  }

  return value.map((entry, index) =>
    parseGlossaryEntry(entry, paths.glossaryJson, index),
  );
};

const writeGlossary = async (
  courseDir: string,
  entries: readonly GlossaryEntry[],
): Promise<void> => {
  const paths = getCoursePaths(courseDir);
  await writeJson(paths.glossaryJson, entries);
};

const normalizeGlossaryInput = (
  input: GlossaryEntryInput,
): GlossaryEntryInput => {
  const term = input.term.trim();
  if (term.length === 0) {
    throw new Error("Glossary term cannot be empty.");
  }

  const def = input.def.trim();
  if (def.length === 0) {
    throw new Error("Glossary definition cannot be empty.");
  }

  const lesson = input.lesson?.trim();
  if (lesson === undefined) {
    return { term, def };
  }

  if (lesson.length === 0) {
    throw new Error("Glossary lesson cannot be empty.");
  }

  return { term, def, lesson };
};

const glossaryTermKey = (term: string): string => term.toLocaleLowerCase();

const isPlainLessonId = (lessonId: string): boolean =>
  lessonId.length > 0 &&
  lessonId === basename(lessonId) &&
  !lessonId.includes("\\");

const lessonExists = async (
  courseDir: string,
  lessonId: string,
): Promise<boolean> => {
  if (!isPlainLessonId(lessonId)) {
    return false;
  }

  const paths = getCoursePaths(courseDir);

  try {
    return (await stat(join(paths.lessonsDir, `${lessonId}.md`))).isFile();
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return false;
    }

    throw error;
  }
};

const formatGlossaryEntry = (
  term: string,
  def: string,
  lesson: string | undefined,
  addedAt: string,
): GlossaryEntry =>
  lesson === undefined
    ? { term, def, addedAt }
    : { term, def, lesson, addedAt };

export const upsertGlossaryEntry = async (
  courseDir: string,
  input: GlossaryEntryInput,
  now = new Date(),
): Promise<GlossaryMutation> => {
  const normalized = normalizeGlossaryInput(input);

  if (
    normalized.lesson !== undefined &&
    !(await lessonExists(courseDir, normalized.lesson))
  ) {
    throw new Error(`Lesson does not exist: ${normalized.lesson}`);
  }

  const entries = await readGlossary(courseDir);
  const existingIndex = entries.findIndex(
    (entry) => glossaryTermKey(entry.term) === glossaryTermKey(normalized.term),
  );

  if (existingIndex === -1) {
    const entry = formatGlossaryEntry(
      normalized.term,
      normalized.def,
      normalized.lesson,
      now.toISOString(),
    );

    await writeGlossary(courseDir, [...entries, entry]);
    return { action: "created", entry };
  }

  const existing = entries[existingIndex];
  if (existing === undefined) {
    throw new Error("Unable to update glossary entry.");
  }

  const entry = formatGlossaryEntry(
    normalized.term,
    normalized.def,
    normalized.lesson ?? existing.lesson,
    existing.addedAt,
  );
  const nextEntries = entries.map((candidate, index) =>
    index === existingIndex ? entry : candidate,
  );

  await writeGlossary(courseDir, nextEntries);
  return { action: "updated", entry };
};

type NormalizedTopicInput = Readonly<{
  path: string;
  title?: string;
  lesson?: string;
}>;

const normalizeTopicInput = (input: TopicInput): NormalizedTopicInput => {
  const path = input.path.trim();
  if (path.length === 0) {
    throw new Error("Topic path cannot be empty.");
  }

  if (!isValidTopicPath(path)) {
    throw new Error(
      `Invalid topic path: ${input.path}. Use slash-separated course-name-safe segments.`,
    );
  }

  const title = input.title?.trim();
  if (title !== undefined && title.length === 0) {
    throw new Error("Topic title cannot be empty.");
  }

  const lesson = input.lesson?.trim();
  if (lesson !== undefined && lesson.length === 0) {
    throw new Error("Topic lesson cannot be empty.");
  }

  return {
    path,
    ...(title === undefined ? {} : { title }),
    ...(lesson === undefined ? {} : { lesson }),
  };
};

const formatTopicNode = (
  path: string,
  title: string,
  lesson: string | undefined,
  enteredAt: string | undefined,
  current: boolean,
  children: readonly TopicNode[],
): TopicNode => ({
  path,
  title,
  ...(lesson === undefined ? {} : { lesson }),
  ...(enteredAt === undefined ? {} : { enteredAt }),
  current,
  children,
});

const createTopicNode = (path: string, title: string): TopicNode =>
  formatTopicNode(path, title, undefined, undefined, false, []);

const clearTopicCurrent = (node: TopicNode): TopicNode =>
  formatTopicNode(
    node.path,
    node.title,
    node.lesson,
    node.enteredAt,
    false,
    node.children.map(clearTopicCurrent),
  );

type TopicTreeWalkResult = Readonly<{
  created: boolean;
  topic: TopicNode;
  topics: readonly TopicNode[];
}>;

const upsertTopicSegments = (
  topics: readonly TopicNode[],
  segments: readonly string[],
  index: number,
  parentPath: string | undefined,
  input: NormalizedTopicInput,
  enteredAt: string,
): TopicTreeWalkResult => {
  const segment = segments[index];
  if (segment === undefined) {
    throw new Error("Topic path cannot be empty.");
  }

  const path = parentPath === undefined ? segment : `${parentPath}/${segment}`;
  const existingIndex = topics.findIndex((topic) => topic.path === path);
  const existing =
    existingIndex === -1 ? createTopicNode(path, segment) : topics[existingIndex];

  if (existing === undefined) {
    throw new Error("Unable to update topic tree.");
  }

  const target = index === segments.length - 1;

  if (target) {
    const topic = formatTopicNode(
      existing.path,
      input.title ?? existing.title,
      input.lesson ?? existing.lesson,
      enteredAt,
      true,
      existing.children,
    );
    const nextTopics =
      existingIndex === -1
        ? [...topics, topic]
        : topics.map((candidate, candidateIndex) =>
            candidateIndex === existingIndex ? topic : candidate,
          );

    return {
      created: existingIndex === -1,
      topic,
      topics: nextTopics,
    };
  }

  const childResult = upsertTopicSegments(
    existing.children,
    segments,
    index + 1,
    path,
    input,
    enteredAt,
  );
  const topic = formatTopicNode(
    existing.path,
    existing.title,
    existing.lesson,
    existing.enteredAt,
    false,
    childResult.topics,
  );
  const nextTopics =
    existingIndex === -1
      ? [...topics, topic]
      : topics.map((candidate, candidateIndex) =>
          candidateIndex === existingIndex ? topic : candidate,
        );

  return {
    created: existingIndex === -1 || childResult.created,
    topic: childResult.topic,
    topics: nextTopics,
  };
};

export const upsertTopicTree = (
  topics: readonly TopicNode[],
  input: TopicInput,
  now = new Date(),
): TopicMutation => {
  const normalized = normalizeTopicInput(input);
  const segments = normalized.path.split("/");
  const clearedTopics = topics.map(clearTopicCurrent);
  const result = upsertTopicSegments(
    clearedTopics,
    segments,
    0,
    undefined,
    normalized,
    now.toISOString(),
  );

  return {
    action: result.created ? "created" : "updated",
    topic: result.topic,
    topics: result.topics,
  };
};

export const upsertTopic = async (
  courseDir: string,
  input: TopicInput,
  now = new Date(),
): Promise<TopicMutation> => {
  const normalized = normalizeTopicInput(input);

  if (
    normalized.lesson !== undefined &&
    !(await lessonExists(courseDir, normalized.lesson))
  ) {
    throw new Error(`Lesson does not exist: ${normalized.lesson}`);
  }

  const manifest = await readCourseManifest(courseDir);
  const mutation = upsertTopicTree(manifest.topics, normalized, now);
  await writeCourseManifest(courseDir, {
    ...manifest,
    topics: mutation.topics,
  });

  return mutation;
};

export const nextTurnNumber = async (courseDir: string): Promise<number> => {
  const paths = getCoursePaths(courseDir);
  await mkdir(paths.turnsDir, { recursive: true });

  const entries = await readdir(paths.turnsDir);
  const maxTurn = entries.reduce((max, entry) => {
    const turnNumber = turnNumberFromFileName(entry);
    if (turnNumber === undefined || !Number.isFinite(turnNumber)) {
      return max;
    }

    return Math.max(max, turnNumber);
  }, 0);

  return maxTurn + 1;
};

export const writeTurnFile = async (
  courseDir: string,
  events: readonly TurnEvent[],
): Promise<string> => {
  const paths = getCoursePaths(courseDir);
  const turn = await nextTurnNumber(courseDir);
  const turnFile: TurnFile = {
    turn,
    createdAt: new Date().toISOString(),
    events,
  };
  const turnPath = join(paths.turnsDir, `turn-${turn}.json`);

  await writeJson(turnPath, turnFile);

  return turnPath;
};

const findCourseAncestor = async (
  startDir: string,
): Promise<string | undefined> => {
  let current = resolve(startDir);

  while (true) {
    const paths = getCoursePaths(current);
    if (await Bun.file(paths.courseJson).exists()) {
      await readCourseManifest(current);
      return current;
    }

    const parent = dirname(current);
    if (parent === current) {
      return undefined;
    }

    current = parent;
  }
};

const listCourseDirs = async (coursesDir: string): Promise<readonly string[]> => {
  if (!(await directoryExists(coursesDir))) {
    return [];
  }

  const entries = await readdir(coursesDir, { withFileTypes: true });
  const courseDirs: string[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const candidate = join(coursesDir, entry.name);
    if (await Bun.file(getCoursePaths(candidate).courseJson).exists()) {
      courseDirs.push(candidate);
    }
  }

  return courseDirs;
};

export const listCourseNames = async (
  env: Env = process.env,
): Promise<readonly string[]> => {
  const coursesDir = getCoursesDir(env);
  const courseDirs = await listCourseDirs(coursesDir);

  return courseDirs
    .map((courseDir) => basename(courseDir))
    .sort((left, right) => left.localeCompare(right));
};

const formatAvailableCourses = (
  coursesDir: string,
  names: readonly string[],
): string =>
  names.length === 0
    ? `No available courses in ${coursesDir}.`
    : `Available courses in ${coursesDir}: ${names.join(", ")}.`;

export const requireCourse = async (
  name = DEFAULT_COURSE_NAME,
  env: Env = process.env,
): Promise<CoursePaths> => {
  const courseDir = resolveNamedCourseDir(name, env);
  const paths = getCoursePaths(courseDir);

  if (!(await Bun.file(paths.courseJson).exists())) {
    const coursesDir = getCoursesDir(env);
    const availableCourses = await listCourseNames(env);
    throw new Error(
      [
        `Cannot resume course "${name}": ${paths.courseJson} does not exist.`,
        formatAvailableCourses(coursesDir, availableCourses),
      ].join("\n"),
    );
  }

  await readCourseManifest(paths.courseDir);
  return paths;
};

export const resolveCourseDirForWait = async (
  name: string | undefined,
  env: Env = process.env,
  cwd = process.cwd(),
): Promise<string> => {
  if (name !== undefined) {
    const courseDir = resolveNamedCourseDir(name, env);
    await readCourseManifest(courseDir);
    return courseDir;
  }

  const ancestor = await findCourseAncestor(cwd);
  if (ancestor !== undefined) {
    return ancestor;
  }

  const courses = await listCourseDirs(getCoursesDir(env));
  if (courses.length === 1) {
    const [courseDir] = courses;
    if (courseDir !== undefined) {
      await readCourseManifest(courseDir);
      return courseDir;
    }
  }

  const cwdName = basename(resolve(cwd));
  if (isValidCourseName(cwdName)) {
    const namedFromCwd = resolveNamedCourseDir(cwdName, env);
    if (await Bun.file(getCoursePaths(namedFromCwd).courseJson).exists()) {
      await readCourseManifest(namedFromCwd);
      return namedFromCwd;
    }
  }

  throw new Error(
    "No course selected. Run `learn wait <name>` or run it inside a course directory.",
  );
};

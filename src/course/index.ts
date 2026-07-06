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
  harness?: string;
  topics: readonly TopicNode[];
  unassignedDemos: readonly DemoEntry[];
}>;

export type TopicNode = Readonly<{
  path: string;
  title: string;
  lesson?: string;
  enteredAt?: string;
  current: boolean;
  demos?: readonly DemoEntry[];
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
  activeFeynmanJson: string;
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

export type ReviewWeakTurnEvent = Readonly<{
  type: "review-weak";
  concepts: readonly string[];
}>;

export type SessionDoneTurnEvent = Readonly<{
  type: "session-done";
}>;

export type HarnessSwappedTurnEvent = Readonly<{
  type: "harness-swapped";
  from: string;
  to: string;
}>;

export type FeynmanAnswerTurnEvent = Readonly<{
  type: "feynman-answer";
  concept: string;
  text: string;
  keyPoints: readonly string[];
}>;

export type TurnEvent =
  | MessageTurnEvent
  | NavTurnEvent
  | ReviewWeakTurnEvent
  | SessionDoneTurnEvent
  | HarnessSwappedTurnEvent
  | FeynmanAnswerTurnEvent;

export type TurnFile = Readonly<{
  turn: number;
  createdAt: string;
  events: readonly TurnEvent[];
}>;

export type TextTranscriptEntry = Readonly<{
  role: "learner" | "agent";
  text: string;
  at: string;
  kind?: "text";
}>;

export type DemoTranscriptEntry = Readonly<{
  role: "agent";
  kind: "demo";
  file: string;
  title?: string;
  at: string;
}>;

export type LessonTranscriptEntry = Readonly<{
  role: "agent";
  kind: "lesson";
  lesson: string;
  at: string;
}>;

export type FeynmanCheckTranscriptEntry = Readonly<{
  role: "agent";
  kind: "feynman-check";
  concept: string;
  prompt: string;
  at: string;
}>;

export type FeynmanAnswerTranscriptEntry = Readonly<{
  role: "learner";
  kind: "feynman-answer";
  concept: string;
  text: string;
  at: string;
}>;

export type TranscriptEntry =
  | TextTranscriptEntry
  | DemoTranscriptEntry
  | LessonTranscriptEntry
  | FeynmanCheckTranscriptEntry
  | FeynmanAnswerTranscriptEntry;

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

export type DemoEntry = Readonly<{
  file: string;
  title?: string;
  addedAt: string;
}>;

export type DemoInput = Readonly<{
  file: string;
  title?: string;
  topic?: string;
}>;

export type DemoMutation = Readonly<{
  action: "created" | "updated";
  demo: DemoEntry;
  topic?: TopicNode;
  topics: readonly TopicNode[];
  unassignedDemos: readonly DemoEntry[];
}>;

export type FeynmanReplacement = Readonly<{
  concept: string;
  issuedAt: string;
  replacedAt: string;
}>;

export type ActiveFeynmanCheck = Readonly<{
  concept: string;
  prompt: string;
  keyPoints: readonly string[];
  issuedAt: string;
  replaced?: FeynmanReplacement;
}>;

export type FeynmanCheckInput = Readonly<{
  concept: string;
  prompt: string;
  keyPoints?: readonly string[];
}>;

export type MasteryEntry = Readonly<{
  concept: string;
  score: number;
  gaps?: string;
  at: string;
}>;

export type MasteryInput = Readonly<{
  concept: string;
  score: number;
  gaps?: string;
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

export const isValidLessonId = (lesson: string): boolean =>
  isValidCourseName(lesson);

export const isValidTopicPath = (path: string): boolean =>
  path.length > 0 &&
  !path.startsWith("/") &&
  !path.endsWith("/") &&
  path.split("/").every(isValidCourseName);

export const isValidDemoFileName = (fileName: string): boolean =>
  fileName.length > ".html".length &&
  fileName === basename(fileName) &&
  !fileName.includes("\\") &&
  fileName.endsWith(".html");

export const isValidConceptId = (concept: string): boolean =>
  /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*$/.test(
    concept,
  );

const invalidConceptIdMessage = (concept: string): string =>
  `Invalid concept id: ${concept}. Use slash-separated lowercase letters, numbers, and hyphens.`;

export const parseKeyPointsText = (text: string): readonly string[] =>
  text
    .split(/[;,]/)
    .map((point) => point.trim())
    .filter((point) => point.length > 0);

const invalidTopicMessage = (filePath: string): string =>
  `Invalid course topics in ${filePath}: expected topic tree nodes.`;

const invalidDemoMessage = (filePath: string): string =>
  `Invalid course demos in ${filePath}: expected demo entries.`;

const invalidActiveFeynmanMessage = (filePath: string): string =>
  `Invalid active Feynman check in ${filePath}`;

const invalidMasteryMessage = (filePath: string): string =>
  `Invalid mastery entry in ${filePath}`;

const parseDemoEntry = (
  value: unknown,
  filePath: string,
  location: string,
): DemoEntry => {
  if (!isRecord(value)) {
    throw new Error(invalidDemoMessage(filePath));
  }

  const file = value["file"];
  const title = value["title"];
  const addedAt = value["addedAt"];

  if (
    typeof file !== "string" ||
    !isValidDemoFileName(file) ||
    (title !== undefined &&
      (typeof title !== "string" || title.trim().length === 0)) ||
    typeof addedAt !== "string" ||
    addedAt.trim().length === 0
  ) {
    throw new Error(`${invalidDemoMessage(filePath)} Invalid entry at ${location}.`);
  }

  return {
    file,
    ...(title === undefined ? {} : { title: title.trim() }),
    addedAt,
  };
};

const parseDemoEntries = (
  value: unknown,
  filePath: string,
  location: string,
): readonly DemoEntry[] => {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new Error(invalidDemoMessage(filePath));
  }

  return value.map((entry, index) =>
    parseDemoEntry(entry, filePath, `${location}[${index}]`),
  );
};

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
  const demos = value["demos"];
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
    (demos !== undefined && !Array.isArray(demos)) ||
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
    ...(demos === undefined
      ? {}
      : {
          demos: demos.map((demo, index) =>
            parseDemoEntry(demo, filePath, `${location}.demos[${index}]`),
          ),
        }),
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
  const harness = value["harness"];
  const topics = value["topics"];
  const unassignedDemos = value["unassignedDemos"];

  if (
    typeof name !== "string" ||
    typeof createdAt !== "string" ||
    (harness !== undefined &&
      (typeof harness !== "string" || harness.trim().length === 0)) ||
    (unassignedDemos !== undefined && !Array.isArray(unassignedDemos))
  ) {
    throw new Error(`Invalid course manifest in ${filePath}`);
  }

  return {
    formatVersion,
    name,
    createdAt,
    ...(harness === undefined ? {} : { harness: harness.trim() }),
    topics: parseTopicTree(topics, filePath),
    unassignedDemos: parseDemoEntries(
      unassignedDemos,
      filePath,
      "unassignedDemos",
    ),
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

const parseKeyPoints = (
  value: unknown,
  errorMessage: string,
): readonly string[] => {
  if (!Array.isArray(value)) {
    throw new Error(errorMessage);
  }

  return value.map((point) => {
    if (typeof point !== "string" || point.trim().length === 0) {
      throw new Error(errorMessage);
    }

    return point.trim();
  });
};

const parseFeynmanReplacement = (
  value: unknown,
  filePath: string,
): FeynmanReplacement | undefined => {
  if (value === undefined) {
    return undefined;
  }

  if (!isRecord(value)) {
    throw new Error(invalidActiveFeynmanMessage(filePath));
  }

  const concept = value["concept"];
  const issuedAt = value["issuedAt"];
  const replacedAt = value["replacedAt"];

  if (
    typeof concept !== "string" ||
    !isValidConceptId(concept) ||
    typeof issuedAt !== "string" ||
    issuedAt.trim().length === 0 ||
    typeof replacedAt !== "string" ||
    replacedAt.trim().length === 0
  ) {
    throw new Error(invalidActiveFeynmanMessage(filePath));
  }

  return {
    concept,
    issuedAt,
    replacedAt,
  };
};

const parseActiveFeynmanCheck = (
  value: unknown,
  filePath: string,
): ActiveFeynmanCheck => {
  if (!isRecord(value)) {
    throw new Error(invalidActiveFeynmanMessage(filePath));
  }

  const concept = value["concept"];
  const prompt = value["prompt"];
  const keyPoints = value["keyPoints"];
  const issuedAt = value["issuedAt"];
  const replaced = parseFeynmanReplacement(value["replaced"], filePath);

  if (
    typeof concept !== "string" ||
    !isValidConceptId(concept) ||
    typeof prompt !== "string" ||
    prompt.trim().length === 0 ||
    typeof issuedAt !== "string" ||
    issuedAt.trim().length === 0
  ) {
    throw new Error(invalidActiveFeynmanMessage(filePath));
  }

  return {
    concept,
    prompt: prompt.trim(),
    keyPoints: parseKeyPoints(keyPoints, invalidActiveFeynmanMessage(filePath)),
    issuedAt,
    ...(replaced === undefined ? {} : { replaced }),
  };
};

const parseMasteryEntry = (
  value: unknown,
  filePath: string,
  index: number,
): MasteryEntry => {
  if (!isRecord(value)) {
    throw new Error(`${invalidMasteryMessage(filePath)}:${index + 1}`);
  }

  const concept = value["concept"];
  const score = value["score"];
  const gaps = value["gaps"];
  const at = value["at"];

  if (
    typeof concept !== "string" ||
    !isValidConceptId(concept) ||
    typeof score !== "number" ||
    !Number.isInteger(score) ||
    score < 0 ||
    score > 100 ||
    (gaps !== undefined &&
      (typeof gaps !== "string" || gaps.trim().length === 0)) ||
    typeof at !== "string" ||
    at.trim().length === 0
  ) {
    throw new Error(`${invalidMasteryMessage(filePath)}:${index + 1}`);
  }

  return {
    concept,
    score,
    ...(gaps === undefined ? {} : { gaps: gaps.trim() }),
    at,
  };
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

  if (type === "review-weak") {
    const concepts = value["concepts"];
    if (!Array.isArray(concepts)) {
      throw new Error(`Invalid pending event in ${filePath}`);
    }

    return {
      type,
      concepts: concepts.map((concept) => {
        if (typeof concept !== "string" || !isValidConceptId(concept)) {
          throw new Error(`Invalid pending event in ${filePath}`);
        }

        return concept;
      }),
    };
  }

  if (type === "session-done") {
    return { type };
  }

  if (type === "harness-swapped") {
    const from = value["from"];
    const to = value["to"];
    if (
      typeof from !== "string" ||
      from.trim().length === 0 ||
      typeof to !== "string" ||
      to.trim().length === 0
    ) {
      throw new Error(`Invalid pending event in ${filePath}`);
    }

    return { type, from: from.trim(), to: to.trim() };
  }

  if (type === "feynman-answer") {
    const concept = value["concept"];
    const text = value["text"];
    const keyPoints = value["keyPoints"];

    if (
      typeof concept !== "string" ||
      !isValidConceptId(concept) ||
      typeof text !== "string" ||
      text.trim().length === 0
    ) {
      throw new Error(`Invalid pending event in ${filePath}`);
    }

    return {
      type,
      concept,
      text: text.trim(),
      keyPoints: parseKeyPoints(
        keyPoints,
        `Invalid pending event in ${filePath}`,
      ),
    };
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
  const kind = value["kind"];
  const text = value["text"];
  const file = value["file"];
  const title = value["title"];
  const lesson = value["lesson"];
  const concept = value["concept"];
  const prompt = value["prompt"];
  const at = value["at"];

  if (
    kind === "demo" &&
    role === "agent" &&
    typeof file === "string" &&
    isValidDemoFileName(file) &&
    (title === undefined ||
      (typeof title === "string" && title.trim().length > 0)) &&
    typeof at === "string"
  ) {
    return {
      role,
      kind,
      file,
      ...(title === undefined ? {} : { title: title.trim() }),
      at,
    };
  }

  if (
    kind === "lesson" &&
    role === "agent" &&
    typeof lesson === "string" &&
    isValidLessonId(lesson) &&
    typeof at === "string"
  ) {
    return {
      role,
      kind,
      lesson,
      at,
    };
  }

  if (
    kind === "feynman-check" &&
    role === "agent" &&
    typeof concept === "string" &&
    isValidConceptId(concept) &&
    typeof prompt === "string" &&
    prompt.trim().length > 0 &&
    typeof at === "string"
  ) {
    return {
      role,
      kind,
      concept,
      prompt: prompt.trim(),
      at,
    };
  }

  if (
    kind === "feynman-answer" &&
    role === "learner" &&
    typeof concept === "string" &&
    isValidConceptId(concept) &&
    typeof text === "string" &&
    text.trim().length > 0 &&
    typeof at === "string"
  ) {
    return {
      role,
      kind,
      concept,
      text: text.trim(),
      at,
    };
  }

  if (
    (role !== "learner" && role !== "agent") ||
    (kind !== undefined && kind !== "text") ||
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
    activeFeynmanJson: join(runtimeDir, "active-feynman.json"),
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
      unassignedDemos: [],
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

export const writeCourseHarness = async (
  courseDir: string,
  harness: string,
): Promise<CourseManifest> => {
  const normalizedHarness = harness.trim();
  if (normalizedHarness.length === 0) {
    throw new Error("Harness id cannot be empty.");
  }

  const paths = getCoursePaths(courseDir);
  const raw = await readJson(paths.courseJson);
  const manifest = parseCourseManifest(raw, paths.courseJson);
  const preserved = isRecord(raw) ? raw : {};
  const next = {
    ...preserved,
    formatVersion: manifest.formatVersion,
    name: manifest.name,
    createdAt: manifest.createdAt,
    harness: normalizedHarness,
    topics: manifest.topics,
    unassignedDemos: manifest.unassignedDemos,
  };

  await writeJsonAtomic(paths.courseJson, next);
  return parseCourseManifest(next, paths.courseJson);
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

const normalizeConceptId = (concept: string): string => {
  const normalized = concept.trim();
  if (normalized.length === 0) {
    throw new Error("Concept id cannot be empty.");
  }

  if (!isValidConceptId(normalized)) {
    throw new Error(invalidConceptIdMessage(concept));
  }

  return normalized;
};

const normalizeFeynmanCheckInput = (
  input: FeynmanCheckInput,
): FeynmanCheckInput => {
  const concept = normalizeConceptId(input.concept);
  const prompt = input.prompt.trim();
  if (prompt.length === 0) {
    throw new Error("Feynman prompt cannot be empty.");
  }

  const keyPoints = input.keyPoints ?? [];
  const normalizedKeyPoints = keyPoints.map((point) => point.trim());
  if (normalizedKeyPoints.some((point) => point.length === 0)) {
    throw new Error("Feynman key points cannot be empty.");
  }

  return {
    concept,
    prompt,
    keyPoints: normalizedKeyPoints,
  };
};

export const readActiveFeynmanCheck = async (
  courseDir: string,
): Promise<ActiveFeynmanCheck | undefined> => {
  const paths = getCoursePaths(courseDir);
  if (!(await Bun.file(paths.activeFeynmanJson).exists())) {
    return undefined;
  }

  return parseActiveFeynmanCheck(
    await readJson(paths.activeFeynmanJson),
    paths.activeFeynmanJson,
  );
};

export const writeActiveFeynmanCheck = async (
  courseDir: string,
  check: ActiveFeynmanCheck,
): Promise<void> => {
  const paths = getCoursePaths(courseDir);
  await mkdir(paths.runtimeDir, { recursive: true });
  await writeJsonAtomic(paths.activeFeynmanJson, check);
};

export const clearActiveFeynmanCheck = async (
  courseDir: string,
): Promise<void> => {
  const paths = getCoursePaths(courseDir);
  await rm(paths.activeFeynmanJson, { force: true });
};

export const registerFeynmanCheck = async (
  courseDir: string,
  input: FeynmanCheckInput,
  now = new Date(),
): Promise<ActiveFeynmanCheck> => {
  const normalized = normalizeFeynmanCheckInput(input);
  const existing = await readActiveFeynmanCheck(courseDir);
  const issuedAt = now.toISOString();
  const replaced =
    existing === undefined
      ? undefined
      : {
          concept: existing.concept,
          issuedAt: existing.issuedAt,
          replacedAt: issuedAt,
        };
  const check: ActiveFeynmanCheck = {
    concept: normalized.concept,
    prompt: normalized.prompt,
    keyPoints: normalized.keyPoints ?? [],
    issuedAt,
    ...(replaced === undefined ? {} : { replaced }),
  };

  await writeActiveFeynmanCheck(courseDir, check);
  return check;
};

export const readMastery = async (
  courseDir: string,
): Promise<readonly MasteryEntry[]> => {
  const paths = getCoursePaths(courseDir);
  if (!(await Bun.file(paths.masteryJson).exists())) {
    return [];
  }

  const value = await readJson(paths.masteryJson);
  if (!Array.isArray(value)) {
    throw new Error(`Invalid mastery in ${paths.masteryJson}`);
  }

  return value.map((entry, index) =>
    parseMasteryEntry(entry, paths.masteryJson, index),
  );
};

const writeMastery = async (
  courseDir: string,
  entries: readonly MasteryEntry[],
): Promise<void> => {
  const paths = getCoursePaths(courseDir);
  await writeJson(paths.masteryJson, entries);
};

const normalizeMasteryInput = (input: MasteryInput): MasteryInput => {
  const concept = normalizeConceptId(input.concept);
  if (!Number.isInteger(input.score) || input.score < 0 || input.score > 100) {
    throw new Error("Mastery score must be an integer from 0 to 100.");
  }

  const gaps = input.gaps?.trim();
  if (gaps !== undefined && gaps.length === 0) {
    throw new Error("Mastery gaps cannot be empty.");
  }

  return {
    concept,
    score: input.score,
    ...(gaps === undefined ? {} : { gaps }),
  };
};

const nextMasteryTimestamp = (
  entries: readonly MasteryEntry[],
  now: Date,
): string => {
  const timestampMs = now.getTime();
  const latestMs = entries.reduce((latest, entry) => {
    const parsed = Date.parse(entry.at);
    return Number.isNaN(parsed) ? latest : Math.max(latest, parsed);
  }, Number.NEGATIVE_INFINITY);
  const nextMs =
    Number.isFinite(latestMs) && timestampMs <= latestMs
      ? latestMs + 1
      : timestampMs;

  return new Date(nextMs).toISOString();
};

export const appendMasteryScore = async (
  courseDir: string,
  input: MasteryInput,
  now = new Date(),
): Promise<MasteryEntry> => {
  const normalized = normalizeMasteryInput(input);
  const entries = await readMastery(courseDir);
  const entry: MasteryEntry = {
    concept: normalized.concept,
    score: normalized.score,
    ...(normalized.gaps === undefined ? {} : { gaps: normalized.gaps }),
    at: nextMasteryTimestamp(entries, now),
  };

  await writeMastery(courseDir, [...entries, entry]);
  return entry;
};

const masteryTimeMs = (entry: MasteryEntry): number => {
  const parsed = Date.parse(entry.at);
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
};

const compareMasteryRecency = (
  left: MasteryEntry,
  leftIndex: number,
  right: MasteryEntry,
  rightIndex: number,
): number => {
  const timeDelta = masteryTimeMs(left) - masteryTimeMs(right);
  if (timeDelta !== 0) {
    return timeDelta;
  }

  const stringDelta = left.at.localeCompare(right.at);
  if (stringDelta !== 0) {
    return stringDelta;
  }

  return leftIndex - rightIndex;
};

export const latestMasteryScores = (
  entries: readonly MasteryEntry[],
): readonly MasteryEntry[] => {
  const byConcept = new Map<
    string,
    Readonly<{ entry: MasteryEntry; index: number }>
  >();

  entries.forEach((entry, index) => {
    const existing = byConcept.get(entry.concept);
    if (
      existing === undefined ||
      compareMasteryRecency(entry, index, existing.entry, existing.index) > 0
    ) {
      byConcept.set(entry.concept, { entry, index });
    }
  });

  return [...byConcept.values()]
    .map((value) => value.entry)
    .sort((left, right) => left.concept.localeCompare(right.concept));
};

export const topicConceptIds = (topicPath: string): readonly string[] => {
  const slug = topicPath.split("/").at(-1) ?? topicPath;
  return slug === topicPath ? [topicPath] : [topicPath, slug];
};

export const latestMasteryForTopic = (
  topic: TopicNode,
  scores: readonly MasteryEntry[],
): MasteryEntry | undefined => {
  const conceptIds = new Set(topicConceptIds(topic.path));
  let match: Readonly<{ entry: MasteryEntry; index: number }> | undefined;

  scores.forEach((entry, index) => {
    if (!conceptIds.has(entry.concept)) {
      return;
    }

    if (
      match === undefined ||
      compareMasteryRecency(entry, index, match.entry, match.index) > 0
    ) {
      match = { entry, index };
    }
  });

  return match?.entry;
};

const collectTopicMastery = (
  topics: readonly TopicNode[],
  scores: readonly MasteryEntry[],
): readonly MasteryEntry[] =>
  topics.flatMap((topic) => {
    const entry = latestMasteryForTopic(topic, scores);
    return [
      ...(entry === undefined ? [] : [entry]),
      ...collectTopicMastery(topic.children, scores),
    ];
  });

const compareWeakestMastery = (
  left: MasteryEntry,
  right: MasteryEntry,
): number => {
  const scoreDelta = left.score - right.score;
  if (scoreDelta !== 0) {
    return scoreDelta;
  }

  const timeDelta = masteryTimeMs(left) - masteryTimeMs(right);
  if (timeDelta !== 0) {
    return timeDelta;
  }

  const stringDelta = left.at.localeCompare(right.at);
  if (stringDelta !== 0) {
    return stringDelta;
  }

  return left.concept.localeCompare(right.concept);
};

export const selectWeakestTopicConcepts = (
  topics: readonly TopicNode[],
  scores: readonly MasteryEntry[],
  limit = 3,
): readonly string[] => {
  if (limit <= 0) {
    return [];
  }

  const seen = new Set<string>();
  return [...collectTopicMastery(topics, scores)]
    .sort(compareWeakestMastery)
    .flatMap((entry) => {
      if (seen.has(entry.concept)) {
        return [];
      }

      seen.add(entry.concept);
      return [entry.concept];
    })
    .slice(0, limit);
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

export const appendAgentDemoTranscript = async (
  courseDir: string,
  file: string,
  title: string | undefined,
  at: string,
): Promise<DemoTranscriptEntry> => {
  const entry: DemoTranscriptEntry =
    title === undefined
      ? {
          role: "agent",
          kind: "demo",
          file,
          at,
        }
      : {
          role: "agent",
          kind: "demo",
          file,
          title,
          at,
        };

  await appendTranscriptEntry(courseDir, entry);
  return entry;
};

export const appendLessonTranscript = async (
  courseDir: string,
  lesson: string,
  at: string,
): Promise<LessonTranscriptEntry> => {
  const entry: LessonTranscriptEntry = {
    role: "agent",
    kind: "lesson",
    lesson,
    at,
  };

  await appendTranscriptEntry(courseDir, entry);
  return entry;
};

export const appendFeynmanCheckTranscript = async (
  courseDir: string,
  concept: string,
  prompt: string,
  at: string,
): Promise<FeynmanCheckTranscriptEntry> => {
  const entry: FeynmanCheckTranscriptEntry = {
    role: "agent",
    kind: "feynman-check",
    concept,
    prompt,
    at,
  };

  await appendTranscriptEntry(courseDir, entry);
  return entry;
};

export const appendFeynmanAnswerTranscript = async (
  courseDir: string,
  concept: string,
  text: string,
  at: string,
): Promise<FeynmanAnswerTranscriptEntry> => {
  const entry: FeynmanAnswerTranscriptEntry = {
    role: "learner",
    kind: "feynman-answer",
    concept,
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

type NormalizedDemoInput = Readonly<{
  file: string;
  title?: string;
  topic?: string;
}>;

const normalizeDemoInput = (input: DemoInput): NormalizedDemoInput => {
  const file = input.file.trim();
  if (file.length === 0) {
    throw new Error("Demo file cannot be empty.");
  }

  if (!isValidDemoFileName(file)) {
    throw new Error(
      `Invalid demo file: ${input.file}. Use a .html file directly inside demos/.`,
    );
  }

  const title = input.title?.trim();
  if (title !== undefined && title.length === 0) {
    throw new Error("Demo title cannot be empty.");
  }

  const topic = input.topic?.trim();
  if (topic !== undefined && topic.length === 0) {
    throw new Error("Demo topic cannot be empty.");
  }

  if (topic !== undefined && !isValidTopicPath(topic)) {
    throw new Error(
      `Invalid demo topic: ${input.topic}. Use slash-separated course-name-safe segments.`,
    );
  }

  return {
    file,
    ...(title === undefined ? {} : { title }),
    ...(topic === undefined ? {} : { topic }),
  };
};

const demoFileExists = async (
  courseDir: string,
  fileName: string,
): Promise<boolean> => {
  if (!isValidDemoFileName(fileName)) {
    return false;
  }

  const paths = getCoursePaths(courseDir);

  try {
    return (await stat(join(paths.demosDir, fileName))).isFile();
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return false;
    }

    throw error;
  }
};

const formatDemoEntry = (
  file: string,
  title: string | undefined,
  addedAt: string,
): DemoEntry =>
  title === undefined
    ? { file, addedAt }
    : {
        file,
        title,
        addedAt,
      };

const upsertDemoList = (
  demos: readonly DemoEntry[],
  input: NormalizedDemoInput,
  addedAt: string,
): Readonly<{
  action: "created" | "updated";
  demo: DemoEntry;
  demos: readonly DemoEntry[];
}> => {
  const existingIndex = demos.findIndex((demo) => demo.file === input.file);

  if (existingIndex === -1) {
    const demo = formatDemoEntry(input.file, input.title, addedAt);
    return {
      action: "created",
      demo,
      demos: [...demos, demo],
    };
  }

  const existing = demos[existingIndex];
  if (existing === undefined) {
    throw new Error("Unable to update demo entry.");
  }

  const demo = formatDemoEntry(
    input.file,
    input.title ?? existing.title,
    existing.addedAt,
  );

  return {
    action: "updated",
    demo,
    demos: demos.map((candidate, index) =>
      index === existingIndex ? demo : candidate,
    ),
  };
};

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
  demos: readonly DemoEntry[] | undefined = undefined,
): TopicNode => ({
  path,
  title,
  ...(lesson === undefined ? {} : { lesson }),
  ...(enteredAt === undefined ? {} : { enteredAt }),
  current,
  ...(demos === undefined || demos.length === 0 ? {} : { demos }),
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
    node.demos,
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
      existing.demos,
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
    existing.demos,
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

const currentTopicPath = (topics: readonly TopicNode[]): string | undefined => {
  for (const topic of topics) {
    if (topic.current) {
      return topic.path;
    }

    const childPath = currentTopicPath(topic.children);
    if (childPath !== undefined) {
      return childPath;
    }
  }

  return undefined;
};

const findTopic = (
  topics: readonly TopicNode[],
  path: string,
): TopicNode | undefined => {
  for (const topic of topics) {
    if (topic.path === path) {
      return topic;
    }

    const child = findTopic(topic.children, path);
    if (child !== undefined) {
      return child;
    }
  }

  return undefined;
};

type TopicDemoUpdate = Readonly<{
  topics: readonly TopicNode[];
  topic: TopicNode | undefined;
  action: "created" | "updated" | undefined;
  demo: DemoEntry | undefined;
}>;

const upsertDemoInTopicTree = (
  topics: readonly TopicNode[],
  topicPath: string,
  input: NormalizedDemoInput,
  addedAt: string,
): TopicDemoUpdate => {
  let updatedTopic: TopicNode | undefined;
  let action: "created" | "updated" | undefined;
  let demo: DemoEntry | undefined;

  const nextTopics = topics.map((topic) => {
    if (topic.path === topicPath) {
      const update = upsertDemoList(topic.demos ?? [], input, addedAt);
      updatedTopic = formatTopicNode(
        topic.path,
        topic.title,
        topic.lesson,
        topic.enteredAt,
        topic.current,
        topic.children,
        update.demos,
      );
      action = update.action;
      demo = update.demo;
      return updatedTopic;
    }

    const childUpdate = upsertDemoInTopicTree(
      topic.children,
      topicPath,
      input,
      addedAt,
    );

    if (childUpdate.topic === undefined) {
      return topic;
    }

    updatedTopic = childUpdate.topic;
    action = childUpdate.action;
    demo = childUpdate.demo;

    return formatTopicNode(
      topic.path,
      topic.title,
      topic.lesson,
      topic.enteredAt,
      topic.current,
      childUpdate.topics,
      topic.demos,
    );
  });

  return {
    topics: nextTopics,
    topic: updatedTopic,
    action,
    demo,
  };
};

export const registerDemo = async (
  courseDir: string,
  input: DemoInput,
  now = new Date(),
): Promise<DemoMutation> => {
  const normalized = normalizeDemoInput(input);

  if (!(await demoFileExists(courseDir, normalized.file))) {
    throw new Error(`Demo file does not exist: demos/${normalized.file}`);
  }

  const manifest = await readCourseManifest(courseDir);
  const targetTopicPath = normalized.topic ?? currentTopicPath(manifest.topics);

  if (
    normalized.topic !== undefined &&
    findTopic(manifest.topics, normalized.topic) === undefined
  ) {
    throw new Error(`Topic does not exist: ${normalized.topic}`);
  }

  if (targetTopicPath === undefined) {
    const update = upsertDemoList(
      manifest.unassignedDemos,
      normalized,
      now.toISOString(),
    );
    await writeCourseManifest(courseDir, {
      ...manifest,
      unassignedDemos: update.demos,
    });

    return {
      action: update.action,
      demo: update.demo,
      topics: manifest.topics,
      unassignedDemos: update.demos,
    };
  }

  const update = upsertDemoInTopicTree(
    manifest.topics,
    targetTopicPath,
    normalized,
    now.toISOString(),
  );

  if (
    update.topic === undefined ||
    update.action === undefined ||
    update.demo === undefined
  ) {
    throw new Error(`Topic does not exist: ${targetTopicPath}`);
  }

  await writeCourseManifest(courseDir, {
    ...manifest,
    topics: update.topics,
  });

  return {
    action: update.action,
    demo: update.demo,
    topic: update.topic,
    topics: update.topics,
    unassignedDemos: manifest.unassignedDemos,
  };
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

import { appendFile, mkdir, readdir, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export const COURSE_FORMAT_VERSION = 1;
export const DEFAULT_COURSE_NAME = "default";

export type CourseManifest = Readonly<{
  formatVersion: typeof COURSE_FORMAT_VERSION;
  name: string;
  createdAt: string;
  topics: readonly string[];
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

export type TurnEvent = MessageTurnEvent;

export type TurnFile = Readonly<{
  turn: number;
  createdAt: string;
  events: readonly TurnEvent[];
}>;

export type TranscriptEntry = Readonly<{
  role: "learner";
  text: string;
  at: string;
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

const writeJson = async (filePath: string, value: unknown): Promise<void> => {
  await Bun.write(filePath, `${JSON.stringify(value, null, 2)}\n`);
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
    typeof createdAt !== "string" ||
    !Array.isArray(topics) ||
    !topics.every((topic) => typeof topic === "string")
  ) {
    throw new Error(`Invalid course manifest in ${filePath}`);
  }

  return {
    formatVersion,
    name,
    createdAt,
    topics,
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
  const text = value["text"];

  if (type !== "message" || typeof text !== "string") {
    throw new Error(`Invalid pending event in ${filePath}`);
  }

  return { type, text };
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

export const isValidCourseName = (name: string): boolean =>
  name.length > 0 &&
  name !== "." &&
  name !== ".." &&
  !name.includes("/") &&
  !name.includes("\\");

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

    await writeJson(paths.courseJson, manifest);
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

export const appendLearnerTranscript = async (
  courseDir: string,
  text: string,
  at: string,
): Promise<void> => {
  const paths = getCoursePaths(courseDir);
  const entry: TranscriptEntry = {
    role: "learner",
    text,
    at,
  };

  await appendFile(paths.transcriptJsonl, `${JSON.stringify(entry)}\n`);
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

import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { join, resolve } from "node:path";

import {
  appendAgentTranscript,
  appendFeynmanAnswerTranscript,
  appendFeynmanCheckTranscript,
  appendLessonTranscript,
  appendLearnerTranscript,
  clearActiveFeynmanCheck,
  clearDaemonMetadata,
  DEFAULT_COURSE_NAME,
  ensureCourseScaffold,
  requireCourse,
  getCoursePaths,
  isValidConceptId,
  isValidTopicPath,
  latestMasteryScores,
  isValidDemoFileName,
  readActiveFeynmanCheck,
  readCourseManifest,
  readDaemonMetadata,
  readGlossary,
  readMastery,
  readPendingEvents,
  readTranscript,
  resolveCourseDirForWait,
  selectWeakestTopicConcepts,
  writeDaemonMetadata,
  writePendingEvents,
  writeTurnFile,
  type ActiveFeynmanCheck,
  type DaemonMetadata,
  type CoursePaths,
  type DemoEntry,
  type GlossaryEntry,
  type MasteryEntry,
  type TopicNode,
  type TranscriptEntry,
  type TurnEvent,
} from "../course";
import { watchFeynmanFile } from "./feynman";
import { watchGlossaryFile } from "./glossary";
import { watchMasteryFile } from "./mastery";
import {
  readLessonSnapshot,
  isLessonFileName,
  lessonIdFromFileName,
  watchLessonDirectory,
  type LessonEvent,
} from "./lessons";
import { renderDemoEmbed, renderMarkdown } from "./markdown";
import { watchTopicFile } from "./topics";
import { renderPage } from "./ui";

export type DaemonEndpoint = Readonly<{
  host: string;
  port: number;
}>;

export type CourseStatus = Readonly<{
  daemonAlive: boolean;
  waitPending: boolean;
  courseDir: string | null;
}>;

type Env = Readonly<Record<string, string | undefined>>;

type UiStatus = "waiting-for-agent" | "agent-working";

type UiStatusPayload = Readonly<{
  status: UiStatus;
  hasSeenWait: boolean;
}>;

export type AgentMessageSource =
  | Readonly<{ kind: "text"; text: string }>
  | Readonly<{ kind: "file"; path: string }>;

type Waiter = Readonly<{
  id: number;
  resolve: (turnPath: string) => void;
}>;

type WaitSetup =
  | Readonly<{ kind: "response"; response: Response }>
  | Readonly<{ kind: "wait"; response: Promise<Response> }>;

type DaemonHealth = Readonly<{
  coursePath: string;
  waitPending: boolean;
  hasSeenWait: boolean;
}>;

export class LearnCommandError extends Error {
  readonly exitCode: 1 | 2;

  constructor(exitCode: 1 | 2, message: string) {
    super(message);
    this.name = "LearnCommandError";
    this.exitCode = exitCode;
  }
}

const LOCALHOST_BIND_HOST = "127.0.0.1";
const LOCALHOST_PRINT_HOST = "localhost";
const DAEMON_START_TIMEOUT_MS = 5_000;
const DAEMON_START_POLL_MS = 50;
const WAIT_RETRY_DELAY_MS = 250;
export const REVIEW_WEAK_NAV_PATH = "overlearn:review-weak";

const sleep = async (milliseconds: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
};

const jsonResponse = (value: unknown, init?: ResponseInit): Response =>
  new Response(JSON.stringify(value), {
    ...init,
    headers: {
      "content-type": "application/json",
      ...init?.headers,
    },
  });

const textResponse = (
  text: string,
  status: number,
): Response =>
  new Response(text, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
    },
  });

const DEMO_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:;";

const formatPublicUrl = (port: number): string =>
  `http://${LOCALHOST_PRINT_HOST}:${port}`;

const formatDaemonUrl = (port: number, path: string): string =>
  `http://${LOCALHOST_BIND_HOST}:${port}${path}`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasErrorCode = (error: unknown, code: string): boolean =>
  isRecord(error) && error["code"] === code;

const isPidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const readDaemonHealth = async (
  metadata: DaemonMetadata,
): Promise<DaemonHealth | undefined> => {
  try {
    const response = await fetch(formatDaemonUrl(metadata.port, "/api/health"));
    if (!response.ok) {
      return undefined;
    }

    const body = (await response.json()) as unknown;
    if (!isRecord(body) || typeof body["coursePath"] !== "string") {
      return undefined;
    }

    return {
      coursePath: body["coursePath"],
      waitPending: body["waitPending"] === true,
      hasSeenWait: body["hasSeenWait"] === true,
    };
  } catch {
    return undefined;
  }
};

const readCourseDisplayTitle = async (
  courseJson: string,
  fallback: string,
): Promise<string> => {
  try {
    const value = JSON.parse(await readFile(courseJson, "utf8")) as unknown;
    const title = isRecord(value) ? value["title"] : undefined;
    if (typeof title === "string" && title.trim().length > 0) {
      return title.trim();
    }
  } catch {
    // Invalid manifests are handled by readCourseManifest; title fallback is best-effort.
  }

  return fallback;
};

const healthMatchesCourse = async (
  courseDir: string,
  metadata: DaemonMetadata,
): Promise<boolean> => {
  const health = await readDaemonHealth(metadata);
  return health?.coursePath === courseDir;
};

const isUsableDaemon = async (
  courseDir: string,
  metadata: DaemonMetadata,
): Promise<boolean> =>
  isPidAlive(metadata.pid) && (await healthMatchesCourse(courseDir, metadata));

const getDaemonSpawnCommand = (courseDir: string): readonly string[] => {
  const executable = process.argv[0] ?? process.execPath;
  const scriptPath = process.argv[1];

  if (
    scriptPath !== undefined &&
    (scriptPath.endsWith(".ts") || scriptPath.endsWith(".js"))
  ) {
    return [executable, scriptPath, "__daemon", courseDir];
  }

  return [process.execPath, "__daemon", courseDir];
};

const spawnDaemonProcess = (courseDir: string, env: Env): void => {
  const [command, ...args] = getDaemonSpawnCommand(courseDir);
  if (command === undefined) {
    throw new LearnCommandError(1, "Unable to determine daemon command.");
  }

  const child = spawn(command, args, {
    detached: true,
    env: {
      ...process.env,
      ...env,
    },
    stdio: "ignore",
  });

  child.unref();
};

const waitForDaemonMetadata = async (
  courseDir: string,
): Promise<DaemonMetadata> => {
  const startedAt = Date.now();

  while (Date.now() - startedAt < DAEMON_START_TIMEOUT_MS) {
    const metadata = await readDaemonMetadata(courseDir);
    if (
      metadata !== undefined &&
      (await isUsableDaemon(courseDir, metadata))
    ) {
      return metadata;
    }

    await sleep(DAEMON_START_POLL_MS);
  }

  throw new LearnCommandError(1, "Daemon did not start within 5 seconds.");
};

const openBrowser = (url: string, env: Env): void => {
  if (env["OVERLEARN_NO_BROWSER"] === "1") {
    return;
  }

  const command = process.platform === "darwin" ? "open" : "xdg-open";

  try {
    const child = spawn(command, [url], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  } catch {
    // Opening the browser is best-effort by contract.
  }
};

const startDaemonForCourse = async (
  paths: CoursePaths,
  env: Env = process.env,
): Promise<string> => {
  const existingMetadata = await readDaemonMetadata(paths.courseDir);

  if (
    existingMetadata !== undefined &&
    (await isUsableDaemon(paths.courseDir, existingMetadata))
  ) {
    const url = formatPublicUrl(existingMetadata.port);
    openBrowser(url, env);
    return url;
  }

  if (existingMetadata !== undefined) {
    await clearDaemonMetadata(paths.courseDir);
  }

  spawnDaemonProcess(paths.courseDir, env);
  const metadata = await waitForDaemonMetadata(paths.courseDir);
  const url = formatPublicUrl(metadata.port);

  openBrowser(url, env);

  return url;
};

export const startCourseDaemon = async (
  name = DEFAULT_COURSE_NAME,
  env: Env = process.env,
): Promise<string> =>
  startDaemonForCourse(await ensureCourseScaffold(name, env), env);

export const resumeCourseDaemon = async (
  name: string,
  env: Env = process.env,
): Promise<string> => startDaemonForCourse(await requireCourse(name, env), env);

const parseWaitResponse = async (response: Response): Promise<string> => {
  const body = (await response.json()) as unknown;
  if (!isRecord(body) || typeof body["turnPath"] !== "string") {
    throw new LearnCommandError(2, "Daemon returned an invalid wait response.");
  }

  return body["turnPath"];
};

export type LearnerTurn = Readonly<{
  turnPath: string;
  courseDir: string;
}>;

export const waitForLearnerTurn = async (
  name: string | undefined,
  env: Env = process.env,
  cwd = process.cwd(),
): Promise<LearnerTurn> => {
  const courseDir = await resolveCourseDirForWait(name, env, cwd);
  const metadata = await readDaemonMetadata(courseDir);

  if (metadata === undefined || !isPidAlive(metadata.pid)) {
    throw new LearnCommandError(
      2,
      `Daemon is not running for course: ${courseDir}`,
    );
  }

  let response: Response;
  for (;;) {
    try {
      response = await fetch(formatDaemonUrl(metadata.port, "/api/wait"));
      break;
    } catch {
      // A dropped connection is not proof of death; only give up when the
      // daemon process is actually gone.
      if (!isPidAlive(metadata.pid)) {
        throw new LearnCommandError(
          2,
          "Daemon died while waiting for learner input.",
        );
      }
      await sleep(WAIT_RETRY_DELAY_MS);
    }
  }

  if (!response.ok) {
    const body = await response.text();
    throw new LearnCommandError(
      2,
      body.trim().length > 0
        ? `Daemon wait failed: ${body.trim()}`
        : `Daemon wait failed with HTTP ${response.status}`,
    );
  }

  return {
    turnPath: await parseWaitResponse(response),
    courseDir,
  };
};

export const getCourseStatus = async (
  name: string | undefined,
  env: Env = process.env,
  cwd = process.cwd(),
): Promise<CourseStatus> => {
  let courseDir: string;
  try {
    courseDir = await resolveCourseDirForWait(name, env, cwd);
  } catch {
    return {
      daemonAlive: false,
      waitPending: false,
      courseDir: null,
    };
  }

  const metadata = await readDaemonMetadata(courseDir);
  if (metadata === undefined || !isPidAlive(metadata.pid)) {
    return {
      daemonAlive: false,
      waitPending: false,
      courseDir,
    };
  }

  const health = await readDaemonHealth(metadata);
  if (health?.coursePath !== courseDir) {
    return {
      daemonAlive: false,
      waitPending: false,
      courseDir,
    };
  }

  return {
    daemonAlive: true,
    waitPending: health.waitPending,
    courseDir,
  };
};

const readAgentMessageText = async (
  source: AgentMessageSource,
  cwd: string,
): Promise<string> =>
  source.kind === "text"
    ? source.text
    : await readFile(resolve(cwd, source.path), "utf8");

const readDemoFileSet = async (
  demosDir: string,
): Promise<ReadonlySet<string>> => {
  let entries: string[];
  try {
    entries = await readdir(demosDir);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return new Set();
    }

    throw error;
  }

  const fileNames = await Promise.all(
    entries
      .filter(isValidDemoFileName)
      .map(async (fileName) => {
        try {
          return (await stat(join(demosDir, fileName))).isFile()
            ? fileName
            : undefined;
        } catch (error) {
          if (
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            error.code === "ENOENT"
          ) {
            return undefined;
          }

          throw error;
        }
      }),
  );

  return new Set(
    fileNames.flatMap((fileName) =>
      fileName === undefined ? [] : [fileName],
    ),
  );
};

type TranscriptBroadcaster = (entry: TranscriptEntry) => void;

const noopBroadcastTranscriptEntry: TranscriptBroadcaster = () => undefined;

type LessonFileReference = Readonly<{
  id: string;
  modifiedAtMs: number;
}>;

export const lessonTranscriptIds = (
  transcript: readonly TranscriptEntry[],
): Set<string> =>
  new Set(
    transcript.flatMap((entry) =>
      entry.kind === "lesson" ? [entry.lesson] : [],
    ),
  );

export const latestFeynmanCheckIssuedAt = (
  transcript: readonly TranscriptEntry[],
): string | undefined =>
  transcript.reduce<string | undefined>(
    (latest, entry) =>
      entry.kind === "feynman-check" ? entry.at : latest,
    undefined,
  );

const lessonIdsFromEvent = (event: LessonEvent): readonly string[] => {
  if (event.action === "upsert") {
    return [event.lesson.id];
  }

  if (event.action === "snapshot") {
    return event.snapshot.lessons.map((lesson) => lesson.id);
  }

  return [];
};

export const appendFirstSeenLessonTranscripts = async (
  courseDir: string,
  seenLessonIds: Set<string>,
  event: LessonEvent,
  broadcastTranscriptEntry: TranscriptBroadcaster =
    noopBroadcastTranscriptEntry,
): Promise<readonly TranscriptEntry[]> => {
  const entries: TranscriptEntry[] = [];

  for (const lessonId of lessonIdsFromEvent(event)) {
    if (seenLessonIds.has(lessonId)) {
      continue;
    }

    const entry = await appendLessonTranscript(
      courseDir,
      lessonId,
      new Date().toISOString(),
    );
    seenLessonIds.add(lessonId);
    entries.push(entry);
    broadcastTranscriptEntry(entry);
  }

  return entries;
};

const readLessonFileReference = async (
  lessonsDir: string,
  fileName: string,
): Promise<LessonFileReference | undefined> => {
  if (!isLessonFileName(fileName)) {
    return undefined;
  }

  try {
    const fileStat = await stat(join(lessonsDir, fileName));
    return fileStat.isFile()
      ? {
          id: lessonIdFromFileName(fileName),
          modifiedAtMs: fileStat.mtimeMs,
        }
      : undefined;
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return undefined;
    }

    throw error;
  }
};

const readLessonFileReferences = async (
  lessonsDir: string,
): Promise<readonly LessonFileReference[]> => {
  let fileNames: string[];
  try {
    fileNames = await readdir(lessonsDir);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return [];
    }

    throw error;
  }

  const references = await Promise.all(
    fileNames.map((fileName) => readLessonFileReference(lessonsDir, fileName)),
  );

  return references
    .flatMap((reference) => (reference === undefined ? [] : [reference]))
    .sort((left, right) => {
      const mtimeCompare = left.modifiedAtMs - right.modifiedAtMs;
      return mtimeCompare === 0 ? left.id.localeCompare(right.id) : mtimeCompare;
    });
};

export const backfillLessonTranscripts = async (
  courseDir: string,
  lessonsDir: string,
  seenLessonIds: Set<string>,
  broadcastTranscriptEntry: TranscriptBroadcaster =
    noopBroadcastTranscriptEntry,
): Promise<readonly TranscriptEntry[]> => {
  const entries: TranscriptEntry[] = [];

  for (const reference of await readLessonFileReferences(lessonsDir)) {
    if (seenLessonIds.has(reference.id)) {
      continue;
    }

    const entry = await appendLessonTranscript(
      courseDir,
      reference.id,
      new Date(reference.modifiedAtMs).toISOString(),
    );
    seenLessonIds.add(reference.id);
    entries.push(entry);
    broadcastTranscriptEntry(entry);
  }

  return entries;
};

export const appendNewFeynmanCheckTranscript = async (
  courseDir: string,
  activeCheck: ActiveFeynmanCheck | undefined,
  lastRecordedIssuedAt: string | undefined,
  broadcastTranscriptEntry: TranscriptBroadcaster =
    noopBroadcastTranscriptEntry,
): Promise<
  Readonly<{
    entry: TranscriptEntry | undefined;
    lastRecordedIssuedAt: string | undefined;
  }>
> => {
  if (
    activeCheck === undefined ||
    activeCheck.issuedAt === lastRecordedIssuedAt
  ) {
    return { entry: undefined, lastRecordedIssuedAt };
  }

  const entry = await appendFeynmanCheckTranscript(
    courseDir,
    activeCheck.concept,
    activeCheck.prompt,
    activeCheck.issuedAt,
  );
  broadcastTranscriptEntry(entry);

  return {
    entry,
    lastRecordedIssuedAt: activeCheck.issuedAt,
  };
};

export const appendFeynmanAnswerTimelineEntry = async (
  courseDir: string,
  concept: string,
  text: string,
  at: string,
  broadcastTranscriptEntry: TranscriptBroadcaster =
    noopBroadcastTranscriptEntry,
): Promise<TranscriptEntry> => {
  const entry = await appendFeynmanAnswerTranscript(
    courseDir,
    concept,
    text,
    at,
  );
  broadcastTranscriptEntry(entry);

  return entry;
};

const demoFileFromPath = (pathName: string): string | undefined => {
  if (!pathName.startsWith("/demos/")) {
    return undefined;
  }

  const encodedFile = pathName.slice("/demos/".length);
  if (encodedFile.length === 0 || encodedFile.includes("/")) {
    return undefined;
  }

  try {
    const file = decodeURIComponent(encodedFile);
    return isValidDemoFileName(file) ? file : undefined;
  } catch {
    return undefined;
  }
};

const demoResponse = async (
  demosDir: string,
  pathName: string,
): Promise<Response | undefined> => {
  const file = demoFileFromPath(pathName);
  if (file === undefined) {
    return undefined;
  }

  const filePath = join(demosDir, file);

  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) {
      return textResponse("Demo not found", 404);
    }
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return textResponse("Demo not found", 404);
    }

    throw error;
  }

  return new Response(Bun.file(filePath), {
    headers: {
      "content-type": "text/html; charset=utf-8",
      // Inline demos are self-contained. The iframe sandbox omits
      // allow-same-origin, and this CSP blocks network reach-back.
      "content-security-policy": DEMO_CSP,
    },
  });
};

const notifyAgentMessage = async (
  metadata: DaemonMetadata,
  entry: TranscriptEntry,
): Promise<string | undefined> => {
  try {
    const response = await fetch(
      formatDaemonUrl(metadata.port, "/api/agent-message"),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(entry),
      },
    );

    if (response.ok) {
      return undefined;
    }

    const body = await response.text();
    return body.trim().length > 0
      ? `daemon rejected agent message: ${body.trim()}`
      : `daemon rejected agent message with HTTP ${response.status}`;
  } catch {
    return "daemon did not accept the agent message";
  }
};

export const sayAgentMessage = async (
  name: string | undefined,
  source: AgentMessageSource,
  env: Env = process.env,
  cwd = process.cwd(),
): Promise<string | undefined> => {
  const courseDir = await resolveCourseDirForWait(name, env, cwd);
  const text = await readAgentMessageText(source, cwd);

  if (text.trim().length === 0) {
    throw new LearnCommandError(1, "Agent message text cannot be empty.");
  }

  const at = new Date().toISOString();
  const entry = await appendAgentTranscript(courseDir, text, at);

  return notifyAgentTranscriptEntry(courseDir, entry);
};

export const notifyAgentTranscriptEntry = async (
  courseDir: string,
  entry: TranscriptEntry,
): Promise<string | undefined> => {
  const metadata = await readDaemonMetadata(courseDir);

  if (
    metadata === undefined ||
    !(await isUsableDaemon(courseDir, metadata))
  ) {
    return `Warning: daemon is not running for course ${courseDir}; appended agent message to transcript only.`;
  }

  const notifyWarning = await notifyAgentMessage(metadata, entry);
  return notifyWarning === undefined
    ? undefined
    : `Warning: ${notifyWarning}; appended agent message to transcript only.`;
};

const createSseHub = (
  getStatus: () => UiStatusPayload,
  getGlossary: () => readonly GlossaryEntry[],
  getTopics: () => readonly TopicNode[],
  getUnassignedDemos: () => readonly DemoEntry[],
  getMasteryScores: () => readonly MasteryEntry[],
  getDemoFiles: () => ReadonlySet<string>,
  getActiveFeynmanCheck: () => ActiveFeynmanCheck | undefined,
) => {
  const subscribers = new Set<ServerResponse>();

  const writeEvent = (
    response: ServerResponse,
    event: string,
    value: unknown,
  ): void => {
    if (response.writableEnded) {
      subscribers.delete(response);
      return;
    }

    response.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);
  };

  const broadcastStatus = (): void => {
    const payload = getStatus();
    for (const subscriber of subscribers) {
      writeEvent(subscriber, "status", payload);
    }
  };

  const renderTranscriptEntry = (entry: TranscriptEntry) => {
    const markdownOptions = {
      glossary: getGlossary(),
      demoFiles: getDemoFiles(),
    };
    const html =
      entry.kind === "demo"
        ? renderDemoEmbed(entry.file, entry.title, {
            demoFiles: getDemoFiles(),
          })
        : entry.kind === undefined || entry.kind === "text"
          ? renderMarkdown(entry.text, markdownOptions)
          : entry.kind === "feynman-check"
            ? renderMarkdown(entry.prompt, markdownOptions)
            : entry.kind === "feynman-answer"
              ? renderMarkdown(entry.text, markdownOptions)
              : "";

    return { ...entry, html };
  };

  const broadcastMessage = (entry: TranscriptEntry): void => {
    const renderedEntry = renderTranscriptEntry(entry);
    for (const subscriber of subscribers) {
      writeEvent(subscriber, "message", renderedEntry);
    }
  };

  const broadcastTranscript = (entries: readonly TranscriptEntry[]): void => {
    const renderedEntries = entries.map(renderTranscriptEntry);
    for (const subscriber of subscribers) {
      writeEvent(subscriber, "transcript", { entries: renderedEntries });
    }
  };

  const broadcastLesson = (event: LessonEvent): void => {
    for (const subscriber of subscribers) {
      writeEvent(subscriber, "lesson", event);
    }
  };

  const broadcastGlossary = (entries: readonly GlossaryEntry[]): void => {
    for (const subscriber of subscribers) {
      writeEvent(subscriber, "glossary", { entries });
    }
  };

  const broadcastTopics = (
    topics: readonly TopicNode[],
    unassignedDemos: readonly DemoEntry[],
  ): void => {
    for (const subscriber of subscribers) {
      writeEvent(subscriber, "topics", { topics, unassignedDemos });
    }
  };

  const broadcastMastery = (entries: readonly MasteryEntry[]): void => {
    for (const subscriber of subscribers) {
      writeEvent(subscriber, "mastery", { entries });
    }
  };

  const broadcastFeynman = (
    activeCheck: ActiveFeynmanCheck | undefined,
  ): void => {
    for (const subscriber of subscribers) {
      writeEvent(subscriber, "feynman", { activeCheck: activeCheck ?? null });
    }
  };

  const connect = (
    request: IncomingMessage,
    response: ServerResponse,
  ): void => {
    response.writeHead(200, {
      "cache-control": "no-cache",
      connection: "keep-alive",
      "content-type": "text/event-stream",
    });
    subscribers.add(response);
    writeEvent(response, "status", getStatus());
    writeEvent(response, "glossary", { entries: getGlossary() });
    writeEvent(response, "topics", {
      topics: getTopics(),
      unassignedDemos: getUnassignedDemos(),
    });
    writeEvent(response, "mastery", { entries: getMasteryScores() });
    writeEvent(response, "feynman", {
      activeCheck: getActiveFeynmanCheck() ?? null,
    });

    request.on("close", () => {
      subscribers.delete(response);
    });
  };

  return {
    broadcastFeynman,
    broadcastGlossary,
    broadcastLesson,
    broadcastMastery,
    broadcastMessage,
    broadcastStatus,
    broadcastTranscript,
    broadcastTopics,
    connect,
  };
};

const createSerializer = () => {
  let current = Promise.resolve();

  return async <T>(operation: () => Promise<T>): Promise<T> => {
    const next = current.then(operation, operation);
    current = next.then(
      () => undefined,
      () => undefined,
    );

    return next;
  };
};

const parseSubmitText = (bodyText: string): string => {
  const body = JSON.parse(bodyText) as unknown;
  if (!isRecord(body) || typeof body["text"] !== "string") {
    throw new Error("Expected JSON body with a text field.");
  }

  const text = body["text"].trim();
  if (text.length === 0) {
    throw new Error("Message text cannot be empty.");
  }

  return text;
};

type NavRequest =
  | Readonly<{ kind: "nav"; path: string }>
  | Readonly<{ kind: "review-weak" }>;

const parseNavRequest = (bodyText: string): NavRequest => {
  const body = JSON.parse(bodyText) as unknown;
  if (!isRecord(body) || typeof body["path"] !== "string") {
    throw new Error("Expected JSON body with a path field.");
  }

  const path = body["path"].trim();
  if (path.length === 0) {
    throw new Error("Topic path cannot be empty.");
  }

  if (path === REVIEW_WEAK_NAV_PATH) {
    return { kind: "review-weak" };
  }

  if (!isValidTopicPath(path)) {
    throw new Error(`Invalid topic path: ${body["path"]}.`);
  }

  return { kind: "nav", path };
};

const parseFeynmanAnswer = (
  bodyText: string,
): Readonly<{ concept: string; text: string }> => {
  const body = JSON.parse(bodyText) as unknown;
  if (
    !isRecord(body) ||
    typeof body["concept"] !== "string" ||
    typeof body["text"] !== "string"
  ) {
    throw new Error("Expected JSON body with concept and text fields.");
  }

  const concept = body["concept"].trim();
  if (concept.length === 0) {
    throw new Error("Concept id cannot be empty.");
  }

  if (!isValidConceptId(concept)) {
    throw new Error(
      `Invalid concept id: ${body["concept"]}. Use slash-separated lowercase letters, numbers, and hyphens.`,
    );
  }

  const text = body["text"].trim();
  if (text.length === 0) {
    throw new Error("Feynman answer cannot be empty.");
  }

  return { concept, text };
};

const parseAgentMessage = (bodyText: string): TranscriptEntry => {
  const body = JSON.parse(bodyText) as unknown;
  if (!isRecord(body)) {
    throw new Error("Expected JSON agent message body.");
  }

  const role = body["role"];
  const kind = body["kind"];
  const text = body["text"];
  const file = body["file"];
  const title = body["title"];
  const at = body["at"];

  if (role !== "agent" || typeof at !== "string") {
    throw new Error("Expected JSON body with agent role and at fields.");
  }

  if (kind === "demo") {
    if (
      typeof file !== "string" ||
      !isValidDemoFileName(file) ||
      (title !== undefined &&
        (typeof title !== "string" || title.trim().length === 0))
    ) {
      throw new Error("Expected JSON demo body with a valid file.");
    }

    return {
      role,
      kind,
      file,
      ...(title === undefined ? {} : { title: title.trim() }),
      at,
    };
  }

  if ((kind !== undefined && kind !== "text") || typeof text !== "string") {
    throw new Error("Expected JSON body with agent role, text, and at fields.");
  }

  if (text.trim().length === 0) {
    throw new Error("Agent message text cannot be empty.");
  }

  return { role, text, at };
};

const readRequestBody = async (request: IncomingMessage): Promise<string> => {
  const chunks: string[] = [];

  await new Promise<void>((resolve, reject) => {
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      chunks.push(chunk);
    });
    request.on("end", () => resolve());
    request.on("error", reject);
  });

  return chunks.join("");
};

const sendResponse = async (
  target: ServerResponse,
  response: Response,
): Promise<void> => {
  target.statusCode = response.status;
  response.headers.forEach((value, key) => {
    target.setHeader(key, value);
  });

  target.end(await response.text());
};

export const runDaemon = async (courseDir: string): Promise<void> => {
  const coursePaths = getCoursePaths(courseDir);
  const coursePath = coursePaths.courseDir;

  // Resumed/fetched courses have no runtime dir yet; watchers below need it.
  await mkdir(coursePaths.turnsDir, { recursive: true });

  let manifest = await readCourseManifest(coursePath);
  let glossaryEntries = await readGlossary(coursePath);
  let topicTree = manifest.topics;
  let unassignedDemos = manifest.unassignedDemos;
  let masteryScores = latestMasteryScores(await readMastery(coursePath));
  let demoFileSet = await readDemoFileSet(coursePaths.demosDir);
  let activeFeynmanCheck = await readActiveFeynmanCheck(coursePath);
  const initialTranscript = await readTranscript(coursePath);
  const seenLessonIds = lessonTranscriptIds(initialTranscript);
  let lastRecordedFeynmanCheckIssuedAt =
    latestFeynmanCheckIssuedAt(initialTranscript);

  let status: UiStatus = "agent-working";
  let hasSeenWait = false;
  let waiter: Waiter | undefined;
  let nextWaiterId = 1;

  const serialize = createSerializer();
  const sseHub = createSseHub(
    () => ({ status, hasSeenWait }),
    () => glossaryEntries,
    () => topicTree,
    () => unassignedDemos,
    () => masteryScores,
    () => demoFileSet,
    () => activeFeynmanCheck,
  );

  await backfillLessonTranscripts(
    coursePath,
    coursePaths.lessonsDir,
    seenLessonIds,
    sseHub.broadcastMessage,
  );
  const bootFeynmanResult = await appendNewFeynmanCheckTranscript(
    coursePath,
    activeFeynmanCheck,
    lastRecordedFeynmanCheckIssuedAt,
    sseHub.broadcastMessage,
  );
  lastRecordedFeynmanCheckIssuedAt =
    bootFeynmanResult.lastRecordedIssuedAt;

  const refreshGlossary = async (): Promise<void> => {
    await serialize(async () => {
      glossaryEntries = await readGlossary(coursePath);
      demoFileSet = await readDemoFileSet(coursePaths.demosDir);
      sseHub.broadcastGlossary(glossaryEntries);

      const [transcript, lessons] = await Promise.all([
        readTranscript(coursePath),
        readLessonSnapshot(
          coursePaths.lessonsDir,
          glossaryEntries,
          demoFileSet,
        ),
      ]);

      sseHub.broadcastLesson({ action: "snapshot", snapshot: lessons });
      sseHub.broadcastTranscript(transcript);
    });
  };
  const refreshTopics = async (): Promise<void> => {
    await serialize(async () => {
      manifest = await readCourseManifest(coursePath);
      topicTree = manifest.topics;
      unassignedDemos = manifest.unassignedDemos;
      demoFileSet = await readDemoFileSet(coursePaths.demosDir);
      sseHub.broadcastTopics(topicTree, unassignedDemos);
    });
  };
  const refreshMastery = async (): Promise<void> => {
    await serialize(async () => {
      masteryScores = latestMasteryScores(await readMastery(coursePath));
      sseHub.broadcastMastery(masteryScores);
    });
  };
  const refreshFeynman = async (): Promise<void> => {
    await serialize(async () => {
      activeFeynmanCheck = await readActiveFeynmanCheck(coursePath);
      const result = await appendNewFeynmanCheckTranscript(
        coursePath,
        activeFeynmanCheck,
        lastRecordedFeynmanCheckIssuedAt,
        sseHub.broadcastMessage,
      );
      lastRecordedFeynmanCheckIssuedAt = result.lastRecordedIssuedAt;
      sseHub.broadcastFeynman(activeFeynmanCheck);
    });
  };

  const lessonWatcher = watchLessonDirectory({
    lessonsDir: coursePaths.lessonsDir,
    getGlossary: () => glossaryEntries,
    getDemoFiles: () => demoFileSet,
    emit: async (event) => {
      await serialize(async () => {
        const entries = await appendFirstSeenLessonTranscripts(
          coursePath,
          seenLessonIds,
          event,
        );

        sseHub.broadcastLesson(event);
        for (const entry of entries) {
          sseHub.broadcastMessage(entry);
        }
      });
    },
    onError: (error) => {
      console.error(
        error instanceof Error
          ? `Lesson watcher error: ${error.message}`
          : "Lesson watcher error.",
      );
    },
  });
  const glossaryWatcher = watchGlossaryFile({
    glossaryJson: coursePaths.glossaryJson,
    emit: refreshGlossary,
    onError: (error) => {
      console.error(
        error instanceof Error
          ? `Glossary watcher error: ${error.message}`
          : "Glossary watcher error.",
      );
    },
  });
  const topicWatcher = watchTopicFile({
    courseJson: coursePaths.courseJson,
    emit: refreshTopics,
    onError: (error) => {
      console.error(
        error instanceof Error
          ? `Topic watcher error: ${error.message}`
          : "Topic watcher error.",
      );
    },
  });
  const masteryWatcher = watchMasteryFile({
    masteryJson: coursePaths.masteryJson,
    emit: refreshMastery,
    onError: (error) => {
      console.error(
        error instanceof Error
          ? `Mastery watcher error: ${error.message}`
          : "Mastery watcher error.",
      );
    },
  });
  const feynmanWatcher = watchFeynmanFile({
    activeFeynmanJson: coursePaths.activeFeynmanJson,
    emit: refreshFeynman,
    onError: (error) => {
      console.error(
        error instanceof Error
          ? `Feynman watcher error: ${error.message}`
          : "Feynman watcher error.",
      );
    },
  });

  const setStatus = (nextStatus: UiStatus): void => {
    status = nextStatus;
    sseHub.broadcastStatus();
  };

  const flushPendingTurn = async (): Promise<string | undefined> => {
    const events = await readPendingEvents(coursePath);
    if (events.length === 0) {
      return undefined;
    }

    const turnPath = await writeTurnFile(coursePath, events);
    await writePendingEvents(coursePath, []);
    setStatus("agent-working");

    return turnPath;
  };

  const maybeResolveWaiter = async (): Promise<void> => {
    if (waiter === undefined) {
      return;
    }

    const turnPath = await flushPendingTurn();
    if (turnPath === undefined) {
      return;
    }

    const currentWaiter = waiter;
    waiter = undefined;
    currentWaiter.resolve(turnPath);
  };

  const handleWait = async (
    onAbort: (listener: () => void) => void,
  ): Promise<Response> => {
    const setup = await serialize(async (): Promise<WaitSetup> => {
      hasSeenWait = true;
      setStatus("waiting-for-agent");

      const immediateTurnPath = await flushPendingTurn();
      if (immediateTurnPath !== undefined) {
        return {
          kind: "response",
          response: jsonResponse({ turnPath: immediateTurnPath }),
        };
      }

      if (waiter !== undefined) {
        return {
          kind: "response",
          response: textResponse("Another learn wait is already pending.", 409),
        };
      }

      const waiterId = nextWaiterId;
      nextWaiterId += 1;

      const response = new Promise<Response>((resolveResponse) => {
        waiter = {
          id: waiterId,
          resolve: (turnPath) => {
            resolveResponse(jsonResponse({ turnPath }));
          },
        };
      });

      onAbort(() => {
        if (waiter?.id === waiterId) {
          waiter = undefined;
          setStatus("agent-working");
        }
      });

      return { kind: "wait", response };
    });

    return setup.kind === "response" ? setup.response : await setup.response;
  };

  const handleSubmit = async (bodyText: string): Promise<Response> => {
    let text: string;
    try {
      text = parseSubmitText(bodyText);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Invalid submit request.";
      return textResponse(message, 400);
    }

    await serialize(async () => {
      const at = new Date().toISOString();
      const event: TurnEvent = { type: "message", text };
      const pendingEvents = await readPendingEvents(coursePath);

      await writePendingEvents(coursePath, [...pendingEvents, event]);
      const entry = await appendLearnerTranscript(coursePath, text, at);
      sseHub.broadcastMessage(entry);
      await maybeResolveWaiter();

      if (waiter === undefined) {
        setStatus("agent-working");
      }
    });

    return jsonResponse({ ok: true });
  };

  const handleNav = async (bodyText: string): Promise<Response> => {
    let navRequest: NavRequest;
    try {
      navRequest = parseNavRequest(bodyText);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Invalid nav request.";
      return textResponse(message, 400);
    }

    await serialize(async () => {
      let queuedEvent: TurnEvent;
      if (navRequest.kind === "review-weak") {
        manifest = await readCourseManifest(coursePath);
        topicTree = manifest.topics;
        unassignedDemos = manifest.unassignedDemos;
        masteryScores = latestMasteryScores(await readMastery(coursePath));
        sseHub.broadcastTopics(topicTree, unassignedDemos);
        sseHub.broadcastMastery(masteryScores);
        queuedEvent = {
          type: "review-weak",
          concepts: selectWeakestTopicConcepts(topicTree, masteryScores, 3),
        };
      } else {
        queuedEvent = { type: "nav", path: navRequest.path };
      }
      const pendingEvents = await readPendingEvents(coursePath);

      await writePendingEvents(coursePath, [...pendingEvents, queuedEvent]);
      await maybeResolveWaiter();

      if (waiter === undefined) {
        setStatus("agent-working");
      }
    });

    return jsonResponse({ ok: true });
  };

  const handleFeynmanAnswer = async (bodyText: string): Promise<Response> => {
    let answer: Readonly<{ concept: string; text: string }>;
    try {
      answer = parseFeynmanAnswer(bodyText);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Invalid Feynman answer.";
      return textResponse(message, 400);
    }

    let response: Response = jsonResponse({ ok: true });

    await serialize(async () => {
      const active = await readActiveFeynmanCheck(coursePath);
      activeFeynmanCheck = active;

      if (active === undefined) {
        response = textResponse("No active Feynman check.", 409);
        return;
      }

      if (active.concept !== answer.concept) {
        response = textResponse("Active Feynman check changed.", 409);
        return;
      }

      const event: TurnEvent = {
        type: "feynman-answer",
        concept: active.concept,
        text: answer.text,
        keyPoints: active.keyPoints,
      };
      const pendingEvents = await readPendingEvents(coursePath);
      const at = new Date().toISOString();

      await writePendingEvents(coursePath, [...pendingEvents, event]);
      const checkResult = await appendNewFeynmanCheckTranscript(
        coursePath,
        active,
        lastRecordedFeynmanCheckIssuedAt,
        sseHub.broadcastMessage,
      );
      lastRecordedFeynmanCheckIssuedAt =
        checkResult.lastRecordedIssuedAt;
      await appendFeynmanAnswerTimelineEntry(
        coursePath,
        active.concept,
        answer.text,
        at,
        sseHub.broadcastMessage,
      );
      await clearActiveFeynmanCheck(coursePath);
      activeFeynmanCheck = undefined;
      sseHub.broadcastFeynman(activeFeynmanCheck);
      await maybeResolveWaiter();

      if (waiter === undefined) {
        setStatus("agent-working");
      }
    });

    return response;
  };

  const handleAgentMessage = async (bodyText: string): Promise<Response> => {
    let entry: TranscriptEntry;
    try {
      entry = parseAgentMessage(bodyText);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Invalid agent message.";
      return textResponse(message, 400);
    }

    if (entry.kind === "demo") {
      demoFileSet = await readDemoFileSet(coursePaths.demosDir);
    }

    sseHub.broadcastMessage(entry);
    return jsonResponse({ ok: true });
  };

  const server = createServer((request, response) => {
    void (async () => {
      const method = request.method ?? "GET";
      const requestUrl = new URL(
        request.url ?? "/",
        `http://${LOCALHOST_BIND_HOST}`,
      );

      if (method === "GET" && requestUrl.pathname.startsWith("/demos/")) {
        await sendResponse(
          response,
          (await demoResponse(coursePaths.demosDir, requestUrl.pathname)) ??
            textResponse("Invalid demo path", 400),
        );
        return;
      }

      if (method === "GET" && requestUrl.pathname === "/") {
        manifest = await readCourseManifest(coursePath);
        topicTree = manifest.topics;
        unassignedDemos = manifest.unassignedDemos;
        glossaryEntries = await readGlossary(coursePath);
        masteryScores = latestMasteryScores(await readMastery(coursePath));
        activeFeynmanCheck = await readActiveFeynmanCheck(coursePath);
        demoFileSet = await readDemoFileSet(coursePaths.demosDir);
        const [transcript, lessons] = await Promise.all([
          readTranscript(coursePath),
          readLessonSnapshot(
            coursePaths.lessonsDir,
            glossaryEntries,
            demoFileSet,
          ),
        ]);
        const displayTitle = await readCourseDisplayTitle(
          coursePaths.courseJson,
          manifest.name,
        );
        await sendResponse(
          response,
          new Response(
            renderPage(
              displayTitle,
              transcript,
              lessons,
              glossaryEntries,
              topicTree,
              unassignedDemos,
              masteryScores,
              demoFileSet,
              activeFeynmanCheck,
              status,
              hasSeenWait,
            ),
            {
              headers: { "content-type": "text/html; charset=utf-8" },
            },
          ),
        );
        return;
      }

      if (method === "GET" && requestUrl.pathname === "/api/health") {
        await sendResponse(
          response,
          jsonResponse({
            ok: true,
            coursePath,
            name: manifest.name,
            waitPending: waiter !== undefined,
            hasSeenWait,
          }),
        );
        return;
      }

      if (method === "GET" && requestUrl.pathname === "/api/events") {
        sseHub.connect(request, response);
        return;
      }

      if (method === "GET" && requestUrl.pathname === "/api/wait") {
        await sendResponse(
          response,
          await handleWait((listener) => {
            request.on("close", listener);
          }),
        );
        return;
      }

      if (method === "POST" && requestUrl.pathname === "/api/submit") {
        const bodyText = await readRequestBody(request);
        await sendResponse(response, await handleSubmit(bodyText));
        return;
      }

      if (method === "POST" && requestUrl.pathname === "/api/nav") {
        const bodyText = await readRequestBody(request);
        await sendResponse(response, await handleNav(bodyText));
        return;
      }

      if (method === "POST" && requestUrl.pathname === "/api/feynman-answer") {
        const bodyText = await readRequestBody(request);
        await sendResponse(response, await handleFeynmanAnswer(bodyText));
        return;
      }

      if (method === "POST" && requestUrl.pathname === "/api/agent-message") {
        const bodyText = await readRequestBody(request);
        await sendResponse(response, await handleAgentMessage(bodyText));
        return;
      }

      await sendResponse(response, textResponse("Not found", 404));
    })().catch((error: unknown) => {
      if (response.writableEnded) {
        return;
      }

      const message =
        error instanceof Error ? error.message : "Internal daemon error.";
      void sendResponse(response, textResponse(message, 500));
    });
  });

  // /api/wait long-polls can sit idle indefinitely; Node's default
  // requestTimeout (5 min) would destroy the socket mid-wait.
  server.requestTimeout = 0;

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, LOCALHOST_BIND_HOST, () => resolve());
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Daemon server did not bind a TCP port.");
  }

  const port = address.port;

  await writeDaemonMetadata(coursePath, {
    pid: process.pid,
    port,
    startedAt: new Date().toISOString(),
  });

  const cleanup = async (): Promise<void> => {
    lessonWatcher.close();
    glossaryWatcher.close();
    topicWatcher.close();
    masteryWatcher.close();
    feynmanWatcher.close();
    server.close();
    await clearDaemonMetadata(coursePath);
  };

  process.on("SIGTERM", () => {
    void cleanup().finally(() => process.exit(0));
  });
  process.on("SIGINT", () => {
    void cleanup().finally(() => process.exit(0));
  });

  await new Promise<never>(() => undefined);
};

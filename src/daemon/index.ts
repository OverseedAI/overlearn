import { randomBytes } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { dirname, join } from "node:path";
import { spawn as spawnChildProcess } from "node:child_process";

import packageJson from "../../package.json";
import {
  getHarnessAdapterDefinition,
  listHarnessAdapters,
  type HarnessCommand,
} from "../adapter/registry";
import type { AdapterDetection, HarnessAdapterId } from "../adapter/types";
import {
  appendTranscriptEntry,
  appendTurnEvents,
  clearActiveFeynmanCheck,
  consumePendingTopicNavigation,
  createCourse,
  demoFileKey,
  enterFrontierTopic,
  endSession as endStoreSession,
  flattenTopicTree,
  getActiveFeynmanCheck,
  getCourse,
  getTopicByPath,
  getProfile,
  getStoreDataDir,
  listCourses,
  listDemos,
  listGlossary,
  listLatestMasteryScores,
  listJournalEntries,
  openStore,
  pageTranscript,
  pageTranscriptBefore,
  patchProfile,
  patchCourse,
  readTopicTree,
  selectVisitedTopic,
  skipActiveFeynmanCheck,
  startSession,
  updateLatestActiveTranscriptCardState,
  withStoreTransaction,
  type Course,
  type CourseStatus as StoreCourseStatus,
  type Demo,
  type FeynmanCheck,
  type GlossaryEntry as StoreGlossaryEntry,
  type MasteryEvent,
  type Profile,
  type Store,
  type Topic,
  type PendingTopicNavigation,
  type PendingCardSkippedEvent,
  type TopicNavigationResult,
  type TopicNavigationTopic,
  type TopicJournalEntry as StoreTopicJournalEntry,
  type TranscriptCardStateChange,
  type TranscriptEntry as StoreTranscriptEntry,
} from "../store";
import {
  exportCourseBundle,
  importCoursePath,
  type ExportCourseBundleOptions,
} from "../store/bundle";
import {
  createTeachingMcpHttpHandler,
  teachingTokenFromRequestPath,
  type ActiveTeachingTurn,
  type TeachingWriteEvent,
} from "../mcp/teaching";
import { renderMarkdown } from "./markdown";
import {
  createDaemonTurnOrchestrator,
  type ActiveTeachingSessionRegistration,
  type AgentStreamPayload,
  type DaemonTurnOrchestrator,
  type TurnEvent,
  type TurnPayload,
  type TurnPromptMode,
  type TurnPositionContext,
  type TurnPositionTopic,
} from "./orchestrator";
import { splitLeadingLeakedThinking } from "./reasoning";
import { createTutorialCourse } from "./tutorial";

export type DaemonEndpoint = Readonly<{
  host: string;
  port: number;
}>;

export type CourseStatus = Readonly<{
  daemonAlive: boolean;
  waitPending: false;
  courseDir: null;
  liveSessions: readonly LiveSessionSummary[];
}>;

export const REVIEW_WEAK_NAV_PATH = "overlearn:review-weak";

type Env = Readonly<Record<string, string | undefined>>;

type DaemonMetadata = Readonly<{
  pid: number;
  port: number;
  token: string;
  startedAt: string;
}>;

export type RunDaemonOptions = Readonly<{
  portFile?: string;
  harnessLoginSpawner?: (input: HarnessLoginSpawnInput) => void;
}>;

type UiStatus =
  | "waiting-for-agent"
  | "agent-working"
  | "agent-failed"
  | "wrapping-up"
  | "session-ended";

type UiStatusPayload = Readonly<{
  courseId: number;
  status: UiStatus;
  hasSeenWait: boolean;
  message?: string;
}>;

type DemoEntry = Readonly<{
  file: string;
  title?: string;
  addedAt: string;
}>;

type JournalDemoRef = Readonly<{
  id: number;
  file: string;
  title: string | null;
  fileName: string | null;
}>;

type JournalEntry = Readonly<{
  id: number;
  kind: StoreTopicJournalEntry["kind"];
  topicId: number;
  bodyMarkdown?: string;
  demoId?: number | null;
  demo?: JournalDemoRef | null;
  turn: number | null;
  createdAt: string;
}>;

type JournalSnapshot = Readonly<{
  entries: readonly JournalEntry[];
  totalCount: number;
  limit: number | null;
}>;

type GlossaryEntry = Readonly<{
  term: string;
  def: string;
  topicId: number | null;
  addedAt: string;
}>;

type MasteryEntry = Readonly<{
  concept: string;
  score: number;
  gaps?: string;
  at: string;
}>;

type TopicNode = Readonly<{
  id: number;
  path: string;
  title: string;
  body?: string;
  enteredAt?: string;
  current: boolean;
  state: Topic["state"];
  demos?: readonly DemoEntry[];
  journal: JournalSnapshot;
  children: readonly TopicNode[];
}>;

type ActiveFeynmanCheck = Readonly<{
  concept: string;
  prompt: string;
  keyPoints: readonly string[];
  issuedAt: string;
  replaced?: Readonly<{
    concept: string;
    issuedAt: string;
    replacedAt: string;
  }>;
}>;

type TopicProposalCardTopic = Readonly<{
  path: string;
  title: string;
  blurb: string;
}>;

type TranscriptEntryBase = Readonly<{
  id: number;
  topicId: number | null;
  at: string;
  turn?: number;
}>;

type TranscriptEntry = TranscriptEntryBase &
  (
    | Readonly<{
      role: "learner" | "agent";
      text: string;
      kind?: "text";
    }>
    | Readonly<{
      role: "agent";
      kind: "thinking";
      text: string;
    }>
    | Readonly<{
      role: "agent";
      kind: "demo";
      file: string;
      title?: string;
    }>
    | Readonly<{
      role: "agent";
      kind: "journal-note";
      markdown: string;
    }>
    | Readonly<{
      role: "agent";
      kind: "feynman-check";
      cardId: string;
      state: "active" | "acted" | "skipped";
      concept: string;
      prompt: string;
      keyPoints: readonly string[];
    }>
    | Readonly<{
      role: "agent";
      kind: "topic-proposals";
      cardId: string;
      state: "active" | "acted" | "skipped";
      topics: readonly TopicProposalCardTopic[];
    }>
    | Readonly<{
      role: "learner";
      kind: "feynman-answer";
      concept: string;
      text: string;
    }>
    | Readonly<{
      role: "system";
      kind: "tool-call";
      text: string;
      tool: string;
    }>
    | Readonly<{
      role: "system";
      kind: "topic-change";
      text: string;
    }>
  );

type HarnessSummary = Readonly<{
  id: string;
  name: string;
  installed: boolean;
  authenticated: boolean;
  version?: string;
  selected: boolean;
  login: Readonly<{
    command: string;
    manual: boolean;
    note: string;
  }>;
  install: Readonly<{
    command: string;
    docsUrl: string;
  }>;
}>;

type HarnessesPayload = Readonly<{
  courseId?: number;
  scope?: "profile";
  harnesses: readonly HarnessSummary[];
  switched: boolean;
}>;

type LiveSessionSummary = Readonly<{
  courseId: number;
  harnessId: string;
  state: "turn-running" | "idle";
}>;

type SessionSummary = LiveSessionSummary &
  Readonly<{
    courseTitle: string;
    lastActivityAt: string;
    startedAt: string;
  }>;

type OnboardingState = "welcome" | "connect-agent" | "tutorial-offer" | "done";

type ProfileResource = Readonly<{
  name: string | null;
  onboardingState: OnboardingState;
  settings: Record<string, unknown>;
  preferredHarness: string | null;
  dataDir: string;
  createdAt: string;
  updatedAt: string;
}>;

type HarnessLoginSpawnInput = Readonly<{
  harnessId: string;
  command: string;
  args: readonly string[];
  displayCommand: string;
  cwd: string;
  env: Record<string, string>;
}>;

type CourseRuntime = {
  courseId: number;
  harnessId: string;
  orchestrator: DaemonTurnOrchestrator;
  runningTurn: boolean;
  lastActivityAt: number;
  startedAt: number;
};

type TokenScope = Readonly<{
  courseId: number;
  sessionId?: number;
}>;

type MessageTurnEvent = Extract<TurnEvent, { type: "message" }>;
type TopicEnteredTurnEvent = Extract<TurnEvent, { type: "topic-entered" }>;
type FeynmanAnswerTurnEvent = Extract<TurnEvent, { type: "feynman-answer" }>;
type CardSkippedTurnEvent = Extract<TurnEvent, { type: "card-skipped" }>;

type NavRequest = Readonly<{
  path: string;
  cardId?: string;
}>;

type CourseCreateInput = {
  title: string;
  description?: string | null;
  harnessId?: string | null;
  attachedDir?: string | null;
  sourceName?: string | null;
  status?: StoreCourseStatus;
};

type CoursePatchInput = {
  title?: string;
  description?: string | null;
  harnessId?: string | null;
  attachedDir?: string | null;
  sourceName?: string | null;
  status?: StoreCourseStatus;
};

type ProfilePatchInput = {
  name?: string | null;
  onboardingState?: string;
  settings?: Record<string, unknown>;
  preferredHarness?: string | null;
};

const LOCALHOST_BIND_HOST = "127.0.0.1";
const DEFAULT_HARNESS_ID = "claude-code";
const MAX_AGENT_STREAM_REPLAY = 200;
const DEFAULT_SESSION_IDLE_TTL_MS = 30 * 60 * 1_000;
const DEFAULT_SESSION_IDLE_SWEEP_INTERVAL_MS = 60 * 1_000;
const onboardingStates: readonly OnboardingState[] = [
  "welcome",
  "connect-agent",
  "tutorial-offer",
  "done",
];
const legalOnboardingTransitions: Readonly<
  Record<OnboardingState, readonly OnboardingState[]>
> = {
  welcome: ["welcome", "connect-agent"],
  "connect-agent": ["connect-agent", "tutorial-offer"],
  "tutorial-offer": ["tutorial-offer", "done"],
  done: ["done", "welcome"],
};

const parsePositiveInteger = (
  value: string | undefined,
  name: string,
): number | undefined => {
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }

  return parsed;
};

const parseOptionalPositiveIntegerParam = (
  params: URLSearchParams,
  name: string,
): number | undefined => {
  const value = params.get(name);
  if (value === null || value.length === 0) {
    return undefined;
  }

  return parsePositiveInteger(value, name);
};

export const resolveSessionIdleTtlMs = (env: Env = process.env): number =>
  parsePositiveInteger(
    env["OVERLEARN_SESSION_IDLE_TTL_MS"],
    "OVERLEARN_SESSION_IDLE_TTL_MS",
  ) ?? DEFAULT_SESSION_IDLE_TTL_MS;

const resolveSessionIdleSweepIntervalMs = (env: Env = process.env): number =>
  parsePositiveInteger(
    env["OVERLEARN_SESSION_IDLE_SWEEP_INTERVAL_MS"],
    "OVERLEARN_SESSION_IDLE_SWEEP_INTERVAL_MS",
  ) ?? DEFAULT_SESSION_IDLE_SWEEP_INTERVAL_MS;

const jsonResponse = (value: unknown, init?: ResponseInit): Response =>
  new Response(JSON.stringify(value), {
    ...init,
    headers: {
      "content-type": "application/json",
      ...init?.headers,
    },
  });

const textResponse = (text: string, status: number): Response =>
  new Response(text, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
    },
  });

const emptyResponse = (status = 204): Response => new Response(null, { status });

const CORS_BASE_ALLOWED_ORIGINS = [
  "tauri://localhost",
  "http://tauri.localhost",
] as const;
const CORS_ALLOWED_METHODS = "GET, POST, PATCH, DELETE, OPTIONS";
const CORS_ALLOWED_HEADERS = "Authorization, Content-Type";

const parseDevCorsOrigins = (value: string | undefined): readonly string[] =>
  value === undefined
    ? []
    : value
        .split(",")
        .map((origin) => origin.trim())
        .filter((origin) => origin.length > 0);

const corsAllowedOrigins = (env: Env): ReadonlySet<string> =>
  new Set([
    ...CORS_BASE_ALLOWED_ORIGINS,
    ...parseDevCorsOrigins(env["OVERLEARN_DEV_ORIGINS"]),
  ]);

const addVaryOrigin = (headers: Headers): void => {
  const vary = headers.get("vary");
  if (vary === null || vary.trim().length === 0) {
    headers.set("vary", "Origin");
    return;
  }

  const parts = vary.split(",").map((part) => part.trim().toLowerCase());
  if (!parts.includes("*") && !parts.includes("origin")) {
    headers.set("vary", `${vary}, Origin`);
  }
};

const addCorsHeaders = (
  headers: Headers,
  requestHeaders: Headers,
  allowedOrigins: ReadonlySet<string>,
  preflight = false,
): void => {
  const origin = requestHeaders.get("origin");
  if (origin === null) {
    return;
  }

  addVaryOrigin(headers);
  if (!allowedOrigins.has(origin)) {
    return;
  }

  headers.set("access-control-allow-origin", origin);
  headers.set("access-control-allow-credentials", "true");
  if (preflight) {
    headers.set("access-control-allow-methods", CORS_ALLOWED_METHODS);
    headers.set("access-control-allow-headers", CORS_ALLOWED_HEADERS);
  }
};

const corsHeaderRecord = (
  requestHeaders: Headers,
  allowedOrigins: ReadonlySet<string>,
  preflight = false,
): Record<string, string> => {
  const headers = new Headers();
  addCorsHeaders(headers, requestHeaders, allowedOrigins, preflight);
  return Object.fromEntries(headers.entries());
};

const responseWithCorsHeaders = (
  request: Request,
  response: Response,
  allowedOrigins: ReadonlySet<string>,
): Response => {
  const headers = new Headers(response.headers);
  addCorsHeaders(headers, request.headers, allowedOrigins);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};

const isCorsPreflight = (request: Request): boolean =>
  request.method === "OPTIONS" &&
  request.headers.has("origin") &&
  request.headers.has("access-control-request-method");

const corsPreflightResponse = (
  request: Request,
  allowedOrigins: ReadonlySet<string>,
): Response =>
  new Response(null, {
    status: 204,
    headers: corsHeaderRecord(request.headers, allowedOrigins, true),
  });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasErrorCode = (error: unknown, code: string): boolean =>
  isRecord(error) && error["code"] === code;

const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const formatCommand = (command: HarnessCommand): string =>
  [command.command, ...command.args].join(" ");

const formatDaemonUrl = (port: number, path: string): string =>
  `http://${LOCALHOST_BIND_HOST}:${port}${path}`;

const isOnboardingState = (value: unknown): value is OnboardingState =>
  typeof value === "string" &&
  onboardingStates.includes(value as OnboardingState);

const normalizeOnboardingState = (value: string): OnboardingState =>
  isOnboardingState(value) ? value : "welcome";

export const isLegalOnboardingTransition = (
  current: string,
  next: string,
): boolean => {
  const normalizedCurrent = normalizeOnboardingState(current);
  if (!isOnboardingState(next)) {
    return false;
  }

  return legalOnboardingTransitions[normalizedCurrent].includes(next);
};

const profileResource = (profile: Profile, dataDir: string): ProfileResource => ({
  name: profile.name,
  onboardingState: normalizeOnboardingState(profile.onboardingState),
  settings: { ...profile.settings },
  preferredHarness: profile.preferredHarness,
  dataDir,
  createdAt: profile.createdAt,
  updatedAt: profile.updatedAt,
});

export const daemonMetadataPath = (env: Env = process.env): string =>
  join(getStoreDataDir(env), "daemon.json");

export const readDaemonMetadata = async (
  env: Env = process.env,
): Promise<DaemonMetadata | undefined> => {
  try {
    const parsed = JSON.parse(await Bun.file(daemonMetadataPath(env)).text()) as unknown;
    if (
      !isRecord(parsed) ||
      typeof parsed["pid"] !== "number" ||
      typeof parsed["port"] !== "number" ||
      typeof parsed["token"] !== "string" ||
      typeof parsed["startedAt"] !== "string"
    ) {
      return undefined;
    }

    return {
      pid: parsed["pid"],
      port: parsed["port"],
      token: parsed["token"],
      startedAt: parsed["startedAt"],
    };
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return undefined;
    }

    return undefined;
  }
};

const writeDaemonMetadata = async (
  metadata: DaemonMetadata,
  env: Env = process.env,
): Promise<void> => {
  const path = daemonMetadataPath(env);
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, `${JSON.stringify(metadata, null, 2)}\n`);
};

const clearDaemonMetadata = async (env: Env = process.env): Promise<void> => {
  await rm(daemonMetadataPath(env), { force: true });
};

type IdleSessionRuntime = {
  courseId: number;
  runningTurn: boolean;
  lastActivityAt: number;
  orchestrator: Pick<DaemonTurnOrchestrator, "resetSession">;
};

export const expireIdleSessions = async <Runtime extends IdleSessionRuntime>(
  input: Readonly<{
    runtimes: Map<number, Runtime>;
    idleTtlMs: number;
    now: () => number;
    onExpired?: () => void;
  }>,
): Promise<number> => {
  const now = input.now();
  let expiredCount = 0;

  for (const runtime of [...input.runtimes.values()]) {
    if (
      runtime.runningTurn ||
      now - runtime.lastActivityAt <= input.idleTtlMs ||
      input.runtimes.get(runtime.courseId) !== runtime
    ) {
      continue;
    }

    input.runtimes.delete(runtime.courseId);
    await runtime.orchestrator.resetSession("idle-ttl");
    expiredCount += 1;
  }

  if (expiredCount > 0) {
    input.onExpired?.();
  }

  return expiredCount;
};

type TimerWithUnref = Readonly<{ unref: () => void }>;

const unrefTimer = (timer: ReturnType<typeof setInterval>): void => {
  if (typeof timer !== "object" || timer === null || !("unref" in timer)) {
    return;
  }

  const unref = (timer as TimerWithUnref).unref;
  if (typeof unref === "function") {
    unref();
  }
};

const createSseHub = (
  getStatusPayloads: () => readonly UiStatusPayload[],
  getHarnesses: (courseId?: number) => HarnessesPayload,
  getCourses: () => unknown,
  getSessions: () => unknown,
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

  const broadcast = (event: string, value: unknown): void => {
    for (const subscriber of subscribers) {
      writeEvent(subscriber, event, value);
    }
  };

  const connect = (
    _request: IncomingMessage,
    response: ServerResponse,
    headers: Record<string, string> = {},
  ): void => {
    response.writeHead(200, {
      "cache-control": "no-cache",
      connection: "keep-alive",
      "content-type": "text/event-stream",
      ...headers,
    });
    subscribers.add(response);

    for (const status of getStatusPayloads()) {
      writeEvent(response, "status", status);
    }
    writeEvent(response, "courses", getCourses());
    writeEvent(response, "harnesses", getHarnesses());
    writeEvent(response, "sessions", getSessions());

    response.on("close", () => {
      subscribers.delete(response);
    });
  };

  const closeAll = (): void => {
    for (const subscriber of subscribers) {
      subscriber.end();
    }
    subscribers.clear();
  };

  return { broadcast, closeAll, connect };
};

const readRequestBody = async (request: IncomingMessage): Promise<Uint8Array> => {
  const chunks: Uint8Array[] = [];

  for await (const chunk of request) {
    chunks.push(chunk instanceof Uint8Array ? chunk : Buffer.from(chunk));
  }

  const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const body = new Uint8Array(length);
  let offset = 0;

  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return body;
};

const headersFromIncoming = (
  request: IncomingMessage,
): Headers => {
  const headers = new Headers();

  for (const [key, value] of Object.entries(request.headers)) {
    if (value === undefined) {
      continue;
    }

    if (Array.isArray(value)) {
      headers.set(key, value.join(", "));
    } else {
      headers.set(key, value);
    }
  }

  return headers;
};

const webRequestFromIncoming = async (
  request: IncomingMessage,
  port: number,
): Promise<Request> => {
  const method = request.method ?? "GET";
  const url = `http://${LOCALHOST_BIND_HOST}:${port}${request.url ?? "/"}`;
  const body =
    method === "GET" || method === "HEAD"
      ? undefined
      : await readRequestBody(request);

  return new Request(url, {
    method,
    headers: headersFromIncoming(request),
    ...(body === undefined ? {} : { body }),
  });
};

const writeWebResponse = async (
  target: ServerResponse,
  response: Response,
): Promise<void> => {
  target.writeHead(
    response.status,
    Object.fromEntries(response.headers.entries()),
  );

  if (response.body === null) {
    target.end();
    return;
  }

  const reader = response.body.getReader();
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) {
      target.end();
      return;
    }

    if (!target.write(Buffer.from(chunk.value))) {
      await new Promise<void>((resolveDrain) => {
        target.once("drain", () => resolveDrain());
      });
    }
  }
};

const bearerToken = (headers: Headers): string | undefined => {
  const authorization = headers.get("authorization");
  if (authorization === null) {
    return undefined;
  }

  const [scheme, token, extra] = authorization.split(/\s+/);
  if (scheme?.toLowerCase() !== "bearer" || token === undefined || extra !== undefined) {
    return undefined;
  }

  return token;
};

const requestHasDaemonToken = (request: Request, daemonToken: string): boolean =>
  bearerToken(request.headers) === daemonToken;

const isDemoFileApiRequest = (requestUrl: URL, method: string): boolean => {
  if (method !== "GET") {
    return false;
  }

  const segments = requestUrl.pathname.split("/").filter((segment) => segment.length > 0);
  if (
    segments.length !== 5 ||
    segments[0] !== "api" ||
    segments[1] !== "courses" ||
    segments[3] !== "demos"
  ) {
    return false;
  }

  const courseId = Number(segments[2]);
  return Number.isInteger(courseId) && courseId > 0 && (segments[4]?.length ?? 0) > 0;
};

const requestHasDemoQueryToken = (
  requestUrl: URL,
  method: string,
  daemonToken: string,
): boolean =>
  isDemoFileApiRequest(requestUrl, method) &&
  requestUrl.searchParams.get("token") === daemonToken;

const incomingHasDaemonToken = (
  request: IncomingMessage,
  daemonToken: string,
): boolean => {
  const headers = headersFromIncoming(request);
  return bearerToken(headers) === daemonToken;
};

const unauthorizedResponse = (): Response =>
  textResponse("Overlearn daemon authentication is required.", 401);

const readJsonBody = async (request: Request): Promise<unknown> => {
  const text = await request.text();
  if (text.trim().length === 0) {
    return {};
  }

  return JSON.parse(text) as unknown;
};

const optionalStringField = (
  record: Record<string, unknown>,
  key: string,
): string | null | undefined => {
  if (!Object.hasOwn(record, key)) {
    return undefined;
  }

  const value = record[key];
  if (value === null) {
    return null;
  }

  if (typeof value !== "string") {
    throw new Error(`${key} must be a string or null.`);
  }

  return value;
};

const optionalRecordField = (
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined => {
  if (!Object.hasOwn(record, key)) {
    return undefined;
  }

  const value = record[key];
  if (!isRecord(value)) {
    throw new Error(`${key} must be an object.`);
  }

  return value;
};

const optionalBooleanField = (
  record: Record<string, unknown>,
  key: string,
): boolean | undefined => {
  if (!Object.hasOwn(record, key)) {
    return undefined;
  }

  const value = record[key];
  if (typeof value !== "boolean") {
    throw new Error(`${key} must be a boolean.`);
  }

  return value;
};

const requiredStringField = (
  record: Record<string, unknown>,
  key: string,
): string => {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${key} is required.`);
  }

  return value;
};

const parseCommandOverride = (value: string, name: string): readonly string[] => {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`${name} cannot be empty.`);
  }

  if (trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed) as unknown;
    if (
      !Array.isArray(parsed) ||
      parsed.length === 0 ||
      !parsed.every((entry) => typeof entry === "string" && entry.length > 0)
    ) {
      throw new Error(`${name} JSON must be a non-empty string array.`);
    }

    return parsed;
  }

  const parts = trimmed.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  const tokens = parts.map((part) =>
    part.replace(/^(['"])([\s\S]*)\1$/, "$2"),
  );
  if (tokens.length === 0) {
    throw new Error(`${name} cannot be empty.`);
  }

  return tokens;
};

const defaultHarnessLoginSpawner = (input: HarnessLoginSpawnInput): void => {
  const child = spawnChildProcess(input.command, [...input.args], {
    cwd: input.cwd,
    detached: true,
    env: input.env,
    stdio: "ignore",
  });
  child.unref();
};

const mergeStringEnv = (...envs: readonly Env[]): Record<string, string> => {
  const merged: Record<string, string> = {};

  for (const source of envs) {
    for (const [key, value] of Object.entries(source)) {
      if (value === undefined) {
        delete merged[key];
      } else {
        merged[key] = value;
      }
    }
  }

  return merged;
};

const parseCourseStatus = (value: string | null): StoreCourseStatus | undefined => {
  if (value === null) {
    return undefined;
  }

  if (value === "active" || value === "archived") {
    return value;
  }

  throw new Error("status must be active or archived.");
};

const courseResource = (course: Course): Record<string, unknown> => ({
  id: course.id,
  title: course.title,
  description: course.description,
  harnessId: course.harnessId,
  attachedDir: course.attachedDir,
  status: course.status,
  sourceName: course.sourceName,
  manifestExtra: course.manifestExtra,
  createdAt: course.createdAt,
  updatedAt: course.updatedAt,
});


const uiDemo = (demo: Demo): DemoEntry => ({
  file: demoFileKey(demo),
  ...(demo.title === null ? {} : { title: demo.title }),
  addedAt: demo.addedAt,
});

const journalEntriesPerTopicLimit = 5;

const uiJournalEntry = (
  entry: StoreTopicJournalEntry,
  demosById: ReadonlyMap<number, Demo>,
): JournalEntry => {
  if (entry.kind === "demo") {
    const demo = entry.demoId === null ? undefined : demosById.get(entry.demoId);

    return {
      id: entry.id,
      kind: entry.kind,
      topicId: entry.topicId,
      demoId: entry.demoId,
      demo:
        demo === undefined
          ? null
          : {
              id: demo.id,
              file: demoFileKey(demo),
              title: demo.title,
              fileName: demo.fileName,
            },
      turn: entry.turn,
      createdAt: entry.createdAt,
    };
  }

  return {
    id: entry.id,
    kind: entry.kind,
    topicId: entry.topicId,
    bodyMarkdown: entry.bodyMarkdown ?? "",
    turn: entry.turn,
    createdAt: entry.createdAt,
  };
};

const uiJournalSnapshot = (
  store: Store,
  courseId: number,
  topic: Topic,
  demosById: ReadonlyMap<number, Demo>,
): JournalSnapshot => {
  const entries = listJournalEntries(store, courseId, topic.id);
  const visibleEntries = topic.isCurrent
    ? entries
    : entries.slice(-journalEntriesPerTopicLimit);

  return {
    entries: visibleEntries.map((entry) => uiJournalEntry(entry, demosById)),
    totalCount: entries.length,
    limit: topic.isCurrent ? null : journalEntriesPerTopicLimit,
  };
};

const uiGlossaryEntry = (entry: StoreGlossaryEntry): GlossaryEntry => ({
  term: entry.term,
  def: entry.definition,
  topicId: entry.topicId,
  addedAt: entry.addedAt,
});

const uiMasteryEntry = (entry: MasteryEvent): MasteryEntry => ({
  concept: entry.concept,
  score: entry.score,
  ...(entry.gaps === null ? {} : { gaps: entry.gaps }),
  at: entry.ts,
});

const demosByTopicId = (
  demos: readonly Demo[],
): ReadonlyMap<number | null, readonly DemoEntry[]> => {
  const grouped = new Map<number | null, DemoEntry[]>();

  for (const demo of demos) {
    const existing = grouped.get(demo.topicId) ?? [];
    existing.push(uiDemo(demo));
    grouped.set(demo.topicId, existing);
  }

  return grouped;
};

const uiTopic = (
  store: Store,
  courseId: number,
  topic: Topic,
  groupedDemos: ReadonlyMap<number | null, readonly DemoEntry[]>,
  demosById: ReadonlyMap<number, Demo>,
): TopicNode => ({
  id: topic.id,
  path: topic.path,
  title: topic.title,
  ...(topic.body.length === 0 ? {} : { body: topic.body }),
  ...(topic.enteredAt === null ? {} : { enteredAt: topic.enteredAt }),
  current: topic.isCurrent,
  state: topic.state,
  demos: groupedDemos.get(topic.id) ?? [],
  journal: uiJournalSnapshot(store, courseId, topic, demosById),
  children: topic.children.map((child) =>
    uiTopic(store, courseId, child, groupedDemos, demosById),
  ),
});

const activeFeynman = (check: FeynmanCheck | null): ActiveFeynmanCheck | undefined =>
  check === null
    ? undefined
    : {
        concept: check.concept,
        prompt: check.prompt,
        keyPoints: check.keyPoints,
        issuedAt: check.issuedAt,
        ...(check.replacedConcept === null ||
        check.replacedIssuedAt === null ||
        check.replacedAt === null
          ? {}
          : {
              replaced: {
                concept: check.replacedConcept,
                issuedAt: check.replacedIssuedAt,
                replacedAt: check.replacedAt,
              },
            }),
      };

const transcriptPayloadRecord = (
  entry: StoreTranscriptEntry,
): Record<string, unknown> =>
  isRecord(entry.payload) ? entry.payload : {};

const topicProposalCardTopics = (
  value: unknown,
): readonly TopicProposalCardTopic[] =>
  Array.isArray(value)
    ? value.flatMap((entry) => {
        if (!isRecord(entry)) {
          return [];
        }

        const path = entry["path"];
        const title = entry["title"];
        const blurb = entry["blurb"];
        return typeof path === "string" &&
          typeof title === "string" &&
          typeof blurb === "string"
          ? [{ path, title, blurb }]
          : [];
      })
    : [];

const topicProposalCardState = (value: unknown): "active" | "acted" | "skipped" =>
  value === "acted" || value === "skipped" ? value : "active";

const feynmanCardState = (value: unknown): "active" | "acted" | "skipped" =>
  value === "active" || value === "skipped" ? value : "acted";

const feynmanKeyPoints = (value: unknown): readonly string[] =>
  Array.isArray(value)
    ? value.flatMap((entry) => (typeof entry === "string" ? [entry] : []))
    : [];

const transcriptEntryBase = (entry: StoreTranscriptEntry) => ({
  id: entry.id,
  topicId: entry.topicId,
  at: entry.ts,
  turn: entry.turn,
});

const uiTranscriptEntry = (entry: StoreTranscriptEntry): TranscriptEntry => {
  const payload = transcriptPayloadRecord(entry);
  const base = transcriptEntryBase(entry);

  if (entry.kind === "demo") {
    const title = payload["title"];
    return {
      ...base,
      role: "agent",
      kind: "demo",
      file:
        typeof payload["file"] === "string" && payload["file"].length > 0
          ? payload["file"]
          : entry.content,
      ...(typeof title === "string" && title.length > 0 ? { title } : {}),
    };
  }

  if (entry.kind === "thinking") {
    return {
      ...base,
      role: "agent",
      kind: "thinking",
      text: entry.content,
    };
  }

  if (entry.kind === "journal-note") {
    const markdown = payload["markdown"];
    return {
      ...base,
      role: "agent",
      kind: "journal-note",
      markdown:
        typeof markdown === "string" && markdown.length > 0
          ? markdown
          : entry.content,
    };
  }

  if (entry.kind === "feynman-check") {
    const cardId = payload["cardId"];
    return {
      ...base,
      role: "agent",
      kind: "feynman-check",
      cardId:
        typeof cardId === "string" && cardId.length > 0
          ? cardId
          : `feynman-${entry.id}`,
      state: feynmanCardState(payload["state"]),
      concept:
        typeof payload["concept"] === "string" ? payload["concept"] : "unknown",
      prompt: entry.content,
      keyPoints: feynmanKeyPoints(payload["keyPoints"]),
    };
  }

  if (entry.kind === "topic-proposals") {
    const cardId = payload["cardId"];
    return {
      ...base,
      role: "agent",
      kind: "topic-proposals",
      cardId:
        typeof cardId === "string" && cardId.length > 0
          ? cardId
          : `topic-proposals-${entry.id}`,
      state: topicProposalCardState(payload["state"]),
      topics: topicProposalCardTopics(payload["topics"]),
    };
  }

  if (entry.kind === "feynman-answer") {
    return {
      ...base,
      role: "learner",
      kind: "feynman-answer",
      concept:
        typeof payload["concept"] === "string" ? payload["concept"] : "unknown",
      text: entry.content,
    };
  }

  if (entry.kind === "tool-call") {
    return {
      ...base,
      role: "system",
      kind: "tool-call",
      text: entry.content,
      tool: typeof payload["tool"] === "string" ? payload["tool"] : "tool",
    };
  }

  if (entry.kind === "topic-change") {
    return {
      ...base,
      role: "system",
      kind: "topic-change",
      text: entry.content,
    };
  }

  return {
    ...base,
    role: entry.role === "agent" ? "agent" : "learner",
    text: entry.content,
  };
};

const readTranscriptTail = (
  store: Store,
  courseId: number,
): readonly TranscriptEntry[] => {
  let afterId: number | undefined;
  let tail: readonly StoreTranscriptEntry[] = [];

  while (true) {
    const page = pageTranscript(store, courseId, {
      ...(afterId === undefined ? {} : { afterId }),
      limit: 200,
    });
    tail = [...tail, ...page.entries].slice(-200);

    if (page.nextAfterId === null) {
      break;
    }

    afterId = page.nextAfterId;
  }

  return tail.map(uiTranscriptEntry);
};

const readTranscriptBefore = (
  store: Store,
  courseId: number,
  options: Readonly<{ beforeId?: number; limit?: number }>,
) => {
  const page = pageTranscriptBefore(store, courseId, options);

  return {
    entries: page.entries.map(uiTranscriptEntry),
    hasMore: page.hasMore,
    nextBeforeId: page.nextBeforeId,
  };
};

const courseView = (store: Store, courseId: number) => {
  const course = getCourse(store, courseId);
  if (course === undefined) {
    return undefined;
  }

  const demos = listDemos(store, courseId);
  const groupedDemos = demosByTopicId(demos);
  const demosById = new Map(demos.map((demo) => [demo.id, demo]));
  const glossary = listGlossary(store, courseId).map(uiGlossaryEntry);

  return {
    course,
    transcript: readTranscriptTail(store, courseId),
    glossary,
    topics: readTopicTree(store, courseId).map((topic) =>
      uiTopic(store, courseId, topic, groupedDemos, demosById),
    ),
    unassignedDemos: groupedDemos.get(null) ?? [],
    masteryScores: listLatestMasteryScores(store, courseId).map(uiMasteryEntry),
    activeFeynmanCheck: activeFeynman(getActiveFeynmanCheck(store, courseId)),
  };
};

const courseState = (store: Store, courseId: number): Record<string, unknown> | undefined => {
  const view = courseView(store, courseId);
  if (view === undefined) {
    return undefined;
  }

  return {
    course: courseResource(view.course),
    topics: view.topics,
    glossary: view.glossary,
    mastery: view.masteryScores,
    demos: listDemos(store, courseId).map((demo) => ({
      id: demo.id,
      topicId: demo.topicId,
      fileName: demo.fileName,
      key: demoFileKey(demo),
      title: demo.title,
      bodyFormat: demo.bodyFormat,
      addedAt: demo.addedAt,
    })),
    activeFeynmanCheck: view.activeFeynmanCheck ?? null,
    transcript: view.transcript,
  };
};

const selectedHarnessId = (
  store: Store,
  courseId: number | undefined,
  env: Env,
): string => {
  if (courseId !== undefined) {
    const course = getCourse(store, courseId);
    if (course?.harnessId !== null && course?.harnessId !== undefined) {
      return course.harnessId;
    }
  }

  const profile = getProfile(store);
  return (
    profile.preferredHarness ?? env["OVERLEARN_HARNESS"] ?? DEFAULT_HARNESS_ID
  );
};

const detectHarnesses = (): Map<string, AdapterDetection> => {
  const detections = new Map<string, AdapterDetection>();

  for (const adapter of listHarnessAdapters()) {
    detections.set(adapter.id, adapter.detect());
  }

  return detections;
};

const harnessSummaries = (
  store: Store,
  courseId: number | undefined,
  env: Env,
  cache: { value?: Map<string, AdapterDetection> },
  refresh = false,
): readonly HarnessSummary[] => {
  if (cache.value === undefined || refresh) {
    cache.value = detectHarnesses();
  }

  const selected = selectedHarnessId(store, courseId, env);

  return listHarnessAdapters().map((adapter) => {
    const definition = getHarnessAdapterDefinition(adapter.id);
    const detection = cache.value?.get(adapter.id) ?? {
      installed: false,
      authenticated: false,
    };
    if (definition === undefined) {
      throw new Error(`Missing harness adapter definition: ${adapter.id}`);
    }

    return {
      id: adapter.id,
      name: adapter.name,
      installed: detection.installed,
      authenticated: detection.authenticated,
      ...(detection.version === undefined ? {} : { version: detection.version }),
      selected: adapter.id === selected,
      login: {
        command: formatCommand(definition.loginCommand),
        manual: definition.loginCommand.interactive,
        note: definition.loginCommand.note,
      },
      install: {
        command: formatCommand(definition.install),
        docsUrl: definition.install.docsUrl,
      },
    };
  });
};

const nextTurnNumber = (store: Store, courseId: number): number => {
  const transcriptRow = store.db
    .query(
      "SELECT COALESCE(MAX(turn), 0) AS turn FROM transcript WHERE course_id = ?1",
    )
    .get(courseId) as { turn: number | bigint } | undefined;
  const eventsRow = store.db
    .query(
      "SELECT COALESCE(MAX(turn), 0) AS turn FROM turn_events WHERE course_id = ?1",
    )
    .get(courseId) as { turn: number | bigint } | undefined;
  const transcriptTurn =
    typeof transcriptRow?.turn === "bigint"
      ? Number(transcriptRow.turn)
      : (transcriptRow?.turn ?? 0);
  const eventsTurn =
    typeof eventsRow?.turn === "bigint"
      ? Number(eventsRow.turn)
      : (eventsRow?.turn ?? 0);

  return Math.max(transcriptTurn, eventsTurn) + 1;
};

const dbNumber = (value: number | bigint): number =>
  typeof value === "bigint" ? Number(value) : value;

const topicForTurnPosition = (topic: Topic): TurnPositionTopic => ({
  id: topic.id,
  path: topic.path,
  title: topic.title,
});

const navigationTopicForTurnPosition = (
  topic: TopicNavigationTopic,
): TurnPositionTopic => ({
  id: topic.id,
  path: topic.path,
  title: topic.title,
});

const topicEnteredEvent = (
  topic: TopicNavigationTopic,
  previous: TopicNavigationTopic | null,
  revisit: boolean,
): TopicEnteredTurnEvent => ({
  type: "topic-entered",
  path: topic.path,
  revisit,
  previous:
    previous === null ? null : navigationTopicForTurnPosition(previous),
});

const topicEnteredEventFromNavigation = (
  navigation: TopicNavigationResult,
  revisit: boolean,
): TopicEnteredTurnEvent =>
  topicEnteredEvent(navigationResultTopic(navigation), navigation.previous, revisit);

const topicEnteredEventFromPending = (
  pending: PendingTopicNavigation,
): TopicEnteredTurnEvent =>
  topicEnteredEvent(pending.topic, pending.previous, pending.revisit);

const cardSkippedEventFromChange = (
  change: TranscriptCardStateChange,
): CardSkippedTurnEvent => ({
  type: "card-skipped",
  cardId: change.cardId,
  cardKind: change.cardKind,
  reason: "learner-action",
});

const cardSkippedEventFromPending = (
  event: PendingCardSkippedEvent,
): CardSkippedTurnEvent => ({
  type: "card-skipped",
  cardId: event.cardId,
  cardKind: event.cardKind,
  reason: event.reason,
});

const pendingCardSkippedEventsFromChanges = (
  changes: readonly TranscriptCardStateChange[],
): readonly PendingCardSkippedEvent[] =>
  changes.map((change) => ({
    type: "card-skipped",
    cardId: change.cardId,
    cardKind: change.cardKind,
    reason: "learner-action",
  }));

const flatTopicsForCourse = (store: Store, courseId: number): readonly Topic[] =>
  flattenTopicTree(readTopicTree(store, courseId));

const currentTopicForCourse = (
  store: Store,
  courseId: number,
): Topic | null =>
  flatTopicsForCourse(store, courseId).find((topic) => topic.isCurrent) ?? null;

const snapshotActiveTurn = (
  store: Store,
  courseId: number,
  turn: number,
): Readonly<{ activeTurn: ActiveTeachingTurn; currentTopic: Topic | null }> => {
  const currentTopic = currentTopicForCourse(store, courseId);

  return {
    activeTurn: {
      turn,
      topicId: currentTopic?.id ?? null,
      topicPath: currentTopic?.path ?? null,
    },
    currentTopic,
  };
};

const previousTranscriptTopic = (
  store: Store,
  courseId: number,
  turn: number,
): TurnPositionTopic | null | undefined => {
  const row = store.db
    .query(
      `
        SELECT topic_id
        FROM transcript
        WHERE course_id = ?1
          AND turn < ?2
        ORDER BY turn DESC, id DESC
        LIMIT 1
      `,
    )
    .get(courseId, turn) as
    | { topic_id: number | bigint | null }
    | null
    | undefined;

  if (row === null || row === undefined) {
    return undefined;
  }

  if (row.topic_id === null) {
    return null;
  }

  const topicId = dbNumber(row.topic_id);
  const topic = flatTopicsForCourse(store, courseId).find(
    (candidate) => candidate.id === topicId,
  );

  return topic === undefined ? null : topicForTurnPosition(topic);
};

const turnPositionContext = (
  store: Store,
  courseId: number,
  turn: number,
  currentTopic: Topic | null,
  events: readonly TurnEvent[] = [],
): TurnPositionContext => {
  if (currentTopic === null) {
    return { currentTopic: null };
  }

  const currentPositionTopic = {
    ...topicForTurnPosition(currentTopic),
    state: currentTopic.state,
  };
  const explicitTopicEntry = [...events]
    .reverse()
    .find(
      (event): event is TopicEnteredTurnEvent =>
        event.type === "topic-entered" && event.path === currentTopic.path,
    );
  if (explicitTopicEntry !== undefined) {
    return {
      currentTopic: currentPositionTopic,
      previousTopic: explicitTopicEntry.previous,
      revisit: explicitTopicEntry.revisit,
    };
  }

  const previousTopic = previousTranscriptTopic(store, courseId, turn);
  if (previousTopic === undefined) {
    return { currentTopic: currentPositionTopic };
  }

  const previousTopicId = previousTopic?.id ?? null;
  if (previousTopicId === currentTopic.id) {
    return { currentTopic: currentPositionTopic };
  }

  return {
    currentTopic: currentPositionTopic,
    previousTopic,
    revisit: currentTopic.enteredAt !== null,
  };
};

const appendUiTranscript = (
  store: Store,
  courseId: number,
  input: Parameters<typeof appendTranscriptEntry>[2],
): TranscriptEntry => uiTranscriptEntry(appendTranscriptEntry(store, courseId, input));

const navigationResultTopic = (
  navigation: TopicNavigationResult,
): TopicNavigationTopic => ({
  id: navigation.topic.id,
  path: navigation.topic.path,
  title: navigation.topic.title,
});

const topicChangeContent = (
  topic: TopicNavigationTopic,
  revisit: boolean,
): string =>
  revisit
    ? `Back to **${topic.title}** (revisit)`
    : `Entered **${topic.title}**`;

const appendTopicChangeTranscript = (
  store: Store,
  courseId: number,
  input: Readonly<{
    turn: number;
    topic: TopicNavigationTopic;
    previous: TopicNavigationTopic | null;
    revisit: boolean;
  }>,
): TranscriptEntry =>
  appendUiTranscript(store, courseId, {
    turn: input.turn,
    role: "system",
    kind: "topic-change",
    content: topicChangeContent(input.topic, input.revisit),
    payload: {
      kind: "topic-change",
      topic: input.topic,
      previous: input.previous,
      revisit: input.revisit,
    },
  });

const routeCourseRequest = (
  path: string,
): Readonly<{ courseId: number; rest: readonly string[] }> | undefined => {
  const segments = path.split("/").filter((segment) => segment.length > 0);
  if (segments[0] !== "api" || segments[1] !== "courses") {
    return undefined;
  }

  const rawCourseId = segments[2];
  if (rawCourseId === undefined) {
    return undefined;
  }

  const courseId = Number(rawCourseId);
  if (!Number.isInteger(courseId) || courseId <= 0) {
    return undefined;
  }

  return {
    courseId,
    rest: segments.slice(3),
  };
};

const routeHarnessLoginRequest = (path: string): string | undefined => {
  const segments = path.split("/").filter((segment) => segment.length > 0);
  if (
    segments.length !== 4 ||
    segments[0] !== "api" ||
    segments[1] !== "harnesses" ||
    segments[3] !== "login"
  ) {
    return undefined;
  }

  return segments[2] === undefined ? undefined : decodeURIComponent(segments[2]);
};

const demoResponse = (store: Store, courseId: number, file: string): Response => {
  const demo = listDemos(store, courseId).find((candidate) => demoFileKey(candidate) === file);
  if (demo === undefined) {
    return textResponse("Demo not found.", 404);
  }

  if (demo.bodyFormat === "html") {
    return new Response(demo.body, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy":
          "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:;",
      },
    });
  }

  const html =
    demo.bodyFormat === "markdown"
      ? renderMarkdown(demo.body)
      : `<pre>${escapeHtml(demo.body)}</pre>`;

  return new Response(`<!doctype html><meta charset="utf-8">${html}`, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline';",
    },
  });
};

export const runDaemon = async (
  env: Env = process.env,
  options: RunDaemonOptions = {},
): Promise<void> => {
  const sessionIdleTtlMs = resolveSessionIdleTtlMs(env);
  const sessionIdleSweepIntervalMs = resolveSessionIdleSweepIntervalMs(env);
  const store = openStore({ env });
  const daemonToken = randomBytes(32).toString("base64url");
  const tokenScopes = new Map<string, TokenScope>();
  const statuses = new Map<number, UiStatusPayload>();
  const activeTurnByCourse = new Map<number, number>();
  const activeTurnSnapshotByCourse = new Map<number, ActiveTeachingTurn>();
  const agentStreamReplay: AgentStreamPayload[] = [];
  const harnessDetectionCache: { value?: Map<string, AdapterDetection> } = {};
  const harnessLoginSpawner =
    options.harnessLoginSpawner ?? defaultHarnessLoginSpawner;
  const allowedCorsOrigins = corsAllowedOrigins(env);
  const runtimes = new Map<number, CourseRuntime>();
  let port = 0;
  let shuttingDown = false;
  let sweepingIdleSessions = false;
  let sessionIdleSweepInterval: ReturnType<typeof setInterval> | undefined;

  const readProfileResource = (): ProfileResource => {
    const profile = getProfile(store);
    const normalized = normalizeOnboardingState(profile.onboardingState);
    if (profile.onboardingState !== normalized) {
      return profileResource(
        patchProfile(store, { onboardingState: normalized }),
        store.dataDir,
      );
    }

    return profileResource(profile, store.dataDir);
  };

  const patchProfileResource = (
    patch: ProfilePatchInput,
  ): ProfileResource => profileResource(patchProfile(store, patch), store.dataDir);

  const setStatus = (
    courseId: number,
    status: UiStatus,
    message?: string,
  ): void => {
    const payload = {
      courseId,
      status,
      hasSeenWait: true,
      ...(message === undefined ? {} : { message }),
    };
    statuses.set(courseId, payload);
    sseHub.broadcast("status", payload);
  };

  const runtimeHarnessId = (courseRuntime: CourseRuntime): string =>
    courseRuntime.orchestrator.hasActiveSession()
      ? courseRuntime.harnessId
      : selectedHarnessId(store, courseRuntime.courseId, env);

  const liveSession = (courseRuntime: CourseRuntime): LiveSessionSummary => ({
    courseId: courseRuntime.courseId,
    harnessId: runtimeHarnessId(courseRuntime),
    state: courseRuntime.runningTurn ? "turn-running" : "idle",
  });

  const liveSessions = (): readonly LiveSessionSummary[] =>
    [...runtimes.values()]
      .sort((left, right) => left.courseId - right.courseId)
      .map(liveSession);

  const sessionSummary = (courseRuntime: CourseRuntime): SessionSummary => {
    const course = getCourse(store, courseRuntime.courseId);

    return {
      ...liveSession(courseRuntime),
      courseTitle: course?.title ?? `Course ${courseRuntime.courseId}`,
      lastActivityAt: new Date(courseRuntime.lastActivityAt).toISOString(),
      startedAt: new Date(courseRuntime.startedAt).toISOString(),
    };
  };

  const sessionsPayload = (): readonly SessionSummary[] =>
    [...runtimes.values()]
      .sort((left, right) => left.courseId - right.courseId)
      .map(sessionSummary);

  const broadcastSessions = (): void => {
    sseHub.broadcast("sessions", sessionsPayload());
  };

  const getActiveTurn = (courseId: number): ActiveTeachingTurn | undefined => {
    const turn = activeTurnByCourse.get(courseId);
    if (turn === undefined) {
      return undefined;
    }

    const snapshot = activeTurnSnapshotByCourse.get(courseId);
    if (snapshot !== undefined && snapshot.turn === turn) {
      return snapshot;
    }

    return { turn, topicId: null, topicPath: null };
  };

  const coursesPayload = (): Record<string, unknown> => ({
    courses: listCourses(store).map(courseResource),
    liveSessions: liveSessions(),
  });

  const harnessesPayload = (
    courseId: number | undefined,
    switched: boolean,
    refresh = false,
  ): HarnessesPayload => ({
    ...(courseId === undefined ? { scope: "profile" as const } : { courseId }),
    harnesses: harnessSummaries(store, courseId, env, harnessDetectionCache, refresh),
    switched,
  });

  const sseHub = createSseHub(
    () => [...statuses.values()],
    (courseId) => harnessesPayload(courseId, false),
    coursesPayload,
    sessionsPayload,
  );

  const sweepIdleSessions = async (): Promise<void> => {
    if (shuttingDown || sweepingIdleSessions) {
      return;
    }

    sweepingIdleSessions = true;
    try {
      await expireIdleSessions({
        runtimes,
        idleTtlMs: sessionIdleTtlMs,
        now: () => Date.now(),
        onExpired: () => {
          if (!shuttingDown) {
            sseHub.broadcast("courses", coursesPayload());
            broadcastSessions();
          }
        },
      });
    } finally {
      sweepingIdleSessions = false;
    }
  };

  const startSessionIdleSweep = (): void => {
    sessionIdleSweepInterval = setInterval(() => {
      void sweepIdleSessions().catch(() => undefined);
    }, sessionIdleSweepIntervalMs);
    unrefTimer(sessionIdleSweepInterval);
  };

  const broadcastCourseCollections = (courseId: number): void => {
    const view = courseView(store, courseId);
    if (view === undefined) {
      return;
    }

    sseHub.broadcast("transcript", {
      courseId,
      entries: view.transcript,
    });
    sseHub.broadcast("glossary", {
      courseId,
      entries: view.glossary,
    });
    sseHub.broadcast("topics", {
      courseId,
      topics: view.topics,
      unassignedDemos: view.unassignedDemos,
    });
    sseHub.broadcast("mastery", {
      courseId,
      entries: view.masteryScores,
    });
    sseHub.broadcast("feynman", {
      courseId,
      activeCheck: view.activeFeynmanCheck ?? null,
    });
  };

  const onTeachingWrite = (event: TeachingWriteEvent): void => {
    flushPendingAgentText(event.courseId);
    const activeTurn = event.activeTurn;
    const attachment = event.attachment;
    // Demo, journal-note, and card writes render as rich transcript
    // cards; every other teaching write keeps its readable tool-call row.
    const entry =
      attachment?.kind === "demo"
        ? appendUiTranscript(store, event.courseId, {
            ...(activeTurn === undefined
              ? {}
              : { turn: activeTurn.turn, topicId: activeTurn.topicId }),
            role: "agent",
            kind: "demo",
            content: attachment.file,
            payload: {
              file: attachment.file,
              ...(attachment.title === undefined ? {} : { title: attachment.title }),
            },
          })
        : attachment?.kind === "journal-note"
          ? appendUiTranscript(store, event.courseId, {
              ...(activeTurn === undefined
                ? { topicId: attachment.topicId }
                : { turn: activeTurn.turn, topicId: attachment.topicId }),
              role: "agent",
              kind: "journal-note",
              content: attachment.markdown,
              payload: {
                entryId: attachment.entryId,
                topicId: attachment.topicId,
                markdown: attachment.markdown,
              },
            })
          : attachment?.kind === "topic-proposals"
            ? withStoreTransaction(store, () => {
                skipLatestActiveCard(event.courseId);
                return appendUiTranscript(store, event.courseId, {
                  ...(activeTurn === undefined
                    ? {}
                    : { turn: activeTurn.turn, topicId: activeTurn.topicId }),
                  role: "agent",
                  kind: "topic-proposals",
                  content: event.summary,
                  payload: {
                    cardId: attachment.cardId,
                    cardKind: "topic-proposals",
                    state: "active",
                    topics: attachment.topics,
                  },
                });
              })
          : attachment?.kind === "feynman"
            ? withStoreTransaction(store, () => {
                skipLatestActiveTranscriptCard(event.courseId);
                return appendUiTranscript(store, event.courseId, {
                  ...(activeTurn === undefined
                    ? {}
                    : { turn: activeTurn.turn, topicId: activeTurn.topicId }),
                  role: "agent",
                  kind: "feynman-check",
                  content: attachment.prompt,
                  payload: {
                    cardId: attachment.cardId,
                    cardKind: "feynman",
                    state: "active",
                    concept: attachment.concept,
                    keyPoints: attachment.keyPoints,
                  },
                });
              })
          : appendUiTranscript(store, event.courseId, {
              ...(activeTurn === undefined
                ? {}
                : { turn: activeTurn.turn, topicId: activeTurn.topicId }),
              role: "system",
              kind: "tool-call",
              content: event.summary,
              payload: {
                tool: event.tool,
                summary: event.summary,
              },
            });

    sseHub.broadcast("message", { courseId: event.courseId, entry });
    sseHub.broadcast("tool-write", event);
    broadcastCourseCollections(event.courseId);

    // Course renames must reach every title surface (topbar, library,
    // sessions bar) immediately, not at the next turn boundary.
    if (event.tool === "update_course_info") {
      sseHub.broadcast("courses", coursesPayload());
      broadcastSessions();
    }
  };

  const teachingMcpHandler = createTeachingMcpHttpHandler({
    store,
    resolveScope: (token) => {
      const scope = tokenScopes.get(token);
      return scope === undefined
        ? null
        : {
            courseId: scope.courseId,
            getActiveTurn: () => getActiveTurn(scope.courseId),
          };
    },
    onWrite: onTeachingWrite,
  });

  const registerTeachingSession = (
    input: Readonly<{ courseId: number; harnessId: string }>,
  ): ActiveTeachingSessionRegistration => {
    const token = randomBytes(32).toString("base64url");
    const session = startSession(store, {
      courseId: input.courseId,
      harnessId: input.harnessId,
    });

    tokenScopes.set(token, {
      courseId: input.courseId,
      sessionId: session.id,
    });

    const courseRuntime = runtimes.get(input.courseId);
    if (courseRuntime !== undefined) {
      courseRuntime.harnessId = input.harnessId;
    }

    return { token, sessionId: session.id };
  };

  const unregisterTeachingSession = (
    registration: ActiveTeachingSessionRegistration,
    reason: string,
  ): void => {
    tokenScopes.delete(registration.token);

    if (registration.sessionId !== undefined) {
      endStoreSession(store, registration.sessionId, reason);
    }
  };

  const revokeTeachingTokensForCourse = (courseId: number, reason: string): void => {
    for (const [token, scope] of [...tokenScopes.entries()]) {
      if (scope.courseId !== courseId) {
        continue;
      }

      tokenScopes.delete(token);
      if (scope.sessionId !== undefined) {
        endStoreSession(store, scope.sessionId, reason);
      }
    }
  };

  // ACP harnesses stream agent text as per-chunk events; buffer them per
  // course/turn and persist one transcript row per contiguous message so the
  // stored transcript (and exports) aren't fragmented into token deltas.
  const pendingAgentText = new Map<
    number,
    { turn: number; topicId: number | null | undefined; text: string }
  >();

  const flushPendingAgentText = (courseId: number): void => {
    const pending = pendingAgentText.get(courseId);
    pendingAgentText.delete(courseId);
    // Whitespace-only buffers (e.g. a stray newline chunk streamed before a
    // tool call) must not persist as empty transcript bubbles.
    if (pending === undefined || pending.text.trim().length === 0) {
      return;
    }

    const split = splitLeadingLeakedThinking(pending.text);
    const baseInput = {
      turn: pending.turn,
      ...(pending.topicId === undefined ? {} : { topicId: pending.topicId }),
      role: "agent" as const,
    };

    if (split.thinking.trim().length > 0) {
      const thinkingEntry = appendUiTranscript(store, courseId, {
        ...baseInput,
        kind: "thinking",
        content: split.thinking,
        payload: {
          role: "agent",
          kind: "thinking",
          text: split.thinking,
        },
      });
      sseHub.broadcast("message", { courseId, entry: thinkingEntry });
    }

    if (split.text.trim().length > 0) {
      const entry = appendUiTranscript(store, courseId, {
        ...baseInput,
        kind: "text",
        content: split.text,
      });
      sseHub.broadcast("message", { courseId, entry });
    }
  };

  const appendAgentEventTranscript = (payload: AgentStreamPayload): void => {
    const event = payload.event;

    if (event.type === "text") {
      const pending = pendingAgentText.get(payload.courseId);
      if (pending !== undefined && pending.turn === payload.turn) {
        pending.text += event.text;
      } else {
        flushPendingAgentText(payload.courseId);
        const activeTurn = getActiveTurn(payload.courseId);
        pendingAgentText.set(payload.courseId, {
          turn: payload.turn,
          topicId:
            activeTurn?.turn === payload.turn ? activeTurn.topicId : undefined,
          text: event.text,
        });
      }
      return;
    }

    if (event.type === "done" || event.type === "error") {
      flushPendingAgentText(payload.courseId);
    }

    // Generic harness tool calls are working noise, not part of the learning
    // record — the live activity stream shows them in flight, and meaningful
    // writes (mastery, glossary, etc.) get readable rows via
    // onTeachingWrite. Only agent text is persisted from the raw stream.
  };

  const onAgentEvent = (payload: AgentStreamPayload): void => {
    const terminalWrapUp =
      payload.event.type === "done" &&
      statuses.get(payload.courseId)?.status === "wrapping-up";
    if (terminalWrapUp) {
      revokeTeachingTokensForCourse(payload.courseId, "done");
    }
    if (payload.event.type === "error") {
      revokeTeachingTokensForCourse(payload.courseId, "agent-crashed");
    }

    agentStreamReplay.push(payload);
    agentStreamReplay.splice(0, Math.max(0, agentStreamReplay.length - MAX_AGENT_STREAM_REPLAY));
    appendAgentEventTranscript(payload);
    sseHub.broadcast("agent-stream", payload);
  };

  const ensureRuntime = (course: Course): CourseRuntime => {
    const existing = runtimes.get(course.id);
    if (existing !== undefined) {
      return existing;
    }

    const mcpBaseUrl = formatDaemonUrl(port, "");
    const orchestrator = createDaemonTurnOrchestrator({
      courseId: course.id,
      getCourseMetadata: () => {
        const currentCourse = getCourse(store, course.id);
        return currentCourse === undefined
          ? undefined
          : {
              title: currentCourse.title,
              description: currentCourse.description,
            };
      },
      attachedDir: course.attachedDir,
      cwd: store.dataDir,
      mcpBaseUrl,
      env,
      getHarnessId: () => {
        const harnessId = getCourse(store, course.id)?.harnessId;
        return harnessId ?? getProfile(store).preferredHarness ?? undefined;
      },
      onAgentEvent,
      registerTeachingSession,
      unregisterTeachingSession,
    });

    const now = Date.now();
    const courseRuntime = {
      courseId: course.id,
      harnessId: selectedHarnessId(store, course.id, env),
      orchestrator,
      runningTurn: false,
      lastActivityAt: now,
      startedAt: now,
    };
    runtimes.set(course.id, courseRuntime);
    sseHub.broadcast("courses", coursesPayload());
    broadcastSessions();

    return courseRuntime;
  };

  const removeRuntimeIfCold = (courseRuntime: CourseRuntime): void => {
    if (
      !courseRuntime.orchestrator.hasActiveSession() &&
      runtimes.get(courseRuntime.courseId) === courseRuntime
    ) {
      runtimes.delete(courseRuntime.courseId);
    }
  };

  const runCourseTurn = (
    course: Course,
    events: readonly TurnEvent[],
    mode: TurnPromptMode,
    existingTurn?: number,
  ): Response => {
    const currentRuntime = ensureRuntime(course);
    if (currentRuntime.runningTurn) {
      return textResponse("A turn is already running for this course.", 409);
    }

    const turn: TurnPayload = {
      turn: existingTurn ?? nextTurnNumber(store, course.id),
      createdAt: new Date().toISOString(),
      events,
    };
    const turnSnapshot = snapshotActiveTurn(store, course.id, turn.turn);
    const position = turnPositionContext(
      store,
      course.id,
      turn.turn,
      turnSnapshot.currentTopic,
      turn.events,
    );
    currentRuntime.lastActivityAt = Date.now();
    currentRuntime.runningTurn = true;
    activeTurnByCourse.set(course.id, turn.turn);
    activeTurnSnapshotByCourse.set(course.id, turnSnapshot.activeTurn);
    const progressMessage =
      mode === "orientation"
        ? "Drafting your course…"
        : mode === "wrap-up"
          ? "Saving your progress…"
          : mode === "greeting"
            ? "Getting your course ready…"
            : "Preparing your next step…";
    setStatus(
      course.id,
      mode === "wrap-up" ? "wrapping-up" : "agent-working",
      progressMessage,
    );
    sseHub.broadcast("courses", coursesPayload());
    broadcastSessions();
    appendTurnEvents(store, course.id, {
      turn: turn.turn,
      status: "pending",
      createdAt: turn.createdAt,
      events: turn.events.map((event) => ({ ...event })),
      importedFrom: null,
    });

    void (async () => {
      const result = await currentRuntime.orchestrator.runTurn(
        turn,
        mode,
        position,
      );
      appendTurnEvents(store, course.id, {
        turn: turn.turn,
        status: "completed",
        createdAt: new Date().toISOString(),
        events: turn.events.map((event) => ({ ...event })),
        importedFrom: null,
      });

      currentRuntime.runningTurn = false;
      currentRuntime.lastActivityAt = Date.now();
      activeTurnByCourse.delete(course.id);
      activeTurnSnapshotByCourse.delete(course.id);

      if (!result.ok) {
        setStatus(course.id, "agent-failed", result.message);
        removeRuntimeIfCold(currentRuntime);
        sseHub.broadcast("courses", coursesPayload());
        broadcastSessions();
        return;
      }

      if (mode === "wrap-up") {
        await currentRuntime.orchestrator.endSession("done");
        runtimes.delete(course.id);
        setStatus(course.id, "session-ended");
        sseHub.broadcast("courses", coursesPayload());
        broadcastSessions();
        return;
      }

      setStatus(course.id, "waiting-for-agent");
      sseHub.broadcast("courses", coursesPayload());
      broadcastSessions();
      broadcastCourseCollections(course.id);
    })().catch((error) => {
      currentRuntime.runningTurn = false;
      currentRuntime.lastActivityAt = Date.now();
      activeTurnByCourse.delete(course.id);
      activeTurnSnapshotByCourse.delete(course.id);
      setStatus(
        course.id,
        "agent-failed",
        error instanceof Error ? error.message : "Agent turn failed.",
      );
      removeRuntimeIfCold(currentRuntime);
      sseHub.broadcast("courses", coursesPayload());
      broadcastSessions();
    });

    return jsonResponse({ ok: true, turn: turn.turn });
  };

  const broadcastTranscriptEntries = (
    courseId: number,
    entries: readonly TranscriptEntry[],
  ): void => {
    for (const entry of entries) {
      sseHub.broadcast("message", { courseId, entry });
    }
  };

  const skipLatestActiveTranscriptCard = (
    courseId: number,
  ): TranscriptCardStateChange | null =>
    updateLatestActiveTranscriptCardState(store, courseId, {
      state: "skipped",
    });

  const skipLatestActiveCard = (
    courseId: number,
  ): TranscriptCardStateChange | null => {
    const skipped = skipLatestActiveTranscriptCard(courseId);
    if (skipped?.cardKind === "feynman") {
      skipActiveFeynmanCheck(store, courseId);
    }

    return skipped;
  };

  const actOnTopicProposalCard = (
    courseId: number,
    cardId: string,
  ): TranscriptCardStateChange => {
    const changed = updateLatestActiveTranscriptCardState(store, courseId, {
      state: "acted",
      cardId,
      cardKind: "topic-proposals",
    });
    if (changed === null) {
      throw new Error("Topic proposal card is no longer active.");
    }

    return changed;
  };

  const actOnFeynmanCard = (courseId: number): TranscriptCardStateChange | null =>
    updateLatestActiveTranscriptCardState(store, courseId, {
      state: "acted",
      cardKind: "feynman",
    });

  const appendLearnerTurnTranscript = (
    courseId: number,
    turn: number,
    event: TurnEvent,
    input: Parameters<typeof appendTranscriptEntry>[2],
    options: Readonly<{
      skipActiveCard?: boolean;
      beforeAppend?: () => void;
      afterAppend?: () => void;
    }> = {},
  ): Readonly<{
    events: readonly TurnEvent[];
    entries: readonly TranscriptEntry[];
  }> =>
    withStoreTransaction(store, () => {
      const pending = consumePendingTopicNavigation(store, courseId);
      const skipped =
        options.skipActiveCard === false ? null : skipLatestActiveCard(courseId);
      const topicChange =
        pending === null
          ? undefined
          : appendTopicChangeTranscript(store, courseId, {
              turn,
              topic: pending.topic,
              previous: pending.previous,
              revisit: true,
            });
      options.beforeAppend?.();
      const entry = appendUiTranscript(store, courseId, {
        ...input,
        turn,
      });

      options.afterAppend?.();

      return {
        events: [
          ...(pending?.cardEvents.map(cardSkippedEventFromPending) ?? []),
          ...(pending === null ? [] : [topicEnteredEventFromPending(pending)]),
          ...(skipped === null ? [] : [cardSkippedEventFromChange(skipped)]),
          event,
        ],
        entries:
          topicChange === undefined ? [entry] : [topicChange, entry],
      };
    });

  const parseSubmit = async (request: Request): Promise<MessageTurnEvent> => {
    const body = await readJsonBody(request);
    if (!isRecord(body)) {
      throw new Error("Submit body must be an object.");
    }

    return {
      type: "message",
      text: requiredStringField(body, "text"),
    };
  };

  const parseNavRequest = async (request: Request): Promise<NavRequest> => {
    const body = await readJsonBody(request);
    if (!isRecord(body)) {
      throw new Error("Nav body must be an object.");
    }

    const cardId = optionalStringField(body, "cardId");
    if (cardId === null) {
      throw new Error("cardId must be a string.");
    }

    return {
      path: requiredStringField(body, "path"),
      ...(cardId === undefined ? {} : { cardId }),
    };
  };

  const reviewWeakEvent = (courseId: number): TurnEvent => {
    const weakest = flattenTopicTree(readTopicTree(store, courseId))
      .filter((topic) => topic.state !== "frontier")
      .flatMap((topic) => {
        const score = listLatestMasteryScores(store, courseId).find(
          (entry) =>
            entry.concept === topic.path ||
            entry.concept === topic.path.split("/").at(-1),
        );
        return score === undefined ? [] : [score];
      })
      .sort((left, right) => left.score - right.score)
      .slice(0, 3)
      .map((entry) => entry.concept);

    return { type: "review-weak", concepts: weakest };
  };

  const parseFeynmanAnswer = async (
    request: Request,
  ): Promise<FeynmanAnswerTurnEvent> => {
    const body = await readJsonBody(request);
    if (!isRecord(body)) {
      throw new Error("Feynman answer body must be an object.");
    }

    const keyPoints = body["keyPoints"];
    if (!Array.isArray(keyPoints) || !keyPoints.every((entry) => typeof entry === "string")) {
      throw new Error("keyPoints must be an array of strings.");
    }

    return {
      type: "feynman-answer",
      concept: requiredStringField(body, "concept"),
      text: requiredStringField(body, "text"),
      keyPoints,
    };
  };

  const handleCoursesRoot = async (
    request: Request,
    requestUrl: URL,
  ): Promise<Response> => {
    if (request.method === "GET") {
      const status = parseCourseStatus(requestUrl.searchParams.get("status"));
      return jsonResponse(listCourses(store, status).map(courseResource));
    }

    if (request.method === "POST") {
      const body = await readJsonBody(request);
      if (!isRecord(body)) {
        return textResponse("Course body must be an object.", 400);
      }

      try {
        if (Object.hasOwn(body, "seed")) {
          const seed = requiredStringField(body, "seed");
          const harnessId = optionalStringField(body, "harnessId");
          const attachedDir = optionalStringField(body, "attachedDir");
          const sourceName = optionalStringField(body, "sourceName");
          const course = createCourse(store, {
            title: "New course",
            description: seed,
            status: "active",
            ...(harnessId === undefined ? {} : { harnessId }),
            ...(attachedDir === undefined ? {} : { attachedDir }),
            ...(sourceName === undefined ? {} : { sourceName }),
          });
          const event: MessageTurnEvent = { type: "message", text: seed };
          const turn = nextTurnNumber(store, course.id);
          const entry = appendUiTranscript(store, course.id, {
            turn,
            role: "learner",
            kind: "text",
            content: seed,
          });

          sseHub.broadcast("courses", coursesPayload());
          sseHub.broadcast("message", { courseId: course.id, entry });
          const turnResponse = runCourseTurn(course, [event], "orientation", turn);
          if (!turnResponse.ok) {
            return turnResponse;
          }

          return jsonResponse(
            {
              ok: true,
              course: courseResource(course),
              turn,
            },
            { status: 201 },
          );
        }

        const input: CourseCreateInput = {
          title: requiredStringField(body, "title"),
        };
        const description = optionalStringField(body, "description");
        const harnessId = optionalStringField(body, "harnessId");
        const attachedDir = optionalStringField(body, "attachedDir");
        const sourceName = optionalStringField(body, "sourceName");

        if (description !== undefined) {
          input.description = description;
        }
        if (harnessId !== undefined) {
          input.harnessId = harnessId;
        }
        if (attachedDir !== undefined) {
          input.attachedDir = attachedDir;
        }
        if (sourceName !== undefined) {
          input.sourceName = sourceName;
        }

        const course = createCourse(store, input);
        sseHub.broadcast("courses", coursesPayload());
        return jsonResponse(courseResource(course), { status: 201 });
      } catch (error) {
        return textResponse(error instanceof Error ? error.message : "Invalid course.", 400);
      }
    }

    return emptyResponse(405);
  };

  const parsePreferredHarness = (
    value: string | null | undefined,
  ): string | null | undefined => {
    if (value === undefined || value === null) {
      return value;
    }

    const adapter = listHarnessAdapters().find(
      (candidate) => candidate.id === value,
    );
    if (adapter === undefined) {
      throw new Error(`Unknown harness adapter: ${value}`);
    }

    return value;
  };

  const handleProfileApi = async (request: Request): Promise<Response> => {
    if (request.method === "GET") {
      return jsonResponse(readProfileResource());
    }

    if (request.method !== "PATCH") {
      return emptyResponse(405);
    }

    const body = await readJsonBody(request);
    if (!isRecord(body)) {
      return textResponse("Profile patch must be an object.", 400);
    }

    try {
      const patch: ProfilePatchInput = {};

      if (Object.hasOwn(body, "name")) {
        const name = optionalStringField(body, "name");
        if (name !== undefined) {
          patch.name = name;
        }
      }

      if (Object.hasOwn(body, "settings")) {
        const settings = optionalRecordField(body, "settings");
        if (settings !== undefined) {
          patch.settings = settings;
        }
      }

      if (Object.hasOwn(body, "preferredHarness")) {
        const preferredHarness = parsePreferredHarness(
          optionalStringField(body, "preferredHarness"),
        );
        if (preferredHarness !== undefined) {
          patch.preferredHarness = preferredHarness;
        }
      }

      const profile = patchProfileResource(patch);
      sseHub.broadcast("harnesses", harnessesPayload(undefined, false, true));
      return jsonResponse(profile);
    } catch (error) {
      return textResponse(
        error instanceof Error ? error.message : "Invalid profile patch.",
        400,
      );
    }
  };

  const handleOnboardingApi = async (request: Request): Promise<Response> => {
    if (request.method === "GET") {
      const profile = readProfileResource();
      return jsonResponse({ state: profile.onboardingState, profile });
    }

    if (request.method !== "POST") {
      return emptyResponse(405);
    }

    const body = await readJsonBody(request);
    if (!isRecord(body)) {
      return textResponse("Onboarding body must be an object.", 400);
    }

    const state = body["state"];
    if (!isOnboardingState(state)) {
      return textResponse(
        "state must be welcome, connect-agent, tutorial-offer, or done.",
        400,
      );
    }

    const current = readProfileResource().onboardingState;
    if (!isLegalOnboardingTransition(current, state)) {
      return textResponse(
        `Illegal onboarding transition: ${current} -> ${state}.`,
        409,
      );
    }

    const profile = patchProfileResource({ onboardingState: state });
    return jsonResponse({ state: profile.onboardingState, profile });
  };

  const handleTutorialApi = (request: Request): Response => {
    if (request.method !== "POST") {
      return emptyResponse(405);
    }

    const course = createTutorialCourse(store);
    sseHub.broadcast("courses", coursesPayload());
    broadcastCourseCollections(course.id);

    return jsonResponse({ courseId: course.id });
  };

  const handleImportApi = async (request: Request): Promise<Response> => {
    if (request.method !== "POST") {
      return emptyResponse(405);
    }

    const body = await readJsonBody(request);
    if (!isRecord(body)) {
      return textResponse("Import body must be an object.", 400);
    }

    try {
      const result = await importCoursePath(store, requiredStringField(body, "path"));
      sseHub.broadcast("courses", coursesPayload());
      broadcastCourseCollections(result.course.id);

      return jsonResponse({
        courseId: result.course.id,
        warnings: result.warnings,
      });
    } catch (error) {
      return textResponse(
        error instanceof Error ? error.message : "Import failed.",
        400,
      );
    }
  };

  const parseExportOptions = async (
    request: Request,
  ): Promise<ExportCourseBundleOptions> => {
    const body = await readJsonBody(request);
    if (!isRecord(body)) {
      throw new Error("Export body must be an object.");
    }

    return {
      includeTranscript: optionalBooleanField(body, "includeTranscript") ?? false,
    };
  };

  const handleHarnessLoginApi = (harnessId: string): Response => {
    const definition = getHarnessAdapterDefinition(harnessId as HarnessAdapterId);
    if (definition === undefined) {
      return textResponse(`Unknown harness adapter: ${harnessId}`, 404);
    }

    const [summary] = harnessSummaries(
      store,
      undefined,
      env,
      harnessDetectionCache,
      true,
    ).filter((candidate) => candidate.id === definition.id);
    if (summary?.installed !== true) {
      return textResponse(`${definition.name} is not installed.`, 409);
    }

    const displayCommand = formatCommand(definition.loginCommand);
    if (definition.loginCommand.interactive) {
      return jsonResponse({
        manual: true,
        spawned: false,
        command: displayCommand,
        note: definition.loginCommand.note,
      });
    }

    try {
      const override = env["OVERLEARN_HARNESS_LOGIN_CMD"];
      const commandLine =
        override === undefined
          ? [definition.loginCommand.command, ...definition.loginCommand.args]
          : parseCommandOverride(override, "OVERLEARN_HARNESS_LOGIN_CMD");
      const [command, ...args] = commandLine;
      if (command === undefined) {
        throw new Error("OVERLEARN_HARNESS_LOGIN_CMD cannot be empty.");
      }

      harnessLoginSpawner({
        harnessId: definition.id,
        command,
        args,
        displayCommand,
        cwd: store.dataDir,
        env: mergeStringEnv(process.env, env, {
          OVERLEARN_LOGIN_HARNESS_ID: definition.id,
          OVERLEARN_LOGIN_COMMAND: displayCommand,
          OVERLEARN_LOGIN_COMMAND_JSON: JSON.stringify([
            definition.loginCommand.command,
            ...definition.loginCommand.args,
          ]),
        }),
      });

      return jsonResponse({
        manual: false,
        spawned: true,
        command: displayCommand,
        note: definition.loginCommand.note,
      });
    } catch (error) {
      return textResponse(
        error instanceof Error ? error.message : "Harness login failed.",
        500,
      );
    }
  };

  const handleCourseApi = async (
    request: Request,
    requestUrl: URL,
    courseId: number,
    rest: readonly string[],
  ): Promise<Response> => {
    const course = getCourse(store, courseId);
    if (course === undefined) {
      return textResponse("Course not found.", 404);
    }

    if (rest.length === 0) {
      if (request.method === "GET") {
        return jsonResponse(courseState(store, courseId));
      }

      if (request.method === "PATCH") {
        const body = await readJsonBody(request);
        if (!isRecord(body)) {
          return textResponse("Course patch must be an object.", 400);
        }

        try {
          const patch: CoursePatchInput = {};

          if (Object.hasOwn(body, "title")) {
            patch.title = requiredStringField(body, "title");
          }
          if (Object.hasOwn(body, "description")) {
            const description = optionalStringField(body, "description");
            if (description !== undefined) {
              patch.description = description;
            }
          }
          if (Object.hasOwn(body, "harnessId")) {
            const harnessId = optionalStringField(body, "harnessId");
            if (harnessId !== undefined) {
              patch.harnessId = harnessId;
            }
          }
          if (Object.hasOwn(body, "attachedDir")) {
            const attachedDir = optionalStringField(body, "attachedDir");
            if (attachedDir !== undefined) {
              patch.attachedDir = attachedDir;
            }
          }
          if (Object.hasOwn(body, "sourceName")) {
            const sourceName = optionalStringField(body, "sourceName");
            if (sourceName !== undefined) {
              patch.sourceName = sourceName;
            }
          }
          if (Object.hasOwn(body, "status")) {
            const status = parseCourseStatus(
              optionalStringField(body, "status") ?? null,
            );
            if (status !== undefined) {
              patch.status = status;
            }
          }

          const patched = patchCourse(store, courseId, patch);
          sseHub.broadcast("courses", coursesPayload());
          if (runtimes.has(courseId)) {
            broadcastSessions();
          }
          return jsonResponse(courseResource(patched));
        } catch (error) {
          return textResponse(error instanceof Error ? error.message : "Invalid course patch.", 400);
        }
      }

      if (request.method === "DELETE") {
        const archived = patchCourse(store, courseId, { status: "archived" });
        sseHub.broadcast("courses", coursesPayload());
        return jsonResponse(courseResource(archived));
      }
    }

    const [action, extra] = rest;

    if (action === "transcript" && extra === undefined) {
      if (request.method !== "GET") {
        return emptyResponse(405);
      }

      try {
        const beforeId = parseOptionalPositiveIntegerParam(
          requestUrl.searchParams,
          "before",
        );
        const limit = parseOptionalPositiveIntegerParam(
          requestUrl.searchParams,
          "limit",
        );

        return jsonResponse(
          readTranscriptBefore(store, courseId, {
            ...(beforeId === undefined ? {} : { beforeId }),
            ...(limit === undefined ? {} : { limit }),
          }),
        );
      } catch (error) {
        return textResponse(
          error instanceof Error ? error.message : "Invalid transcript page.",
          400,
        );
      }
    }

    if (action === "submit" && extra === undefined && request.method === "POST") {
      try {
        const event = await parseSubmit(request);
        const turn = nextTurnNumber(store, courseId);
        const appended = appendLearnerTurnTranscript(courseId, turn, event, {
          role: "learner",
          kind: "text",
          content: event.text,
        });
        broadcastTranscriptEntries(courseId, appended.entries);
        broadcastCourseCollections(courseId);
        return runCourseTurn(course, appended.events, "teaching", turn);
      } catch (error) {
        return textResponse(error instanceof Error ? error.message : "Invalid submit request.", 400);
      }
    }

    if (action === "export" && extra === undefined) {
      if (request.method !== "POST") {
        return emptyResponse(405);
      }

      let options: ExportCourseBundleOptions;
      try {
        options = await parseExportOptions(request);
      } catch (error) {
        return textResponse(
          error instanceof Error ? error.message : "Invalid export request.",
          400,
        );
      }

      try {
        return jsonResponse(await exportCourseBundle(store, courseId, options));
      } catch (error) {
        return textResponse(
          error instanceof Error ? error.message : "Export failed.",
          500,
        );
      }
    }

    if (action === "nav" && extra === undefined && request.method === "POST") {
      try {
        const nav = await parseNavRequest(request);
        const { path } = nav;
        if (path === REVIEW_WEAK_NAV_PATH) {
          const skipped = withStoreTransaction(store, () => skipLatestActiveCard(courseId));
          if (skipped !== null) {
            broadcastCourseCollections(courseId);
          }

          return runCourseTurn(
            course,
            [
              ...(skipped === null ? [] : [cardSkippedEventFromChange(skipped)]),
              reviewWeakEvent(courseId),
            ],
            "teaching",
          );
        }

        const topic = getTopicByPath(store, courseId, path);
        if (topic === undefined) {
          throw new Error(`Topic does not exist in course ${courseId}: ${path}`);
        }

        if (topic.isCurrent) {
          if (nav.cardId !== undefined) {
            const cardId = nav.cardId;
            withStoreTransaction(store, () => {
              actOnTopicProposalCard(courseId, cardId);
            });
            broadcastCourseCollections(courseId);
          }

          return jsonResponse({ ok: true });
        }

        if (topic.state === "frontier") {
          const currentRuntime = runtimes.get(courseId);
          if (currentRuntime?.runningTurn === true) {
            return textResponse("A turn is already running for this course.", 409);
          }

          const turn = nextTurnNumber(store, courseId);
          const frontier = withStoreTransaction(store, () => {
            const skipped =
              nav.cardId === undefined ? skipLatestActiveCard(courseId) : null;
            if (nav.cardId !== undefined) {
              actOnTopicProposalCard(courseId, nav.cardId);
            }

            const navigation = enterFrontierTopic(store, courseId, path);
            const topicChange = navigation.changed
              ? appendTopicChangeTranscript(store, courseId, {
                  turn,
                  topic: navigationResultTopic(navigation),
                  previous: navigation.previous,
                  revisit: false,
                })
              : null;

            return { navigation, skipped, topicChange };
          });
          const { navigation } = frontier;
          if (!navigation.changed) {
            if (frontier.skipped !== null || nav.cardId !== undefined) {
              broadcastCourseCollections(courseId);
            }
            return jsonResponse({ ok: true });
          }

          broadcastCourseCollections(courseId);
          if (frontier.topicChange !== null) {
            sseHub.broadcast("message", { courseId, entry: frontier.topicChange });
          }

          return runCourseTurn(
            course,
            [
              ...(frontier.skipped === null
                ? []
                : [cardSkippedEventFromChange(frontier.skipped)]),
              topicEnteredEventFromNavigation(navigation, false),
            ],
            "teaching",
            turn,
          );
        }

        const visited = withStoreTransaction(store, () => {
          const skipped =
            nav.cardId === undefined ? skipLatestActiveCard(courseId) : null;
          if (nav.cardId !== undefined) {
            actOnTopicProposalCard(courseId, nav.cardId);
          }

          const navigation = selectVisitedTopic(store, courseId, path, {
            cardEvents:
              skipped === null ? [] : pendingCardSkippedEventsFromChanges([skipped]),
          });

          return { navigation, skipped };
        });
        const { navigation } = visited;
        if (navigation.changed || visited.skipped !== null || nav.cardId !== undefined) {
          broadcastCourseCollections(courseId);
        }

        return jsonResponse({ ok: true });
      } catch (error) {
        return textResponse(error instanceof Error ? error.message : "Invalid nav request.", 400);
      }
    }

    if (action === "done" && extra === undefined && request.method === "POST") {
      const skipped = withStoreTransaction(store, () => skipLatestActiveCard(courseId));
      if (skipped !== null) {
        broadcastCourseCollections(courseId);
      }

      return runCourseTurn(
        course,
        [
          ...(skipped === null ? [] : [cardSkippedEventFromChange(skipped)]),
          { type: "session-done" },
        ],
        "wrap-up",
      );
    }

    if (
      action === "feynman-answer" &&
      extra === undefined &&
      request.method === "POST"
    ) {
      try {
        const event = await parseFeynmanAnswer(request);
        const turn = nextTurnNumber(store, courseId);
        const appended = appendLearnerTurnTranscript(
          courseId,
          turn,
          event,
          {
            role: "learner",
            kind: "feynman-answer",
            content: event.text,
            payload: {
              concept: event.concept,
              keyPoints: event.keyPoints,
            },
          },
          {
            skipActiveCard: false,
            beforeAppend: () => {
              actOnFeynmanCard(courseId);
              clearActiveFeynmanCheck(store, courseId);
            },
          },
        );
        broadcastTranscriptEntries(courseId, appended.entries);
        broadcastCourseCollections(courseId);
        return runCourseTurn(course, appended.events, "teaching", turn);
      } catch (error) {
        return textResponse(error instanceof Error ? error.message : "Invalid Feynman answer.", 400);
      }
    }

    if (action === "harness" && extra === undefined && request.method === "POST") {
      const body = await readJsonBody(request);
      if (!isRecord(body)) {
        return textResponse("Harness body must be an object.", 400);
      }

      const id = requiredStringField(body, "id");
      const adapter = listHarnessAdapters().find((candidate) => candidate.id === id);
      if (adapter === undefined) {
        return textResponse(`Unknown harness adapter: ${id}`, 400);
      }

      const currentRuntime = runtimes.get(courseId);
      if (currentRuntime?.runningTurn === true) {
        return textResponse(
          "Cannot change harness while a turn is running. Try again after the agent stops.",
          409,
        );
      }

      const previousHarnessId = selectedHarnessId(store, courseId, env);
      patchCourse(store, courseId, { harnessId: id });
      if (currentRuntime !== undefined) {
        currentRuntime.harnessId = id;
        currentRuntime.lastActivityAt = Date.now();
      }
      const hadActiveSession =
        currentRuntime === undefined
          ? false
          : await currentRuntime.orchestrator.resetSession("harness-swap");
      const payload = harnessesPayload(courseId, hadActiveSession, true);
      sseHub.broadcast("harnesses", payload);
      sseHub.broadcast("courses", coursesPayload());
      if (currentRuntime !== undefined) {
        broadcastSessions();
      }

      if (hadActiveSession) {
        runCourseTurn(
          getCourse(store, courseId) ?? course,
          [{ type: "harness-swapped", from: previousHarnessId, to: id }],
          "greeting",
        );
      }

      return jsonResponse({
        ok: true,
        harness: id,
        swapped: hadActiveSession,
      });
    }

    if (action === "activate" && extra === undefined && request.method === "POST") {
      return jsonResponse({ ok: true, session: sessionSummary(ensureRuntime(course)) });
    }

    if (action === "demos" && extra !== undefined && request.method === "GET") {
      return demoResponse(store, courseId, decodeURIComponent(extra));
    }

    return textResponse("Not found.", 404);
  };

  const healthPayload = (): Record<string, unknown> => ({
    ok: true,
    orchestrated: true,
    version: packageJson.version,
    liveSessions: liveSessions(),
    waitPending: false,
    hasSeenWait: true,
    dataDir: store.dataDir,
  });

  const shutdown = async (): Promise<void> => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    if (sessionIdleSweepInterval !== undefined) {
      clearInterval(sessionIdleSweepInterval);
      sessionIdleSweepInterval = undefined;
    }
    await Promise.all(
      [...runtimes.values()].map((courseRuntime) =>
        courseRuntime.orchestrator.endSession("shutdown"),
      ),
    );
    runtimes.clear();
    tokenScopes.clear();
    broadcastSessions();
    await clearDaemonMetadata(env);
    sseHub.closeAll();
    await new Promise<void>((resolveClose) => {
      server.close(() => resolveClose());
    });
    store.close();
  };

  const handleRequest = async (request: Request): Promise<Response> => {
    if (isCorsPreflight(request)) {
      return corsPreflightResponse(request, allowedCorsOrigins);
    }

    const response = await handleRequestWithoutCors(request);
    return responseWithCorsHeaders(request, response, allowedCorsOrigins);
  };

  const handleRequestWithoutCors = async (request: Request): Promise<Response> => {
    const requestUrl = new URL(request.url);
    const method = request.method;

    if (
      requestUrl.pathname.startsWith("/api/") &&
      !requestHasDaemonToken(request, daemonToken) &&
      !requestHasDemoQueryToken(requestUrl, method, daemonToken)
    ) {
      return unauthorizedResponse();
    }

    if (method === "GET" && requestUrl.pathname === "/api/health") {
      return jsonResponse(healthPayload());
    }

    if (method === "GET" && requestUrl.pathname === "/api/sessions") {
      return jsonResponse(sessionsPayload());
    }

    if (method === "POST" && requestUrl.pathname === "/api/shutdown") {
      setTimeout(() => {
        void shutdown();
      }, 0);
      return jsonResponse({ ok: true });
    }

    if (requestUrl.pathname === "/api/profile") {
      return await handleProfileApi(request);
    }

    if (requestUrl.pathname === "/api/onboarding") {
      return await handleOnboardingApi(request);
    }

    if (requestUrl.pathname === "/api/tutorial") {
      return handleTutorialApi(request);
    }

    if (requestUrl.pathname === "/api/import") {
      return await handleImportApi(request);
    }

    const harnessLoginId = routeHarnessLoginRequest(requestUrl.pathname);
    if (harnessLoginId !== undefined && method === "POST") {
      return handleHarnessLoginApi(harnessLoginId);
    }

    if (method === "GET" && requestUrl.pathname === "/api/harnesses") {
      const courseIdParam = requestUrl.searchParams.get("courseId");
      const scope = requestUrl.searchParams.get("scope");
      if (courseIdParam !== null && scope !== null) {
        return textResponse("Use either courseId or scope, not both.", 400);
      }

      const courseId =
        courseIdParam === null || courseIdParam.length === 0
          ? undefined
          : Number(courseIdParam);
      if (courseId !== undefined) {
        if (!Number.isInteger(courseId) || courseId <= 0) {
          return textResponse("courseId must be a positive integer.", 400);
        }
        if (getCourse(store, courseId) === undefined) {
          return textResponse("Course not found.", 404);
        }

        return jsonResponse(
          harnessSummaries(
            store,
            courseId,
            env,
            harnessDetectionCache,
            requestUrl.searchParams.get("refresh") === "1",
          ),
        );
      }

      if (scope !== "profile") {
        return textResponse("Harness scope is required.", 400);
      }

      return jsonResponse(
        harnessSummaries(
          store,
          undefined,
          env,
          harnessDetectionCache,
          requestUrl.searchParams.get("refresh") === "1",
        ),
      );
    }

    if (requestUrl.pathname === "/api/courses") {
      return await handleCoursesRoot(request, requestUrl);
    }

    const courseRoute = routeCourseRequest(requestUrl.pathname);
    if (courseRoute !== undefined) {
      return await handleCourseApi(
        request,
        requestUrl,
        courseRoute.courseId,
        courseRoute.rest,
      );
    }

    if (requestUrl.pathname.startsWith("/mcp/")) {
      const token = teachingTokenFromRequestPath(request);
      if (token === undefined || !tokenScopes.has(token)) {
        return textResponse("Unknown teaching session token.", 404);
      }

      return await teachingMcpHandler(request);
    }

    if (
      !requestUrl.pathname.startsWith("/api") &&
      !requestUrl.pathname.startsWith("/mcp")
    ) {
      return jsonResponse({ error: "Not found." }, { status: 404 });
    }

    return textResponse("Not found.", 404);
  };

  const server = createServer((incoming, outgoing) => {
    const incomingUrl = new URL(
      incoming.url ?? "/",
      `http://${LOCALHOST_BIND_HOST}:${port}`,
    );

    if (incomingUrl.pathname === "/api/events" && incoming.method === "GET") {
      const incomingHeaders = headersFromIncoming(incoming);
      const corsHeaders = corsHeaderRecord(incomingHeaders, allowedCorsOrigins);
      const queryToken = incomingUrl.searchParams.get("token");
      if (
        !incomingHasDaemonToken(incoming, daemonToken) &&
        queryToken !== daemonToken
      ) {
        outgoing.writeHead(401, {
          "content-type": "text/plain; charset=utf-8",
          ...corsHeaders,
        });
        outgoing.end("Overlearn daemon authentication is required.");
        return;
      }

      sseHub.connect(incoming, outgoing, corsHeaders);
      for (const replay of agentStreamReplay) {
        outgoing.write(`event: agent-stream\ndata: ${JSON.stringify(replay)}\n\n`);
      }
      return;
    }

    void (async () => {
      const request = await webRequestFromIncoming(incoming, port);
      const response = await handleRequest(request);
      await writeWebResponse(outgoing, response);
    })().catch(async (error) => {
      const message = error instanceof Error ? error.message : "Internal daemon error.";
      await writeWebResponse(outgoing, textResponse(message, 500));
    });
  });

  server.keepAliveTimeout = 0;
  server.headersTimeout = 0;

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, LOCALHOST_BIND_HOST, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        rejectListen(new Error("Daemon did not bind to a TCP port."));
        return;
      }

      port = address.port;
      resolveListen();
    });
  });

  await writeDaemonMetadata(
    {
      pid: process.pid,
      port,
      token: daemonToken,
      startedAt: new Date().toISOString(),
    },
    env,
  );

  if (options.portFile !== undefined) {
    await mkdir(dirname(options.portFile), { recursive: true });
    await Bun.write(options.portFile, `${port}\n`);
  }

  startSessionIdleSweep();

  const cleanup = (): void => {
    void shutdown();
  };
  process.once("SIGTERM", cleanup);
  process.once("SIGINT", cleanup);

  await new Promise<void>((resolveClosed) => {
    server.once("close", () => resolveClosed());
  });
};

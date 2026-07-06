import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

import { getHarnessAdapter } from "../adapter/registry";
import type {
  AgentEvent,
  HarnessAdapter,
  HarnessAdapterId,
  PermissionPolicy,
  PermissionRule,
  SessionRef,
} from "../adapter/types";
import type { CoursePaths, TurnFile } from "../course";
import { assembleInstructionModules, formatInstructions } from "../instructions";

type Env = Readonly<Record<string, string | undefined>>;

export type TurnPromptMode = "teaching" | "wrap-up";

export type TurnPromptInput = Readonly<{
  courseName: string;
  courseDir: string;
  turnPath: string;
  turn: TurnFile;
  instructions: string;
  includeResumeContext: boolean;
  mode: TurnPromptMode;
}>;

export type AgentStreamPayload = Readonly<{
  turn: number;
  sequence: number;
  event: AgentEvent;
}>;

export type OrchestratorResult =
  | Readonly<{ ok: true }>
  | Readonly<{
      ok: false;
      reason: "agent-crashed" | "timeout";
      message: string;
    }>;

export type DaemonTurnOrchestrator = Readonly<{
  runTurn: (
    turnPath: string,
    turn: TurnFile,
    mode: TurnPromptMode,
  ) => Promise<OrchestratorResult>;
  endSession: () => Promise<void>;
}>;

type CreateDaemonTurnOrchestratorOptions = Readonly<{
  coursePaths: CoursePaths;
  cwd: string;
  env?: Env;
  adapter?: HarnessAdapter;
  timeoutMs?: number;
  onAgentEvent: (payload: AgentStreamPayload) => void;
}>;

type PromptAttemptResult =
  | OrchestratorResult
  | Readonly<{ timedOut: true }>;

const defaultTurnTimeoutMs = 10 * 60 * 1_000;
const cancelSettleMs = 500;

const sleep = async (milliseconds: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const orchestratedTurnsEnabled = (env: Env = process.env): boolean =>
  env["OVERLEARN_ORCHESTRATED"] === "1";

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

export const resolveTurnTimeoutMs = (env: Env = process.env): number =>
  parsePositiveInteger(
    env["OVERLEARN_TURN_TIMEOUT_MS"],
    "OVERLEARN_TURN_TIMEOUT_MS",
  ) ?? defaultTurnTimeoutMs;

const pushToken = (tokens: string[], token: string): string => {
  if (token.length > 0) {
    tokens.push(token);
  }

  return "";
};

const splitCommandLine = (value: string): readonly string[] => {
  const tokens: string[] = [];
  let token = "";
  let quote: "'" | "\"" | undefined;
  let escaping = false;

  for (const character of value) {
    if (escaping) {
      token += character;
      escaping = false;
      continue;
    }

    if (character === "\\" && quote !== "'") {
      escaping = true;
      continue;
    }

    if (quote !== undefined) {
      if (character === quote) {
        quote = undefined;
      } else {
        token += character;
      }
      continue;
    }

    if (character === "'" || character === "\"") {
      quote = character;
      continue;
    }

    if (/\s/.test(character)) {
      token = pushToken(tokens, token);
      continue;
    }

    token += character;
  }

  if (escaping) {
    token += "\\";
  }

  if (quote !== undefined) {
    throw new Error("OVERLEARN_HARNESS_CMD contains an unterminated quote.");
  }

  pushToken(tokens, token);
  return tokens;
};

export const parseHarnessCommand = (value: string): readonly string[] => {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error("OVERLEARN_HARNESS_CMD cannot be empty.");
  }

  if (trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed) as unknown;
    if (
      !Array.isArray(parsed) ||
      parsed.length === 0 ||
      !parsed.every((entry) => typeof entry === "string" && entry.length > 0)
    ) {
      throw new Error(
        "OVERLEARN_HARNESS_CMD JSON must be a non-empty string array.",
      );
    }

    return parsed;
  }

  const tokens = splitCommandLine(trimmed);
  if (tokens.length === 0) {
    throw new Error("OVERLEARN_HARNESS_CMD cannot be empty.");
  }

  return tokens;
};

export const nestedSessionEnvOverride = (): Env => ({
  CLAUDECODE: undefined,
});

const maybeCommandOverride = (
  env: Env,
): Readonly<{ command: string; args: readonly string[] }> | undefined => {
  const raw = env["OVERLEARN_HARNESS_CMD"];
  if (raw === undefined) {
    return undefined;
  }

  const [command, ...args] = parseHarnessCommand(raw);
  if (command === undefined) {
    throw new Error("OVERLEARN_HARNESS_CMD cannot be empty.");
  }

  return { command, args };
};

export const resolveHarnessAdapter = (
  env: Env = process.env,
): HarnessAdapter => {
  const id = (env["OVERLEARN_HARNESS"] ?? "claude-code") as HarnessAdapterId;
  const commandOverride = maybeCommandOverride(env);
  const requestTimeoutMs = parsePositiveInteger(
    env["OVERLEARN_HARNESS_REQUEST_TIMEOUT_MS"],
    "OVERLEARN_HARNESS_REQUEST_TIMEOUT_MS",
  );
  const adapter = getHarnessAdapter(id, {
    env: nestedSessionEnvOverride(),
    ...(commandOverride === undefined ? {} : commandOverride),
    ...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs }),
  });

  if (adapter === undefined) {
    throw new Error(`Unknown harness adapter: ${id}`);
  }

  return adapter;
};

const readCourseJson = async (
  courseJson: string,
): Promise<Record<string, unknown>> => {
  const parsed = JSON.parse(await readFile(courseJson, "utf8")) as unknown;
  return isRecord(parsed) ? parsed : {};
};

export const resolveCourseWorkingDirectory = async (
  paths: CoursePaths,
): Promise<string> => {
  const manifest = await readCourseJson(paths.courseJson);
  const workingDirectory = manifest["workingDirectory"];

  return typeof workingDirectory === "string" &&
    workingDirectory.trim().length > 0
    ? resolve(paths.courseDir, workingDirectory)
    : paths.courseDir;
};

const courseWriteResources = (courseDir: string): readonly string[] => {
  const normalized = resolve(courseDir);

  return [`${normalized}/**`];
};

const courseReadResources = (
  courseDir: string,
  workingDirectory: string,
): readonly string[] => [
  ...new Set([`${resolve(courseDir)}/**`, `${resolve(workingDirectory)}/**`]),
];

const permissionRules = (
  actions: readonly string[],
  resources: readonly string[],
  reason: string,
): readonly PermissionRule[] =>
  actions.flatMap((action) =>
    resources.map((resource) => ({ action, resource, reason })),
  );

export const buildCoursePermissionPolicy = (
  courseDir: string,
  workingDirectory = courseDir,
): PermissionPolicy => ({
  allow: [
    ...permissionRules(
      ["edit", "write", "write_file", "create", "mkdir", "delete"],
      courseWriteResources(courseDir),
      "Course directory writes are pre-approved for this learning session.",
    ),
    ...permissionRules(
      ["read", "search"],
      courseReadResources(courseDir, workingDirectory),
      "Course and working-directory reads are pre-approved for this learning session.",
    ),
    ...permissionRules(
      ["execute", "shell", "bash", "run"],
      ["learn"],
      "The learn CLI is pre-approved for course callbacks.",
    ),
  ],
  defaultDecision: "deny",
  defaultReason: "Permission was not pre-approved by the course daemon.",
});

const resumePreamble = (input: TurnPromptInput): string =>
  input.includeResumeContext
    ? [
        "## Resume context required",
        "",
        "This is a daemon-supervised resumed harness session.",
        "Before teaching, rebuild context only from on-disk course state: read course.json, lessons/*.md, glossary.json, mastery.json, and the tail of transcript.jsonl.",
        "Do not rely on any prior conversation memory for this course.",
        `Use \`learn say ${input.courseName} --text <markdown>\` to greet the learner with an accurate summary of what has been covered, where the course left off, and the next step.`,
      ].join("\n")
    : "";

const modePreamble = (input: TurnPromptInput): string =>
  input.mode === "wrap-up"
    ? [
        "## Final wrap-up turn",
        "",
        "This turn contains a session-done event. Do not start a new teaching objective.",
        "Mirror the protocol's Session wrap-up semantics: optionally emit final mastery for scores that are clear, then send one closing `learn say` summarizing what was covered, recorded mastery, and a suggested next session.",
        "Do not run `learn stop` and do not run `learn wait`; the daemon will end the harness session and stop after this prompt completes.",
      ].join("\n")
    : [
        "## Teaching turn",
        "",
        "Handle every event in the turn payload in order and keep this turn focused on one learning objective.",
        "Do not run `learn wait` when finished; the daemon will invoke the harness again after the learner submits.",
      ].join("\n");

export const buildTurnPrompt = (input: TurnPromptInput): string =>
  [
    "# Overlearn daemon turn",
    "",
    "The daemon owns the event loop for this course. Use `learn say` and `learn emit` exactly as before, but never block on `learn wait` in this supervised mode.",
    `Course name: ${input.courseName}`,
    `Course directory: ${input.courseDir}`,
    `Turn file: ${input.turnPath}`,
    resumePreamble(input),
    modePreamble(input),
    "## Teaching protocol",
    "",
    input.instructions,
    "## Turn payload",
    "",
    "This JSON is identical to the on-disk turn file.",
    "",
    "```json",
    JSON.stringify(input.turn, null, 2),
    "```",
  ]
    .filter((section) => section.length > 0)
    .join("\n\n");

const attemptFailureMessage = (
  result: OrchestratorResult,
): OrchestratorResult =>
  result.ok
    ? result
    : {
        ...result,
        message:
          result.reason === "timeout"
            ? "The agent timed out. You can submit again to retry."
            : "The agent crashed. You can submit again to retry.",
      };

const terminalError = (event: AgentEvent): OrchestratorResult | undefined =>
  event.type === "error"
    ? {
        ok: false,
        reason: "agent-crashed",
        message: event.message,
      }
    : undefined;

const consumePrompt = async (
  events: AsyncIterable<AgentEvent>,
  turn: TurnFile,
  nextSequence: () => number,
  shouldBroadcast: () => boolean,
  onAgentEvent: (payload: AgentStreamPayload) => void,
): Promise<OrchestratorResult> => {
  try {
    for await (const event of events) {
      if (shouldBroadcast()) {
        onAgentEvent({
          turn: turn.turn,
          sequence: nextSequence(),
          event,
        });
      }

      const failure = terminalError(event);
      if (failure !== undefined) {
        return failure;
      }

      if (event.type === "done") {
        return { ok: true };
      }
    }

    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason: "agent-crashed",
      message: error instanceof Error ? error.message : "Agent prompt failed.",
    };
  }
};

const runPromptWithTimeout = async (
  adapter: HarnessAdapter,
  session: SessionRef,
  prompt: string,
  turn: TurnFile,
  timeoutMs: number,
  nextSequence: () => number,
  onAgentEvent: (payload: AgentStreamPayload) => void,
): Promise<PromptAttemptResult> => {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let suppressEvents = false;
  const consume = consumePrompt(
    adapter.prompt(session, prompt),
    turn,
    nextSequence,
    () => !suppressEvents,
    onAgentEvent,
  );
  const timedOut = new Promise<Readonly<{ timedOut: true }>>((resolveTimeout) => {
    timeout = setTimeout(() => resolveTimeout({ timedOut: true }), timeoutMs);
  });

  const result = await Promise.race([consume, timedOut]);
  if (timeout !== undefined) {
    clearTimeout(timeout);
  }

  if ("timedOut" in result) {
    suppressEvents = true;
    await adapter.cancel(session).catch(() => undefined);
    await Promise.race([
      consume.catch(() => undefined),
      sleep(cancelSettleMs),
    ]);

    return result;
  }

  return result;
};

export const createDaemonTurnOrchestrator = (
  options: CreateDaemonTurnOrchestratorOptions,
): DaemonTurnOrchestrator => {
  const env = options.env ?? process.env;
  const adapter = options.adapter ?? resolveHarnessAdapter(env);
  const timeoutMs = options.timeoutMs ?? resolveTurnTimeoutMs(env);
  let session: SessionRef | undefined;
  let nextTurnNeedsResumeContext = true;
  let sequence = 1;

  const nextSequence = (): number => {
    const current = sequence;
    sequence += 1;
    return current;
  };

  const endSession = async (): Promise<void> => {
    const current = session;
    session = undefined;

    if (current !== undefined) {
      await adapter.end(current).catch(() => undefined);
    }
  };

  const ensureSession = async (): Promise<SessionRef> => {
    if (session !== undefined) {
      return session;
    }

    session = await adapter.newSession(options.cwd, {
      permissionPolicy: buildCoursePermissionPolicy(
        options.coursePaths.courseDir,
        options.cwd,
      ),
      metadata: {
        courseDir: options.coursePaths.courseDir,
        orchestrated: true,
      },
    });

    return session;
  };

  const runAttempt = async (
    turnPath: string,
    turn: TurnFile,
    mode: TurnPromptMode,
    includeResumeContext: boolean,
  ): Promise<OrchestratorResult> => {
    const activeSession = await ensureSession();
    const instructions = formatInstructions(
      assembleInstructionModules({
        courseDir: options.coursePaths.courseDir,
        env,
      }),
    );
    const prompt = buildTurnPrompt({
      courseName: basename(options.coursePaths.courseDir),
      courseDir: options.coursePaths.courseDir,
      turnPath,
      turn,
      instructions,
      includeResumeContext,
      mode,
    });
    const result = await runPromptWithTimeout(
      adapter,
      activeSession,
      prompt,
      turn,
      timeoutMs,
      nextSequence,
      options.onAgentEvent,
    );

    if ("timedOut" in result) {
      await endSession();
      return {
        ok: false,
        reason: "timeout",
        message: "The agent timed out.",
      };
    }

    if (!result.ok) {
      await endSession();
    }

    return result;
  };

  const runTurn = async (
    turnPath: string,
    turn: TurnFile,
    mode: TurnPromptMode,
  ): Promise<OrchestratorResult> => {
    const includeResumeContext = nextTurnNeedsResumeContext;
    const first = await runAttempt(
      turnPath,
      turn,
      mode,
      includeResumeContext,
    );

    if (first.ok || first.reason === "timeout") {
      nextTurnNeedsResumeContext = !first.ok;
      return attemptFailureMessage(first);
    }

    const retry = await runAttempt(turnPath, turn, mode, true);
    nextTurnNeedsResumeContext = !retry.ok;
    return attemptFailureMessage(retry);
  };

  return {
    endSession,
    runTurn,
  };
};

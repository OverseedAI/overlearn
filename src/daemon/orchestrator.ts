import { resolve } from "node:path";

import { getHarnessAdapter } from "../adapter/registry";
import type {
  AgentEvent,
  HarnessAdapter,
  HarnessAdapterId,
  PermissionPolicy,
  PermissionRule,
  SessionRef,
} from "../adapter/types";
import { assembleInstructionModules, formatInstructions } from "../instructions";
import {
  teachingMcpServerName,
  type TeachingToolName,
} from "../mcp/teaching";
import type { TopicNodeState } from "../store";

type Env = Readonly<Record<string, string | undefined>>;

export type TurnPromptMode = "teaching" | "wrap-up" | "greeting" | "ideation";

export type TurnEvent =
  | Readonly<{ type: "message"; text: string }>
  | Readonly<{ type: "nav"; path: string }>
  | Readonly<{ type: "review-weak"; concepts: readonly string[] }>
  | Readonly<{ type: "session-done" }>
  | Readonly<{ type: "harness-swapped"; from: string; to: string }>
  | Readonly<{
      type: "feynman-answer";
      concept: string;
      text: string;
      keyPoints: readonly string[];
    }>
  | Readonly<{ type: "ideation"; text: string }>;

export type TurnPayload = Readonly<{
  turn: number;
  createdAt: string;
  events: readonly TurnEvent[];
}>;

export type TurnPositionTopic = Readonly<{
  id: number;
  path: string;
  title: string;
}>;

export type TurnPositionContext = Readonly<{
  currentTopic:
    | (TurnPositionTopic &
        Readonly<{
          state: TopicNodeState;
        }>)
    | null;
  previousTopic?: TurnPositionTopic | null;
  revisit?: boolean;
}>;

export type CoursePromptMetadata = Readonly<{
  title: string;
  description: string | null;
}>;

export type TurnPromptInput = Readonly<{
  courseId: number;
  courseTitle: string;
  courseDescription: string | null;
  position: TurnPositionContext;
  turn: TurnPayload;
  instructions: string;
  includeResumeContext: boolean;
  mode: TurnPromptMode;
}>;

export type AgentStreamPayload = Readonly<{
  courseId: number;
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
    turn: TurnPayload,
    mode: TurnPromptMode,
    position: TurnPositionContext,
  ) => Promise<OrchestratorResult>;
  endSession: (reason?: string) => Promise<void>;
  resetSession: (reason?: string) => Promise<boolean>;
  hasActiveSession: () => boolean;
}>;

export type ActiveTeachingSessionRegistration = Readonly<{
  token: string;
  sessionId?: number;
}>;

type CreateDaemonTurnOrchestratorOptions = Readonly<{
  courseId: number;
  getCourseMetadata: () => CoursePromptMetadata | undefined;
  attachedDir?: string | null;
  cwd: string;
  mcpBaseUrl: string;
  env?: Env;
  adapter?: HarnessAdapter;
  getHarnessId?: () => string | undefined;
  timeoutMs?: number;
  onAgentEvent: (payload: AgentStreamPayload) => void;
  registerTeachingSession: (
    input: Readonly<{ courseId: number; harnessId: string }>,
  ) => ActiveTeachingSessionRegistration;
  unregisterTeachingSession: (
    registration: ActiveTeachingSessionRegistration,
    reason: string,
  ) => void;
}>;

type PromptAttemptResult =
  | OrchestratorResult
  | Readonly<{ timedOut: true }>;

const defaultTurnTimeoutMs = 10 * 60 * 1_000;
const cancelSettleMs = 500;

const sleep = async (milliseconds: number): Promise<void> => {
  await new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
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
  courseHarnessId?: string,
): HarnessAdapter => {
  const id = (courseHarnessId ??
    env["OVERLEARN_HARNESS"] ??
    "claude-code") as HarnessAdapterId;
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

const permissionRules = (
  actions: readonly string[],
  resources: readonly string[],
  reason: string,
): readonly PermissionRule[] =>
  actions.flatMap((action) =>
    resources.map((resource) => ({ action, resource, reason })),
  );

const teachingMcpToolNames: readonly TeachingToolName[] = [
  "get_course_state",
  "upsert_topic",
  "emit_demo",
  "append_lesson_note",
  "record_mastery",
  "feynman_check",
  "upsert_glossary_entry",
  "propose_course_plan",
];

const teachingMcpPermissionRules = (): readonly PermissionRule[] =>
  teachingMcpToolNames.map((tool) => ({
    action: "mcp",
    resource: `${teachingMcpServerName}.${tool}`,
    reason: "Overlearn teaching MCP tools are pre-approved for this learning session.",
  }));

export const buildCoursePermissionPolicy = (
  attachedDir?: string | null,
): PermissionPolicy => {
  const resources =
    attachedDir === undefined || attachedDir === null || attachedDir.trim() === ""
      ? []
      : [`${resolve(attachedDir)}/**`];

  return {
    allow: [
      ...teachingMcpPermissionRules(),
      ...permissionRules(
        ["read", "search"],
        resources,
        "Attached directory reads are pre-approved for this learning session.",
      ),
    ],
    defaultDecision: "deny",
    defaultReason: "Permission was not pre-approved by the course daemon.",
  };
};

const resumePreamble = (input: TurnPromptInput): string =>
  input.includeResumeContext
    ? [
        "## Resume context required",
        "",
        "This is a daemon-supervised resumed harness session.",
        `Before teaching, call the \`${teachingMcpServerName}\` MCP tool \`get_course_state\` to rebuild course context from the store.`,
        "Do not rely on prior conversation memory for this course.",
        "For a resumed teaching turn or greeting, use the conversation response to greet the learner with an accurate summary, the current course position, and the next step.",
      ].join("\n")
    : "";

const modePreamble = (input: TurnPromptInput): string => {
  if (input.mode === "wrap-up") {
    return [
      "## Final wrap-up turn",
      "",
      "This turn contains a session-done event. Do not start a new teaching objective.",
      `Call \`${teachingMcpServerName}.get_course_state\` first, optionally record final mastery with MCP tools when scores are clear, then send one closing conversational response summarizing what was covered, recorded mastery, and a suggested next session.`,
      "End the turn after the closing response. The daemon will end the harness session and stop.",
    ].join("\n");
  }

  if (input.mode === "greeting") {
    return [
      "## Harness swap greeting turn",
      "",
      `Call \`${teachingMcpServerName}.get_course_state\` first because the previous harness session's in-context memory is gone.`,
      "Send one short continuity greeting in the conversation: summarize what has been covered, where the course left off, and the next step.",
      "Do not start a new teaching objective. The daemon will pause for the learner after this greeting.",
    ].join("\n");
  }

  if (input.mode === "ideation") {
    return [
      "## Course ideation turn",
      "",
      `Call \`${teachingMcpServerName}.get_course_state\` first, brainstorm the course shape with the learner's request, then call \`${teachingMcpServerName}.propose_course_plan\` with a coherent draft title, description, and topic tree.`,
      "After proposing the plan, briefly summarize the direction in the conversation and end the turn.",
    ].join("\n");
  }

  return [
    "## Teaching turn",
    "",
    `Call \`${teachingMcpServerName}.get_course_state\` first, then handle every event in the turn payload in order and keep this turn focused on one learning objective.`,
    `Use only the \`${teachingMcpServerName}\` MCP tools for durable course changes. Speak to the learner through the conversation response.`,
    "End the turn when the learner-facing response and any MCP writes are complete.",
  ].join("\n");
};

const positionTopicRecord = (
  topic: TurnPositionTopic & Readonly<{ state?: TopicNodeState }>,
): Record<string, unknown> => ({
  path: topic.path,
  title: topic.title,
  ...(topic.state === undefined ? {} : { state: topic.state }),
});

const positionBlock = (input: TurnPromptInput): string => {
  if (input.position.currentTopic === null) {
    return [
      "## Position",
      "",
      "No current topic is selected for this course.",
    ].join("\n");
  }

  const previousTopic = input.position.previousTopic;
  const payload = {
    currentTopic: positionTopicRecord(input.position.currentTopic),
    ...(previousTopic === undefined
      ? {}
      : {
          previousTopic:
            previousTopic === null ? null : positionTopicRecord(previousTopic),
        }),
    ...(input.position.revisit === undefined
      ? {}
      : { revisit: input.position.revisit }),
  };

  return [
    "## Position",
    "",
    "```json",
    JSON.stringify(payload, null, 2),
    "```",
  ].join("\n");
};

export const buildTurnPrompt = (input: TurnPromptInput): string =>
  [
    "# Overlearn daemon turn",
    "",
    "The daemon owns the event loop for this course. Your durable interface is only the overlearn-teaching MCP server plus the conversation with the learner.",
    "Do not write course files directly. Use only the MCP tools and the conversation response; no sidecar callback commands are available.",
    `Course id: ${input.courseId}`,
    `Course title: ${input.courseTitle}`,
    `Course description: ${input.courseDescription ?? "(none)"}`,
    positionBlock(input),
    resumePreamble(input),
    modePreamble(input),
    "## Teaching protocol",
    "",
    input.instructions,
    "## Turn payload",
    "",
    "Handle this JSON payload exactly once.",
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
  courseId: number,
  turn: TurnPayload,
  nextSequence: () => number,
  shouldBroadcast: () => boolean,
  onAgentEvent: (payload: AgentStreamPayload) => void,
): Promise<OrchestratorResult> => {
  try {
    for await (const event of events) {
      if (shouldBroadcast()) {
        onAgentEvent({
          courseId,
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
  courseId: number,
  turn: TurnPayload,
  timeoutMs: number,
  nextSequence: () => number,
  onAgentEvent: (payload: AgentStreamPayload) => void,
): Promise<PromptAttemptResult> => {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let suppressEvents = false;
  const consume = consumePrompt(
    adapter.prompt(session, prompt),
    courseId,
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

type ActiveSession = Readonly<{
  adapter: HarnessAdapter;
  session: SessionRef;
  teachingSession: ActiveTeachingSessionRegistration;
}>;

const mcpUrl = (baseUrl: string, token: string): string =>
  `${baseUrl.replace(/\/+$/, "")}/mcp/${encodeURIComponent(token)}`;

export const createDaemonTurnOrchestrator = (
  options: CreateDaemonTurnOrchestratorOptions,
): DaemonTurnOrchestrator => {
  const env = options.env ?? process.env;
  const timeoutMs = options.timeoutMs ?? resolveTurnTimeoutMs(env);
  let activeSession: ActiveSession | undefined;
  let nextTurnNeedsResumeContext = true;
  let sequence = 1;

  const nextSequence = (): number => {
    const current = sequence;
    sequence += 1;
    return current;
  };

  const endSession = async (reason = "ended"): Promise<void> => {
    const current = activeSession;
    activeSession = undefined;

    if (current !== undefined) {
      await current.adapter.end(current.session).catch(() => undefined);
      options.unregisterTeachingSession(current.teachingSession, reason);
    }
  };

  const resetSession = async (reason = "reset"): Promise<boolean> => {
    const hadActiveSession = activeSession !== undefined;
    await endSession(reason);
    nextTurnNeedsResumeContext = true;

    return hadActiveSession;
  };

  const ensureSession = async (): Promise<ActiveSession> => {
    if (activeSession !== undefined) {
      return activeSession;
    }

    const adapter =
      options.adapter ?? resolveHarnessAdapter(env, options.getHarnessId?.());
    const teachingSession = options.registerTeachingSession({
      courseId: options.courseId,
      harnessId: adapter.id,
    });

    try {
      const session = await adapter.newSession(options.cwd, {
        mcpServers: [
          {
            name: teachingMcpServerName,
            url: mcpUrl(options.mcpBaseUrl, teachingSession.token),
          },
        ],
        permissionPolicy: buildCoursePermissionPolicy(options.attachedDir),
        metadata: {
          courseId: options.courseId,
          orchestrated: true,
        },
      });
      activeSession = { adapter, session, teachingSession };

      return activeSession;
    } catch (error) {
      options.unregisterTeachingSession(teachingSession, "session-start-failed");
      throw error;
    }
  };

  const runAttempt = async (
    turn: TurnPayload,
    mode: TurnPromptMode,
    includeResumeContext: boolean,
    position: TurnPositionContext,
  ): Promise<OrchestratorResult> => {
    const active = await ensureSession();
    const instructions = formatInstructions(assembleInstructionModules({ env }));
    const courseMetadata = options.getCourseMetadata() ?? {
      title: `Course ${options.courseId}`,
      description: null,
    };
    const prompt = buildTurnPrompt({
      courseId: options.courseId,
      courseTitle: courseMetadata.title,
      courseDescription: courseMetadata.description,
      position,
      turn,
      instructions,
      includeResumeContext,
      mode,
    });
    const result = await runPromptWithTimeout(
      active.adapter,
      active.session,
      prompt,
      options.courseId,
      turn,
      timeoutMs,
      nextSequence,
      options.onAgentEvent,
    );

    if ("timedOut" in result) {
      await endSession("timeout");
      return {
        ok: false,
        reason: "timeout",
        message: "The agent timed out.",
      };
    }

    if (!result.ok) {
      await endSession(result.reason);
    }

    return result;
  };

  const runTurn = async (
    turn: TurnPayload,
    mode: TurnPromptMode,
    position: TurnPositionContext,
  ): Promise<OrchestratorResult> => {
    const includeResumeContext = nextTurnNeedsResumeContext;
    const first = await runAttempt(turn, mode, includeResumeContext, position);

    if (first.ok || first.reason === "timeout") {
      nextTurnNeedsResumeContext = !first.ok;
      return attemptFailureMessage(first);
    }

    const retry = await runAttempt(turn, mode, true, position);
    nextTurnNeedsResumeContext = !retry.ok;
    return attemptFailureMessage(retry);
  };

  return {
    endSession,
    hasActiveSession: () => activeSession !== undefined,
    resetSession,
    runTurn,
  };
};

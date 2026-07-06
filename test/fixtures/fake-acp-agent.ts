import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

type Scenario =
  | "normal"
  | "permission"
  | "never"
  | "crash-once"
  | "crash-always"
  | "malformed";
type JsonRpcId = string | number | null;
type JsonRpcMessage = Readonly<{
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
}>;

type PendingPrompt = Readonly<{
  id: JsonRpcId;
  cancelled: boolean;
}>;

const scenario = (process.argv[2] ??
  process.env["FAKE_ACP_SCENARIO"] ??
  "normal") as Scenario;
const sessionId = "fake-session";
const logPath = process.env["FAKE_ACP_LOG"];
const permissionPath = process.env["FAKE_ACP_PERMISSION_PATH"] ?? "lesson.md";
const crashMarkerPath = process.env["FAKE_ACP_CRASH_MARKER"];
let nextServerRequestId = 1;
let activePrompt: PendingPrompt | undefined;
let pendingPermission:
  | ((response: Readonly<{ selectedOptionId?: string }>) => void)
  | undefined;

const sleep = async (milliseconds: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const send = (value: unknown): void => {
  process.stdout.write(`${JSON.stringify(value)}\n`);
};

const log = (value: Record<string, unknown>): void => {
  if (logPath === undefined) {
    return;
  }

  appendFileSync(
    logPath,
    `${JSON.stringify({
      ...value,
      pid: process.pid,
      scenario,
    })}\n`,
  );
};

const sendRaw = (value: string): void => {
  process.stdout.write(value);
};

const respond = (id: JsonRpcId | undefined, result: unknown = {}): void => {
  if (id === undefined) {
    return;
  }

  send({
    jsonrpc: "2.0",
    id,
    result,
  });
};

const update = (value: unknown): void => {
  send({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId,
      update: value,
    },
  });
};

const textChunk = (sessionUpdate: string, text: string): unknown => ({
  sessionUpdate,
  content: {
    type: "text",
    text,
  },
});

const finishPrompt = (id: JsonRpcId, stopReason: string): void => {
  activePrompt = undefined;
  respond(id, { stopReason });
};

const runNormalTurn = async (promptId: JsonRpcId): Promise<void> => {
  await sleep(5);
  update(textChunk("agent_thought_chunk", "considering the lesson"));
  await sleep(5);
  update(textChunk("agent_message_chunk", "Here is the first explanation."));
  await sleep(5);
  update({
    sessionUpdate: "tool_call",
    toolCallId: "tool-1",
    title: "write_file",
    kind: "edit",
    status: "pending",
    rawInput: { path: "demo.ts" },
  });
  await sleep(5);
  update({
    sessionUpdate: "tool_call_update",
    toolCallId: "tool-1",
    status: "in_progress",
    content: [
      {
        type: "content",
        content: {
          type: "text",
          text: "writing demo.ts",
        },
      },
    ],
  });
  await sleep(5);
  update({
    sessionUpdate: "tool_call_update",
    toolCallId: "tool-1",
    status: "completed",
    rawOutput: { ok: true },
  });
  await sleep(5);
  finishPrompt(promptId, "end_turn");
};

const requestPermission = async (): Promise<string | undefined> => {
  const id = nextServerRequestId;
  nextServerRequestId += 1;

  send({
    jsonrpc: "2.0",
    id,
    method: "session/request_permission",
    params: {
      sessionId,
      toolCall: {
        toolCallId: "tool-1",
        title: "Write the generated lesson.",
        kind: "edit",
        locations: [{ path: permissionPath }],
      },
      options: [
        {
          optionId: "allow-once",
          name: "Allow once",
          kind: "allow_once",
        },
        {
          optionId: "reject-once",
          name: "Reject once",
          kind: "reject_once",
        },
      ],
    },
  });

  const response = await new Promise<Readonly<{ selectedOptionId?: string }>>(
    (resolve) => {
      pendingPermission = resolve;
    },
  );

  return response.selectedOptionId;
};

const runPermissionTurn = async (promptId: JsonRpcId): Promise<void> => {
  await sleep(5);
  update({
    sessionUpdate: "tool_call",
    toolCallId: "tool-1",
    title: "Write the generated lesson.",
    kind: "edit",
    status: "pending",
    locations: [{ path: permissionPath }],
  });

  const optionId = await requestPermission();

  await sleep(5);
  update(
    textChunk(
      "agent_message_chunk",
      optionId === "allow-once"
        ? "permission granted by fake"
        : "permission denied by fake",
    ),
  );
  await sleep(5);
  finishPrompt(promptId, "end_turn");
};

const runNeverTurn = async (): Promise<void> => {
  await sleep(5);
  update(textChunk("agent_thought_chunk", "waiting forever"));
};

const runCrashTurn = async (): Promise<void> => {
  await sleep(5);
  update(textChunk("agent_thought_chunk", "about to crash"));
  await sleep(5);
  process.exit(42);
};

const shouldCrashOnce = (): boolean => {
  if (crashMarkerPath === undefined) {
    return true;
  }

  if (existsSync(crashMarkerPath)) {
    return false;
  }

  writeFileSync(crashMarkerPath, "crashed\n");
  return true;
};

const runMalformedTurn = async (): Promise<void> => {
  await sleep(5);
  sendRaw("{malformed-json\n");
};

const runTurn = (promptId: JsonRpcId): void => {
  activePrompt = { id: promptId, cancelled: false };

  if (scenario === "permission") {
    void runPermissionTurn(promptId);
    return;
  }

  if (scenario === "never") {
    void runNeverTurn();
    return;
  }

  if (scenario === "crash-once") {
    if (shouldCrashOnce()) {
      void runCrashTurn();
    } else {
      void runNormalTurn(promptId);
    }
    return;
  }

  if (scenario === "crash-always") {
    void runCrashTurn();
    return;
  }

  if (scenario === "malformed") {
    void runMalformedTurn();
    return;
  }

  void runNormalTurn(promptId);
};

const selectedPermissionOption = (message: JsonRpcMessage): string | undefined => {
  if (!isRecord(message.params) && !isRecord(message)) {
    return undefined;
  }

  const result = isRecord(message["result"]) ? message["result"] : undefined;
  const outcome = isRecord(result?.["outcome"]) ? result["outcome"] : undefined;
  const optionId = outcome?.["optionId"];

  return typeof optionId === "string" ? optionId : undefined;
};

const input = createInterface({ input: process.stdin });

for await (const line of input) {
  const message = JSON.parse(line) as JsonRpcMessage;

  if (message.method === "initialize") {
    log({
      event: "initialize",
      env: {
        CLAUDECODE: process.env["CLAUDECODE"] ?? null,
      },
    });
    respond(message.id, {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: false,
        promptCapabilities: {
          image: false,
          audio: false,
          embeddedContext: false,
        },
        mcpCapabilities: {
          http: false,
          sse: false,
        },
      },
      authMethods: [],
      agentInfo: {
        name: "fake-acp-agent",
        version: "0.0.0",
      },
    });
    continue;
  }

  if (message.method === "session/new") {
    log({
      event: "session/new",
      params: message.params,
      sessionId,
    });
    respond(message.id, { sessionId });
    continue;
  }

  if (message.method === "session/prompt") {
    if (message.id === undefined) {
      continue;
    }

    log({
      event: "session/prompt",
      params: message.params,
      prompt: isRecord(message.params) ? message.params["prompt"] : undefined,
      sessionId,
    });
    runTurn(message.id);
    continue;
  }

  if (message.method === "session/cancel") {
    log({
      event: "session/cancel",
      params: message.params,
      sessionId,
    });
    const prompt = activePrompt;

    if (prompt !== undefined) {
      finishPrompt(prompt.id, "cancelled");
    }

    continue;
  }

  if (pendingPermission !== undefined && message.id === nextServerRequestId - 1) {
    pendingPermission({ selectedOptionId: selectedPermissionOption(message) });
    pendingPermission = undefined;
    continue;
  }

  respond(message.id);
}

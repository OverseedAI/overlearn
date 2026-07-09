import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

import {
  connectMcpClient,
  type McpJsonObject,
  type McpServerConnection,
} from "../../src/mcp/protocol";

type Scenario =
  | "normal"
  | "permission"
  | "mcp-permission"
  | "claude-mcp-permission"
  | "never"
  | "slow-initialize"
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

type FakeMcpCall = Readonly<{
  server: string;
  tool: string;
  args?: unknown;
}>;

const scenario = (process.argv[2] ??
  process.env["FAKE_ACP_SCENARIO"] ??
  "normal") as Scenario;
const sessionId = "fake-session";
const logPath = process.env["FAKE_ACP_LOG"];
const permissionPath = process.env["FAKE_ACP_PERMISSION_PATH"] ?? "lesson.md";
const permissionKind = process.env["FAKE_ACP_PERMISSION_KIND"] ?? "edit";
const permissionTitle =
  process.env["FAKE_ACP_PERMISSION_TITLE"] ?? "Write the generated lesson.";
const crashMarkerPath = process.env["FAKE_ACP_CRASH_MARKER"];
const rawMcpCall = process.env["FAKE_ACP_MCP_CALL"];
const rawMessageChunks = process.env["FAKE_ACP_MESSAGE_CHUNKS"];
let nextServerRequestId = 1;
let activePrompt: PendingPrompt | undefined;
let configuredMcpServers: readonly McpServerConnection[] = [];
let pendingPermission:
  | ((response: Readonly<{ selectedOptionId?: string }>) => void)
  | undefined;

const sleep = async (milliseconds: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const wireNameValueRecord = (
  value: unknown,
): Readonly<Record<string, string>> | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const result: Record<string, string> = {};

  for (const entry of value) {
    if (
      !isRecord(entry) ||
      typeof entry["name"] !== "string" ||
      typeof entry["value"] !== "string"
    ) {
      return undefined;
    }

    result[entry["name"]] = entry["value"];
  }

  return result;
};

const stringArray = (value: unknown): readonly string[] | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }

  return value.every((entry) => typeof entry === "string") ? value : undefined;
};

const mcpServerConnection = (
  value: unknown,
): McpServerConnection | undefined => {
  if (!isRecord(value) || typeof value["name"] !== "string") {
    return undefined;
  }

  if ("type" in value) {
    if (value["type"] !== "http" || typeof value["url"] !== "string") {
      return undefined;
    }

    const headers = wireNameValueRecord(value["headers"]);

    if (headers === undefined) {
      return undefined;
    }

    return {
      name: value["name"],
      url: value["url"],
      headers,
    };
  }

  if (typeof value["command"] === "string") {
    const args = stringArray(value["args"]);
    const env = wireNameValueRecord(value["env"]);

    if (args === undefined || env === undefined) {
      return undefined;
    }

    return {
      name: value["name"],
      command: value["command"],
      args,
      env,
    };
  }

  return undefined;
};

const wireMcpServers = (params: unknown): readonly unknown[] => {
  if (!isRecord(params) || !Array.isArray(params["mcpServers"])) {
    return [];
  }

  return params["mcpServers"];
};

const mcpServerConnections = (params: unknown): readonly McpServerConnection[] => {
  return wireMcpServers(params).map((server, index) => {
    const parsed = mcpServerConnection(server);

    if (parsed === undefined) {
      throw new Error(`Invalid ACP MCP server wire config at index ${index}.`);
    }

    return parsed;
  });
};

const parseOneMcpCall = (value: unknown): FakeMcpCall => {
  if (
    !isRecord(value) ||
    typeof value["server"] !== "string" ||
    typeof value["tool"] !== "string"
  ) {
    throw new Error("FAKE_ACP_MCP_CALL must include server and tool strings.");
  }

  return {
    server: value["server"],
    tool: value["tool"],
    ...(Object.hasOwn(value, "args") ? { args: value["args"] } : {}),
  };
};

// Accepts a single call object or an array of calls run in order.
const parseMcpCalls = (): readonly FakeMcpCall[] => {
  if (rawMcpCall === undefined || rawMcpCall.trim().length === 0) {
    return [];
  }

  const parsed = JSON.parse(rawMcpCall) as unknown;
  return Array.isArray(parsed)
    ? parsed.map(parseOneMcpCall)
    : [parseOneMcpCall(parsed)];
};

const fakeMcpCalls = parseMcpCalls();

const parseMessageChunks = (): readonly string[] => {
  if (rawMessageChunks === undefined || rawMessageChunks.trim().length === 0) {
    return ["Here is the first explanation."];
  }

  const parsed = JSON.parse(rawMessageChunks) as unknown;

  if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string")) {
    throw new Error("FAKE_ACP_MESSAGE_CHUNKS must be a JSON array of strings.");
  }

  return parsed;
};

const messageChunks = parseMessageChunks();

const mcpArgs = (args: unknown): McpJsonObject =>
  isRecord(args) ? (args as McpJsonObject) : {};

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

const runMcpCall = async (call: FakeMcpCall): Promise<void> => {
  await sleep(5);
  const toolCallId = `mcp-${call.tool}`;
  const server = configuredMcpServers.find(
    (candidate) => candidate.name === call.server,
  );

  update({
    sessionUpdate: "tool_call",
    toolCallId,
    title: call.tool,
    kind: "mcp",
    status: "pending",
    rawInput: mcpArgs(call.args),
  });

  if (server === undefined) {
    update({
      sessionUpdate: "tool_call_update",
      toolCallId,
      status: "failed",
      error: `MCP server was not configured: ${call.server}`,
    });
    return;
  }

  let client:
    | Awaited<ReturnType<typeof connectMcpClient>>
    | undefined;

  try {
    client = await connectMcpClient(server, {
      clientInfo: {
        name: "fake-acp-agent",
        version: "0.0.0",
      },
      requestTimeoutMs: 1_000,
    });
    const result = await client.callTool(call.tool, mcpArgs(call.args));

    log({
      event: "mcp/tools/call",
      server: call.server,
      tool: call.tool,
      args: mcpArgs(call.args),
      result,
    });
    update({
      sessionUpdate: "tool_call_update",
      toolCallId,
      status: result.isError === true ? "failed" : "completed",
      rawOutput: result,
    });
  } catch (error) {
    log({
      event: "mcp/error",
      server: call.server,
      tool: call.tool,
      message: error instanceof Error ? error.message : String(error),
    });
    update({
      sessionUpdate: "tool_call_update",
      toolCallId,
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    if (client !== undefined) {
      await client.close();
    }
  }
};

const runMcpTurn = async (
  promptId: JsonRpcId,
  calls: readonly FakeMcpCall[],
): Promise<void> => {
  for (const call of calls) {
    await runMcpCall(call);
  }

  await sleep(5);
  finishPrompt(promptId, "end_turn");
};

const attachmentSummary = (prompt: readonly unknown[]): string | undefined => {
  const attachments = prompt.filter(
    (block) =>
      isRecord(block) &&
      (block["type"] === "image" || block["type"] === "resource"),
  );
  if (attachments.length === 0) {
    return undefined;
  }

  const types = attachments.map((block) =>
    isRecord(block) && block["type"] === "image" ? "image" : "file",
  );
  return `Received ${attachments.length} attachment${attachments.length === 1 ? "" : "s"}: ${types.join(", ")}.`;
};

const runNormalTurn = async (
  promptId: JsonRpcId,
  prompt: readonly unknown[] = [],
): Promise<void> => {
  if (fakeMcpCalls.length > 0) {
    await runMcpTurn(promptId, fakeMcpCalls);
    return;
  }

  await sleep(5);
  update(textChunk("agent_thought_chunk", "considering the lesson"));
  const summary = attachmentSummary(prompt);
  if (summary !== undefined) {
    await sleep(5);
    update(textChunk("agent_message_chunk", summary));
  }
  for (const chunk of messageChunks) {
    await sleep(5);
    update(textChunk("agent_message_chunk", chunk));
  }
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
        title: permissionTitle,
        kind: permissionKind,
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
    title: permissionTitle,
    kind: permissionKind,
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

const runMcpPermissionTurn = async (promptId: JsonRpcId): Promise<void> => {
  const toolCallId = "mcp-call-1";

  await sleep(5);
  update({
    sessionUpdate: "tool_call",
    toolCallId,
    title: "mcp.overlearn-teaching.get_course_state",
    kind: "execute",
    status: "pending",
    rawInput: {
      server: "overlearn-teaching",
      tool: "get_course_state",
      arguments: {
        transcriptLimit: 10,
      },
    },
  });

  const id = nextServerRequestId;
  nextServerRequestId += 1;

  send({
    jsonrpc: "2.0",
    id,
    method: "session/request_permission",
    params: {
      sessionId,
      toolCall: {
        toolCallId,
        kind: "execute",
        status: "pending",
      },
      _meta: {
        is_mcp_tool_approval: true,
      },
      options: [
        {
          optionId: "allow_once",
          name: "Allow",
          kind: "allow_once",
        },
        {
          optionId: "decline",
          name: "Decline",
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

  await sleep(5);
  update(
    textChunk(
      "agent_message_chunk",
      response.selectedOptionId === "allow_once"
        ? "mcp permission granted by fake"
        : "mcp permission denied by fake",
    ),
  );
  await sleep(5);
  finishPrompt(promptId, "end_turn");
};

// Mirrors claude-code-acp's wire shape: the MCP tool is only identifiable by
// its "mcp__<server>__<tool>" title, with no _meta approval flag and no
// server/tool fields in rawInput.
const runClaudeMcpPermissionTurn = async (promptId: JsonRpcId): Promise<void> => {
  const toolCallId = "toolu_1";
  const toolTitle = "mcp__overlearn-teaching__get_course_state";

  await sleep(5);
  update({
    sessionUpdate: "tool_call",
    toolCallId,
    title: toolTitle,
    kind: "other",
    status: "pending",
    rawInput: {},
  });

  const id = nextServerRequestId;
  nextServerRequestId += 1;

  send({
    jsonrpc: "2.0",
    id,
    method: "session/request_permission",
    params: {
      sessionId,
      toolCall: {
        toolCallId,
        title: toolTitle,
        rawInput: {},
      },
      options: [
        {
          optionId: "allow_once",
          name: "Yes",
          kind: "allow_once",
        },
        {
          optionId: "reject_once",
          name: "No",
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

  await sleep(5);
  update(
    textChunk(
      "agent_message_chunk",
      response.selectedOptionId === "allow_once"
        ? "claude mcp permission granted by fake"
        : "claude mcp permission denied by fake",
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

const runTurn = (promptId: JsonRpcId, prompt: readonly unknown[] = []): void => {
  activePrompt = { id: promptId, cancelled: false };

  if (scenario === "permission") {
    void runPermissionTurn(promptId);
    return;
  }

  if (scenario === "mcp-permission") {
    void runMcpPermissionTurn(promptId);
    return;
  }

  if (scenario === "claude-mcp-permission") {
    void runClaudeMcpPermissionTurn(promptId);
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
      void runNormalTurn(promptId, prompt);
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

  void runNormalTurn(promptId, prompt);
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
    if (scenario === "slow-initialize") {
      await sleep(2_100);
    }
    respond(message.id, {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: false,
        promptCapabilities: {
          image: true,
          audio: false,
          embeddedContext: true,
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
    const receivedMcpServers = wireMcpServers(message.params);
    configuredMcpServers = mcpServerConnections(message.params);
    log({
      event: "session/new",
      params: message.params,
      mcpServers: receivedMcpServers,
      parsedMcpServers: configuredMcpServers,
      sessionId,
      codexConfig: process.env["CODEX_CONFIG"] ?? null,
      anthropicModel: process.env["ANTHROPIC_MODEL"] ?? null,
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
    const prompt =
      isRecord(message.params) && Array.isArray(message.params["prompt"])
        ? message.params["prompt"]
        : [];
    runTurn(message.id, prompt);
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

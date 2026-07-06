import { existsSync } from "node:fs";

import {
  defaultPermissionPolicy,
  evaluatePermissionRequest,
} from "./permissions";
import type {
  AdapterDetection,
  AgentEvent,
  ErrorAgentEvent,
  HarnessAdapter,
  HarnessAdapterId,
  HarnessMcpServerConfig,
  HarnessSessionConfig,
  JsonObject,
  JsonValue,
  PermissionPolicy,
  PermissionRequest,
  SessionRef,
  ToolCallAgentEvent,
} from "./types";

type Env = Readonly<Record<string, string | undefined>>;
type UnknownRecord = Record<string, unknown>;

type AcpMcpNameValue = Readonly<{
  name: string;
  value: string;
}>;

type AcpMcpStdioServer = Readonly<{
  name: string;
  command: string;
  args: readonly string[];
  env: readonly AcpMcpNameValue[];
}>;

type AcpMcpHttpServer = Readonly<{
  type: "http";
  name: string;
  url: string;
  headers: readonly AcpMcpNameValue[];
}>;

type AcpMcpServer = AcpMcpStdioServer | AcpMcpHttpServer;

export type AcpAuthDetection = Readonly<{
  env?: readonly string[];
  paths?: (env: Env) => readonly string[];
}>;

export type AcpAdapterDefinition = Readonly<{
  id: HarnessAdapterId;
  name: string;
  command: string;
  args: readonly string[];
  versionArgs?: readonly string[];
  auth?: AcpAuthDetection;
}>;

export type AcpAdapterOverride = Readonly<{
  command?: string;
  args?: readonly string[];
  env?: Env;
  requestTimeoutMs?: number;
}>;

type EventQueue<T> = Readonly<{
  push: (value: T) => void;
  close: () => void;
  iterable: AsyncIterable<T>;
}>;

type PendingRequest = Readonly<{
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout> | undefined;
}>;

type JsonRpcId = string | number | null;

type JsonRpcClient = Readonly<{
  process: Bun.Subprocess<"pipe", "pipe", "pipe">;
  request: (
    method: string,
    params?: unknown,
    options?: Readonly<{ timeoutMs?: number }>,
  ) => Promise<unknown>;
  notify: (method: string, params?: unknown) => Promise<void>;
  respond: (id: JsonRpcId, result: unknown) => Promise<void>;
  respondError: (
    id: JsonRpcId,
    code: number,
    message: string,
    data?: unknown,
  ) => Promise<void>;
  terminate: () => Promise<void>;
}>;

type TurnState = Readonly<{
  queue: EventQueue<AgentEvent>;
}>;

type AcpSessionState = {
  rpc: JsonRpcClient;
  acpSessionId: string;
  permissionPolicy: PermissionPolicy;
  currentTurn?: TurnState;
  ended: boolean;
};

type JsonRpcHandlers = Readonly<{
  onRequest: (method: string, params: unknown, id: JsonRpcId) => void;
  onNotification: (method: string, params: unknown) => void;
  onProtocolError: (error: Error) => void;
  onExit: (exitCode: number) => void;
}>;

const defaultRequestTimeoutMs = 2_000;
const cancelSafetyTimeoutMs = 500;
const processExitTimeoutMs = 1_000;
const sleep = async (milliseconds: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
};

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isJsonValue = (value: unknown): value is JsonValue => {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return true;
  }

  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }

  if (isRecord(value)) {
    return Object.values(value).every(isJsonValue);
  }

  return false;
};

const isJsonObject = (value: unknown): value is JsonObject =>
  isRecord(value) && Object.values(value).every(isJsonValue);

const optionalString = (
  record: UnknownRecord,
  key: string,
): string | undefined => {
  const value = record[key];

  return typeof value === "string" && value.length > 0 ? value : undefined;
};

const requiredString = (
  record: UnknownRecord,
  keys: readonly string[],
  fallback: string,
): string => {
  for (const key of keys) {
    const value = optionalString(record, key);

    if (value !== undefined) {
      return value;
    }
  }

  return fallback;
};

const createEventQueue = <T>(): EventQueue<T> => {
  const values: T[] = [];
  const waiters: Array<(result: IteratorResult<T>) => void> = [];
  let closed = false;

  const next = (): Promise<IteratorResult<T>> => {
    if (values.length > 0) {
      return Promise.resolve({
        done: false,
        value: values.shift() as T,
      });
    }

    if (closed) {
      return Promise.resolve({ done: true, value: undefined });
    }

    return new Promise((resolve) => {
      waiters.push(resolve);
    });
  };

  return {
    push: (value) => {
      if (closed) {
        return;
      }

      const waiter = waiters.shift();
      if (waiter !== undefined) {
        waiter({ done: false, value });
        return;
      }

      values.push(value);
    },
    close: () => {
      if (closed) {
        return;
      }

      closed = true;
      for (const waiter of waiters.splice(0)) {
        waiter({ done: true, value: undefined });
      }
    },
    iterable: {
      [Symbol.asyncIterator]: () => ({ next }),
    },
  };
};

const mergeEnv = (...envs: readonly Env[]): Record<string, string> => {
  const merged: Record<string, string> = {};

  for (const env of envs) {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) {
        delete merged[key];
        continue;
      }

      merged[key] = value;
    }
  }

  return merged;
};

const acpNameValueArray = (
  values: Readonly<Record<string, string>> | undefined,
): readonly AcpMcpNameValue[] =>
  Object.entries(values ?? {}).map(([name, value]) => ({ name, value }));

const acpMcpServer = (server: HarnessMcpServerConfig): AcpMcpServer => {
  if ("url" in server) {
    return {
      type: "http",
      name: server.name,
      url: server.url,
      headers: acpNameValueArray(server.headers),
    };
  }

  return {
    name: server.name,
    command: server.command,
    args: server.args,
    env: acpNameValueArray(server.env),
  };
};

const acpMcpServers = (
  servers: readonly HarnessMcpServerConfig[] | undefined,
): readonly AcpMcpServer[] => (servers ?? []).map(acpMcpServer);

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const responseError = (message: UnknownRecord): Error => {
  const error = message["error"];

  if (isRecord(error)) {
    const code =
      typeof error["code"] === "number" ? ` ${error["code"]}` : "";
    const text =
      typeof error["message"] === "string" ? error["message"] : "unknown error";

    return new Error(`JSON-RPC error${code}: ${text}`);
  }

  return new Error("JSON-RPC response contained an invalid error object.");
};

const requestIdKey = (id: unknown): string | undefined => {
  if (id === null) {
    return "null";
  }

  if (typeof id === "string" || typeof id === "number") {
    return String(id);
  }

  return undefined;
};

const createLineReader = (
  onLine: (line: string) => void,
): ((chunk: Uint8Array) => void) => {
  const textDecoder = new TextDecoder();
  let buffered = "";

  return (chunk) => {
    buffered += textDecoder.decode(chunk, { stream: true });

    while (true) {
      const newline = buffered.indexOf("\n");

      if (newline === -1) {
        break;
      }

      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      onLine(line);
    }
  };
};

const readLines = async (
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
): Promise<void> => {
  const readChunk = createLineReader(onLine);
  const reader = stream.getReader();

  while (true) {
    const chunk = await reader.read();

    if (chunk.done) {
      return;
    }

    readChunk(chunk.value);
  }
};

const drainText = async (
  stream: ReadableStream<Uint8Array>,
  onText: (text: string) => void,
): Promise<void> => {
  const reader = stream.getReader();
  const textDecoder = new TextDecoder();

  while (true) {
    const chunk = await reader.read();

    if (chunk.done) {
      return;
    }

    onText(textDecoder.decode(chunk.value, { stream: true }));
  }
};

const writeJsonLine = async (
  process: Bun.Subprocess<"pipe", "pipe", "pipe">,
  value: unknown,
): Promise<void> => {
  const written = process.stdin.write(`${JSON.stringify(value)}\n`);

  if (written instanceof Promise) {
    await written;
  }

  const flushed = process.stdin.flush();

  if (flushed instanceof Promise) {
    await flushed;
  }
};

const closeStdin = async (
  process: Bun.Subprocess<"pipe", "pipe", "pipe">,
): Promise<void> => {
  try {
    const ended = process.stdin.end();

    if (ended instanceof Promise) {
      await ended;
    }
  } catch {
    // The child may have already closed the pipe.
  }
};

const rejectPending = (
  pending: Map<string, PendingRequest>,
  error: Error,
): void => {
  for (const [id, request] of pending) {
    if (request.timeout !== undefined) {
      clearTimeout(request.timeout);
    }

    request.reject(error);
    pending.delete(id);
  }
};

const startJsonRpcClient = (
  commandLine: readonly string[],
  options: Readonly<{
    cwd: string;
    env: Env;
    requestTimeoutMs: number;
  }>,
  handlers: JsonRpcHandlers,
): JsonRpcClient => {
  const [command, ...args] = commandLine;

  if (command === undefined) {
    throw new Error("ACP adapter command line must not be empty.");
  }

  const pending = new Map<string, PendingRequest>();
  let nextId = 1;
  let closed = false;
  let stderr = "";

  const protocolError = (error: Error): void => {
    if (closed) {
      return;
    }

    closed = true;
    rejectPending(pending, error);
    handlers.onProtocolError(error);
  };

  const handleMessage = (line: string): void => {
    const trimmed = line.trim();

    if (trimmed.length === 0) {
      return;
    }

    let parsed: unknown;

    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch (error) {
      protocolError(
        new Error(`Malformed JSON-RPC message: ${trimmed.slice(0, 160)}`, {
          cause: error,
        }),
      );
      return;
    }

    if (!isRecord(parsed)) {
      protocolError(new Error("JSON-RPC message must be an object."));
      return;
    }

    const hasId = Object.hasOwn(parsed, "id");
    const id = requestIdKey(parsed["id"]);

    if (hasId && id !== undefined && ("result" in parsed || "error" in parsed)) {
      const request = pending.get(id);

      if (request === undefined) {
        return;
      }

      if (request.timeout !== undefined) {
        clearTimeout(request.timeout);
      }

      pending.delete(id);

      if ("error" in parsed) {
        request.reject(responseError(parsed));
        return;
      }

      request.resolve(parsed["result"]);
      return;
    }

    const method = parsed["method"];

    if (typeof method === "string" && hasId && id !== undefined) {
      handlers.onRequest(method, parsed["params"], parsed["id"] as JsonRpcId);
      return;
    }

    if (typeof method === "string") {
      handlers.onNotification(method, parsed["params"]);
      return;
    }

    protocolError(new Error("JSON-RPC message was neither response nor notification."));
  };

  const childProcess = Bun.spawn([command, ...args], {
    cwd: options.cwd,
    env: mergeEnv(process.env, options.env),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  void readLines(childProcess.stdout, handleMessage).catch((error) => {
    protocolError(new Error(`Failed reading ACP stdout: ${errorMessage(error)}`));
  });

  void drainText(childProcess.stderr, (text) => {
    stderr = `${stderr}${text}`.slice(-8_000);
  });

  const exited = childProcess.exited.then((exitCode) => {
    const error = new Error(
      stderr.trim().length > 0
        ? `ACP subprocess exited with code ${exitCode}: ${stderr.trim()}`
        : `ACP subprocess exited with code ${exitCode}.`,
    );

    closed = true;
    rejectPending(pending, error);
    handlers.onExit(exitCode);
    return exitCode;
  });

  const request = async (
    method: string,
    params?: unknown,
    requestOptions: Readonly<{ timeoutMs?: number }> = {
      timeoutMs: options.requestTimeoutMs,
    },
  ): Promise<unknown> => {
    if (closed) {
      throw new Error("ACP subprocess is not running.");
    }

    const id = nextId;
    nextId += 1;

    const promise = new Promise<unknown>((resolve, reject) => {
      const timeout =
        requestOptions.timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              pending.delete(String(id));
              reject(new Error(`JSON-RPC request timed out: ${method}`));
            }, requestOptions.timeoutMs);

      pending.set(String(id), { resolve, reject, timeout });
    });

    try {
      await writeJsonLine(childProcess, {
        jsonrpc: "2.0",
        id,
        method,
        ...(params === undefined ? {} : { params }),
      });
    } catch (error) {
      const pendingRequest = pending.get(String(id));

      if (pendingRequest !== undefined) {
        if (pendingRequest.timeout !== undefined) {
          clearTimeout(pendingRequest.timeout);
        }

        pending.delete(String(id));
      }

      throw new Error(
        `Failed writing JSON-RPC request ${method}: ${errorMessage(error)}`,
        { cause: error },
      );
    }

    return await promise;
  };

  const notify = async (method: string, params?: unknown): Promise<void> => {
    if (closed) {
      return;
    }

    await writeJsonLine(childProcess, {
      jsonrpc: "2.0",
      method,
      ...(params === undefined ? {} : { params }),
    });
  };

  const respond = async (id: JsonRpcId, result: unknown): Promise<void> => {
    if (closed) {
      return;
    }

    await writeJsonLine(childProcess, {
      jsonrpc: "2.0",
      id,
      result,
    });
  };

  const respondError = async (
    id: JsonRpcId,
    code: number,
    message: string,
    data?: unknown,
  ): Promise<void> => {
    if (closed) {
      return;
    }

    await writeJsonLine(childProcess, {
      jsonrpc: "2.0",
      id,
      error: {
        code,
        message,
        ...(data === undefined ? {} : { data }),
      },
    });
  };

  const terminate = async (): Promise<void> => {
    closed = true;
    rejectPending(pending, new Error("ACP subprocess was terminated."));
    await closeStdin(childProcess);

    if (childProcess.exitCode !== null || childProcess.signalCode !== null) {
      await exited;
      return;
    }

    childProcess.kill("SIGTERM");
    const didExit = await Promise.race([
      exited.then(() => true),
      sleep(processExitTimeoutMs).then(() => false),
    ]);

    if (didExit) {
      return;
    }

    childProcess.kill("SIGKILL");
    await exited;
  };

  return {
    process: childProcess,
    request,
    notify,
    respond,
    respondError,
    terminate,
  };
};

const normalizeSessionId = (result: unknown): string => {
  if (isRecord(result)) {
    const id =
      optionalString(result, "sessionId") ??
      optionalString(result, "session_id") ??
      optionalString(result, "id");

    if (id !== undefined) {
      return id;
    }
  }

  if (typeof result === "string" && result.length > 0) {
    return result;
  }

  throw new Error("ACP session creation returned no session id.");
};

const normalizeUpdate = (params: unknown): UnknownRecord | undefined => {
  if (!isRecord(params)) {
    return undefined;
  }

  const update = params["update"];

  if (isRecord(update)) {
    return update;
  }

  return params;
};

const notificationSessionId = (params: unknown): string | undefined => {
  if (!isRecord(params)) {
    return undefined;
  }

  return (
    optionalString(params, "sessionId") ??
    optionalString(params, "session_id") ??
    optionalString(params, "id")
  );
};

const textFromContentBlock = (value: unknown): string => {
  if (!isRecord(value)) {
    return "";
  }

  if (optionalString(value, "type") === "text") {
    return optionalString(value, "text") ?? "";
  }

  return "";
};

const textFromToolContent = (value: unknown): string => {
  if (!Array.isArray(value)) {
    return "";
  }

  return value
    .map((entry) => {
      if (!isRecord(entry)) {
        return "";
      }

      if (optionalString(entry, "type") === "content") {
        return textFromContentBlock(entry["content"]);
      }

      if (optionalString(entry, "type") === "diff") {
        return optionalString(entry, "path") ?? "";
      }

      return "";
    })
    .filter((text) => text.length > 0)
    .join("\n");
};

const updateText = (update: UnknownRecord): string => {
  const contentText = textFromContentBlock(update["content"]);

  if (contentText.length > 0) {
    return contentText;
  }

  return requiredString(update, ["text", "delta", "message"], "");
};

const normalizeToolStatus = (
  updateType: string,
  update: UnknownRecord,
): ToolCallAgentEvent["status"] => {
  const raw = optionalString(update, "status") ?? updateType;

  if (["delta", "running", "progress", "in_progress"].includes(raw)) {
    return "delta";
  }

  if (["completed", "complete", "done", "result", "finished"].includes(raw)) {
    return "completed";
  }

  if (["failed", "error"].includes(raw)) {
    return "failed";
  }

  return "started";
};

const normalizeToolCall = (
  updateType: string,
  update: UnknownRecord,
): ToolCallAgentEvent => {
  const id = requiredString(
    update,
    ["id", "toolCallId", "tool_call_id", "callId"],
    "tool-call",
  );
  const name =
    optionalString(update, "title") ??
    optionalString(update, "name") ??
    optionalString(update, "toolName") ??
    optionalString(update, "kind");
  const status = normalizeToolStatus(updateType, update);
  const input = isJsonValue(update["rawInput"])
    ? update["rawInput"]
    : isJsonValue(update["input"])
      ? update["input"]
      : undefined;
  const result = isJsonValue(update["rawOutput"])
    ? update["rawOutput"]
    : isJsonValue(update["result"])
      ? update["result"]
      : undefined;
  const toolText = textFromToolContent(update["content"]);
  const text = toolText.length > 0 ? toolText : updateText(update);
  const error = optionalString(update, "error");

  return {
    type: "tool-call",
    id,
    status,
    ...(name === undefined ? {} : { name }),
    ...(input === undefined ? {} : { input }),
    ...(text.length === 0 ? {} : { text }),
    ...(result === undefined ? {} : { result }),
    ...(error === undefined ? {} : { error }),
  };
};

const normalizePermissionRequest = (
  update: UnknownRecord,
): PermissionRequest => {
  const metadata = isJsonObject(update["metadata"]) ? update["metadata"] : undefined;
  const resource = optionalString(update, "resource");
  const description = optionalString(update, "description");

  return {
    id: requiredString(
      update,
      ["id", "requestId", "request_id", "permissionId", "permission_id"],
      "permission",
    ),
    action: requiredString(update, ["action", "operation", "tool"], "unknown"),
    ...(resource === undefined ? {} : { resource }),
    ...(description === undefined ? {} : { description }),
    ...(metadata === undefined ? {} : { metadata }),
  };
};

const finishTurn = (
  state: AcpSessionState,
  event: AgentEvent,
): void => {
  const turn = state.currentTurn;

  if (turn === undefined) {
    return;
  }

  turn.queue.push(event);
  turn.queue.close();
  delete state.currentTurn;
};

const pushTurnEvent = (state: AcpSessionState, event: AgentEvent): void => {
  const turn = state.currentTurn;

  if (turn === undefined) {
    return;
  }

  if (event.type === "done" || event.type === "error") {
    finishTurn(state, event);
    return;
  }

  turn.queue.push(event);
};

const mapUpdateToEvent = (
  update: UnknownRecord,
): AgentEvent | PermissionRequest | undefined => {
  const updateType =
    optionalString(update, "sessionUpdate") ??
    requiredString(update, ["type", "kind"], "message");

  if (
    ["agent_thought_chunk", "thinking", "thought", "reasoning"].includes(
      updateType,
    )
  ) {
    return { type: "thinking", text: updateText(update) };
  }

  if (
    ["agent_message_chunk", "text", "message", "assistant_message", "content"].includes(
      updateType,
    )
  ) {
    return { type: "text", text: updateText(update) };
  }

  if (
    [
      "tool-call",
      "tool_call",
      "tool-call-delta",
      "tool_call_delta",
      "tool-call-result",
      "tool_call_result",
      "tool_call",
      "tool_call_update",
    ].includes(updateType)
  ) {
    return normalizeToolCall(updateType, update);
  }

  if (
    ["permission-request", "permission_request", "permission"].includes(updateType)
  ) {
    return normalizePermissionRequest(update);
  }

  if (["done", "complete", "completed"].includes(updateType)) {
    return { type: "done", reason: "complete" };
  }

  if (["error", "failed"].includes(updateType)) {
    return {
      type: "error",
      message: requiredString(update, ["message", "error"], "ACP turn failed."),
    };
  }

  return undefined;
};

const firstLocationPath = (value: unknown): string | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }

  for (const entry of value) {
    if (!isRecord(entry)) {
      continue;
    }

    const path = optionalString(entry, "path");

    if (path !== undefined) {
      return path;
    }
  }

  return undefined;
};

const rawInputPath = (value: unknown): string | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  return optionalString(value, "path") ?? optionalString(value, "file");
};

const normalizeAcpPermissionRequest = (
  params: unknown,
  id: JsonRpcId,
): PermissionRequest => {
  const record = isRecord(params) ? params : {};
  const toolCall = isRecord(record["toolCall"]) ? record["toolCall"] : {};
  const metadata = isJsonObject(toolCall) ? toolCall : undefined;
  const title = optionalString(toolCall, "title");
  const resource =
    firstLocationPath(toolCall["locations"]) ??
    rawInputPath(toolCall["rawInput"]) ??
    title;

  return {
    id: String(id),
    action: optionalString(toolCall, "kind") ?? title ?? "unknown",
    ...(resource === undefined ? {} : { resource }),
    ...(title === undefined ? {} : { description: title }),
    ...(metadata === undefined ? {} : { metadata }),
  };
};

const permissionOptions = (params: unknown): readonly UnknownRecord[] => {
  if (!isRecord(params) || !Array.isArray(params["options"])) {
    return [];
  }

  return params["options"].filter(isRecord);
};

const optionKindMatches = (
  option: UnknownRecord,
  kinds: readonly string[],
): boolean => {
  const kind = optionalString(option, "kind");

  return kind !== undefined && kinds.includes(kind);
};

const choosePermissionOption = (
  options: readonly UnknownRecord[],
  allowed: boolean,
): string | undefined => {
  const preferredKinds = allowed
    ? ["allow_once", "allow_always"]
    : ["reject_once", "reject_always"];
  const fallbackKinds = allowed
    ? ["allow_always", "allow_once"]
    : ["reject_always", "reject_once"];
  const preferred =
    preferredKinds
      .map((kind) =>
        options.find((option) => optionalString(option, "kind") === kind),
      )
      .find((option) => option !== undefined) ??
    options.find((option) => optionKindMatches(option, fallbackKinds));
  const optionId =
    preferred === undefined ? undefined : optionalString(preferred, "optionId");

  if (optionId !== undefined) {
    return optionId;
  }

  const firstOption = options[0];

  return firstOption === undefined
    ? undefined
    : optionalString(firstOption, "optionId");
};

const handlePermissionRequest = async (
  state: AcpSessionState,
  params: unknown,
  id: JsonRpcId,
): Promise<void> => {
  const request = normalizeAcpPermissionRequest(params, id);
  const decision = evaluatePermissionRequest(request, state.permissionPolicy);
  const optionId = choosePermissionOption(
    permissionOptions(params),
    decision.allowed,
  );

  pushTurnEvent(state, {
    type: "permission-request",
    request,
    decision,
  });

  if (optionId === undefined) {
    await state.rpc.respondError(
      id,
      -32602,
      "Permission request did not include selectable options.",
    );
    return;
  }

  await state.rpc.respond(id, {
    outcome: {
      outcome: "selected",
      optionId,
    },
  });
};

const handleRequest = (
  state: AcpSessionState | undefined,
  rpc: JsonRpcClient,
  method: string,
  params: unknown,
  id: JsonRpcId,
): void => {
  if (method === "session/request_permission") {
    if (state === undefined) {
      void rpc.respondError(id, -32000, "No active ACP session.");
      return;
    }

    void handlePermissionRequest(state, params, id).catch((error) => {
      void rpc.respondError(
        id,
        -32000,
        `Permission request failed: ${errorMessage(error)}`,
      );
    });
    return;
  }

  void rpc.respondError(
    id,
    -32601,
    `ACP client method is not supported: ${method}`,
  );
};

const handleNotification = (
  state: AcpSessionState,
  method: string,
  params: unknown,
): void => {
  if (method !== "session/update") {
    return;
  }

  const sessionId = notificationSessionId(params);

  if (sessionId !== undefined && sessionId !== state.acpSessionId) {
    return;
  }

  const update = normalizeUpdate(params);

  if (update === undefined) {
    return;
  }

  const event = mapUpdateToEvent(update);

  if (event === undefined) {
    return;
  }

  if (!("type" in event)) {
    const decision = evaluatePermissionRequest(event, state.permissionPolicy);

    pushTurnEvent(state, {
      type: "permission-request",
      request: event,
      decision,
    });
    return;
  }

  pushTurnEvent(state, event);
};

const sessionError = (
  state: AcpSessionState | undefined,
  event: ErrorAgentEvent,
): void => {
  if (state === undefined) {
    return;
  }

  finishTurn(state, event);
};

const promptDoneEvent = (result: unknown): AgentEvent => {
  const stopReason = isRecord(result)
    ? optionalString(result, "stopReason")
    : undefined;

  if (stopReason === "cancelled") {
    return {
      type: "done",
      reason: "cancelled",
    };
  }

  // A refusal means the agent deliberately did not continue the turn, so surface
  // it as a terminal error rather than a successful completion.
  if (stopReason === "refusal") {
    return {
      type: "error",
      message: "ACP prompt stopped with refusal.",
    };
  }

  return {
    type: "done",
    reason: "complete",
  };
};

const detectAuthenticated = (
  auth: AcpAuthDetection | undefined,
  env: Env,
): boolean => {
  if (auth === undefined) {
    return false;
  }

  if (
    auth.env?.some((key) => {
      const value = env[key];

      return value !== undefined && value.trim().length > 0;
    }) === true
  ) {
    return true;
  }

  return auth.paths?.(env).some((path) => existsSync(path)) ?? false;
};

const detectVersion = (
  command: string,
  versionArgs: readonly string[] | undefined,
  env: Env,
): string | undefined => {
  if (versionArgs === undefined || versionArgs.length === 0) {
    return undefined;
  }

  try {
    const result = Bun.spawnSync({
      cmd: [command, ...versionArgs],
      env: mergeEnv(process.env, env),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = result.stdout.toString("utf8").trim();
    const stderr = result.stderr.toString("utf8").trim();
    const text = stdout.length > 0 ? stdout : stderr;

    return text.length === 0 ? undefined : text.split("\n")[0]?.trim();
  } catch {
    return undefined;
  }
};

const detectAdapter = (
  definition: AcpAdapterDefinition,
  override: AcpAdapterOverride,
): AdapterDetection => {
  const command = override.command ?? definition.command;
  const env = mergeEnv(process.env, override.env ?? {});
  const path =
    env["PATH"] === undefined
      ? Bun.which(command)
      : Bun.which(command, { PATH: env["PATH"] });

  if (path === null) {
    return {
      installed: false,
      authenticated: false,
    };
  }

  const version = detectVersion(command, definition.versionArgs, env);
  const detection = {
    installed: true,
    authenticated: detectAuthenticated(definition.auth, env),
  };

  return version === undefined ? detection : { ...detection, version };
};

const requireSession = (
  sessions: WeakMap<SessionRef, AcpSessionState>,
  session: SessionRef,
): AcpSessionState => {
  const state = sessions.get(session);

  if (state === undefined || state.ended) {
    throw new Error("Unknown or ended harness session.");
  }

  return state;
};

export const createAcpHarnessAdapter = (
  definition: AcpAdapterDefinition,
  override: AcpAdapterOverride = {},
): HarnessAdapter => {
  const sessions = new WeakMap<SessionRef, AcpSessionState>();

  return {
    id: definition.id,
    name: definition.name,
    detect: () => detectAdapter(definition, override),
    newSession: async (cwd, config: HarnessSessionConfig = {}) => {
      let state: AcpSessionState | undefined;
      const requestTimeoutMs =
        override.requestTimeoutMs ?? defaultRequestTimeoutMs;
      const commandLine = [
        override.command ?? definition.command,
        ...(override.args ?? definition.args),
      ];
      const rpc = startJsonRpcClient(
        commandLine,
        {
          cwd,
          env: override.env ?? {},
          requestTimeoutMs,
        },
        {
          onRequest: (method, params, id) => {
            handleRequest(state, rpc, method, params, id);
          },
          onNotification: (method, params) => {
            if (state !== undefined) {
              handleNotification(state, method, params);
            }
          },
          onProtocolError: (error) => {
            sessionError(state, {
              type: "error",
              message: error.message,
            });
            void rpc.terminate();
          },
          onExit: (exitCode) => {
            if (state !== undefined) {
              state.ended = true;
            }

            sessionError(state, {
              type: "error",
              message: `ACP subprocess exited with code ${exitCode}.`,
            });
          },
        },
      );

      try {
        await rpc.request("initialize", {
          protocolVersion: 1,
          clientCapabilities: {
            fs: {
              readTextFile: false,
              writeTextFile: false,
            },
            terminal: false,
          },
          clientInfo: {
            name: "overlearn",
            version: "0.0.0",
          },
        });
        const sessionId = normalizeSessionId(
          await rpc.request("session/new", {
            cwd,
            mcpServers: acpMcpServers(config.mcpServers),
          }),
        );
        const processId = rpc.process.pid;

        if (processId === undefined) {
          throw new Error("ACP subprocess did not report a process id.");
        }

        const ref: SessionRef = {
          id: sessionId,
          adapterId: definition.id,
          cwd,
          processId,
        };

        state = {
          rpc,
          acpSessionId: sessionId,
          permissionPolicy: config.permissionPolicy ?? defaultPermissionPolicy,
          ended: false,
        };
        sessions.set(ref, state);

        return ref;
      } catch (error) {
        await rpc.terminate();
        throw error;
      }
    },
    prompt: (session, content) => {
      let state: AcpSessionState;

      try {
        state = requireSession(sessions, session);
      } catch (error) {
        const queue = createEventQueue<AgentEvent>();
        queue.push({
          type: "error",
          message: errorMessage(error),
        });
        queue.close();
        return queue.iterable;
      }

      const queue = createEventQueue<AgentEvent>();

      if (state.currentTurn !== undefined) {
        queue.push({
          type: "error",
          message: "A prompt turn is already active for this harness session.",
        });
        queue.close();
        return queue.iterable;
      }

      const turn = { queue };
      state.currentTurn = turn;

      void state.rpc
        .request("session/prompt", {
          sessionId: state.acpSessionId,
          prompt: [
            {
              type: "text",
              text: content,
            },
          ],
        }, {})
        .then((result) => {
          if (state.currentTurn === turn) {
            finishTurn(state, promptDoneEvent(result));
          }
        })
        .catch((error) => {
          if (state.currentTurn === turn) {
            finishTurn(state, {
              type: "error",
              message: errorMessage(error),
            });
          }
        });

      return queue.iterable;
    },
    cancel: async (session) => {
      const state = requireSession(sessions, session);

      if (state.currentTurn === undefined) {
        return;
      }

      const turn = state.currentTurn;

      await state.rpc.notify("session/cancel", {
        sessionId: state.acpSessionId,
      });

      setTimeout(() => {
        if (state.currentTurn === turn) {
          finishTurn(state, {
            type: "done",
            reason: "cancelled",
          });
        }
      }, cancelSafetyTimeoutMs);
    },
    end: async (session) => {
      const state = sessions.get(session);

      if (state === undefined || state.ended) {
        return;
      }

      state.ended = true;

      try {
        if (state.currentTurn !== undefined) {
          await state.rpc
            .notify("session/cancel", {
              sessionId: state.acpSessionId,
            })
            .catch(() => undefined);
        }
      } finally {
        finishTurn(state, {
          type: "done",
          reason: "cancelled",
        });
        await state.rpc.terminate();
        sessions.delete(session);
      }
    },
  };
};

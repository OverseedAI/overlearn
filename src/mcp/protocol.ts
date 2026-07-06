import { createInterface } from "node:readline";

export type McpJsonPrimitive = string | number | boolean | null;
export type McpJsonObject = Readonly<{ [key: string]: McpJsonValue }>;
export type McpJsonValue =
  | McpJsonPrimitive
  | McpJsonObject
  | readonly McpJsonValue[];

export type McpClientInfo = Readonly<{
  name: string;
  version: string;
}>;

export type McpServerInfo = Readonly<{
  name: string;
  version: string;
}>;

export type McpTool = Readonly<{
  name: string;
  description?: string;
  inputSchema: McpJsonObject;
}>;

export type McpToolCallResult = Readonly<{
  content: readonly McpTextContent[];
  isError?: boolean;
}>;

export type McpTextContent = Readonly<{
  type: "text";
  text: string;
}>;

export type McpServerTool = McpTool &
  Readonly<{
    call: (args: McpJsonObject) => McpToolCallResult | Promise<McpToolCallResult>;
  }>;

export type McpServerDefinition = Readonly<{
  name: string;
  version?: string;
  tools: readonly McpServerTool[];
}>;

export type McpInitializeResult = Readonly<{
  protocolVersion: typeof mcpProtocolVersion;
  capabilities: Readonly<{
    tools: McpJsonObject;
  }>;
  serverInfo: McpServerInfo;
}>;

export type McpStdioServerConnection = Readonly<{
  name: string;
  command: string;
  args?: readonly string[];
  env?: Readonly<Record<string, string | undefined>>;
  cwd?: string;
}>;

export type McpHttpServerConnection = Readonly<{
  name: string;
  url: string;
  headers?: Readonly<Record<string, string>>;
}>;

export type McpServerConnection =
  | McpStdioServerConnection
  | McpHttpServerConnection;

export type McpClient = Readonly<{
  initialize: () => Promise<McpInitializeResult>;
  listTools: () => Promise<readonly McpTool[]>;
  callTool: (
    name: string,
    args?: McpJsonObject,
  ) => Promise<McpToolCallResult>;
  close: () => Promise<void>;
}>;

export type RunningMcpHttpServer = Readonly<{
  url: string;
  stop: () => void;
}>;

export type McpHttpHandlerOptions = Readonly<{
  sessionId?: string | ((request: Request) => string);
}>;

type Env = Readonly<Record<string, string | undefined>>;
type UnknownRecord = Record<string, unknown>;
type JsonRpcId = string | number | null;

type PendingRequest = Readonly<{
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout> | undefined;
}>;

type JsonRpcResponse = Readonly<{
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: Readonly<{
    code: number;
    message: string;
    data?: unknown;
  }>;
}>;

export const mcpProtocolVersion = "2025-06-18";
const defaultRequestTimeoutMs = 2_000;
const processExitTimeoutMs = 1_000;
const randomLoopbackPort = (): number =>
  20_000 + Math.floor(Math.random() * 20_000);

const sleep = async (milliseconds: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
};

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isJsonValue = (value: unknown): value is McpJsonValue => {
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

const isJsonObject = (value: unknown): value is McpJsonObject =>
  isRecord(value) && Object.values(value).every(isJsonValue);

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

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

const requestIdKey = (id: unknown): string | undefined => {
  if (id === null) {
    return "null";
  }

  if (typeof id === "string" || typeof id === "number") {
    return String(id);
  }

  return undefined;
};

const normalizeRequestId = (value: unknown): JsonRpcId =>
  value === null || typeof value === "string" || typeof value === "number"
    ? value
    : null;

const jsonRpcResult = (id: JsonRpcId, result: unknown): JsonRpcResponse => ({
  jsonrpc: "2.0",
  id,
  result,
});

const jsonRpcError = (
  id: JsonRpcId,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse => ({
  jsonrpc: "2.0",
  id,
  error: {
    code,
    message,
    ...(data === undefined ? {} : { data }),
  },
});

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

const publicTool = (tool: McpServerTool): McpTool => ({
  name: tool.name,
  ...(tool.description === undefined ? {} : { description: tool.description }),
  inputSchema: tool.inputSchema,
});

const initializeResult = (server: McpServerDefinition): McpInitializeResult => ({
  protocolVersion: mcpProtocolVersion,
  capabilities: {
    tools: {},
  },
  serverInfo: {
    name: server.name,
    version: server.version ?? "0.0.0",
  },
});

const toolCallArguments = (params: unknown): McpJsonObject | undefined => {
  if (!isRecord(params)) {
    return undefined;
  }

  const args = params["arguments"];

  if (args === undefined) {
    return {};
  }

  return isJsonObject(args) ? args : undefined;
};

const toolName = (params: unknown): string | undefined => {
  if (!isRecord(params)) {
    return undefined;
  }

  const name = params["name"];

  return typeof name === "string" && name.length > 0 ? name : undefined;
};

const handleMcpRequest = async (
  server: McpServerDefinition,
  method: string,
  params: unknown,
  id: JsonRpcId,
): Promise<JsonRpcResponse> => {
  if (method === "initialize") {
    return jsonRpcResult(id, initializeResult(server));
  }

  if (method === "tools/list") {
    return jsonRpcResult(id, {
      tools: server.tools.map(publicTool),
    });
  }

  if (method === "tools/call") {
    const name = toolName(params);
    const args = toolCallArguments(params);

    if (name === undefined || args === undefined) {
      return jsonRpcError(id, -32602, "Invalid tools/call parameters.");
    }

    const tool = server.tools.find((candidate) => candidate.name === name);

    if (tool === undefined) {
      return jsonRpcError(id, -32602, `Unknown MCP tool: ${name}`);
    }

    try {
      return jsonRpcResult(id, await tool.call(args));
    } catch (error) {
      return jsonRpcError(
        id,
        -32603,
        `MCP tool failed: ${errorMessage(error)}`,
      );
    }
  }

  return jsonRpcError(id, -32601, `MCP method is not supported: ${method}`);
};

const handleMcpNotification = (method: string): void => {
  if (method === "notifications/initialized") {
    return;
  }
};

const handleMcpMessage = async (
  server: McpServerDefinition,
  message: unknown,
): Promise<JsonRpcResponse | undefined> => {
  if (!isRecord(message)) {
    return jsonRpcError(null, -32600, "JSON-RPC message must be an object.");
  }

  const method = message["method"];

  if (typeof method !== "string") {
    return jsonRpcError(
      normalizeRequestId(message["id"]),
      -32600,
      "JSON-RPC message is missing a method.",
    );
  }

  if (!Object.hasOwn(message, "id")) {
    handleMcpNotification(method);
    return undefined;
  }

  return await handleMcpRequest(
    server,
    method,
    message["params"],
    normalizeRequestId(message["id"]),
  );
};

const parseMcpTools = (result: unknown): readonly McpTool[] => {
  if (!isRecord(result) || !Array.isArray(result["tools"])) {
    throw new Error("MCP tools/list returned no tools array.");
  }

  return result["tools"].map((tool) => {
    if (!isRecord(tool)) {
      throw new Error("MCP tools/list returned an invalid tool.");
    }

    const name = tool["name"];
    const description = tool["description"];
    const inputSchema = tool["inputSchema"];

    if (typeof name !== "string" || !isJsonObject(inputSchema)) {
      throw new Error("MCP tools/list returned an invalid tool.");
    }

    return {
      name,
      ...(typeof description === "string" ? { description } : {}),
      inputSchema,
    };
  });
};

const parseInitializeResult = (result: unknown): McpInitializeResult => {
  if (!isRecord(result)) {
    throw new Error("MCP initialize returned an invalid response.");
  }

  const protocolVersion = result["protocolVersion"];
  const capabilities = result["capabilities"];
  const serverInfo = result["serverInfo"];

  if (
    protocolVersion !== mcpProtocolVersion ||
    !isRecord(capabilities) ||
    !isJsonObject(capabilities["tools"]) ||
    !isRecord(serverInfo) ||
    typeof serverInfo["name"] !== "string"
  ) {
    throw new Error("MCP initialize returned an invalid response.");
  }

  return {
    protocolVersion,
    capabilities: {
      tools: capabilities["tools"],
    },
    serverInfo: {
      name: serverInfo["name"],
      version:
        typeof serverInfo["version"] === "string"
          ? serverInfo["version"]
          : "0.0.0",
    },
  };
};

const parseToolCallResult = (result: unknown): McpToolCallResult => {
  if (!isRecord(result) || !Array.isArray(result["content"])) {
    throw new Error("MCP tools/call returned an invalid response.");
  }

  const content = result["content"].map((entry) => {
    if (!isRecord(entry)) {
      throw new Error("MCP tools/call returned invalid content.");
    }

    if (entry["type"] !== "text" || typeof entry["text"] !== "string") {
      throw new Error("MCP tools/call returned unsupported content.");
    }

    return {
      type: "text" as const,
      text: entry["text"],
    };
  });

  return {
    content,
    ...(typeof result["isError"] === "boolean"
      ? { isError: result["isError"] }
      : {}),
  };
};

const createJsonRpcRequest = (
  id: JsonRpcId,
  method: string,
  params?: unknown,
): UnknownRecord => ({
  jsonrpc: "2.0",
  id,
  method,
  ...(params === undefined ? {} : { params }),
});

const createJsonRpcNotification = (
  method: string,
  params?: unknown,
): UnknownRecord => ({
  jsonrpc: "2.0",
  method,
  ...(params === undefined ? {} : { params }),
});

export const textMcpResult = (
  text: string,
  options: Readonly<{ isError?: boolean }> = {},
): McpToolCallResult => ({
  content: [
    {
      type: "text",
      text,
    },
  ],
  ...(options.isError === undefined ? {} : { isError: options.isError }),
});

export const createMcpHttpClient = (
  server: McpHttpServerConnection,
  options: Readonly<{
    clientInfo?: McpClientInfo;
  }> = {},
): McpClient => {
  const clientInfo = options.clientInfo ?? {
    name: "overlearn",
    version: "0.0.0",
  };
  let nextId = 1;
  let sessionId: string | undefined;

  const post = async (
    message: UnknownRecord,
    expectResponse: boolean,
  ): Promise<unknown> => {
    const headers = new Headers(server.headers);
    headers.set("Accept", "application/json");
    headers.set("Content-Type", "application/json");

    if (sessionId !== undefined) {
      headers.set("Mcp-Session-Id", sessionId);
    }

    const response = await fetch(server.url, {
      method: "POST",
      headers,
      body: JSON.stringify(message),
    });
    const nextSessionId = response.headers.get("Mcp-Session-Id");

    if (nextSessionId !== null && nextSessionId.length > 0) {
      sessionId = nextSessionId;
    }

    const body = await response.text();

    if (!response.ok) {
      throw new Error(
        body.length > 0
          ? `MCP HTTP request failed ${response.status}: ${body}`
          : `MCP HTTP request failed ${response.status}.`,
      );
    }

    if (body.trim().length === 0) {
      if (expectResponse) {
        throw new Error("MCP HTTP response was empty.");
      }

      return undefined;
    }

    let parsed: unknown;

    try {
      parsed = JSON.parse(body) as unknown;
    } catch (error) {
      throw new Error("MCP HTTP response was not valid JSON.", { cause: error });
    }

    if (!isRecord(parsed)) {
      throw new Error("MCP HTTP response must be an object.");
    }

    if ("error" in parsed) {
      throw responseError(parsed);
    }

    return parsed["result"];
  };

  const request = async (method: string, params?: unknown): Promise<unknown> => {
    const id = nextId;
    nextId += 1;

    return await post(createJsonRpcRequest(id, method, params), true);
  };

  const notify = async (method: string, params?: unknown): Promise<void> => {
    await post(createJsonRpcNotification(method, params), false);
  };

  return {
    initialize: async () => {
      const result = parseInitializeResult(
        await request("initialize", {
          protocolVersion: mcpProtocolVersion,
          capabilities: {},
          clientInfo,
        }),
      );
      await notify("notifications/initialized");
      return result;
    },
    listTools: async () => parseMcpTools(await request("tools/list")),
    callTool: async (name, args = {}) =>
      parseToolCallResult(
        await request("tools/call", {
          name,
          arguments: args,
        }),
      ),
    close: async () => {},
  };
};

export const createMcpStdioClient = (
  server: McpStdioServerConnection,
  options: Readonly<{
    clientInfo?: McpClientInfo;
    requestTimeoutMs?: number;
  }> = {},
): McpClient => {
  const commandLine = [server.command, ...(server.args ?? [])];
  const [command, ...args] = commandLine;

  if (command === undefined) {
    throw new Error("MCP stdio server command line must not be empty.");
  }

  const clientInfo = options.clientInfo ?? {
    name: "overlearn",
    version: "0.0.0",
  };
  const requestTimeoutMs = options.requestTimeoutMs ?? defaultRequestTimeoutMs;
  const pending = new Map<string, PendingRequest>();
  let nextId = 1;
  let closed = false;
  let stderr = "";

  const childProcess = Bun.spawn([command, ...args], {
    ...(server.cwd === undefined ? {} : { cwd: server.cwd }),
    env: mergeEnv(process.env, server.env ?? {}),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  const protocolError = (error: Error): void => {
    if (closed) {
      return;
    }

    closed = true;
    rejectPending(pending, error);
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
        new Error(`Malformed MCP JSON-RPC message: ${trimmed.slice(0, 160)}`, {
          cause: error,
        }),
      );
      return;
    }

    if (!isRecord(parsed)) {
      protocolError(new Error("MCP JSON-RPC message must be an object."));
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

    if (typeof method === "string" && hasId) {
      void writeJsonLine(childProcess, {
        jsonrpc: "2.0",
        id: parsed["id"],
        error: {
          code: -32601,
          message: `MCP client method is not supported: ${method}`,
        },
      });
      return;
    }
  };

  void readLines(childProcess.stdout, handleMessage).catch((error) => {
    protocolError(
      new Error(`Failed reading MCP stdout: ${errorMessage(error)}`),
    );
  });

  void drainText(childProcess.stderr, (text) => {
    stderr = `${stderr}${text}`.slice(-8_000);
  });

  const exited = childProcess.exited.then((exitCode) => {
    closed = true;

    if (pending.size > 0) {
      rejectPending(
        pending,
        new Error(
          stderr.trim().length > 0
            ? `MCP subprocess exited with code ${exitCode}: ${stderr.trim()}`
            : `MCP subprocess exited with code ${exitCode}.`,
        ),
      );
    }

    return exitCode;
  });

  const request = async (method: string, params?: unknown): Promise<unknown> => {
    if (closed) {
      throw new Error("MCP subprocess is not running.");
    }

    const id = nextId;
    nextId += 1;

    const promise = new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(String(id));
        reject(new Error(`MCP JSON-RPC request timed out: ${method}`));
      }, requestTimeoutMs);

      pending.set(String(id), { resolve, reject, timeout });
    });

    try {
      await writeJsonLine(childProcess, createJsonRpcRequest(id, method, params));
    } catch (error) {
      const pendingRequest = pending.get(String(id));

      if (pendingRequest !== undefined) {
        if (pendingRequest.timeout !== undefined) {
          clearTimeout(pendingRequest.timeout);
        }

        pending.delete(String(id));
      }

      throw new Error(
        `Failed writing MCP JSON-RPC request ${method}: ${errorMessage(error)}`,
        { cause: error },
      );
    }

    return await promise;
  };

  const notify = async (method: string, params?: unknown): Promise<void> => {
    if (closed) {
      return;
    }

    await writeJsonLine(childProcess, createJsonRpcNotification(method, params));
  };

  return {
    initialize: async () => {
      const result = parseInitializeResult(
        await request("initialize", {
          protocolVersion: mcpProtocolVersion,
          capabilities: {},
          clientInfo,
        }),
      );
      await notify("notifications/initialized");
      return result;
    },
    listTools: async () => parseMcpTools(await request("tools/list")),
    callTool: async (name, args = {}) =>
      parseToolCallResult(
        await request("tools/call", {
          name,
          arguments: args,
        }),
      ),
    close: async () => {
      closed = true;
      rejectPending(pending, new Error("MCP subprocess was terminated."));
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
    },
  };
};

export const connectMcpClient = async (
  server: McpServerConnection,
  options: Readonly<{
    clientInfo?: McpClientInfo;
    requestTimeoutMs?: number;
  }> = {},
): Promise<McpClient> => {
  const client =
    "url" in server
      ? createMcpHttpClient(server, {
          ...(options.clientInfo === undefined
            ? {}
            : { clientInfo: options.clientInfo }),
        })
      : createMcpStdioClient(server, {
          ...(options.clientInfo === undefined
            ? {}
            : { clientInfo: options.clientInfo }),
          ...(options.requestTimeoutMs === undefined
            ? {}
            : { requestTimeoutMs: options.requestTimeoutMs }),
        });

  await client.initialize();
  return client;
};

export const createMcpHttpHandler = (
  definition: McpServerDefinition,
  options: McpHttpHandlerOptions = {},
): ((request: Request) => Promise<Response>) => {
  const fixedSessionId =
    options.sessionId === undefined
      ? `mcp-${Math.random().toString(36).slice(2)}`
      : undefined;

  const sessionIdForRequest = (request: Request): string =>
    typeof options.sessionId === "function"
      ? options.sessionId(request)
      : options.sessionId ?? fixedSessionId ?? "mcp-session";

  return async (request) => {
    const sessionId = sessionIdForRequest(request);

    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    let parsed: unknown;

    try {
      parsed = JSON.parse(await request.text()) as unknown;
    } catch (error) {
      return Response.json(
        jsonRpcError(null, -32700, "Parse error.", errorMessage(error)),
        {
          status: 400,
          headers: {
            "Mcp-Session-Id": sessionId,
          },
        },
      );
    }

    const response = await handleMcpMessage(definition, parsed);
    const headers = {
      "Mcp-Session-Id": sessionId,
    };

    if (response === undefined) {
      return new Response(null, {
        status: 202,
        headers,
      });
    }

    return Response.json(response, { headers });
  };
};

export const startMcpHttpServer = (
  definition: McpServerDefinition,
  options: Readonly<{
    hostname?: string;
    port?: number;
  }> = {},
): RunningMcpHttpServer => {
  const fetch = createMcpHttpHandler(definition);
  let server: ReturnType<typeof Bun.serve> | undefined;
  let lastError: unknown;
  const attempts = options.port === undefined ? 20 : 1;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      server = Bun.serve({
        hostname: options.hostname ?? "127.0.0.1",
        port: options.port ?? randomLoopbackPort(),
        fetch,
      });
      break;
    } catch (error) {
      lastError = error;

      if (options.port !== undefined) {
        throw error;
      }
    }
  }

  if (server === undefined) {
    throw lastError instanceof Error
      ? lastError
      : new Error("Failed to start MCP HTTP server.");
  }

  return {
    url: server.url.toString(),
    stop: () => {
      server.stop(true);
    },
  };
};

export const runMcpStdioServer = async (
  definition: McpServerDefinition,
): Promise<void> => {
  const input = createInterface({ input: process.stdin });

  for await (const line of input) {
    const trimmed = line.trim();

    if (trimmed.length === 0) {
      continue;
    }

    let parsed: unknown;

    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch (error) {
      process.stdout.write(
        `${JSON.stringify(
          jsonRpcError(null, -32700, "Parse error.", errorMessage(error)),
        )}\n`,
      );
      continue;
    }

    const response = await handleMcpMessage(definition, parsed);

    if (response !== undefined) {
      process.stdout.write(`${JSON.stringify(response)}\n`);
    }
  }
};

import { createInterface } from "node:readline";

export type McpProxyOptions = Readonly<{
  url: string;
  headers?: Readonly<Record<string, string>>;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}>;

type JsonRpcId = string | number | null;

type ProxyConfig = Readonly<{
  url: string;
  headers: Readonly<Record<string, string>>;
}>;

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const requestId = (message: unknown): JsonRpcId | undefined => {
  if (!isRecord(message) || !Object.hasOwn(message, "id")) {
    return undefined;
  }

  const id = message["id"];
  return id === null || typeof id === "string" || typeof id === "number"
    ? id
    : null;
};

const jsonRpcErrorLine = (
  id: JsonRpcId,
  code: number,
  message: string,
): string =>
  `${JSON.stringify({
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
    },
  })}\n`;

const parseHeaderArg = (arg: string): readonly [string, string] => {
  const separator = arg.indexOf("=");
  if (separator <= 0) {
    throw new Error(`Invalid MCP proxy header argument: ${arg}`);
  }

  const name = arg.slice(0, separator).trim();
  const value = arg.slice(separator + 1).trim();
  if (name.length === 0) {
    throw new Error(`Invalid MCP proxy header argument: ${arg}`);
  }

  return [name, value];
};

export const parseMcpProxyConfig = (
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>> = process.env,
): ProxyConfig => {
  const [urlArg, ...headerArgs] = argv;
  const url = urlArg ?? env["OVERLEARN_MCP_HTTP_URL"];

  if (url === undefined || url.trim().length === 0) {
    throw new Error(
      "MCP proxy requires an HTTP URL argument or OVERLEARN_MCP_HTTP_URL.",
    );
  }

  return {
    url,
    headers: Object.fromEntries(headerArgs.map(parseHeaderArg)),
  };
};

const responseBodyIsJsonRpc = (body: string): boolean => {
  try {
    const parsed = JSON.parse(body) as unknown;
    return isRecord(parsed) && parsed["jsonrpc"] === "2.0";
  } catch {
    return false;
  }
};

const postJsonRpc = async (
  url: string,
  headers: Readonly<Record<string, string>>,
  body: string,
  sessionId: string | undefined,
): Promise<Readonly<{ body: string | undefined; sessionId?: string }>> => {
  const requestHeaders = new Headers(headers);
  requestHeaders.set("Accept", "application/json");
  requestHeaders.set("Content-Type", "application/json");

  if (sessionId !== undefined) {
    requestHeaders.set("Mcp-Session-Id", sessionId);
  }

  const response = await fetch(url, {
    method: "POST",
    headers: requestHeaders,
    body,
  });
  const nextSessionId = response.headers.get("Mcp-Session-Id") ?? undefined;
  const responseBody = await response.text();

  if (response.ok) {
    return {
      body: responseBody.trim().length === 0 ? undefined : responseBody,
      ...(nextSessionId === undefined ? {} : { sessionId: nextSessionId }),
    };
  }

  if (responseBodyIsJsonRpc(responseBody)) {
    return {
      body: responseBody,
      ...(nextSessionId === undefined ? {} : { sessionId: nextSessionId }),
    };
  }

  throw new Error(
    responseBody.trim().length === 0
      ? `MCP HTTP request failed ${response.status}.`
      : `MCP HTTP request failed ${response.status}: ${responseBody}`,
  );
};

export const runMcpHttpStdioProxy = async (
  options: McpProxyOptions,
): Promise<void> => {
  const input = createInterface({ input: options.input ?? process.stdin });
  const output = options.output ?? process.stdout;
  let sessionId: string | undefined;

  for await (const line of input) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch {
      output.write(jsonRpcErrorLine(null, -32700, "Parse error."));
      continue;
    }

    const id = requestId(parsed);

    try {
      const response = await postJsonRpc(
        options.url,
        options.headers ?? {},
        trimmed,
        sessionId,
      );

      sessionId = response.sessionId ?? sessionId;

      if (response.body !== undefined) {
        output.write(`${response.body.trimEnd()}\n`);
      }
    } catch (error) {
      if (id !== undefined) {
        output.write(jsonRpcErrorLine(id, -32603, errorMessage(error)));
      }
    }
  }
};

if (import.meta.main) {
  try {
    const config = parseMcpProxyConfig(Bun.argv.slice(2));
    await runMcpHttpStdioProxy(config);
  } catch (error) {
    process.stderr.write(`${errorMessage(error)}\n`);
    process.exit(1);
  }
}

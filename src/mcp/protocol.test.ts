import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

import {
  createMcpHttpClient,
  createMcpStdioClient,
  startMcpHttpServer,
  textMcpResult,
  type McpJsonObject,
  type McpServerDefinition,
} from "./protocol";

const fixturePath = fileURLToPath(
  new URL("../../test/fixtures/fake-mcp-server.ts", import.meta.url),
);

const withTimeout = async <T>(
  promise: Promise<T>,
  milliseconds: number,
  label: string,
): Promise<T> => {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(
      () => reject(new Error(`${label} timed out after ${milliseconds}ms`)),
      milliseconds,
    );
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
};

describe("MCP protocol", () => {
  test("serves initialize, tools/list, and tools/call over streamable HTTP", async () => {
    const calls: McpJsonObject[] = [];
    const definition: McpServerDefinition = {
      name: "teaching",
      version: "0.0.0",
      tools: [
        {
          name: "upsert_topic",
          description: "Records a topic.",
          inputSchema: {
            type: "object",
            additionalProperties: true,
          },
          call: (args) => {
            calls.push(args);
            return textMcpResult(`stored:${args["slug"] ?? "unknown"}`);
          },
        },
      ],
    };
    const server = startMcpHttpServer(definition);

    try {
      const client = createMcpHttpClient({
        name: "teaching",
        url: server.url,
      });
      const initialized = await withTimeout(
        client.initialize(),
        1_000,
        "http initialize",
      );
      const tools = await withTimeout(
        client.listTools(),
        1_000,
        "http tools/list",
      );
      const result = await withTimeout(
        client.callTool("upsert_topic", { slug: "rule-of-72" }),
        1_000,
        "http tools/call",
      );

      expect(initialized).toEqual({
        protocolVersion: "2025-06-18",
        capabilities: {
          tools: {},
        },
        serverInfo: {
          name: "teaching",
          version: "0.0.0",
        },
      });
      expect(tools).toEqual([
        {
          name: "upsert_topic",
          description: "Records a topic.",
          inputSchema: {
            type: "object",
            additionalProperties: true,
          },
        },
      ]);
      expect(result).toEqual(textMcpResult("stored:rule-of-72"));
      expect(calls).toEqual([{ slug: "rule-of-72" }]);
    } finally {
      server.stop();
    }
  });

  test("calls a stdio MCP server with newline-delimited JSON-RPC", async () => {
    const client = createMcpStdioClient(
      {
        name: "teaching",
        command: process.execPath,
        args: [fixturePath],
        env: {},
      },
      {
        requestTimeoutMs: 1_000,
      },
    );

    try {
      const initialized = await withTimeout(
        client.initialize(),
        1_500,
        "stdio initialize",
      );
      const tools = await withTimeout(
        client.listTools(),
        1_500,
        "stdio tools/list",
      );
      const result = await withTimeout(
        client.callTool("upsert_topic", { slug: "stdio-topic" }),
        1_500,
        "stdio tools/call",
      );

      expect(initialized.serverInfo).toEqual({
        name: "fake-mcp-server",
        version: "0.0.0",
      });
      expect(tools.map((tool) => tool.name)).toEqual(["upsert_topic", "echo"]);
      expect(result).toEqual(
        textMcpResult('upsert_topic:{"slug":"stdio-topic"}'),
      );
    } finally {
      await withTimeout(client.close(), 1_500, "stdio close");
    }
  });
});

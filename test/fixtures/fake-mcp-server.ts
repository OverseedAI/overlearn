import {
  runMcpStdioServer,
  textMcpResult,
  type McpServerDefinition,
} from "../../src/mcp/protocol";

const server: McpServerDefinition = {
  name: "fake-mcp-server",
  version: "0.0.0",
  tools: [
    {
      name: "upsert_topic",
      description: "Records a topic update.",
      inputSchema: {
        type: "object",
        additionalProperties: true,
      },
      call: (args) => textMcpResult(`upsert_topic:${JSON.stringify(args)}`),
    },
    {
      name: "echo",
      description: "Echoes MCP tool arguments.",
      inputSchema: {
        type: "object",
        additionalProperties: true,
      },
      call: (args) => textMcpResult(`echo:${JSON.stringify(args)}`),
    },
  ],
};

await runMcpStdioServer(server);

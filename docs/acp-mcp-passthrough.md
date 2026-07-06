# ACP MCP Passthrough

DEV-550 proves Overlearn's side of the ACP MCP contract:

- `HarnessSessionConfig.mcpServers` uses Overlearn-owned internal types.
- `src/adapter/acp.ts` converts those internal configs to the ACP bridge wire shape at `session/new`.
- The fake ACP agent records the wire configs it receives and can call HTTP or stdio MCP tools offline.
- The in-repo MCP slice implements `initialize`, `notifications/initialized`, `tools/list`, and `tools/call` for stdio and Streamable HTTP POST.

## Config Shape

Product code should use the internal Overlearn shape:

```ts
type InternalStdioServer = {
  name: string;
  command: string;
  args: readonly string[];
  env: Record<string, string>;
};

type InternalHttpServer = {
  name: string;
  url: string;
  headers?: Record<string, string>;
};
```

`src/adapter/acp.ts` converts that to the ACP bridge wire shape immediately before `session/new`:

```ts
type AcpStdioServer = {
  name: string;
  command: string;
  args: readonly string[];
  env: Array<{ name: string; value: string }>;
};

type AcpHttpServer = {
  type: "http";
  name: string;
  url: string;
  headers: Array<{ name: string; value: string }>;
};
```

Mapping rules:

| Internal | ACP wire |
| --- | --- |
| stdio `env: { FOO: "bar" }` | `env: [{ name: "FOO", value: "bar" }]` |
| HTTP `headers: { Authorization: "Bearer x" }` | `headers: [{ name: "Authorization", value: "Bearer x" }]` |
| HTTP server without headers | `headers: []` |
| HTTP server discriminator | `type: "http"` is always added |

## Bridge Matrix

Source-verified by the director on July 6, 2026 against:

- `@zed-industries/claude-code-acp` 0.16.2, `dist/acp-agent.js`
- `@agentclientprotocol/codex-acp` 1.1.0, `dist/index.js`
- `gemini-cli` main, `packages/cli/src/acp/acpSessionManager.ts`

| bridge | stdio | streamable HTTP | SSE |
| --- | --- | --- | --- |
| `@zed-industries/claude-code-acp` 0.16.2 | YES | YES (`{ type: "http", url, headers: [{ name, value }] }`) | YES |
| `@agentclientprotocol/codex-acp` 1.1.0 | YES | YES (maps to Codex `mcp_servers.<name>.url` + `http_headers`) | NO - throws `invalidRequest` |
| `gemini-cli` main (`--experimental-acp`) | YES | YES (maps to `MCPServerConfig.httpUrl`) | YES |

## Product Direction

HTTP is the universal transport across all three bridges, so the daemon should serve Streamable HTTP MCP. A stdio proxy remains useful as insurance and for local bridge compatibility.

For Codex, `codex-acp` dedupes server names against user config after sanitizing names. Use a distinctive server name such as `overlearn-teaching`; avoid generic names like `mcp`.

`claude-code-acp` supports `_meta.systemPrompt.append` on `session/new`. That is Claude-only future surface area; do not use it in the portable adapter path.

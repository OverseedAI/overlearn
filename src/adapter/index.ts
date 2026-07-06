/**
 * Harness adapter module
 *
 * Overlearn's daemon will eventually supervise coding-agent harnesses directly.
 * The public surface here is intentionally small: `HarnessAdapter`,
 * `SessionRef`, `AgentEvent`, permission policy helpers, and the adapter
 * registry. The rest of the codebase should not import ACP or vendor-specific
 * details.
 *
 * ACP, the Agent Client Protocol, is JSON-RPC 2.0 over stdio. This module uses
 * newline-delimited JSON frames, performs the initialize/session handshake,
 * sends prompt turns, listens for `session/update` notifications, answers
 * permission requests from a caller-provided allowlist policy, and cleans up the
 * supervised subprocess on session end or protocol failure.
 *
 * Tests run against `test/fixtures/fake-acp-agent.ts`, a deterministic Bun
 * script that speaks the same newline-delimited JSON-RPC contract over stdio.
 * The fixture has modes for normal streaming, permission requests, never-ending
 * turns, subprocess crashes, and malformed JSON so adapter behavior is covered
 * without network access or real harness binaries.
 */

export {
  defaultPermissionPolicy,
  evaluatePermissionRequest,
} from "./permissions";
export {
  getHarnessAdapter,
  harnessAdapterDefinitions,
  listHarnessAdapters,
  type HarnessAdapterRegistryOverride,
} from "./registry";
export type {
  AdapterDetection,
  AgentEvent,
  DoneAgentEvent,
  ErrorAgentEvent,
  HarnessAdapter,
  HarnessAdapterId,
  HarnessSessionConfig,
  JsonObject,
  JsonPrimitive,
  JsonValue,
  PermissionDecision,
  PermissionPolicy,
  PermissionRequest,
  PermissionRequestAgentEvent,
  PermissionRule,
  SessionRef,
  TextAgentEvent,
  ThinkingAgentEvent,
  ToolCallAgentEvent,
} from "./types";

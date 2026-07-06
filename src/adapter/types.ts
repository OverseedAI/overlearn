export type JsonPrimitive = string | number | boolean | null;
export type JsonObject = { [key: string]: JsonValue };
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

export type HarnessAdapterId = "claude-code" | "codex" | "gemini" | (string & {});

export type AdapterDetection = Readonly<{
  installed: boolean;
  authenticated: boolean;
  version?: string;
}>;

export type SessionRef = Readonly<{
  id: string;
  adapterId: HarnessAdapterId;
  cwd: string;
  processId: number;
}>;

export type PermissionRequest = Readonly<{
  id: string;
  action: string;
  resource?: string;
  description?: string;
  metadata?: JsonObject;
}>;

export type PermissionDecision = Readonly<{
  allowed: boolean;
  reason: string;
}>;

export type PermissionRule = Readonly<{
  action?: string;
  resource?: string;
  reason?: string;
}>;

export type PermissionPolicy = Readonly<{
  allow: readonly PermissionRule[];
  defaultDecision?: "allow" | "deny";
  defaultReason?: string;
}>;

export type HarnessSessionConfig = Readonly<{
  permissionPolicy?: PermissionPolicy;
  metadata?: JsonObject;
}>;

export type ThinkingAgentEvent = Readonly<{
  type: "thinking";
  text: string;
}>;

export type TextAgentEvent = Readonly<{
  type: "text";
  text: string;
}>;

export type ToolCallAgentEvent = Readonly<{
  type: "tool-call";
  id: string;
  status: "started" | "delta" | "completed" | "failed";
  name?: string;
  input?: JsonValue;
  text?: string;
  result?: JsonValue;
  error?: string;
}>;

export type PermissionRequestAgentEvent = Readonly<{
  type: "permission-request";
  request: PermissionRequest;
  decision: PermissionDecision;
}>;

export type DoneAgentEvent = Readonly<{
  type: "done";
  reason: "complete" | "cancelled";
}>;

export type ErrorAgentEvent = Readonly<{
  type: "error";
  message: string;
}>;

export type AgentEvent =
  | ThinkingAgentEvent
  | TextAgentEvent
  | ToolCallAgentEvent
  | PermissionRequestAgentEvent
  | DoneAgentEvent
  | ErrorAgentEvent;

export type HarnessAdapter = Readonly<{
  id: HarnessAdapterId;
  name: string;
  detect: () => AdapterDetection;
  newSession: (
    cwd: string,
    config?: HarnessSessionConfig,
  ) => Promise<SessionRef>;
  prompt: (session: SessionRef, content: string) => AsyncIterable<AgentEvent>;
  cancel: (session: SessionRef) => Promise<void>;
  end: (session: SessionRef) => Promise<void>;
}>;

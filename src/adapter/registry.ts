import { homedir } from "node:os";
import { join, resolve } from "node:path";

import {
  createAcpHarnessAdapter,
  type AcpAdapterDefinition,
  type AcpAdapterOverride,
} from "./acp";
import type { HarnessAdapter, HarnessAdapterId } from "./types";

type Env = Readonly<Record<string, string | undefined>>;

export type HarnessAdapterRegistryOverride = AcpAdapterOverride;

export type HarnessCommand = Readonly<{
  command: string;
  args: readonly string[];
}>;

export type HarnessInstallGuidance = HarnessCommand &
  Readonly<{
    docsUrl: string;
  }>;

export type HarnessLoginCommand = HarnessCommand &
  Readonly<{
    interactive: boolean;
    note: string;
  }>;

export type HarnessModel = Readonly<{
  id: string;
  label: string;
}>;

export type HarnessCapabilities = Readonly<{
  models?: readonly HarnessModel[];
  efforts?: readonly string[];
  defaultModel?: string;
  defaultEffort?: string;
  /** Accepts model ids outside the curated list (free-text entry). */
  customModels?: boolean;
}>;

export type HarnessAgentSelection = Readonly<{
  model?: string | null | undefined;
  effort?: string | null | undefined;
}>;

export type ManagedBridgeDefinition = Readonly<{
  package: string;
  version: string;
  bin: string;
}>;

export type ResolvedHarnessAgentSelection = Readonly<{
  model?: string;
  effort?: string;
}>;

export type HarnessAdapterDefinition = AcpAdapterDefinition &
  Readonly<{
    install: HarnessInstallGuidance;
    loginCommand: HarnessLoginCommand;
    managedBridge?: ManagedBridgeDefinition;
    capabilities?: HarnessCapabilities;
  }>;

const userHome = (env: Env): string => resolve(env["HOME"] ?? homedir());

const claudeAuthPaths = (env: Env): readonly string[] => {
  const home = userHome(env);

  return [
    join(home, ".claude", ".credentials.json"),
    join(home, ".claude.json"),
  ];
};

const codexAuthPaths = (env: Env): readonly string[] => {
  const home = resolve(env["CODEX_HOME"] ?? join(userHome(env), ".codex"));

  return [
    join(home, "auth.json"),
    join(home, "credentials.json"),
  ];
};

const geminiAuthPaths = (env: Env): readonly string[] => {
  const home = userHome(env);

  return [
    join(home, ".gemini", "oauth_creds.json"),
    join(home, ".gemini", "credentials.json"),
  ];
};

export const harnessAdapterDefinitions: readonly HarnessAdapterDefinition[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    // @zed-industries/claude-code-acp was renamed to
    // @agentclientprotocol/claude-agent-acp; keep the old binary as a fallback
    // for existing installs.
    command: "claude-agent-acp",
    commandFallbacks: ["claude-code-acp"],
    args: [],
    versionArgs: ["--version"],
    managedBridge: {
      package: "@agentclientprotocol/claude-agent-acp",
      version: "0.55.0",
      bin: "claude-agent-acp",
    },
    install: {
      command: "npm",
      args: ["install", "-g", "@anthropic-ai/claude-code"],
      docsUrl: "https://docs.anthropic.com/en/docs/claude-code/setup",
    },
    loginCommand: {
      command: "claude",
      args: [],
      interactive: true,
      note: "Claude Code opens an interactive terminal login flow, so Overlearn shows the command to run yourself.",
    },
    auth: {
      env: ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"],
      paths: claudeAuthPaths,
    },
    capabilities: {
      models: [
        { id: "claude-opus-4-8", label: "Claude Opus 4.8" },
        { id: "claude-sonnet-5", label: "Claude Sonnet 5" },
        { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
      ],
      defaultModel: "claude-sonnet-5",
      customModels: true,
    },
  },
  {
    id: "codex",
    name: "Codex",
    command: "codex-acp",
    args: [],
    versionArgs: ["--version"],
    managedBridge: {
      package: "@agentclientprotocol/codex-acp",
      version: "1.1.0",
      bin: "codex-acp",
    },
    install: {
      command: "npm",
      args: ["install", "-g", "@openai/codex"],
      docsUrl: "https://developers.openai.com/codex/cli/",
    },
    loginCommand: {
      command: "codex",
      args: ["login"],
      interactive: false,
      note: "Codex login uses browser OAuth, so Overlearn can launch it without collecting credentials.",
    },
    auth: {
      env: ["OPENAI_API_KEY"],
      paths: codexAuthPaths,
    },
    capabilities: {
      // Ids verified against the codex 0.144.x picker lineup (strings embedded
      // in the CLI binary); keep in sync with what the pinned bridge accepts.
      models: [
        { id: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
        { id: "gpt-5.6-luna", label: "GPT-5.6 Luna" },
        { id: "gpt-5.6-terra", label: "GPT-5.6 Terra" },
        { id: "gpt-5.5", label: "GPT-5.5" },
        { id: "gpt-5.4", label: "GPT-5.4" },
        { id: "gpt-5.4-mini", label: "GPT-5.4 Mini" },
      ],
      efforts: ["low", "medium", "high"],
      defaultModel: "gpt-5.6-sol",
      defaultEffort: "medium",
      customModels: true,
    },
  },
  {
    id: "gemini",
    name: "Gemini",
    command: "gemini",
    args: ["--experimental-acp"],
    versionArgs: ["--version"],
    install: {
      command: "npm",
      args: ["install", "-g", "@google/gemini-cli"],
      docsUrl: "https://github.com/google-gemini/gemini-cli",
    },
    loginCommand: {
      command: "gemini",
      args: [],
      interactive: true,
      note: "Google no longer supports Gemini CLI OAuth sign-in for individual accounts (it points to Antigravity, which has no agent-protocol mode yet). Set GEMINI_API_KEY (or GOOGLE_API_KEY) in your environment instead.",
    },
    auth: {
      env: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
      paths: geminiAuthPaths,
    },
    capabilities: {},
  },
];

const customModel = (
  capabilities: HarnessCapabilities,
  model: string | null | undefined,
): string | undefined =>
  capabilities.customModels === true &&
  typeof model === "string" &&
  model.trim().length > 0
    ? model.trim()
    : undefined;

const availableModel = (
  capabilities: HarnessCapabilities,
  model: string | null | undefined,
): string | undefined => {
  const models = capabilities.models ?? [];
  const selected =
    models.find((candidate) => candidate.id === model)?.id ??
    customModel(capabilities, model);

  return (
    selected ??
    models.find((candidate) => candidate.id === capabilities.defaultModel)?.id
  );
};

const availableEffort = (
  capabilities: HarnessCapabilities,
  effort: string | null | undefined,
): string | undefined => {
  const efforts = capabilities.efforts ?? [];

  return efforts.includes(effort ?? "")
    ? (effort ?? undefined)
    : efforts.find((candidate) => candidate === capabilities.defaultEffort);
};

export const resolveHarnessAgentSelection = (
  id: HarnessAdapterId,
  selection: HarnessAgentSelection = {},
): ResolvedHarnessAgentSelection => {
  const capabilities = getHarnessAdapterDefinition(id)?.capabilities ?? {};
  const model = availableModel(capabilities, selection.model);
  const effort = availableEffort(capabilities, selection.effort);

  return {
    ...(model === undefined ? {} : { model }),
    ...(effort === undefined ? {} : { effort }),
  };
};

const parseCodexConfig = (value: string | undefined): Record<string, unknown> => {
  if (value === undefined || value.trim().length === 0) {
    return {};
  }

  const parsed = JSON.parse(value) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("CODEX_CONFIG must be a JSON object.");
  }

  return parsed as Record<string, unknown>;
};

export const harnessAgentSpawnOverride = (
  id: HarnessAdapterId,
  selection: HarnessAgentSelection = {},
  env: Env = process.env,
): HarnessAdapterRegistryOverride => {
  const capabilities = getHarnessAdapterDefinition(id)?.capabilities ?? {};
  const selectedModel =
    capabilities.models?.find((candidate) => candidate.id === selection.model)
      ?.id ?? customModel(capabilities, selection.model);
  const selectedEffort = capabilities.efforts?.find(
    (candidate) => candidate === selection.effort,
  );

  if (selectedModel === undefined && selectedEffort === undefined) {
    return {};
  }

  if (id === "codex") {
    // TODO(verify): confirm codex-acp honors CODEX_CONFIG (model /
    // model_reasoning_effort) against the real bridge; mechanism centralized
    // here for easy correction.
    return {
      env: {
        CODEX_CONFIG: JSON.stringify({
          ...parseCodexConfig(env["CODEX_CONFIG"]),
          ...(selectedModel === undefined
            ? {}
            : { model: selectedModel }),
          ...(selectedEffort === undefined
            ? {}
            : { model_reasoning_effort: selectedEffort }),
        }),
      },
    };
  }

  if (id === "claude-code" && selectedModel !== undefined) {
    // TODO(verify): confirm claude-agent-acp honors ANTHROPIC_MODEL against the
    // real bridge; mechanism centralized here for easy correction.
    return { env: { ANTHROPIC_MODEL: selectedModel } };
  }

  return {};
};

export const listHarnessAdapters = (
  overrides: Readonly<
    Partial<Record<HarnessAdapterId, HarnessAdapterRegistryOverride>>
  > = {},
): readonly HarnessAdapter[] =>
  harnessAdapterDefinitions.map((definition) =>
    createAcpHarnessAdapter(definition, overrides[definition.id] ?? {}),
  );

export const getHarnessAdapter = (
  id: HarnessAdapterId,
  override: HarnessAdapterRegistryOverride = {},
): HarnessAdapter | undefined => {
  const definition = harnessAdapterDefinitions.find(
    (candidate) => candidate.id === id,
  );

  return definition === undefined
    ? undefined
    : createAcpHarnessAdapter(definition, override);
};

export const getHarnessAdapterDefinition = (
  id: HarnessAdapterId,
): HarnessAdapterDefinition | undefined =>
  harnessAdapterDefinitions.find((candidate) => candidate.id === id);

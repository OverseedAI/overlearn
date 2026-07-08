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

export type HarnessAdapterDefinition = AcpAdapterDefinition &
  Readonly<{
    install: HarnessInstallGuidance;
    loginCommand: HarnessLoginCommand;
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
    install: {
      command: "npm",
      args: [
        "install",
        "-g",
        "@anthropic-ai/claude-code",
        "@agentclientprotocol/claude-agent-acp",
      ],
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
  },
  {
    id: "codex",
    name: "Codex",
    command: "codex-acp",
    args: [],
    versionArgs: ["--version"],
    install: {
      command: "npm",
      args: [
        "install",
        "-g",
        "@openai/codex",
        "@agentclientprotocol/codex-acp",
      ],
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
  },
];

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

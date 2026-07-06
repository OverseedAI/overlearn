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

export const harnessAdapterDefinitions: readonly AcpAdapterDefinition[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    command: "claude-code-acp",
    args: [],
    versionArgs: ["--version"],
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

import { createHash } from "node:crypto";
import {
  access,
  chmod,
  mkdir,
  readFile,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import stopBackstop from "../../plugin/hooks/stop-backstop.sh" with { type: "text" };
import learnSkillCodex from "../../plugin/skills/learn/SKILL.codex.md" with { type: "text" };
import learnSkill from "../../plugin/skills/learn/SKILL.md" with { type: "text" };
import { getOverlearnHome } from "../instructions";

type Env = Readonly<Record<string, string | undefined>>;

export type HarnessTool = "claude-code" | "codex";
export type HarnessScope = "global" | "project";

export type HarnessOptions = Readonly<{
  tool: HarnessTool;
  scope: HarnessScope;
  force?: boolean;
  cwd?: string;
  env?: Env;
}>;

export type HarnessAction = Readonly<{
  kind: "file" | "settings-hook" | "config" | "directory";
  path: string;
  status:
    | "written"
    | "overwritten"
    | "skipped"
    | "updated"
    | "unchanged"
    | "removed"
    | "missing"
    | "kept"
    | "pruned";
  detail?: string;
}>;

export type HarnessInstallResult = Readonly<{
  tool: HarnessTool;
  scope: HarnessScope;
  root: string;
  manifestPath: string;
  actions: readonly HarnessAction[];
}>;

export type HarnessUninstallResult = HarnessInstallResult &
  Readonly<{
    nothingToUninstall: boolean;
  }>;

type JsonPrimitive = string | number | boolean | null;
type JsonObject = { [key: string]: JsonValue };
type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

type PlannedFile = Readonly<{
  path: string;
  content: string;
  mode?: number;
}>;

type PlannedSettingsHook = Readonly<{
  path: string;
  scriptPath: string;
  command: string;
}>;

type PlannedTomlFlag = Readonly<{
  path: string;
  table: string;
  key: string;
  value: boolean;
}>;

type HarnessPlan = Readonly<{
  tool: HarnessTool;
  scope: HarnessScope;
  root: string;
  manifestPath: string;
  files: readonly PlannedFile[];
  settingsHooks: readonly PlannedSettingsHook[];
  tomlFlags: readonly PlannedTomlFlag[];
}>;

type ManifestFileEntry = Readonly<{
  path: string;
  sha256: string;
  mode?: number;
  createdDirs: readonly string[];
}>;

type ManifestSettingsHookEntry = Readonly<{
  path: string;
  scriptPath: string;
  command: string;
  createdFile: boolean;
  createdDirs: readonly string[];
}>;

type ManifestInstall = Readonly<{
  tool: HarnessTool;
  scope: HarnessScope;
  root: string;
  installedAt: string;
  files: readonly ManifestFileEntry[];
  settingsHooks: readonly ManifestSettingsHookEntry[];
}>;

type InstallManifest = Readonly<{
  version: 1;
  installs: readonly ManifestInstall[];
}>;

type SettingsMerge = Readonly<{
  path: string;
  scriptPath: string;
  command: string;
  existed: boolean;
  status: "updated" | "unchanged";
  content?: string;
}>;

type SettingsRemoval = Readonly<{
  entry: ManifestSettingsHookEntry;
  existed: boolean;
  status: "updated" | "unchanged" | "removed" | "missing";
  content?: string;
}>;

const manifestVersion = 1 as const;

const skillContent = `${learnSkill.trimEnd()}\n`;
const codexSkillContent = `${learnSkillCodex.trimEnd()}\n`;
const stopBackstopContent = `${stopBackstop.trimEnd()}\n`;

const hasErrorCode = (error: unknown, code: string): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error["code"] === code;

const pathExists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return false;
    }

    throw error;
  }
};

const readTextIfExists = async (path: string): Promise<string | undefined> => {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return undefined;
    }

    throw error;
  }
};

const hashText = (content: string): string =>
  createHash("sha256").update(content).digest("hex");

const getAgentHome = (env: Env = process.env): string =>
  resolve(env["OVERLEARN_AGENT_HOME"] ?? homedir());

const shellQuote = (value: string): string =>
  `'${value.replaceAll("'", "'\\''")}'`;

const claudeHookCommand = (scriptPath: string): string =>
  `bash ${shellQuote(scriptPath)}`;

const codexHookCommand = (scriptPath: string): string =>
  `bash ${shellQuote(scriptPath)} codex`;

const stopHookEntry = (command: string): JsonObject => ({
  hooks: [
    {
      type: "command",
      command,
      timeout: 10,
    },
  ],
});

const isJsonObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const jsonContainsString = (value: JsonValue, needle: string): boolean => {
  if (typeof value === "string") {
    return value.includes(needle);
  }

  if (Array.isArray(value)) {
    return value.some((entry) => jsonContainsString(entry, needle));
  }

  if (isJsonObject(value)) {
    return Object.values(value).some((entry) => jsonContainsString(entry, needle));
  }

  return false;
};

const parseSettingsObject = (text: string, path: string): JsonObject => {
  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Cannot merge Stop hook into ${path}: invalid JSON (${message}).`,
      { cause: error },
    );
  }

  if (!isJsonObject(parsed)) {
    throw new Error(`Cannot merge Stop hook into ${path}: settings file must contain a JSON object.`);
  }

  return parsed;
};

const stringifyJson = (value: unknown): string =>
  `${JSON.stringify(value, null, 2)}\n`;

const ensureHooksObject = (settings: JsonObject, path: string): JsonObject => {
  const current = settings["hooks"];

  if (current === undefined) {
    const hooks: JsonObject = {};
    settings["hooks"] = hooks;
    return hooks;
  }

  if (!isJsonObject(current)) {
    throw new Error(`Cannot merge Stop hook into ${path}: hooks must be a JSON object.`);
  }

  return current;
};

const ensureStopArray = (hooks: JsonObject, path: string): JsonValue[] => {
  const current = hooks["Stop"];

  if (current === undefined) {
    const stop: JsonValue[] = [];
    hooks["Stop"] = stop;
    return stop;
  }

  if (!Array.isArray(current)) {
    throw new Error(`Cannot merge Stop hook into ${path}: hooks.Stop must be an array.`);
  }

  return current;
};

const prepareSettingsMerge = async (
  hook: PlannedSettingsHook,
): Promise<SettingsMerge> => {
  const text = await readTextIfExists(hook.path);
  const existed = text !== undefined;
  const settings = text === undefined ? {} : parseSettingsObject(text, hook.path);
  const hooks = ensureHooksObject(settings, hook.path);
  const stop = ensureStopArray(hooks, hook.path);

  if (stop.some((entry) => jsonContainsString(entry, hook.scriptPath))) {
    return {
      path: hook.path,
      scriptPath: hook.scriptPath,
      command: hook.command,
      existed,
      status: "unchanged",
    };
  }

  stop.push(stopHookEntry(hook.command));

  return {
    path: hook.path,
    scriptPath: hook.scriptPath,
    command: hook.command,
    existed,
    status: "updated",
    content: stringifyJson(settings),
  };
};

const removeStopHook = (
  settings: JsonObject,
  scriptPath: string,
  path: string,
): boolean => {
  const hooks = settings["hooks"];
  if (hooks === undefined) {
    return false;
  }

  if (!isJsonObject(hooks)) {
    throw new Error(`Cannot remove Stop hook from ${path}: hooks must be a JSON object.`);
  }

  const stop = hooks["Stop"];
  if (stop === undefined) {
    return false;
  }

  if (!Array.isArray(stop)) {
    throw new Error(`Cannot remove Stop hook from ${path}: hooks.Stop must be an array.`);
  }

  let removed = false;
  const nextStop = stop.flatMap((entry): JsonValue[] => {
    if (!jsonContainsString(entry, scriptPath)) {
      return [entry];
    }

    removed = true;

    if (isJsonObject(entry) && Array.isArray(entry["hooks"])) {
      const nextHooks = entry["hooks"].filter(
        (nested) => !jsonContainsString(nested, scriptPath),
      );

      if (nextHooks.length > 0) {
        return [
          {
            ...entry,
            hooks: nextHooks,
          },
        ];
      }
    }

    return [];
  });

  hooks["Stop"] = nextStop;
  return removed;
};

const isEmptyCreatedSettings = (settings: JsonObject): boolean => {
  const keys = Object.keys(settings);
  if (keys.length === 0) {
    return true;
  }

  if (keys.length !== 1 || keys[0] !== "hooks") {
    return false;
  }

  const hooks = settings["hooks"];
  if (!isJsonObject(hooks)) {
    return false;
  }

  const hookKeys = Object.keys(hooks);
  if (hookKeys.length === 0) {
    return true;
  }

  return (
    hookKeys.length === 1 &&
    hookKeys[0] === "Stop" &&
    Array.isArray(hooks["Stop"]) &&
    hooks["Stop"].length === 0
  );
};

const prepareSettingsRemoval = async (
  entry: ManifestSettingsHookEntry,
): Promise<SettingsRemoval> => {
  const text = await readTextIfExists(entry.path);
  if (text === undefined) {
    return {
      entry,
      existed: false,
      status: "missing",
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Cannot remove Stop hook from ${entry.path}: invalid JSON (${message}).`,
      { cause: error },
    );
  }

  if (!isJsonObject(parsed)) {
    throw new Error(`Cannot remove Stop hook from ${entry.path}: settings file must contain a JSON object.`);
  }

  const removed = removeStopHook(parsed, entry.scriptPath, entry.path);
  if (!removed) {
    return {
      entry,
      existed: true,
      status: "unchanged",
    };
  }

  if (entry.createdFile && isEmptyCreatedSettings(parsed)) {
    return {
      entry,
      existed: true,
      status: "removed",
    };
  }

  return {
    entry,
    existed: true,
    status: "updated",
    content: stringifyJson(parsed),
  };
};

type TomlFlagResult = Readonly<{
  status: "updated" | "unchanged" | "skipped";
  detail: string;
  content?: string;
}>;

// Line-based upsert so user formatting and comments survive. Handles the
// common `[table]` section form only; an inline `table = { ... }` is left
// alone and reported for manual editing.
const upsertTomlFlag = (raw: string, flag: PlannedTomlFlag): TomlFlagResult => {
  const header = `[${flag.table}]`;
  const assignment = `${flag.key} = ${flag.value}`;
  const detail = `${flag.table}.${flag.key} = ${flag.value}`;
  const keyPattern = new RegExp(`^\\s*${flag.key}\\s*=`);
  const inlinePattern = new RegExp(`^\\s*${flag.table}\\s*=`);

  const normalized =
    raw.length === 0 || raw.endsWith("\n") ? raw : `${raw}\n`;
  const lines = normalized.length === 0 ? [] : normalized.split("\n");

  if (lines.some((line) => inlinePattern.test(line))) {
    return {
      status: "skipped",
      detail: `${flag.table} is an inline table; set ${detail} manually`,
    };
  }

  const headerIndex = lines.findIndex((line) => line.trim() === header);

  if (headerIndex === -1) {
    const prefix = normalized.length === 0 ? "" : `${normalized}\n`;
    return {
      status: "updated",
      detail,
      content: `${prefix}${header}\n${assignment}\n`,
    };
  }

  let tableEnd = lines.length;
  for (let index = headerIndex + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.trim().startsWith("[")) {
      tableEnd = index;
      break;
    }
  }

  for (let index = headerIndex + 1; index < tableEnd; index += 1) {
    const line = lines[index] ?? "";
    if (!keyPattern.test(line)) {
      continue;
    }

    if (line.trim() === assignment) {
      return { status: "unchanged", detail };
    }

    const next = [...lines];
    next[index] = assignment;
    return {
      status: "updated",
      detail,
      content: next.join("\n"),
    };
  }

  const next = [...lines];
  next.splice(headerIndex + 1, 0, assignment);
  return {
    status: "updated",
    detail,
    content: next.join("\n"),
  };
};

const missingDirsFor = async (path: string): Promise<readonly string[]> => {
  const dirs: string[] = [];
  let current = dirname(path);

  while (!(await pathExists(current))) {
    dirs.push(current);
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return dirs;
};

const isHarnessTool = (value: JsonValue | undefined): value is HarnessTool =>
  value === "claude-code" || value === "codex";

const isHarnessScope = (value: JsonValue | undefined): value is HarnessScope =>
  value === "global" || value === "project";

const stringValue = (value: JsonValue | undefined): string | undefined =>
  typeof value === "string" ? value : undefined;

const booleanValue = (value: JsonValue | undefined): boolean | undefined =>
  typeof value === "boolean" ? value : undefined;

const numberValue = (value: JsonValue | undefined): number | undefined =>
  typeof value === "number" ? value : undefined;

const stringArrayValue = (
  value: JsonValue | undefined,
): readonly string[] =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];

const parseManifestFile = (
  value: JsonValue,
): ManifestFileEntry | undefined => {
  if (!isJsonObject(value)) {
    return undefined;
  }

  const path = stringValue(value["path"]);
  const sha256 = stringValue(value["sha256"]);
  if (path === undefined || sha256 === undefined) {
    return undefined;
  }

  const mode = numberValue(value["mode"]);
  return {
    path,
    sha256,
    ...(mode === undefined ? {} : { mode }),
    createdDirs: stringArrayValue(value["createdDirs"]),
  };
};

const parseManifestSettingsHook = (
  value: JsonValue,
): ManifestSettingsHookEntry | undefined => {
  if (!isJsonObject(value)) {
    return undefined;
  }

  const path = stringValue(value["path"]);
  const scriptPath = stringValue(value["scriptPath"]);
  const command = stringValue(value["command"]);
  const createdFile = booleanValue(value["createdFile"]);

  if (
    path === undefined ||
    scriptPath === undefined ||
    command === undefined ||
    createdFile === undefined
  ) {
    return undefined;
  }

  return {
    path,
    scriptPath,
    command,
    createdFile,
    createdDirs: stringArrayValue(value["createdDirs"]),
  };
};

const parseManifestInstall = (
  value: JsonValue,
): ManifestInstall | undefined => {
  if (!isJsonObject(value)) {
    return undefined;
  }

  const tool = value["tool"];
  const scope = value["scope"];
  const root = stringValue(value["root"]);
  const installedAt = stringValue(value["installedAt"]);

  if (
    !isHarnessTool(tool) ||
    !isHarnessScope(scope) ||
    root === undefined ||
    installedAt === undefined
  ) {
    return undefined;
  }

  const files = Array.isArray(value["files"])
    ? value["files"].flatMap((entry) => {
        const parsed = parseManifestFile(entry);
        return parsed === undefined ? [] : [parsed];
      })
    : [];

  const settingsHooks = Array.isArray(value["settingsHooks"])
    ? value["settingsHooks"].flatMap((entry) => {
        const parsed = parseManifestSettingsHook(entry);
        return parsed === undefined ? [] : [parsed];
      })
    : [];

  return {
    tool,
    scope,
    root,
    installedAt,
    files,
    settingsHooks,
  };
};

const emptyManifest = (): InstallManifest => ({
  version: manifestVersion,
  installs: [],
});

const readManifest = async (path: string): Promise<InstallManifest> => {
  const text = await readTextIfExists(path);
  if (text === undefined) {
    return emptyManifest();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Cannot read install manifest at ${path}: invalid JSON (${message}).`,
      { cause: error },
    );
  }

  if (!isJsonObject(parsed) || parsed["version"] !== manifestVersion) {
    return emptyManifest();
  }

  const installs = Array.isArray(parsed["installs"])
    ? parsed["installs"].flatMap((entry) => {
        const install = parseManifestInstall(entry);
        return install === undefined ? [] : [install];
      })
    : [];

  return {
    version: manifestVersion,
    installs,
  };
};

const writeManifest = async (
  path: string,
  manifest: InstallManifest,
): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, stringifyJson(manifest), "utf8");
};

const installMatchesPlan = (
  install: ManifestInstall,
  plan: HarnessPlan,
): boolean =>
  install.tool === plan.tool &&
  install.scope === plan.scope &&
  install.root === plan.root;

const upsertFileEntry = (
  files: readonly ManifestFileEntry[],
  entry: ManifestFileEntry,
): readonly ManifestFileEntry[] => [
  ...files.filter((file) => file.path !== entry.path),
  entry,
];

const upsertSettingsHookEntry = (
  settingsHooks: readonly ManifestSettingsHookEntry[],
  entry: ManifestSettingsHookEntry,
): readonly ManifestSettingsHookEntry[] => [
  ...settingsHooks.filter((hook) => hook.path !== entry.path),
  entry,
];

const fileReferencedBy = (
  installs: readonly ManifestInstall[],
  path: string,
): boolean =>
  installs.some((install) =>
    install.files.some((file) => file.path === path),
  );

const manifestRecordsContent = (
  installs: readonly ManifestInstall[],
  path: string,
  sha256: string,
): boolean =>
  installs.some((install) =>
    install.files.some(
      (file) => file.path === path && file.sha256 === sha256,
    ),
  );

const withRefreshedHashes = (
  install: ManifestInstall,
  refreshedHashes: ReadonlyMap<string, string>,
): ManifestInstall =>
  refreshedHashes.size === 0
    ? install
    : {
        ...install,
        files: install.files.map((file) => {
          const sha256 = refreshedHashes.get(file.path);
          return sha256 === undefined ? file : { ...file, sha256 };
        }),
      };

const settingsHookReferencedBy = (
  installs: readonly ManifestInstall[],
  hook: ManifestSettingsHookEntry,
): boolean =>
  installs.some((install) =>
    install.settingsHooks.some(
      (candidate) =>
        candidate.path === hook.path &&
        candidate.scriptPath === hook.scriptPath,
    ),
  );

const pruneCreatedDirs = async (
  dirs: readonly string[],
): Promise<readonly HarnessAction[]> => {
  const actions: HarnessAction[] = [];
  const uniqueDirs = [...new Set(dirs)].sort((left, right) => right.length - left.length);

  for (const dir of uniqueDirs) {
    try {
      await rmdir(dir);
      actions.push({
        kind: "directory",
        path: dir,
        status: "pruned",
      });
    } catch (error) {
      if (
        hasErrorCode(error, "ENOENT") ||
        hasErrorCode(error, "ENOTEMPTY") ||
        hasErrorCode(error, "EEXIST")
      ) {
        continue;
      }

      throw error;
    }
  }

  return actions;
};

export const planHarnessInstall = (
  options: HarnessOptions,
): HarnessPlan => {
  const env = options.env ?? process.env;
  const cwd = resolve(options.cwd ?? process.cwd());
  const agentHome = getAgentHome(env);
  const overlearnHome = getOverlearnHome(env);
  const root = options.scope === "global" ? agentHome : cwd;
  const manifestPath = join(overlearnHome, "install-manifest.json");

  const scriptPath = join(overlearnHome, "hooks", "stop-backstop.sh");

  if (options.tool === "codex") {
    // Codex reads hooks from ~/.codex/hooks.json regardless of project;
    // there is no project-level hooks file, so both scopes target agent home.
    return {
      tool: options.tool,
      scope: options.scope,
      root,
      manifestPath,
      files: [
        {
          path: join(root, ".agents", "skills", "learn", "SKILL.md"),
          content: codexSkillContent,
        },
        {
          path: scriptPath,
          content: stopBackstopContent,
          mode: 0o755,
        },
      ],
      settingsHooks: [
        {
          path: join(agentHome, ".codex", "hooks.json"),
          scriptPath,
          command: codexHookCommand(scriptPath),
        },
      ],
      // Codex only runs hooks.json when the feature flag is on; uninstall
      // leaves the flag alone since other hooks may rely on it.
      tomlFlags: [
        {
          path: join(agentHome, ".codex", "config.toml"),
          table: "features",
          key: "hooks",
          value: true,
        },
      ],
    };
  }

  return {
    tool: options.tool,
    scope: options.scope,
    root,
    manifestPath,
    files: [
      {
        path: join(root, ".claude", "skills", "learn", "SKILL.md"),
        content: skillContent,
      },
      {
        path: scriptPath,
        content: stopBackstopContent,
        mode: 0o755,
      },
    ],
    settingsHooks: [
      {
        path: join(root, ".claude", "settings.json"),
        scriptPath,
        command: claudeHookCommand(scriptPath),
      },
    ],
    tomlFlags: [],
  };
};

export const installHarness = async (
  options: HarnessOptions,
): Promise<HarnessInstallResult> => {
  const force = options.force ?? false;
  const plan = planHarnessInstall(options);
  const manifest = await readManifest(plan.manifestPath);
  const settingsMerges = await Promise.all(
    plan.settingsHooks.map((hook) => prepareSettingsMerge(hook)),
  );
  const existingInstall = manifest.installs.find((install) =>
    installMatchesPlan(install, plan),
  );
  const actions: HarnessAction[] = [];
  const refreshedHashes = new Map<string, string>();

  let files = existingInstall?.files ?? [];
  let settingsHooks = existingInstall?.settingsHooks ?? [];

  for (const file of plan.files) {
    const existing = await readTextIfExists(file.path);
    const exists = existing !== undefined;
    const ownedUnmodified =
      exists && manifestRecordsContent(manifest.installs, file.path, hashText(existing));

    if (exists && !force) {
      if (existing === file.content) {
        // Same content, likely installed for another tool: reference it in
        // this install too so uninstalling the other tool keeps the file.
        // A re-run keeps its original entry (and recorded createdDirs).
        const priorEntry = files.find((entry) => entry.path === file.path);
        files = upsertFileEntry(
          files,
          priorEntry ?? {
            path: file.path,
            sha256: hashText(file.content),
            ...(file.mode === undefined ? {} : { mode: file.mode }),
            createdDirs: [],
          },
        );
        actions.push({
          kind: "file",
          path: file.path,
          status: "unchanged",
          detail: "already installed",
        });
        continue;
      }

      // A file that still matches an installed hash is ours and unmodified,
      // so a newer bundled version may refresh it. Anything else was changed
      // by the user and needs --force.
      if (!ownedUnmodified) {
        actions.push({
          kind: "file",
          path: file.path,
          status: "skipped",
          detail: "existing file",
        });
        continue;
      }
    }

    const createdDirs = await missingDirsFor(file.path);
    await mkdir(dirname(file.path), { recursive: true });
    await writeFile(file.path, file.content, "utf8");

    if (file.mode !== undefined) {
      await chmod(file.path, file.mode);
    }

    const sha256 = hashText(file.content);
    refreshedHashes.set(file.path, sha256);
    files = upsertFileEntry(files, {
      path: file.path,
      sha256,
      ...(file.mode === undefined ? {} : { mode: file.mode }),
      createdDirs,
    });
    actions.push({
      kind: "file",
      path: file.path,
      status: exists ? (ownedUnmodified && !force ? "updated" : "overwritten") : "written",
      ...(ownedUnmodified && !force && exists
        ? { detail: "bundled content refreshed" }
        : {}),
    });
  }

  for (const merge of settingsMerges) {
    if (merge.status === "unchanged") {
      // Hook already present (possibly merged by another install of ours):
      // reference it in this install too so uninstalling the other keeps it.
      // A re-run keeps its original entry (and recorded createdFile/dirs).
      const priorEntry = settingsHooks.find(
        (entry) => entry.path === merge.path,
      );
      settingsHooks = upsertSettingsHookEntry(
        settingsHooks,
        priorEntry ?? {
          path: merge.path,
          scriptPath: merge.scriptPath,
          command: merge.command,
          createdFile: false,
          createdDirs: [],
        },
      );
      actions.push({
        kind: "settings-hook",
        path: merge.path,
        status: "skipped",
        detail: "Stop hook already present",
      });
      continue;
    }

    if (merge.content === undefined) {
      throw new Error(`Cannot write Stop hook into ${merge.path}: no settings content prepared.`);
    }

    const createdDirs = await missingDirsFor(merge.path);
    await mkdir(dirname(merge.path), { recursive: true });
    await writeFile(merge.path, merge.content, "utf8");
    settingsHooks = upsertSettingsHookEntry(settingsHooks, {
      path: merge.path,
      scriptPath: merge.scriptPath,
      command: merge.command,
      createdFile: !merge.existed,
      createdDirs,
    });
    actions.push({
      kind: "settings-hook",
      path: merge.path,
      status: "updated",
    });
  }

  for (const flag of plan.tomlFlags) {
    const raw = (await readTextIfExists(flag.path)) ?? "";
    const result = upsertTomlFlag(raw, flag);

    if (result.status === "updated" && result.content !== undefined) {
      await mkdir(dirname(flag.path), { recursive: true });
      await writeFile(flag.path, result.content, "utf8");
    }

    actions.push({
      kind: "config",
      path: flag.path,
      status: result.status === "unchanged" ? "skipped" : result.status,
      detail:
        result.status === "unchanged"
          ? `${result.detail} already set`
          : result.detail,
    });
  }

  const nextInstall: ManifestInstall = {
    tool: plan.tool,
    scope: plan.scope,
    root: plan.root,
    installedAt: new Date().toISOString(),
    files,
    settingsHooks,
  };
  const nextInstalls = [
    ...manifest.installs
      .filter((install) => !installMatchesPlan(install, plan))
      .map((install) => withRefreshedHashes(install, refreshedHashes)),
    nextInstall,
  ].filter(
    (install) => install.files.length > 0 || install.settingsHooks.length > 0,
  );
  await writeManifest(plan.manifestPath, {
    version: manifestVersion,
    installs: nextInstalls,
  });

  return {
    tool: plan.tool,
    scope: plan.scope,
    root: plan.root,
    manifestPath: plan.manifestPath,
    actions,
  };
};

export const uninstallHarness = async (
  options: HarnessOptions,
): Promise<HarnessUninstallResult> => {
  const force = options.force ?? false;
  const plan = planHarnessInstall(options);
  const manifest = await readManifest(plan.manifestPath);
  const install = manifest.installs.find((candidate) =>
    installMatchesPlan(candidate, plan),
  );

  if (install === undefined) {
    return {
      tool: plan.tool,
      scope: plan.scope,
      root: plan.root,
      manifestPath: plan.manifestPath,
      actions: [],
      nothingToUninstall: true,
    };
  }

  const remainingInstalls = manifest.installs.filter(
    (candidate) => !installMatchesPlan(candidate, plan),
  );
  const sharedSettingsHooks = install.settingsHooks.filter((hook) =>
    settingsHookReferencedBy(remainingInstalls, hook),
  );
  const removableSettingsHooks = install.settingsHooks.filter(
    (hook) => !settingsHookReferencedBy(remainingInstalls, hook),
  );
  const settingsRemovals = await Promise.all(
    removableSettingsHooks.map((hook) => prepareSettingsRemoval(hook)),
  );
  const actions: HarnessAction[] = [];
  const dirsToPrune: string[] = [];
  const retainedFiles: ManifestFileEntry[] = [];

  for (const hook of sharedSettingsHooks) {
    actions.push({
      kind: "settings-hook",
      path: hook.path,
      status: "kept",
      detail: "still referenced by another harness install",
    });
  }

  for (const file of install.files) {
    if (fileReferencedBy(remainingInstalls, file.path)) {
      actions.push({
        kind: "file",
        path: file.path,
        status: "kept",
        detail: "still referenced by another harness install",
      });
      continue;
    }

    const text = await readTextIfExists(file.path);
    if (text === undefined) {
      actions.push({
        kind: "file",
        path: file.path,
        status: "missing",
      });
      dirsToPrune.push(...file.createdDirs);
      continue;
    }

    if (hashText(text) !== file.sha256 && !force) {
      actions.push({
        kind: "file",
        path: file.path,
        status: "kept",
        detail: "content changed since install",
      });
      retainedFiles.push(file);
      continue;
    }

    await unlink(file.path);
    actions.push({
      kind: "file",
      path: file.path,
      status: "removed",
    });
    dirsToPrune.push(...file.createdDirs);
  }

  for (const removal of settingsRemovals) {
    if (removal.status === "missing") {
      actions.push({
        kind: "settings-hook",
        path: removal.entry.path,
        status: "missing",
      });
      dirsToPrune.push(...removal.entry.createdDirs);
      continue;
    }

    if (removal.status === "unchanged") {
      actions.push({
        kind: "settings-hook",
        path: removal.entry.path,
        status: "missing",
        detail: "Stop hook entry was already absent",
      });
      continue;
    }

    if (removal.status === "removed") {
      await unlink(removal.entry.path);
      actions.push({
        kind: "settings-hook",
        path: removal.entry.path,
        status: "removed",
      });
      dirsToPrune.push(...removal.entry.createdDirs);
      continue;
    }

    if (removal.content === undefined) {
      throw new Error(`Cannot update hook settings at ${removal.entry.path}: no settings content prepared.`);
    }

    await writeFile(removal.entry.path, removal.content, "utf8");
    actions.push({
      kind: "settings-hook",
      path: removal.entry.path,
      status: "updated",
    });
    dirsToPrune.push(...removal.entry.createdDirs);
  }

  actions.push(...(await pruneCreatedDirs(dirsToPrune)));

  const retainedInstalls =
    retainedFiles.length === 0
      ? remainingInstalls
      : [
          ...remainingInstalls,
          {
            ...install,
            files: retainedFiles,
            settingsHooks: [],
          },
        ];

  await writeManifest(plan.manifestPath, {
    version: manifestVersion,
    installs: retainedInstalls,
  });

  return {
    tool: plan.tool,
    scope: plan.scope,
    root: plan.root,
    manifestPath: plan.manifestPath,
    actions,
    nothingToUninstall: false,
  };
};

const scopeLabel = (scope: HarnessScope): string =>
  scope === "global" ? "global" : "project";

const formatAction = (action: HarnessAction): string => {
  const detail = action.detail === undefined ? "" : ` (${action.detail})`;

  if (action.status === "skipped") {
    return `skipped ${action.kind}: ${action.path}${detail}`;
  }

  if (action.status === "kept") {
    return `kept ${action.kind}: ${action.path}${detail}`;
  }

  return `${action.status} ${action.kind}: ${action.path}${detail}`;
};

export const formatInstallHarnessResult = (
  result: HarnessInstallResult,
): string =>
  [
    `learn ${result.tool} harness install (${scopeLabel(result.scope)}):`,
    ...result.actions.map(formatAction),
    `manifest: ${result.manifestPath}`,
  ].join("\n");

export const formatUninstallHarnessResult = (
  result: HarnessUninstallResult,
): string => {
  if (result.nothingToUninstall) {
    return `nothing to uninstall for ${result.tool} (${scopeLabel(result.scope)})`;
  }

  return [
    `learn ${result.tool} harness uninstall (${scopeLabel(result.scope)}):`,
    ...result.actions.map(formatAction),
    `manifest: ${result.manifestPath}`,
  ].join("\n");
};

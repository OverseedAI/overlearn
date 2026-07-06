import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

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
  kind: "file" | "settings-hook" | "directory";
  path: string;
  status:
    | "updated"
    | "removed"
    | "missing"
    | "kept"
    | "pruned";
  detail?: string;
}>;

export type HarnessUninstallResult = Readonly<{
  tool: HarnessTool;
  scope: HarnessScope;
  root: string;
  manifestPath: string;
  actions: readonly HarnessAction[];
  nothingToUninstall: boolean;
}>;

type JsonPrimitive = string | number | boolean | null;
type JsonObject = { [key: string]: JsonValue };
type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

type HarnessTarget = Readonly<{
  tool: HarnessTool;
  scope: HarnessScope;
  root: string;
  manifestPath: string;
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

type SettingsRemoval = Readonly<{
  entry: ManifestSettingsHookEntry;
  existed: boolean;
  status: "updated" | "unchanged" | "removed" | "missing";
  content?: string;
}>;

const manifestVersion = 1 as const;

const hasErrorCode = (error: unknown, code: string): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error["code"] === code;

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

const stringifyJson = (value: unknown): string =>
  `${JSON.stringify(value, null, 2)}\n`;

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

const installMatchesTarget = (
  install: ManifestInstall,
  target: HarnessTarget,
): boolean =>
  install.tool === target.tool &&
  install.scope === target.scope &&
  install.root === target.root;

const fileReferencedBy = (
  installs: readonly ManifestInstall[],
  path: string,
): boolean =>
  installs.some((install) =>
    install.files.some((file) => file.path === path),
  );

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

const resolveHarnessTarget = (options: HarnessOptions): HarnessTarget => {
  const env = options.env ?? process.env;
  const cwd = resolve(options.cwd ?? process.cwd());
  const agentHome = getAgentHome(env);
  const overlearnHome = getOverlearnHome(env);
  const root = options.scope === "global" ? agentHome : cwd;

  return {
    tool: options.tool,
    scope: options.scope,
    root,
    manifestPath: join(overlearnHome, "install-manifest.json"),
  };
};

export const uninstallHarness = async (
  options: HarnessOptions,
): Promise<HarnessUninstallResult> => {
  const force = options.force ?? false;
  const target = resolveHarnessTarget(options);
  const manifest = await readManifest(target.manifestPath);
  const install = manifest.installs.find((candidate) =>
    installMatchesTarget(candidate, target),
  );

  if (install === undefined) {
    return {
      tool: target.tool,
      scope: target.scope,
      root: target.root,
      manifestPath: target.manifestPath,
      actions: [],
      nothingToUninstall: true,
    };
  }

  const remainingInstalls = manifest.installs.filter(
    (candidate) => !installMatchesTarget(candidate, target),
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

  await writeManifest(target.manifestPath, {
    version: manifestVersion,
    installs: retainedInstalls,
  });

  return {
    tool: target.tool,
    scope: target.scope,
    root: target.root,
    manifestPath: target.manifestPath,
    actions,
    nothingToUninstall: false,
  };
};

const scopeLabel = (scope: HarnessScope): string =>
  scope === "global" ? "global" : "project";

const formatAction = (action: HarnessAction): string => {
  const detail = action.detail === undefined ? "" : ` (${action.detail})`;

  if (action.status === "kept") {
    return `kept ${action.kind}: ${action.path}${detail}`;
  }

  return `${action.status} ${action.kind}: ${action.path}${detail}`;
};

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

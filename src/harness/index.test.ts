import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  formatUninstallHarnessResult,
  uninstallHarness,
  type HarnessOptions,
  type HarnessScope,
  type HarnessTool,
} from "./index";

type HarnessFixture = Readonly<{
  root: string;
  agentHome: string;
  overlearnHome: string;
  projectDir: string;
  env: Record<string, string>;
}>;

type ManifestFile = Readonly<{
  path: string;
  sha256: string;
  createdDirs: readonly string[];
}>;

type ManifestSettingsHook = Readonly<{
  path: string;
  scriptPath: string;
  command: string;
  createdFile: boolean;
  createdDirs: readonly string[];
}>;

type ManifestEntry = Readonly<{
  tool: HarnessTool;
  scope: HarnessScope;
  root: string;
  installedAt: string;
  files: readonly ManifestFile[];
  settingsHooks: readonly ManifestSettingsHook[];
}>;

const withFixture = async (
  fn: (fixture: HarnessFixture) => Promise<void>,
): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "overlearn-harness-"));
  const fixture = {
    root,
    agentHome: join(root, "agent-home"),
    overlearnHome: join(root, "overlearn-home"),
    projectDir: join(root, "project"),
    env: {
      OVERLEARN_AGENT_HOME: join(root, "agent-home"),
      OVERLEARN_HOME: join(root, "overlearn-home"),
    },
  };

  try {
    await mkdir(fixture.projectDir, { recursive: true });
    await fn(fixture);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

const readJson = async <T>(path: string): Promise<T> =>
  JSON.parse(await readFile(path, "utf8")) as T;

const exists = async (path: string): Promise<boolean> => {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
};

const writeText = async (path: string, text: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, "utf8");
};

const sha256 = (text: string): string =>
  createHash("sha256").update(text).digest("hex");

const manifestPath = (fixture: HarnessFixture): string =>
  join(fixture.overlearnHome, "install-manifest.json");

const writeManifest = async (
  fixture: HarnessFixture,
  installs: readonly ManifestEntry[],
): Promise<void> => {
  await writeText(
    manifestPath(fixture),
    `${JSON.stringify({ version: 1, installs }, null, 2)}\n`,
  );
};

const harnessOptions = (
  fixture: HarnessFixture,
  options: Pick<HarnessOptions, "tool" | "scope" | "force">,
): HarnessOptions => ({
  ...options,
  env: fixture.env,
  cwd: fixture.projectDir,
});

const installEntry = (
  fixture: HarnessFixture,
  options: Readonly<{
    tool: HarnessTool;
    scope: HarnessScope;
    files?: readonly ManifestFile[];
    settingsHooks?: readonly ManifestSettingsHook[];
  }>,
): ManifestEntry => ({
  tool: options.tool,
  scope: options.scope,
  root: options.scope === "global" ? fixture.agentHome : fixture.projectDir,
  installedAt: "2026-01-01T00:00:00.000Z",
  files: options.files ?? [],
  settingsHooks: options.settingsHooks ?? [],
});

describe("harness uninstall", () => {
  test("uninstall with no manifest is a clean no-op", async () => {
    await withFixture(async (fixture) => {
      const result = await uninstallHarness(
        harnessOptions(fixture, { tool: "codex", scope: "global" }),
      );

      expect(result.nothingToUninstall).toBe(true);
      expect(result.actions).toEqual([]);
      expect(formatUninstallHarnessResult(result)).toBe(
        "nothing to uninstall for codex (global)",
      );
    });
  });

  test("removes manifest-owned files and only the matching settings entry", async () => {
    await withFixture(async (fixture) => {
      const ownedPath = join(fixture.agentHome, ".overlearn-agent", "owned.md");
      const scriptPath = join(fixture.overlearnHome, "hooks", "loop.sh");
      const settingsPath = join(fixture.agentHome, ".claude", "settings.json");
      const ownedContent = "# Owned by old setup\n";
      const scriptContent = "#!/bin/sh\nexit 0\n";

      await writeText(ownedPath, ownedContent);
      await writeText(scriptPath, scriptContent);
      await writeText(
        settingsPath,
        `${JSON.stringify(
          {
            theme: "dark",
            hooks: {
              Stop: [
                {
                  hooks: [
                    {
                      type: "command",
                      command: `bash '${scriptPath}'`,
                      timeout: 10,
                    },
                  ],
                },
                {
                  hooks: [{ command: "echo user-stop" }],
                },
              ],
            },
          },
          null,
          2,
        )}\n`,
      );
      await writeManifest(fixture, [
        installEntry(fixture, {
          tool: "claude-code",
          scope: "global",
          files: [
            {
              path: ownedPath,
              sha256: sha256(ownedContent),
              createdDirs: [dirname(ownedPath)],
            },
            {
              path: scriptPath,
              sha256: sha256(scriptContent),
              createdDirs: [dirname(scriptPath)],
            },
          ],
          settingsHooks: [
            {
              path: settingsPath,
              scriptPath,
              command: `bash '${scriptPath}'`,
              createdFile: false,
              createdDirs: [dirname(settingsPath)],
            },
          ],
        }),
      ]);

      const result = await uninstallHarness(
        harnessOptions(fixture, { tool: "claude-code", scope: "global" }),
      );
      const output = formatUninstallHarnessResult(result);

      expect(result.nothingToUninstall).toBe(false);
      expect(output).toContain("removed file");
      expect(await exists(ownedPath)).toBe(false);
      expect(await exists(scriptPath)).toBe(false);

      const afterSettings = await readJson<{
        theme: string;
        hooks: { Stop: Array<unknown> };
      }>(settingsPath);
      expect(afterSettings.theme).toBe("dark");
      expect(afterSettings.hooks.Stop).toHaveLength(1);
      expect(JSON.stringify(afterSettings)).toContain("echo user-stop");
      expect(JSON.stringify(afterSettings)).not.toContain(scriptPath);

      const manifest = await readJson<{ installs: unknown[] }>(
        manifestPath(fixture),
      );
      expect(manifest.installs).toEqual([]);
    });
  });

  test("leaves changed manifest-owned files unless forced", async () => {
    await withFixture(async (fixture) => {
      const options = harnessOptions(fixture, { tool: "codex", scope: "global" });
      const ownedPath = join(fixture.agentHome, ".overlearn-agent", "owned.md");
      const original = "# Original\n";

      await writeText(ownedPath, "# User changed content\n");
      await writeManifest(fixture, [
        installEntry(fixture, {
          tool: "codex",
          scope: "global",
          files: [
            {
              path: ownedPath,
              sha256: sha256(original),
              createdDirs: [dirname(ownedPath)],
            },
          ],
        }),
      ]);

      const kept = await uninstallHarness(options);
      expect(kept.actions).toContainEqual(
        expect.objectContaining({
          path: ownedPath,
          status: "kept",
          detail: "content changed since install",
        }),
      );
      expect(await readFile(ownedPath, "utf8")).toBe("# User changed content\n");

      const retained = await readJson<{
        installs: Array<{ files: Array<{ path: string }>; settingsHooks: unknown[] }>;
      }>(manifestPath(fixture));
      expect(retained.installs).toHaveLength(1);
      expect(retained.installs[0]?.files).toEqual([
        expect.objectContaining({ path: ownedPath }),
      ]);
      expect(retained.installs[0]?.settingsHooks).toEqual([]);

      const forced = await uninstallHarness({ ...options, force: true });
      expect(forced.actions).toContainEqual(
        expect.objectContaining({ path: ownedPath, status: "removed" }),
      );
      expect(await exists(ownedPath)).toBe(false);
    });
  });

  test("keeps files and settings entries still referenced by another install", async () => {
    await withFixture(async (fixture) => {
      const sharedPath = join(fixture.overlearnHome, "hooks", "loop.sh");
      const settingsPath = join(fixture.agentHome, ".codex", "settings.json");
      const sharedContent = "#!/bin/sh\nexit 0\n";
      const settingsHook = {
        path: settingsPath,
        scriptPath: sharedPath,
        command: `bash '${sharedPath}'`,
        createdFile: true,
        createdDirs: [dirname(settingsPath)],
      };

      await writeText(sharedPath, sharedContent);
      await writeText(
        settingsPath,
        `${JSON.stringify(
          {
            hooks: {
              Stop: [
                {
                  hooks: [{ command: `bash '${sharedPath}'` }],
                },
              ],
            },
          },
          null,
          2,
        )}\n`,
      );
      await writeManifest(fixture, [
        installEntry(fixture, {
          tool: "codex",
          scope: "global",
          files: [
            {
              path: sharedPath,
              sha256: sha256(sharedContent),
              createdDirs: [dirname(sharedPath)],
            },
          ],
          settingsHooks: [settingsHook],
        }),
        installEntry(fixture, {
          tool: "codex",
          scope: "project",
          files: [
            {
              path: sharedPath,
              sha256: sha256(sharedContent),
              createdDirs: [dirname(sharedPath)],
            },
          ],
          settingsHooks: [settingsHook],
        }),
      ]);

      const result = await uninstallHarness(
        harnessOptions(fixture, { tool: "codex", scope: "global" }),
      );

      expect(result.actions).toContainEqual(
        expect.objectContaining({
          kind: "file",
          path: sharedPath,
          status: "kept",
          detail: "still referenced by another harness install",
        }),
      );
      expect(result.actions).toContainEqual(
        expect.objectContaining({
          kind: "settings-hook",
          path: settingsPath,
          status: "kept",
          detail: "still referenced by another harness install",
        }),
      );
      expect(await exists(sharedPath)).toBe(true);
      expect(JSON.stringify(await readJson(settingsPath))).toContain(sharedPath);

      const manifest = await readJson<{ installs: Array<{ scope: string }> }>(
        manifestPath(fixture),
      );
      expect(manifest.installs).toEqual([
        expect.objectContaining({ scope: "project" }),
      ]);
    });
  });
});

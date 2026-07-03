import { describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import stopBackstop from "../../plugin/hooks/stop-backstop.sh" with { type: "text" };
import learnSkill from "../../plugin/skills/learn/SKILL.md" with { type: "text" };
import {
  formatInstallHarnessResult,
  formatUninstallHarnessResult,
  installHarness,
  planHarnessInstall,
  uninstallHarness,
  type HarnessOptions,
} from "./index";

type HarnessFixture = Readonly<{
  root: string;
  agentHome: string;
  overlearnHome: string;
  projectDir: string;
  env: Record<string, string>;
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

const harnessOptions = (
  fixture: HarnessFixture,
  options: Pick<HarnessOptions, "tool" | "scope" | "force">,
): HarnessOptions => ({
  ...options,
  env: fixture.env,
  cwd: fixture.projectDir,
});

describe("harness install", () => {
  test("fresh claude-code install writes skill, hook, settings, and manifest", async () => {
    await withFixture(async (fixture) => {
      const result = await installHarness(
        harnessOptions(fixture, { tool: "claude-code", scope: "global" }),
      );
      const plan = planHarnessInstall(
        harnessOptions(fixture, { tool: "claude-code", scope: "global" }),
      );

      const skillPath = join(
        fixture.agentHome,
        ".claude",
        "skills",
        "learn",
        "SKILL.md",
      );
      const hookPath = join(
        fixture.overlearnHome,
        "hooks",
        "stop-backstop.sh",
      );
      const settingsPath = join(fixture.agentHome, ".claude", "settings.json");

      expect(result.actions.map((action) => action.status)).toEqual([
        "written",
        "written",
        "updated",
      ]);
      expect(await readFile(skillPath, "utf8")).toBe(`${learnSkill.trimEnd()}\n`);
      expect(await readFile(hookPath, "utf8")).toBe(
        `${stopBackstop.trimEnd()}\n`,
      );
      expect((await stat(hookPath)).mode & 0o777).toBe(0o755);

      const settings = await readJson<{ hooks: { Stop: unknown[] } }>(
        settingsPath,
      );
      expect(JSON.stringify(settings.hooks.Stop)).toContain(hookPath);

      const manifest = await readJson<{
        installs: Array<{
          tool: string;
          scope: string;
          root: string;
          files: Array<{ path: string; sha256: string }>;
          settingsHooks: Array<{ path: string; scriptPath: string }>;
        }>;
      }>(plan.manifestPath);
      expect(manifest.installs).toHaveLength(1);
      expect(manifest.installs[0]).toEqual(
        expect.objectContaining({
          tool: "claude-code",
          scope: "global",
          root: fixture.agentHome,
        }),
      );
      expect(manifest.installs[0]?.files.map((file) => file.path).sort()).toEqual(
        [hookPath, skillPath].sort(),
      );
      expect(manifest.installs[0]?.settingsHooks).toEqual([
        expect.objectContaining({
          path: settingsPath,
          scriptPath: hookPath,
        }),
      ]);
    });
  });

  test("re-run skips existing files and hook without dropping manifest entries", async () => {
    await withFixture(async (fixture) => {
      const options = harnessOptions(fixture, {
        tool: "claude-code",
        scope: "global",
      });
      await installHarness(options);

      const second = await installHarness(options);
      const output = formatInstallHarnessResult(second);
      expect(second.actions).toEqual([
        expect.objectContaining({ kind: "file", status: "skipped" }),
        expect.objectContaining({ kind: "file", status: "skipped" }),
        expect.objectContaining({ kind: "settings-hook", status: "skipped" }),
      ]);
      expect(output).toContain("skipped file");

      const manifest = await readJson<{ installs: unknown[] }>(
        planHarnessInstall(options).manifestPath,
      );
      expect(manifest.installs).toHaveLength(1);
    });
  });

  test("--force overwrites existing installed skill content", async () => {
    await withFixture(async (fixture) => {
      const options = harnessOptions(fixture, { tool: "codex", scope: "global" });
      const skillPath = join(
        fixture.agentHome,
        ".agents",
        "skills",
        "learn",
        "SKILL.md",
      );
      await writeText(skillPath, "# User skill\n");

      const skipped = await installHarness(options);
      expect(skipped.actions).toEqual([
        expect.objectContaining({ path: skillPath, status: "skipped" }),
      ]);
      expect(await readFile(skillPath, "utf8")).toBe("# User skill\n");

      const forced = await installHarness({ ...options, force: true });
      expect(forced.actions).toEqual([
        expect.objectContaining({ path: skillPath, status: "overwritten" }),
      ]);
      expect(await readFile(skillPath, "utf8")).toBe(`${learnSkill.trimEnd()}\n`);
    });
  });

  test("settings merge preserves unrelated keys and hooks", async () => {
    await withFixture(async (fixture) => {
      const settingsPath = join(fixture.agentHome, ".claude", "settings.json");
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
                      command: "echo user-stop",
                      timeout: 2,
                    },
                  ],
                },
              ],
              PreToolUse: [{ matcher: "Bash" }],
            },
          },
          null,
          2,
        )}\n`,
      );

      await installHarness(
        harnessOptions(fixture, { tool: "claude-code", scope: "global" }),
      );

      const hookPath = join(
        fixture.overlearnHome,
        "hooks",
        "stop-backstop.sh",
      );
      const settings = await readJson<{
        theme: string;
        hooks: {
          Stop: Array<{ hooks: Array<{ command: string }> }>;
          PreToolUse: unknown[];
        };
      }>(settingsPath);

      expect(settings.theme).toBe("dark");
      expect(settings.hooks.PreToolUse).toEqual([{ matcher: "Bash" }]);
      expect(settings.hooks.Stop).toHaveLength(2);
      expect(JSON.stringify(settings.hooks.Stop[0])).toContain("echo user-stop");
      expect(JSON.stringify(settings.hooks.Stop[1])).toContain(hookPath);
    });
  });

  test("malformed Claude settings aborts before writing files", async () => {
    await withFixture(async (fixture) => {
      const settingsPath = join(fixture.agentHome, ".claude", "settings.json");
      await writeText(settingsPath, "{ nope\n");

      await expect(
        installHarness(
          harnessOptions(fixture, { tool: "claude-code", scope: "global" }),
        ),
      ).rejects.toThrow("invalid JSON");

      expect(
        await exists(
          join(fixture.agentHome, ".claude", "skills", "learn", "SKILL.md"),
        ),
      ).toBe(false);
      expect(
        await exists(join(fixture.overlearnHome, "hooks", "stop-backstop.sh")),
      ).toBe(false);
    });
  });

  test("codex install writes only the codex skill path", async () => {
    await withFixture(async (fixture) => {
      const result = await installHarness(
        harnessOptions(fixture, { tool: "codex", scope: "global" }),
      );
      const skillPath = join(
        fixture.agentHome,
        ".agents",
        "skills",
        "learn",
        "SKILL.md",
      );

      expect(result.actions).toEqual([
        expect.objectContaining({ path: skillPath, status: "written" }),
      ]);
      expect(await readFile(skillPath, "utf8")).toBe(`${learnSkill.trimEnd()}\n`);
      expect(await exists(join(fixture.agentHome, ".claude"))).toBe(false);
      expect(await exists(join(fixture.overlearnHome, "hooks"))).toBe(false);
    });
  });

  test("--project claude-code install targets project .claude paths", async () => {
    await withFixture(async (fixture) => {
      await installHarness(
        harnessOptions(fixture, { tool: "claude-code", scope: "project" }),
      );

      const skillPath = join(
        fixture.projectDir,
        ".claude",
        "skills",
        "learn",
        "SKILL.md",
      );
      const settingsPath = join(fixture.projectDir, ".claude", "settings.json");
      const hookPath = join(
        fixture.overlearnHome,
        "hooks",
        "stop-backstop.sh",
      );
      const manifest = await readJson<{
        installs: Array<{ root: string; scope: string }>;
      }>(join(fixture.overlearnHome, "install-manifest.json"));

      expect(await exists(skillPath)).toBe(true);
      expect(JSON.stringify(await readJson(settingsPath))).toContain(hookPath);
      expect(await exists(join(fixture.agentHome, ".claude"))).toBe(false);
      expect(manifest.installs[0]).toEqual(
        expect.objectContaining({
          root: fixture.projectDir,
          scope: "project",
        }),
      );
    });
  });
});

describe("harness uninstall", () => {
  test("uninstall removes manifest-owned files and only the installed hook", async () => {
    await withFixture(async (fixture) => {
      const options = harnessOptions(fixture, {
        tool: "claude-code",
        scope: "global",
      });
      await installHarness(options);

      const skillPath = join(
        fixture.agentHome,
        ".claude",
        "skills",
        "learn",
        "SKILL.md",
      );
      const hookPath = join(
        fixture.overlearnHome,
        "hooks",
        "stop-backstop.sh",
      );
      const settingsPath = join(fixture.agentHome, ".claude", "settings.json");
      const settings = await readJson<{
        theme?: string;
        hooks: { Stop: Array<{ hooks: Array<{ command: string }> }> };
      }>(settingsPath);
      settings.theme = "dark";
      settings.hooks.Stop.push({
        hooks: [
          {
            command: "echo user-stop",
          },
        ],
      });
      await writeText(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);

      const result = await uninstallHarness(options);
      const output = formatUninstallHarnessResult(result);

      expect(result.nothingToUninstall).toBe(false);
      expect(output).toContain("removed file");
      expect(await exists(skillPath)).toBe(false);
      expect(await exists(hookPath)).toBe(false);

      const afterSettings = await readJson<{
        theme: string;
        hooks: { Stop: Array<unknown> };
      }>(settingsPath);
      expect(afterSettings.theme).toBe("dark");
      expect(afterSettings.hooks.Stop).toHaveLength(1);
      expect(JSON.stringify(afterSettings)).toContain("echo user-stop");
      expect(JSON.stringify(afterSettings)).not.toContain(hookPath);

      const manifest = await readJson<{ installs: unknown[] }>(
        join(fixture.overlearnHome, "install-manifest.json"),
      );
      expect(manifest.installs).toEqual([]);
    });
  });

  test("uninstall leaves changed installed files unless forced", async () => {
    await withFixture(async (fixture) => {
      const options = harnessOptions(fixture, { tool: "codex", scope: "global" });
      await installHarness(options);

      const skillPath = join(
        fixture.agentHome,
        ".agents",
        "skills",
        "learn",
        "SKILL.md",
      );
      await writeText(skillPath, "# User changed skill\n");

      const kept = await uninstallHarness(options);
      expect(kept.actions).toContainEqual(
        expect.objectContaining({
          path: skillPath,
          status: "kept",
          detail: "content changed since install",
        }),
      );
      expect(await readFile(skillPath, "utf8")).toBe("# User changed skill\n");
      const manifest = await readJson<{
        installs: Array<{
          tool: string;
          files: Array<{ path: string }>;
          settingsHooks: unknown[];
        }>;
      }>(join(fixture.overlearnHome, "install-manifest.json"));
      expect(manifest.installs).toHaveLength(1);
      expect(manifest.installs[0]).toEqual(
        expect.objectContaining({
          tool: "codex",
          settingsHooks: [],
        }),
      );
      expect(manifest.installs[0]?.files).toEqual([
        expect.objectContaining({ path: skillPath }),
      ]);

      const forced = await uninstallHarness({ ...options, force: true });
      expect(forced.actions).toContainEqual(
        expect.objectContaining({ path: skillPath, status: "removed" }),
      );
      expect(await exists(skillPath)).toBe(false);
    });
  });

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

  test("project uninstall removes project codex skill without touching global paths", async () => {
    await withFixture(async (fixture) => {
      const projectOptions = harnessOptions(fixture, {
        tool: "codex",
        scope: "project",
      });
      await installHarness(projectOptions);

      const projectSkill = join(
        fixture.projectDir,
        ".agents",
        "skills",
        "learn",
        "SKILL.md",
      );
      const globalSkill = join(
        fixture.agentHome,
        ".agents",
        "skills",
        "learn",
        "SKILL.md",
      );
      await writeText(globalSkill, "# Global user skill\n");

      await uninstallHarness(projectOptions);

      expect(await exists(projectSkill)).toBe(false);
      expect(await readFile(globalSkill, "utf8")).toBe("# Global user skill\n");
    });
  });
});

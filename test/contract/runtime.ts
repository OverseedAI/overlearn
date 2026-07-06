import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ensureCourseScaffold,
  readDaemonMetadata,
  type TurnFile,
} from "../../src/course";
import {
  killDaemon,
  type ProcessResult,
  runProcess,
  waitForDaemonStopped,
} from "../helpers/daemon";

export type ContractRuntimeName = "source" | "binary" | "sidecar";

type ContractRuntime = Readonly<{
  name: ContractRuntimeName;
  command: readonly string[];
  startCommand: "start" | "resume";
  missing?: string;
}>;

type ContractEnvContext = Readonly<{
  coursesDir: string;
  courseName: string;
  courseDir: string;
  logPath: string;
}>;

type ContractExtraEnv =
  | Record<string, string>
  | ((context: ContractEnvContext) => Record<string, string>);

export type StartedContractDaemon = Readonly<{
  runtime: ContractRuntimeName;
  coursesDir: string;
  courseName: string;
  courseDir: string;
  env: Record<string, string>;
  logPath: string;
  url: string;
  pid: number;
  runCli: (
    args: readonly string[],
    extraEnv?: Record<string, string>,
  ) => Promise<ProcessResult>;
  stop: () => Promise<void>;
  cleanup: () => Promise<void>;
}>;

type StartContractOptions = Readonly<{
  scenario?: string;
  orchestrated?: boolean;
  extraEnv?: ContractExtraEnv;
}>;

const repoRoot = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const cliPath = join(repoRoot, "src", "cli", "index.ts");
const binaryPath = join(repoRoot, "dist", "learn");
const sidecarBinDir = join(repoRoot, "src-tauri", "bin");
const fixturePath = join(repoRoot, "test", "fixtures", "fake-acp-agent.ts");

const isCi = (): boolean => process.env["CI"] === "true";

const hostTriple = (): string | undefined => {
  if (process.platform === "linux" && process.arch === "x64") {
    return "x86_64-unknown-linux-gnu";
  }

  if (process.platform === "linux" && process.arch === "arm64") {
    return "aarch64-unknown-linux-gnu";
  }

  if (process.platform === "darwin" && process.arch === "x64") {
    return "x86_64-apple-darwin";
  }

  if (process.platform === "darwin" && process.arch === "arm64") {
    return "aarch64-apple-darwin";
  }

  if (process.platform === "win32" && process.arch === "x64") {
    return "x86_64-pc-windows-msvc";
  }

  return undefined;
};

const resolveSidecarPath = (): string => {
  const explicit = process.env["OVERLEARN_CONTRACT_SIDECAR_PATH"];
  if (explicit !== undefined && explicit.length > 0) {
    return explicit;
  }

  const triple = process.env["TAURI_TARGET_TRIPLE"] ?? hostTriple();
  if (triple !== undefined) {
    const candidate = join(sidecarBinDir, `learn-${triple}`);
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  const candidates = existsSync(sidecarBinDir)
    ? readdirSync(sidecarBinDir)
        .filter((entry) => entry.startsWith("learn-"))
        .map((entry) => join(sidecarBinDir, entry))
    : [];

  if (candidates.length === 1) {
    const [candidate] = candidates;
    if (candidate !== undefined) {
      return candidate;
    }
  }

  return join(sidecarBinDir, `learn-${triple ?? "<target-triple>"}`);
};

const requestedRuntimeName = (): ContractRuntimeName => {
  const raw = process.env["OVERLEARN_CONTRACT_RUNTIME"] ?? "source";

  if (raw === "source" || raw === "binary" || raw === "sidecar") {
    return raw;
  }

  throw new Error(
    `Unknown OVERLEARN_CONTRACT_RUNTIME: ${raw}. Expected source, binary, or sidecar.`,
  );
};

export const resolveContractRuntime = (): ContractRuntime => {
  const name = requestedRuntimeName();

  if (name === "source") {
    return {
      name,
      command: [process.execPath, cliPath],
      startCommand: "start",
    };
  }

  if (name === "binary") {
    const missing = existsSync(binaryPath)
      ? {}
      : {
          missing: `Missing ${binaryPath}. Run \`bun run build\` before \`OVERLEARN_CONTRACT_RUNTIME=binary bun run test:contract\`.`,
        };

    return {
      name,
      command: [binaryPath],
      startCommand: "start",
      ...missing,
    };
  }

  const sidecarPath = resolveSidecarPath();
  const missing = existsSync(sidecarPath)
    ? {}
    : {
        missing: `Missing ${sidecarPath}. Run \`bun run build && bun run app:copy-sidecar\` before \`OVERLEARN_CONTRACT_RUNTIME=sidecar bun run test:contract\`.`,
      };

  return {
    name,
    command: [sidecarPath],
    startCommand: "resume",
    ...missing,
  };
};

export const checkContractRuntime = (
  runtime: ContractRuntime,
): string | undefined => {
  if (runtime.missing === undefined) {
    return undefined;
  }

  const message = `${runtime.name} contract runtime is unavailable: ${runtime.missing}`;
  if (isCi()) {
    throw new Error(message);
  }

  console.warn(`Skipping ${runtime.name} contract tests: ${runtime.missing}`);
  return message;
};

const contractEnv = (
  context: ContractEnvContext,
  scenario: string,
  orchestrated: boolean,
  extra: Record<string, string>,
): Record<string, string> => {
  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }

  env["OVERLEARN_COURSES_DIR"] = context.coursesDir;
  env["OVERLEARN_NO_BROWSER"] = "1";
  env["OVERLEARN_ORCHESTRATED"] = orchestrated ? "1" : "0";
  env["OVERLEARN_HARNESS_CMD"] = JSON.stringify([
    process.execPath,
    fixturePath,
    scenario,
  ]);
  env["FAKE_ACP_LOG"] = context.logPath;
  env["CLAUDECODE"] = "nested-agent";
  env["NO_COLOR"] = "1";
  delete env["FORCE_COLOR"];

  return { ...env, ...extra };
};

const runRuntimeCli = (
  runtime: ContractRuntime,
  args: readonly string[],
  env: Record<string, string>,
): Promise<ProcessResult> =>
  runProcess(
    [...runtime.command, ...args],
    env,
    `${runtime.name} ${args.join(" ")}`,
  );

export const startContractDaemon = async (
  runtime: ContractRuntime,
  options: StartContractOptions = {},
): Promise<StartedContractDaemon> => {
  if (runtime.missing !== undefined) {
    throw new Error(runtime.missing);
  }

  const scenario = options.scenario ?? "normal";
  const orchestrated = options.orchestrated ?? true;
  const coursesDir = await mkdtemp(join(tmpdir(), "overlearn-contract-"));
  const courseName = `contract-${runtime.name}-${scenario}-${Date.now()}`;
  const courseDir = join(coursesDir, courseName);
  const logPath = join(coursesDir, "fake-acp.jsonl");
  const context = { coursesDir, courseName, courseDir, logPath };
  const extra =
    typeof options.extraEnv === "function"
      ? options.extraEnv(context)
      : (options.extraEnv ?? {});
  const env = contractEnv(context, scenario, orchestrated, extra);

  if (runtime.startCommand === "resume") {
    await ensureCourseScaffold(courseName, env);
  }

  const start = await runRuntimeCli(
    runtime,
    [runtime.startCommand, courseName],
    env,
  );
  if (start.exitCode !== 0 || start.stderr.length > 0) {
    throw new Error(
      [
        `${runtime.name} ${runtime.startCommand} failed with exit ${start.exitCode}.`,
        start.stderr.trim(),
        start.stdout.trim(),
      ]
        .filter((line) => line.length > 0)
        .join("\n"),
    );
  }

  const metadata = await readDaemonMetadata(courseDir);
  if (metadata === undefined) {
    throw new Error("Daemon metadata was not written.");
  }

  const url =
    runtime.name === "sidecar"
      ? `http://localhost:${metadata.port}`
      : start.stdout.trim();
  if (!/^http:\/\/localhost:\d+$/.test(url)) {
    throw new Error(`Unexpected daemon URL: ${url}`);
  }

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) {
      return;
    }
    stopped = true;

    try {
      const response = await fetch(`${url}/api/shutdown`, { method: "POST" });
      if (!response.ok) {
        throw new Error(`Shutdown failed with HTTP ${response.status}.`);
      }
    } catch {
      await killDaemon(metadata.pid);
      return;
    }

    await waitForDaemonStopped(courseDir, metadata.pid);
  };

  const cleanup = async (): Promise<void> => {
    await stop();
    await rm(coursesDir, { force: true, recursive: true });
  };

  return {
    runtime: runtime.name,
    coursesDir,
    courseName,
    courseDir,
    env,
    logPath,
    url,
    pid: metadata.pid,
    runCli: (args, extraEnv = {}) =>
      runRuntimeCli(runtime, args, { ...env, ...extraEnv }),
    stop,
    cleanup,
  };
};

export const readTurnFile = async (path: string): Promise<TurnFile> =>
  JSON.parse(await Bun.file(path).text()) as TurnFile;

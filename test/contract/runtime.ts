import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readDaemonMetadata } from "../../src/daemon";
import {
  killDaemon,
  type ProcessResult,
  runProcess,
  sleep,
  streamText,
  waitForDaemonStopped,
} from "../helpers/daemon";

export type ContractRuntimeName = "source" | "sidecar";

type ContractRuntime = Readonly<{
  name: ContractRuntimeName;
  command: readonly string[];
  missing?: string;
}>;

type ContractEnvContext = Readonly<{
  dataDir: string;
  courseName: string;
  logPath: string;
}>;

type ContractExtraEnv =
  | Record<string, string>
  | ((context: ContractEnvContext) => Record<string, string>);

export type StartedContractDaemon = Readonly<{
  runtime: ContractRuntimeName;
  dataDir: string;
  courseName: string;
  env: Record<string, string>;
  logPath: string;
  url: string;
  token: string;
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
  extraEnv?: ContractExtraEnv;
  useHarnessOverride?: boolean;
}>;

const repoRoot = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const cliPath = join(repoRoot, "src", "cli", "index.ts");
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

  if (raw === "source" || raw === "sidecar") {
    return raw;
  }

  throw new Error(
    `Unknown OVERLEARN_CONTRACT_RUNTIME: ${raw}. Expected source or sidecar.`,
  );
};

export const resolveContractRuntime = (): ContractRuntime => {
  const name = requestedRuntimeName();

  if (name === "source") {
    return {
      name,
      command: [process.execPath, cliPath],
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
  extra: Record<string, string>,
  useHarnessOverride: boolean,
): Record<string, string> => {
  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }

  env["OVERLEARN_DATA_DIR"] = context.dataDir;
  if (useHarnessOverride) {
    env["OVERLEARN_HARNESS_CMD"] = JSON.stringify([
      process.execPath,
      fixturePath,
      scenario,
    ]);
  }
  env["OVERLEARN_DISABLE_MANAGED_BRIDGES"] = "1";
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

const authHeaders = (token: string): Record<string, string> => ({
  authorization: `Bearer ${token}`,
});

const readStartedMetadata = async (
  env: Record<string, string>,
  child: ReturnType<typeof Bun.spawn>,
  runtimeName: ContractRuntimeName,
): Promise<NonNullable<Awaited<ReturnType<typeof readDaemonMetadata>>>> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const metadata = await readDaemonMetadata(env);
    if (metadata !== undefined) {
      const response = await fetch(`http://127.0.0.1:${metadata.port}/api/health`, {
        headers: authHeaders(metadata.token),
      }).catch(() => undefined);

      if (response?.ok === true) {
        return metadata;
      }
    }

    const exited = await Promise.race([
      child.exited.then((exitCode) => exitCode),
      sleep(25).then(() => undefined),
    ]);
    if (exited !== undefined) {
      const [stdout, stderr] = await Promise.all([
        streamText(child.stdout),
        streamText(child.stderr),
      ]);
      throw new Error(
        [
          `${runtimeName} daemon exited before writing healthy metadata with exit ${exited}.`,
          stderr.trim(),
          stdout.trim(),
        ]
          .filter((line) => line.length > 0)
          .join("\n"),
      );
    }
  }

  throw new Error("Daemon metadata was not written.");
};

export const startContractDaemon = async (
  runtime: ContractRuntime,
  options: StartContractOptions = {},
): Promise<StartedContractDaemon> => {
  if (runtime.missing !== undefined) {
    throw new Error(runtime.missing);
  }

  const scenario = options.scenario ?? "normal";
  const dataDir = await mkdtemp(join(tmpdir(), "overlearn-contract-store-"));
  const courseName = `contract-${runtime.name}-${scenario}-${Date.now()}`;
  const logPath = join(dataDir, "fake-acp.jsonl");
  const context = { dataDir, courseName, logPath };
  const extra =
    typeof options.extraEnv === "function"
      ? options.extraEnv(context)
      : (options.extraEnv ?? {});
  const env = contractEnv(
    context,
    scenario,
    extra,
    options.useHarnessOverride !== false,
  );

  const child = Bun.spawn([...runtime.command, "daemon"], {
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const metadata = await readStartedMetadata(env, child, runtime.name);
  const url = `http://localhost:${metadata.port}`;
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
      const response = await fetch(`${url}/api/shutdown`, {
        method: "POST",
        headers: authHeaders(metadata.token),
      });
      if (!response.ok) {
        throw new Error(`Shutdown failed with HTTP ${response.status}.`);
      }
    } catch {
      await killDaemon(metadata.pid);
      return;
    }

    await waitForDaemonStopped(dataDir, metadata.pid);
  };

  const cleanup = async (): Promise<void> => {
    await stop();
    await rm(dataDir, { force: true, recursive: true });
  };

  return {
    runtime: runtime.name,
    dataDir,
    courseName,
    env,
    logPath,
    url,
    token: metadata.token,
    pid: metadata.pid,
    runCli: (args, extraEnv = {}) =>
      runRuntimeCli(runtime, args, { ...env, ...extraEnv }),
    stop,
    cleanup,
  };
};

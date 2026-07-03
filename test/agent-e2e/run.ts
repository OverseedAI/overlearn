#!/usr/bin/env bun

import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type ProcessResult = Readonly<{
  exitCode: number;
  stdout: string;
  stderr: string;
}>;

type DaemonMetadata = Readonly<{
  pid: number;
  port: number;
}>;

type LiveDaemon = Readonly<{
  courseDir: string;
  url: string;
  metadata: DaemonMetadata;
  health: Readonly<{
    waitPending: boolean;
  }>;
}>;

const MODEL = "claude-haiku-4-5-20251001";
const SESSION_TIMEOUT_MS = 10 * 60 * 1_000;
const POLL_MS = 500;

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const pluginDir = join(repoRoot, "plugin");
const learnBinary = join(repoRoot, "dist", "learn");

const sleep = async (milliseconds: number): Promise<void> => {
  await new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
};

const withTimeout = async <T>(
  promise: Promise<T>,
  milliseconds: number,
  label: string,
): Promise<T> => {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(
      () => reject(new Error(`${label} timed out after ${milliseconds}ms`)),
      milliseconds,
    );
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
};

const streamText = async (
  stream: ReadableStream<Uint8Array> | null,
): Promise<string> => (stream === null ? "" : await new Response(stream).text());

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const fileExists = async (filePath: string): Promise<boolean> => {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
};

const readJsonFile = async (filePath: string): Promise<unknown> =>
  JSON.parse(await readFile(filePath, "utf8")) as unknown;

const parseDaemonMetadata = (value: unknown): DaemonMetadata | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  const pid = value["pid"];
  const port = value["port"];

  if (
    typeof pid !== "number" ||
    !Number.isInteger(pid) ||
    typeof port !== "number" ||
    !Number.isInteger(port)
  ) {
    return undefined;
  }

  return { pid, port };
};

const isPidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const killDaemon = async (pid: number): Promise<void> => {
  if (!isPidAlive(pid)) {
    return;
  }

  process.kill(pid, "SIGTERM");

  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!isPidAlive(pid)) {
      return;
    }

    await sleep(25);
  }

  process.kill(pid, "SIGKILL");
};

const fetchWithTimeout = async (
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
};

const readLiveDaemon = async (
  courseDir: string,
): Promise<LiveDaemon | undefined> => {
  const daemonPath = join(courseDir, ".overlearn", "daemon.json");
  if (!(await fileExists(daemonPath))) {
    return undefined;
  }

  const metadata = parseDaemonMetadata(await readJsonFile(daemonPath));
  if (metadata === undefined || !isPidAlive(metadata.pid)) {
    return undefined;
  }

  const url = `http://127.0.0.1:${metadata.port}`;

  try {
    const response = await fetchWithTimeout(
      `${url}/api/health`,
      { method: "GET" },
      1_000,
    );
    if (!response.ok) {
      return undefined;
    }

    const health = (await response.json()) as unknown;
    if (!isRecord(health) || health["coursePath"] !== courseDir) {
      return undefined;
    }

    return {
      courseDir,
      url,
      metadata,
      health: {
        waitPending: health["waitPending"] === true,
      },
    };
  } catch {
    return undefined;
  }
};

const findLiveDaemon = async (
  coursesDir: string,
): Promise<LiveDaemon | undefined> => {
  const entries = await readdir(coursesDir).catch(() => []);

  for (const entry of entries) {
    const daemon = await readLiveDaemon(join(coursesDir, entry));
    if (daemon !== undefined) {
      return daemon;
    }
  }

  return undefined;
};

const submitLearnerMessage = async (
  daemon: LiveDaemon,
  text: string,
): Promise<void> => {
  const response = await fetchWithTimeout(
    `${daemon.url}/api/submit`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    },
    5_000,
  );

  if (!response.ok) {
    throw new Error(`Learner submit failed with HTTP ${response.status}`);
  }
};

const simulateLearner = async (
  coursesDir: string,
  replies: readonly string[],
  claudeDone: () => boolean,
): Promise<void> => {
  let sent = 0;

  while (sent < replies.length) {
    if (claudeDone()) {
      throw new Error(
        `Claude exited after ${sent} simulated learner replies; expected ${replies.length}.`,
      );
    }

    const daemon = await findLiveDaemon(coursesDir);
    if (daemon?.health.waitPending === true) {
      const reply = replies[sent];
      if (reply === undefined) {
        throw new Error("Missing scripted learner reply.");
      }

      console.log(`[learner] reply ${sent + 1}/${replies.length}`);
      await submitLearnerMessage(daemon, reply);
      sent += 1;
      await sleep(1_000);
      continue;
    }

    await sleep(POLL_MS);
  }
};

const collectProcess = async (
  process: Bun.Subprocess<"ignore", "pipe", "pipe">,
  exitPromise: Promise<number>,
): Promise<ProcessResult> => {
  const [exitCode, stdout, stderr] = await Promise.all([
    exitPromise,
    streamText(process.stdout),
    streamText(process.stderr),
  ]);

  return { exitCode, stdout, stderr };
};

const createEnv = (
  coursesDir: string,
  binDir: string,
  homeDir: string,
): Record<string, string> => {
  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }

  env["HOME"] = homeDir;
  env["OVERLEARN_BIN"] = learnBinary;
  env["OVERLEARN_COURSES_DIR"] = coursesDir;
  env["OVERLEARN_NO_BROWSER"] = "1";
  env["NO_COLOR"] = "1";
  env["PATH"] = `${binDir}:${env["PATH"] ?? ""}`;
  delete env["FORCE_COLOR"];

  return env;
};

const spawnClaude = (
  args: readonly string[],
  env: Record<string, string>,
  cwd: string,
): Bun.Subprocess<"ignore", "pipe", "pipe"> =>
  Bun.spawn(["claude", ...args], {
    cwd,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

const assertDeterministicChecks = async (
  courseDir: string,
  daemon: LiveDaemon,
): Promise<void> => {
  const turnsDir = join(courseDir, ".overlearn", "turns");
  const lessonsDir = join(courseDir, "lessons");
  const turnFiles = (await readdir(turnsDir)).filter((file) =>
    /^turn-\d+\.json$/.test(file),
  );
  const lessonFiles = (await readdir(lessonsDir)).filter((file) =>
    file.endsWith(".md"),
  );
  const transcript = await readFile(join(courseDir, "transcript.jsonl"), "utf8");
  const transcriptLines = transcript
    .trim()
    .split("\n")
    .filter((line) => line.length > 0);
  const transcriptEntries = transcriptLines.map((line) =>
    JSON.parse(line) as unknown,
  );

  if (turnFiles.length < 2) {
    throw new Error(`Expected at least 2 turn files, found ${turnFiles.length}.`);
  }

  if (lessonFiles.length < 1) {
    throw new Error("Expected at least 1 lesson file.");
  }

  if (
    !transcriptEntries.some(
      (entry) => isRecord(entry) && entry["role"] === "agent",
    ) ||
    !transcriptEntries.some(
      (entry) => isRecord(entry) && entry["role"] === "learner",
    )
  ) {
    throw new Error("Expected transcript entries from both agent and learner.");
  }

  if (!isPidAlive(daemon.metadata.pid)) {
    throw new Error("Expected daemon to survive the agent session.");
  }
};

const readNamedFiles = async (
  root: string,
  relativeDir: string,
): Promise<string> => {
  const directory = join(root, relativeDir);
  const entries = await readdir(directory).catch(() => []);
  const markdown = await Promise.all(
    entries.sort().map(async (entry) => {
      const relativePath = join(relativeDir, entry);
      const content = await readFile(join(root, relativePath), "utf8");
      return `### ${relativePath}\n\n${content.trim()}`;
    }),
  );

  return markdown.join("\n\n");
};

const readCourseSnapshot = async (courseDir: string): Promise<string> => {
  const courseJson = await readFile(join(courseDir, "course.json"), "utf8");
  const transcript = await readFile(join(courseDir, "transcript.jsonl"), "utf8");
  const lessons = await readNamedFiles(courseDir, "lessons");
  const turns = await readNamedFiles(courseDir, join(".overlearn", "turns"));

  return [
    "## course.json",
    courseJson.trim(),
    "## transcript.jsonl",
    transcript.trim(),
    "## lessons",
    lessons,
    "## turns",
    turns,
  ].join("\n\n");
};

const extractJsonObject = (text: string): unknown => {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");

  if (start === -1 || end === -1 || end < start) {
    throw new Error(`Grader did not return JSON: ${text}`);
  }

  return JSON.parse(text.slice(start, end + 1)) as unknown;
};

const runGrader = async (
  courseDir: string,
  env: Record<string, string>,
  cwd: string,
): Promise<void> => {
  const snapshot = await readCourseSnapshot(courseDir);
  const prompt = [
    "Grade this Overlearn teaching session.",
    "",
    "Return only JSON with this shape:",
    "{\"result\":\"PASS\"|\"FAIL\",\"reasons\":[\"...\"]}",
    "",
    "Rubric:",
    "- PASS only if the agent re-entered wait after each active teaching turn and did not dead-end the learner.",
    "- PASS only if lesson files were the primary durable teaching artifact.",
    "- PASS only if learner events were emitted into turn files and addressed.",
    "- PASS only if the teaching style used guided discovery: short turns, questions, and checks rather than lecture dumps.",
    "",
    "Course contents:",
    snapshot,
  ].join("\n");

  const grader = spawnClaude(
    [
      "-p",
      "--dangerously-skip-permissions",
      "--no-session-persistence",
      "--model",
      MODEL,
      "--max-budget-usd",
      "1.00",
      prompt,
    ],
    env,
    cwd,
  );
  const result = await collectProcess(grader, grader.exited);

  if (result.exitCode !== 0) {
    throw new Error(
      `Grader Claude run failed with ${result.exitCode}:\n${result.stderr}\n${result.stdout}`,
    );
  }

  const grade = extractJsonObject(result.stdout);
  if (
    !isRecord(grade) ||
    grade["result"] !== "PASS" ||
    !Array.isArray(grade["reasons"])
  ) {
    throw new Error(`Grader failed rubric:\n${result.stdout}`);
  }

  console.log(`[grader] PASS: ${grade["reasons"].join("; ")}`);
};

const ensureBuiltBinary = async (): Promise<void> => {
  if (!(await fileExists(learnBinary))) {
    throw new Error("Missing dist/learn. Run `bun run build` before agent E2E.");
  }
};

const main = async (): Promise<void> => {
  if ((process.env["ANTHROPIC_API_KEY"] ?? "").trim().length === 0) {
    console.log("Skipping agent E2E: ANTHROPIC_API_KEY is not set.");
    return;
  }

  await ensureBuiltBinary();

  const tempRoot = await mkdtemp(join(tmpdir(), "overlearn-agent-e2e-"));
  const coursesDir = join(tempRoot, "courses");
  const workspaceDir = join(tempRoot, "workspace");
  const binDir = join(tempRoot, "bin");
  const homeDir = join(tempRoot, "home");
  let daemonToKill: number | undefined;

  try {
    await mkdir(coursesDir, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(binDir, { recursive: true });
    await mkdir(homeDir, { recursive: true });
    await symlink(learnBinary, join(binDir, "learn"));

    const env = createEnv(coursesDir, binDir, homeDir);
    const prompt = [
      "/learn teach me the rule of 72.",
      "Use course name rule-of-72-e2e.",
      "Keep it to 3 short learner turns.",
      "When I say to end the session, close the loop and stop.",
    ].join(" ");

    const claude = spawnClaude(
      [
        "-p",
        "--dangerously-skip-permissions",
        "--no-session-persistence",
        "--plugin-dir",
        pluginDir,
        "--model",
        MODEL,
        "--max-budget-usd",
        "2.00",
        prompt,
      ],
      env,
      workspaceDir,
    );

    let claudeDone = false;
    const claudeExit = claude.exited.then((code) => {
      claudeDone = true;
      return code;
    });

    const learner = simulateLearner(
      coursesDir,
      [
        "If the rate is 6%, I think doubling takes about 12 years.",
        "Why does the shortcut use 72 instead of 70?",
        "Got it, thanks -- end the session.",
      ],
      () => claudeDone,
    );

    await withTimeout(
      Promise.all([claudeExit, learner]),
      SESSION_TIMEOUT_MS,
      "Claude simulated learner session",
    ).catch((error: unknown) => {
      claude.kill();
      throw error;
    });

    const sessionResult = await collectProcess(claude, claudeExit);
    if (sessionResult.exitCode !== 0) {
      throw new Error(
        `Claude session failed with ${sessionResult.exitCode}:\n${sessionResult.stderr}\n${sessionResult.stdout}`,
      );
    }

    const daemon = await findLiveDaemon(coursesDir);
    if (daemon === undefined) {
      throw new Error("No live daemon found after Claude session.");
    }
    daemonToKill = daemon.metadata.pid;

    await assertDeterministicChecks(daemon.courseDir, daemon);
    await runGrader(daemon.courseDir, env, workspaceDir);

    console.log(`[agent-e2e] PASS ${daemon.courseDir}`);
  } finally {
    if (daemonToKill !== undefined) {
      await killDaemon(daemonToKill);
    }

    if (process.env["KEEP_OVERLEARN_E2E"] !== "1") {
      await rm(tempRoot, { force: true, recursive: true });
    } else {
      console.log(`[agent-e2e] kept temp root ${tempRoot}`);
    }
  }
};

await main();

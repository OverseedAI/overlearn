#!/usr/bin/env bun

import {
  cp,
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

type TranscriptEntry = Readonly<{
  role: "learner" | "agent";
  text: string;
  at: string;
}>;

const MODEL = "claude-sonnet-5";
const SESSION_TIMEOUT_MS = 8 * 60 * 1_000;
const POLL_MS = 500;
const COURSE_NAME = "rule-of-72-partial";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const pluginDir = join(repoRoot, "plugin");
const learnBinary = join(repoRoot, "dist", "learn");
const fixtureDir = join(repoRoot, "test", "agent-e2e", "fixtures", COURSE_NAME);

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

const parseTranscriptEntry = (
  value: unknown,
  lineNumber: number,
): TranscriptEntry => {
  if (!isRecord(value)) {
    throw new Error(`Invalid transcript entry at line ${lineNumber}.`);
  }

  const role = value["role"];
  const text = value["text"];
  const at = value["at"];

  if (
    (role !== "learner" && role !== "agent") ||
    typeof text !== "string" ||
    typeof at !== "string"
  ) {
    throw new Error(`Invalid transcript entry at line ${lineNumber}.`);
  }

  return { role, text, at };
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

const readTranscriptEntries = async (
  courseDir: string,
): Promise<readonly TranscriptEntry[]> => {
  const transcript = await readFile(join(courseDir, "transcript.jsonl"), "utf8");

  return transcript
    .split("\n")
    .flatMap((line, index) =>
      line.trim().length === 0
        ? []
        : [parseTranscriptEntry(JSON.parse(line) as unknown, index + 1)],
    );
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

const readFixtureState = async (courseDir: string): Promise<string> => {
  const courseJson = await readFile(join(courseDir, "course.json"), "utf8");
  const transcript = await readFile(join(courseDir, "transcript.jsonl"), "utf8");
  const glossary = await readFile(join(courseDir, "glossary.json"), "utf8");
  const mastery = await readFile(join(courseDir, "mastery.json"), "utf8");
  const lessons = await readNamedFiles(courseDir, "lessons");

  return [
    "## course.json",
    courseJson.trim(),
    "## lessons",
    lessons,
    "## glossary.json",
    glossary.trim(),
    "## mastery.json",
    mastery.trim(),
    "## transcript.jsonl before resume",
    transcript.trim(),
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

const assertResumeTranscript = (
  newEntries: readonly TranscriptEntry[],
): void => {
  if (newEntries.length < 2) {
    throw new Error(
      `Expected at least 2 new transcript entries after resume, found ${newEntries.length}.`,
    );
  }

  const [firstNewEntry] = newEntries;
  if (firstNewEntry?.role !== "agent") {
    throw new Error("Expected the first new transcript entry to be the resume greeting.");
  }

  const firstLearnerIndex = newEntries.findIndex(
    (entry) => entry.role === "learner",
  );
  if (firstLearnerIndex <= 0) {
    throw new Error("Expected the resume greeting before the learner reply.");
  }
};

const runGrader = async (
  fixtureState: string,
  newEntries: readonly TranscriptEntry[],
  env: Record<string, string>,
  cwd: string,
): Promise<void> => {
  const prompt = [
    "Grade this Overlearn resume session.",
    "",
    "Return only JSON with this shape:",
    "{\"result\":\"PASS\"|\"FAIL\",\"reasons\":[\"...\"]}",
    "",
    "Rubric:",
    "- PASS only if the first new agent message is a resume greeting based on the fixture state, not generic course-start text.",
    "- PASS only if the greeting accurately says the learner already covered what the Rule of 72 estimates and how to use 72 divided by the rate.",
    "- PASS only if the greeting says the course left off before the topic of why 72 is used instead of a rounder number like 70.",
    "- PASS only if the greeting offers the next step as the topic 'Why 72 is a useful numerator' or an equivalent explanation of why 72 is used.",
    "- FAIL if the greeting claims the learner already completed the why-72 topic or the limits/sanity-check topic.",
    "",
    "Fixture state before the fresh resume session:",
    fixtureState,
    "",
    "New transcript entries appended by the fresh session:",
    JSON.stringify(newEntries, null, 2),
  ].join("\n");

  const grader = spawnClaude(
    [
      "-p",
      "--dangerously-skip-permissions",
      "--no-session-persistence",
      "--model",
      MODEL,
      "--max-budget-usd",
      "0.75",
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
  const reasons =
    isRecord(grade) && Array.isArray(grade["reasons"])
      ? grade["reasons"].filter((reason): reason is string => typeof reason === "string")
      : [];

  if (!isRecord(grade) || grade["result"] !== "PASS" || reasons.length === 0) {
    throw new Error(`Grader failed rubric:\n${result.stdout}`);
  }

  console.log(`[grader] PASS: ${reasons.join("; ")}`);
};

const ensureBuiltBinary = async (): Promise<void> => {
  if (!(await fileExists(learnBinary))) {
    throw new Error("Missing dist/learn. Run `bun run build` before agent E2E.");
  }
};

const main = async (): Promise<void> => {
  if ((process.env["ANTHROPIC_API_KEY"] ?? "").trim().length === 0) {
    console.log("Skipping resume agent E2E: ANTHROPIC_API_KEY is not set.");
    return;
  }

  await ensureBuiltBinary();

  const tempRoot = await mkdtemp(join(tmpdir(), "overlearn-resume-e2e-"));
  const coursesDir = join(tempRoot, "courses");
  const workspaceDir = join(tempRoot, "workspace");
  const binDir = join(tempRoot, "bin");
  const homeDir = join(tempRoot, "home");
  const courseDir = join(coursesDir, COURSE_NAME);
  let daemonToKill: number | undefined;

  try {
    await mkdir(coursesDir, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(binDir, { recursive: true });
    await mkdir(homeDir, { recursive: true });
    await symlink(learnBinary, join(binDir, "learn"));
    await cp(fixtureDir, courseDir, { recursive: true });

    const fixtureState = await readFixtureState(courseDir);
    const initialEntries = await readTranscriptEntries(courseDir);
    const env = createEnv(coursesDir, binDir, homeDir);
    const prompt = [
      `/learn --resume ${COURSE_NAME}`,
      "This is a fresh headless session. Rebuild course context only from disk.",
      "After your resume greeting, wait for me.",
      "When I reply exactly 'yes, continue', teach one tiny next step and then end the session without waiting again.",
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
        "1.50",
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

    const learner = simulateLearner(coursesDir, ["yes, continue"], () => claudeDone);

    await withTimeout(
      Promise.all([claudeExit, learner]),
      SESSION_TIMEOUT_MS,
      "Claude resume simulated learner session",
    ).catch((error: unknown) => {
      claude.kill();
      throw error;
    });

    const sessionResult = await collectProcess(claude, claudeExit);
    if (sessionResult.exitCode !== 0) {
      throw new Error(
        `Claude resume session failed with ${sessionResult.exitCode}:\n${sessionResult.stderr}\n${sessionResult.stdout}`,
      );
    }

    const daemon = await findLiveDaemon(coursesDir);
    if (daemon === undefined) {
      throw new Error("No live daemon found after Claude resume session.");
    }
    daemonToKill = daemon.metadata.pid;

    const finalEntries = await readTranscriptEntries(courseDir);
    const newEntries = finalEntries.slice(initialEntries.length);

    assertResumeTranscript(newEntries);
    await runGrader(fixtureState, newEntries, env, workspaceDir);

    console.log(`[agent-e2e:resume] PASS ${courseDir}`);
  } finally {
    if (daemonToKill !== undefined) {
      await killDaemon(daemonToKill);
    }

    if (process.env["KEEP_OVERLEARN_E2E"] !== "1") {
      await rm(tempRoot, { force: true, recursive: true });
    } else {
      console.log(`[agent-e2e:resume] kept temp root ${tempRoot}`);
    }
  }
};

await main();

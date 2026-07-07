import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  canBindLocalhost,
  createFakeHarnessPath,
  createSseClient,
  daemonAuthHeaders,
  harnessById,
  harnessPayloadHasSelected,
  isRecord,
  promptText,
  submitCourseDone,
  submitCourseMessage,
  waitForDaemonStopped,
  waitForLogEntries,
  waitForPidStopped,
} from "../helpers/daemon";
import {
  checkContractRuntime,
  resolveContractRuntime,
  startContractDaemon,
  type StartedContractDaemon,
} from "./runtime";

const runtime = resolveContractRuntime();
const runtimeIssue = checkContractRuntime(runtime);
const contractTest = runtimeIssue === undefined ? test : test.skip;
const activeDaemons = new Set<StartedContractDaemon>();

type CourseResource = Readonly<{
  id: number;
  title: string;
  status: string;
  description?: string | null;
  harnessId?: string | null;
  sourceName?: string | null;
}>;

const ensureLocalhost = async (): Promise<boolean> => {
  if (await canBindLocalhost()) {
    return true;
  }

  if (process.env["CI"] === "true") {
    throw new Error("Localhost binding is unavailable; contract tests cannot run.");
  }

  return false;
};

const withFakeHarnessPath = async (): Promise<
  Readonly<{ binDir: string; path: string }>
> => {
  const binDir = await createFakeHarnessPath();
  const existingPath = process.env["PATH"];
  const path =
    existingPath === undefined || existingPath.length === 0
      ? binDir
      : `${binDir}:${existingPath}`;

  return { binDir, path };
};

const start = async (
  options: Parameters<typeof startContractDaemon>[1] = {},
): Promise<StartedContractDaemon> => {
  const daemon = await startContractDaemon(runtime, options);
  activeDaemons.add(daemon);

  return daemon;
};

const authFetch = (
  daemon: StartedContractDaemon,
  path: string,
  init: RequestInit = {},
): Promise<Response> =>
  fetch(`${daemon.url}${path}`, {
    ...init,
    headers: daemonAuthHeaders(
      daemon.token,
      Object.fromEntries(new Headers(init.headers).entries()),
    ),
  });

const createCourse = async (
  daemon: StartedContractDaemon,
  input: Record<string, unknown>,
): Promise<CourseResource> => {
  const response = await authFetch(daemon, "/api/courses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });

  expect(response.status).toBe(201);
  return (await response.json()) as CourseResource;
};

const createIdeationCourse = async (
  daemon: StartedContractDaemon,
  seed: string,
): Promise<CourseResource> => {
  const response = await authFetch(daemon, "/api/courses/ideate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ seed }),
  });

  expect(response.status).toBe(201);
  const payload = (await response.json()) as Record<string, unknown>;
  expect(payload).toMatchObject({ ok: true });
  expect(payload["course"]).toMatchObject({ status: "draft" });

  return payload["course"] as CourseResource;
};

const createFakeLoginCommand = async (binDir: string): Promise<string> => {
  const path = join(binDir, "fake-login");
  await writeFile(
    path,
    [
      "#!/bin/sh",
      "printf '{\"event\":\"login-spawn\",\"harness\":\"%s\",\"command\":\"%s\",\"argv\":\"%s\"}\\n' \"$OVERLEARN_LOGIN_HARNESS_ID\" \"$OVERLEARN_LOGIN_COMMAND\" \"$*\" >> \"$OVERLEARN_LOGIN_SPAWN_LOG\"",
      "",
    ].join("\n"),
    "utf8",
  );
  await chmod(path, 0o755);

  return path;
};

const writeJson = async (path: string, value: unknown): Promise<void> => {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
};

const courseState = async (
  daemon: StartedContractDaemon,
  courseId: number,
): Promise<Record<string, unknown>> => {
  const response = await authFetch(daemon, `/api/courses/${courseId}`);

  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, unknown>;
};

const mcpUrlFromLogs = (
  logs: readonly Record<string, unknown>[],
): string => {
  const sessionNew = logs.find((entry) => entry["event"] === "session/new");
  const mcpServers = isRecord(sessionNew) ? sessionNew["parsedMcpServers"] : undefined;

  if (!Array.isArray(mcpServers)) {
    throw new Error("Missing parsed MCP servers in fake ACP log.");
  }

  const server = mcpServers.find(
    (candidate) =>
      isRecord(candidate) && candidate["name"] === "overlearn-teaching",
  );

  if (!isRecord(server) || typeof server["url"] !== "string") {
    throw new Error("Missing overlearn-teaching MCP URL.");
  }

  return server["url"];
};

afterEach(async () => {
  await Promise.all([...activeDaemons].map((daemon) => daemon.cleanup()));
  activeDaemons.clear();
});

describe(`daemon contract (${runtime.name})`, () => {
  contractTest(
    "enforces onboarding transitions and patches settings profile fields",
    async () => {
      if (!(await ensureLocalhost())) {
        return;
      }

      const daemon = await start();

      const unauthenticated = await fetch(`${daemon.url}/api/onboarding`);
      expect(unauthenticated.status).toBe(401);

      const initial = (await (
        await authFetch(daemon, "/api/onboarding")
      ).json()) as Record<string, unknown>;
      expect(initial).toMatchObject({ state: "welcome" });

      const illegal = await authFetch(daemon, "/api/onboarding", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ state: "done" }),
      });
      expect(illegal.status).toBe(409);
      await expect(illegal.text()).resolves.toContain(
        "Illegal onboarding transition",
      );

      const connect = await authFetch(daemon, "/api/onboarding", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ state: "connect-agent" }),
      });
      expect(connect.status).toBe(200);
      await expect(connect.json()).resolves.toMatchObject({
        state: "connect-agent",
      });

      const profilePatch = await authFetch(daemon, "/api/profile", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Hal",
          preferredHarness: "codex",
          settings: { tutorialChoice: "later" },
        }),
      });
      expect(profilePatch.status).toBe(200);
      await expect(profilePatch.json()).resolves.toMatchObject({
        name: "Hal",
        preferredHarness: "codex",
        settings: { tutorialChoice: "later" },
        dataDir: daemon.dataDir,
      });

      const tutorialOffer = await authFetch(daemon, "/api/onboarding", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ state: "tutorial-offer" }),
      });
      expect(tutorialOffer.status).toBe(200);

      const done = await authFetch(daemon, "/api/onboarding", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ state: "done" }),
      });
      expect(done.status).toBe(200);
      await expect(done.json()).resolves.toMatchObject({ state: "done" });

      const rerun = await authFetch(daemon, "/api/onboarding", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ state: "welcome" }),
      });
      expect(rerun.status).toBe(200);
      await expect(rerun.json()).resolves.toMatchObject({ state: "welcome" });
    },
    15_000,
  );

  contractTest(
    "starts the authored tutorial course from onboarding and runs a teaching turn",
    async () => {
      if (!(await ensureLocalhost())) {
        return;
      }

      const fakeHarness = await withFakeHarnessPath();
      const daemon = await start({
        scenario: "normal",
        extraEnv: {
          PATH: fakeHarness.path,
          OVERLEARN_HARNESS: "codex",
          ANTHROPIC_API_KEY: "test-anthropic",
          OPENAI_API_KEY: "test-openai",
          GEMINI_API_KEY: "test-gemini",
        },
      });
      const sse = await createSseClient(daemon.url, daemon.token);

      try {
        const unauthenticated = await fetch(`${daemon.url}/api/tutorial`, {
          method: "POST",
        });
        expect(unauthenticated.status).toBe(401);

        const connect = await authFetch(daemon, "/api/onboarding", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ state: "connect-agent" }),
        });
        expect(connect.status).toBe(200);

        const offer = await authFetch(daemon, "/api/onboarding", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ state: "tutorial-offer" }),
        });
        expect(offer.status).toBe(200);

        const tutorial = await authFetch(daemon, "/api/tutorial", {
          method: "POST",
        });
        expect(tutorial.status).toBe(200);
        const payload = (await tutorial.json()) as Record<string, unknown>;
        expect(typeof payload["courseId"]).toBe("number");
        const courseId = payload["courseId"] as number;

        const repeated = await authFetch(daemon, "/api/tutorial", {
          method: "POST",
        });
        expect(repeated.status).toBe(200);
        await expect(repeated.json()).resolves.toMatchObject({ courseId });

        const state = await courseState(daemon, courseId);
        expect(state["course"]).toMatchObject({
          id: courseId,
          title: "Learning Overlearn",
          status: "active",
          sourceName: "tutorial",
        });
        expect(state["topics"]).toContainEqual(
          expect.objectContaining({
            path: "dialogue-loop",
            title: "Dialogue loop",
            current: true,
            body: expect.stringContaining("Your connected agent teaches"),
          }),
        );
        expect(state["topics"]).toContainEqual(
          expect.objectContaining({
            path: "next-course",
            title: "Creating your next course",
            body: expect.stringContaining("brainstorm wizard"),
          }),
        );

        // Mirror the UI's start-tutorial flow: onboarding completes before the
        // course page opens, otherwise the deep-link guard serves the shell.
        const advanced = await authFetch(daemon, "/api/onboarding", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ state: "done" }),
        });
        expect(advanced.status).toBe(200);

        // The page shell may be the SPA (title arrives via API) or the legacy
        // server-rendered page (title inline) — assert both layers directly.
        const opened = await authFetch(daemon, `/?course=${courseId}`);
        expect(opened.status).toBe(200);
        await expect(opened.text()).resolves.toContain("Overlearn");

        const openedState = await authFetch(daemon, `/api/courses/${courseId}`);
        expect(openedState.status).toBe(200);
        const openedStateBody = (await openedState.json()) as {
          course: { title: string };
        };
        expect(openedStateBody.course.title).toBe("Learning Overlearn");

        await submitCourseMessage(
          daemon.url,
          daemon.token,
          courseId,
          "Teach me how the Overlearn tutorial works.",
        );
        await sse.waitFor(
          "agent-stream",
          (data) =>
            isRecord(data) &&
            data["courseId"] === courseId &&
            data["turn"] === 1 &&
            isRecord(data["event"]) &&
            data["event"]["type"] === "done",
          "tutorial teaching turn done",
        );

        const logs = await waitForLogEntries(
          daemon.logPath,
          (entries) =>
            entries.some((entry) => entry["event"] === "session/prompt"),
          "tutorial prompt log",
        );
        const firstPrompt = promptText(
          logs.find((entry) => entry["event"] === "session/prompt") ?? {},
        );
        expect(firstPrompt).toContain("Learning Overlearn");
        expect(firstPrompt).toContain("Teach me how the Overlearn tutorial works.");
      } finally {
        sse.close();
        await rm(fakeHarness.binDir, { force: true, recursive: true });
      }
    },
    15_000,
  );

  contractTest(
    "returns manual login for interactive agents and spawns browser OAuth login through the seam",
    async () => {
      if (!(await ensureLocalhost())) {
        return;
      }

      const fakeHarness = await withFakeHarnessPath();
      const fakeLogin = await createFakeLoginCommand(fakeHarness.binDir);
      const loginLogPath = join(fakeHarness.binDir, "login.jsonl");
      const daemon = await start({
        extraEnv: {
          PATH: fakeHarness.path,
          OVERLEARN_HARNESS_LOGIN_CMD: JSON.stringify([fakeLogin, "--fake"]),
          OVERLEARN_LOGIN_SPAWN_LOG: loginLogPath,
        },
      });

      try {
        const unauthenticated = await fetch(
          `${daemon.url}/api/harnesses/codex/login`,
          { method: "POST" },
        );
        expect(unauthenticated.status).toBe(401);

        const manual = await authFetch(
          daemon,
          "/api/harnesses/claude-code/login",
          { method: "POST" },
        );
        expect(manual.status).toBe(200);
        await expect(manual.json()).resolves.toMatchObject({
          manual: true,
          spawned: false,
          command: "claude",
        });

        const spawned = await authFetch(daemon, "/api/harnesses/codex/login", {
          method: "POST",
        });
        expect(spawned.status).toBe(200);
        await expect(spawned.json()).resolves.toMatchObject({
          manual: false,
          spawned: true,
          command: "codex login",
        });

        const entries = await waitForLogEntries(
          loginLogPath,
          (logs) =>
            logs.some(
              (entry) =>
                entry["event"] === "login-spawn" &&
                entry["harness"] === "codex" &&
                entry["command"] === "codex login" &&
                entry["argv"] === "--fake",
            ),
          "login spawn log",
        );
        expect(entries).toContainEqual(
          expect.objectContaining({
            event: "login-spawn",
            harness: "codex",
            command: "codex login",
            argv: "--fake",
          }),
        );
      } finally {
        await rm(fakeHarness.binDir, { force: true, recursive: true });
      }
    },
    15_000,
  );

  contractTest(
    "starts app-level, creates/lists courses, streams an MCP-backed turn, and exposes store state",
    async () => {
      if (!(await ensureLocalhost())) {
        return;
      }

      const fakeHarness = await withFakeHarnessPath();
      const daemon = await start({
        scenario: "normal",
        extraEnv: {
          PATH: fakeHarness.path,
          OVERLEARN_HARNESS: "codex",
          ANTHROPIC_API_KEY: "test-anthropic",
          OPENAI_API_KEY: "test-openai",
          GEMINI_API_KEY: "test-gemini",
          FAKE_ACP_MCP_CALL: JSON.stringify({
            server: "overlearn-teaching",
            tool: "record_mastery",
            args: {
              concept: "compound-growth",
              score: 84,
              gaps: "none",
            },
          }),
        },
      });
      const sse = await createSseClient(daemon.url, daemon.token);

      try {
        const unauthenticated = await fetch(`${daemon.url}/api/health`);
        expect(unauthenticated.status).toBe(401);

        const bootstrap = await fetch(`${daemon.url}/?token=${daemon.token}`, {
          redirect: "manual",
        });
        expect(bootstrap.status).toBe(303);
        expect(bootstrap.headers.get("set-cookie")).toContain("HttpOnly");

        const health = (await (
          await authFetch(daemon, "/api/health")
        ).json()) as Record<string, unknown>;
        expect(health).toMatchObject({
          ok: true,
          orchestrated: true,
          version: expect.any(String),
          activeCourseId: null,
        });

        const created = await createCourse(daemon, {
          title: "Contract Course",
          description: "Store-backed contract course",
          harnessId: "codex",
        });
        expect(typeof created.id).toBe("number");
        const createdId = created.id;
        expect(created).toMatchObject({
          title: "Contract Course",
          status: "active",
        });

        const list = (await (
          await authFetch(daemon, "/api/courses?status=active")
        ).json()) as readonly CourseResource[];
        expect(list.map((course) => course.id)).toContain(createdId);

        const harnessResponse = await authFetch(
          daemon,
          `/api/harnesses?courseId=${createdId}`,
        );
        expect(harnessResponse.status).toBe(200);
        const harnesses = (await harnessResponse.json()) as unknown;
        expect(harnessById(harnesses, "codex")).toMatchObject({
          installed: true,
          authenticated: true,
          selected: true,
          version: "codex-acp 9.9.9",
        });

        await submitCourseMessage(
          daemon.url,
          daemon.token,
          createdId,
          "contract hello",
        );
        await sse.waitFor(
          "status",
          (data) =>
            isRecord(data) &&
            data["courseId"] === createdId &&
            data["status"] === "agent-working",
          "agent-working status",
        );
        await sse.waitFor(
          "agent-stream",
          (data) =>
            isRecord(data) &&
            data["courseId"] === createdId &&
            data["turn"] === 1 &&
            isRecord(data["event"]) &&
            data["event"]["type"] === "tool-call",
          "mcp tool-call stream",
        );
        await sse.waitFor(
          "tool-write",
          (data) =>
            isRecord(data) &&
            data["courseId"] === createdId &&
            data["tool"] === "record_mastery",
          "mcp write summary",
        );
        await sse.waitFor(
          "agent-stream",
          (data) =>
            isRecord(data) &&
            data["courseId"] === createdId &&
            data["turn"] === 1 &&
            isRecord(data["event"]) &&
            data["event"]["type"] === "done",
          "turn done stream",
        );

        const state = await courseState(daemon, createdId);
        expect(state["mastery"]).toContainEqual(
          expect.objectContaining({
            concept: "compound-growth",
            score: 84,
          }),
        );
        expect(state["transcript"]).toContainEqual(
          expect.objectContaining({
            role: "system",
            kind: "tool-call",
            text: "recorded mastery compound-growth=84",
          }),
        );

        const logs = await waitForLogEntries(
          daemon.logPath,
          (entries) =>
            entries.some((entry) => entry["event"] === "session/prompt"),
          "first prompt log",
        );
        const firstPrompt = promptText(
          logs.find((entry) => entry["event"] === "session/prompt") ?? {},
        );
        expect(firstPrompt).toContain("## Turn payload");
        expect(firstPrompt).toContain('"text": "contract hello"');
        expect(firstPrompt).toContain("## Resume context required");
        expect(firstPrompt).toContain("get_course_state");
        expect(firstPrompt).toContain("no sidecar callback commands are available");
      } finally {
        sse.close();
        await rm(fakeHarness.binDir, { force: true, recursive: true });
      }
    },
    15_000,
  );

  contractTest(
    "exports bundle directories and imports bundle or legacy course folders",
    async () => {
      if (!(await ensureLocalhost())) {
        return;
      }

      const daemon = await start();

      const course = await createCourse(daemon, {
        title: "Bundle Contract Course",
        description: "Exported through the app API.",
      });

      const unauthenticatedExport = await fetch(
        `${daemon.url}/api/courses/${course.id}/export`,
        { method: "POST" },
      );
      expect(unauthenticatedExport.status).toBe(401);

      const exported = await authFetch(daemon, `/api/courses/${course.id}/export`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ includeTranscript: true }),
      });
      expect(exported.status).toBe(200);
      const exportPayload = (await exported.json()) as Record<string, unknown>;
      expect(typeof exportPayload["path"]).toBe("string");
      const bundlePath = exportPayload["path"] as string;
      expect(bundlePath.startsWith(join(daemon.dataDir, "exports") + "/")).toBe(true);
      expect((await stat(bundlePath)).isDirectory()).toBe(true);
      expect(await readFile(join(bundlePath, "course.json"), "utf8")).toContain(
        '"format": "overlearn.course.bundle"',
      );

      const unauthenticatedImport = await fetch(`${daemon.url}/api/import`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: bundlePath }),
      });
      expect(unauthenticatedImport.status).toBe(401);

      const imported = await authFetch(daemon, "/api/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: bundlePath }),
      });
      expect(imported.status).toBe(200);
      const importPayload = (await imported.json()) as Record<string, unknown>;
      expect(importPayload["warnings"]).toEqual([]);
      expect(typeof importPayload["courseId"]).toBe("number");
      expect(importPayload["courseId"]).not.toBe(course.id);
      const importedState = await courseState(
        daemon,
        importPayload["courseId"] as number,
      );
      expect(importedState["course"]).toMatchObject({
        title: "Bundle Contract Course",
        description: "Exported through the app API.",
      });

      const legacyPath = join(daemon.dataDir, "legacy-course");
      await mkdir(legacyPath, { recursive: true });
      await writeJson(join(legacyPath, "course.json"), {
        title: "Legacy Contract Course",
        name: "legacy-contract",
        topics: [{ path: "intro", title: "Intro", current: false }],
      });

      const legacy = await authFetch(daemon, "/api/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: legacyPath }),
      });
      expect(legacy.status).toBe(200);
      await expect(legacy.json()).resolves.toMatchObject({
        courseId: expect.any(Number),
        warnings: ["Imported topic tree has no current topic."],
      });
    },
    15_000,
  );

  contractTest(
    "ideates a draft course, accepts an edited plan, and queues the teaching greeting",
    async () => {
      if (!(await ensureLocalhost())) {
        return;
      }

      const fakeHarness = await withFakeHarnessPath();
      const planTopics = [
        {
          path: "foundations",
          title: "Foundations",
          summary: "Core concepts and vocabulary.",
          children: [
            {
              path: "foundations/mental-models",
              title: "Mental models",
              summary: "How to reason about the topic.",
            },
          ],
        },
        {
          path: "practice",
          title: "Practice",
          summary: "Applied exercises.",
        },
      ];
      const daemon = await start({
        scenario: "normal",
        extraEnv: {
          PATH: fakeHarness.path,
          ANTHROPIC_API_KEY: "test-anthropic",
          OPENAI_API_KEY: "test-openai",
          GEMINI_API_KEY: "test-gemini",
          FAKE_ACP_MCP_CALL: JSON.stringify({
            server: "overlearn-teaching",
            tool: "propose_course_plan",
            args: {
              title: "Database Foundations",
              description: "Learn how databases work from first principles.",
              topics: planTopics,
            },
          }),
        },
      });
      const sse = await createSseClient(daemon.url, daemon.token);

      try {
        const draft = await createIdeationCourse(
          daemon,
          "Teach me databases from first principles.",
        );
        expect(draft.status).toBe("draft");

        const activeBefore = (await (
          await authFetch(daemon, "/api/courses?status=active")
        ).json()) as readonly CourseResource[];
        expect(activeBefore.map((course) => course.id)).not.toContain(draft.id);

        await sse.waitFor(
          "tool-write",
          (data) =>
            isRecord(data) &&
            data["courseId"] === draft.id &&
            data["tool"] === "propose_course_plan",
          "course plan write",
        );
        await sse.waitFor(
          "agent-stream",
          (data) =>
            isRecord(data) &&
            data["courseId"] === draft.id &&
            data["turn"] === 1 &&
            isRecord(data["event"]) &&
            data["event"]["type"] === "done",
          "ideation done stream",
        );

        const draftState = await courseState(daemon, draft.id);
        expect(draftState["course"]).toMatchObject({
          title: "Database Foundations",
          status: "draft",
        });
        expect(draftState["topics"]).toContainEqual(
          expect.objectContaining({
            path: "foundations",
            title: "Foundations",
            body: "Core concepts and vocabulary.",
          }),
        );

        const accept = await authFetch(
          daemon,
          `/api/courses/${draft.id}/accept-plan`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              title: "Database Systems",
              description: "Edited plan description.",
              topics: [
                {
                  path: "foundations",
                  title: "Renamed foundations",
                  body: "Keep only this edited topic.",
                },
              ],
            }),
          },
        );
        expect(accept.status).toBe(200);
        expect(await accept.json()).toMatchObject({
          ok: true,
          greetingQueued: true,
          course: {
            id: draft.id,
            status: "active",
            title: "Database Systems",
          },
        });

        await sse.waitFor(
          "agent-stream",
          (data) =>
            isRecord(data) &&
            data["courseId"] === draft.id &&
            data["turn"] === 2 &&
            isRecord(data["event"]) &&
            data["event"]["type"] === "done",
          "greeting done stream",
        );

        const logs = await waitForLogEntries(
          daemon.logPath,
          (entries) =>
            entries.filter((entry) => entry["event"] === "session/prompt")
              .length >= 2,
          "ideation and greeting prompts",
        );
        const prompts = logs.filter((entry) => entry["event"] === "session/prompt");
        expect(promptText(prompts[0] ?? {})).toContain("## Course ideation turn");
        expect(promptText(prompts[1] ?? {})).toContain(
          "The learner accepted the course plan.",
        );

        const activeState = await courseState(daemon, draft.id);
        expect(activeState["course"]).toMatchObject({
          status: "active",
          title: "Database Systems",
          description: "Edited plan description.",
        });
        expect(activeState["topics"]).toEqual([
          expect.objectContaining({
            path: "foundations",
            title: "Renamed foundations",
            body: "Keep only this edited topic.",
          }),
        ]);

        const draftList = (await (
          await authFetch(daemon, "/api/courses?status=draft")
        ).json()) as readonly CourseResource[];
        const activeList = (await (
          await authFetch(daemon, "/api/courses?status=active")
        ).json()) as readonly CourseResource[];
        expect(draftList.map((course) => course.id)).not.toContain(draft.id);
        expect(activeList.map((course) => course.id)).toContain(draft.id);
      } finally {
        sse.close();
        await rm(fakeHarness.binDir, { force: true, recursive: true });
      }
    },
    15_000,
  );

  contractTest(
    "discards draft ideation courses with hard delete and MCP token revocation",
    async () => {
      if (!(await ensureLocalhost())) {
        return;
      }

      const fakeHarness = await withFakeHarnessPath();
      const daemon = await start({
        scenario: "normal",
        extraEnv: {
          PATH: fakeHarness.path,
          ANTHROPIC_API_KEY: "test-anthropic",
          OPENAI_API_KEY: "test-openai",
          GEMINI_API_KEY: "test-gemini",
          FAKE_ACP_MCP_CALL: JSON.stringify({
            server: "overlearn-teaching",
            tool: "propose_course_plan",
            args: {
              title: "Discardable Plan",
              description: "Temporary draft.",
              topics: [
                {
                  path: "temporary",
                  title: "Temporary",
                  summary: "Throwaway topic.",
                },
              ],
            },
          }),
        },
      });
      const sse = await createSseClient(daemon.url, daemon.token);

      try {
        const draft = await createIdeationCourse(daemon, "Make a disposable plan.");
        await sse.waitFor(
          "tool-write",
          (data) =>
            isRecord(data) &&
            data["courseId"] === draft.id &&
            data["tool"] === "propose_course_plan",
          "discard plan write",
        );
        await sse.waitFor(
          "agent-stream",
          (data) =>
            isRecord(data) &&
            data["courseId"] === draft.id &&
            data["turn"] === 1 &&
            isRecord(data["event"]) &&
            data["event"]["type"] === "done",
          "discard ideation done stream",
        );

        const logs = await waitForLogEntries(
          daemon.logPath,
          (entries) => entries.some((entry) => entry["event"] === "session/new"),
          "draft session log",
        );
        const mcpUrl = mcpUrlFromLogs(logs);

        const discard = await authFetch(daemon, `/api/courses/${draft.id}`, {
          method: "DELETE",
        });
        expect(discard.status).toBe(200);
        expect(await discard.json()).toMatchObject({ ok: true, deleted: true });

        const missing = await authFetch(daemon, `/api/courses/${draft.id}`);
        expect(missing.status).toBe(404);
        const draftList = (await (
          await authFetch(daemon, "/api/courses?status=draft")
        ).json()) as readonly CourseResource[];
        expect(draftList.map((course) => course.id)).not.toContain(draft.id);

        const revoked = await fetch(mcpUrl);
        expect(revoked.status).toBe(404);
      } finally {
        sse.close();
        await rm(fakeHarness.binDir, { force: true, recursive: true });
      }
    },
    15_000,
  );

  contractTest(
    "lists unfinished draft ideation courses after daemon restart",
    async () => {
      if (!(await ensureLocalhost())) {
        return;
      }

      const fakeHarness = await withFakeHarnessPath();
      const first = await start({
        scenario: "normal",
        extraEnv: {
          PATH: fakeHarness.path,
          ANTHROPIC_API_KEY: "test-anthropic",
          OPENAI_API_KEY: "test-openai",
          GEMINI_API_KEY: "test-gemini",
        },
      });
      const sse = await createSseClient(first.url, first.token);

      try {
        const draft = await createIdeationCourse(
          first,
          "Keep this draft across daemon restarts.",
        );
        await sse.waitFor(
          "agent-stream",
          (data) =>
            isRecord(data) &&
            data["courseId"] === draft.id &&
            data["turn"] === 1 &&
            isRecord(data["event"]) &&
            data["event"]["type"] === "done",
          "restart ideation done stream",
        );
        sse.close();
        await first.stop();

        const second = await start({
          scenario: "normal",
          extraEnv: {
            PATH: fakeHarness.path,
            OVERLEARN_DATA_DIR: first.dataDir,
            ANTHROPIC_API_KEY: "test-anthropic",
            OPENAI_API_KEY: "test-openai",
            GEMINI_API_KEY: "test-gemini",
          },
        });

        const drafts = (await (
          await authFetch(second, "/api/courses?status=draft")
        ).json()) as readonly CourseResource[];
        const active = (await (
          await authFetch(second, "/api/courses?status=active")
        ).json()) as readonly CourseResource[];
        expect(drafts).toContainEqual(
          expect.objectContaining({
            id: draft.id,
            status: "draft",
            description: "Keep this draft across daemon restarts.",
          }),
        );
        expect(active.map((course) => course.id)).not.toContain(draft.id);
      } finally {
        sse.close();
        await rm(fakeHarness.binDir, { force: true, recursive: true });
      }
    },
    15_000,
  );

  contractTest(
    "swaps active harnesses and runs a continuity greeting turn",
    async () => {
      if (!(await ensureLocalhost())) {
        return;
      }

      const fakeHarness = await withFakeHarnessPath();
      const daemon = await start({
        scenario: "normal",
        extraEnv: {
          PATH: fakeHarness.path,
          ANTHROPIC_API_KEY: "test-anthropic",
          OPENAI_API_KEY: "test-openai",
          GEMINI_API_KEY: "test-gemini",
        },
      });
      const firstClient = await createSseClient(daemon.url, daemon.token);
      const secondClient = await createSseClient(daemon.url, daemon.token);

      try {
        const course = await createCourse(daemon, {
          title: "Swap Course",
          harnessId: "claude-code",
        });

        await submitCourseMessage(
          daemon.url,
          daemon.token,
          course.id,
          "start on adapter A",
        );
        await firstClient.waitFor(
          "agent-stream",
          (data) =>
            isRecord(data) &&
            data["courseId"] === course.id &&
            data["turn"] === 1 &&
            isRecord(data["event"]) &&
            data["event"]["type"] === "done",
          "first adapter turn done",
        );
        await firstClient.waitFor(
          "status",
          (data) =>
            isRecord(data) &&
            data["courseId"] === course.id &&
            data["status"] === "waiting-for-agent",
          "idle after first turn",
        );

        const response = await authFetch(daemon, `/api/courses/${course.id}/harness`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: "codex" }),
        });
        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toMatchObject({
          ok: true,
          harness: "codex",
          swapped: true,
        });

        const state = await courseState(daemon, course.id);
        expect(state["course"]).toMatchObject({ harnessId: "codex" });

        await firstClient.waitFor(
          "harnesses",
          (data) => harnessPayloadHasSelected(data, "codex", true),
          "first client selected codex",
        );
        await secondClient.waitFor(
          "harnesses",
          (data) => harnessPayloadHasSelected(data, "codex", true),
          "second client selected codex",
        );
        await firstClient.waitFor(
          "agent-stream",
          (data) =>
            isRecord(data) &&
            data["courseId"] === course.id &&
            data["turn"] === 2 &&
            isRecord(data["event"]) &&
            data["event"]["type"] === "thinking",
          "greeting turn started",
        );
        await firstClient.waitFor(
          "agent-stream",
          (data) =>
            isRecord(data) &&
            data["courseId"] === course.id &&
            data["turn"] === 2 &&
            isRecord(data["event"]) &&
            data["event"]["type"] === "done",
          "greeting turn done",
        );

        const logEntries = await waitForLogEntries(
          daemon.logPath,
          (entries) =>
            entries.filter((entry) => entry["event"] === "session/new").length >=
              2 &&
            entries.filter((entry) => entry["event"] === "session/prompt")
              .length >= 2,
          "swap sessions and prompts",
        );
        const sessionNews = logEntries.filter(
          (entry) => entry["event"] === "session/new",
        );
        expect(sessionNews).toHaveLength(2);
        const firstPid = sessionNews[0]?.["pid"];
        const secondPid = sessionNews[1]?.["pid"];
        if (typeof firstPid !== "number" || typeof secondPid !== "number") {
          throw new Error("Expected two fake adapter process ids.");
        }
        expect(secondPid).not.toBe(firstPid);
        await waitForPidStopped(firstPid);

        const prompts = logEntries.filter(
          (entry) => entry["event"] === "session/prompt",
        );
        const swapPrompt = promptText(prompts[1] ?? {});
        expect(swapPrompt).toContain("## Harness swap greeting turn");
        expect(swapPrompt).toContain("## Resume context required");
        expect(swapPrompt).toContain('"type": "harness-swapped"');
        expect(swapPrompt).toContain('"from": "claude-code"');
        expect(swapPrompt).toContain('"to": "codex"');
      } finally {
        firstClient.close();
        secondClient.close();
        await rm(fakeHarness.binDir, { force: true, recursive: true });
      }
    },
    15_000,
  );

  contractTest(
    "replays buffered agent-stream events to clients that connect mid-turn",
    async () => {
      if (!(await ensureLocalhost())) {
        return;
      }

      const daemon = await start({ scenario: "never" });
      const first = await createSseClient(daemon.url, daemon.token);
      let second: Awaited<ReturnType<typeof createSseClient>> | undefined;

      try {
        const course = await createCourse(daemon, {
          title: "Replay Course",
        });
        await submitCourseMessage(
          daemon.url,
          daemon.token,
          course.id,
          "stream for a while",
        );
        const streamed = await first.waitFor(
          "agent-stream",
          (data) =>
            isRecord(data) &&
            data["courseId"] === course.id &&
            data["turn"] === 1 &&
            isRecord(data["event"]) &&
            data["event"]["type"] === "thinking" &&
            data["event"]["text"] === "waiting forever",
          "first client thinking event",
        );
        expect(streamed.data).toMatchObject({
          courseId: course.id,
          turn: 1,
          sequence: 1,
          event: { type: "thinking", text: "waiting forever" },
        });

        second = await createSseClient(daemon.url, daemon.token);
        const replayed = await second.waitFor(
          "agent-stream",
          (data) =>
            isRecord(data) &&
            data["courseId"] === course.id &&
            data["turn"] === 1 &&
            data["sequence"] === 1 &&
            isRecord(data["event"]) &&
            data["event"]["type"] === "thinking",
          "replayed thinking event",
        );
        expect(replayed.data).toEqual(streamed.data);
      } finally {
        first.close();
        second?.close();
      }
    },
    15_000,
  );

  contractTest(
    "rejects harness changes while a course turn is running",
    async () => {
      if (!(await ensureLocalhost())) {
        return;
      }

      const daemon = await start({ scenario: "never" });
      const sse = await createSseClient(daemon.url, daemon.token);

      try {
        const course = await createCourse(daemon, {
          title: "Running Harness Course",
        });
        await submitCourseMessage(
          daemon.url,
          daemon.token,
          course.id,
          "keep working",
        );
        await sse.waitFor(
          "agent-stream",
          (data) =>
            isRecord(data) &&
            data["courseId"] === course.id &&
            isRecord(data["event"]) &&
            data["event"]["type"] === "thinking",
          "running turn thinking",
        );

        const response = await authFetch(
          daemon,
          `/api/courses/${course.id}/harness`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ id: "codex" }),
          },
        );
        expect(response.status).toBe(409);
        await expect(response.text()).resolves.toContain(
          "Cannot change harness while a turn is running",
        );
      } finally {
        sse.close();
      }
    },
    15_000,
  );

  contractTest(
    "streams an allowed read permission decision for an attached directory",
    async () => {
      if (!(await ensureLocalhost())) {
        return;
      }

      const daemon = await start({
        scenario: "permission",
        extraEnv: ({ dataDir }) => ({
          FAKE_ACP_PERMISSION_KIND: "read",
          FAKE_ACP_PERMISSION_TITLE: "Read attached source.",
          FAKE_ACP_PERMISSION_PATH: join(dataDir, "attached", "notes.md"),
        }),
      });
      const sse = await createSseClient(daemon.url, daemon.token);
      const attachedDir = join(daemon.dataDir, "attached");
      const permissionPath = join(attachedDir, "notes.md");

      try {
        const course = await createCourse(daemon, {
          title: "Attached Permission Course",
          attachedDir,
        });
        await submitCourseMessage(
          daemon.url,
          daemon.token,
          course.id,
          "read the source",
        );

        const permission = await sse.waitFor(
          "agent-stream",
          (data) =>
            isRecord(data) &&
            data["courseId"] === course.id &&
            data["turn"] === 1 &&
            isRecord(data["event"]) &&
            data["event"]["type"] === "permission-request" &&
            isRecord(data["event"]["decision"]) &&
            data["event"]["decision"]["allowed"] === true,
          "allowed permission stream",
        );
        expect(permission.data).toMatchObject({
          courseId: course.id,
          turn: 1,
          event: {
            type: "permission-request",
            request: {
              action: "read",
              resource: permissionPath,
            },
            decision: {
              allowed: true,
              reason:
                "Attached directory reads are pre-approved for this learning session.",
            },
          },
        });
        await sse.waitFor(
          "agent-stream",
          (data) =>
            isRecord(data) &&
            data["courseId"] === course.id &&
            isRecord(data["event"]) &&
            data["event"]["type"] === "text" &&
            data["event"]["text"] === "permission granted by fake",
          "permission granted text stream",
        );
      } finally {
        sse.close();
      }
    },
    15_000,
  );

  contractTest(
    "streams a default-denied permission decision without an attached directory",
    async () => {
      if (!(await ensureLocalhost())) {
        return;
      }

      const daemon = await start({
        scenario: "permission",
        extraEnv: ({ dataDir }) => ({
          FAKE_ACP_PERMISSION_KIND: "read",
          FAKE_ACP_PERMISSION_TITLE: "Read unattached source.",
          FAKE_ACP_PERMISSION_PATH: join(dataDir, "unattached", "notes.md"),
        }),
      });
      const sse = await createSseClient(daemon.url, daemon.token);
      const permissionPath = join(daemon.dataDir, "unattached", "notes.md");

      try {
        const course = await createCourse(daemon, {
          title: "Denied Permission Course",
        });
        await submitCourseMessage(
          daemon.url,
          daemon.token,
          course.id,
          "read without attach",
        );

        const permission = await sse.waitFor(
          "agent-stream",
          (data) =>
            isRecord(data) &&
            data["courseId"] === course.id &&
            data["turn"] === 1 &&
            isRecord(data["event"]) &&
            data["event"]["type"] === "permission-request" &&
            isRecord(data["event"]["decision"]) &&
            data["event"]["decision"]["allowed"] === false,
          "denied permission stream",
        );
        expect(permission.data).toMatchObject({
          courseId: course.id,
          turn: 1,
          event: {
            type: "permission-request",
            request: {
              action: "read",
              resource: permissionPath,
            },
            decision: {
              allowed: false,
              reason: "Permission was not pre-approved by the course daemon.",
            },
          },
        });
        await sse.waitFor(
          "agent-stream",
          (data) =>
            isRecord(data) &&
            data["courseId"] === course.id &&
            isRecord(data["event"]) &&
            data["event"]["type"] === "text" &&
            data["event"]["text"] === "permission denied by fake",
          "permission denied text stream",
        );
      } finally {
        sse.close();
      }
    },
    15_000,
  );

  contractTest(
    "timed out turns cancel the prompt, surface failure, and keep the daemon running",
    async () => {
      if (!(await ensureLocalhost())) {
        return;
      }

      const daemon = await start({
        scenario: "never",
        extraEnv: { OVERLEARN_TURN_TIMEOUT_MS: "50" },
      });
      const sse = await createSseClient(daemon.url, daemon.token);

      try {
        const course = await createCourse(daemon, {
          title: "Timeout Course",
        });
        await submitCourseMessage(
          daemon.url,
          daemon.token,
          course.id,
          "wait forever",
        );
        await sse.waitFor(
          "agent-stream",
          (data) =>
            isRecord(data) &&
            data["courseId"] === course.id &&
            isRecord(data["event"]) &&
            data["event"]["type"] === "thinking",
          "never scenario thinking event",
        );
        await sse.waitFor(
          "status",
          (data) =>
            isRecord(data) &&
            data["courseId"] === course.id &&
            data["status"] === "agent-failed" &&
            typeof data["message"] === "string" &&
            data["message"].includes("timed out"),
          "timeout failure status",
        );

        const entries = await waitForLogEntries(
          daemon.logPath,
          (logs) => logs.some((entry) => entry["event"] === "session/cancel"),
          "cancel log",
        );
        expect(entries.some((entry) => entry["event"] === "session/cancel")).toBe(
          true,
        );

        const health = (await (
          await authFetch(daemon, "/api/health")
        ).json()) as Record<string, unknown>;
        expect(health["ok"]).toBe(true);
      } finally {
        sse.close();
      }
    },
    15_000,
  );

  contractTest(
    "crashed turns retry once and surface a learner-visible failure",
    async () => {
      if (!(await ensureLocalhost())) {
        return;
      }

      const daemon = await start({ scenario: "crash-always" });
      const sse = await createSseClient(daemon.url, daemon.token);

      try {
        const course = await createCourse(daemon, {
          title: "Crash Course",
        });
        await submitCourseMessage(
          daemon.url,
          daemon.token,
          course.id,
          "please crash",
        );
        await sse.waitFor(
          "status",
          (data) =>
            isRecord(data) &&
            data["courseId"] === course.id &&
            data["status"] === "agent-failed" &&
            typeof data["message"] === "string" &&
            data["message"].includes("crashed"),
          "agent crashed status",
        );

        const entries = await waitForLogEntries(
          daemon.logPath,
          (logs) =>
            logs.filter((entry) => entry["event"] === "session/new").length >=
              2 &&
            logs.filter((entry) => entry["event"] === "session/prompt").length >=
              2,
          "crash retry sessions",
        );
        expect(
          entries.filter((entry) => entry["event"] === "session/prompt"),
        ).toHaveLength(2);

        const health = (await (
          await authFetch(daemon, "/api/health")
        ).json()) as Record<string, unknown>;
        expect(health["ok"]).toBe(true);
      } finally {
        sse.close();
      }
    },
    15_000,
  );

  contractTest(
    "runs the final wrap-up turn, expires the MCP token, emits session-ended, and exits",
    async () => {
      if (!(await ensureLocalhost())) {
        return;
      }

      const daemon = await start({
        scenario: "normal",
        extraEnv: {
          FAKE_ACP_MESSAGE_CHUNKS: JSON.stringify([
            "Hi",
            ".",
            " We're",
            " ready.",
          ]),
        },
      });
      const sse = await createSseClient(daemon.url, daemon.token);

      try {
        const course = await createCourse(daemon, { title: "Done Course" });
        await submitCourseMessage(
          daemon.url,
          daemon.token,
          course.id,
          "start before done",
        );
        await sse.waitFor(
          "agent-stream",
          (data) =>
            isRecord(data) &&
            data["courseId"] === course.id &&
            data["turn"] === 1 &&
            isRecord(data["event"]) &&
            data["event"]["type"] === "done",
          "first turn done",
        );

        // Streamed agent text chunks must be persisted as ONE transcript
        // row (write-time coalescing), tagged with the turn number.
        const firstState = await courseState(daemon, course.id);
        const firstTranscript = firstState["transcript"];
        expect(Array.isArray(firstTranscript)).toBe(true);
        const agentMessages = (firstTranscript as readonly unknown[]).filter(
          (entry) =>
            isRecord(entry) &&
            entry["role"] === "agent" &&
            (entry["kind"] ?? "text") === "text",
        );
        expect(agentMessages).toHaveLength(1);
        expect(agentMessages[0]).toMatchObject({
          role: "agent",
          text: "Hi. We're ready.",
          turn: 1,
        });

        const firstLogs = await waitForLogEntries(
          daemon.logPath,
          (entries) =>
            entries.some((entry) => entry["event"] === "session/new"),
          "first session log",
        );
        const tokenUrl = mcpUrlFromLogs(firstLogs);

        await submitCourseDone(daemon.url, daemon.token, course.id);
        await sse.waitFor(
          "status",
          (data) =>
            isRecord(data) &&
            data["courseId"] === course.id &&
            data["status"] === "wrapping-up",
          "wrapping status",
        );
        await sse.waitFor(
          "agent-stream",
          (data) =>
            isRecord(data) &&
            data["courseId"] === course.id &&
            data["turn"] === 2 &&
            isRecord(data["event"]) &&
            data["event"]["type"] === "done",
          "wrap-up done stream",
        );

        const expired = await fetch(tokenUrl, { method: "POST", body: "{}" });
        expect(expired.status).toBe(404);

        await sse.waitFor(
          "status",
          (data) =>
            isRecord(data) &&
            data["courseId"] === course.id &&
            data["status"] === "session-ended",
          "session-ended status",
        );
        await waitForDaemonStopped(daemon.dataDir, daemon.pid);
      } finally {
        sse.close();
      }
    },
    15_000,
  );

  contractTest(
    "rejects starting a second course while another course owns the active session",
    async () => {
      if (!(await ensureLocalhost())) {
        return;
      }

      const daemon = await start({ scenario: "normal" });

      const first = await createCourse(daemon, { title: "First Course" });
      const second = await createCourse(daemon, { title: "Second Course" });

      await submitCourseMessage(
        daemon.url,
        daemon.token,
        first.id,
        "start first",
      );
      const response = await authFetch(daemon, `/api/courses/${second.id}/submit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "start second" }),
      });

      expect(response.status).toBe(409);
      await expect(response.text()).resolves.toContain(
        "already has the active learning session",
      );
    },
    15_000,
  );
});

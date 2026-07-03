import { afterEach, describe, expect, test } from "bun:test";
import { constants } from "node:fs";
import { createServer } from "node:net";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import worker from "../src/index";
import type { Env } from "../src/types";

const registryRoot = resolve(import.meta.dir, "..");
const repoRoot = resolve(registryRoot, "..");
const learnBin = join(repoRoot, "src", "cli", "index.ts");

const tempRoots = new Set<string>();
const cleanupTasks: Array<() => Promise<void>> = [];

const sleep = async (ms: number): Promise<void> =>
  new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

const freePort = async (): Promise<number> =>
  new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address !== null && typeof address === "object") {
          resolvePort(address.port);
        } else {
          reject(new Error("Unable to allocate a test port."));
        }
      });
    });
  });

const writeJson = async (path: string, value: unknown): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
};

const findOnPath = async (name: string): Promise<string | undefined> => {
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (dir.length === 0) {
      continue;
    }

    const candidate = join(dir, name);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Keep searching.
    }
  }

  return undefined;
};

const fetchWorker = (path: string): Promise<Response> =>
  worker.fetch(new Request(`https://overlearn.org${path}`), {} as Env);

const createFixtureCourse = async (): Promise<Readonly<{ coursesDir: string }>> => {
  const root = await mkdtemp(join(tmpdir(), "overlearn-registry-it-"));
  tempRoots.add(root);

  const coursesDir = join(root, "courses");
  const courseDir = join(coursesDir, "roundtrip");
  await mkdir(join(courseDir, "lessons"), { recursive: true });
  await mkdir(join(courseDir, "demos"), { recursive: true });
  await mkdir(join(courseDir, ".overlearn"), { recursive: true });

  await writeJson(join(courseDir, "course.json"), {
    formatVersion: 1,
    name: "Compound Interest",
    createdAt: "2026-01-01T00:00:00.000Z",
    topics: [
      {
        path: "growth",
        title: "Growth",
        lesson: "01-growth",
        current: true,
        demos: [
          {
            file: "growth.html",
            title: "Growth curve",
            addedAt: "2026-01-01T00:01:00.000Z",
          },
        ],
        children: [],
      },
    ],
    unassignedDemos: [],
  });
  await writeJson(join(courseDir, "glossary.json"), [
    {
      term: "Compounding",
      def: "Growth that earns growth on prior growth.",
      lesson: "01-growth",
      addedAt: "2026-01-01T00:02:00.000Z",
    },
  ]);
  await writeFile(
    join(courseDir, "lessons", "01-growth.md"),
    "# Growth\n\nCompounding grows on itself.\n",
    "utf8",
  );
  await writeFile(
    join(courseDir, "demos", "growth.html"),
    "<!doctype html><h1>Growth curve</h1>\n",
    "utf8",
  );
  await writeFile(join(courseDir, "transcript.jsonl"), "private transcript\n", "utf8");
  await writeJson(join(courseDir, "mastery.json"), [{ private: true }]);
  await writeFile(join(courseDir, ".overlearn", "daemon.json"), "private\n", "utf8");

  return { coursesDir };
};

const startGitHubStub = async (): Promise<string> => {
  const port = await freePort();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch: async (request) => {
      const url = new URL(request.url);

      if (url.pathname === "/login/device/code" && request.method === "POST") {
        return Response.json({
          device_code: "device-test",
          user_code: "ABCD-EFGH",
          verification_uri: `${url.origin}/device`,
          expires_in: 600,
          interval: 0,
        });
      }

      if (
        url.pathname === "/login/oauth/access_token" &&
        request.method === "POST"
      ) {
        return Response.json({
          access_token: "test-token",
          token_type: "bearer",
          scope: "read:user",
        });
      }

      if (url.pathname === "/user") {
        const authorization = request.headers.get("Authorization");
        if (authorization !== "Bearer test-token") {
          return Response.json({ message: "bad credentials" }, { status: 401 });
        }

        return Response.json({
          login: "octocat",
          html_url: "https://github.com/octocat",
        });
      }

      return Response.json({ message: "not found" }, { status: 404 });
    },
  });

  cleanupTasks.push(async () => {
    server.stop(true);
  });

  return `http://127.0.0.1:${server.port}`;
};

const startReleaseStub = async (): Promise<string> => {
  const port = await freePort();
  const fixture = "#!/bin/sh\necho overlearn fixture\n";
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch: (request) => {
      const url = new URL(request.url);

      if (
        /^\/releases\/(?:latest\/download|download\/v[^/]+)\/learn-(?:linux|darwin)-(?:x64|arm64)$/.test(
          url.pathname,
        )
      ) {
        return new Response(fixture, {
          headers: {
            "Content-Type": "application/octet-stream",
          },
        });
      }

      return new Response("not found", { status: 404 });
    },
  });

  cleanupTasks.push(async () => {
    server.stop(true);
  });

  return `http://127.0.0.1:${server.port}/releases`;
};

type ProcessResult = Readonly<{
  exitCode: number;
  stdout: string;
  stderr: string;
}>;

const runProcess = async (
  cmd: readonly string[],
  env: Record<string, string>,
  cwd = repoRoot,
): Promise<ProcessResult> => {
  const proc = Bun.spawn({
    cmd,
    cwd,
    env: {
      ...process.env,
      ...env,
      CI: "true",
      NO_COLOR: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = new Response(proc.stdout).text();
  const stderr = new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  return {
    exitCode,
    stdout: await stdout,
    stderr: await stderr,
  };
};

const runLearn = async (
  args: readonly string[],
  env: Record<string, string>,
): Promise<ProcessResult> => {
  const result = await runProcess(["bun", learnBin, ...args], env);

  if (result.exitCode !== 0) {
    throw new Error(
      `learn ${args.join(" ")} failed:\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }

  return result;
};

const writeWranglerConfig = async (githubUrl: string, port: number): Promise<string> => {
  const configPath = join(registryRoot, `wrangler.it.${port}.toml`);
  await writeFile(
    configPath,
    [
      'name = "overlearn-registry-it"',
      'main = "src/index.ts"',
      'compatibility_date = "2025-01-01"',
      "workers_dev = true",
      "",
      "[vars]",
      'GITHUB_CLIENT_ID = "test-client"',
      `GITHUB_API_BASE = "${githubUrl}"`,
      "",
      "[[r2_buckets]]",
      'binding = "COURSES"',
      'bucket_name = "overlearn-courses-it"',
      'preview_bucket_name = "overlearn-courses-it-preview"',
      "",
      "[[kv_namespaces]]",
      'binding = "META"',
      'id = "00000000000000000000000000000000"',
      'preview_id = "00000000000000000000000000000000"',
      "",
    ].join("\n"),
    "utf8",
  );

  cleanupTasks.push(async () => {
    await unlink(configPath).catch(() => undefined);
  });

  return configPath;
};

const startWorker = async (githubUrl: string): Promise<string> => {
  const port = await freePort();
  const configPath = await writeWranglerConfig(githubUrl, port);
  const wranglerBin = join(registryRoot, "node_modules", ".bin", "wrangler");
  const proc = Bun.spawn({
    cmd: [
      wranglerBin,
      "dev",
      "--local",
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
      "--config",
      configPath,
    ],
    cwd: registryRoot,
    env: {
      ...process.env,
      CI: "true",
      NO_COLOR: "1",
      WRANGLER_SEND_METRICS: "false",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = new Response(proc.stdout).text();
  const stderr = new Response(proc.stderr).text();
  const workerUrl = `http://127.0.0.1:${port}`;

  cleanupTasks.push(async () => {
    proc.kill();
    await Promise.race([proc.exited, sleep(5000)]);
    if (!(await Promise.race([proc.exited.then(() => true), sleep(0).then(() => false)]))) {
      proc.kill("SIGKILL");
    }
    await Promise.allSettled([stdout, stderr]);
  });

  const deadline = Date.now() + 45_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${workerUrl}/api/courses`);
      if (response.ok) {
        return workerUrl;
      }
    } catch (error) {
      lastError = error;
    }

    await sleep(250);
  }

  proc.kill();
  throw new Error(`wrangler dev did not become ready: ${String(lastError)}`);
};

afterEach(async () => {
  for (const task of cleanupTasks.splice(0).reverse()) {
    await task();
  }

  await Promise.all(
    [...tempRoots].map((root) => rm(root, { recursive: true, force: true })),
  );
  tempRoots.clear();
});

describe("landing page", () => {
  test("serves the chalkboard landing at / and the registry index at /courses", async () => {
    const landing = await fetchWorker("/");
    expect(landing.status).toBe(200);
    expect(landing.headers.get("Content-Type")).toContain("text/html");

    const body = await landing.text();
    expect(body).toContain("curl -fsSL https://overlearn.org/install.sh | bash");
    expect(body).toContain("DO NOT ERASE");
    expect(body).toContain('href="/courses"');

    const post = await worker.fetch(
      new Request("https://overlearn.org/", { method: "POST" }),
      {} as Env,
    );
    expect(post.status).toBe(405);
  });
});

describe("installer", () => {
  test("serves /install.sh and /install as a shell script", async () => {
    const response = await fetchWorker("/install.sh");
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe(
      "text/x-shellscript; charset=utf-8",
    );

    const body = await response.text();
    expect(body).toStartWith("#!/usr/bin/env bash\n");
    expect(body).toContain("OVERLEARN_VERSION");
    expect(body).toContain("learn install claude-code");
    expect(body).not.toContain("claude plugin install overlearn@overlearn");

    const alias = await fetchWorker("/install");
    expect(alias.status).toBe(200);
    expect(await alias.text()).toBe(body);
  });

  test("installer script passes shellcheck when available", async () => {
    const shellcheck = await findOnPath("shellcheck");
    if (shellcheck === undefined) {
      if (process.env.CI === "true") {
        throw new Error("shellcheck is required in CI.");
      }

      return;
    }

    const response = await fetchWorker("/install.sh");
    const scriptPath = join(
      await mkdtemp(join(tmpdir(), "overlearn-shellcheck-")),
      "install.sh",
    );
    tempRoots.add(dirname(scriptPath));
    await writeFile(scriptPath, await response.text(), { mode: 0o755 });

    const result = await runProcess([shellcheck, "-s", "bash", scriptPath], {});
    expect(result).toEqual({
      exitCode: 0,
      stdout: "",
      stderr: "",
    });
  });

  test("installer downloads, installs, hints PATH, and never touches agent config", async () => {
    const bash = await findOnPath("bash");
    if (bash === undefined) {
      throw new Error("bash is required to test the installer.");
    }

    const response = await fetchWorker("/install.sh");
    const script = await response.text();
    const releaseBase = await startReleaseStub();
    const root = await mkdtemp(join(tmpdir(), "overlearn-installer-"));
    const installDir = join(root, "bin");
    const homeDir = join(root, "home");
    tempRoots.add(root);

    const result = await runProcess(
      [bash, "-c", script],
      {
        HOME: homeDir,
        OVERLEARN_DL_BASE: releaseBase,
        OVERLEARN_INSTALL_DIR: installDir,
        PATH: "/usr/bin:/bin",
        SHELL: "/bin/bash",
      },
      repoRoot,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`Installed learn to ${installDir}/learn`);
    expect(result.stdout).toContain("PATH hint:");
    expect(result.stdout).toContain("Claude Code setup (optional, run it yourself):");
    expect(result.stdout).toContain("learn install claude-code");
    expect(result.stdout).toContain("Quickstart:");
    expect(result.stderr).toBe("");

    const installed = join(installDir, "learn");
    await expect(readFile(installed, "utf8")).resolves.toBe(
      "#!/bin/sh\necho overlearn fixture\n",
    );
    expect((await stat(installed)).mode & 0o777).toBe(0o755);
  });
});

describe("registry local integration", () => {
  test("share, index, fetch, export, and unpublish round-trip through wrangler dev", async () => {
    const githubUrl = await startGitHubStub();
    const workerUrl = await startWorker(githubUrl);
    const { coursesDir } = await createFixtureCourse();
    const fetchedCoursesDir = await mkdtemp(join(tmpdir(), "overlearn-fetched-"));
    const configDir = await mkdtemp(join(tmpdir(), "overlearn-config-"));
    tempRoots.add(fetchedCoursesDir);
    tempRoots.add(configDir);

    const commonEnv = {
      OVERLEARN_REGISTRY_URL: workerUrl,
      OVERLEARN_GITHUB_CLIENT_ID: "test-client",
      OVERLEARN_GITHUB_DEVICE_POLL_MS: "0",
      OVERLEARN_CONFIG_DIR: configDir,
      GITHUB_API_BASE: githubUrl,
      GITHUB_OAUTH_BASE: githubUrl,
    };

    const share = await runLearn(["share", "roundtrip", "--json"], {
      ...commonEnv,
      OVERLEARN_COURSES_DIR: coursesDir,
    });
    const published = JSON.parse(share.stdout) as { slug: string; url: string };

    expect(published.slug).toBe("compound-interest");
    expect(published.url).toBe(`${workerUrl}/c/compound-interest`);

    const landingHtml = await fetch(workerUrl).then((response) => response.text());
    expect(landingHtml).toContain("DO NOT ERASE");

    const indexHtml = await fetch(`${workerUrl}/courses`).then((response) =>
      response.text(),
    );
    expect(indexHtml).toContain("Compound Interest");
    expect(indexHtml).toContain("octocat");

    const indexJson = (await fetch(`${workerUrl}/api/courses`).then((response) =>
      response.json(),
    )) as { courses: Array<{ slug: string; topicCount: number }> };
    expect(indexJson.courses).toEqual([
      expect.objectContaining({ slug: "compound-interest", topicCount: 1 }),
    ]);

    const fetched = await runLearn(["fetch", published.slug, "--json"], {
      ...commonEnv,
      OVERLEARN_COURSES_DIR: fetchedCoursesDir,
    });
    const fetchedJson = JSON.parse(fetched.stdout) as { courseDir: string };

    await expect(
      readFile(join(fetchedJson.courseDir, "course.json"), "utf8"),
    ).resolves.toContain("Compound Interest");
    await expect(
      readFile(join(fetchedJson.courseDir, "transcript.jsonl"), "utf8"),
    ).rejects.toThrow();
    await expect(
      readFile(join(fetchedJson.courseDir, "mastery.json"), "utf8"),
    ).rejects.toThrow();

    const exportDir = join(fetchedCoursesDir, "exported-site");
    await runLearn(["export", published.slug, "--out", exportDir], {
      ...commonEnv,
      OVERLEARN_COURSES_DIR: fetchedCoursesDir,
    });
    await expect(readFile(join(exportDir, "index.html"), "utf8")).resolves.toContain(
      "Compound Interest",
    );

    const unpublished = await runLearn(["unpublish", "roundtrip", "--json"], {
      ...commonEnv,
      OVERLEARN_COURSES_DIR: coursesDir,
    });
    expect(JSON.parse(unpublished.stdout)).toEqual({
      ok: true,
      slug: "compound-interest",
    });

    const after = (await fetch(`${workerUrl}/api/courses`).then((response) =>
      response.json(),
    )) as { courses: unknown[] };
    expect(after.courses).toEqual([]);
  });
});

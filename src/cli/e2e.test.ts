import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const cliPath = fileURLToPath(new URL("./index.ts", import.meta.url));

const streamText = async (
  stream: ReadableStream<Uint8Array> | null,
): Promise<string> => (stream === null ? "" : await new Response(stream).text());

const runLearn = async (
  args: readonly string[],
  env: Record<string, string>,
): Promise<Readonly<{ exitCode: number; stdout: string; stderr: string }>> => {
  const child = Bun.spawn([process.execPath, cliPath, ...args], {
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    streamText(child.stdout),
    streamText(child.stderr),
  ]);

  return { exitCode, stdout, stderr };
};

describe("learn wait", () => {
  test("returns a clear removed-command error", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "overlearn-cli-wait-"));
    const env: Record<string, string> = {
      ...process.env,
      OVERLEARN_DATA_DIR: dataDir,
      OVERLEARN_NO_BROWSER: "1",
      NO_COLOR: "1",
    };
    delete env["FORCE_COLOR"];

    try {
      const result = await runLearn(["wait", "course"], env);

      expect(result.exitCode).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("learn wait has been removed");
    } finally {
      await rm(dataDir, { force: true, recursive: true });
    }
  });
});

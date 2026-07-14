import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAcpHarnessAdapter } from "../../src/adapter/acp";
import type { AgentEvent, SessionRef } from "../../src/adapter";

const smokeTimeoutMs = 180_000;

const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
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

const collectPrompt = async (
  events: AsyncIterable<AgentEvent>,
): Promise<Readonly<{ sawPong: boolean; sawDone: boolean }>> => {
  let sawPong = false;
  let sawDone = false;

  for await (const event of events) {
    console.log(JSON.stringify(event));

    if (event.type === "text" && event.text.toLowerCase().includes("pong")) {
      sawPong = true;
    }

    if (event.type === "error") {
      throw new Error(event.message);
    }

    if (event.type === "done") {
      sawDone = true;
      break;
    }
  }

  return { sawPong, sawDone };
};

const run = async (): Promise<void> => {
  const anthropicKey = process.env["ANTHROPIC_API_KEY"];
  if (anthropicKey === undefined || anthropicKey.trim().length === 0) {
    fail("ANTHROPIC_API_KEY is required for the real ACP smoke workflow.");
  }

  const command = process.env["CLAUDE_CODE_ACP_COMMAND"] ?? "claude-code-acp";
  const binDir = process.env["CLAUDE_CODE_ACP_BIN_DIR"];
  const path =
    binDir === undefined || binDir.length === 0
      ? process.env["PATH"]
      : `${binDir}:${process.env["PATH"] ?? ""}`;
  const cwd = await mkdtemp(join(tmpdir(), "overlearn-acp-real-"));
  const adapter = createAcpHarnessAdapter(
    {
      id: "claude-code-real",
      name: "Claude Code ACP Real",
      command,
      args: [],
      versionArgs: ["--version"],
      auth: { env: ["ANTHROPIC_API_KEY"] },
    },
    {
      env: {
        ANTHROPIC_API_KEY: anthropicKey,
        CLAUDECODE: undefined,
        PATH: path,
      },
      requestTimeoutMs: 30_000,
    },
  );
  let session: SessionRef | undefined;

  try {
    const detection = await adapter.detect();
    console.log(JSON.stringify({ event: "detect", detection }));
    if (!detection.installed) {
      throw new Error(`${command} was not detected on PATH.`);
    }
    if (!detection.authenticated) {
      throw new Error("Claude Code ACP adapter did not detect authentication.");
    }

    session = await withTimeout(adapter.newSession(cwd), 60_000, "newSession");
    const result = await collectPrompt(
      adapter.prompt(session, "Reply with exactly: pong"),
    );

    if (!result.sawPong) {
      throw new Error("ACP smoke did not receive a text event containing pong.");
    }
    if (!result.sawDone) {
      throw new Error("ACP smoke did not receive a done event.");
    }
  } finally {
    if (session !== undefined) {
      await withTimeout(adapter.end(session), 15_000, "end session").catch(
        (error: unknown) => {
          console.error(error instanceof Error ? error.message : String(error));
        },
      );
    }
    await rm(cwd, { force: true, recursive: true });
  }
};

await withTimeout(run(), smokeTimeoutMs, "real ACP smoke").catch((error: unknown) => {
  fail(error instanceof Error ? error.message : String(error));
});

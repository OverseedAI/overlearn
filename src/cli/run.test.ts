import { describe, expect, test } from "bun:test";

import { parseCli, runCli } from "./run";

describe("runCli", () => {
  test("prints the package version", () => {
    expect(runCli(["--version"], "1.2.3")).toEqual({
      exitCode: 0,
      stdout: "1.2.3",
    });
  });

  test("prints internal help for an empty invocation", () => {
    const result = runCli([], "1.2.3");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("overlearn-internal daemon");
    expect(result.stdout).toContain("overlearn-internal mcp-proxy <url>");
    expect(result.stdout).not.toContain("start [name]");
    expect(result.stdout).not.toContain("resume <name>");
    expect(result.stdout).not.toContain("emit glossary");
  });

  test("parses daemon mode with optional files", () => {
    expect(
      parseCli(
        [
          "daemon",
          "--data-dir",
          "/tmp/overlearn-data",
          "--port-file",
          "/tmp/overlearn-port",
        ],
        "1.2.3",
      ),
    ).toEqual({
      kind: "daemon",
      dataDir: "/tmp/overlearn-data",
      portFile: "/tmp/overlearn-port",
    });
  });

  test("rejects invalid daemon options", () => {
    expect(parseCli(["daemon", "--port-file"], "1.2.3")).toEqual({
      kind: "result",
      result: {
        exitCode: 1,
        stdout: expect.stringContaining("overlearn-internal daemon"),
        stderr:
          "Usage: overlearn-internal daemon [--data-dir <dir>] [--port-file <path>]",
      },
    });

    expect(parseCli(["daemon", "--browser"], "1.2.3")).toEqual({
      kind: "result",
      result: {
        exitCode: 1,
        stdout: expect.stringContaining("overlearn-internal daemon"),
        stderr: "Unknown daemon option: --browser",
      },
    });
  });

  test("parses mcp proxy mode", () => {
    expect(
      parseCli(
        ["mcp-proxy", "http://127.0.0.1:9000/mcp/token", "x-test=1"],
        "1.2.3",
      ),
    ).toEqual({
      kind: "mcp-proxy",
      args: ["http://127.0.0.1:9000/mcp/token", "x-test=1"],
    });
  });

  test("rejects removed public commands", () => {
    expect(parseCli(["resume", "course"], "1.2.3")).toEqual({
      kind: "result",
      result: {
        exitCode: 1,
        stdout: expect.stringContaining("overlearn-internal daemon"),
        stderr: "Unsupported internal command: resume",
      },
    });
  });
});

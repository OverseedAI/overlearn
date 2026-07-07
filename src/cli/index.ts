#!/usr/bin/env bun

import packageJson from "../../package.json";
import { runDaemon } from "../daemon";
import { parseMcpProxyConfig, runMcpHttpStdioProxy } from "../mcp/proxy";
import { parseCli, type CliResult } from "./run";

const writeResult = (result: CliResult): void => {
  if (result.stderr !== undefined) {
    console.error(result.stderr);
  }

  if (result.stdout.length > 0) {
    console.log(result.stdout);
  }
};

const errorResult = (error: unknown): CliResult => ({
  exitCode: 1,
  stdout: "",
  stderr: error instanceof Error ? error.message : "Unknown error.",
});

const main = async (): Promise<CliResult> => {
  const command = parseCli(process.argv.slice(2), packageJson.version);

  if (command.kind === "result") {
    return command.result;
  }

  if (command.kind === "mcp-proxy") {
    await runMcpHttpStdioProxy(parseMcpProxyConfig(command.args));
    return {
      exitCode: 0,
      stdout: "",
    };
  }

  const env = {
    ...process.env,
    ...(command.dataDir === undefined
      ? {}
      : { OVERLEARN_DATA_DIR: command.dataDir }),
  };
  await runDaemon(env, {
    ...(command.portFile === undefined ? {} : { portFile: command.portFile }),
  });
  return {
    exitCode: 0,
    stdout: "",
  };
};

const result = await main().catch(errorResult);
writeResult(result);
process.exitCode = result.exitCode;

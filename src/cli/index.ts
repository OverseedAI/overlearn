#!/usr/bin/env bun

import packageJson from "../../package.json";
import { runCli, type CliResult } from "./run";

const writeResult = (result: CliResult): void => {
  if (result.stderr !== undefined) {
    console.error(result.stderr);
  }

  if (result.stdout.length > 0) {
    console.log(result.stdout);
  }
};

const result = runCli(process.argv.slice(2), packageJson.version);

writeResult(result);
process.exitCode = result.exitCode;

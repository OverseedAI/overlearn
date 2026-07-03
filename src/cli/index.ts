#!/usr/bin/env bun

import packageJson from "../../package.json";
import {
  formatInstructions,
  formatInstructionsJson,
} from "../instructions";
import {
  getCourseStatus,
  LearnCommandError,
  runDaemon,
  sayAgentMessage,
  startCourseDaemon,
  waitForLearnerTurn,
} from "../daemon";
import {
  resolveCourseDirForWait,
  upsertGlossaryEntry,
  type GlossaryMutation,
} from "../course";
import { parseCli, type CliResult } from "./run";

const writeResult = (result: CliResult): void => {
  if (result.stderr !== undefined) {
    console.error(result.stderr);
  }

  if (result.stdout.length > 0) {
    console.log(result.stdout);
  }
};

const errorResult = (error: unknown): CliResult => {
  if (error instanceof LearnCommandError) {
    return {
      exitCode: error.exitCode,
      stdout: "",
      stderr: error.message,
    };
  }

  return {
    exitCode: 1,
    stdout: "",
    stderr: error instanceof Error ? error.message : "Unknown error.",
  };
};

const formatGlossaryEmitOutput = (
  coursePath: string,
  mutation: GlossaryMutation,
  json: boolean,
): string => {
  if (json) {
    return JSON.stringify({
      ok: true,
      kind: "glossary",
      action: mutation.action,
      coursePath,
      entry: mutation.entry,
    });
  }

  return `${mutation.action} glossary term: ${mutation.entry.term}`;
};

const main = async (): Promise<CliResult> => {
  const command = parseCli(process.argv.slice(2), packageJson.version);

  if (command.kind === "result") {
    return command.result;
  }

  if (command.kind === "start") {
    return {
      exitCode: 0,
      stdout: await startCourseDaemon(command.name),
    };
  }

  if (command.kind === "wait") {
    return {
      exitCode: 0,
      stdout: await waitForLearnerTurn(command.name),
    };
  }

  if (command.kind === "instructions") {
    return {
      exitCode: 0,
      stdout: command.json ? formatInstructionsJson() : formatInstructions(),
    };
  }

  if (command.kind === "status") {
    return {
      exitCode: 0,
      stdout: JSON.stringify(await getCourseStatus(command.name)),
    };
  }

  if (command.kind === "say") {
    const stderr = await sayAgentMessage(command.name, command.source);
    return stderr === undefined
      ? {
          exitCode: 0,
          stdout: "",
        }
      : {
          exitCode: 0,
          stdout: "",
          stderr,
        };
  }

  if (command.kind === "emit") {
    const coursePath = await resolveCourseDirForWait(command.name);
    const mutation = await upsertGlossaryEntry(coursePath, command.emit);

    return {
      exitCode: 0,
      stdout: formatGlossaryEmitOutput(coursePath, mutation, command.emit.json),
    };
  }

  await runDaemon(command.courseDir);
  return {
    exitCode: 0,
    stdout: "",
  };
};

const result = await main().catch(errorResult);
writeResult(result);
process.exitCode = result.exitCode;

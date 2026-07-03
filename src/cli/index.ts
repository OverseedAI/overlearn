#!/usr/bin/env bun

import { basename } from "node:path";

import packageJson from "../../package.json";
import {
  assembleInstructionModules,
  ejectInstructionModules,
  formatEjectInstructionModules,
  formatInstructions,
  formatInstructionsJson,
} from "../instructions";
import {
  formatInstallHarnessResult,
  formatUninstallHarnessResult,
  installHarness,
  uninstallHarness,
} from "../harness";
import {
  getCourseStatus,
  LearnCommandError,
  notifyAgentTranscriptEntry,
  resumeCourseDaemon,
  runDaemon,
  sayAgentMessage,
  startCourseDaemon,
  waitForLearnerTurn,
} from "../daemon";
import {
  appendAgentDemoTranscript,
  appendMasteryScore,
  registerFeynmanCheck,
  registerDemo,
  resolveCourseDirForWait,
  upsertGlossaryEntry,
  upsertTopic,
  type ActiveFeynmanCheck,
  type DemoMutation,
  type GlossaryMutation,
  type MasteryEntry,
  type TopicMutation,
} from "../course";
import {
  exportCourse,
  formatStaticExportResult,
  resolveStaticExportCourseDir,
} from "../export";
import { fetchCourse, shareCourse, unpublishCourse } from "../registry";
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

const isNoCourseSelectedError = (error: unknown): boolean =>
  error instanceof Error && error.message.startsWith("No course selected.");

const resolveInstructionsCourseDir = async (
  name: string | undefined,
): Promise<string | undefined> => {
  try {
    return await resolveCourseDirForWait(name);
  } catch (error) {
    if (name === undefined && isNoCourseSelectedError(error)) {
      return undefined;
    }

    throw error;
  }
};

const formatTopicEmitOutput = (
  coursePath: string,
  mutation: TopicMutation,
  json: boolean,
): string => {
  if (json) {
    return JSON.stringify({
      ok: true,
      kind: "topic",
      action: mutation.action,
      coursePath,
      topic: mutation.topic,
      topics: mutation.topics,
    });
  }

  return `${mutation.action} topic: ${mutation.topic.path}`;
};

const formatDemoEmitOutput = (
  coursePath: string,
  mutation: DemoMutation,
  json: boolean,
): string => {
  if (json) {
    return JSON.stringify({
      ok: true,
      kind: "demo",
      action: mutation.action,
      coursePath,
      demo: mutation.demo,
      ...(mutation.topic === undefined ? {} : { topic: mutation.topic }),
      topics: mutation.topics,
      unassignedDemos: mutation.unassignedDemos,
    });
  }

  return `${mutation.action} demo: ${mutation.demo.file}`;
};

const formatFeynmanEmitOutput = (
  coursePath: string,
  check: ActiveFeynmanCheck,
  json: boolean,
): string => {
  if (json) {
    return JSON.stringify({
      ok: true,
      kind: "feynman",
      coursePath,
      activeCheck: check,
    });
  }

  return `active feynman check: ${check.concept}`;
};

const formatMasteryEmitOutput = (
  coursePath: string,
  entry: MasteryEntry,
  json: boolean,
): string => {
  if (json) {
    return JSON.stringify({
      ok: true,
      kind: "mastery",
      coursePath,
      entry,
    });
  }

  return `recorded mastery: ${entry.concept} ${entry.score}`;
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

  if (command.kind === "resume") {
    return {
      exitCode: 0,
      stdout: await resumeCourseDaemon(command.name),
    };
  }

  if (command.kind === "wait") {
    const turn = await waitForLearnerTurn(command.name);
    const course = basename(turn.courseDir);

    // Crit-style wake-time re-prompt: restate the loop discipline at the
    // moment the agent resumes, instead of trusting skill text from earlier
    // turns. Stdout stays machine-readable (the turn.json path only).
    return {
      exitCode: 0,
      stdout: turn.turnPath,
      stderr: [
        `Act on every event in the printed turn.json, then immediately re-enter \`learn wait ${course}\` —`,
        "as a background task on Claude Code, or as a foreground blocking command on Codex.",
        "Never end the session without a pending wait unless the learner said goodbye.",
      ].join("\n"),
    };
  }

  if (command.kind === "instructions") {
    const courseDir = await resolveInstructionsCourseDir(command.name);
    const modules = assembleInstructionModules(
      courseDir === undefined ? {} : { courseDir },
    );

    return {
      exitCode: 0,
      stdout: command.json
        ? formatInstructionsJson(modules)
        : formatInstructions(modules),
    };
  }

  if (command.kind === "instructions-eject") {
    const modules = await ejectInstructionModules({
      ...(command.toDir === undefined ? {} : { toDir: command.toDir }),
      force: command.force,
    });

    return {
      exitCode: 0,
      stdout: formatEjectInstructionModules(modules),
    };
  }

  if (command.kind === "install") {
    const result = await installHarness({
      tool: command.tool,
      scope: command.project ? "project" : "global",
      force: command.force,
    });

    return {
      exitCode: 0,
      stdout: formatInstallHarnessResult(result),
    };
  }

  if (command.kind === "uninstall") {
    const result = await uninstallHarness({
      tool: command.tool,
      scope: command.project ? "project" : "global",
      force: command.force,
    });

    return {
      exitCode: 0,
      stdout: formatUninstallHarnessResult(result),
    };
  }

  if (command.kind === "status") {
    return {
      exitCode: 0,
      stdout: JSON.stringify(await getCourseStatus(command.name)),
    };
  }

  if (command.kind === "export") {
    const courseDir = await resolveStaticExportCourseDir(command.name);
    const exported = await exportCourse({
      courseDir,
      ...(command.outDir === undefined ? {} : { outDir: command.outDir }),
      includeTranscript: command.includeTranscript,
      force: command.force,
    });

    return {
      exitCode: 0,
      stdout: formatStaticExportResult(exported, command.json),
    };
  }

  if (command.kind === "share") {
    return {
      exitCode: 0,
      stdout: await shareCourse({
        ...(command.name === undefined ? {} : { name: command.name }),
        json: command.json,
      }),
    };
  }

  if (command.kind === "unpublish") {
    return {
      exitCode: 0,
      stdout: await unpublishCourse({
        ...(command.name === undefined ? {} : { name: command.name }),
        json: command.json,
      }),
    };
  }

  if (command.kind === "fetch") {
    return {
      exitCode: 0,
      stdout: await fetchCourse({
        input: command.input,
        force: command.force,
        json: command.json,
      }),
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

    if (command.emit.kind === "topic") {
      const mutation = await upsertTopic(coursePath, command.emit);
      return {
        exitCode: 0,
        stdout: formatTopicEmitOutput(coursePath, mutation, command.emit.json),
      };
    }

    if (command.emit.kind === "demo") {
      const now = new Date();
      const mutation = await registerDemo(coursePath, command.emit, now);
      const entry = await appendAgentDemoTranscript(
        coursePath,
        mutation.demo.file,
        mutation.demo.title,
        now.toISOString(),
      );
      const warning = await notifyAgentTranscriptEntry(coursePath, entry);
      const stdout = formatDemoEmitOutput(
        coursePath,
        mutation,
        command.emit.json,
      );

      return warning === undefined
        ? {
            exitCode: 0,
            stdout,
          }
        : {
            exitCode: 0,
            stdout,
            stderr: warning,
          };
    }

    if (command.emit.kind === "feynman") {
      const check = await registerFeynmanCheck(coursePath, command.emit);
      return {
        exitCode: 0,
        stdout: formatFeynmanEmitOutput(coursePath, check, command.emit.json),
      };
    }

    if (command.emit.kind === "mastery") {
      const entry = await appendMasteryScore(coursePath, command.emit);
      return {
        exitCode: 0,
        stdout: formatMasteryEmitOutput(coursePath, entry, command.emit.json),
      };
    }

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

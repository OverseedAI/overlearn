import { readFileSync, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import demos from "../../instructions/demos.md" with { type: "text" };
import grading from "../../instructions/grading.md" with { type: "text" };
import pedagogy from "../../instructions/pedagogy.md" with { type: "text" };
import protocol from "../../instructions/protocol.md" with { type: "text" };

type Env = Readonly<Record<string, string | undefined>>;

export type InstructionModuleSource = "builtin" | "user" | "course";
export type InstructionModulePrecedence = "user-first" | "course-first";

export type InstructionModuleResolution = Readonly<{
  source: InstructionModuleSource;
  content: string;
  path?: string;
}>;

export type AssembledInstructionModule = InstructionModuleResolution &
  Readonly<{
    name: InstructionModuleName;
  }>;

export type ResolveModuleOptions = Readonly<{
  courseDir?: string;
  env?: Env;
}>;

export type EjectInstructionModulesOptions = Readonly<{
  toDir?: string;
  force?: boolean;
  env?: Env;
}>;

export type EjectedInstructionModule = Readonly<{
  name: InstructionModuleName;
  path: string;
  status: "written" | "skipped" | "overwritten";
}>;

const builtinModules = {
  pedagogy,
  protocol,
  demos,
  grading,
} as const;

export type InstructionModuleName = keyof typeof builtinModules;

export const BUILTIN_MODULE_NAMES: readonly InstructionModuleName[] = [
  "pedagogy",
  "protocol",
  "demos",
  "grading",
];

export const stylePrecedence: Readonly<
  Record<InstructionModuleName, InstructionModulePrecedence>
> = {
  pedagogy: "user-first",
  protocol: "course-first",
  demos: "user-first",
  grading: "course-first",
};

const isInstructionModuleName = (
  name: string,
): name is InstructionModuleName => Object.hasOwn(builtinModules, name);

const trimModule = (content: string): string => content.trimEnd();

const hasErrorCode = (error: unknown, code: string): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error["code"] === code;

export const getOverlearnHome = (env: Env = process.env): string =>
  resolve(env["OVERLEARN_HOME"] ?? join(homedir(), ".overlearn"));

export const getUserInstructionDir = (env: Env = process.env): string =>
  join(getOverlearnHome(env), "instructions");

const moduleFileName = (name: InstructionModuleName): string => `${name}.md`;

const readModuleFile = (
  source: Exclude<InstructionModuleSource, "builtin">,
  path: string,
): InstructionModuleResolution | undefined => {
  try {
    if (!statSync(path).isFile()) {
      return undefined;
    }
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return undefined;
    }

    throw error;
  }

  return {
    source,
    path,
    content: trimModule(readFileSync(path, "utf8")),
  };
};

const builtinModule = (name: InstructionModuleName): InstructionModuleResolution => ({
  source: "builtin",
  content: trimModule(builtinModules[name]),
});

const resolveLayeredModule = (
  name: InstructionModuleName,
  options: ResolveModuleOptions,
): InstructionModuleResolution => {
  const userModule = readModuleFile(
    "user",
    join(getUserInstructionDir(options.env), moduleFileName(name)),
  );
  const courseModule =
    options.courseDir === undefined
      ? undefined
      : readModuleFile(
          "course",
          join(resolve(options.courseDir), "instructions", moduleFileName(name)),
        );

  if (userModule !== undefined && courseModule !== undefined) {
    return stylePrecedence[name] === "user-first" ? userModule : courseModule;
  }

  return courseModule ?? userModule ?? builtinModule(name);
};

export const resolveModule = (
  name: string,
  options: ResolveModuleOptions = {},
): InstructionModuleResolution => {
  if (!isInstructionModuleName(name)) {
    throw new Error(`Unknown instruction module: ${name}`);
  }

  return resolveLayeredModule(name, options);
};

export const assembleInstructionModules =
  (options: ResolveModuleOptions = {}): readonly AssembledInstructionModule[] =>
    BUILTIN_MODULE_NAMES.map((name) => ({
      name,
      ...resolveModule(name, options),
    }));

const sourceLabel = (source: InstructionModuleSource): string => {
  if (source === "user") {
    return "user override";
  }

  if (source === "course") {
    return "course override";
  }

  return "builtin";
};

export const formatInstructions = (
  modules: readonly AssembledInstructionModule[] = assembleInstructionModules(),
): string =>
  modules
    .map(
      (module) =>
        `## module: ${module.name} (${sourceLabel(module.source)})\n\n${module.content}`,
    )
    .join("\n\n");

export const formatInstructionsJson = (
  modules: readonly AssembledInstructionModule[] = assembleInstructionModules(),
): string =>
  JSON.stringify({
    modules: modules.map((module) => ({
      name: module.name,
      source: module.source,
      path: module.path ?? null,
      content: module.content,
    })),
    text: formatInstructions(modules),
  });

export const ejectInstructionModules = async (
  options: EjectInstructionModulesOptions = {},
): Promise<readonly EjectedInstructionModule[]> => {
  const targetDir = resolve(options.toDir ?? getUserInstructionDir(options.env));
  const force = options.force ?? false;

  await mkdir(targetDir, { recursive: true });

  const results: EjectedInstructionModule[] = [];
  for (const name of BUILTIN_MODULE_NAMES) {
    const path = join(targetDir, moduleFileName(name));
    const exists = await Bun.file(path).exists();

    if (exists && !force) {
      results.push({ name, path, status: "skipped" });
      continue;
    }

    await Bun.write(path, `${trimModule(builtinModules[name])}\n`);
    results.push({
      name,
      path,
      status: exists ? "overwritten" : "written",
    });
  }

  return results;
};

export const formatEjectInstructionModules = (
  modules: readonly EjectedInstructionModule[],
): string => {
  const lines = modules.map((module) => {
    if (module.status === "skipped") {
      return `skipped ${module.name}: ${module.path} already exists; use --force to overwrite`;
    }

    if (module.status === "overwritten") {
      return `overwrote ${module.name}: ${module.path} from builtin`;
    }

    return `wrote ${module.name}: ${module.path} from builtin`;
  });

  return [...lines, "edit these to customize; delete to revert to builtin"].join(
    "\n",
  );
};

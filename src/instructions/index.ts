import demos from "../../instructions/demos.md" with { type: "text" };
import grading from "../../instructions/grading.md" with { type: "text" };
import pedagogy from "../../instructions/pedagogy.md" with { type: "text" };
import protocol from "../../instructions/protocol.md" with { type: "text" };

export type InstructionModuleSource = "builtin";

export type InstructionModuleResolution = Readonly<{
  source: InstructionModuleSource;
  content: string;
}>;

export type AssembledInstructionModule = InstructionModuleResolution &
  Readonly<{
    name: InstructionModuleName;
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

const isInstructionModuleName = (
  name: string,
): name is InstructionModuleName => Object.hasOwn(builtinModules, name);

const trimModule = (content: string): string => content.trimEnd();

export const resolveModule = (name: string): InstructionModuleResolution => {
  if (!isInstructionModuleName(name)) {
    throw new Error(`Unknown instruction module: ${name}`);
  }

  return {
    source: "builtin",
    content: trimModule(builtinModules[name]),
  };
};

export const assembleInstructionModules =
  (): readonly AssembledInstructionModule[] =>
    BUILTIN_MODULE_NAMES.map((name) => ({
      name,
      ...resolveModule(name),
    }));

export const formatInstructions = (
  modules: readonly AssembledInstructionModule[] = assembleInstructionModules(),
): string =>
  modules
    .map((module) => `## module: ${module.name}\n\n${module.content}`)
    .join("\n\n");

export const formatInstructionsJson = (
  modules: readonly AssembledInstructionModule[] = assembleInstructionModules(),
): string =>
  JSON.stringify({
    modules,
    text: formatInstructions(modules),
  });

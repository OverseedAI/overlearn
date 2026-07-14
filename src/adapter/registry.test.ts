import { describe, expect, test } from "bun:test";

import {
  getHarnessAdapterDefinition,
  harnessAgentSpawnOverride,
  resolveHarnessAgentSelection,
} from "./registry";

describe("harness agent configuration", () => {
  test("pins app-managed bridges separately from harness install guidance", () => {
    expect(getHarnessAdapterDefinition("claude-code")).toMatchObject({
      managedBridge: {
        package: "@agentclientprotocol/claude-agent-acp",
        version: "0.55.0",
        bin: "claude-agent-acp",
      },
      install: { args: ["install", "-g", "@anthropic-ai/claude-code"] },
    });
    expect(getHarnessAdapterDefinition("codex")).toMatchObject({
      managedBridge: {
        package: "@agentclientprotocol/codex-acp",
        version: "1.1.0",
        bin: "codex-acp",
      },
      install: { args: ["install", "-g", "@openai/codex"] },
    });
    expect(getHarnessAdapterDefinition("gemini")?.managedBridge).toBeUndefined();
  });

  test("keeps selectable values centralized in harness capabilities", () => {
    expect(getHarnessAdapterDefinition("codex")?.capabilities).toEqual({
      models: [
        { id: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
        { id: "gpt-5.6-luna", label: "GPT-5.6 Luna" },
        { id: "gpt-5.6-terra", label: "GPT-5.6 Terra" },
        { id: "gpt-5.5", label: "GPT-5.5" },
        { id: "gpt-5.4", label: "GPT-5.4" },
        { id: "gpt-5.4-mini", label: "GPT-5.4 Mini" },
      ],
      efforts: ["low", "medium", "high"],
      defaultModel: "gpt-5.6-sol",
      defaultEffort: "medium",
      customModels: true,
    });
    expect(getHarnessAdapterDefinition("gemini")?.capabilities).toEqual({});
  });

  test("passes custom model ids through for harnesses that allow them", () => {
    expect(
      resolveHarnessAgentSelection("codex", {
        model: "gpt-6-experimental",
        effort: "high",
      }),
    ).toEqual({ model: "gpt-6-experimental", effort: "high" });
    expect(
      harnessAgentSpawnOverride("claude-code", {
        model: "claude-fable-5",
      }).env,
    ).toEqual({ ANTHROPIC_MODEL: "claude-fable-5" });
    expect(resolveHarnessAgentSelection("codex", { model: "   " })).toEqual({
      model: "gpt-5.6-sol",
      effort: "medium",
    });
  });

  test("constructs Codex ACP with selected model and effort in spawn env", () => {
    const override = harnessAgentSpawnOverride(
      "codex",
      { model: "gpt-5.5", effort: "high" },
      { CODEX_CONFIG: '{"sandbox_mode":"workspace-write"}' },
    );

    expect(JSON.parse(override.env?.["CODEX_CONFIG"] ?? "{}")).toEqual({
      sandbox_mode: "workspace-write",
      model: "gpt-5.5",
      model_reasoning_effort: "high",
    });
  });

  test("constructs Claude ACP with its selected model in spawn env", () => {
    expect(
      harnessAgentSpawnOverride("claude-code", {
        model: "claude-opus-4-8",
      }).env,
    ).toEqual({ ANTHROPIC_MODEL: "claude-opus-4-8" });
  });

  test("falls back safely and emits no overrides for unsupported harnesses", () => {
    expect(harnessAgentSpawnOverride("codex", {})).toEqual({});
    expect(
      resolveHarnessAgentSelection("gemini", {
        model: "unknown",
        effort: "high",
      }),
    ).toEqual({});
    expect(
      harnessAgentSpawnOverride("gemini", {
        model: "unknown",
        effort: "high",
      }),
    ).toEqual({});
  });
});

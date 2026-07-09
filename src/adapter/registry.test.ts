import { describe, expect, test } from "bun:test";

import {
  getHarnessAdapterDefinition,
  harnessAgentSpawnOverride,
  resolveHarnessAgentSelection,
} from "./registry";

describe("harness agent configuration", () => {
  test("keeps selectable values centralized in harness capabilities", () => {
    expect(getHarnessAdapterDefinition("codex")?.capabilities).toEqual({
      models: [
        { id: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
        { id: "gpt-5.5", label: "GPT-5.5" },
      ],
      efforts: ["low", "medium", "high"],
      defaultModel: "gpt-5.6-sol",
      defaultEffort: "medium",
    });
    expect(getHarnessAdapterDefinition("gemini")?.capabilities).toEqual({});
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

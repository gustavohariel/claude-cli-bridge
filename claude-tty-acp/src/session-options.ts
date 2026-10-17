import type { ModelInfo, SessionConfigOption, SessionConfigSelectOption, SessionModeState, SessionModelState } from "@agentclientprotocol/sdk";
import { AUTO_ACCEPT_CONFIG_ID } from "./auto-accept.ts";

// Paseo reads a literal "default" model id as "no model selected" and then refuses to list a draft agent's commands.
export const INHERIT_MODEL_ID = "inherit";
export const INHERIT_EFFORT_ID = "inherit";

export const MODEL_CONFIG_ID = "model";
export const EFFORT_CONFIG_ID = "effort";

export const MODELS: ModelInfo[] = [
  { modelId: INHERIT_MODEL_ID, name: "Default", description: "Use Claude Code's configured default model" },
  { modelId: "opus", name: "Opus (latest)", description: "Claude Code's rolling Opus alias" },
  { modelId: "fable", name: "Fable (latest)", description: "Claude Code's rolling Fable alias" },
  { modelId: "sonnet", name: "Sonnet (latest)", description: "Claude Code's rolling Sonnet alias" },
  { modelId: "haiku", name: "Haiku (latest)", description: "Claude Code's rolling Haiku alias" },
  { modelId: "claude-opus-5-5", name: "Opus 5.5", description: "Latest release" },
  { modelId: "claude-opus-5", name: "Opus 5", description: "Previous release" },
  { modelId: "claude-fable-5", name: "Fable 5", description: "Most powerful model" },
  { modelId: "claude-opus-4-8[1m]", name: "Opus 4.8 1M", description: "Opus 4.8 with 1M context window" },
  { modelId: "claude-opus-4-8", name: "Opus 4.8", description: "Previous release" },
  { modelId: "claude-sonnet-5-5", name: "Sonnet 5.5", description: "Best for everyday tasks" },
  { modelId: "claude-sonnet-5-5[1m]", name: "Sonnet 5.5 1M", description: "Sonnet 5.5 with 1M context window" },
  { modelId: "claude-sonnet-5", name: "Sonnet 5", description: "Previous release" },
  { modelId: "claude-sonnet-5[1m]", name: "Sonnet 5 1M", description: "Sonnet 5 with 1M context window" },
  { modelId: "claude-opus-4-7[1m]", name: "Opus 4.7 1M", description: "Opus 4.7 with 1M context window" },
  { modelId: "claude-opus-4-7", name: "Opus 4.7", description: "Previous release" },
  { modelId: "claude-opus-4-6[1m]", name: "Opus 4.6 1M", description: "Opus 4.6 with 1M context window" },
  { modelId: "claude-opus-4-6", name: "Opus 4.6", description: "Most capable for complex work" },
  { modelId: "claude-sonnet-4-6[1m]", name: "Sonnet 4.6 1M", description: "Sonnet 4.6 with 1M context window" },
  { modelId: "claude-sonnet-4-6", name: "Sonnet 4.6", description: "Best for everyday tasks" },
  { modelId: "claude-haiku-4-5", name: "Haiku 4.5", description: "Fastest for quick answers" },
];

/** Claude Code's own `--effort` levels, ahead of the one that passes no flag at all. */
export const EFFORTS: SessionConfigSelectOption[] = [
  { value: INHERIT_EFFORT_ID, name: "Default", description: "Use Claude Code's configured default effort" },
  { value: "low", name: "Low", description: "Answer with as little reasoning as the task allows" },
  { value: "medium", name: "Medium", description: "Claude Code's own balance of reasoning against speed" },
  { value: "high", name: "High", description: "Reason at length before answering" },
  { value: "xhigh", name: "Extra high", description: "Reason further still, at the cost of speed" },
  { value: "max", name: "Max", description: "As much reasoning as the model will do" },
];

export const MODEL_IDS = MODELS.map((model) => model.modelId);
export const EFFORT_IDS = EFFORTS.map((effort) => effort.value);
export const MODE_IDS = ["default", "acceptEdits", "plan", "auto", "bypassPermissions"] as const;

export type ModeId = (typeof MODE_IDS)[number];

export function modelState(currentModelId: string): SessionModelState {
  return {
    currentModelId,
    availableModels: MODELS,
  };
}

export function modeState(currentModeId: string): SessionModeState {
  return {
    currentModeId,
    availableModes: [
      { id: "default", name: "Default", description: "Ask before edits and commands according to Claude settings" },
      { id: "acceptEdits", name: "Accept Edits", description: "Automatically accept file edits" },
      { id: "plan", name: "Plan", description: "Explore and plan without making changes" },
      { id: "auto", name: "Auto", description: "Let Claude Code handle permissions automatically" },
      { id: "bypassPermissions", name: "Bypass Permissions", description: "Never ask - for unattended agents" },
    ],
  };
}

/**
 * The same two selectors in ACP's newer vocabulary, which is the only one that carries an effort level.
 * Paseo's plugin ACP bridge builds both of its pickers from here and reads `models` not at all; the daemon's
 * own bridge still prefers `models` for the model list and takes the thought levels only from here.
 * So a session publishes both, and the model values are the `modelId`s verbatim because the daemon falls
 * back to this option when `session/set_model` fails and matches the choice by value.
 *
 * Auto Accept rides beside them as a boolean, which the plugin bridge turns into an agent toggle. Neither
 * Paseo bridge advertises boolean options at initialize, but the plugin bridge reads and sets them, and the
 * daemon's own ignores options it was not configured to map.
 */
export function configOptions(currentModelId: string, currentEffortId: string, autoAccept: boolean): SessionConfigOption[] {
  return [
    {
      id: MODEL_CONFIG_ID,
      name: "Model",
      category: "model",
      type: "select",
      currentValue: currentModelId,
      options: MODELS.map((model) => ({ value: model.modelId, name: model.name, description: model.description })),
    },
    {
      id: EFFORT_CONFIG_ID,
      name: "Effort",
      description: "How much reasoning Claude Code puts into a turn",
      category: "thought_level",
      type: "select",
      currentValue: currentEffortId,
      options: EFFORTS,
    },
    {
      id: AUTO_ACCEPT_CONFIG_ID,
      name: "Auto Accept",
      description: "Approve Claude Code's permission prompts without showing a card. Questions and plans still ask.",
      type: "boolean",
      currentValue: autoAccept,
    },
  ];
}

export function migrateModelId(value: string): string {
  return value === "default" ? INHERIT_MODEL_ID : value;
}

export function assertModelId(value: string): void {
  if (!MODEL_IDS.includes(value)) throw new Error(`Unsupported Claude model ${value}`);
}

export function assertEffortId(value: string): void {
  if (!EFFORT_IDS.includes(value)) throw new Error(`Unsupported Claude effort level ${value}`);
}

/** An effort level a persisted session names but this build does not offer, read the way an unoffered mode is. */
export function offeredEffortId(value: string | undefined): string {
  return value !== undefined && EFFORT_IDS.includes(value) ? value : INHERIT_EFFORT_ID;
}

/**
 * A mode a persisted session names but this build does not offer — an adapter rolled back past the release that added it, most likely.
 * The session opens in the mode that asks about everything rather than not opening at all, which is the safe direction to be wrong in.
 */
export function offeredModeId(value: string): ModeId {
  return (MODE_IDS as readonly string[]).includes(value) ? (value as ModeId) : "default";
}

export function assertModeId(value: string): asserts value is ModeId {
  if (!(MODE_IDS as readonly string[]).includes(value)) throw new Error(`Unsupported Claude mode ${value}`);
}

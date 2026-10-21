import type { ModelInfo } from "./protocol.ts";

/** What a session runs with when nothing chose a model or an effort: no flag, so Claude Code's own configured default. */
export const INHERIT_MODEL_ID = "inherit";
export const INHERIT_EFFORT_ID = "inherit";

/** Display names for the model ids Claude Code takes, which the transcript translator reports a session's model by. */
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

/**
 * The shapes the runtime reports through: what Claude did (session updates), what it asks (permission
 * requests), and how a prompt ended. The bridge receives them in `src/bridge.mjs` and turns what it needs
 * into Agent SDK messages. They keep the field names of the Agent Client Protocol the runtime was first
 * written against, so the translation code reads the same as it did there.
 */

export type ContentBlock =
  | { type: "text"; text: string; annotations?: unknown }
  | { type: "image"; data: string; mimeType: string; uri?: string | null; annotations?: unknown }
  | { type: "audio"; data: string; mimeType: string; annotations?: unknown }
  | {
      type: "resource_link";
      uri: string;
      name: string;
      title?: string | null;
      description?: string | null;
      mimeType?: string | null;
      size?: number | null;
      annotations?: unknown;
    }
  | {
      type: "resource";
      resource: { uri: string; mimeType?: string | null } & ({ text: string } | { blob: string });
      annotations?: unknown;
    };

export type ToolKind = "read" | "edit" | "delete" | "move" | "search" | "execute" | "think" | "fetch" | "switch_mode" | "other";

export type ToolCallStatus = "pending" | "in_progress" | "completed" | "failed";

export type ToolCallLocation = { path: string; line?: number | null };

export type ToolCallContent =
  | { type: "content"; content: ContentBlock }
  | { type: "diff"; path: string; oldText?: string | null; newText: string }
  | { type: "terminal"; terminalId: string };

export type ToolCallUpdate = {
  toolCallId: string;
  title?: string | null;
  kind?: ToolKind | null;
  status?: ToolCallStatus | null;
  content?: ToolCallContent[] | null;
  locations?: ToolCallLocation[] | null;
  rawInput?: unknown;
  rawOutput?: unknown;
  _meta?: Record<string, unknown> | null;
};

export type PlanEntry = { content: string; priority: "high" | "medium" | "low"; status: "pending" | "in_progress" | "completed" };

export type AvailableCommand = { name: string; description: string; input?: { hint: string } | null };

export type ModelInfo = { modelId: string; name: string; description?: string | null };

export type SessionModelState = { availableModels: ModelInfo[]; currentModelId: string };

export type SessionModeState = { availableModes: { id: string; name: string; description?: string | null }[]; currentModeId: string };

export type SessionConfigSelectOption = { value: string; name: string; description?: string | null };

export type SessionConfigOption = {
  id: string;
  name: string;
  description?: string | null;
  category?: string | null;
} & (
  | { type: "select"; currentValue: string; options: SessionConfigSelectOption[] }
  | { type: "boolean"; currentValue: boolean }
);

export type SessionUpdate = { _meta?: Record<string, unknown> | null } & (
  | { sessionUpdate: "user_message_chunk" | "agent_message_chunk" | "agent_thought_chunk"; content: ContentBlock; messageId?: string | null }
  | ({ sessionUpdate: "tool_call"; title: string } & Omit<ToolCallUpdate, "title">)
  | ({ sessionUpdate: "tool_call_update" } & ToolCallUpdate)
  | { sessionUpdate: "plan"; entries: PlanEntry[] }
  | { sessionUpdate: "available_commands_update"; availableCommands: AvailableCommand[] }
  | { sessionUpdate: "current_mode_update"; currentModeId: string }
  | { sessionUpdate: "config_option_update"; configOptions: SessionConfigOption[] }
  | { sessionUpdate: "usage_update"; used: number; size: number; cost?: unknown }
  | { sessionUpdate: "session_info_update"; title?: string | null; updatedAt?: string | null }
);

export type SessionNotification = { sessionId: string; update: SessionUpdate };

export type PermissionOption = { optionId: string; name: string; kind: "allow_once" | "allow_always" | "reject_once" | "reject_always" };

export type RequestPermissionRequest = { sessionId: string; toolCall: ToolCallUpdate; options: PermissionOption[] };

export type RequestPermissionResponse = { outcome: { outcome: "cancelled" } | { outcome: "selected"; optionId: string } };

export type PromptResponse = { stopReason: "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled"; usage?: unknown };

/** Where the runtime sends what it reports. The bridge passes one in. */
export type AgentSideConnection = {
  sessionUpdate(params: SessionNotification): Promise<void>;
  requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse>;
  extNotification(method: string, params: Record<string, unknown>): Promise<void>;
};

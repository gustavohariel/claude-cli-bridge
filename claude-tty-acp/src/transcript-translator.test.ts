import assert from "node:assert/strict";
import { appendFile, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { AgentSideConnection, SessionNotification } from "@agentclientprotocol/sdk";
import { BACKGROUND_COMMAND_META, type ModelFallback, TOOL_CALL_MIRROR_METHOD, TranscriptTranslator } from "./transcript-translator.ts";

/**
 * `switchModelsOnFlag` lets Claude retry a message its model's safeguards flagged on a fallback model,
 * and this record is the only account of it. The shape is copied from a real one, written on
 * 2026-09-11 into `~/.claude/projects/-home-kobe-dotfiles/8b06973d-....jsonl`.
 */
function modelFallbackRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "system",
    uuid: "system-fallback-1",
    subtype: "model_refusal_fallback",
    level: "warning",
    content: "Fable 5's safeguards flagged this message, so it was retried on Opus 4.8.",
    direction: "retry",
    scope: "session",
    originalModel: "claude-fable-5",
    fallbackModel: "claude-opus-4-8",
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

test("hands a model Claude switched under a live session to the runtime, rather than to the conversation", async () => {
  const notifications: SessionNotification[] = [];
  const connection = {
    sessionUpdate: async (notification: SessionNotification) => {
      notifications.push(notification);
    },
    extNotification: async () => undefined,
  } as unknown as AgentSideConnection;
  const translator = new TranscriptTranslator("session", "/work/repo", connection);
  const fallbacks: ModelFallback[] = [];
  translator.setModelFallbackHandler((fallback) => fallbacks.push(fallback));

  await translator.translate([modelFallbackRecord()]);

  assert.equal(fallbacks.length, 1);
  assert.equal(fallbacks[0]!.title, "Model switched: Fable 5 → Opus 4.8");
  // Claude's own sentence, which is what the notice carries; the names are Paseo's for the same models.
  assert.equal(fallbacks[0]!.description, "Fable 5's safeguards flagged this message, so it was retried on Opus 4.8.");
  // Session-scoped, so it is what the session is on from here and worth showing in the picker.
  assert.equal(fallbacks[0]!.model, "claude-opus-4-8");
  // And it is not also said in the conversation: the notice carries the same sentence, and once is enough.
  assert.equal(notifications.length, 0);

  // Reading the record again -- which a compaction makes the watcher do -- is the same switch.
  await translator.translate([modelFallbackRecord()]);
  assert.equal(fallbacks.length, 1);
  assert.equal(notifications.length, 0);
});

test("reads a model switch out of history as the line in the conversation it has always been", async () => {
  const notifications: SessionNotification[] = [];
  const connection = {
    sessionUpdate: async (notification: SessionNotification) => {
      notifications.push(notification);
    },
    extNotification: async () => undefined,
  } as unknown as AgentSideConnection;
  const translator = new TranscriptTranslator("session", "/work/repo", connection);
  const fallbacks: ModelFallback[] = [];
  translator.setModelFallbackHandler((fallback) => fallbacks.push(fallback));

  // A session being loaded replays its whole transcript: everything in it happened before this
  // translator existed, and a card or a push for a switch from last week is noise.
  await translator.translate([modelFallbackRecord({ timestamp: "2026-09-11T18:22:04.000Z" })]);
  // A record with no timestamp at all reads as history for the same reason.
  await translator.translate([modelFallbackRecord({ uuid: "system-fallback-2", timestamp: undefined })]);

  assert.deepEqual(fallbacks, []);
  assert.equal(notifications.length, 2);
  assert.equal(
    (notifications[0]!.update as { content: { text: string } }).content.text,
    "Fable 5's safeguards flagged this message, so it was retried on Opus 4.8.",
  );
});

test("reads what a switch says about the model the session is on, and says nothing where it says nothing", async () => {
  const connection = { sessionUpdate: async () => undefined, extNotification: async () => undefined } as unknown as AgentSideConnection;
  const translator = new TranscriptTranslator("session", "/work/repo", connection);
  const fallbacks: ModelFallback[] = [];
  translator.setModelFallbackHandler((fallback) => fallbacks.push(fallback));

  await translator.translate([
    // A switch Claude made for one message says nothing about what the session is on.
    modelFallbackRecord({ uuid: "one", scope: "local" }),
    // A revert puts back the model the session was launched with.
    modelFallbackRecord({ uuid: "two", direction: "revert" }),
    // A model this build has no name for is named the way Claude named it.
    modelFallbackRecord({ uuid: "three", originalModel: "claude-something-9", fallbackModel: "claude-something-8" }),
    // And the two other subtypes Claude writes for the same thing are read the same way.
    modelFallbackRecord({ uuid: "four", subtype: "model_fallback", trigger: "model_not_found" }),
    modelFallbackRecord({ uuid: "five", subtype: "model_consent_fallback", choice: "switch", persistedAsDefault: false }),
  ]);

  assert.deepEqual(
    fallbacks.map((fallback) => [fallback.subtype, fallback.title, fallback.model]),
    [
      ["model_refusal_fallback", "Model switched: Fable 5 → Opus 4.8", null],
      ["model_refusal_fallback", "Model switched back to Fable 5", "claude-fable-5"],
      ["model_refusal_fallback", "Model switched: claude-something-9 → claude-something-8", "claude-something-8"],
      ["model_fallback", "Model switched: Fable 5 → Opus 4.8", "claude-opus-4-8"],
      ["model_consent_fallback", "Model switched: Fable 5 → Opus 4.8", "claude-opus-4-8"],
    ],
  );
});

test("translates messages, reasoning, tools, plans, usage, images, and system activity", async () => {
  const notifications: SessionNotification[] = [];
  const connection = {
    sessionUpdate: async (notification: SessionNotification) => {
      notifications.push(notification);
    },
    extNotification: async () => undefined,
  } as unknown as AgentSideConnection;
  const translator = new TranscriptTranslator("session", "/work/repo", connection);
  const records = [
    {
      type: "user",
      uuid: "user-1",
      message: { content: "hello<system-reminder>hidden</system-reminder>" },
    },
    {
      type: "assistant",
      uuid: "assistant-1",
      requestId: "request-1",
      context_window: 200_000,
      message: {
        usage: { input_tokens: 100, cache_read_input_tokens: 50 },
        content: [
          { type: "thinking", thinking: "considering" },
          { type: "text", text: "working" },
          { type: "tool_use", id: "edit-1", name: "Edit", input: { file_path: "src/app.ts", old_string: "a", new_string: "b" } },
          {
            type: "tool_use",
            id: "todo-1",
            name: "TodoWrite",
            input: { todos: [{ content: "Implement", status: "in_progress" }, { content: "Verify", status: "pending" }] },
          },
        ],
      },
    },
    {
      type: "user",
      uuid: "result-1",
      message: { content: [{ type: "tool_result", tool_use_id: "edit-1", content: [{ type: "text", text: "updated" }] }] },
    },
    {
      type: "assistant",
      uuid: "assistant-image",
      message: { content: [{ type: "image", source: { data: "aW1hZ2U=", media_type: "image/png" } }] },
    },
    { type: "system", uuid: "system-1", subtype: "api_error", content: "Transient API error" },
  ];

  await translator.translate(records);
  await translator.translate(records);

  assert.deepEqual(
    notifications.map((notification) => notification.update.sessionUpdate),
    ["user_message_chunk", "agent_thought_chunk", "agent_message_chunk", "tool_call", "plan", "usage_update", "tool_call_update", "agent_message_chunk", "agent_message_chunk"],
  );
  const tool = notifications.find((notification) => notification.update.sessionUpdate === "tool_call")?.update;
  assert.ok(tool?.sessionUpdate === "tool_call");
  assert.equal(tool.kind, "edit");
  assert.deepEqual(tool.locations, [{ path: "/work/repo/src/app.ts" }]);
  assert.deepEqual(tool.content, [{ type: "diff", path: "/work/repo/src/app.ts", oldText: "a", newText: "b" }]);
  const plan = notifications.find((notification) => notification.update.sessionUpdate === "plan")?.update;
  assert.ok(plan?.sessionUpdate === "plan");
  assert.deepEqual(plan.entries.map((entry) => entry.status), ["in_progress", "pending"]);
  const usage = notifications.find((notification) => notification.update.sessionUpdate === "usage_update")?.update;
  assert.deepEqual(usage, { sessionUpdate: "usage_update", size: 200_000, used: 150 });
  const chunks = notifications.filter((notification) => notification.update.sessionUpdate.endsWith("message_chunk"));
  assert.ok(chunks.every((notification) => "messageId" in notification.update && /^[0-9a-f-]{36}$/.test(String(notification.update.messageId))));
  assert.equal(translator.assistantChunks, 3);
});

test("suppresses a transcript answer already emitted from the Stop fallback", async () => {
  const notifications: SessionNotification[] = [];
  const connection = {
    sessionUpdate: async (notification: SessionNotification) => {
      notifications.push(notification);
    },
    extNotification: async () => undefined,
  } as unknown as AgentSideConnection;
  const translator = new TranscriptTranslator("session", "/work/repo", connection);

  translator.suppressNextAssistantText("Hello from Claude");
  await translator.translate([
    { type: "assistant", uuid: "late-answer", message: { content: [{ type: "text", text: "Hello from Claude" }] } },
  ]);
  assert.equal(notifications.length, 0);

  await translator.translate([{ type: "user", uuid: "next-user", message: { content: "next" } }]);
  await translator.translate([
    { type: "assistant", uuid: "next-answer", message: { content: [{ type: "text", text: "Hello from Claude" }] } },
  ]);
  assert.deepEqual(notifications.map((notification) => notification.update.sessionUpdate), ["user_message_chunk", "agent_message_chunk"]);
});

test("renders question tool calls as readable text instead of raw JSON", async () => {
  const notifications: SessionNotification[] = [];
  const connection = {
    sessionUpdate: async (notification: SessionNotification) => {
      notifications.push(notification);
    },
    extNotification: async () => undefined,
  } as unknown as AgentSideConnection;
  const translator = new TranscriptTranslator("session", "/work/repo", connection);
  const input = {
    questions: [
      {
        question: "Choose runtime",
        header: "Runtime",
        options: [
          { label: "Node", description: "Use the established runtime" },
          { label: "Bun", description: "Use the faster alternative" },
        ],
        multiSelect: false,
      },
    ],
  };

  await translator.translate([
    {
      type: "assistant",
      uuid: "question-message",
      message: { content: [{ type: "tool_use", id: "question-tool", name: "AskUserQuestion", input }] },
    },
  ]);

  assert.equal(notifications.length, 1);
  const update = notifications[0]?.update;
  assert.ok(update?.sessionUpdate === "tool_call");
  assert.deepEqual(update.rawInput, input);
  assert.deepEqual(update.content, [
    {
      type: "content",
      content: {
        type: "text",
        text: "Choose runtime\n\n- Node — Use the established runtime\n- Bun — Use the faster alternative",
      },
    },
  ]);
});

test("keeps an asynchronous agent's tool call open and streams the work it does", async () => {
  const notifications: SessionNotification[] = [];
  const connection = {
    sessionUpdate: async (notification: SessionNotification) => {
      notifications.push(notification);
    },
    extNotification: async () => undefined,
  } as unknown as AgentSideConnection;
  const translator = new TranscriptTranslator("session", "/work/repo", connection);

  await translator.translate([
    {
      type: "assistant",
      uuid: "launcher",
      message: {
        content: [{ type: "tool_use", id: "agent-tool", name: "Agent", input: { description: "Audit the API", subagent_type: "general-purpose" } }],
      },
    },
    {
      type: "user",
      uuid: "launched",
      toolUseResult: { isAsync: true, status: "async_launched", agentId: "a1", description: "Audit the API" },
      message: { content: [{ type: "tool_result", tool_use_id: "agent-tool", content: [{ type: "text", text: "Async agent launched successfully." }] }] },
    },
  ]);

  const launch = notifications.map((notification) => notification.update);
  assert.deepEqual(launch.map((update) => update.sessionUpdate), ["tool_call", "tool_call_update"]);
  assert.ok(launch[0]?.sessionUpdate === "tool_call");
  assert.equal(launch[0].title, "Agent: Audit the API");
  assert.equal(launch[0].status, "in_progress");
  assert.ok(launch[1]?.sessionUpdate === "tool_call_update");
  assert.equal(launch[1].status, "in_progress");

  notifications.length = 0;
  await translator.translateSubagent("a1", [
    {
      type: "assistant",
      uuid: "sub-1",
      message: {
        content: [
          { type: "thinking", thinking: "hidden" },
          { type: "text", text: "Reading the controllers" },
          { type: "tool_use", id: "sub-read", name: "Read", input: { file_path: "src/app.ts" } },
        ],
      },
    },
  ]);

  assert.equal(notifications.length, 1);
  const streamed = notifications[0]?.update;
  assert.ok(streamed?.sessionUpdate === "tool_call_update");
  assert.equal(streamed.toolCallId, "agent-tool");
  assert.equal(streamed.status, "in_progress");
  assert.deepEqual(streamed.content, [
    { type: "content", content: { type: "text", text: "Reading the controllers\n• Read: src/app.ts" } },
  ]);

  notifications.length = 0;
  const notification =
    "<task-notification> <task-id>a1</task-id> <tool-use-id>agent-tool</tool-use-id> <status>completed</status> <summary>Agent \"Audit the API\" finished</summary> </task-notification>";
  await translator.translate([{ type: "user", uuid: "notified", message: { content: notification } }]);
  await translator.translate([{ type: "user", uuid: "notified", message: { content: notification } }]);

  assert.equal(notifications.length, 1);
  const finished = notifications[0]?.update;
  assert.ok(finished?.sessionUpdate === "tool_call_update");
  assert.equal(finished.status, "completed");
  assert.deepEqual(finished.content, [
    {
      type: "content",
      content: { type: "text", text: 'Reading the controllers\n• Read: src/app.ts\nAgent "Audit the API" finished' },
    },
  ]);
});

test("shows a subagent's steps that arrived before its launch was read, and its nested agents", async () => {
  const notifications: SessionNotification[] = [];
  const connection = {
    sessionUpdate: async (notification: SessionNotification) => {
      notifications.push(notification);
    },
    extNotification: async () => undefined,
  } as unknown as AgentSideConnection;
  const translator = new TranscriptTranslator("session", "/work/repo", connection);

  await translator.translateSubagent("a1", [
    { type: "assistant", uuid: "early", message: { content: [{ type: "text", text: "Started early" }] } },
  ]);
  assert.equal(notifications.length, 0);

  await translator.translate([
    {
      type: "assistant",
      uuid: "launcher",
      message: { content: [{ type: "tool_use", id: "agent-tool", name: "Task", input: { description: "Search" } }] },
    },
    {
      type: "user",
      uuid: "finished",
      toolUseResult: { status: "completed", agentId: "a1" },
      message: { content: [{ type: "tool_result", tool_use_id: "agent-tool", content: [{ type: "text", text: "report" }] }] },
    },
  ]);

  // A synchronous agent answers when it is done, so its card is linked, filled in and then closed.
  assert.deepEqual(notifications.map((notification) => notification.update.sessionUpdate), ["tool_call", "tool_call_update", "tool_call_update"]);
  const linked = notifications[1]?.update;
  assert.ok(linked?.sessionUpdate === "tool_call_update");
  assert.deepEqual(linked.content, [{ type: "content", content: { type: "text", text: "Started early" } }]);
  const closed = notifications[2]?.update;
  assert.ok(closed?.sessionUpdate === "tool_call_update");
  assert.equal(closed.status, "completed");

  notifications.length = 0;
  await translator.translateSubagent("a1", [
    { type: "user", uuid: "nested-launch", toolUseResult: { isAsync: true, status: "async_launched", agentId: "a2" }, message: { content: [] } },
  ]);
  await translator.translateSubagent("a2", [
    { type: "assistant", uuid: "nested", message: { content: [{ type: "text", text: "Nested work" }] } },
  ]);

  assert.equal(notifications.length, 1);
  const nested = notifications[0]?.update;
  assert.ok(nested?.sessionUpdate === "tool_call_update");
  assert.equal(nested.toolCallId, "agent-tool");
  assert.deepEqual(nested.content, [{ type: "content", content: { type: "text", text: "Started early\n↳ Nested work" } }]);
});

test("carries a nested subagent's earlier steps onto the card of the agent that launched it", async () => {
  const notifications: SessionNotification[] = [];
  const connection = {
    sessionUpdate: async (notification: SessionNotification) => {
      notifications.push(notification);
    },
    extNotification: async () => undefined,
  } as unknown as AgentSideConnection;
  const translator = new TranscriptTranslator("session", "/work/repo", connection);

  // Transcripts are read in name order, so a nested agent is routinely seen before its spawner.
  await translator.translateSubagent("nested", [
    { type: "assistant", uuid: "n1", message: { content: [{ type: "text", text: "Nested first step" }] } },
  ]);
  await translator.translateSubagent("spawner", [
    { type: "user", uuid: "s1", toolUseResult: { isAsync: true, status: "async_launched", agentId: "nested" }, message: { content: [] } },
    { type: "assistant", uuid: "s2", message: { content: [{ type: "text", text: "Spawner step" }] } },
  ]);
  await translator.translate([
    {
      type: "assistant",
      uuid: "launcher",
      message: { content: [{ type: "tool_use", id: "agent-tool", name: "Agent", input: { description: "Investigate" } }] },
    },
    {
      type: "user",
      uuid: "launched",
      toolUseResult: { isAsync: true, status: "async_launched", agentId: "spawner" },
      message: { content: [{ type: "tool_result", tool_use_id: "agent-tool", content: [] }] },
    },
  ]);

  const linked = notifications.at(-1)?.update;
  assert.ok(linked?.sessionUpdate === "tool_call_update");
  assert.deepEqual(linked.content, [
    { type: "content", content: { type: "text", text: "↳ Nested first step\nSpawner step" } },
  ]);

  notifications.length = 0;
  await translator.translateSubagent("nested", [
    { type: "assistant", uuid: "n2", message: { content: [{ type: "text", text: "Nested later step" }] } },
  ]);
  const streamed = notifications[0]?.update;
  assert.ok(streamed?.sessionUpdate === "tool_call_update");
  assert.equal(streamed.toolCallId, "agent-tool");
  assert.deepEqual(streamed.content, [
    { type: "content", content: { type: "text", text: "↳ Nested first step\nSpawner step\n↳ Nested later step" } },
  ]);
});

test("keeps a spawner's card working when the agent it nested reports, and closes it on its own", async () => {
  const notifications: SessionNotification[] = [];
  const connection = {
    sessionUpdate: async (notification: SessionNotification) => {
      notifications.push(notification);
    },
    extNotification: async () => undefined,
  } as unknown as AgentSideConnection;
  const translator = new TranscriptTranslator("session", "/work/repo", connection);
  // Claude writes the tool-use id of the call inside the *spawner's* transcript, which this session has never seen.
  const nested =
    '<task-notification><task-id>nested</task-id><tool-use-id>nested-call</tool-use-id><status>completed</status><summary>Agent "Review the branch" finished</summary></task-notification>';

  translator.trackBackgroundWork();
  await translator.translate([
    {
      type: "assistant",
      uuid: "launcher",
      message: { content: [{ type: "tool_use", id: "agent-tool", name: "Agent", input: { description: "Ship the MR" } }] },
    },
    {
      type: "user",
      uuid: "launched",
      toolUseResult: { isAsync: true, status: "async_launched", agentId: "spawner" },
      message: { content: [{ type: "tool_result", tool_use_id: "agent-tool", content: [] }] },
    },
  ]);
  await translator.translateSubagent("spawner", [
    { type: "assistant", uuid: "s1", message: { content: [{ type: "text", text: "Handing the diff to a reviewer" }] } },
    { type: "user", uuid: "s2", toolUseResult: { isAsync: true, status: "async_launched", agentId: "nested" }, message: { content: [] } },
  ]);
  assert.equal(translator.runningSubagents, 1);

  // A nested agent's report is delivered into this session's transcript, and resolves onto the card it shares with its spawner.
  notifications.length = 0;
  const workingAt = translator.subagentActivityAt;
  await new Promise((resolve) => setTimeout(resolve, 5));
  await translator.translate([{ type: "user", uuid: "nested-notified", message: { content: nested } }]);

  // The spawner is still working — this report is what wakes it — so the card stays open, its
  // transcript stays worth reading, and the turn goes on waiting for it.
  assert.equal(translator.runningSubagents, 1);
  assert.equal(translator.subagentSettled("spawner"), false);
  assert.ok(translator.subagentActivityAt > workingAt, "a nested report is the spawner being woken");
  assert.equal(notifications.length, 1);
  const noted = notifications[0]?.update;
  assert.ok(noted?.sessionUpdate === "tool_call_update");
  assert.equal(noted.status, "in_progress");
  assert.deepEqual(noted.content, [
    { type: "content", content: { type: "text", text: 'Handing the diff to a reviewer\n↳ Agent "Review the branch" finished' } },
  ]);

  // The queue rewrites the notification at every turn boundary it survives, and none of the repeats is a second report to stack onto the card.
  notifications.length = 0;
  await translator.translate([
    { type: "user", uuid: "nested-again", message: { content: nested } },
    { type: "attachment", uuid: "nested-queued", attachment: { type: "queued_command", commandMode: "task-notification", prompt: nested } },
  ]);
  assert.equal(notifications.length, 0);

  // The spawner's own report is the one that closes its card.
  await translator.translate([
    {
      type: "user",
      uuid: "notified",
      message: {
        content:
          '<task-notification><task-id>spawner</task-id><status>completed</status><summary>Agent "Ship the MR" finished</summary></task-notification>',
      },
    },
  ]);
  assert.equal(translator.runningSubagents, 0);
  assert.equal(translator.subagentSettled("spawner"), true);
  const closed = notifications.at(-1)?.update;
  assert.ok(closed?.sessionUpdate === "tool_call_update");
  assert.equal(closed.status, "completed");
  assert.deepEqual(closed.content, [
    {
      type: "content",
      content: {
        type: "text",
        text: 'Handing the diff to a reviewer\n↳ Agent "Review the branch" finished\nAgent "Ship the MR" finished',
      },
    },
  ]);
});

test("counts the agents a turn is still waiting on, and ignores the ones history only remembers", async () => {
  const connection = { sessionUpdate: async () => undefined, extNotification: async () => undefined } as unknown as AgentSideConnection;
  const translator = new TranscriptTranslator("session", "/work/repo", connection);
  const launch = (toolCallId: string, agentId: string, running: boolean) => [
    {
      type: "assistant",
      uuid: `launcher-${agentId}`,
      message: { content: [{ type: "tool_use", id: toolCallId, name: "Agent", input: { description: agentId } }] },
    },
    {
      type: "user",
      uuid: `launched-${agentId}`,
      toolUseResult: running ? { isAsync: true, status: "async_launched", agentId } : { status: "completed", agentId },
      message: { content: [{ type: "tool_result", tool_use_id: toolCallId, content: [] }] },
    },
  ];

  // A session being loaded replays a transcript whose agents died with the process that ran them.
  await translator.translate(launch("history-tool", "history", true));
  assert.equal(translator.runningSubagents, 0);

  translator.trackBackgroundWork();
  await translator.translate([...launch("async-tool", "async", true), ...launch("sync-tool", "sync", false)]);
  assert.equal(translator.runningSubagents, 1);

  // A nested agent is part of the one piece of work the session launched, not a second one.
  await translator.translateSubagent("async", [
    { type: "user", uuid: "nested", toolUseResult: { isAsync: true, status: "async_launched", agentId: "nested" }, message: { content: [] } },
  ]);
  assert.equal(translator.runningSubagents, 1);

  const activityBefore = translator.subagentActivityAt;
  assert.ok(activityBefore > 0);
  await translator.translate([
    {
      type: "user",
      uuid: "notified",
      message: { content: "<task-notification> <task-id>async</task-id> <status>completed</status> <summary>done</summary> </task-notification>" },
    },
  ]);
  assert.equal(translator.runningSubagents, 0);
  assert.ok(translator.subagentActivityAt >= activityBefore);
});

test("counts the background commands a turn is waiting on, and lets go of one that reports", async () => {
  const connection = { sessionUpdate: async () => undefined, extNotification: async () => undefined } as unknown as AgentSideConnection;
  const translator = new TranscriptTranslator("session", "/work/repo", connection);
  const launch = (toolCallId: string, taskId: string) => [
    {
      type: "assistant",
      uuid: `launcher-${taskId}`,
      message: {
        content: [
          { type: "tool_use", id: toolCallId, name: "Bash", input: { command: "npm test", description: "Run the tests", run_in_background: true } },
        ],
      },
    },
    {
      type: "user",
      uuid: `launched-${taskId}`,
      toolUseResult: { stdout: "", stderr: "", backgroundTaskId: taskId },
      message: { content: [{ type: "tool_result", tool_use_id: toolCallId, content: [] }] },
    },
  ];
  const report = (taskId: string) => [
    {
      type: "user",
      uuid: `notified-${taskId}`,
      message: {
        content: `<task-notification> <task-id>${taskId}</task-id> <status>completed</status> <summary>Background command "Run the tests" completed (exit code 0)</summary> </task-notification>`,
      },
    },
  ];

  // A session being loaded replays a transcript whose commands died with the process that ran them.
  await translator.translate(launch("history-tool", "history"));
  assert.equal(translator.runningBackgroundShells, 0);

  translator.trackBackgroundWork();
  await translator.translate(launch("bash-tool", "b1"));
  assert.equal(translator.runningBackgroundShells, 1);
  const startedAt = translator.backgroundShellActivityAt;
  assert.ok(startedAt > 0);

  // The report names the command by its task id, and is the only record that says it has ended.
  await translator.translate(report("b1"));
  assert.equal(translator.runningBackgroundShells, 0);
  assert.ok(translator.backgroundShellActivityAt >= startedAt);

  // A compaction rewrites the transcript, and the reader that notices replays it from the top.
  await translator.translate(launch("bash-tool", "b1"));
  assert.equal(translator.runningBackgroundShells, 0);
});

test("stops counting a background command a turn gave up on, and one whose session has stopped", async () => {
  const connection = { sessionUpdate: async () => undefined, extNotification: async () => undefined } as unknown as AgentSideConnection;
  const translator = new TranscriptTranslator("session", "/work/repo", connection);
  const launch = (toolCallId: string, taskId: string) => [
    {
      type: "assistant",
      uuid: `launcher-${taskId}`,
      message: {
        content: [{ type: "tool_use", id: toolCallId, name: "Bash", input: { command: "npm run dev", run_in_background: true } }],
      },
    },
    {
      type: "user",
      uuid: `launched-${taskId}`,
      toolUseResult: { stdout: "", stderr: "", backgroundTaskId: taskId },
      message: { content: [{ type: "tool_result", tool_use_id: toolCallId, content: [] }] },
    },
  ];

  translator.trackBackgroundWork();
  await translator.translate(launch("server-tool", "b1"));
  assert.equal(translator.runningBackgroundShells, 1);

  // A command that never reports — a server, say — is given up on once and not waited on again.
  translator.abandonBackgroundWork();
  assert.equal(translator.runningBackgroundShells, 0);
  await translator.translate(launch("server-tool", "b1"));
  assert.equal(translator.runningBackgroundShells, 0);

  // A command is a child of the Claude process, so a stop is the end of it and of the wait for it.
  await translator.translate(launch("suite-tool", "b2"));
  assert.equal(translator.runningBackgroundShells, 1);
  await translator.settleOpenToolCalls();
  assert.equal(translator.runningBackgroundShells, 0);
});

test("lets go of a background command whose report was queued because Claude was busy when it ended", async () => {
  const notifications: SessionNotification[] = [];
  const connection = {
    sessionUpdate: async (notification: SessionNotification) => {
      notifications.push(notification);
    },
    extNotification: async () => undefined,
  } as unknown as AgentSideConnection;
  const translator = new TranscriptTranslator("session", "/work/repo", connection);
  const report =
    '<task-notification><task-id>b1</task-id><tool-use-id>bash-tool</tool-use-id><status>completed</status><summary>Background command "Run the tests" completed (exit code 0)</summary></task-notification>';

  translator.trackBackgroundWork();
  await translator.translate([
    {
      type: "assistant",
      uuid: "launcher",
      message: {
        content: [
          { type: "tool_use", id: "bash-tool", name: "Bash", input: { command: "npm test", description: "Run the tests", run_in_background: true } },
        ],
      },
    },
    {
      type: "user",
      uuid: "launched",
      toolUseResult: {
        stdout: "Command running in background with ID: b1. Output is being written to: /tmp/claude-1000/-work-repo/session/tasks/b1.output",
        stderr: "",
        backgroundTaskId: "b1",
      },
      message: { content: [{ type: "tool_result", tool_use_id: "bash-tool", content: [] }] },
    },
  ]);
  assert.equal(translator.runningBackgroundShells, 1);

  // A command that ends while Claude is mid-turn is queued instead of delivered, and every command reported on this box left the report nowhere else.
  notifications.length = 0;
  await translator.translate([
    { type: "attachment", uuid: "queued", attachment: { type: "queued_command", commandMode: "task-notification", prompt: report } },
  ]);
  assert.equal(translator.runningBackgroundShells, 0);
  const closed = notifications.filter((notification) => notification.update.sessionUpdate === "tool_call_update");
  assert.equal(closed.length, 1);
  assert.equal((closed[0]!.update as { status: string }).status, "completed");
});

test("does not read a report for a background command a turn gave up on as an agent's", async () => {
  const notifications: SessionNotification[] = [];
  const connection = {
    sessionUpdate: async (notification: SessionNotification) => {
      notifications.push(notification);
    },
    extNotification: async () => undefined,
  } as unknown as AgentSideConnection;
  const translator = new TranscriptTranslator("session", "/work/repo", connection);

  translator.trackBackgroundWork();
  await translator.translate([
    {
      type: "assistant",
      uuid: "launcher",
      message: { content: [{ type: "tool_use", id: "bash-tool", name: "Bash", input: { command: "npm run dev", run_in_background: true } }] },
    },
    {
      type: "user",
      uuid: "launched",
      toolUseResult: { stdout: "", stderr: "", backgroundTaskId: "b1" },
      message: { content: [{ type: "tool_result", tool_use_id: "bash-tool", content: [] }] },
    },
  ]);
  translator.abandonBackgroundWork();
  const abandonedAt = translator.backgroundShellActivityAt;
  await new Promise((resolve) => setTimeout(resolve, 5));

  // A command reports long after the turn that started it has stopped waiting on it, and the bound of a later turn is not the one that was waited out.
  notifications.length = 0;
  await translator.translate([
    {
      type: "user",
      uuid: "notified",
      message: {
        content:
          '<task-notification> <task-id>b1</task-id> <status>completed</status> <summary>Background command completed (exit code 0)</summary> </task-notification>',
      },
    },
  ]);
  assert.equal(translator.runningBackgroundShells, 0);
  assert.equal(translator.backgroundShellActivityAt, abandonedAt);
  // The id is a command's, so nothing looks for an agent by it, and the card it closes is the command's own.
  assert.equal(translator.runningSubagents, 0);
  const closed = notifications.filter((notification) => notification.update.sessionUpdate === "tool_call_update");
  assert.deepEqual(
    closed.map((notification) => notification.update as { toolCallId: string; status: string }).map(({ toolCallId, status }) => ({ toolCallId, status })),
    [{ toolCallId: "bash-tool", status: "completed" }],
  );
});

/** The launch of a command Claude backgrounded, with the sentence Claude answers it with, copied from a real one. */
function backgroundLaunch(toolCallId: string, taskId: string, outputFile: string): Record<string, unknown>[] {
  return [
    {
      type: "assistant",
      uuid: `launcher-${toolCallId}`,
      message: { content: [{ type: "tool_use", id: toolCallId, name: "Bash", input: { command: "npm test", description: "Run the tests" } }] },
    },
    {
      type: "user",
      uuid: `launched-${toolCallId}`,
      toolUseResult: { stdout: "", stderr: "", backgroundTaskId: taskId, timedOutAfterMs: 120000 },
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: toolCallId,
            content: `Command did not complete within its 120s timeout and was moved to the background (ID: ${taskId}). Output is being written to: ${outputFile}. You will be notified when it completes. To check interim output, use Read on that file path.`,
            is_error: false,
          },
        ],
      },
    },
  ];
}

function cardUpdates(notifications: SessionNotification[], toolCallId: string): { status: string; text: string | null; rawOutput: unknown }[] {
  return notifications.flatMap(({ update }) => {
    if (update.sessionUpdate !== "tool_call_update" || update.toolCallId !== toolCallId) return [];
    const block = update.content?.[0];
    const text = block?.type === "content" && block.content.type === "text" ? block.content.text : null;
    return [{ status: update.status ?? "", text, rawOutput: update.rawOutput }];
  });
}

test("keeps a backgrounded command's card open with what it prints, until its report closes it", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "claude-tty-background-"));
  const outputFile = path.join(directory, "b1.output");
  const notifications: SessionNotification[] = [];
  const connection = {
    sessionUpdate: async (notification: SessionNotification) => {
      notifications.push(notification);
    },
    extNotification: async () => undefined,
  } as unknown as AgentSideConnection;
  const translator = new TranscriptTranslator("session", "/work/repo", connection);
  translator.trackBackgroundWork();

  await translator.translate(backgroundLaunch("bash-tool", "b1", outputFile));
  // The launch result says only that the command started, so the card goes on running.
  assert.deepEqual(cardUpdates(notifications, "bash-tool"), [
    { status: "in_progress", text: "Running in the background; no output yet.", rawOutput: undefined },
  ]);
  assert.deepEqual(notifications.at(-1)!.update._meta, { [BACKGROUND_COMMAND_META]: { taskId: "b1", outputFile } });

  await writeFile(outputFile, "\x1b[32mpass\x1b[0m one\nprogress 10%\rprogress 100%\n");
  const activityBefore = translator.activityAt;
  await new Promise((resolve) => setTimeout(resolve, 5));
  await translator.refreshBackgroundShells(true);
  assert.equal(cardUpdates(notifications, "bash-tool").at(-1)?.text, "pass one\nprogress 100%");
  // A command printing is not Claude doing anything, and a prompt is judged delivered by activity.
  assert.equal(translator.activityAt, activityBefore);
  // Nothing new printed is nothing to send.
  const sent = notifications.length;
  await translator.refreshBackgroundShells(true);
  assert.equal(notifications.length, sent);

  await appendFile(outputFile, "pass two\n");
  await translator.translate([
    {
      type: "user",
      uuid: "notified",
      message: {
        content: `<task-notification><task-id>b1</task-id><tool-use-id>bash-tool</tool-use-id><status>completed</status><summary>Background command "Run the tests" completed (exit code 0)</summary></task-notification>`,
      },
    },
  ]);
  // The report reads what was printed last, so the card ends on the whole of it.
  assert.deepEqual(cardUpdates(notifications, "bash-tool").at(-1), {
    status: "completed",
    text: 'pass one\nprogress 100%\npass two\n\nBackground command "Run the tests" completed (exit code 0)',
    rawOutput: undefined,
  });

  // A compaction replays the launch, which neither reopens the card nor closes it as the launch's own result.
  const closedAt = notifications.length;
  await translator.translate(backgroundLaunch("bash-tool", "b1", outputFile));
  await translator.refreshBackgroundShells(true);
  assert.equal(notifications.length, closedAt);
});

test("fails a backgrounded command's card when Claude stops the command or the session stops", async () => {
  const notifications: SessionNotification[] = [];
  const connection = {
    sessionUpdate: async (notification: SessionNotification) => {
      notifications.push(notification);
    },
    extNotification: async () => undefined,
  } as unknown as AgentSideConnection;
  const translator = new TranscriptTranslator("session", "/work/repo", connection);
  translator.trackBackgroundWork();

  await translator.translate([
    ...backgroundLaunch("server-tool", "b1", "/nonexistent/b1.output"),
    ...backgroundLaunch("suite-tool", "b2", "/nonexistent/b2.output"),
    {
      type: "assistant",
      uuid: "stopper",
      message: { content: [{ type: "tool_use", id: "stop-tool", name: "TaskStop", input: { task_id: "b1" } }] },
    },
    {
      type: "user",
      uuid: "stopped",
      message: { content: [{ type: "tool_result", tool_use_id: "stop-tool", content: [{ type: "text", text: '{"task_id":"b1"}' }] }] },
    },
  ]);
  // A failed card has to carry an error, or the daemon refuses the agent's whole history.
  assert.deepEqual(cardUpdates(notifications, "server-tool").at(-1), {
    status: "failed",
    text: "Claude stopped this command.",
    rawOutput: { error: "Claude stopped this command." },
  });

  // Abandoning the wait leaves the card saying the command runs, which is still true.
  translator.abandonBackgroundWork();
  assert.equal(cardUpdates(notifications, "suite-tool").at(-1)?.status, "in_progress");

  await translator.settleOpenToolCalls();
  assert.deepEqual(cardUpdates(notifications, "suite-tool").slice(1), [
    {
      status: "failed",
      text: "The session stopped before this command reported.",
      rawOutput: { error: "The session stopped before this command reported." },
    },
  ]);
});

test("closes a backgrounded command read out of history as the plain result it was", async () => {
  const notifications: SessionNotification[] = [];
  const connection = {
    sessionUpdate: async (notification: SessionNotification) => {
      notifications.push(notification);
    },
    extNotification: async () => undefined,
  } as unknown as AgentSideConnection;
  const translator = new TranscriptTranslator("session", "/work/repo", connection);

  // A session being loaded replays commands that stopped with the process that ran them.
  await translator.translate(backgroundLaunch("history-tool", "b1", "/nonexistent/b1.output"));
  const updates = cardUpdates(notifications, "history-tool");
  assert.equal(updates.length, 1);
  assert.equal(updates[0]!.status, "completed");
  assert.match(updates[0]!.text ?? "", /moved to the background/);
});

test("lets go of an agent whose report was queued because Claude was busy when it finished", async () => {
  const notifications: SessionNotification[] = [];
  const connection = {
    sessionUpdate: async (notification: SessionNotification) => {
      notifications.push(notification);
    },
    extNotification: async () => undefined,
  } as unknown as AgentSideConnection;
  const translator = new TranscriptTranslator("session", "/work/repo", connection);
  const report =
    '<task-notification><task-id>a1</task-id><tool-use-id>agent-tool</tool-use-id><status>completed</status><summary>Agent "Map the bridge" finished</summary></task-notification>';
  const queued = {
    type: "attachment",
    uuid: "queued",
    attachment: { type: "queued_command", commandMode: "task-notification", prompt: report },
  };

  translator.trackBackgroundWork();
  await translator.translate([
    {
      type: "assistant",
      uuid: "launcher",
      message: { content: [{ type: "tool_use", id: "agent-tool", name: "Agent", input: { description: "Map the bridge" } }] },
    },
    {
      type: "user",
      uuid: "launched",
      toolUseResult: { isAsync: true, status: "async_launched", agentId: "a1" },
      message: { content: [{ type: "tool_result", tool_use_id: "agent-tool", content: [] }] },
    },
  ]);
  assert.equal(translator.runningSubagents, 1);

  // An agent that finishes while Claude is mid-turn is queued instead of delivered, and this is the only record it leaves: no user turn ever carries it.
  await translator.translate([queued]);
  assert.equal(translator.runningSubagents, 0);
  assert.equal(translator.subagentSettled("a1"), true);
  const reported = notifications.map((notification) => notification.update).at(-1);
  assert.ok(reported?.sessionUpdate === "tool_call_update");
  assert.equal(reported.status, "completed");
  assert.deepEqual(reported.content, [{ type: "content", content: { type: "text", text: 'Agent "Map the bridge" finished' } }]);

  // The queue is rewritten at every turn boundary it survives, and the turn that finally delivers it says the same thing again.
  // Neither is a second report to put on the card.
  notifications.length = 0;
  await translator.translate([
    { ...queued, uuid: "queued-again" },
    { type: "user", uuid: "delivered", message: { content: report } },
  ]);
  assert.deepEqual(notifications, []);
});

test("lets go of an agent whose queued report was written as blocks", async () => {
  const notifications: SessionNotification[] = [];
  const connection = {
    sessionUpdate: async (notification: SessionNotification) => {
      notifications.push(notification);
    },
    extNotification: async () => undefined,
  } as unknown as AgentSideConnection;
  const translator = new TranscriptTranslator("session", "/work/repo", connection);

  translator.trackBackgroundWork();
  await translator.translate([
    {
      type: "assistant",
      uuid: "launcher",
      message: { content: [{ type: "tool_use", id: "agent-tool", name: "Agent", input: { description: "Map the bridge" } }] },
    },
    {
      type: "user",
      uuid: "launched",
      toolUseResult: { isAsync: true, status: "async_launched", agentId: "a1" },
      message: { content: [{ type: "tool_result", tool_use_id: "agent-tool", content: [] }] },
    },
  ]);
  assert.equal(translator.runningSubagents, 1);

  notifications.length = 0;
  await translator.translate([
    {
      type: "attachment",
      uuid: "queued",
      attachment: {
        type: "queued_command",
        commandMode: "task-notification",
        prompt: [
          {
            type: "text",
            text: '<task-notification><task-id>a1</task-id><tool-use-id>agent-tool</tool-use-id><status>completed</status><summary>Agent "Map the bridge" finished</summary></task-notification>',
          },
        ],
      },
    },
  ]);

  assert.equal(translator.runningSubagents, 0);
  assert.equal(translator.subagentSettled("a1"), true);
  const reported = notifications.map((notification) => notification.update).at(-1);
  assert.ok(reported?.sessionUpdate === "tool_call_update");
  assert.equal(reported.status, "completed");
  assert.deepEqual(reported.content, [{ type: "content", content: { type: "text", text: 'Agent "Map the bridge" finished' } }]);
  assert.equal(notifications.some((notification) => notification.update.sessionUpdate === "user_message_chunk"), false);
});

test("puts a message queued while Claude was working into the conversation, once", async () => {
  const notifications: SessionNotification[] = [];
  const connection = {
    sessionUpdate: async (notification: SessionNotification) => {
      notifications.push(notification);
    },
    extNotification: async () => undefined,
  } as unknown as AgentSideConnection;
  const translator = new TranscriptTranslator("session", "/work/repo", connection);
  const typed = {
    type: "attachment",
    uuid: "queued-typed",
    attachment: {
      type: "queued_command",
      commandMode: "prompt",
      origin: { kind: "human" },
      source_uuid: "typed-1",
      prompt: "I interrupt you, what happens<system-reminder>hidden</system-reminder>",
    },
  };
  const unkeyed = {
    type: "attachment",
    uuid: "queued-unkeyed",
    attachment: { type: "queued_command", commandMode: "prompt", prompt: "and one more thing" },
  };

  await translator.translate([
    typed,
    // Some Claude versions write the prompt as blocks rather than as one string.
    {
      type: "attachment",
      uuid: "queued-blocks",
      attachment: { type: "queued_command", commandMode: "prompt", source_uuid: "typed-2", prompt: [{ type: "text", text: "the codex one" }] },
    },
    // An agent's report is queued the same way, and is not the user saying anything.
    {
      type: "attachment",
      uuid: "queued-report",
      attachment: {
        type: "queued_command",
        commandMode: "task-notification",
        prompt: "<task-notification><task-id>a1</task-id><status>completed</status><summary>done</summary></task-notification>",
      },
    },
    // A prompt the queue gave no id of its own is keyed off the record that carries it.
    unkeyed,
  ]);

  assert.deepEqual(
    notifications.map((notification) => notification.update).map((update) => ({
      sessionUpdate: update.sessionUpdate,
      content: "content" in update ? update.content : null,
    })),
    [
      { sessionUpdate: "user_message_chunk", content: { type: "text", text: "I interrupt you, what happens" } },
      { sessionUpdate: "user_message_chunk", content: { type: "text", text: "the codex one" } },
      { sessionUpdate: "user_message_chunk", content: { type: "text", text: "and one more thing" } },
    ],
  );

  notifications.length = 0;
  await translator.translate([{ ...typed, uuid: "queued-again" }, unkeyed]);
  assert.deepEqual(notifications, []);
});

test("does not wait again on an agent whose launch a rewrite replayed", async () => {
  const connection = { sessionUpdate: async () => undefined, extNotification: async () => undefined } as unknown as AgentSideConnection;
  const translator = new TranscriptTranslator("session", "/work/repo", connection);
  const launch = [
    {
      type: "assistant",
      uuid: "launcher",
      message: { content: [{ type: "tool_use", id: "agent-tool", name: "Agent", input: { description: "Count the files" } }] },
    },
    {
      type: "user",
      uuid: "launched",
      toolUseResult: { isAsync: true, status: "async_launched", agentId: "a1" },
      message: { content: [{ type: "tool_result", tool_use_id: "agent-tool", content: [] }] },
    },
  ];

  translator.trackBackgroundWork();
  await translator.translate(launch);
  assert.equal(translator.runningSubagents, 1);

  await translator.translate([
    {
      type: "user",
      uuid: "notified",
      message: { content: "<task-notification> <task-id>a1</task-id> <status>completed</status> <summary>done</summary> </task-notification>" },
    },
  ]);
  assert.equal(translator.runningSubagents, 0);

  // A compaction rewrites the transcript, and the reader that notices replays it from the top.
  await translator.translate(launch);
  assert.equal(translator.runningSubagents, 0);
});

test("does not wait again on an agent a turn gave up on when a rewrite replays its launch", async () => {
  const connection = { sessionUpdate: async () => undefined, extNotification: async () => undefined } as unknown as AgentSideConnection;
  const translator = new TranscriptTranslator("session", "/work/repo", connection);
  const launch = [
    {
      type: "assistant",
      uuid: "launcher",
      message: { content: [{ type: "tool_use", id: "agent-tool", name: "Agent", input: { description: "Count the files" } }] },
    },
    {
      type: "user",
      uuid: "launched",
      toolUseResult: { isAsync: true, status: "async_launched", agentId: "a1" },
      message: { content: [{ type: "tool_result", tool_use_id: "agent-tool", content: [] }] },
    },
  ];

  translator.trackBackgroundWork();
  await translator.translate(launch);
  assert.equal(translator.runningSubagents, 1);

  // The turn waited its bound out on an agent that never reported, and stopped counting it.
  translator.abandonBackgroundWork();
  assert.equal(translator.runningSubagents, 0);

  await translator.translate(launch);
  assert.equal(translator.runningSubagents, 0);
});

test("settles a subagent whose launch is no longer in the transcript, so it stops being followed", async () => {
  const notifications: SessionNotification[] = [];
  const connection = {
    sessionUpdate: async (notification: SessionNotification) => {
      notifications.push(notification);
    },
    extNotification: async () => undefined,
  } as unknown as AgentSideConnection;
  const translator = new TranscriptTranslator("session", "/work/repo", connection);
  const steps = (agentId: string) => [
    { type: "assistant", uuid: `${agentId}-step`, message: { content: [{ type: "text", text: "Counting" }] } },
  ];

  // Two agents whose transcripts exist, and whose launches a compaction has taken out of the session's own.
  await translator.translateSubagent("reported", steps("reported"));
  await translator.translateSubagent("unreported", steps("unreported"));
  assert.equal(translator.subagentSettled("reported"), false);
  assert.equal(translator.subagentSettled("unreported"), false);

  // One reports, in the only record that says so.
  await translator.translate([
    {
      type: "user",
      uuid: "notified",
      message: { content: "<task-notification><task-id>reported</task-id><status>completed</status><summary>done</summary></task-notification>" },
    },
  ]);
  assert.equal(translator.subagentSettled("reported"), true);
  assert.equal(translator.subagentSettled("unreported"), false);

  // The other is still open when the session stops, which is the end of it too.
  await translator.settleOpenToolCalls();
  assert.equal(translator.subagentSettled("unreported"), true);

  // Neither has a tool call to show any of this on.
  assert.deepEqual(notifications, []);
});

test("leaves a synchronous agent's report alone when the session it ran in stops", async () => {
  const notifications: SessionNotification[] = [];
  const connection = {
    sessionUpdate: async (notification: SessionNotification) => {
      notifications.push(notification);
    },
    extNotification: async () => undefined,
  } as unknown as AgentSideConnection;
  const translator = new TranscriptTranslator("session", "/work/repo", connection);

  await translator.translate([
    {
      type: "assistant",
      uuid: "launcher",
      message: { content: [{ type: "tool_use", id: "task-1", name: "Task", input: { description: "Count the files" } }] },
    },
    {
      type: "user",
      uuid: "launched",
      toolUseResult: { status: "completed", agentId: "a1" },
      message: { content: [{ type: "tool_result", tool_use_id: "task-1", content: [{ type: "text", text: "There are 12." }] }] },
    },
  ]);

  const reported = notifications.map((notification) => notification.update).at(-1);
  assert.ok(reported?.sessionUpdate === "tool_call_update");
  assert.equal(reported.status, "completed");
  assert.deepEqual(reported.content, [{ type: "content", content: { type: "text", text: "There are 12." } }]);

  // A history replay settles the calls of a session that is no longer running, and an agent that
  // answered inside its launcher's turn is not one of them.
  notifications.length = 0;
  await translator.settleOpenToolCalls();
  assert.deepEqual(notifications, []);
});

test("closes the tool calls a stopped session left running, and leaves the ones it answered", async () => {
  const notifications: SessionNotification[] = [];
  const connection = {
    sessionUpdate: async (notification: SessionNotification) => {
      notifications.push(notification);
    },
    extNotification: async () => undefined,
  } as unknown as AgentSideConnection;
  const translator = new TranscriptTranslator("session", "/work/repo", connection);

  await translator.translate([
    {
      type: "assistant",
      uuid: "launcher",
      message: {
        content: [
          { type: "tool_use", id: "agent-tool", name: "Agent", input: { description: "Fix the findings" } },
          { type: "tool_use", id: "done-agent-tool", name: "Agent", input: { description: "Review the branch" } },
          { type: "tool_use", id: "bash-tool", name: "Bash", input: { command: "pnpm test" } },
          { type: "tool_use", id: "read-tool", name: "Read", input: { file_path: "src/app.ts" } },
        ],
      },
    },
    {
      type: "user",
      uuid: "launched",
      toolUseResult: { isAsync: true, status: "async_launched", agentId: "a1", description: "Fix the findings" },
      message: { content: [{ type: "tool_result", tool_use_id: "agent-tool", content: [] }] },
    },
    {
      type: "user",
      uuid: "launched-done",
      toolUseResult: { isAsync: true, status: "async_launched", agentId: "a2", description: "Review the branch" },
      message: { content: [{ type: "tool_result", tool_use_id: "done-agent-tool", content: [] }] },
    },
    {
      type: "user",
      uuid: "reported",
      message: { content: "<task-notification> <task-id>a2</task-id> <status>completed</status> <summary>Reviewed</summary> </task-notification>" },
    },
    {
      type: "user",
      uuid: "read-result",
      message: { content: [{ type: "tool_result", tool_use_id: "read-tool", content: [{ type: "text", text: "contents" }] }] },
    },
  ]);
  await translator.translateSubagent("a1", [
    { type: "assistant", uuid: "sub-1", message: { content: [{ type: "text", text: "Reading the diff" }] } },
  ]);

  notifications.length = 0;
  await translator.settleOpenToolCalls();
  await translator.settleOpenToolCalls();

  const updates = notifications.map((notification) => notification.update);
  assert.equal(updates.length, 2);
  assert.ok(updates[0]?.sessionUpdate === "tool_call_update");
  assert.equal(updates[0].toolCallId, "agent-tool");
  assert.equal(updates[0].status, "failed");
  assert.deepEqual(updates[0].content, [
    { type: "content", content: { type: "text", text: "Reading the diff\nClaude stopped before this agent reported back." } },
  ]);
  assert.ok(updates[1]?.sessionUpdate === "tool_call_update");
  assert.equal(updates[1].toolCallId, "bash-tool");
  assert.equal(updates[1].status, "failed");
  // Both carry something to fail with. A failed tool call the daemon is given a null error for is one
  // its own schema has no branch for, and the response carrying it fails validation whole: the client
  // loses the agent's entire history rather than this one card, and goes on losing it.
  assert.ok(updates[0].rawOutput !== undefined && updates[0].rawOutput !== null, "a failed agent card carried no error");
  assert.ok(updates[1].rawOutput !== undefined && updates[1].rawOutput !== null, "a failed tool call carried no error");
  assert.equal(translator.runningSubagents, 0);
});

test("reads the session's last sign of life from whatever moved last, Claude's own tools included", async () => {
  const connection = { sessionUpdate: async () => undefined, extNotification: async () => undefined } as unknown as AgentSideConnection;
  const translator = new TranscriptTranslator("session", "/work/repo", connection);
  assert.equal(translator.activityAt, 0);
  assert.equal(translator.assistantActivityAt, 0);

  await translator.translate([{ type: "user", uuid: "user-1", message: { content: "<task-notification><task-id>b1</task-id><status>completed</status></task-notification>" } }]);
  // Nothing is shown for a notification about a command, but the turn Claude was woken with is the session moving.
  assert.equal(translator.assistantActivityAt, 0);
  assert.equal(translator.activityAt, 0);

  await translator.translate([{ type: "user", uuid: "user-2", message: { content: "carry on" } }]);
  const wokenAt = translator.activityAt;
  assert.ok(wokenAt > 0);
  assert.equal(translator.assistantActivityAt, 0);

  await new Promise((resolve) => setTimeout(resolve, 5));
  await translator.translate([
    { type: "assistant", uuid: "assistant-1", message: { content: [{ type: "tool_use", id: "bash-1", name: "Bash", input: { command: "ls" } }] } },
  ]);
  const calledAt = translator.assistantActivityAt;
  assert.ok(calledAt > wokenAt);

  const beforeResult = translator.activityAt;
  await new Promise((resolve) => setTimeout(resolve, 5));
  await translator.translate([{ type: "user", uuid: "user-3", message: { content: [{ type: "tool_result", tool_use_id: "bash-1", content: "done" }] } }]);
  assert.ok(translator.assistantActivityAt > calledAt, "a tool finishing is Claude's own progress");
  assert.ok(translator.activityAt > beforeResult, "and the session moved with it");

  // Reading the same records again shows nothing new, and so moves nothing.
  const settledAt = translator.activityAt;
  await new Promise((resolve) => setTimeout(resolve, 5));
  await translator.translate([{ type: "user", uuid: "user-3", message: { content: [{ type: "tool_result", tool_use_id: "bash-1", content: "done" }] } }]);
  assert.equal(translator.activityAt, settledAt);
});

test("stops counting an agent the session stopped, which never reports and never would", async () => {
  const notifications: SessionNotification[] = [];
  const connection = {
    sessionUpdate: async (notification: SessionNotification) => {
      notifications.push(notification);
    },
    extNotification: async () => undefined,
  } as unknown as AgentSideConnection;
  const translator = new TranscriptTranslator("session", "/work/repo", connection);
  translator.trackBackgroundWork();

  await translator.translate([
    {
      type: "assistant",
      uuid: "launcher",
      message: { content: [{ type: "tool_use", id: "agent-tool", name: "Agent", input: { description: "Fix the regressions" } }] },
    },
    {
      type: "user",
      uuid: "launched",
      toolUseResult: { isAsync: true, status: "async_launched", agentId: "a8feac8dac4f2bf65" },
      message: { content: [{ type: "tool_result", tool_use_id: "agent-tool", content: [] }] },
    },
  ]);
  assert.equal(translator.runningSubagents, 1);

  notifications.length = 0;
  await translator.translate([
    {
      type: "assistant",
      uuid: "stopper",
      message: { content: [{ type: "tool_use", id: "stop-tool", name: "TaskStop", input: { task_id: "a8feac8dac4f2bf65" } }] },
    },
    {
      type: "user",
      uuid: "stopped",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "stop-tool",
            content: [{ type: "text", text: '{"task_id":"a8feac8dac4f2bf65"}' }],
          },
        ],
      },
    },
  ]);

  assert.equal(translator.runningSubagents, 0);
  const card = notifications
    .map((notification) => notification.update)
    .find((update) => update.sessionUpdate === "tool_call_update" && update.toolCallId === "agent-tool");
  assert.ok(card?.sessionUpdate === "tool_call_update");
  assert.equal(card.status, "failed");
  assert.match(JSON.stringify(card.content), /Claude stopped this agent\./);
});

test("leaves an agent running when the stop that named it failed", async () => {
  const notifications: SessionNotification[] = [];
  const connection = {
    sessionUpdate: async (notification: SessionNotification) => {
      notifications.push(notification);
    },
    extNotification: async () => undefined,
  } as unknown as AgentSideConnection;
  const translator = new TranscriptTranslator("session", "/work/repo", connection);
  translator.trackBackgroundWork();

  await translator.translate([
    {
      type: "assistant",
      uuid: "launcher",
      message: { content: [{ type: "tool_use", id: "agent-tool", name: "Agent", input: { description: "Keep working" } }] },
    },
    {
      type: "user",
      uuid: "launched",
      toolUseResult: { isAsync: true, status: "async_launched", agentId: "still-running" },
      message: { content: [{ type: "tool_result", tool_use_id: "agent-tool", content: [] }] },
    },
    {
      type: "assistant",
      uuid: "stopper",
      message: { content: [{ type: "tool_use", id: "stop-tool", name: "TaskStop", input: { task_id: "still-running" } }] },
    },
    {
      type: "user",
      uuid: "stop-failed",
      message: { content: [{ type: "tool_result", tool_use_id: "stop-tool", is_error: true, content: [] }] },
    },
  ]);

  assert.equal(translator.runningSubagents, 1);
});

test("stops counting a background command the session stopped, and goes on counting one whose stop failed", async () => {
  const connection = { sessionUpdate: async () => undefined, extNotification: async () => undefined } as unknown as AgentSideConnection;
  const translator = new TranscriptTranslator("session", "/work/repo", connection);
  const stop = (toolCallId: string, taskId: string, result: Record<string, unknown>) => [
    {
      type: "assistant",
      uuid: `stopper-${toolCallId}`,
      message: { content: [{ type: "tool_use", id: toolCallId, name: "TaskStop", input: { task_id: taskId } }] },
    },
    {
      type: "user",
      uuid: `stopped-${toolCallId}`,
      message: { content: [{ type: "tool_result", tool_use_id: toolCallId, ...result }] },
    },
  ];

  translator.trackBackgroundWork();
  await translator.translate([
    {
      type: "assistant",
      uuid: "launcher",
      message: {
        content: [{ type: "tool_use", id: "server-tool", name: "Bash", input: { command: "npm run dev", run_in_background: true } }],
      },
    },
    {
      type: "user",
      uuid: "launched",
      toolUseResult: { stdout: "", stderr: "", backgroundTaskId: "blra7ddm0" },
      message: { content: [{ type: "tool_result", tool_use_id: "server-tool", content: [] }] },
    },
  ]);
  assert.equal(translator.runningBackgroundShells, 1);
  const launchedAt = translator.backgroundShellActivityAt;

  await translator.translate(stop("failed-stop", "blra7ddm0", { is_error: true, content: [] }));
  assert.equal(translator.runningBackgroundShells, 1);
  assert.deepEqual(translator.outstandingBackgroundShells, ["blra7ddm0"]);

  await translator.translate(stop("stop-tool", "blra7ddm0", { content: [{ type: "text", text: '{"task_id":"blra7ddm0"}' }] }));
  assert.equal(translator.runningBackgroundShells, 0);
  assert.deepEqual(translator.outstandingBackgroundShells, []);
  assert.ok(translator.backgroundShellActivityAt >= launchedAt);
});

test("mirrors every tool-call update as a vendor notification, ahead of the update itself", async () => {
  const sent: string[] = [];
  const mirrored: Record<string, unknown>[] = [];
  const connection = {
    sessionUpdate: async (notification: SessionNotification) => {
      sent.push(`update:${notification.update.sessionUpdate}`);
    },
    extNotification: async (method: string, params: Record<string, unknown>) => {
      sent.push(`mirror:${method}`);
      mirrored.push(params);
    },
  } as unknown as AgentSideConnection;
  const translator = new TranscriptTranslator("session", "/work/repo", connection);

  await translator.translate([
    {
      type: "assistant",
      uuid: "assistant-1",
      message: {
        content: [
          { type: "text", text: "running it" },
          { type: "tool_use", id: "bash-1", name: "Bash", input: { command: "npm test" } },
        ],
      },
    },
    {
      type: "user",
      uuid: "result-1",
      message: { content: [{ type: "tool_result", tool_use_id: "bash-1", content: [{ type: "text", text: "3 passing" }] }] },
    },
  ]);

  // Nothing but a tool call is mirrored, and each mirror goes out before the update it copies.
  assert.deepEqual(sent, [
    "update:agent_message_chunk",
    `mirror:${TOOL_CALL_MIRROR_METHOD}`,
    "update:tool_call",
    `mirror:${TOOL_CALL_MIRROR_METHOD}`,
    "update:tool_call_update",
  ]);
  // The whole update, because the fields the plugin bridge drops are exactly the ones a card is made of.
  assert.deepEqual(mirrored, [
    {
      sessionId: "session",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "bash-1",
        title: "Bash: npm test",
        kind: "execute",
        status: "in_progress",
        rawInput: { command: "npm test" },
        content: [{ type: "content", content: { type: "text", text: "npm test" } }],
      },
    },
    {
      sessionId: "session",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "bash-1",
        status: "completed",
        rawOutput: [{ type: "text", text: "3 passing" }],
        content: [{ type: "content", content: { type: "text", text: "3 passing" } }],
      },
    },
  ]);
});

test("sends an edit's diff again with its result, rather than the line saying the file was updated", async () => {
  const notifications: SessionNotification[] = [];
  const connection = {
    sessionUpdate: async (notification: SessionNotification) => {
      notifications.push(notification);
    },
    extNotification: async () => undefined,
  } as unknown as AgentSideConnection;
  const translator = new TranscriptTranslator("session", "/work/repo", connection);
  const updated = (file: string) => [{ type: "text", text: `The file ${file} has been updated successfully.` }];

  await translator.translate([
    {
      type: "assistant",
      uuid: "assistant-1",
      message: {
        content: [
          { type: "tool_use", id: "edit-1", name: "Edit", input: { file_path: "src/app.ts", old_string: "a", new_string: "b" } },
          { type: "tool_use", id: "write-1", name: "Write", input: { file_path: "/tmp/notes.md", content: "# Notes" } },
          { type: "tool_use", id: "edit-2", name: "Edit", input: { file_path: "src/gone.ts", old_string: "x", new_string: "y" } },
          { type: "tool_use", id: "bash-1", name: "Bash", input: { command: "npm test" } },
        ],
      },
    },
    {
      type: "user",
      uuid: "results",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "edit-1", content: updated("/work/repo/src/app.ts") },
          { type: "tool_result", tool_use_id: "write-1", content: updated("/tmp/notes.md") },
          { type: "tool_result", tool_use_id: "edit-2", is_error: true, content: "<tool_use_error>String to replace not found in file.</tool_use_error>" },
          { type: "tool_result", tool_use_id: "bash-1", content: [{ type: "text", text: "3 passing" }] },
        ],
      },
    },
  ]);

  const result = (toolCallId: string) =>
    notifications.find((notification) => notification.update.sessionUpdate === "tool_call_update" && notification.update.toolCallId === toolCallId)?.update;
  assert.deepEqual(result("edit-1"), {
    sessionUpdate: "tool_call_update",
    toolCallId: "edit-1",
    status: "completed",
    rawOutput: updated("/work/repo/src/app.ts"),
    content: [{ type: "diff", path: "/work/repo/src/app.ts", oldText: "a", newText: "b" }],
  });
  assert.deepEqual(result("write-1"), {
    sessionUpdate: "tool_call_update",
    toolCallId: "write-1",
    status: "completed",
    rawOutput: updated("/tmp/notes.md"),
    content: [{ type: "diff", path: "/tmp/notes.md", newText: "# Notes" }],
  });
  // A failed edit keeps the diff it attempted too; what went wrong is in its raw output.
  assert.deepEqual(result("edit-2"), {
    sessionUpdate: "tool_call_update",
    toolCallId: "edit-2",
    status: "failed",
    rawOutput: "<tool_use_error>String to replace not found in file.</tool_use_error>",
    content: [{ type: "diff", path: "/work/repo/src/gone.ts", oldText: "x", newText: "y" }],
  });
  // Anything that is not an edit still shows what it produced.
  const shell = result("bash-1");
  assert.ok(shell?.sessionUpdate === "tool_call_update");
  assert.deepEqual(shell.content, [{ type: "content", content: { type: "text", text: "3 passing" } }]);
});

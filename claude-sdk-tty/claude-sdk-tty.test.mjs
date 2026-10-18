import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";

const configDir = mkdtempSync(path.join(os.tmpdir(), "claude-sdk-tty-test-"));
process.env.CLAUDE_CONFIG_DIR = configDir;
process.env.CLAUDE_SDK_TTY_STATE_DIR = path.join(configDir, "state");
const { Bridge } = await import("./claude-sdk-tty.mjs");

const sessionId = "11111111-2222-3333-4444-555555555555";
const agentId = "a007b3f65134392f1";
const toolUseId = "toolu_agent";
let sessionDir;

const jsonl = (records) => records.map((record) => JSON.stringify(record)).join("\n") + "\n";

beforeEach(() => {
  const projectDir = path.join(configDir, "projects", process.cwd().replace(/[^a-zA-Z0-9]/g, "-"));
  sessionDir = path.join(projectDir, sessionId);
  mkdirSync(path.join(sessionDir, "subagents"), { recursive: true });
  // A background agent that was launched and has already reported back.
  writeFileSync(
    path.join(projectDir, `${sessionId}.jsonl`),
    jsonl([
      { type: "assistant", uuid: "u1", message: { content: [{ type: "tool_use", id: toolUseId, name: "Agent", input: { description: "Prune", run_in_background: true } }] } },
      { type: "user", uuid: "u2", message: { content: [{ type: "tool_result", tool_use_id: toolUseId, content: "launched" }] }, toolUseResult: { status: "async_launched", agentId } },
      { type: "queue-operation", operation: "enqueue", timestamp: "t1", content: `<task-notification><task-id>${agentId}</task-id><status>completed</status></task-notification>` },
    ]),
  );
  writeFileSync(path.join(sessionDir, "subagents", `agent-${agentId}.meta.json`), JSON.stringify({ toolUseId, requestShape: "background" }));
  writeFileSync(
    path.join(sessionDir, "subagents", `agent-${agentId}.jsonl`),
    jsonl([
      { type: "user", uuid: "s1", message: { content: "Prune tests" } },
      { type: "api-request", id: "req1", timestamp: "t0" },
      { type: "assistant", uuid: "s2", message: { content: [{ type: "text", text: "done" }] } },
    ]),
  );
});

afterEach(() => rmSync(path.join(configDir, "projects"), { recursive: true, force: true }));

function resumedBridge() {
  const bridge = new Bridge(["--resume", sessionId, "--input-format", "stream-json", "--output-format", "stream-json"]);
  const sent = [];
  bridge.send = (message) => sent.push(message);
  bridge.seedSeen();
  return { bridge, sent };
}

/** What the transcript watcher does on start: hand over every record it reads. */
function replaySubagent(bridge, records) {
  for (const record of records) bridge.onRecord(record, agentId);
}

test("a resumed session does not restart subagents that already finished", () => {
  const { bridge, sent } = resumedBridge();
  bridge.onToolUse({ type: "tool_use", id: toolUseId, name: "Agent", input: { description: "Prune", run_in_background: true } });
  replaySubagent(bridge, [
    { type: "user", uuid: "s1", message: { content: "Prune tests" } },
    { type: "api-request", id: "req1", timestamp: "t0" },
    { type: "assistant", uuid: "s2", message: { content: [{ type: "text", text: "done" }] } },
  ]);
  assert.deepEqual(sent.filter((message) => message.subtype === "task_started"), []);
});

test("a subagent continued after a resume starts and finishes again", () => {
  const { bridge, sent } = resumedBridge();
  bridge.onToolUse({ type: "tool_use", id: toolUseId, name: "Agent", input: { description: "Prune", run_in_background: true } });
  replaySubagent(bridge, [{ type: "user", uuid: "s3", message: { content: "continue" } }]);
  bridge.onRecord({ type: "queue-operation", operation: "enqueue", timestamp: "t2", content: `<task-notification><task-id>${agentId}</task-id><status>completed</status></task-notification>` }, null);
  assert.deepEqual(
    sent.filter((message) => message.subtype?.startsWith("task_")).map((message) => [message.subtype, message.task_id]),
    [
      ["task_started", agentId],
      ["task_notification", agentId],
    ],
  );
});

/** A bridge whose transcript reader hands over `pending` records only when flushed, like the 40 ms poll a hook can beat. */
function liveBridge() {
  const bridge = new Bridge(["--session-id", sessionId, "--input-format", "stream-json", "--output-format", "stream-json"]);
  const sent = [];
  const pending = [];
  bridge.send = (message) => sent.push(message);
  bridge.runtime = { contextFilePath: null, transcript: { flushUntilStable: async () => { for (const record of pending.splice(0)) bridge.onRecord(record, null); } } };
  return { bridge, sent, pending };
}

const notification = (uuid) => ({ type: "user", uuid, origin: { kind: "task-notification" }, message: { content: "<task-notification><task-id>b1</task-id><status>completed</status></task-notification>" } });
const usageLimit = (uuid) => ({ type: "assistant", uuid, error: "rate_limit", message: { id: uuid, model: "<synthetic>", content: [{ type: "text", text: "You've hit your session limit" }] } });

test("a usage-limit failure that beats its records to the reader leaves no turn open", async () => {
  const { bridge, sent, pending } = liveBridge();
  pending.push(notification("n1"), usageLimit("e1"));
  await bridge.afterLifecycleHook({ hook_event_name: "StopFailure", error: "rate_limit" });
  assert.equal(bridge.turn, null);
  assert.equal(sent.filter((message) => message.type === "result" && message.is_error).length, 1);
});

test("a stop that beats its task notification to the reader still ends that turn", async () => {
  const { bridge, sent, pending } = liveBridge();
  pending.push(notification("n2"), { type: "assistant", uuid: "a2", message: { id: "m2", model: "claude-opus-5-5", content: [{ type: "text", text: "noted" }] } });
  await bridge.afterLifecycleHook({ hook_event_name: "Stop", last_assistant_message: "noted" });
  assert.equal(bridge.turn, null);
  assert.deepEqual(sent.filter((message) => message.type === "result").map((message) => message.result), ["noted"]);
});

test("a usage-limit notice read after its turn ended does not open another", () => {
  const { bridge } = liveBridge();
  bridge.onRecord(usageLimit("e3"), null);
  assert.equal(bridge.turn, null);
});

test("a typed /compact sends its boundary before the turn's result", async () => {
  const { bridge, sent } = liveBridge();
  bridge.openTurn({ kind: "human", compact: true });
  // The runtime's own PostCompact handling ends a `/compact` turn, which is when the result goes out.
  const runtimeHook = async () => {
    await bridge.finishTurn({ kind: "success" });
    return {};
  };
  await bridge.onHook({ hook_event_name: "PostCompact", trigger: "manual" }, runtimeHook);
  const order = sent.map((message) => message.subtype === "compact_boundary" ? "boundary" : message.type).filter((kind) => kind === "boundary" || kind === "result");
  assert.deepEqual(order, ["boundary", "result"]);
});

test("the compact boundary Claude writes late is not sent a second time", async () => {
  const { bridge, sent, pending } = liveBridge();
  bridge.openTurn({ kind: "human", compact: true });
  await bridge.onHook({ hook_event_name: "PostCompact", trigger: "manual" }, async () => ({}));
  pending.push({ type: "system", subtype: "compact_boundary", uuid: "cb1", compactMetadata: { trigger: "manual", preTokens: 1 } });
  await bridge.flushTranscript(true);
  assert.equal(sent.filter((message) => message.subtype === "compact_boundary").length, 1);
});

test("a compact right after a resume reports the resumed context's size", async () => {
  const projectDir = path.dirname(sessionDir);
  writeFileSync(
    path.join(projectDir, `${sessionId}.jsonl`),
    jsonl([{ type: "assistant", uuid: "u9", message: { id: "m9", model: "claude-opus-5-5", usage: { input_tokens: 10, cache_read_input_tokens: 120_000, output_tokens: 500 }, content: [] } }]),
    { flag: "a" },
  );
  const { bridge, sent } = resumedBridge();
  bridge.openTurn({ kind: "human", compact: true });
  await bridge.onHook({ hook_event_name: "PostCompact", trigger: "manual" }, async () => ({}));
  assert.equal(sent.find((message) => message.subtype === "compact_boundary").compact_metadata.pre_tokens, 120_510);
});

test("a prompt that opens with an image is typed text first", async () => {
  const { toAcpContent } = await import("./claude-sdk-tty.mjs");
  const blocks = toAcpContent([
    { type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } },
    { type: "text", text: "What color is this?" },
  ]);
  assert.deepEqual(blocks.map((block) => block.type), ["text", "image"]);
});

test("a /compact Claude refuses ends its turn with Claude's reason", async () => {
  const { bridge, sent, pending } = liveBridge();
  let runtimeTurnEnded = false;
  bridge.runtimeHook = async (payload) => { runtimeTurnEnded = payload.hook_event_name === "PostCompact"; };
  bridge.openTurn({ kind: "human", compact: true });
  pending.push({ type: "system", subtype: "local_command", uuid: "lc1", content: "<local-command-stderr>Error during compaction: You've hit your session limit</local-command-stderr>" });
  await bridge.flushTranscript(true);
  await bridge.turnEnded;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(bridge.turn, null);
  assert.ok(runtimeTurnEnded);
  assert.deepEqual(sent.filter((message) => message.type === "result").map((message) => [message.is_error, message.result]), [[true, "Error during compaction: You've hit your session limit"]]);
});

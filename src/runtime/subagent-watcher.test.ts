import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SubagentWatcher } from "./subagent-watcher.ts";
import type { TranscriptRecord } from "./transcript-reader.ts";

function record(text: string): string {
  return `${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } })}\n`;
}

test("follows every subagent transcript from where it last read", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "subagents-"));
  const transcript = path.join(root, "session.jsonl");
  const directory = path.join(root, "session", "subagents");
  const seen: Array<{ agentId: string; records: TranscriptRecord[] }> = [];
  const watcher = new SubagentWatcher(
    transcript,
    { translateSubagent: async (agentId, records) => void seen.push({ agentId, records }), subagentSettled: () => false },
    root,
    0,
  );

  // A session that has never run a subagent has no directory of them.
  await watcher.sync();
  assert.equal(seen.length, 0);

  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "agent-a1.jsonl"), record("first"));
  await writeFile(path.join(directory, "notes.txt"), "ignored");
  await watcher.sync();
  assert.deepEqual(seen.map((entry) => entry.agentId), ["a1"]);
  assert.equal(seen[0]?.records.length, 1);

  await watcher.sync();
  assert.equal(seen.length, 1);

  await writeFile(path.join(directory, "agent-a1.jsonl"), `${record("first")}${record("second")}`);
  await writeFile(path.join(directory, "agent-a2.jsonl"), record("other"));
  await watcher.sync();
  assert.deepEqual(seen.slice(1).map((entry) => entry.agentId), ["a1", "a2"]);
  assert.equal(seen[1]?.records.length, 1);

  watcher.close();
  await writeFile(path.join(directory, "agent-a3.jsonl"), record("after close"));
  await watcher.sync();
  assert.equal(seen.length, 3);

  // A suspended session wakes onto the same watcher, and picks up where it read rather than again.
  watcher.open();
  await watcher.sync();
  assert.deepEqual(seen.slice(3).map((entry) => entry.agentId), ["a3"]);
  assert.equal(seen[3]?.records.length, 1);
});

test("reads no more often than its interval unless the end of a turn forces it", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "subagents-"));
  const directory = path.join(root, "session", "subagents");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "agent-a1.jsonl"), record("first"));
  const seen: string[] = [];
  const watcher = new SubagentWatcher(
    path.join(root, "session.jsonl"),
    { translateSubagent: async (agentId) => void seen.push(agentId), subagentSettled: () => false },
    root,
    60_000,
  );

  await watcher.sync();
  await writeFile(path.join(directory, "agent-a1.jsonl"), `${record("first")}${record("second")}`);
  await watcher.sync();
  assert.deepEqual(seen, ["a1"]);

  await watcher.sync(true);
  assert.deepEqual(seen, ["a1", "a1"]);
});

test("stops following a subagent that has reported, and does not open it again", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "subagents-"));
  const directory = path.join(root, "session", "subagents");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "agent-a1.jsonl"), record("first"));
  const seen: string[] = [];
  const settled = new Set<string>();
  const watcher = new SubagentWatcher(
    path.join(root, "session.jsonl"),
    { translateSubagent: async (agentId) => void seen.push(agentId), subagentSettled: (agentId) => settled.has(agentId) },
    root,
    0,
  );

  await watcher.sync();
  assert.deepEqual(seen, ["a1"]);

  // The agent reports, so the read that saw its last step is the last read it gets.
  settled.add("a1");
  await writeFile(path.join(directory, "agent-a1.jsonl"), `${record("first")}${record("second")}`);
  await watcher.sync();
  assert.deepEqual(seen, ["a1", "a1"]);

  await writeFile(path.join(directory, "agent-a1.jsonl"), `${record("first")}${record("second")}${record("third")}`);
  await watcher.sync();
  assert.deepEqual(seen, ["a1", "a1"]);
});

test("follows a settled subagent again when its card reopens, from where it stopped reading", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "subagents-"));
  const directory = path.join(root, "session", "subagents");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "agent-a1.jsonl"), record("first"));
  const seen: Array<{ agentId: string; records: TranscriptRecord[] }> = [];
  const settled = new Set<string>();
  const watcher = new SubagentWatcher(
    path.join(root, "session.jsonl"),
    {
      translateSubagent: async (agentId, records) => void seen.push({ agentId, records }),
      subagentSettled: (agentId) => settled.has(agentId),
    },
    root,
    0,
  );

  await watcher.sync();
  settled.add("a1");
  await writeFile(path.join(directory, "agent-a1.jsonl"), `${record("first")}${record("second")}`);
  await watcher.sync();
  assert.equal(seen.length, 2);

  // Nothing of a settled transcript is read, however much it grows.
  await writeFile(path.join(directory, "agent-a1.jsonl"), `${record("first")}${record("second")}${record("third")}`);
  await watcher.sync();
  assert.equal(seen.length, 2);

  // A message sent to the agent reopens its card, and it is followed again — from the offset its
  // reader still holds, so the steps already on that card are not streamed onto it a second time.
  settled.delete("a1");
  await watcher.sync();
  assert.equal(seen.length, 3);
  assert.deepEqual(seen[2]?.agentId, "a1");
  assert.equal(seen[2]?.records.length, 1);

  // And it is set aside again when it reports again, after the one read that takes its last words.
  settled.add("a1");
  await writeFile(path.join(directory, "agent-a1.jsonl"), `${record("first")}${record("second")}${record("third")}${record("fourth")}`);
  await watcher.sync();
  assert.equal(seen.length, 4);
  await writeFile(path.join(directory, "agent-a1.jsonl"), `${record("first")}${record("second")}${record("third")}${record("fourth")}${record("fifth")}`);
  await watcher.sync();
  assert.equal(seen.length, 4);
});

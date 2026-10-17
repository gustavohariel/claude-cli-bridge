import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AgentSideConnection, SessionNotification } from "@agentclientprotocol/sdk";
import { escapeProjectDirName, TranscriptReader } from "./transcript-reader.ts";
import { TranscriptTranslator } from "./transcript-translator.ts";
import { TranscriptWatcher } from "./transcript-watcher.ts";

test("streams a delayed transcript and flushes its final offset", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "transcript-watcher-test-"));
  const cwd = "/work/watch";
  const sessionId = "44444444-4444-4444-8444-444444444444";
  const notifications: SessionNotification[] = [];
  const connection = {
    sessionUpdate: async (notification: SessionNotification) => {
      notifications.push(notification);
    },
    extNotification: async () => undefined,
  } as unknown as AgentSideConnection;
  const watcher = new TranscriptWatcher(
    new TranscriptReader(sessionId, cwd, { configDir: root }),
    new TranscriptTranslator(sessionId, cwd, connection),
    5,
  );

  try {
    await watcher.start();
    const projectDir = path.join(root, "projects", escapeProjectDirName(cwd));
    const filePath = path.join(projectDir, `${sessionId}.jsonl`);
    await mkdir(projectDir, { recursive: true });
    const user = `${JSON.stringify({ type: "user", uuid: "user", message: { content: "hello" } })}\n`;
    await writeFile(filePath, user);
    await waitFor(() => notifications.length === 1);

    const assistant = `${JSON.stringify({ type: "assistant", uuid: "assistant", message: { content: [{ type: "text", text: "done" }] } })}\n`;
    await appendFile(filePath, assistant.slice(0, 25));
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.equal(notifications.length, 1);
    await appendFile(filePath, assistant.slice(25));
    await watcher.flushUntilStable();
    assert.deepEqual(notifications.map((notification) => notification.update.sessionUpdate), ["user_message_chunk", "agent_message_chunk"]);
  } finally {
    await watcher.close();
    await rm(root, { force: true, recursive: true });
  }
});

test("does not consider a partial final JSONL record stable", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "transcript-watcher-test-"));
  const cwd = "/work/watch-partial";
  const sessionId = "55555555-5555-4555-8555-555555555555";
  const notifications: SessionNotification[] = [];
  const connection = {
    sessionUpdate: async (notification: SessionNotification) => {
      notifications.push(notification);
    },
    extNotification: async () => undefined,
  } as unknown as AgentSideConnection;
  const watcher = new TranscriptWatcher(
    new TranscriptReader(sessionId, cwd, { configDir: root }),
    new TranscriptTranslator(sessionId, cwd, connection),
    5,
  );

  try {
    await watcher.start();
    const projectDir = path.join(root, "projects", escapeProjectDirName(cwd));
    const filePath = path.join(projectDir, `${sessionId}.jsonl`);
    await mkdir(projectDir, { recursive: true });
    const assistant = JSON.stringify({ type: "assistant", uuid: "assistant", message: { content: [{ type: "text", text: "done" }] } });
    await writeFile(filePath, assistant);
    const flush = watcher.flushUntilStable();
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(notifications.length, 0);
    await appendFile(filePath, "\n");
    await flush;
    assert.deepEqual(notifications.map((notification) => notification.update.sessionUpdate), ["agent_message_chunk"]);
  } finally {
    await watcher.close();
    await rm(root, { force: true, recursive: true });
  }
});

test("leaves the subagent throttle alone unless the flush is the end of a turn", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "transcript-watcher-test-"));
  const cwd = "/work/watch-subagents";
  const sessionId = "66666666-6666-4666-8666-666666666666";
  const connection = { sessionUpdate: async () => undefined, extNotification: async () => undefined } as unknown as AgentSideConnection;
  const forced: boolean[] = [];
  const watcher = new TranscriptWatcher(
    new TranscriptReader(sessionId, cwd, { configDir: root }),
    new TranscriptTranslator(sessionId, cwd, connection),
    5,
    { sync: async (force = false) => void forced.push(force), open: () => undefined, close: () => undefined },
  );

  try {
    const projectDir = path.join(root, "projects", escapeProjectDirName(cwd));
    await mkdir(projectDir, { recursive: true });
    await writeFile(path.join(projectDir, `${sessionId}.jsonl`), `${JSON.stringify({ type: "user", uuid: "user", message: { content: "hello" } })}\n`);

    // The flush a hook does runs several reads, and Claude is blocked on every one of them.
    await watcher.flushUntilStable();
    assert.ok(forced.length >= 3, `expected repeated reads, got ${forced.length}`);
    assert.deepEqual(new Set(forced), new Set([false]));

    forced.length = 0;
    await watcher.flushUntilStable(true);
    assert.deepEqual(forced.slice(-1), [true]);
    assert.deepEqual(new Set(forced.slice(0, -1)), new Set([false]));
  } finally {
    await watcher.close();
    await rm(root, { force: true, recursive: true });
  }
});

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for transcript update");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

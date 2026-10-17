import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AgentSideConnection, SessionNotification } from "@agentclientprotocol/sdk";
import type { IPty } from "node-pty";
import { ClaudeTtyAgent } from "./agent.ts";
import { StateStore } from "./state-store.ts";
import { escapeProjectDirName } from "./transcript-reader.ts";

class LoadFakePty {
  readonly pid = 9000;
  readonly writes: string[] = [];
  killed = false;

  write(data: string | Buffer): void {
    this.writes.push(data.toString());
  }

  kill(): void {
    this.killed = true;
  }

  onData(): { dispose(): void } {
    return { dispose: () => undefined };
  }

  onExit(): { dispose(): void } {
    return { dispose: () => undefined };
  }
}

test("loads history lazily, resumes Claude, and follows clear session rotation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "persistence-integration-test-"));
  const stateDirectory = path.join(root, "state");
  const configDirectory = path.join(root, "claude");
  const runtimeRoot = path.join(root, "runtime");
  await mkdir(runtimeRoot, { recursive: true });
  const acpSessionId = "88888888-8888-4888-8888-888888888888";
  const claudeSessionId = "99999999-9999-4999-8999-999999999999";
  const nextClaudeSessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const cwd = "/work/load";
  const projectDirectory = path.join(configDirectory, "projects", escapeProjectDirName(cwd));
  const transcriptPath = path.join(projectDirectory, `${claudeSessionId}.jsonl`);
  await mkdir(projectDirectory, { recursive: true });
  await writeFile(
    transcriptPath,
    [
      JSON.stringify({ type: "user", uuid: "history-user", message: { content: "previous question" } }),
      JSON.stringify({ type: "assistant", uuid: "history-assistant", message: { content: [{ type: "text", text: "previous answer" }] } }),
      "",
    ].join("\n"),
  );
  const store = new StateStore(stateDirectory);
  await store.save({
    version: 1,
    acpSessionId,
    claudeSessionId,
    cwd,
    model: "inherit",
    mode: "default",
    lastActivity: 1,
  });
  const updates: SessionNotification[] = [];
  const connection = {
    sessionUpdate: async (notification: SessionNotification) => {
      updates.push(notification);
    },
    extNotification: async () => undefined,
  } as unknown as AgentSideConnection;
  const pty = new LoadFakePty();
  const spawns: string[][] = [];
  let agent!: ClaudeTtyAgent;
  const spawnPty = (_file: string, args: string[]): Pick<IPty, "pid" | "write" | "kill" | "onData" | "onExit"> => {
    spawns.push(args);
    const resumedId = args[args.indexOf("--resume") + 1];
    setImmediate(() => void agent.hooks.dispatch({ hook_event_name: "SessionStart", session_id: resumedId, source: "resume", transcript_path: transcriptPath }));
    return pty;
  };
  agent = new ClaudeTtyAgent(connection, { claudeConfigDir: configDirectory, runtimeRoot, stateDirectory, spawnPty, startupTimeoutMs: 500, readinessTimeoutMs: 0, submitDelayMs: 0, contextRefreshTimeoutMs: 0 });

  try {
    await agent.loadSession({ sessionId: acpSessionId, cwd, mcpServers: [] });
    assert.equal(spawns.length, 0);
    // The history follows the response rather than preceding it, so that the client has a session to
    // put it on; the command list closes the replay, which is what makes it the thing to wait for.
    await waitForCommands(updates);
    assert.deepEqual(updates.map((notification) => notification.update.sessionUpdate), ["user_message_chunk", "agent_message_chunk", "available_commands_update"]);

    const turn = agent.prompt({ sessionId: acpSessionId, prompt: [{ type: "text", text: "/clear" }] });
    await waitFor(() => pty.writes.length === 2);
    assert.deepEqual(spawns[0]?.slice(0, 2), ["--resume", claudeSessionId]);
    await agent.hooks.dispatch(
      { hook_event_name: "SessionStart", session_id: nextClaudeSessionId, source: "clear", transcript_path: path.join(projectDirectory, `${nextClaudeSessionId}.jsonl`) },
      claudeSessionId,
    );
    assert.equal((await store.load(acpSessionId))?.claudeSessionId, nextClaudeSessionId);
    await agent.hooks.dispatch({ hook_event_name: "Stop", session_id: nextClaudeSessionId, last_assistant_message: "Context cleared" });
    assert.deepEqual(await turn, { stopReason: "end_turn" });
  } finally {
    await agent.close();
    assert.equal(pty.killed, true);
    await rm(root, { force: true, recursive: true });
  }
});

test("closes the background agent a loaded session's history leaves running", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "persistence-agents-test-"));
  const stateDirectory = path.join(root, "state");
  const configDirectory = path.join(root, "claude");
  const runtimeRoot = path.join(root, "runtime");
  await mkdir(runtimeRoot, { recursive: true });
  const acpSessionId = "77777777-7777-4777-8777-777777777777";
  const claudeSessionId = "66666666-6666-4666-8666-666666666666";
  const cwd = "/work/agents-load";
  const projectDirectory = path.join(configDirectory, "projects", escapeProjectDirName(cwd));
  await mkdir(projectDirectory, { recursive: true });
  // An agent launched to run on its own is reported in a later user turn, which a session that
  // stopped while it ran never wrote.
  await writeFile(
    path.join(projectDirectory, `${claudeSessionId}.jsonl`),
    [
      JSON.stringify({
        type: "assistant",
        uuid: "launcher",
        message: { content: [{ type: "tool_use", id: "agent-tool", name: "Agent", input: { description: "Fix the findings" } }] },
      }),
      JSON.stringify({
        type: "user",
        uuid: "launched",
        toolUseResult: { isAsync: true, status: "async_launched", agentId: "a1" },
        message: { content: [{ type: "tool_result", tool_use_id: "agent-tool", content: [] }] },
      }),
      "",
    ].join("\n"),
  );
  await new StateStore(stateDirectory).save({
    version: 1,
    acpSessionId,
    claudeSessionId,
    cwd,
    model: "inherit",
    mode: "default",
    lastActivity: 1,
  });
  const updates: SessionNotification[] = [];
  const connection = {
    sessionUpdate: async (notification: SessionNotification) => {
      updates.push(notification);
    },
    extNotification: async () => undefined,
  } as unknown as AgentSideConnection;
  const agent = new ClaudeTtyAgent(connection, { claudeConfigDir: configDirectory, runtimeRoot, stateDirectory, startupTimeoutMs: 500, readinessTimeoutMs: 0 });

  try {
    await agent.loadSession({ sessionId: acpSessionId, cwd, mcpServers: [] });
    await waitForCommands(updates);
    const toolCalls = updates.map((notification) => notification.update).filter((update) => update.sessionUpdate === "tool_call_update");
    const closed = toolCalls.at(-1);
    assert.ok(closed?.sessionUpdate === "tool_call_update");
    assert.equal(closed.toolCallId, "agent-tool");
    assert.equal(closed.status, "failed");
  } finally {
    await agent.close();
    await rm(root, { force: true, recursive: true });
  }
});

test("sends a loaded session's history only after session/load has answered", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "persistence-ordering-test-"));
  const stateDirectory = path.join(root, "state");
  const configDirectory = path.join(root, "claude");
  const runtimeRoot = path.join(root, "runtime");
  await mkdir(runtimeRoot, { recursive: true });
  const acpSessionId = "55555555-5555-4555-8555-555555555555";
  const claudeSessionId = "44444444-4444-4444-8444-444444444444";
  const cwd = "/work/ordering";
  const projectDirectory = path.join(configDirectory, "projects", escapeProjectDirName(cwd));
  await mkdir(projectDirectory, { recursive: true });
  await writeFile(
    path.join(projectDirectory, `${claudeSessionId}.jsonl`),
    `${JSON.stringify({ type: "user", uuid: "u1", message: { content: [{ type: "text", text: "what did we decide" }] } })}\n`,
  );
  await new StateStore(stateDirectory).save({ version: 1, acpSessionId, claudeSessionId, cwd, model: "inherit", mode: "default", lastActivity: 1 });
  const updates: SessionNotification[] = [];
  const connection = {
    sessionUpdate: async (notification: SessionNotification) => {
      updates.push(notification);
    },
    extNotification: async () => undefined,
  } as unknown as AgentSideConnection;
  const agent = new ClaudeTtyAgent(connection, { claudeConfigDir: configDirectory, runtimeRoot, stateDirectory, startupTimeoutMs: 500, readinessTimeoutMs: 0 });

  try {
    await agent.loadSession({ sessionId: acpSessionId, cwd, mcpServers: [] });
    // The client has no session to put an update on until this call has answered, so the daemon drops
    // whatever arrived first -- and a resumed session comes up with an empty timeline while Claude
    // still holds the whole conversation.
    assert.equal(updates.length, 0, "nothing may be sent before session/load has answered");
    await waitForCommands(updates);
    assert.deepEqual(
      updates.map((notification) => notification.update.sessionUpdate),
      ["user_message_chunk", "available_commands_update"],
    );
  } finally {
    await agent.close();
    await rm(root, { force: true, recursive: true });
  }
});

/** A loaded session's replay is finished once its command list has gone out behind the history. */
async function waitForCommands(updates: SessionNotification[]): Promise<void> {
  await waitFor(() => updates.some((notification) => notification.update.sessionUpdate === "available_commands_update"));
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for resumed Claude prompt");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

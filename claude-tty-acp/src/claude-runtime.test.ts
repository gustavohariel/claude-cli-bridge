import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AgentSideConnection, RequestPermissionRequest, RequestPermissionResponse, SessionNotification } from "@agentclientprotocol/sdk";
import type { IPty, IPtyForkOptions } from "node-pty";
import { ClaudeTtyAgent, type ClaudeTtyAgentDependencies } from "./agent.ts";
import { StateStore } from "./state-store.ts";
import { subagentsDirectory } from "./subagent-transcript.ts";
import { TERMINAL_COLS, TERMINAL_ROWS } from "./terminal-screen.ts";
import { escapeProjectDirName } from "./transcript-reader.ts";
import { NOTICE_METHOD } from "./vendor-updates.ts";

/** What the runtime clears Claude's input box with before every paste: Ctrl-U, a key per write, until the box reads empty. */
const CLEAR_INPUT_LINE = "\u0015";
/** The clear stops after this many readings of an empty box, which is all an empty one costs. */
const CLEAR_INPUT_CONFIRMATIONS = 3;
/** And after this many keys that changed nothing, which is what a box it cannot empty costs. */
const CLEAR_INPUT_UNCHANGED = 4;
/** The key that moves a startup menu's marker down. */
const CURSOR_DOWN = "\u001b[B";

/**
 * The runtime waits are sized for a real Claude on a loaded host, and a fake PTY that answers at once only has to be outlasted by these.
 * Spread first, so a test about one of these waits still names its own.
 */
const TEST_TIMINGS = {
  readyQuietMs: 20,
  pasteEchoMs: 30,
  submitConfirmMs: 30,
  latePasteMs: 100,
  pasteSettleMs: 5,
  transcriptFlushIntervalMs: 2,
  clearInputKeyMs: 1,
  dialogPollMs: 10,
  dialogSettleMs: 50,
  dialogAnswerKeyMs: 5,
  dialogDismissMs: 50,
  workspaceTrustKeyDelayMs: 5,
  bypassPermissionsKeyDelayMs: 5,
  externalImportsKeyDelayMs: 5,
  staleResumeKeyDelayMs: 5,
} satisfies ClaudeTtyAgentDependencies;

// The adapter waits a 25ms poll after every key it sends a startup menu, so a menu a test expects answered needs a budget a loaded runner cannot spend on those polls alone.
// Only a run that is already failing ever reaches it.
const ANSWERED_MENU_TIMEOUT_MS = 1_000;

class FakePty {
  readonly pid: number;
  /** Every key the runtime sent, in order, the clear before each prompt included. */
  readonly keystrokes: string[] = [];
  killed = false;

  /**
   * The same without that clear. Nearly every test here counts or names the writes one prompt makes, and
   * a key sent ahead of all of them says nothing about any one of them; the tests about the clear itself
   * read `keystrokes`, through `keySequence` below.
   */
  get writes(): string[] {
    return this.keystrokes.filter((write) => write !== CLEAR_INPUT_LINE);
  }

  private readonly dataHandlers: Array<(data: string) => void> = [];
  private readonly exitHandlers: Array<(event: { exitCode: number; signal?: number }) => void> = [];
  private readonly writeHandler: ((data: string) => void) | undefined;

  constructor(pid: number, writeHandler?: (data: string) => void) {
    this.pid = pid;
    this.writeHandler = writeHandler;
  }

  write(data: string | Buffer): void {
    const text = data.toString();
    this.keystrokes.push(text);
    this.writeHandler?.(text);
  }

  kill(): void {
    this.killed = true;
  }

  onData(handler: (data: string) => void): { dispose(): void } {
    this.dataHandlers.push(handler);
    return { dispose: () => undefined };
  }

  onExit(handler: (event: { exitCode: number; signal?: number }) => void): { dispose(): void } {
    this.exitHandlers.push(handler);
    return { dispose: () => undefined };
  }

  emitData(data: string): void {
    for (const handler of this.dataHandlers) handler(data);
  }

  emitExit(): void {
    for (const handler of this.exitHandlers) handler({ exitCode: 0 });
  }
}

/**
 * The keys a prompt sent, with each run of clear keys collapsed into a single `clear`. The clear is one
 * key per write now -- a burst of them reaches Claude as text rather than as keys -- and how many it takes
 * is whatever the box on the screen said, so a test naming the writes around it reads that run as one
 * thing, and the tests about the clear itself count `clearKeys`.
 */
function keySequence(keystrokes: string[]): string[] {
  const sequence: string[] = [];
  for (const key of keystrokes) {
    if (key === CLEAR_INPUT_LINE) {
      if (sequence.at(-1) !== "clear") sequence.push("clear");
      continue;
    }
    sequence.push(key);
  }
  return sequence;
}

/**
 * The keys that answered a startup menu, with the run of down keys before the confirm collapsed into a single `down`.
 * The adapter presses down again whenever its next look finds the marker unmoved, and a runner that stalls past that
 * look before the fake repaints takes another, so how many downs it took is the runner's, not the test's.
 */
function menuKeys(keystrokes: string[]): string[] {
  const sequence: string[] = [];
  for (const key of keystrokes) {
    if (key === CURSOR_DOWN) {
      if (sequence.at(-1) !== "down") sequence.push("down");
      continue;
    }
    sequence.push(key);
  }
  return sequence;
}

/** How many keys the clear took, which is bounded by the height of the screen. */
function clearKeys(keystrokes: string[]): number {
  return keystrokes.filter((key) => key === CLEAR_INPUT_LINE).length;
}

type SpawnRecord = {
  file: string;
  args: string[];
  options: IPtyForkOptions;
  pty: FakePty;
};

function createConnection(updates: SessionNotification[]): AgentSideConnection {
  return {
    sessionUpdate: async (update: SessionNotification) => {
      updates.push(update);
    },
    extNotification: async () => undefined,
  } as unknown as AgentSideConnection;
}

test("keeps three parallel PTYs, hooks, cancellation, and attachments isolated", async () => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "claude-runtime-test-"));
  const spawns: SpawnRecord[] = [];
  const updates: SessionNotification[] = [];
  let agent!: ClaudeTtyAgent;
  const spawnPty = (file: string, args: string[], options: IPtyForkOptions): Pick<IPty, "pid" | "write" | "kill" | "onData" | "onExit"> => {
    const pty = new FakePty(1000 + spawns.length);
    spawns.push({ file, args, options, pty });
    const sessionId = args[args.indexOf("--session-id") + 1];
    setImmediate(() => void agent.hooks.dispatch({ hook_event_name: "SessionStart", session_id: sessionId }));
    return pty;
  };
  agent = new ClaudeTtyAgent(createConnection(updates), { ...TEST_TIMINGS, spawnPty, runtimeRoot, stateDirectory: path.join(runtimeRoot, "state"), startupTimeoutMs: 500, readinessTimeoutMs: 0, submitDelayMs: 0, contextRefreshTimeoutMs: 0 });

  try {
    const first = await agent.newSession({ cwd: "/work/one", mcpServers: [] });
    const second = await agent.newSession({ cwd: "/work/two", mcpServers: [] });
    const third = await agent.newSession({ cwd: "/work/three", mcpServers: [] });
    const firstTurn = agent.prompt({ sessionId: first.sessionId, prompt: [{ type: "text", text: "first $(safe)" }] });
    const secondTurn = agent.prompt({ sessionId: second.sessionId, prompt: [{ type: "text", text: "second" }] });
    const thirdTurn = agent.prompt({
      sessionId: third.sessionId,
      prompt: [
        { type: "text", text: "third" },
        { type: "image", mimeType: "image/png", data: Buffer.from("third-image").toString("base64") },
      ],
    });
    await waitFor(() => spawns.length === 3 && spawns.every((spawn) => spawn.pty.writes.length === 2));

    const firstSpawn = spawns.find((spawn) => spawn.args[1] === first.sessionId);
    const secondSpawn = spawns.find((spawn) => spawn.args[1] === second.sessionId);
    const thirdSpawn = spawns.find((spawn) => spawn.args[1] === third.sessionId);
    assert.equal(firstSpawn?.file, "claude");
    assert.deepEqual(firstSpawn?.args.slice(0, 2), ["--session-id", first.sessionId]);
    assert.equal(firstSpawn?.options.cwd, "/work/one");
    assert.equal(secondSpawn?.options.cwd, "/work/two");
    assert.equal(thirdSpawn?.options.cwd, "/work/three");
    assert.equal(firstSpawn?.pty.writes.join(""), "\u001b[200~first $(safe) \u001b[201~\r");
    assert.equal(secondSpawn?.pty.writes.join(""), "\u001b[200~second \u001b[201~\r");
    const attachment = /@(\/[^\u001b\n ]+\.png)/.exec(thirdSpawn?.pty.writes[0] ?? "")?.[1];
    assert.ok(attachment);
    assert.equal(thirdSpawn?.pty.writes[0], `\u001b[200~third\u001b[201~\n\u001b[200~@${attachment} \u001b[201~`);
    assert.equal(path.dirname(attachment), path.dirname(thirdSpawn!.args.at(-1)!));
    assert.notEqual(path.dirname(attachment), path.dirname(firstSpawn!.args.at(-1)!));

    await agent.cancel({ sessionId: second.sessionId });
    await Promise.all([
      agent.hooks.dispatch({ hook_event_name: "Stop", session_id: first.sessionId, last_assistant_message: "one done" }),
      agent.hooks.dispatch({ hook_event_name: "Stop", session_id: second.sessionId, last_assistant_message: "two done" }),
      agent.hooks.dispatch({ hook_event_name: "Stop", session_id: third.sessionId, last_assistant_message: "three done" }),
    ]);
    assert.deepEqual(await Promise.all([firstTurn, secondTurn, thirdTurn]), [{ stopReason: "end_turn" }, { stopReason: "cancelled" }, { stopReason: "end_turn" }]);
    await assert.rejects(stat(attachment), /ENOENT/);
    assert.deepEqual(
      updates.map((notification) => notification.update.sessionUpdate).filter((update) => update !== "available_commands_update"),
      ["agent_message_chunk", "agent_message_chunk"],
    );
  } finally {
    await agent.close();
    assert.ok(spawns.every((spawn) => spawn.pty.killed));
    assert.equal((await readdir(runtimeRoot)).some((name) => name.startsWith("claude-tty-acp-")), false);
    await rm(runtimeRoot, { force: true, recursive: true });
  }
});

test("lets the hooks that wait on a person wait a day, over a transport with no deadline of its own", async () => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "claude-runtime-test-"));
  const spawns: SpawnRecord[] = [];
  let agent!: ClaudeTtyAgent;
  const spawnPty = (file: string, args: string[], options: IPtyForkOptions): Pick<IPty, "pid" | "write" | "kill" | "onData" | "onExit"> => {
    const pty = new FakePty(1000 + spawns.length);
    spawns.push({ file, args, options, pty });
    setImmediate(() => void agent.hooks.dispatch({ hook_event_name: "SessionStart", session_id: args[args.indexOf("--session-id") + 1] }));
    return pty;
  };
  agent = new ClaudeTtyAgent(createConnection([]), { ...TEST_TIMINGS, spawnPty, runtimeRoot, stateDirectory: path.join(runtimeRoot, "state"), startupTimeoutMs: 500, readinessTimeoutMs: 0, submitDelayMs: 0, contextRefreshTimeoutMs: 0 });

  try {
    const session = await agent.newSession({ cwd: "/work/repo", mcpServers: [] });
    void agent.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "hello" }] });
    await waitFor(() => spawns.length === 1);
    const settingsPath = spawns[0]!.args[spawns[0]!.args.indexOf("--settings") + 1]!;
    const hooks = (JSON.parse(await readFile(settingsPath, "utf8")) as { hooks: Record<string, Array<{ hooks: Array<{ timeout: number }> }>> }).hooks;
    const client = await readFile(path.join(path.dirname(settingsPath), "hook-client.mjs"), "utf8");

    // A card that waits on a person must outlive any reading of it, and the timeout only means what the transport allows.
    // Claude kills the hook at its timeout and resolves the call without the answer the user is still typing; fetch would do the same at undici's 300 second headersTimeout.
    assert.equal(hooks.PreToolUse?.[0]?.hooks[0]?.timeout, 86_400);
    assert.equal(hooks.PermissionRequest?.[0]?.hooks[0]?.timeout, 86_400);
    assert.equal(hooks.SessionStart?.[0]?.hooks[0]?.timeout, 30);
    assert.match(client, /import http from "node:http"/);
    assert.doesNotMatch(client, /fetch\(/);
    assert.deepEqual(await runHookClient(path.join(path.dirname(settingsPath), "hook-client.mjs"), {
      hook_event_name: "PreToolUse",
      session_id: spawns[0]!.args[1]!,
      tool_name: "Bash",
      tool_input: { command: "pwd" },
    }), { code: 0, stdout: "{}" });
  } finally {
    await agent.close();
    await rm(runtimeRoot, { force: true, recursive: true });
  }
});

test("cancels an active turn with Escape", async () => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "claude-runtime-test-"));
  let agent!: ClaudeTtyAgent;
  let spawned: FakePty | null = null;
  const spawnPty = (_file: string, args: string[]): Pick<IPty, "pid" | "write" | "kill" | "onData" | "onExit"> => {
    spawned = new FakePty(2000);
    const sessionId = args[args.indexOf("--session-id") + 1];
    setImmediate(() => void agent.hooks.dispatch({ hook_event_name: "SessionStart", session_id: sessionId }));
    return spawned;
  };
  agent = new ClaudeTtyAgent(createConnection([]), { ...TEST_TIMINGS, spawnPty, runtimeRoot, stateDirectory: path.join(runtimeRoot, "state"), startupTimeoutMs: 500, readinessTimeoutMs: 0, cancelTimeoutMs: 5, submitDelayMs: 0, contextRefreshTimeoutMs: 0 });

  try {
    const session = await agent.newSession({ cwd: "/work/cancel", mcpServers: [] });
    const turn = agent.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "cancel me" }] });
    await waitFor(() => spawned !== null && spawned.writes.length === 2);
    await agent.cancel({ sessionId: session.sessionId });
    assert.deepEqual(await turn, { stopReason: "cancelled" });
    assert.equal((spawned as FakePty | null)?.writes.at(-1), "\u001b");
  } finally {
    await agent.close();
    await rm(runtimeRoot, { force: true, recursive: true });
  }
});

test("fails closed when Claude never completes the startup hook", async () => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "claude-runtime-test-"));
  const pty = new FakePty(3000);
  const agent = new ClaudeTtyAgent(createConnection([]), {
    ...TEST_TIMINGS,
    spawnPty: () => pty,
    runtimeRoot,
    stateDirectory: path.join(runtimeRoot, "state"),
    startupTimeoutMs: 5,
    readinessTimeoutMs: 0,
    submitDelayMs: 0, contextRefreshTimeoutMs: 0,
  });

  try {
    const session = await agent.newSession({ cwd: "/work/blocked", mcpServers: [] });
    await assert.rejects(
      agent.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "hello" }] }),
      /SessionStart hook handshake/,
    );
    assert.equal(pty.killed, true);
    assert.equal((await readdir(runtimeRoot)).some((name) => name.startsWith("claude-tty-acp-")), false);
  } finally {
    await agent.close();
    await rm(runtimeRoot, { force: true, recursive: true });
  }
});

test("asks through ACP before accepting Claude workspace trust", async () => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "claude-runtime-trust-test-"));
  const cwd = "/work/new-project";
  const permissionRequests: RequestPermissionRequest[] = [];
  let agent!: ClaudeTtyAgent;
  let spawned: FakePty | null = null;
  const connection = {
    sessionUpdate: async () => undefined,
    requestPermission: async (request: RequestPermissionRequest): Promise<RequestPermissionResponse> => {
      permissionRequests.push(request);
      return { outcome: { outcome: "selected", optionId: "trust-workspace" } };
    },
    extNotification: async () => undefined,
  } as unknown as AgentSideConnection;
  const spawnPty = (_file: string, args: string[]): Pick<IPty, "pid" | "write" | "kill" | "onData" | "onExit"> => {
    const sessionId = args[args.indexOf("--session-id") + 1]!;
    let confirmed = false;
    const pty = new FakePty(3100, (data) => {
      if (data === "\u001b[B") {
        setImmediate(() => pty.emitData("\r\n  No, exit\r\n❯ Yes, I trust this folder\r\nEnter to confirm · Esc to cancel"));
      }
      // Claude runs SessionStart once, after the trust screen is confirmed; the later submit key is not a second startup.
      if (data === "\r" && !confirmed) {
        confirmed = true;
        setImmediate(() => void agent.hooks.dispatch({ hook_event_name: "SessionStart", session_id: sessionId }));
      }
    });
    spawned = pty;
    setImmediate(() => pty.emitData(workspaceTrustScreen(cwd)));
    return pty;
  };
  agent = new ClaudeTtyAgent(connection, {
    ...TEST_TIMINGS,
    spawnPty,
    runtimeRoot,
    stateDirectory: path.join(runtimeRoot, "state"),
    startupTimeoutMs: 500,
    readinessTimeoutMs: 0,
    submitDelayMs: 0, contextRefreshTimeoutMs: 0,
    clearInputKeyMs: 0,
    workspaceTrustKeyDelayMs: 0,
    workspaceTrustSelectionTimeoutMs: ANSWERED_MENU_TIMEOUT_MS,
  });

  try {
    const session = await agent.newSession({ cwd, mcpServers: [] });
    const turn = agent.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "hello" }] });
    await waitFor(() => permissionRequests.length === 1 && spawned !== null && menuKeys(spawned.writes).length === 4);
    assert.equal(permissionRequests[0]!.toolCall.title, "Is this a project you created or one you trust?");
    assert.deepEqual(permissionRequests[0]!.toolCall.locations, [{ path: cwd }]);
    assert.deepEqual(permissionRequests[0]!.options, [
      { optionId: "deny-workspace", name: "No, exit", kind: "reject_once" },
      { optionId: "trust-workspace", name: "Yes, trust this folder", kind: "reject_once" },
    ]);
    assert.deepEqual(menuKeys((spawned as unknown as FakePty).writes), ["down", "\r", "\u001b[200~hello \u001b[201~", "\r"]);
    await agent.hooks.dispatch({ hook_event_name: "Stop", session_id: session.sessionId, last_assistant_message: "done" });
    assert.deepEqual(await turn, { stopReason: "end_turn" });
  } finally {
    await agent.close();
    await rm(runtimeRoot, { force: true, recursive: true });
  }
});

test("never confirms workspace trust unless Claude visibly selects Yes", async () => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "claude-runtime-trust-selection-test-"));
  const cwd = "/work/selection-ignored";
  const pty = new FakePty(3150);
  const connection = {
    sessionUpdate: async () => undefined,
    requestPermission: async (): Promise<RequestPermissionResponse> => ({ outcome: { outcome: "selected", optionId: "trust-workspace" } }),
    extNotification: async () => undefined,
  } as unknown as AgentSideConnection;
  const agent = new ClaudeTtyAgent(connection, {
    ...TEST_TIMINGS,
    spawnPty: () => {
      setImmediate(() => pty.emitData(workspaceTrustScreen(cwd)));
      return pty;
    },
    runtimeRoot,
    stateDirectory: path.join(runtimeRoot, "state"),
    startupTimeoutMs: 500,
    readinessTimeoutMs: 0,
    submitDelayMs: 0,
    workspaceTrustKeyDelayMs: 0,
    workspaceTrustSelectionTimeoutMs: 200,
  });

  try {
    const session = await agent.newSession({ cwd, mcpServers: [] });
    await assert.rejects(
      agent.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "hello" }] }),
      /did not select the workspace trust option/,
    );
    // How many times it presses down before giving up depends on the runner; that it only ever presses down does not.
    assert.ok(pty.writes.length > 0);
    assert.ok(pty.writes.every((write) => write === "\u001b[B"), `pressed something other than down: ${JSON.stringify(pty.writes)}`);
    assert.equal(pty.killed, true);
  } finally {
    await agent.close();
    await rm(runtimeRoot, { force: true, recursive: true });
  }
});

test("fails closed when Claude workspace trust is denied", async () => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "claude-runtime-trust-denied-test-"));
  const cwd = "/work/untrusted-project";
  const pty = new FakePty(3200);
  const connection = {
    sessionUpdate: async () => undefined,
    requestPermission: async (): Promise<RequestPermissionResponse> => ({ outcome: { outcome: "selected", optionId: "deny-workspace" } }),
    extNotification: async () => undefined,
  } as unknown as AgentSideConnection;
  const agent = new ClaudeTtyAgent(connection, {
    ...TEST_TIMINGS,
    spawnPty: () => {
      setImmediate(() => pty.emitData(workspaceTrustScreen(cwd)));
      return pty;
    },
    runtimeRoot,
    stateDirectory: path.join(runtimeRoot, "state"),
    startupTimeoutMs: 500,
    readinessTimeoutMs: 0,
    submitDelayMs: 0,
  });

  try {
    const session = await agent.newSession({ cwd, mcpServers: [] });
    await assert.rejects(
      agent.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "hello" }] }),
      /requires workspace trust.*not approved in Paseo/,
    );
    assert.deepEqual(pty.writes, []);
    assert.equal(pty.killed, true);
    assert.equal((await readdir(runtimeRoot)).some((name) => name.startsWith("claude-tty-acp-")), false);
  } finally {
    await agent.close();
    await rm(runtimeRoot, { force: true, recursive: true });
  }
});

const EXTERNAL_IMPORTS = ["/home/node/rbms-legacy-lab/AGENTS.md", "/srv/house-style/CONVENTIONS.md"];

test("asks through ACP before letting a CLAUDE.md import files from outside the workspace", async () => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "claude-runtime-imports-test-"));
  const cwd = "/work/imports";
  const permissionRequests: RequestPermissionRequest[] = [];
  let agent!: ClaudeTtyAgent;
  let spawned: FakePty | null = null;
  const connection = {
    sessionUpdate: async () => undefined,
    requestPermission: async (request: RequestPermissionRequest): Promise<RequestPermissionResponse> => {
      permissionRequests.push(request);
      return { outcome: { outcome: "selected", optionId: "allow-external-imports" } };
    },
    extNotification: async () => undefined,
  } as unknown as AgentSideConnection;
  const spawnPty = (_file: string, args: string[]): Pick<IPty, "pid" | "write" | "kill" | "onData" | "onExit"> => {
    const sessionId = args[args.indexOf("--session-id") + 1]!;
    let answered = false;
    const pty = new FakePty(5700, (data) => {
      if (data === "[B") setImmediate(() => pty.emitData(externalImportsScreen("allow")));
      // Claude reads the CLAUDE.md, and so reaches its SessionStart hook, only once this is answered.
      if (data === "\r" && !answered) {
        answered = true;
        setImmediate(() => void agent.hooks.dispatch({ hook_event_name: "SessionStart", session_id: sessionId }));
      }
    });
    spawned = pty;
    setImmediate(() => pty.emitData(externalImportsScreen("disable")));
    return pty;
  };
  agent = new ClaudeTtyAgent(connection, {
    ...TEST_TIMINGS,
    spawnPty,
    runtimeRoot,
    stateDirectory: path.join(runtimeRoot, "state"),
    startupTimeoutMs: 500,
    readinessTimeoutMs: 0,
    submitDelayMs: 0,
    contextRefreshTimeoutMs: 0,
    clearInputKeyMs: 0,
    externalImportsKeyDelayMs: 0,
    externalImportsSelectionTimeoutMs: ANSWERED_MENU_TIMEOUT_MS,
  });

  try {
    const session = await agent.newSession({ cwd, mcpServers: [] });
    const turn = agent.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "hello" }] });
    await waitFor(() => permissionRequests.length === 1 && spawned !== null && menuKeys(spawned.writes).length === 4);
    assert.equal(permissionRequests[0]!.toolCall.title, "Let this project's CLAUDE.md import files from outside it?");
    // The files are the question, so the card has to carry the ones Claude listed rather than the words around them.
    assert.deepEqual((permissionRequests[0]!.toolCall.rawInput as { imports?: string[] }).imports, EXTERNAL_IMPORTS);
    assert.deepEqual(permissionRequests[0]!.options, [
      { optionId: "disable-external-imports", name: "No, disable external imports", kind: "reject_once" },
      { optionId: "allow-external-imports", name: "Yes, allow external imports", kind: "reject_once" },
    ]);
    assert.deepEqual(menuKeys((spawned as unknown as FakePty).writes), ["down", "\r", "\u001b[200~hello \u001b[201~", "\r"]);
    await agent.hooks.dispatch({ hook_event_name: "Stop", session_id: session.sessionId, last_assistant_message: "done" });
    assert.deepEqual(await turn, { stopReason: "end_turn" });
  } finally {
    await agent.close();
    await rm(runtimeRoot, { force: true, recursive: true });
  }
});

// The one consent card a refusal does not fail the start on: Claude runs without the imports, and a
// session that runs is worth more than the files it was refused.
test("starts without the external imports, and says so, when the card is declined", async () => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "claude-runtime-imports-declined-test-"));
  const vendor: Array<{ method: string; params: Record<string, unknown> }> = [];
  let agent!: ClaudeTtyAgent;
  let spawned: FakePty | null = null;
  const connection = {
    sessionUpdate: async () => undefined,
    requestPermission: async (): Promise<RequestPermissionResponse> => ({ outcome: { outcome: "selected", optionId: "disable-external-imports" } }),
    extNotification: async (method: string, params: Record<string, unknown>) => {
      vendor.push({ method, params });
    },
  } as unknown as AgentSideConnection;
  const spawnPty = (_file: string, args: string[]): Pick<IPty, "pid" | "write" | "kill" | "onData" | "onExit"> => {
    const sessionId = args[args.indexOf("--session-id") + 1]!;
    let answered = false;
    const pty = new FakePty(5800, (data) => {
      if (data === "\r" && !answered) {
        answered = true;
        setImmediate(() => void agent.hooks.dispatch({ hook_event_name: "SessionStart", session_id: sessionId }));
      }
    });
    spawned = pty;
    setImmediate(() => pty.emitData(externalImportsScreen("disable")));
    return pty;
  };
  agent = new ClaudeTtyAgent(connection, {
    ...TEST_TIMINGS,
    spawnPty,
    runtimeRoot,
    stateDirectory: path.join(runtimeRoot, "state"),
    startupTimeoutMs: 500,
    readinessTimeoutMs: 0,
    submitDelayMs: 0,
    contextRefreshTimeoutMs: 0,
    clearInputKeyMs: 0,
    externalImportsKeyDelayMs: 0,
    externalImportsSelectionTimeoutMs: ANSWERED_MENU_TIMEOUT_MS,
  });

  try {
    const session = await agent.newSession({ cwd: "/work/imports-declined", mcpServers: [] });
    const turn = agent.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "hello" }] });
    await waitFor(() => spawned !== null && spawned.writes.length === 3);
    // Claude's own marker starts on No, so the refusal is confirmed where it stands and no row is walked.
    assert.deepEqual((spawned as unknown as FakePty).writes, ["\r", "[200~hello [201~", "\r"]);
    assert.equal((spawned as unknown as FakePty).killed, false);
    const notice = vendor.find((update) => update.method === NOTICE_METHOD)?.params.notice as { title: string; description: string } | undefined;
    assert.equal(notice?.title, "External CLAUDE.md imports are disabled for this session");
    // Which files the session is missing, or the notice explains nothing anybody can act on.
    for (const file of EXTERNAL_IMPORTS) assert.ok(notice?.description.includes(file), `notice names ${file}`);
    await agent.hooks.dispatch({ hook_event_name: "Stop", session_id: session.sessionId, last_assistant_message: "done" });
    assert.deepEqual(await turn, { stopReason: "end_turn" });
  } finally {
    await agent.close();
    await rm(runtimeRoot, { force: true, recursive: true });
  }
});

// Claude answers its own dialogs sometimes -- a remembered project, a key that arrived from somewhere
// else -- and the answer this side was given is then about a question nobody is asking.
test("presses nothing when Claude's external-imports question goes before the card is answered", async () => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "claude-runtime-imports-gone-test-"));
  const vendor: Array<{ method: string; params: Record<string, unknown> }> = [];
  let agent!: ClaudeTtyAgent;
  let spawned: FakePty | null = null;
  let asked = false;
  const connection = {
    sessionUpdate: async () => undefined,
    requestPermission: async (): Promise<RequestPermissionResponse> => {
      asked = true;
      // Claude has moved on by the time the answer comes back, which is the whole of this case.
      spawned?.emitData(freshModeScreen("auto mode on"));
      return { outcome: { outcome: "selected", optionId: "disable-external-imports" } };
    },
    extNotification: async (method: string, params: Record<string, unknown>) => {
      vendor.push({ method, params });
    },
  } as unknown as AgentSideConnection;
  const spawnPty = (_file: string, args: string[]): Pick<IPty, "pid" | "write" | "kill" | "onData" | "onExit"> => {
    const sessionId = args[args.indexOf("--session-id") + 1]!;
    const pty = new FakePty(5900);
    spawned = pty;
    setImmediate(() => {
      pty.emitData(externalImportsScreen("disable"));
      setTimeout(() => void agent.hooks.dispatch({ hook_event_name: "SessionStart", session_id: sessionId }), 50);
    });
    return pty;
  };
  agent = new ClaudeTtyAgent(connection, {
    ...TEST_TIMINGS,
    spawnPty,
    runtimeRoot,
    stateDirectory: path.join(runtimeRoot, "state"),
    startupTimeoutMs: 1_000,
    readinessTimeoutMs: 0,
    submitDelayMs: 0,
    contextRefreshTimeoutMs: 0,
    clearInputKeyMs: 0,
    externalImportsKeyDelayMs: 0,
    externalImportsSelectionTimeoutMs: ANSWERED_MENU_TIMEOUT_MS,
  });

  try {
    const session = await agent.newSession({ cwd: "/work/imports-gone", mcpServers: [] });
    const turn = agent.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "hello" }] });
    await waitFor(() => spawned !== null && spawned.writes.length === 2, 3_000);
    // The dialog was recognised and carded; what follows is about what became of the answer.
    assert.equal(asked, true);
    // Only the prompt: an Enter sent at a dialog that has gone lands wherever Claude is now.
    assert.deepEqual((spawned as unknown as FakePty).writes, ["[200~hello [201~", "\r"]);
    // And nothing is claimed about a session whose answer the adapter never gave.
    assert.deepEqual(vendor.filter((update) => update.method === NOTICE_METHOD), []);
    await agent.hooks.dispatch({ hook_event_name: "Stop", session_id: session.sessionId, last_assistant_message: "done" });
    assert.deepEqual(await turn, { stopReason: "end_turn" });
  } finally {
    await agent.close();
    await rm(runtimeRoot, { force: true, recursive: true });
  }
});

test("submits a prompt taller than Claude's input box once, reading the box from whichever of its lines Claude scrolled to", async () => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "claude-runtime-tall-test-"));
  let agent!: ClaudeTtyAgent;
  let pty!: FakePty;
  const spawnPty = (_file: string, args: string[]): Pick<IPty, "pid" | "write" | "kill" | "onData" | "onExit"> => {
    pty = new FakePty(6800, (text) => {
      // The box scrolled to the cursor, at the end of the prompt, with its first visible line wherever that leaves it.
      if (text.includes("\u001b[200~")) pty.emitData(`\u001b[2J\u001b[H\u276f line 120:    some   text\r\n${Array.from({ length: 10 }, (_, index) => `  line ${290 + index}: some text\r\n`).join("")}`);
      if (text === "\r") pty.emitData("\u001b[2J\u001b[H\u276f\r\n");
    });
    const sessionId = args[args.indexOf("--session-id") + 1];
    setImmediate(() => void agent.hooks.dispatch({ hook_event_name: "SessionStart", session_id: sessionId }));
    return pty;
  };
  agent = new ClaudeTtyAgent(createConnection([]), { ...TEST_TIMINGS, spawnPty, runtimeRoot, stateDirectory: path.join(runtimeRoot, "state"), startupTimeoutMs: 500, readinessTimeoutMs: 0, submitDelayMs: 0, contextRefreshTimeoutMs: 0 });

  try {
    const session = await agent.newSession({ cwd: "/work/tall", mcpServers: [] });
    const text = Array.from({ length: 300 }, (_, index) => `line ${index}: some text`).join("\n");
    const turn = agent.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text }] });
    await waitFor(() => pty !== undefined && pty.writes.at(-1) === "\r");
    const pasted = pty.writes.slice(0, -1);
    assert.ok(pasted.length > 1, "a prompt this long goes in several writes");
    assert.equal(pasted.join("").replace(/\u001b\[20[01]~/g, ""), `${text} `);
    assert.equal(pty.writes.filter((write) => write === "\r").length, 1);
    await agent.hooks.dispatch({ hook_event_name: "Stop", session_id: session.sessionId, last_assistant_message: "done" });
    assert.deepEqual(await turn, { stopReason: "end_turn" });
  } finally {
    await agent.close();
    await rm(runtimeRoot, { force: true, recursive: true });
  }
});

test("applies native model and mode controls and restarts an idle session", async () => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "claude-runtime-test-"));
  const spawns: SpawnRecord[] = [];
  let agent!: ClaudeTtyAgent;
  const spawnPty = (file: string, args: string[], options: IPtyForkOptions): Pick<IPty, "pid" | "write" | "kill" | "onData" | "onExit"> => {
    let pty!: FakePty;
    pty = new FakePty(4000 + spawns.length, (data) => {
      if (data === "\u0004") setImmediate(() => pty.emitExit());
    });
    spawns.push({ file, args, options, pty });
    const idFlag = args.includes("--resume") ? "--resume" : "--session-id";
    const sessionId = args[args.indexOf(idFlag) + 1];
    setImmediate(() => void agent.hooks.dispatch({ hook_event_name: "SessionStart", session_id: sessionId }));
    return pty;
  };
  agent = new ClaudeTtyAgent(createConnection([]), { ...TEST_TIMINGS, spawnPty, runtimeRoot, stateDirectory: path.join(runtimeRoot, "state"), startupTimeoutMs: 500, readinessTimeoutMs: 0, submitDelayMs: 0, contextRefreshTimeoutMs: 0 });

  try {
    const created = await agent.newSession({ cwd: "/work/controls", mcpServers: [] });
    await agent.unstable_setSessionModel({ sessionId: created.sessionId, modelId: "claude-opus-5" });
    await agent.setSessionMode({ sessionId: created.sessionId, modeId: "plan" });
    const turn = agent.prompt({ sessionId: created.sessionId, prompt: [{ type: "text", text: "plan it" }] });
    await waitFor(() => spawns.length === 1 && spawns[0]!.pty.writes.length === 2);
    assert.deepEqual(spawns[0]!.args.slice(0, 6), ["--session-id", created.sessionId, "--model", "claude-opus-5", "--permission-mode", "plan"]);
    await assert.rejects(agent.setSessionMode({ sessionId: created.sessionId, modeId: "auto" }), /active turn/);
    await agent.hooks.dispatch({ hook_event_name: "Stop", session_id: created.sessionId, last_assistant_message: "planned" });
    await turn;

    await agent.unstable_setSessionModel({ sessionId: created.sessionId, modelId: "sonnet" });
    assert.equal(spawns.length, 2);
    assert.deepEqual(spawns[1]!.args.slice(0, 6), ["--resume", created.sessionId, "--model", "sonnet", "--permission-mode", "plan"]);
    assert.equal(spawns[0]!.pty.writes.at(-1), "\u0004");
  } finally {
    await agent.close();
    await rm(runtimeRoot, { force: true, recursive: true });
  }
});

test("launches Claude at the effort a config option chose and restarts an idle session to change it", async () => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "claude-runtime-effort-test-"));
  const spawns: SpawnRecord[] = [];
  const updates: SessionNotification[] = [];
  let agent!: ClaudeTtyAgent;
  const spawnPty = (file: string, args: string[], options: IPtyForkOptions): Pick<IPty, "pid" | "write" | "kill" | "onData" | "onExit"> => {
    let pty!: FakePty;
    pty = new FakePty(4200 + spawns.length, (data) => {
      if (data === "") setImmediate(() => pty.emitExit());
    });
    spawns.push({ file, args, options, pty });
    const idFlag = args.includes("--resume") ? "--resume" : "--session-id";
    const sessionId = args[args.indexOf(idFlag) + 1];
    setImmediate(() => void agent.hooks.dispatch({ hook_event_name: "SessionStart", session_id: sessionId }));
    return pty;
  };
  agent = new ClaudeTtyAgent(createConnection(updates), { ...TEST_TIMINGS, spawnPty, runtimeRoot, stateDirectory: path.join(runtimeRoot, "state"), startupTimeoutMs: 500, readinessTimeoutMs: 0, submitDelayMs: 0, contextRefreshTimeoutMs: 0 });

  try {
    const created = await agent.newSession({ cwd: "/work/effort", mcpServers: [] });
    const set = await agent.setSessionConfigOption({ sessionId: created.sessionId, configId: "effort", value: "xhigh" });
    assert.equal(set.configOptions.find((option) => option.category === "thought_level")?.currentValue, "xhigh");

    const turn = agent.prompt({ sessionId: created.sessionId, prompt: [{ type: "text", text: "think it over" }] });
    await waitFor(() => spawns.length === 1 && spawns[0]!.pty.writes.length === 2);
    assert.deepEqual(spawns[0]!.args.slice(0, 4), ["--session-id", created.sessionId, "--effort", "xhigh"]);
    await assert.rejects(agent.setSessionConfigOption({ sessionId: created.sessionId, configId: "effort", value: "low" }), /active turn/);
    await agent.hooks.dispatch({ hook_event_name: "Stop", session_id: created.sessionId, last_assistant_message: "thought" });
    await turn;

    await agent.setSessionConfigOption({ sessionId: created.sessionId, configId: "model", value: "claude-opus-5" });
    assert.equal(spawns.length, 2);
    assert.deepEqual(spawns[1]!.args.slice(0, 6), ["--resume", created.sessionId, "--model", "claude-opus-5", "--effort", "xhigh"]);
    assert.equal(updates.filter((update) => update.update.sessionUpdate === "config_option_update").length, 2);

    await assert.rejects(agent.setSessionConfigOption({ sessionId: created.sessionId, configId: "verbosity", value: "loud" }), /Unsupported configuration option verbosity/);
    await assert.rejects(agent.setSessionConfigOption({ sessionId: created.sessionId, configId: "model", type: "boolean", value: true }), /not a boolean/);
  } finally {
    await agent.close();
    await rm(runtimeRoot, { force: true, recursive: true });
  }
});

test("suspends an idle native process and resumes it on the next prompt", async () => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "claude-runtime-idle-test-"));
  const spawns: SpawnRecord[] = [];
  let agent!: ClaudeTtyAgent;
  const spawnPty = (file: string, args: string[], options: IPtyForkOptions): Pick<IPty, "pid" | "write" | "kill" | "onData" | "onExit"> => {
    let pty!: FakePty;
    pty = new FakePty(4500 + spawns.length, (data) => {
      if (data === "\u0004") setImmediate(() => pty.emitExit());
    });
    spawns.push({ file, args, options, pty });
    const idFlag = args.includes("--resume") ? "--resume" : "--session-id";
    const sessionId = args[args.indexOf(idFlag) + 1];
    setImmediate(() => void agent.hooks.dispatch({ hook_event_name: "SessionStart", session_id: sessionId }));
    return pty;
  };
  agent = new ClaudeTtyAgent(createConnection([]), {
    ...TEST_TIMINGS,
    spawnPty,
    runtimeRoot,
    stateDirectory: path.join(runtimeRoot, "state"),
    startupTimeoutMs: 500,
    readinessTimeoutMs: 0,
    submitDelayMs: 0,
    contextRefreshTimeoutMs: 0,
    idleTimeoutMs: 20,
  });

  try {
    const created = await agent.newSession({ cwd: "/work/idle-resume", mcpServers: [] });
    const first = agent.prompt({ sessionId: created.sessionId, prompt: [{ type: "text", text: "first" }] });
    await waitFor(() => spawns.length === 1 && spawns[0]!.pty.writes.length === 2);
    await agent.hooks.dispatch({ hook_event_name: "Stop", session_id: created.sessionId, last_assistant_message: "first done" });
    await first;
    await waitFor(() => agent.sessions.get(created.sessionId)?.started === false);
    assert.equal(spawns[0]!.pty.writes.at(-1), "\u0004");

    const second = agent.prompt({ sessionId: created.sessionId, prompt: [{ type: "text", text: "second" }] });
    await waitFor(() => spawns.length === 2 && spawns[1]!.pty.writes.length === 2);
    assert.deepEqual(spawns[1]!.args.slice(0, 2), ["--resume", created.sessionId]);
    await agent.hooks.dispatch({ hook_event_name: "Stop", session_id: created.sessionId, last_assistant_message: "second done" });
    await second;
  } finally {
    await agent.close();
    await rm(runtimeRoot, { force: true, recursive: true });
  }
});

// Long enough to outlast a runner with every package's suite on it stalling the event loop for most of a second, on top of the 200ms between subagent transcript reads.
const IDLE_TIMEOUT_MS = 2_000;
const IDLE_STEP_MS = 250;
// Twice the timeout's worth of steps, so a session that did not count them would be suspended halfway through.
const IDLE_STEPS = (2 * IDLE_TIMEOUT_MS) / IDLE_STEP_MS;
const IDLE_SUSPENSION_WAIT_MS = IDLE_TIMEOUT_MS + 3_000;

/**
 * A session for the idle tests: a fake PTY that exits on Ctrl-D, a config directory the transcript
 * watcher reads, and an idle timeout short enough to watch run out.
 */
async function createIdleHarness(name: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), `claude-runtime-${name}-`));
  const configDirectory = path.join(root, "claude");
  const cwd = `/work/${name}`;
  const projectDirectory = path.join(configDirectory, "projects", escapeProjectDirName(cwd));
  await mkdir(projectDirectory, { recursive: true });
  await mkdir(path.join(root, "runtime"), { recursive: true });
  const spawns: SpawnRecord[] = [];
  let agent!: ClaudeTtyAgent;
  const spawnPty = (file: string, args: string[], options: IPtyForkOptions): Pick<IPty, "pid" | "write" | "kill" | "onData" | "onExit"> => {
    let pty!: FakePty;
    pty = new FakePty(4600 + spawns.length, (data) => {
      if (data === "\u0004") setImmediate(() => pty.emitExit());
    });
    spawns.push({ file, args, options, pty });
    const idFlag = args.includes("--resume") ? "--resume" : "--session-id";
    const sessionId = args[args.indexOf(idFlag) + 1];
    setImmediate(() => void agent.hooks.dispatch({ hook_event_name: "SessionStart", session_id: sessionId }));
    return pty;
  };
  agent = new ClaudeTtyAgent(createConnection([]), {
    ...TEST_TIMINGS,
    spawnPty,
    runtimeRoot: path.join(root, "runtime"),
    claudeConfigDir: configDirectory,
    stateDirectory: path.join(root, "state"),
    startupTimeoutMs: 500,
    readinessTimeoutMs: 0,
    submitDelayMs: 0,
    contextRefreshTimeoutMs: 0,
    transcriptPollIntervalMs: 10,
    idleTimeoutMs: IDLE_TIMEOUT_MS,
  });
  const session = await agent.newSession({ cwd, mcpServers: [] });
  const turn = agent.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "start" }] });
  await waitFor(() => spawns.length === 1 && spawns[0]!.pty.writes.length === 2);
  await agent.hooks.dispatch({ hook_event_name: "Stop", session_id: session.sessionId, last_assistant_message: "started" });
  await turn;
  const started = () => agent.sessions.get(session.sessionId)?.started === true;
  const transcript = path.join(projectDirectory, `${session.sessionId}.jsonl`);
  return {
    agent,
    sessionId: session.sessionId,
    transcript,
    started,
    close: async () => {
      await agent.close();
      await rm(root, { force: true, recursive: true });
    },
  };
}

test("does not suspend a session whose background agent is still writing", async () => {
  const harness = await createIdleHarness("idle-subagent");
  try {
    // The turn is over and nothing was launched inside it: as far as prompts go, the session is idle.
    // But an agent Claude started on its own is writing, and that is the session working.
    const directory = subagentsDirectory(harness.transcript);
    await mkdir(directory, { recursive: true });
    const steps: string[] = [];
    for (let index = 0; index < IDLE_STEPS; index += 1) {
      steps.push(JSON.stringify({ type: "assistant", uuid: `step-${index}`, message: { content: [{ type: "text", text: `step ${index}` }] } }));
      await writeFile(path.join(directory, "agent-a1.jsonl"), `${steps.join("\n")}\n`);
      await new Promise((resolve) => setTimeout(resolve, IDLE_STEP_MS));
      assert.equal(harness.started(), true, `suspended while the agent was writing, at step ${index}`);
    }
    // The agent has gone quiet, and now the idle timeout is what it always was.
    await waitFor(() => !harness.started(), IDLE_SUSPENSION_WAIT_MS);
  } finally {
    await harness.close();
  }
});

test("does not suspend a session Claude is still working in after its prompt ended", async () => {
  const harness = await createIdleHarness("idle-own-turn");
  try {
    // A task notification woke Claude for a turn of its own; it writes records and calls hooks, and
    // none of that is a Paseo prompt.
    const records: string[] = [];
    for (let index = 0; index < IDLE_STEPS; index += 1) {
      if (index % 2 === 0) {
        records.push(JSON.stringify({ type: "assistant", uuid: `own-${index}`, message: { content: [{ type: "text", text: `answering, part ${index}` }] } }));
        await writeFile(harness.transcript, `${records.join("\n")}\n`);
      } else {
        await harness.agent.hooks.dispatch({ hook_event_name: "PreToolUse", session_id: harness.sessionId, tool_name: "Bash", tool_input: { command: "ls" } });
      }
      await new Promise((resolve) => setTimeout(resolve, IDLE_STEP_MS));
      assert.equal(harness.started(), true, `suspended while Claude was working, at step ${index}`);
    }
    await waitFor(() => !harness.started(), IDLE_SUSPENSION_WAIT_MS);
  } finally {
    await harness.close();
  }
});

test("counts a hook Claude called as the session working, with nothing yet written for it", async () => {
  const harness = await createIdleHarness("idle-hooks-only");
  try {
    // Claude writes a response to its transcript only once the whole of it has streamed, so a long
    // tool call shows nothing on disk while it is generated. The hooks are all there is to go on,
    // and this session writes no record at all: the transcript stays exactly as the turn left it.
    for (let index = 0; index < IDLE_STEPS; index += 1) {
      await harness.agent.hooks.dispatch({ hook_event_name: "PreToolUse", session_id: harness.sessionId, tool_name: "Bash", tool_input: { command: `echo ${index}` } });
      await new Promise((resolve) => setTimeout(resolve, IDLE_STEP_MS));
      assert.equal(harness.started(), true, `suspended while Claude was calling hooks, at step ${index}`);
    }
    await waitFor(() => !harness.started(), IDLE_SUSPENSION_WAIT_MS);
  } finally {
    await harness.close();
  }
});

test("delivers the assistant text before an interactive hook prompts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "claude-runtime-flush-test-"));
  const configDirectory = path.join(root, "claude");
  const runtimeRoot = path.join(root, "runtime");
  const cwd = "/work/questions";
  const projectDirectory = path.join(configDirectory, "projects", escapeProjectDirName(cwd));
  await mkdir(projectDirectory, { recursive: true });
  await mkdir(runtimeRoot, { recursive: true });
  const updates: SessionNotification[] = [];
  const textWhenAsked: string[] = [];
  let agent!: ClaudeTtyAgent;
  let spawned: FakePty | null = null;
  const spawnPty = (_file: string, args: string[]): Pick<IPty, "pid" | "write" | "kill" | "onData" | "onExit"> => {
    spawned = new FakePty(3000);
    const sessionId = args[args.indexOf("--session-id") + 1]!;
    setImmediate(() => void agent.hooks.dispatch({ hook_event_name: "SessionStart", session_id: sessionId }));
    return spawned;
  };
  const connection = {
    sessionUpdate: async (notification: SessionNotification) => {
      updates.push(notification);
    },
    requestPermission: async (_request: RequestPermissionRequest): Promise<RequestPermissionResponse> => {
      textWhenAsked.push(...assistantText(updates));
      return { outcome: { outcome: "selected", optionId: "answer-0-0" } };
    },
    extNotification: async () => undefined,
  } as unknown as AgentSideConnection;
  agent = new ClaudeTtyAgent(connection, {
    ...TEST_TIMINGS,
    spawnPty,
    runtimeRoot,
    claudeConfigDir: configDirectory,
    stateDirectory: path.join(root, "state"),
    startupTimeoutMs: 500,
    readinessTimeoutMs: 0,
    submitDelayMs: 0, contextRefreshTimeoutMs: 0,
    // Only the hook's own drain can deliver the transcript, so a passing run cannot be the background poll.
    transcriptPollIntervalMs: 60_000,
  });

  try {
    const session = await agent.newSession({ cwd, mcpServers: [] });
    const turn = agent.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "ask me" }] });
    await waitFor(() => spawned !== null && spawned.writes.length === 2);
    await writeFile(
      path.join(projectDirectory, `${session.sessionId}.jsonl`),
      `${JSON.stringify({ type: "assistant", uuid: "preamble", message: { content: [{ type: "text", text: "Two ways to do this." }] } })}\n`,
    );
    const answered = await agent.hooks.dispatch({
      hook_event_name: "PreToolUse",
      session_id: session.sessionId,
      tool_use_id: "question-tool",
      tool_name: "AskUserQuestion",
      tool_input: { questions: [{ question: "Which way?", header: "Approach", options: [{ label: "First" }, { label: "Second" }] }] },
    });

    assert.deepEqual(textWhenAsked, ["Two ways to do this."]);
    assert.equal((answered.hookSpecificOutput as { updatedInput?: { answers?: Record<string, string> } } | undefined)?.updatedInput?.answers?.["Which way?"], "First");
    await agent.hooks.dispatch({ hook_event_name: "Stop", session_id: session.sessionId, last_assistant_message: "done" });
    await turn;
  } finally {
    await agent.close();
    await rm(root, { force: true, recursive: true });
  }
});

function assistantText(updates: SessionNotification[]): string[] {
  return updates.flatMap((notification) => {
    const update = notification.update as { sessionUpdate: string; content?: { type: string; text?: string } };
    if (update.sessionUpdate !== "agent_message_chunk" || update.content?.type !== "text") return [];
    return [update.content.text ?? ""];
  });
}

function workspaceTrustScreen(cwd: string): string {
  return [
    "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────",
    "Accessing workspace:",
    cwd,
    "Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source",
    "project, or work from your team). If not, take a moment to review what's in this folder first.",
    "Claude Code'll be able to read, edit, and execute files here.",
    "Security guide",
    "❯ No, exit",
    "  Yes, I trust this folder",
    "Enter to confirm · Esc to cancel",
  ].join("\r\n");
}

/** Claude's external-imports question, as captured from a session that stopped at one. */
function externalImportsScreen(selected: "disable" | "allow"): string {
  return [
    "[2J[H",
    "Allow external CLAUDE.md file imports?",
    "This project's CLAUDE.md imports files outside the current working directory. Never allow this for third-party",
    "repositories.",
    "External imports:",
    ...EXTERNAL_IMPORTS.map((file) => `  ${file}`),
    "Important: Only use Claude Code with files you trust. Accessing untrusted files may pose security risks",
    "https://code.claude.com/docs/en/security",
    selected === "disable" ? "❯ No, disable external imports" : "  No, disable external imports",
    selected === "disable" ? "    Yes, allow external imports" : "❯ Yes, allow external imports",
    "Enter to confirm · Esc to cancel",
  ].join("\r\n");
}

async function runHookClient(clientPath: string, payload: Record<string, unknown>): Promise<{ code: number; stdout: string }> {
  const child = spawn(process.execPath, [clientPath], { stdio: ["pipe", "pipe", "inherit"] });
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => (stdout += chunk));
  child.stdin.end(JSON.stringify(payload));
  const code = await new Promise<number>((resolve) => child.on("close", (value) => resolve(value ?? 1)));
  return { code, stdout: stdout.trim() };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for test condition");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

test("clears what an interrupt left in Claude's input box before pasting the next prompt", async () => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "claude-runtime-clear-box-test-"));
  let agent!: ClaudeTtyAgent;
  let pty!: FakePty;
  const spawnPty = (_file: string, args: string[]): Pick<IPty, "pid" | "write" | "kill" | "onData" | "onExit"> => {
    pty = new FakePty(6100);
    const sessionId = args[args.indexOf("--session-id") + 1];
    // Claude as it stands after an interrupt: the prompt it was answering is back in the input box, where
    // a bracketed paste would land on the end of it rather than in place of it.
    setImmediate(() => pty.emitData("\u001b[2J\u001b[H\u276f the message before this one\r\n  \u23f8 manual mode on\r\n"));
    setImmediate(() => void agent.hooks.dispatch({ hook_event_name: "SessionStart", session_id: sessionId }));
    return pty;
  };
  agent = new ClaudeTtyAgent(createConnection([]), { ...TEST_TIMINGS, spawnPty, runtimeRoot, stateDirectory: path.join(runtimeRoot, "state"), startupTimeoutMs: 500, readinessTimeoutMs: 0, submitDelayMs: 0, contextRefreshTimeoutMs: 0, clearInputKeyMs: 0 });

  try {
    const session = await agent.newSession({ cwd: "/work/clear", mcpServers: [] });
    const turn = agent.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "hello" }] });
    await waitFor(() => pty !== undefined && pty.writes.length === 2);
    // The clear goes first, so what Claude reads is this prompt and not it run together with the old one.
    assert.deepEqual(keySequence(pty.keystrokes), ["clear", "\u001b[200~hello \u001b[201~", "\r"]);
    // A key per line of the box, because Ctrl-U only kills the line the cursor is on and Claude wraps a
    // long prompt across several. This fake never redraws, so the keys stop once they are visibly doing
    // nothing -- give or take the one whose reading caught the screen still being painted. The screenful
    // is still the bound, and is what a box that goes on changing is allowed.
    assert.ok(clearKeys(pty.keystrokes) <= CLEAR_INPUT_UNCHANGED + 1, `cleared with ${clearKeys(pty.keystrokes)} keys`);
    // And each of them its own write: in one write Claude reads them as text and types them into the box.
    assert.ok(pty.keystrokes.every((key) => key === CLEAR_INPUT_LINE || !key.includes(CLEAR_INPUT_LINE)));
    await agent.hooks.dispatch({ hook_event_name: "Stop", session_id: session.sessionId, last_assistant_message: "done" });
    assert.deepEqual(await turn, { stopReason: "end_turn" });
  } finally {
    await agent.close();
    await rm(runtimeRoot, { force: true, recursive: true });
  }
});

test("clears the input box even when nothing is showing in it", async () => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "claude-runtime-clear-empty-test-"));
  let agent!: ClaudeTtyAgent;
  let pty!: FakePty;
  const spawnPty = (_file: string, args: string[]): Pick<IPty, "pid" | "write" | "kill" | "onData" | "onExit"> => {
    pty = new FakePty(6200);
    const sessionId = args[args.indexOf("--session-id") + 1];
    setImmediate(() => pty.emitData("\u001b[2J\u001b[H\u276f\r\n  \u23f8 manual mode on\r\n"));
    setImmediate(() => void agent.hooks.dispatch({ hook_event_name: "SessionStart", session_id: sessionId }));
    return pty;
  };
  agent = new ClaudeTtyAgent(createConnection([]), { ...TEST_TIMINGS, spawnPty, runtimeRoot, stateDirectory: path.join(runtimeRoot, "state"), startupTimeoutMs: 500, readinessTimeoutMs: 0, submitDelayMs: 0, contextRefreshTimeoutMs: 0 });

  try {
    const session = await agent.newSession({ cwd: "/work/clear-empty", mcpServers: [] });
    const turn = agent.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "hello" }] });
    await waitFor(() => pty !== undefined && pty.writes.length === 2);
    // Unconditional, because the screen is sampled: a paste too recent to have been drawn is exactly the
    // residue worth clearing, and an empty box costs only the keys that confirm it is one.
    assert.equal(keySequence(pty.keystrokes)[0], "clear");
    assert.equal(clearKeys(pty.keystrokes), CLEAR_INPUT_CONFIRMATIONS);
    await agent.hooks.dispatch({ hook_event_name: "Stop", session_id: session.sessionId, last_assistant_message: "done" });
    assert.deepEqual(await turn, { stopReason: "end_turn" });
  } finally {
    await agent.close();
    await rm(runtimeRoot, { force: true, recursive: true });
  }
});

test("clears a residue Claude had wrapped, not just the last line of it", async () => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "claude-runtime-clear-wrapped-test-"));
  let agent!: ClaudeTtyAgent;
  let pty!: FakePty;
  // Long enough to wrap three times in Claude's input box, which is the terminal minus the "\u276f " it draws.
  const WRAP_AT = TERMINAL_COLS - 2;
  const residue = "R".repeat(WRAP_AT * 2 + 14);
  // What Claude was given to read, each time a submit key was pressed.
  const submitted: string[] = [];

  const spawnPty = (_file: string, args: string[]): Pick<IPty, "pid" | "write" | "kill" | "onData" | "onExit"> => {
    // Claude's input box, modelled closely enough to tell a clear that empties it from one that does not:
    // a paste lands on the end of what is already there, Ctrl-U kills the visual line the cursor is on,
    // and the submit key hands Claude whatever is left.
    let box = residue;
    const draw = (): void => {
      const lines = box.length === 0 ? [""] : (box.match(new RegExp(`.{1,${WRAP_AT}}`, "g")) ?? [""]);
      pty.emitData(`\u001b[2J\u001b[H\u276f ${lines.join("\r\n  ")}\r\n  \u23f8 manual mode on\r\n`);
    };
    pty = new FakePty(6300, (text) => {
      for (const key of text) {
        if (key === CLEAR_INPUT_LINE) box = box.slice(0, Math.max(0, Math.ceil(box.length / WRAP_AT) - 1) * WRAP_AT);
      }
      const paste = /^\u001b\[200~(.*)\u001b\[201~$/s.exec(text);
      if (paste) box += paste[1]!;
      if (text === "\r") {
        submitted.push(box);
        box = "";
      }
      draw();
    });
    const sessionId = args[args.indexOf("--session-id") + 1];
    setImmediate(draw);
    setImmediate(() => void agent.hooks.dispatch({ hook_event_name: "SessionStart", session_id: sessionId }));
    return pty;
  };
  agent = new ClaudeTtyAgent(createConnection([]), { ...TEST_TIMINGS, spawnPty, runtimeRoot, stateDirectory: path.join(runtimeRoot, "state"), startupTimeoutMs: 500, readinessTimeoutMs: 0, submitDelayMs: 0, contextRefreshTimeoutMs: 0 });

  try {
    const session = await agent.newSession({ cwd: "/work/clear-wrapped", mcpServers: [] });
    const turn = agent.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "hello" }] });
    await waitFor(() => submitted.length > 0);
    // The whole of the old message went, not just the line the cursor was on. One Ctrl-U would have left
    // the front of it in the box, and Claude would have read that run together with this prompt.
    assert.deepEqual(submitted, ["hello "]);
    // Three keys for the three lines it had grown to, and two more for the readings that end the run --
    // the third of those readings is the one the last of the three keys made. The bound is a screenful;
    // what a clear costs on a box the screen can be read is what the box was holding.
    assert.equal(clearKeys(pty.keystrokes), 3 + CLEAR_INPUT_CONFIRMATIONS - 1);
    await agent.hooks.dispatch({ hook_event_name: "Stop", session_id: session.sessionId, last_assistant_message: "done" });
    assert.deepEqual(await turn, { stopReason: "end_turn" });
  } finally {
    await agent.close();
    await rm(runtimeRoot, { force: true, recursive: true });
  }
});

test("stops clearing a box holding a suggestion Claude is offering rather than text anybody typed", async () => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "claude-runtime-clear-suggestion-test-"));
  let agent!: ClaudeTtyAgent;
  let pty!: FakePty;
  const submitted: string[] = [];
  // Claude offers a prompt of its own in an empty box, in grey, and Ctrl-U does not take it away:
  // there is nothing in the box to take. On a screen read for its characters it is indistinguishable
  // from something typed, so the keys have to stop on their own once they stop changing anything.
  const SUGGESTION = "Try /rewind to undo the last change";

  const spawnPty = (_file: string, args: string[]): Pick<IPty, "pid" | "write" | "kill" | "onData" | "onExit"> => {
    let box = "";
    const draw = (): void => pty.emitData(`\u001b[2J\u001b[H\u276f ${box === "" ? SUGGESTION : box}\r\n  \u23f8 manual mode on\r\n`);
    pty = new FakePty(6360, (text) => {
      const paste = /^\u001b\[200~(.*)\u001b\[201~$/s.exec(text);
      if (paste) box += paste[1]!;
      else if (text === "\r") {
        submitted.push(box);
        box = "";
      }
      // Ctrl-U kills what was typed, and the suggestion is not that: the screen comes back the same.
      draw();
    });
    const sessionId = args[args.indexOf("--session-id") + 1];
    setImmediate(draw);
    setImmediate(() => void agent.hooks.dispatch({ hook_event_name: "SessionStart", session_id: sessionId }));
    return pty;
  };
  agent = new ClaudeTtyAgent(createConnection([]), { ...TEST_TIMINGS, spawnPty, runtimeRoot, stateDirectory: path.join(runtimeRoot, "state"), startupTimeoutMs: 500, readinessTimeoutMs: 0, submitDelayMs: 0, contextRefreshTimeoutMs: 0 });

  try {
    const session = await agent.newSession({ cwd: "/work/clear-suggestion", mcpServers: [] });
    const turn = agent.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "hello" }] });
    await waitFor(() => submitted.length > 0);
    // The prompt still goes in whole, and it cost four keys rather than the forty a box nothing can
    // empty used to take on the front of every message.
    assert.deepEqual(submitted, ["hello "]);
    // Four keys that changed nothing, plus the one whose reading caught the screen still settling --
    // rather than the forty a box nothing can empty used to cost on the front of every message.
    assert.ok(clearKeys(pty.keystrokes) <= CLEAR_INPUT_UNCHANGED + 1, `cleared with ${clearKeys(pty.keystrokes)} keys`);
    await agent.hooks.dispatch({ hook_event_name: "Stop", session_id: session.sessionId, last_assistant_message: "done" });
    assert.deepEqual(await turn, { stopReason: "end_turn" });
  } finally {
    await agent.close();
    await rm(runtimeRoot, { force: true, recursive: true });
  }
});

test("clears the box a key at a time, because Claude reads a burst of them as text", async () => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "claude-runtime-clear-keys-test-"));
  let agent!: ClaudeTtyAgent;
  let pty!: FakePty;
  const submitted: string[] = [];

  const spawnPty = (_file: string, args: string[]): Pick<IPty, "pid" | "write" | "kill" | "onData" | "onExit"> => {
    // Claude v2.1.269 as it reads what arrives on its stdin: a write carrying the one control character is
    // that key, and a write carrying more than one character is text and goes into the box as itself. That
    // is how a screenful of Ctrl-U written in one go came to stand at the head of the prompt behind it --
    // around 60 prompts in ~/.claude/projects since 2026-09-13 begin with exactly forty literal U+0015.
    let box = "residue";
    const draw = (): void => pty.emitData(`\u001b[2J\u001b[H\u276f ${box}\r\n  \u23f8 manual mode on\r\n`);
    pty = new FakePty(6350, (text) => {
      const paste = /^\u001b\[200~(.*)\u001b\[201~$/s.exec(text);
      if (text === CLEAR_INPUT_LINE) box = "";
      else if (paste) box += paste[1]!;
      else if (text === "\r") {
        submitted.push(box);
        box = "";
      } else box += text;
      draw();
    });
    const sessionId = args[args.indexOf("--session-id") + 1];
    setImmediate(draw);
    setImmediate(() => void agent.hooks.dispatch({ hook_event_name: "SessionStart", session_id: sessionId }));
    return pty;
  };
  agent = new ClaudeTtyAgent(createConnection([]), { ...TEST_TIMINGS, spawnPty, runtimeRoot, stateDirectory: path.join(runtimeRoot, "state"), startupTimeoutMs: 500, readinessTimeoutMs: 0, submitDelayMs: 0, contextRefreshTimeoutMs: 0 });

  try {
    const session = await agent.newSession({ cwd: "/work/clear-keys", mcpServers: [] });
    const turn = agent.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "hello" }] });
    await waitFor(() => submitted.length > 0);
    // What Claude was handed is the prompt, with neither the residue in front of it nor the keys that took
    // the residue away. A single write of forty of them lands here as forty characters of prompt.
    assert.deepEqual(submitted, ["hello "]);
    assert.ok(!submitted[0]!.includes(CLEAR_INPUT_LINE));
    // Every clear key its own write, and nothing else carrying one.
    assert.ok(pty.keystrokes.every((key) => !key.includes(CLEAR_INPUT_LINE) || key === CLEAR_INPUT_LINE));
    assert.ok(clearKeys(pty.keystrokes) > 0);
    await agent.hooks.dispatch({ hook_event_name: "Stop", session_id: session.sessionId, last_assistant_message: "done" });
    assert.deepEqual(await turn, { stopReason: "end_turn" });
  } finally {
    await agent.close();
    await rm(runtimeRoot, { force: true, recursive: true });
  }
});

/**
 * The auto-mode setup question, as Claude draws it: in the input box's place, its selected row marked
 * with the box's own glyph. Read off a session that lost two messages into one of these on 2026-09-13.
 */
const AUTO_MODE_SETUP_SCREEN = [
  "\u001b[2J\u001b[H",
  "Claude Code reads this project, your recent Claude sessions, and optionally your shell history and other repositories.",
  "\u276f Also scan shell history    [\u2714]",
  "  Also scan your other repos   [ ]",
  "Enter to confirm \u00b7 Esc to cancel",
].join("\r\n");

/** What Claude keeps for itself while a session is up: `sessions/<pid>.json` under its config directory. */
async function writeClaudeSessionState(configDirectory: string, claudePid: number, state: Record<string, unknown>): Promise<string> {
  const filePath = path.join(configDirectory, "sessions", `${claudePid}.json`);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify({ pid: claudePid, kind: "interactive", ...state }));
  return filePath;
}

const ESCAPE_KEY = "\u001b";

test("closes a question Claude has open, then sends the prompt into the box behind it", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "claude-runtime-open-dialog-test-"));
  const configDirectory = path.join(root, "claude");
  const runtimeRoot = path.join(root, "runtime");
  const claudePid = 6400;
  const statePath = await writeClaudeSessionState(configDirectory, claudePid, { status: "waiting", waitingFor: "dialog open" });
  let agent!: ClaudeTtyAgent;
  let pty!: FakePty;
  const spawnPty = (_file: string, args: string[]): Pick<IPty, "pid" | "write" | "kill" | "onData" | "onExit"> => {
    pty = new FakePty(claudePid, (text) => {
      // Escape closes the question and Claude goes back to saying nothing has the keyboard.
      if (text === ESCAPE_KEY) {
        writeFileSync(statePath, JSON.stringify({ pid: claudePid, status: "idle" }));
        pty.emitData("\u001b[2J\u001b[H\u276f\r\n  \u23f8 auto mode on\r\n");
      }
      if (text.startsWith("\u001b[200~")) pty.emitData("\u001b[2J\u001b[H\u276f commit this\r\n");
      if (text === "\r") pty.emitData("\u001b[2J\u001b[H\u276f\r\n");
    });
    const sessionId = args[args.indexOf("--session-id") + 1];
    setImmediate(() => pty.emitData(AUTO_MODE_SETUP_SCREEN));
    setImmediate(() => void agent.hooks.dispatch({ hook_event_name: "SessionStart", session_id: sessionId }));
    return pty;
  };
  agent = new ClaudeTtyAgent(createConnection([]), { ...TEST_TIMINGS, spawnPty, runtimeRoot, stateDirectory: path.join(runtimeRoot, "state"), claudeConfigDir: configDirectory, startupTimeoutMs: 500, readinessTimeoutMs: 0, submitDelayMs: 0, contextRefreshTimeoutMs: 0 });

  try {
    const session = await agent.newSession({ cwd: "/work/open-dialog", mcpServers: [] });
    const turn = agent.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "commit this" }] });
    await waitFor(() => pty !== undefined && pty.writes.length === 3);
    // The question is closed before a single key of the prompt goes anywhere near it: the clear would
    // walk its selection, the space that ends the paste would toggle the checkbox, and Enter would confirm.
    assert.deepEqual(keySequence(pty.keystrokes), [ESCAPE_KEY, "clear", "\u001b[200~commit this \u001b[201~", "\r"]);
    await agent.hooks.dispatch({ hook_event_name: "Stop", session_id: session.sessionId, last_assistant_message: "done" });
    assert.deepEqual(await turn, { stopReason: "end_turn" });
  } finally {
    await agent.close();
    await rm(root, { force: true, recursive: true });
  }
});

test("fails the prompt, rather than answering it, when a question will not close", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "claude-runtime-stuck-dialog-test-"));
  const configDirectory = path.join(root, "claude");
  const runtimeRoot = path.join(root, "runtime");
  const claudePid = 6450;
  await writeClaudeSessionState(configDirectory, claudePid, { status: "waiting", waitingFor: "dialog open" });
  let agent!: ClaudeTtyAgent;
  let pty!: FakePty;
  const spawnPty = (_file: string, args: string[]): Pick<IPty, "pid" | "write" | "kill" | "onData" | "onExit"> => {
    // A question Escape does not close: Claude goes on saying it has the keyboard.
    pty = new FakePty(claudePid);
    const sessionId = args[args.indexOf("--session-id") + 1];
    setImmediate(() => pty.emitData(AUTO_MODE_SETUP_SCREEN));
    setImmediate(() => void agent.hooks.dispatch({ hook_event_name: "SessionStart", session_id: sessionId }));
    return pty;
  };
  agent = new ClaudeTtyAgent(createConnection([]), { ...TEST_TIMINGS, spawnPty, runtimeRoot, stateDirectory: path.join(runtimeRoot, "state"), claudeConfigDir: configDirectory, startupTimeoutMs: 500, readinessTimeoutMs: 0, submitDelayMs: 0, contextRefreshTimeoutMs: 0, dialogDismissMs: 20 });

  try {
    const session = await agent.newSession({ cwd: "/work/stuck-dialog", mcpServers: [] });
    const turn = agent.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "commit this" }] });
    // The screen alone says the input box is there holding `Also scan shell history    [✔]`, so both the
    // refusal and what it names have to come from what Claude says about itself.
    await assert.rejects(turn, /waiting on dialog open/);
    // Nothing but the keys that ask for the keyboard back; the error carries the screen instead.
    assert.deepEqual(pty.keystrokes, [ESCAPE_KEY, ESCAPE_KEY, ESCAPE_KEY]);
    await assert.rejects(turn, /Also scan shell history/);
  } finally {
    await agent.close();
    await rm(root, { force: true, recursive: true });
  }
});

test("re-pastes a prompt the question behind it swallowed, instead of sending an empty box", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "claude-runtime-late-dialog-test-"));
  const configDirectory = path.join(root, "claude");
  const runtimeRoot = path.join(root, "runtime");
  const claudePid = 6500;
  const statePath = await writeClaudeSessionState(configDirectory, claudePid, { status: "idle" });
  let agent!: ClaudeTtyAgent;
  let pty!: FakePty;
  let questionUp = false;
  // The question opens once, behind the first paste, and does not come back after it is closed.
  let questionRaised = false;
  const spawnPty = (_file: string, args: string[]): Pick<IPty, "pid" | "write" | "kill" | "onData" | "onExit"> => {
    // The gap the 2026-09-13 session fell into: the box was a box when the prompt was cleared into it, and
    // a question had the keyboard by the time the submit key went, so the paste landed in the question.
    pty = new FakePty(claudePid, (text) => {
      if (text.startsWith("\u001b[200~") && !questionRaised) {
        questionUp = true;
        questionRaised = true;
        writeFileSync(statePath, JSON.stringify({ pid: claudePid, status: "waiting", waitingFor: "dialog open" }));
        pty.emitData(AUTO_MODE_SETUP_SCREEN);
        return;
      }
      if (text === ESCAPE_KEY) {
        questionUp = false;
        writeFileSync(statePath, JSON.stringify({ pid: claudePid, status: "idle" }));
        pty.emitData("\u001b[2J\u001b[H\u276f\r\n  \u23f8 auto mode on\r\n");
      }
      if (text.startsWith("\u001b[200~") && !questionUp) pty.emitData("\u001b[2J\u001b[H\u276f commit this\r\n");
      if (text === "\r") pty.emitData("\u001b[2J\u001b[H\u276f\r\n");
    });
    const sessionId = args[args.indexOf("--session-id") + 1];
    setImmediate(() => pty.emitData("\u001b[2J\u001b[H\u276f\r\n  \u23f8 auto mode on\r\n"));
    setImmediate(() => void agent.hooks.dispatch({ hook_event_name: "SessionStart", session_id: sessionId }));
    return pty;
  };
  agent = new ClaudeTtyAgent(createConnection([]), { ...TEST_TIMINGS, spawnPty, runtimeRoot, stateDirectory: path.join(runtimeRoot, "state"), claudeConfigDir: configDirectory, startupTimeoutMs: 500, readinessTimeoutMs: 0, submitDelayMs: 0, contextRefreshTimeoutMs: 0 });

  try {
    const session = await agent.newSession({ cwd: "/work/late-dialog", mcpServers: [] });
    const turn = agent.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "commit this" }] });
    await waitFor(() => pty !== undefined && pty.writes.length === 4);
    // The submit key was withheld while the question was up, and the prompt pasted again once it was gone:
    // Claude had none of it, and Enter on the empty box behind the question would have sent nothing.
    assert.deepEqual(keySequence(pty.keystrokes), [
      "clear",
      "\u001b[200~commit this \u001b[201~",
      ESCAPE_KEY,
      "clear",
      "\u001b[200~commit this \u001b[201~",
      "\r",
    ]);
    await agent.hooks.dispatch({ hook_event_name: "Stop", session_id: session.sessionId, last_assistant_message: "done" });
    assert.deepEqual(await turn, { stopReason: "end_turn" });
  } finally {
    await agent.close();
    await rm(root, { force: true, recursive: true });
  }
});

test("re-pastes a prompt whose echo never came because a question opened behind it", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "claude-runtime-late-echo-test-"));
  const configDirectory = path.join(root, "claude");
  const runtimeRoot = path.join(root, "runtime");
  const claudePid = 6700;
  const statePath = await writeClaudeSessionState(configDirectory, claudePid, { status: "idle" });
  const vendor: Array<{ method: string; params: Record<string, unknown> }> = [];
  const connection = {
    sessionUpdate: async () => undefined,
    extNotification: async (method: string, params: Record<string, unknown>) => {
      vendor.push({ method, params });
    },
  } as unknown as AgentSideConnection;
  let agent!: ClaudeTtyAgent;
  let pty!: FakePty;
  let swallowed = false;
  let dialogUp = false;
  const spawnPty = (_file: string, args: string[]): Pick<IPty, "pid" | "write" | "kill" | "onData" | "onExit"> => {
    // The race the state file could not see in time: nothing had the keyboard when the prompt was
    // cleared and pasted, and the question opened during the paste -- so there is no echo of the prompt
    // coming, ever, and the two seconds spent waiting for one are two seconds the question was up.
    pty = new FakePty(claudePid, (text) => {
      if (text.startsWith("\u001b[200~")) {
        if (!swallowed || dialogUp) return;
        pty.emitData("\u001b[2J\u001b[H\u276f commit this\r\n");
        return;
      }
      if (text === "\r" && !swallowed) {
        swallowed = true;
        dialogUp = true;
        writeFileSync(statePath, JSON.stringify({ pid: claudePid, status: "waiting", waitingFor: "dialog open" }));
        pty.emitData(AUTO_MODE_SETUP_SCREEN);
        return;
      }
      if (text === ESCAPE_KEY && dialogUp) {
        dialogUp = false;
        writeFileSync(statePath, JSON.stringify({ pid: claudePid, status: "idle" }));
        pty.emitData("\u001b[2J\u001b[H\u276f\r\n  \u23f8 auto mode on\r\n");
        return;
      }
      if (text === "\r") pty.emitData("\u001b[2J\u001b[H\u276f\r\n");
    });
    const sessionId = args[args.indexOf("--session-id") + 1];
    setImmediate(() => pty.emitData("\u001b[2J\u001b[H\u276f\r\n  \u23f8 auto mode on\r\n"));
    setImmediate(() => void agent.hooks.dispatch({ hook_event_name: "SessionStart", session_id: sessionId }));
    return pty;
  };
  agent = new ClaudeTtyAgent(connection, {
    ...TEST_TIMINGS,
    spawnPty,
    runtimeRoot,
    stateDirectory: path.join(runtimeRoot, "state"),
    claudeConfigDir: configDirectory,
    startupTimeoutMs: 500,
    readinessTimeoutMs: 0,
    submitDelayMs: 0,
    contextRefreshTimeoutMs: 0,
    latePasteMs: 50,
    // Long enough that the poll never gets there first: this is the submit path's own check.
    dialogPollMs: 10_000,
  });

  try {
    const session = await agent.newSession({ cwd: "/work/late-echo", mcpServers: [] });
    const turn = agent.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "commit this" }] });
    await waitFor(() => pty !== undefined && pty.writes.length === 5, 4_000);
    // The first submit key went into a box with nothing in it, the wait for a late echo found the
    // question instead, and the prompt was pasted again once the keyboard was back -- rather than the
    // turn failing with a message Claude never saw.
    assert.deepEqual(keySequence(pty.keystrokes), [
      "clear",
      "\u001b[200~commit this \u001b[201~",
      "\r",
      ESCAPE_KEY,
      "clear",
      "\u001b[200~commit this \u001b[201~",
      "\r",
    ]);
    // And the question that was closed to make room is said in the timeline rather than lost.
    const notice = vendor.find((update) => update.method === "_claude_tty/notice");
    assert.ok(String((notice?.params.notice as { title: string } | undefined)?.title).includes("Dismissed"));
    await agent.hooks.dispatch({ hook_event_name: "Stop", session_id: session.sessionId, last_assistant_message: "done" });
    assert.deepEqual(await turn, { stopReason: "end_turn" });
  } finally {
    await agent.close();
    await rm(root, { force: true, recursive: true });
  }
});

test("raises a card for a question Claude opens on its own, and closes it with Escape", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "claude-runtime-dialog-card-test-"));
  const configDirectory = path.join(root, "claude");
  const runtimeRoot = path.join(root, "runtime");
  const claudePid = 6800;
  const statePath = await writeClaudeSessionState(configDirectory, claudePid, { status: "idle" });
  const permissionRequests: RequestPermissionRequest[] = [];
  const connection = {
    sessionUpdate: async () => undefined,
    extNotification: async () => undefined,
    requestPermission: async (request: RequestPermissionRequest): Promise<RequestPermissionResponse> => {
      permissionRequests.push(request);
      return { outcome: { outcome: "selected", optionId: "dialog-dismiss" } };
    },
  } as unknown as AgentSideConnection;
  let agent!: ClaudeTtyAgent;
  let pty!: FakePty;
  const spawnPty = (_file: string, args: string[]): Pick<IPty, "pid" | "write" | "kill" | "onData" | "onExit"> => {
    pty = new FakePty(claudePid, (text) => {
      if (text.startsWith("\u001b[200~")) pty.emitData("\u001b[2J\u001b[H\u276f commit this\r\n");
      if (text === "\r") pty.emitData("\u001b[2J\u001b[H\u276f\r\n");
      if (text === ESCAPE_KEY) {
        writeFileSync(statePath, JSON.stringify({ pid: claudePid, status: "idle" }));
        pty.emitData("\u001b[2J\u001b[H\u276f\r\n  \u23f8 auto mode on\r\n");
      }
    });
    const sessionId = args[args.indexOf("--session-id") + 1];
    setImmediate(() => pty.emitData("\u001b[2J\u001b[H\u276f\r\n  \u23f8 auto mode on\r\n"));
    setImmediate(() => void agent.hooks.dispatch({ hook_event_name: "SessionStart", session_id: sessionId }));
    return pty;
  };
  agent = new ClaudeTtyAgent(connection, {
    ...TEST_TIMINGS,
    spawnPty,
    runtimeRoot,
    stateDirectory: path.join(runtimeRoot, "state"),
    claudeConfigDir: configDirectory,
    startupTimeoutMs: 500,
    readinessTimeoutMs: 0,
    submitDelayMs: 0,
    contextRefreshTimeoutMs: 0,
    dialogPollMs: 10,
    dialogSettleMs: 200,
  });

  try {
    const session = await agent.newSession({ cwd: "/work/dialog-card", mcpServers: [] });
    const turn = agent.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "commit this" }] });
    await waitFor(() => pty !== undefined && pty.writes.length === 2);
    await agent.hooks.dispatch({ hook_event_name: "Stop", session_id: session.sessionId, last_assistant_message: "done" });
    assert.deepEqual(await turn, { stopReason: "end_turn" });

    // Claude puts a nudge up the moment the turn ends, which is exactly when it does not report them
    // while one is running. Nothing else in this process would ever see it.
    pty.emitData(AUTO_MODE_SETUP_SCREEN);
    writeFileSync(statePath, JSON.stringify({ pid: claudePid, status: "waiting", waitingFor: "dialog open" }));
    await waitFor(() => permissionRequests.length === 1, 4_000);
    const request = permissionRequests[0]!;
    assert.equal(request.toolCall.title, "Claude Code reads this project, your recent Claude sessions, and optionally your shell history and other repositories.");
    assert.deepEqual(
      request.options.map((option) => `${option.optionId}:${option.kind}`),
      ["dialog-dismiss:reject_once", "dialog-choice-0:reject_once", "dialog-choice-1:reject_once"],
    );
    // Dismissed in Paseo, so Escape goes in and Claude stops saying it is waiting.
    await waitFor(() => pty.keystrokes.at(-1) === ESCAPE_KEY, 4_000);
  } finally {
    await agent.close();
    await rm(root, { force: true, recursive: true });
  }
});

test("says so three ways when Claude swaps the model under a running session", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "claude-runtime-model-fallback-test-"));
  const configDirectory = path.join(root, "claude");
  const cwd = "/work/model-fallback";
  const projectDirectory = path.join(configDirectory, "projects", escapeProjectDirName(cwd));
  await mkdir(projectDirectory, { recursive: true });
  await mkdir(path.join(root, "runtime"), { recursive: true });
  const vendor: Array<{ method: string; params: Record<string, unknown> }> = [];
  const permissionRequests: RequestPermissionRequest[] = [];
  const connection = {
    sessionUpdate: async () => undefined,
    extNotification: async (method: string, params: Record<string, unknown>) => {
      vendor.push({ method, params });
    },
    // The card is never answered: nothing waits for it, and what it is for is the push a new permission
    // request sends. So this promise is left hanging on purpose.
    requestPermission: (request: RequestPermissionRequest) => {
      permissionRequests.push(request);
      return new Promise<RequestPermissionResponse>(() => undefined);
    },
  } as unknown as AgentSideConnection;
  let agent!: ClaudeTtyAgent;
  const spawns: SpawnRecord[] = [];
  const spawnPty = (file: string, args: string[], options: IPtyForkOptions): Pick<IPty, "pid" | "write" | "kill" | "onData" | "onExit"> => {
    const pty = new FakePty(6900 + spawns.length);
    spawns.push({ file, args, options, pty });
    const sessionId = args[args.indexOf("--session-id") + 1];
    setImmediate(() => void agent.hooks.dispatch({ hook_event_name: "SessionStart", session_id: sessionId }));
    return pty;
  };
  agent = new ClaudeTtyAgent(connection, {
    ...TEST_TIMINGS,
    spawnPty,
    runtimeRoot: path.join(root, "runtime"),
    claudeConfigDir: configDirectory,
    stateDirectory: path.join(root, "state"),
    startupTimeoutMs: 500,
    readinessTimeoutMs: 0,
    submitDelayMs: 0,
    contextRefreshTimeoutMs: 0,
    transcriptPollIntervalMs: 10,
  });

  try {
    const session = await agent.newSession({ cwd, mcpServers: [] });
    const turn = agent.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "go" }] });
    await waitFor(() => spawns.length === 1 && spawns[0]!.pty.writes.length === 2);
    await appendFile(
      path.join(projectDirectory, `${session.sessionId}.jsonl`),
      `${JSON.stringify({
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
      })}\n`,
    );

    // The notice, which is the timeline's record of it and sends no push.
    await waitFor(() => vendor.some((update) => update.method === "_claude_tty/notice"));
    const notice = vendor.find((update) => update.method === "_claude_tty/notice")!.params.notice as { severity: string; title: string; description: string };
    assert.equal(notice.severity, "warning");
    assert.equal(notice.title, "Model switched: Fable 5 → Opus 4.8");
    assert.equal(notice.description, "Fable 5's safeguards flagged this message, so it was retried on Opus 4.8.");
    // The model the session is on from here, which ACP has no update for and the plugin puts in the picker.
    const model = vendor.find((update) => update.method === "_claude_tty/model");
    assert.equal(model?.params.model, "claude-opus-4-8");
    // And a card, which is the only thing in Paseo that pushes to a phone.
    await waitFor(() => permissionRequests.length === 1);
    assert.equal(permissionRequests[0]!.toolCall.title, "Model switched: Fable 5 → Opus 4.8");
    assert.deepEqual(permissionRequests[0]!.options, [{ optionId: "acknowledge", name: "OK", kind: "reject_once" }]);

    await agent.hooks.dispatch({ hook_event_name: "Stop", session_id: session.sessionId, last_assistant_message: "done" });
    assert.deepEqual(await turn, { stopReason: "end_turn" });

    // The card nobody answered does not stand between the session and the next message: it is taken down
    // as the prompt goes in, on both sides.
    const second = agent.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "again" }] });
    await waitFor(() => vendor.some((update) => update.method === "_claude_tty/card_withdrawn"));
    assert.equal(vendor.find((update) => update.method === "_claude_tty/card_withdrawn")!.params.toolCallId, permissionRequests[0]!.toolCall.toolCallId);
    await waitFor(() => spawns[0]!.pty.writes.length === 4);
    await agent.hooks.dispatch({ hook_event_name: "Stop", session_id: session.sessionId, last_assistant_message: "done again" });
    assert.deepEqual(await second, { stopReason: "end_turn" });
  } finally {
    await agent.close();
    await rm(root, { force: true, recursive: true });
  }
});

test("sends the prompt as usual when Claude says nothing else has the keyboard", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "claude-runtime-no-dialog-test-"));
  const configDirectory = path.join(root, "claude");
  const runtimeRoot = path.join(root, "runtime");
  const claudePid = 6600;
  await writeClaudeSessionState(configDirectory, claudePid, { status: "idle" });
  let agent!: ClaudeTtyAgent;
  let pty!: FakePty;
  const spawnPty = (_file: string, args: string[]): Pick<IPty, "pid" | "write" | "kill" | "onData" | "onExit"> => {
    pty = new FakePty(claudePid, (text) => {
      if (text.startsWith("\u001b[200~")) pty.emitData("\u001b[2J\u001b[H\u276f commit this\r\n");
      if (text === "\r") pty.emitData("\u001b[2J\u001b[H\u276f\r\n");
    });
    const sessionId = args[args.indexOf("--session-id") + 1];
    setImmediate(() => pty.emitData("\u001b[2J\u001b[H\u276f\r\n  \u23f8 auto mode on\r\n"));
    setImmediate(() => void agent.hooks.dispatch({ hook_event_name: "SessionStart", session_id: sessionId }));
    return pty;
  };
  agent = new ClaudeTtyAgent(createConnection([]), { ...TEST_TIMINGS, spawnPty, runtimeRoot, stateDirectory: path.join(runtimeRoot, "state"), claudeConfigDir: configDirectory, startupTimeoutMs: 500, readinessTimeoutMs: 0, submitDelayMs: 0, contextRefreshTimeoutMs: 0 });

  try {
    const session = await agent.newSession({ cwd: "/work/no-dialog", mcpServers: [] });
    const turn = agent.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "commit this" }] });
    await waitFor(() => pty !== undefined && pty.writes.length === 2);
    assert.deepEqual(keySequence(pty.keystrokes), ["clear", "\u001b[200~commit this \u001b[201~", "\r"]);
    await agent.hooks.dispatch({ hook_event_name: "Stop", session_id: session.sessionId, last_assistant_message: "done" });
    assert.deepEqual(await turn, { stopReason: "end_turn" });
  } finally {
    await agent.close();
    await rm(root, { force: true, recursive: true });
  }
});

test("pastes a known command apart from its attachment, so Claude runs it rather than reading it as pasted text", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "claude-runtime-command-test-"));
  const configDirectory = path.join(root, "claude");
  const runtimeRoot = path.join(root, "runtime");
  await mkdir(path.join(configDirectory, "skills", "implement-spec"), { recursive: true });
  await writeFile(path.join(configDirectory, "skills", "implement-spec", "SKILL.md"), "---\ndescription: Implement a spec\n---\n");
  let agent!: ClaudeTtyAgent;
  let pty!: FakePty;
  const spawnPty = (_file: string, args: string[]): Pick<IPty, "pid" | "write" | "kill" | "onData" | "onExit"> => {
    pty = new FakePty(6700, (text) => {
      if (text.startsWith("\u001b[200~")) pty.emitData('\u001b[2J\u001b[H\u276f /implement-spec https://example.com/issues/88\r\n  <resource uri="paseo://issue/88">\r\n  the issue\r\n  </resource>\r\n');
      if (text === "\r") pty.emitData("\u001b[2J\u001b[H\u276f\r\n");
    });
    const sessionId = args[args.indexOf("--session-id") + 1];
    setImmediate(() => void agent.hooks.dispatch({ hook_event_name: "SessionStart", session_id: sessionId }));
    return pty;
  };
  agent = new ClaudeTtyAgent(createConnection([]), { ...TEST_TIMINGS, spawnPty, runtimeRoot, stateDirectory: path.join(runtimeRoot, "state"), claudeConfigDir: configDirectory, startupTimeoutMs: 500, readinessTimeoutMs: 0, submitDelayMs: 0, contextRefreshTimeoutMs: 0 });

  try {
    const session = await agent.newSession({ cwd: path.join(root, "work"), mcpServers: [] });
    const turn = agent.prompt({
      sessionId: session.sessionId,
      prompt: [
        { type: "text", text: "/implement-spec https://example.com/issues/88" },
        { type: "resource", resource: { uri: "paseo://issue/88", mimeType: "text/plain", text: "the issue" } },
      ],
    });
    await waitFor(() => pty !== undefined && pty.writes.length === 3);
    assert.deepEqual(pty.writes, [
      "\u001b[200~/implement-spec \u001b[201~",
      '\u001b[200~https://example.com/issues/88\u001b[201~\n\u001b[200~<resource uri="paseo://issue/88">\u001b[201~\n\u001b[200~the issue\u001b[201~\n\u001b[200~</resource> \u001b[201~',
      "\r",
    ]);
    await agent.hooks.dispatch({ hook_event_name: "Stop", session_id: session.sessionId, last_assistant_message: "done" });
    assert.deepEqual(await turn, { stopReason: "end_turn" });
  } finally {
    await agent.close();
    await rm(root, { force: true, recursive: true });
  }
});

test("resubmits a prompt Claude leaves sitting in its input box", async () => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "claude-runtime-test-"));
  const updates: SessionNotification[] = [];
  let agent!: ClaudeTtyAgent;
  let pty!: FakePty;
  let submits = 0;
  const spawnPty = (_file: string, args: string[]): Pick<IPty, "pid" | "write" | "kill" | "onData" | "onExit"> => {
    pty = new FakePty(2000, (text) => {
      if (text.startsWith("\u001b[200~")) pty.emitData("\u001b[2J\u001b[H\u276f hello there\r\n");
      // Claude only takes the prompt on the second submit key, the way it does while it is still settling a paste.
      if (text === "\r" && (submits += 1) > 1) pty.emitData("\u001b[2J\u001b[H\u276f\r\n");
    });
    const sessionId = args[args.indexOf("--session-id") + 1];
    setImmediate(() => void agent.hooks.dispatch({ hook_event_name: "SessionStart", session_id: sessionId }));
    return pty;
  };
  agent = new ClaudeTtyAgent(createConnection(updates), { ...TEST_TIMINGS, spawnPty, runtimeRoot, stateDirectory: path.join(runtimeRoot, "state"), startupTimeoutMs: 500, readinessTimeoutMs: 0, submitDelayMs: 0, contextRefreshTimeoutMs: 0 });

  try {
    const session = await agent.newSession({ cwd: "/work/one", mcpServers: [] });
    const turn = agent.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "hello there" }] });
    await waitFor(() => submits === 2);
    await agent.hooks.dispatch({ hook_event_name: "Stop", session_id: session.sessionId, last_assistant_message: "done" });
    assert.deepEqual(await turn, { stopReason: "end_turn" });
    assert.equal(submits, 2);
    assert.equal(pty.writes[0], "\u001b[200~hello there \u001b[201~");
  } finally {
    await agent.close();
    await rm(runtimeRoot, { force: true, recursive: true });
  }
});

// The screens Claude paints around a prompt, spelled here rather than inline: what these tests turn on
// is which of them arrives when.
const ESC_SEQ = String.fromCharCode(27);
const CLEARED = `${ESC_SEQ}[2J${ESC_SEQ}[H`;
const EMPTY_INPUT_BOX = `${CLEARED}\u276f\r\n`;
const INPUT_BOX_HOLDING = `${CLEARED}\u276f hello there\r\n`;

test("sends a prompt Claude echoed only after the first submit key, rather than leaving it in the box", async () => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "claude-runtime-late-paste-test-"));
  const updates: SessionNotification[] = [];
  let agent!: ClaudeTtyAgent;
  let pty!: FakePty;
  let submits = 0;
  const spawnPty = (_file: string, args: string[]): Pick<IPty, "pid" | "write" | "kill" | "onData" | "onExit"> => {
    pty = new FakePty(2100, (text) => {
      // The paste is read and the box stays empty: Claude has not settled it into a render yet.
      if (text.startsWith(`${ESC_SEQ}[200~`)) pty.emitData(EMPTY_INPUT_BOX);
      if (text !== "\r") return;
      submits += 1;
      // The first submit key lands on that empty box and sends nothing; the echo turns up behind it.
      pty.emitData(submits === 1 ? INPUT_BOX_HOLDING : EMPTY_INPUT_BOX);
    });
    const sessionId = args[args.indexOf("--session-id") + 1];
    setImmediate(() => void agent.hooks.dispatch({ hook_event_name: "SessionStart", session_id: sessionId }));
    return pty;
  };
  agent = new ClaudeTtyAgent(createConnection(updates), { ...TEST_TIMINGS, spawnPty, runtimeRoot, stateDirectory: path.join(runtimeRoot, "state"), startupTimeoutMs: 500, readinessTimeoutMs: 0, submitDelayMs: 0, latePasteMs: 500, contextRefreshTimeoutMs: 0 });

  try {
    const session = await agent.newSession({ cwd: "/work/late", mcpServers: [] });
    const turn = agent.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "hello there" }] });
    await waitFor(() => submits === 2, 5_000);
    await agent.hooks.dispatch({ hook_event_name: "Stop", session_id: session.sessionId, last_assistant_message: "done" });
    assert.deepEqual(await turn, { stopReason: "end_turn" });
    assert.equal(submits, 2);
  } finally {
    await agent.close();
    await rm(runtimeRoot, { force: true, recursive: true });
  }
});

test("fails a prompt Claude never took, and leaves the session able to take the next one", async () => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "claude-runtime-lost-paste-test-"));
  const updates: SessionNotification[] = [];
  let agent!: ClaudeTtyAgent;
  let pty!: FakePty;
  const spawnPty = (_file: string, args: string[]): Pick<IPty, "pid" | "write" | "kill" | "onData" | "onExit"> => {
    // The box is on screen and stays empty however often the prompt is pasted into it: the paste is gone.
    pty = new FakePty(2200, () => pty.emitData(EMPTY_INPUT_BOX));
    const sessionId = args[args.indexOf("--session-id") + 1];
    setImmediate(() => void agent.hooks.dispatch({ hook_event_name: "SessionStart", session_id: sessionId }));
    return pty;
  };
  agent = new ClaudeTtyAgent(createConnection(updates), { ...TEST_TIMINGS, spawnPty, runtimeRoot, stateDirectory: path.join(runtimeRoot, "state"), startupTimeoutMs: 500, readinessTimeoutMs: 0, submitDelayMs: 0, latePasteMs: 50, contextRefreshTimeoutMs: 0 });

  try {
    const session = await agent.newSession({ cwd: "/work/lost", mcpServers: [] });
    await assert.rejects(
      agent.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "hello there" }] }),
      /never took the prompt/,
    );
    // The turn the lost prompt opened is gone with it, rather than holding the session busy for good.
    await assert.rejects(
      agent.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "anyone there" }] }),
      /never took the prompt/,
    );
  } finally {
    await agent.close();
    await rm(runtimeRoot, { force: true, recursive: true });
  }
});

test("reports the context reading Claude's status line writes after the turn", async () => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "claude-runtime-context-test-"));
  const updates: SessionNotification[] = [];
  const spawns: SpawnRecord[] = [];
  let agent!: ClaudeTtyAgent;
  const spawnPty = (file: string, args: string[], options: IPtyForkOptions): Pick<IPty, "pid" | "write" | "kill" | "onData" | "onExit"> => {
    const pty = new FakePty(3400 + spawns.length);
    spawns.push({ file, args, options, pty });
    const sessionId = args[args.indexOf("--session-id") + 1];
    setImmediate(() => void agent.hooks.dispatch({ hook_event_name: "SessionStart", session_id: sessionId }));
    return pty;
  };
  agent = new ClaudeTtyAgent(createConnection(updates), { ...TEST_TIMINGS, spawnPty, runtimeRoot, stateDirectory: path.join(runtimeRoot, "state"), startupTimeoutMs: 500, readinessTimeoutMs: 0, submitDelayMs: 0, contextRefreshTimeoutMs: 500 });

  try {
    const session = await agent.newSession({ cwd: "/work/context", mcpServers: [] });
    const first = agent.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "hello" }] });
    await waitFor(() => spawns.length === 1 && spawns[0]!.pty.writes.length === 2);

    const settingsPath = spawns[0]!.args.at(-1)!;
    const contextPath = path.join(path.dirname(settingsPath), "context.json");
    const settings = JSON.parse(await readFile(settingsPath, "utf8")) as { statusLine?: { type?: string; command?: string } };
    assert.equal(settings.statusLine?.type, "command");
    assert.equal(settings.statusLine?.command, `cat > '${contextPath}'`);

    // Claude renders the status line during the turn too, and that reading is the stale one.
    await writeFile(contextPath, contextPayload(20_000, 10));
    // It keeps rendering after the Stop hook, truncating the file before each rewrite, so the torn state has to be waited out rather than reported.
    let render = 0;
    const renders = setInterval(
      () => void writeFile(contextPath, render++ === 0 ? '{"context_window":{"total_input_tok' : contextPayload(137_400, 69)),
      25,
    );
    try {
      await agent.hooks.dispatch({ hook_event_name: "Stop", session_id: session.sessionId, last_assistant_message: "done" });
      assert.deepEqual(await first, { stopReason: "end_turn" });
    } finally {
      clearInterval(renders);
    }
    assert.deepEqual(contextLines(updates), ["Context: 137.4k tokens (69%)"]);
  } finally {
    await agent.close();
    await rm(runtimeRoot, { force: true, recursive: true });
  }
});

test("takes a context reading Claude writes while the transcript is still draining", async () => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "claude-runtime-context-drain-test-"));
  const updates: SessionNotification[] = [];
  const spawns: SpawnRecord[] = [];
  let agent!: ClaudeTtyAgent;
  const spawnPty = (file: string, args: string[], options: IPtyForkOptions): Pick<IPty, "pid" | "write" | "kill" | "onData" | "onExit"> => {
    const pty = new FakePty(3600 + spawns.length);
    spawns.push({ file, args, options, pty });
    const sessionId = args[args.indexOf("--session-id") + 1];
    setImmediate(() => void agent.hooks.dispatch({ hook_event_name: "SessionStart", session_id: sessionId }));
    return pty;
  };
  agent = new ClaudeTtyAgent(createConnection(updates), { ...TEST_TIMINGS, spawnPty, runtimeRoot, stateDirectory: path.join(runtimeRoot, "state"), startupTimeoutMs: 500, readinessTimeoutMs: 0, submitDelayMs: 0, contextRefreshTimeoutMs: 500 });

  try {
    const session = await agent.newSession({ cwd: "/work/drain", mcpServers: [] });
    const turn = agent.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "hello" }] });
    await waitFor(() => spawns.length === 1 && spawns[0]!.pty.writes.length === 2);
    const contextPath = path.join(path.dirname(spawns[0]!.args.at(-1)!), "context.json");

    // Draining the transcript and delivering the turn's last message both sit between the Stop hook and the read,
    // so a reading written in that window is this turn's and has to be taken rather than judged stale.
    const stop = agent.hooks.dispatch({ hook_event_name: "Stop", session_id: session.sessionId, last_assistant_message: "done" });
    await writeFile(contextPath, contextPayload(42_000, 21));
    await stop;
    assert.deepEqual(await turn, { stopReason: "end_turn" });
    assert.deepEqual(contextLines(updates), ["Context: 42k tokens (21%)"]);
  } finally {
    await agent.close();
    await rm(runtimeRoot, { force: true, recursive: true });
  }
});

test("does not repeat the last reading when a turn ends in failure", async () => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "claude-runtime-context-refusal-test-"));
  const updates: SessionNotification[] = [];
  const spawns: SpawnRecord[] = [];
  let agent!: ClaudeTtyAgent;
  const spawnPty = (file: string, args: string[], options: IPtyForkOptions): Pick<IPty, "pid" | "write" | "kill" | "onData" | "onExit"> => {
    const pty = new FakePty(4400 + spawns.length);
    spawns.push({ file, args, options, pty });
    const sessionId = args[args.indexOf("--session-id") + 1];
    setImmediate(() => void agent.hooks.dispatch({ hook_event_name: "SessionStart", session_id: sessionId }));
    return pty;
  };
  agent = new ClaudeTtyAgent(createConnection(updates), { ...TEST_TIMINGS, spawnPty, runtimeRoot, stateDirectory: path.join(runtimeRoot, "state"), startupTimeoutMs: 500, readinessTimeoutMs: 0, submitDelayMs: 0, contextRefreshTimeoutMs: 200 });

  try {
    const session = await agent.newSession({ cwd: "/work/refusal", mcpServers: [] });
    const contextPath = () => path.join(path.dirname(spawns[0]!.args.at(-1)!), "context.json");

    const first = agent.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "hello" }] });
    await waitFor(() => spawns.length === 1 && spawns[0]!.pty.writes.length === 2);
    const stop = agent.hooks.dispatch({ hook_event_name: "Stop", session_id: session.sessionId, last_assistant_message: "done" });
    await writeFile(contextPath(), contextPayload(42_000, 21));
    await stop;
    assert.deepEqual(await first, { stopReason: "end_turn" });

    // A failed turn reports like any other, so it needs its own baseline: on the previous turn's it would find that turn's reading unmoved and report it a second time.
    const second = agent.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "again" }] });
    await waitFor(() => spawns[0]!.pty.writes.length === 4);
    await agent.hooks.dispatch({ hook_event_name: "StopFailure", session_id: session.sessionId, error: "Claude ran out of context" });
    assert.deepEqual(await second, { stopReason: "refusal" });
    assert.deepEqual(contextLines(updates), ["Context: 42k tokens (21%)"]);
  } finally {
    await agent.close();
    await rm(runtimeRoot, { force: true, recursive: true });
  }
});

test("says nothing about the context when Claude's status line does not refresh", async () => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "claude-runtime-context-quiet-test-"));
  const updates: SessionNotification[] = [];
  const spawns: SpawnRecord[] = [];
  let agent!: ClaudeTtyAgent;
  const spawnPty = (file: string, args: string[], options: IPtyForkOptions): Pick<IPty, "pid" | "write" | "kill" | "onData" | "onExit"> => {
    const pty = new FakePty(3500 + spawns.length);
    spawns.push({ file, args, options, pty });
    const sessionId = args[args.indexOf("--session-id") + 1];
    setImmediate(() => void agent.hooks.dispatch({ hook_event_name: "SessionStart", session_id: sessionId }));
    return pty;
  };
  agent = new ClaudeTtyAgent(createConnection(updates), { ...TEST_TIMINGS, spawnPty, runtimeRoot, stateDirectory: path.join(runtimeRoot, "state"), startupTimeoutMs: 500, readinessTimeoutMs: 0, submitDelayMs: 0, contextRefreshTimeoutMs: 100 });

  try {
    const session = await agent.newSession({ cwd: "/work/quiet", mcpServers: [] });
    const turn = agent.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "hello" }] });
    await waitFor(() => spawns.length === 1 && spawns[0]!.pty.writes.length === 2);
    // A reading that never moves is the one from before the turn, so it is not this turn's.
    await writeFile(path.join(path.dirname(spawns[0]!.args.at(-1)!), "context.json"), contextPayload(20_000, 10));
    await agent.hooks.dispatch({ hook_event_name: "Stop", session_id: session.sessionId, last_assistant_message: "done" });
    assert.deepEqual(await turn, { stopReason: "end_turn" });
    assert.deepEqual(contextLines(updates), []);
  } finally {
    await agent.close();
    await rm(runtimeRoot, { force: true, recursive: true });
  }
});

test("drops the context wait when the turn is cancelled", async () => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "claude-runtime-context-cancel-test-"));
  const updates: SessionNotification[] = [];
  const spawns: SpawnRecord[] = [];
  let agent!: ClaudeTtyAgent;
  const spawnPty = (file: string, args: string[], options: IPtyForkOptions): Pick<IPty, "pid" | "write" | "kill" | "onData" | "onExit"> => {
    const pty = new FakePty(3700 + spawns.length);
    spawns.push({ file, args, options, pty });
    const sessionId = args[args.indexOf("--session-id") + 1];
    setImmediate(() => void agent.hooks.dispatch({ hook_event_name: "SessionStart", session_id: sessionId }));
    return pty;
  };
  agent = new ClaudeTtyAgent(createConnection(updates), { ...TEST_TIMINGS, spawnPty, runtimeRoot, stateDirectory: path.join(runtimeRoot, "state"), startupTimeoutMs: 500, readinessTimeoutMs: 0, submitDelayMs: 0, cancelTimeoutMs: 5, contextRefreshTimeoutMs: 5_000 });

  try {
    const session = await agent.newSession({ cwd: "/work/cancel", mcpServers: [] });
    const turn = agent.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "hello" }] });
    await waitFor(() => spawns.length === 1 && spawns[0]!.pty.writes.length === 2);
    const contextPath = path.join(path.dirname(spawns[0]!.args.at(-1)!), "context.json");

    // A cancelled turn reports nothing about the context, and must not hold the response for the refresh budget while it decides that.
    const started = Date.now();
    await agent.cancel({ sessionId: session.sessionId });
    await writeFile(contextPath, contextPayload(137_400, 69));
    assert.deepEqual(await turn, { stopReason: "cancelled" });
    assert.ok(Date.now() - started < 2_000);
    assert.deepEqual(contextLines(updates), []);
  } finally {
    await agent.close();
    await rm(runtimeRoot, { force: true, recursive: true });
  }
});

test("stops waiting for a context reading when the turn is cancelled mid-wait", async () => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "claude-runtime-context-stop-test-"));
  const updates: SessionNotification[] = [];
  const spawns: SpawnRecord[] = [];
  let agent!: ClaudeTtyAgent;
  const spawnPty = (file: string, args: string[], options: IPtyForkOptions): Pick<IPty, "pid" | "write" | "kill" | "onData" | "onExit"> => {
    const pty = new FakePty(3800 + spawns.length);
    spawns.push({ file, args, options, pty });
    const sessionId = args[args.indexOf("--session-id") + 1];
    setImmediate(() => void agent.hooks.dispatch({ hook_event_name: "SessionStart", session_id: sessionId }));
    return pty;
  };
  agent = new ClaudeTtyAgent(createConnection(updates), { ...TEST_TIMINGS, spawnPty, runtimeRoot, stateDirectory: path.join(runtimeRoot, "state"), startupTimeoutMs: 500, readinessTimeoutMs: 0, submitDelayMs: 0, cancelTimeoutMs: 5, contextRefreshTimeoutMs: 10_000 });

  try {
    const session = await agent.newSession({ cwd: "/work/stop", mcpServers: [] });
    const turn = agent.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "hello" }] });
    await waitFor(() => spawns.length === 1 && spawns[0]!.pty.writes.length === 2);

    // Claude has already stopped, so the turn is over, but the wait for its last reading is still running and the stop button has to reach it.
    await agent.hooks.dispatch({ hook_event_name: "Stop", session_id: session.sessionId, last_assistant_message: "done" });
    const started = Date.now();
    await agent.cancel({ sessionId: session.sessionId });
    assert.deepEqual(await turn, { stopReason: "end_turn" });
    assert.ok(Date.now() - started < 5_000, "the cancel has to end the wait well inside the refresh budget");
    assert.deepEqual(contextLines(updates), []);
  } finally {
    await agent.close();
    await rm(runtimeRoot, { force: true, recursive: true });
  }
});

test("says nothing about the context when the session closes while the wait is reading", async () => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "claude-runtime-context-close-test-"));
  const updates: SessionNotification[] = [];
  const spawns: SpawnRecord[] = [];
  let agent!: ClaudeTtyAgent;
  let contextPath = "";
  let closing: Promise<void> | undefined;
  const spawnPty = (file: string, args: string[], options: IPtyForkOptions): Pick<IPty, "pid" | "write" | "kill" | "onData" | "onExit"> => {
    const pty = new FakePty(4100 + spawns.length);
    spawns.push({ file, args, options, pty });
    const sessionId = args[args.indexOf("--session-id") + 1];
    setImmediate(() => void agent.hooks.dispatch({ hook_event_name: "SessionStart", session_id: sessionId }));
    return pty;
  };
  // The turn's last message is delivered between the Stop hook and the wait, so a close deferred from inside its send lands once the wait is already reading.
  const connection = {
    sessionUpdate: async (notification: SessionNotification) => {
      updates.push(notification);
      const update = notification.update as { sessionUpdate?: string; content?: { type?: string; text?: string } };
      if (update.sessionUpdate !== "agent_message_chunk" || update.content?.text !== "done") return;
      // Nothing writes context.json before the Stop hook here, so the baseline mtime is 0 and this reading is newer whatever the clock does.
      // The test therefore turns on the close alone; pre-writing a stale reading, as the happy-path test does, would let a coarse mtime pass it with the guard reverted.
      await writeFile(contextPath, contextPayload(42_000, 21));
      // setImmediate rather than a timer, because the check phase is what reliably falls between the wait's stat and its read of the file.
      setImmediate(() => {
        closing = agent.close();
      });
    },
  } as unknown as AgentSideConnection;
  agent = new ClaudeTtyAgent(connection, { ...TEST_TIMINGS, spawnPty, runtimeRoot, stateDirectory: path.join(runtimeRoot, "state"), startupTimeoutMs: 500, readinessTimeoutMs: 0, submitDelayMs: 0, contextRefreshTimeoutMs: 500 });

  try {
    const session = await agent.newSession({ cwd: "/work/close", mcpServers: [] });
    const turn = agent.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "hello" }] });
    await waitFor(() => spawns.length === 1 && spawns[0]!.pty.writes.length === 2);
    contextPath = path.join(path.dirname(spawns[0]!.args.at(-1)!), "context.json");

    await agent.hooks.dispatch({ hook_event_name: "Stop", session_id: session.sessionId, last_assistant_message: "done" });
    assert.deepEqual(await turn, { stopReason: "end_turn" }, "a turn that has already completed cannot be failed by the session closing under its context wait");
    assert.deepEqual(contextLines(updates), []);
  } finally {
    await closing;
    await agent.close();
    await rm(runtimeRoot, { force: true, recursive: true });
  }
});

test("stays ready once a status line has taken Claude's shortcut hint away", async () => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "claude-runtime-ready-test-"));
  let agent!: ClaudeTtyAgent;
  let pty!: FakePty;
  const spawnPty = (_file: string, args: string[]): Pick<IPty, "pid" | "write" | "kill" | "onData" | "onExit"> => {
    pty = new FakePty(3900);
    const sessionId = args[args.indexOf("--session-id") + 1];
    // A fresh session in the default mode, as Claude draws it once the adapter has registered a status line:
    // no `? for shortcuts`, no token badge until there is context, and the input box still holding its placeholder.
    setImmediate(() => pty.emitData('\u001b[2J\u001b[H\u276f Try "refactor index.ts"\r\n  \u23f8 manual mode on\r\n'));
    setImmediate(() => void agent.hooks.dispatch({ hook_event_name: "SessionStart", session_id: sessionId }));
    return pty;
  };
  agent = new ClaudeTtyAgent(createConnection([]), { ...TEST_TIMINGS, spawnPty, runtimeRoot, stateDirectory: path.join(runtimeRoot, "state"), startupTimeoutMs: 500, readinessTimeoutMs: 1_000, submitDelayMs: 0, contextRefreshTimeoutMs: 0, clearInputKeyMs: 0 });

  try {
    const session = await agent.newSession({ cwd: "/work/ready", mcpServers: [] });
    const turn = agent.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "hello" }] });
    await waitFor(() => pty !== undefined && pty.writes.length === 2);
    assert.equal(pty.writes[0], "\u001b[200~hello \u001b[201~");
    await agent.hooks.dispatch({ hook_event_name: "Stop", session_id: session.sessionId, last_assistant_message: "done" });
    assert.deepEqual(await turn, { stopReason: "end_turn" });
  } finally {
    await agent.close();
    await rm(runtimeRoot, { force: true, recursive: true });
  }
});

test("keeps a stop that lands while the turn's last message is still in flight", async () => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "claude-runtime-context-race-test-"));
  const updates: SessionNotification[] = [];
  const spawns: SpawnRecord[] = [];
  let agent!: ClaudeTtyAgent;
  let sessionId = "";
  // `finishTurn` clears the turn before `prompt()` delivers the last assistant message, so a stop arriving during that
  // round trip finds no turn to attach to and only has the flag to land on.
  const connection = {
    sessionUpdate: async (notification: SessionNotification) => {
      updates.push(notification);
      const update = notification.update as { sessionUpdate?: string; content?: { text?: string } };
      if (update.sessionUpdate === "agent_message_chunk" && update.content?.text === "done") await agent.cancel({ sessionId });
    },
    extNotification: async () => undefined,
  } as unknown as AgentSideConnection;
  const spawnPty = (file: string, args: string[], options: IPtyForkOptions): Pick<IPty, "pid" | "write" | "kill" | "onData" | "onExit"> => {
    const pty = new FakePty(4000 + spawns.length);
    spawns.push({ file, args, options, pty });
    const claudeSessionId = args[args.indexOf("--session-id") + 1];
    setImmediate(() => void agent.hooks.dispatch({ hook_event_name: "SessionStart", session_id: claudeSessionId }));
    return pty;
  };
  agent = new ClaudeTtyAgent(connection, { ...TEST_TIMINGS, spawnPty, runtimeRoot, stateDirectory: path.join(runtimeRoot, "state"), startupTimeoutMs: 500, readinessTimeoutMs: 0, submitDelayMs: 0, cancelTimeoutMs: 5, contextRefreshTimeoutMs: 10_000 });

  try {
    const session = await agent.newSession({ cwd: "/work/race", mcpServers: [] });
    sessionId = session.sessionId;
    const turn = agent.prompt({ sessionId, prompt: [{ type: "text", text: "hello" }] });
    await waitFor(() => spawns.length === 1 && spawns[0]!.pty.writes.length === 2);
    const started = Date.now();
    await agent.hooks.dispatch({ hook_event_name: "Stop", session_id: sessionId, last_assistant_message: "done" });
    assert.deepEqual(await turn, { stopReason: "end_turn" });
    assert.ok(Date.now() - started < 5_000, "the stop has to end the wait rather than be reset by it");
    assert.deepEqual(contextLines(updates), []);
  } finally {
    await agent.close();
    await rm(runtimeRoot, { force: true, recursive: true });
  }
});

test("stops paying the wait once a session has gone several turns without a reading", async () => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "claude-runtime-context-latch-test-"));
  const updates: SessionNotification[] = [];
  const spawns: SpawnRecord[] = [];
  let agent!: ClaudeTtyAgent;
  const spawnPty = (file: string, args: string[], options: IPtyForkOptions): Pick<IPty, "pid" | "write" | "kill" | "onData" | "onExit"> => {
    const pty = new FakePty(4100 + spawns.length);
    spawns.push({ file, args, options, pty });
    const sessionId = args[args.indexOf("--session-id") + 1];
    setImmediate(() => void agent.hooks.dispatch({ hook_event_name: "SessionStart", session_id: sessionId }));
    return pty;
  };
  agent = new ClaudeTtyAgent(createConnection(updates), { ...TEST_TIMINGS, spawnPty, runtimeRoot, stateDirectory: path.join(runtimeRoot, "state"), startupTimeoutMs: 500, readinessTimeoutMs: 0, submitDelayMs: 0, contextRefreshTimeoutMs: 400 });

  try {
    const session = await agent.newSession({ cwd: "/work/latch", mcpServers: [] });
    // Claude never writes a status line here, which is what a session gets when its build reports no context window at all.
    const durations: number[] = [];
    for (let index = 0; index < 4; index += 1) {
      const turn = agent.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: `turn ${index}` }] });
      await waitFor(() => spawns.length === 1 && spawns[0]!.pty.writes.length === (index + 1) * 2);
      const started = Date.now();
      await agent.hooks.dispatch({ hook_event_name: "Stop", session_id: session.sessionId, last_assistant_message: "done" });
      assert.deepEqual(await turn, { stopReason: "end_turn" });
      durations.push(Date.now() - started);
    }
    assert.deepEqual(contextLines(updates), []);
    assert.ok(durations[0]! - durations[3]! > 250, `the fourth turn must not pay the budget: ${JSON.stringify(durations)}`);
  } finally {
    await agent.close();
    await rm(runtimeRoot, { force: true, recursive: true });
  }
});

test("does not let stopped waits count towards giving up on a session's readings", async () => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "claude-runtime-context-stopcount-test-"));
  const updates: SessionNotification[] = [];
  const spawns: SpawnRecord[] = [];
  let agent!: ClaudeTtyAgent;
  let sessionId = "";
  let stopEveryWait = true;
  // Cancelling a wait says nothing about whether Claude writes readings, so a run of stops must not be read as a session that never reports.
  const connection = {
    sessionUpdate: async (notification: SessionNotification) => {
      updates.push(notification);
      const update = notification.update as { sessionUpdate?: string; content?: { text?: string } };
      if (stopEveryWait && update.sessionUpdate === "agent_message_chunk" && update.content?.text === "done") await agent.cancel({ sessionId });
    },
    extNotification: async () => undefined,
  } as unknown as AgentSideConnection;
  const spawnPty = (file: string, args: string[], options: IPtyForkOptions): Pick<IPty, "pid" | "write" | "kill" | "onData" | "onExit"> => {
    const pty = new FakePty(4200 + spawns.length);
    spawns.push({ file, args, options, pty });
    const claudeSessionId = args[args.indexOf("--session-id") + 1];
    setImmediate(() => void agent.hooks.dispatch({ hook_event_name: "SessionStart", session_id: claudeSessionId }));
    return pty;
  };
  agent = new ClaudeTtyAgent(connection, { ...TEST_TIMINGS, spawnPty, runtimeRoot, stateDirectory: path.join(runtimeRoot, "state"), startupTimeoutMs: 500, readinessTimeoutMs: 0, submitDelayMs: 0, cancelTimeoutMs: 5, contextRefreshTimeoutMs: 2_000 });

  try {
    const session = await agent.newSession({ cwd: "/work/stopcount", mcpServers: [] });
    sessionId = session.sessionId;
    const contextPath = () => path.join(path.dirname(spawns[0]!.args.at(-1)!), "context.json");
    for (let index = 0; index < 3; index += 1) {
      const turn = agent.prompt({ sessionId, prompt: [{ type: "text", text: `turn ${index}` }] });
      await waitFor(() => spawns.length === 1 && spawns[0]!.pty.writes.length === (index + 1) * 2);
      await agent.hooks.dispatch({ hook_event_name: "Stop", session_id: sessionId, last_assistant_message: "done" });
      assert.deepEqual(await turn, { stopReason: "end_turn" });
    }
    assert.deepEqual(contextLines(updates), []);

    // Claude reports again on the next turn, late enough that only a session still willing to wait will see it.
    stopEveryWait = false;
    const turn = agent.prompt({ sessionId, prompt: [{ type: "text", text: "turn 3" }] });
    await waitFor(() => spawns[0]!.pty.writes.length === 8);
    const stop = agent.hooks.dispatch({ hook_event_name: "Stop", session_id: sessionId, last_assistant_message: "done" });
    setTimeout(() => void writeFile(contextPath(), contextPayload(42_000, 21)), AFTER_THE_LOOK_MS);
    await stop;
    assert.deepEqual(await turn, { stopReason: "end_turn" });
    assert.deepEqual(contextLines(updates), ["Context: 42k tokens (21%)"]);
  } finally {
    await agent.close();
    await rm(runtimeRoot, { force: true, recursive: true });
  }
});

test("picks a session back up when its readings resume after it stopped waiting", async () => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "claude-runtime-context-rearm-test-"));
  const updates: SessionNotification[] = [];
  const spawns: SpawnRecord[] = [];
  let agent!: ClaudeTtyAgent;
  const spawnPty = (file: string, args: string[], options: IPtyForkOptions): Pick<IPty, "pid" | "write" | "kill" | "onData" | "onExit"> => {
    const pty = new FakePty(4300 + spawns.length);
    spawns.push({ file, args, options, pty });
    const sessionId = args[args.indexOf("--session-id") + 1];
    setImmediate(() => void agent.hooks.dispatch({ hook_event_name: "SessionStart", session_id: sessionId }));
    return pty;
  };
  agent = new ClaudeTtyAgent(createConnection(updates), { ...TEST_TIMINGS, spawnPty, runtimeRoot, stateDirectory: path.join(runtimeRoot, "state"), startupTimeoutMs: 500, readinessTimeoutMs: 0, submitDelayMs: 0, contextRefreshTimeoutMs: 600 });

  try {
    const session = await agent.newSession({ cwd: "/work/rearm", mcpServers: [] });
    const contextPath = () => path.join(path.dirname(spawns[0]!.args.at(-1)!), "context.json");
    // Claude writes its reading after the Stop hook, so a turn that only looks can never find one: three of these miss and the session stops waiting.
    // The fifth is the one that waits again, and Claude reports on exactly that turn, late enough that only waiting can see it.
    // The sixth misses and the seventh reports again, which holds only because a reading clears the misses: left uncleared, a single miss after recovery drops the session straight back to looking and loses what the seventh turn does write.
    const readings = new Map([
      [4, contextPayload(42_000, 21)],
      [6, contextPayload(55_000, 28)],
    ]);
    for (let index = 0; index < 7; index += 1) {
      const turn = agent.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: `turn ${index}` }] });
      await waitFor(() => spawns.length === 1 && spawns[0]!.pty.writes.length === (index + 1) * 2);
      const stop = agent.hooks.dispatch({ hook_event_name: "Stop", session_id: session.sessionId, last_assistant_message: "done" });
      const reading = readings.get(index);
      if (reading) setTimeout(() => void writeFile(contextPath(), reading), AFTER_THE_LOOK_MS);
      await stop;
      assert.deepEqual(await turn, { stopReason: "end_turn" });
    }
    assert.deepEqual(
      contextLines(updates),
      ["Context: 42k tokens (21%)", "Context: 55k tokens (28%)"],
      "a session whose readings come back has to be picked up again, and stay picked up",
    );
  } finally {
    await agent.close();
    await rm(runtimeRoot, { force: true, recursive: true });
  }
});

// The adapter looks for a reading only once the transcript drain finishes, which is 15 flushes of `transcriptFlushIntervalMs` in a test with no transcript file.
// A reading written this long after the Stop hook therefore lands after that look, which is the only thing separating a turn that waits from a turn that merely looks.
// Two of these tests pass whatever the code does if this drops below the drain, so it is named once rather than spelled at each call site.
const AFTER_THE_LOOK_MS = 300;

function contextPayload(tokens: number, percent: number): string {
  return JSON.stringify({
    context_window: { total_input_tokens: tokens, total_output_tokens: 4, context_window_size: 200_000, used_percentage: percent, remaining_percentage: 100 - percent },
  });
}

function contextLines(updates: SessionNotification[]): string[] {
  return updates.flatMap((notification) => {
    const update = notification.update as { sessionUpdate?: string; content?: { type?: string; text?: string } };
    const text = update.sessionUpdate === "agent_message_chunk" && update.content?.type === "text" ? update.content.text : undefined;
    return text?.startsWith("Context: ") ? [text] : [];
  });
}

test("keeps the whole conversation when Claude asks how to resume a suspended session, and still delivers that prompt", async () => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "claude-runtime-resume-test-"));
  const spawns: SpawnRecord[] = [];
  let agent!: ClaudeTtyAgent;
  const spawnPty = (file: string, args: string[], options: IPtyForkOptions): Pick<IPty, "pid" | "write" | "kill" | "onData" | "onExit"> => {
    let pty!: FakePty;
    const resuming = args.includes("--resume");
    pty = new FakePty(4700 + spawns.length, (data) => {
      if (data === "\u0004") setImmediate(() => pty.emitExit());
      // The dialog moves its marker onto the second option, and Enter takes it and paints the restored conversation.
      if (resuming && data === "\u001b[B") setImmediate(() => pty.emitData(staleResumeScreen("full")));
      if (resuming && data === "\r") setImmediate(() => pty.emitData("\u001b[2J\u001b[H  ⏵⏵ auto mode on\r\n"));
    });
    spawns.push({ file, args, options, pty });
    const idFlag = resuming ? "--resume" : "--session-id";
    const sessionId = args[args.indexOf(idFlag) + 1];
    setImmediate(() => {
      void agent.hooks.dispatch({ hook_event_name: "SessionStart", session_id: sessionId });
      // Claude paints the restored conversation and then asks; that conversation already satisfies every readiness signal on its own.
      pty.emitData(resuming ? staleResumeScreen("summary") : "\u001b[2J\u001b[H  ⏵⏵ auto mode on\r\n");
    });
    return pty;
  };
  agent = new ClaudeTtyAgent(createConnection([]), {
    ...TEST_TIMINGS,
    spawnPty,
    runtimeRoot,
    stateDirectory: path.join(runtimeRoot, "state"),
    startupTimeoutMs: 1_000,
    readinessTimeoutMs: 1_000,
    readyQuietMs: 5,
    staleResumeKeyDelayMs: 0,
    staleResumeSelectionTimeoutMs: 200,
    submitDelayMs: 0,
    contextRefreshTimeoutMs: 0,
    idleTimeoutMs: 20,
  });

  try {
    const created = await agent.newSession({ cwd: "/work/idle-dialog", mcpServers: [] });
    const first = agent.prompt({ sessionId: created.sessionId, prompt: [{ type: "text", text: "first" }] });
    await waitFor(() => spawns.length === 1 && spawns[0]!.pty.writes.length === 2);
    await agent.hooks.dispatch({ hook_event_name: "Stop", session_id: created.sessionId, last_assistant_message: "first done" });
    await first;
    await waitFor(() => agent.sessions.get(created.sessionId)?.started === false);

    const second = agent.prompt({ sessionId: created.sessionId, prompt: [{ type: "text", text: "second" }] });
    await waitFor(() => spawns.length === 2 && spawns[1]!.pty.writes.some((write) => write.startsWith("\u001b[200~")), 3_000);
    const writes = spawns[1]!.pty.writes;
    assert.deepEqual(spawns[1]!.args.slice(0, 2), ["--resume", created.sessionId]);
    // Down then Enter answers with "Resume full session as-is", and the prompt is pasted only after that.
    assert.deepEqual(menuKeys(writes).slice(0, 3), ["down", "\r", "\u001b[200~second \u001b[201~"]);
    await agent.hooks.dispatch({ hook_event_name: "Stop", session_id: created.sessionId, last_assistant_message: "second done" });
    assert.deepEqual(await second, { stopReason: "end_turn" });
  } finally {
    await agent.close();
    await rm(runtimeRoot, { force: true, recursive: true });
  }
});

test("leaves a session running while a card is still waiting on the person who has to answer it", async () => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "claude-runtime-card-test-"));
  const spawns: SpawnRecord[] = [];
  let agent!: ClaudeTtyAgent;
  let answer: ((response: RequestPermissionResponse) => void) | null = null;
  const spawnPty = (file: string, args: string[], options: IPtyForkOptions): Pick<IPty, "pid" | "write" | "kill" | "onData" | "onExit"> => {
    let pty!: FakePty;
    pty = new FakePty(4800 + spawns.length, (data) => {
      if (data === "\u0004") setImmediate(() => pty.emitExit());
    });
    spawns.push({ file, args, options, pty });
    const idFlag = args.includes("--resume") ? "--resume" : "--session-id";
    setImmediate(() => void agent.hooks.dispatch({ hook_event_name: "SessionStart", session_id: args[args.indexOf(idFlag) + 1] }));
    return pty;
  };
  const connection = {
    sessionUpdate: async () => undefined,
    requestPermission: () => new Promise<RequestPermissionResponse>((resolve) => (answer = resolve)),
    extNotification: async () => undefined,
  } as unknown as AgentSideConnection;
  agent = new ClaudeTtyAgent(connection, {
    ...TEST_TIMINGS,
    spawnPty,
    runtimeRoot,
    stateDirectory: path.join(runtimeRoot, "state"),
    startupTimeoutMs: 500,
    readinessTimeoutMs: 0,
    submitDelayMs: 0,
    contextRefreshTimeoutMs: 0,
    // Long enough that the card below is on screen well before the timeout expires.
    idleTimeoutMs: 1_000,
  });

  try {
    const created = await agent.newSession({ cwd: "/work/idle-card", mcpServers: [] });
    const turn = agent.prompt({ sessionId: created.sessionId, prompt: [{ type: "text", text: "ask me" }] });
    await waitFor(() => spawns.length === 1 && spawns[0]!.pty.writes.length === 2);
    await agent.hooks.dispatch({ hook_event_name: "Stop", session_id: created.sessionId, last_assistant_message: "asked" });
    await turn;

    // A card raised outside the turn, the way work Claude is still finishing in the background raises one.
    const question = agent.hooks.dispatch({
      hook_event_name: "PreToolUse",
      session_id: created.sessionId,
      tool_name: "AskUserQuestion",
      tool_use_id: "toolu_1",
      tool_input: { questions: [{ question: "Which one?", options: [{ label: "This one" }] }] },
    });
    await waitFor(() => answer !== null);

    // Well past the timeout: the session is left alone rather than stopped out from under the open card.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    assert.equal(agent.sessions.get(created.sessionId)?.started, true);

    answer!({ outcome: { outcome: "selected", optionId: "answer-0-0" } });
    const decision = (await question) as { hookSpecificOutput?: { permissionDecision?: string } };
    assert.equal(decision.hookSpecificOutput?.permissionDecision, "allow");
  } finally {
    await agent.close();
    await rm(runtimeRoot, { force: true, recursive: true });
  }
});

test("presses again when Claude drops the key that moves its resume question", async () => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "claude-runtime-resume-retry-test-"));
  const spawns: SpawnRecord[] = [];
  let agent!: ClaudeTtyAgent;
  const spawnPty = (file: string, args: string[], options: IPtyForkOptions): Pick<IPty, "pid" | "write" | "kill" | "onData" | "onExit"> => {
    let pty!: FakePty;
    const resuming = args.includes("--resume");
    // Claude paints a menu just before its input state settles, and the key that lands in that gap is dropped.
    let dropped = false;
    pty = new FakePty(4800 + spawns.length, (data) => {
      if (data === "\u0004") setImmediate(() => pty.emitExit());
      if (resuming && data === "\u001b[B" && !dropped) dropped = true;
      else if (resuming && data === "\u001b[B") setImmediate(() => pty.emitData(staleResumeScreen("full")));
      if (resuming && data === "\r") setImmediate(() => pty.emitData("\u001b[2J\u001b[H  auto mode on\r\n"));
    });
    spawns.push({ file, args, options, pty });
    const idFlag = resuming ? "--resume" : "--session-id";
    const sessionId = args[args.indexOf(idFlag) + 1];
    setImmediate(() => {
      void agent.hooks.dispatch({ hook_event_name: "SessionStart", session_id: sessionId });
      pty.emitData(resuming ? staleResumeScreen("summary") : "\u001b[2J\u001b[H  auto mode on\r\n");
    });
    return pty;
  };
  agent = new ClaudeTtyAgent(createConnection([]), {
    ...TEST_TIMINGS,
    spawnPty,
    runtimeRoot,
    stateDirectory: path.join(runtimeRoot, "state"),
    startupTimeoutMs: 1_000,
    readinessTimeoutMs: 1_000,
    readyQuietMs: 5,
    staleResumeKeyDelayMs: 5,
    staleResumeSelectionTimeoutMs: 500,
    submitDelayMs: 0,
    contextRefreshTimeoutMs: 0,
    idleTimeoutMs: 20,
  });

  try {
    const created = await agent.newSession({ cwd: "/work/resume-retry", mcpServers: [] });
    const first = agent.prompt({ sessionId: created.sessionId, prompt: [{ type: "text", text: "first" }] });
    await waitFor(() => spawns.length === 1 && spawns[0]!.pty.writes.length === 2);
    await agent.hooks.dispatch({ hook_event_name: "Stop", session_id: created.sessionId, last_assistant_message: "first done" });
    await first;
    await waitFor(() => agent.sessions.get(created.sessionId)?.started === false);

    const second = agent.prompt({ sessionId: created.sessionId, prompt: [{ type: "text", text: "second" }] });
    await waitFor(() => spawns.length === 2 && spawns[1]!.pty.writes.some((write) => write.startsWith("\u001b[200~")), 3_000);
    const writes = spawns[1]!.pty.writes;
    assert.deepEqual(menuKeys(writes).slice(0, 2), ["down", "\r"]);
    assert.ok(writes.indexOf("\r") >= 2, `did not press down again after the dropped key: ${JSON.stringify(writes)}`);
    await agent.hooks.dispatch({ hook_event_name: "Stop", session_id: created.sessionId, last_assistant_message: "second done" });
    assert.deepEqual(await second, { stopReason: "end_turn" });
  } finally {
    await agent.close();
    await rm(runtimeRoot, { force: true, recursive: true });
  }
});

test("carries on when Claude's resume question is answered before the adapter takes it", async () => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "claude-runtime-resume-gone-test-"));
  const spawns: SpawnRecord[] = [];
  let agent!: ClaudeTtyAgent;
  const spawnPty = (file: string, args: string[], options: IPtyForkOptions): Pick<IPty, "pid" | "write" | "kill" | "onData" | "onExit"> => {
    let pty!: FakePty;
    const resuming = args.includes("--resume");
    pty = new FakePty(4900 + spawns.length, (data) => {
      if (data === "\u0004") setImmediate(() => pty.emitExit());
      // The question goes without the adapter answering it, and Claude resumes on somebody else's answer.
      if (resuming && data === "\u001b[B") setImmediate(() => pty.emitData("\u001b[2J\u001b[H  auto mode on\r\n"));
    });
    spawns.push({ file, args, options, pty });
    const idFlag = resuming ? "--resume" : "--session-id";
    const sessionId = args[args.indexOf(idFlag) + 1];
    setImmediate(() => {
      void agent.hooks.dispatch({ hook_event_name: "SessionStart", session_id: sessionId });
      pty.emitData(resuming ? staleResumeScreen("summary") : "\u001b[2J\u001b[H  auto mode on\r\n");
    });
    return pty;
  };
  agent = new ClaudeTtyAgent(createConnection([]), {
    ...TEST_TIMINGS,
    spawnPty,
    runtimeRoot,
    stateDirectory: path.join(runtimeRoot, "state"),
    startupTimeoutMs: 1_000,
    readinessTimeoutMs: 1_000,
    readyQuietMs: 5,
    staleResumeKeyDelayMs: 5,
    staleResumeSelectionTimeoutMs: 500,
    submitDelayMs: 0,
    contextRefreshTimeoutMs: 0,
    idleTimeoutMs: 20,
  });

  try {
    const created = await agent.newSession({ cwd: "/work/resume-gone", mcpServers: [] });
    const first = agent.prompt({ sessionId: created.sessionId, prompt: [{ type: "text", text: "first" }] });
    await waitFor(() => spawns.length === 1 && spawns[0]!.pty.writes.length === 2);
    await agent.hooks.dispatch({ hook_event_name: "Stop", session_id: created.sessionId, last_assistant_message: "first done" });
    await first;
    await waitFor(() => agent.sessions.get(created.sessionId)?.started === false);

    const second = agent.prompt({ sessionId: created.sessionId, prompt: [{ type: "text", text: "second" }] });
    await waitFor(() => spawns.length === 2 && spawns[1]!.pty.writes.some((write) => write.startsWith("\u001b[200~")), 3_000);
    assert.equal(spawns[1]!.pty.killed, false);
    await agent.hooks.dispatch({ hook_event_name: "Stop", session_id: created.sessionId, last_assistant_message: "second done" });
    assert.deepEqual(await second, { stopReason: "end_turn" });
  } finally {
    await agent.close();
    await rm(runtimeRoot, { force: true, recursive: true });
  }
});

function staleResumeScreen(selected: "summary" | "full"): string {
  return [
    "\u001b[2J\u001b[H",
    "● CI green on the tip commit.",
    "  ⏵⏵ auto mode on",
    "─".repeat(120),
    "  This session is 10h 51m old and 329.7k tokens.",
    "  Resuming the full session will consume a substantial portion of your usage limits. We recommend resuming from a",
    "  summary.",
    selected === "summary" ? "  ❯ 1. Resume from summary (recommended)" : "    1. Resume from summary (recommended)",
    selected === "summary" ? "    2. Resume full session as-is" : "  ❯ 2. Resume full session as-is",
    "    3. Don't ask me again",
    "  Enter to confirm · Esc to cancel",
  ].join("\r\n");
}

test("keeps the turn open while a background agent runs, so the session reads as busy", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "claude-runtime-subagent-test-"));
  const configDirectory = path.join(root, "claude");
  const runtimeRoot = path.join(root, "runtime");
  const cwd = "/work/agents";
  const projectDirectory = path.join(configDirectory, "projects", escapeProjectDirName(cwd));
  await mkdir(projectDirectory, { recursive: true });
  await mkdir(runtimeRoot, { recursive: true });
  let agent!: ClaudeTtyAgent;
  let spawned: FakePty | null = null;
  const spawnPty = (_file: string, args: string[]): Pick<IPty, "pid" | "write" | "kill" | "onData" | "onExit"> => {
    spawned = new FakePty(3600);
    const sessionId = args[args.indexOf("--session-id") + 1]!;
    setImmediate(() => void agent.hooks.dispatch({ hook_event_name: "SessionStart", session_id: sessionId }));
    return spawned;
  };
  agent = new ClaudeTtyAgent(createConnection([]), {
    ...TEST_TIMINGS,
    spawnPty,
    runtimeRoot,
    claudeConfigDir: configDirectory,
    stateDirectory: path.join(root, "state"),
    startupTimeoutMs: 500,
    readinessTimeoutMs: 0,
    submitDelayMs: 0,
    contextRefreshTimeoutMs: 0,
    transcriptPollIntervalMs: 10,
  });

  try {
    const session = await agent.newSession({ cwd, mcpServers: [] });
    const turn = agent.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "launch an agent" }] });
    await waitFor(() => spawned !== null && spawned.writes.length === 2);
    const transcript = path.join(projectDirectory, `${session.sessionId}.jsonl`);
    const launch = [
      JSON.stringify({
        type: "assistant",
        uuid: "launcher",
        message: { content: [{ type: "tool_use", id: "agent-tool", name: "Agent", input: { description: "Count the files" } }] },
      }),
      JSON.stringify({
        type: "user",
        uuid: "launched",
        toolUseResult: { isAsync: true, status: "async_launched", agentId: "a1" },
        message: { content: [{ type: "tool_result", tool_use_id: "agent-tool", content: [] }] },
      }),
    ];
    await writeFile(transcript, `${launch.join("\n")}\n`);

    // Claude goes idle as soon as it has launched the agent, and the agent has done nothing yet.
    let settled = false;
    void turn.then(() => {
      settled = true;
    });
    await agent.hooks.dispatch({ hook_event_name: "Stop", session_id: session.sessionId, last_assistant_message: "LAUNCHED" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(settled, false);

    const notification =
      "<task-notification> <task-id>a1</task-id> <tool-use-id>agent-tool</tool-use-id> <status>completed</status> <summary>Agent finished</summary> </task-notification>";
    await writeFile(
      transcript,
      `${[...launch, JSON.stringify({ type: "user", uuid: "notified", message: { content: notification } })].join("\n")}\n`,
    );
    // The notification wakes Claude for a turn of its own, which ends in the Stop that ends this one.
    await agent.hooks.dispatch({ hook_event_name: "Stop", session_id: session.sessionId, last_assistant_message: "The agent finished." });
    assert.deepEqual(await turn, { stopReason: "end_turn" });
  } finally {
    await agent.close();
    await rm(root, { force: true, recursive: true });
  }
});

test("keeps the turn open while a background command runs, so the session reads as busy", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "claude-runtime-shell-test-"));
  const configDirectory = path.join(root, "claude");
  const runtimeRoot = path.join(root, "runtime");
  const cwd = "/work/shells";
  const projectDirectory = path.join(configDirectory, "projects", escapeProjectDirName(cwd));
  await mkdir(projectDirectory, { recursive: true });
  await mkdir(runtimeRoot, { recursive: true });
  let agent!: ClaudeTtyAgent;
  let spawned: FakePty | null = null;
  const spawnPty = (_file: string, args: string[]): Pick<IPty, "pid" | "write" | "kill" | "onData" | "onExit"> => {
    spawned = new FakePty(4300);
    const sessionId = args[args.indexOf("--session-id") + 1]!;
    setImmediate(() => void agent.hooks.dispatch({ hook_event_name: "SessionStart", session_id: sessionId }));
    return spawned;
  };
  agent = new ClaudeTtyAgent(createConnection([]), {
    ...TEST_TIMINGS,
    spawnPty,
    runtimeRoot,
    claudeConfigDir: configDirectory,
    stateDirectory: path.join(root, "state"),
    startupTimeoutMs: 500,
    readinessTimeoutMs: 0,
    submitDelayMs: 0,
    contextRefreshTimeoutMs: 0,
    transcriptPollIntervalMs: 10,
  });

  try {
    const session = await agent.newSession({ cwd, mcpServers: [] });
    const turn = agent.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "run the suite in the background" }] });
    await waitFor(() => spawned !== null && spawned.writes.length === 2);
    const transcript = path.join(projectDirectory, `${session.sessionId}.jsonl`);
    const launch = [
      JSON.stringify({
        type: "assistant",
        uuid: "launcher",
        message: {
          content: [
            { type: "tool_use", id: "bash-tool", name: "Bash", input: { command: "npm test", description: "Run the tests", run_in_background: true } },
          ],
        },
      }),
      JSON.stringify({
        type: "user",
        uuid: "launched",
        toolUseResult: { stdout: "", stderr: "", backgroundTaskId: "b1" },
        message: { content: [{ type: "tool_result", tool_use_id: "bash-tool", content: [] }] },
      }),
    ];
    await writeFile(transcript, `${launch.join("\n")}\n`);

    // Claude goes idle as soon as it has backgrounded the command, and the command is still running.
    let settled = false;
    void turn.then(() => {
      settled = true;
    });
    await agent.hooks.dispatch({ hook_event_name: "Stop", session_id: session.sessionId, last_assistant_message: "RUNNING" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(settled, false);

    const notification =
      '<task-notification> <task-id>b1</task-id> <tool-use-id>bash-tool</tool-use-id> <status>completed</status> <summary>Background command "Run the tests" completed (exit code 0)</summary> </task-notification>';
    await writeFile(
      transcript,
      `${[...launch, JSON.stringify({ type: "user", uuid: "notified", message: { content: notification } })].join("\n")}\n`,
    );
    // The report wakes Claude for a turn of its own, which ends in the Stop that ends this one.
    await agent.hooks.dispatch({ hook_event_name: "Stop", session_id: session.sessionId, last_assistant_message: "The suite passed." });
    assert.deepEqual(await turn, { stopReason: "end_turn" });
  } finally {
    await agent.close();
    await rm(root, { force: true, recursive: true });
  }
});

test("gives up on a background command that never reports, and does not wait on it again", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "claude-runtime-shell-bound-test-"));
  const configDirectory = path.join(root, "claude");
  const runtimeRoot = path.join(root, "runtime");
  const cwd = "/work/shells-bound";
  const projectDirectory = path.join(configDirectory, "projects", escapeProjectDirName(cwd));
  await mkdir(projectDirectory, { recursive: true });
  await mkdir(runtimeRoot, { recursive: true });
  let agent!: ClaudeTtyAgent;
  let spawned: FakePty | null = null;
  const spawnPty = (_file: string, args: string[]): Pick<IPty, "pid" | "write" | "kill" | "onData" | "onExit"> => {
    spawned = new FakePty(4400);
    const sessionId = args[args.indexOf("--session-id") + 1]!;
    setImmediate(() => void agent.hooks.dispatch({ hook_event_name: "SessionStart", session_id: sessionId }));
    return spawned;
  };
  // A slow poll makes a second hold measurable.
  agent = new ClaudeTtyAgent(createConnection([]), {
    ...TEST_TIMINGS,
    spawnPty,
    runtimeRoot,
    claudeConfigDir: configDirectory,
    stateDirectory: path.join(root, "state"),
    startupTimeoutMs: 500,
    readinessTimeoutMs: 0,
    submitDelayMs: 0,
    contextRefreshTimeoutMs: 0,
    transcriptPollIntervalMs: 10,
    subagentPollMs: 1_000,
    subagentWakeMs: 10,
    backgroundShellMs: 10,
  });

  try {
    const session = await agent.newSession({ cwd, mcpServers: [] });
    const first = agent.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "start the dev server" }] });
    await waitFor(() => spawned !== null && spawned.writes.length === 2);
    await writeFile(
      path.join(projectDirectory, `${session.sessionId}.jsonl`),
      `${[
        JSON.stringify({
          type: "assistant",
          uuid: "launcher",
          message: { content: [{ type: "tool_use", id: "bash-tool", name: "Bash", input: { command: "npm run dev", run_in_background: true } }] },
        }),
        JSON.stringify({
          type: "user",
          uuid: "launched",
          toolUseResult: { stdout: "", stderr: "", backgroundTaskId: "b1" },
          message: { content: [{ type: "tool_result", tool_use_id: "bash-tool", content: [] }] },
        }),
      ].join("\n")}\n`,
    );
    // A server never finishes, so it never reports, and the turn waits its bound out on it.
    await agent.hooks.dispatch({ hook_event_name: "Stop", session_id: session.sessionId, last_assistant_message: "SERVING" });
    assert.deepEqual(await first, { stopReason: "end_turn" });

    const second = agent.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "never mind the server" }] });
    await waitFor(() => spawned !== null && spawned.writes.length === 4);
    const startedAt = Date.now();
    await agent.hooks.dispatch({ hook_event_name: "Stop", session_id: session.sessionId, last_assistant_message: "Never mind." });
    assert.deepEqual(await second, { stopReason: "end_turn" });
    assert.ok(Date.now() - startedAt < 500, `the next turn waited ${Date.now() - startedAt}ms on an abandoned command`);
  } finally {
    await agent.close();
    await rm(root, { force: true, recursive: true });
  }
});

test("goes on waiting for a background command after giving up on the agents beside it", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "claude-runtime-shell-outlives-agent-test-"));
  const configDirectory = path.join(root, "claude");
  const runtimeRoot = path.join(root, "runtime");
  const cwd = "/work/shells-and-agents";
  const projectDirectory = path.join(configDirectory, "projects", escapeProjectDirName(cwd));
  await mkdir(projectDirectory, { recursive: true });
  await mkdir(runtimeRoot, { recursive: true });
  let agent!: ClaudeTtyAgent;
  let spawned: FakePty | null = null;
  const spawnPty = (_file: string, args: string[]): Pick<IPty, "pid" | "write" | "kill" | "onData" | "onExit"> => {
    spawned = new FakePty(4500);
    const sessionId = args[args.indexOf("--session-id") + 1]!;
    setImmediate(() => void agent.hooks.dispatch({ hook_event_name: "SessionStart", session_id: sessionId }));
    return spawned;
  };
  agent = new ClaudeTtyAgent(createConnection([]), {
    ...TEST_TIMINGS,
    spawnPty,
    runtimeRoot,
    claudeConfigDir: configDirectory,
    stateDirectory: path.join(root, "state"),
    startupTimeoutMs: 500,
    readinessTimeoutMs: 0,
    submitDelayMs: 0,
    contextRefreshTimeoutMs: 0,
    transcriptPollIntervalMs: 10,
    subagentPollMs: 10,
    subagentSilenceMs: 10,
    subagentWakeMs: 300,
    backgroundShellMs: 5_000,
  });

  try {
    const session = await agent.newSession({ cwd, mcpServers: [] });
    const turn = agent.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "review it and run the suite" }] });
    await waitFor(() => spawned !== null && spawned.writes.length === 2);
    const transcript = path.join(projectDirectory, `${session.sessionId}.jsonl`);
    const launch = [
      JSON.stringify({
        type: "assistant",
        uuid: "launcher",
        message: {
          content: [
            { type: "tool_use", id: "agent-tool", name: "Agent", input: { description: "Review the branch" } },
            { type: "tool_use", id: "bash-tool", name: "Bash", input: { command: "npm test", run_in_background: true } },
          ],
        },
      }),
      JSON.stringify({
        type: "user",
        uuid: "launched-agent",
        toolUseResult: { isAsync: true, status: "async_launched", agentId: "a1" },
        message: { content: [{ type: "tool_result", tool_use_id: "agent-tool", content: [] }] },
      }),
      JSON.stringify({
        type: "user",
        uuid: "launched-shell",
        toolUseResult: { stdout: "", stderr: "", backgroundTaskId: "b1" },
        message: { content: [{ type: "tool_result", tool_use_id: "bash-tool", content: [] }] },
      }),
    ];
    await writeFile(transcript, `${launch.join("\n")}\n`);

    let settled = false;
    void turn.then(() => {
      settled = true;
    });
    await agent.hooks.dispatch({ hook_event_name: "Stop", session_id: session.sessionId, last_assistant_message: "LAUNCHED" });
    // The agent writes nothing and is well past its bound, as is the wake bound, but the command is still inside its own.
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(settled, false);

    const notification =
      '<task-notification> <task-id>b1</task-id> <status>completed</status> <summary>Background command completed (exit code 0)</summary> </task-notification>';
    const reportedAt = Date.now();
    await writeFile(
      transcript,
      `${[...launch, JSON.stringify({ type: "user", uuid: "notified", message: { content: notification } })].join("\n")}\n`,
    );
    // The report is what wakes Claude, so the turn ends on the agent it had already waited out only once the wake bound has run out too.
    assert.deepEqual(await turn, { stopReason: "end_turn" });
    assert.ok(Date.now() - reportedAt >= 250, `the turn ended ${Date.now() - reportedAt}ms after the report, inside the wake bound`);
  } finally {
    await agent.close();
    await rm(root, { force: true, recursive: true });
  }
});

test("goes on waiting for an agent inside its bound after giving up on the command beside it", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "claude-runtime-agent-outlives-shell-test-"));
  const configDirectory = path.join(root, "claude");
  const runtimeRoot = path.join(root, "runtime");
  const cwd = "/work/agents-and-shells";
  const projectDirectory = path.join(configDirectory, "projects", escapeProjectDirName(cwd));
  await mkdir(projectDirectory, { recursive: true });
  await mkdir(runtimeRoot, { recursive: true });
  let agent!: ClaudeTtyAgent;
  let spawned: FakePty | null = null;
  const spawnPty = (_file: string, args: string[]): Pick<IPty, "pid" | "write" | "kill" | "onData" | "onExit"> => {
    spawned = new FakePty(4600);
    const sessionId = args[args.indexOf("--session-id") + 1]!;
    setImmediate(() => void agent.hooks.dispatch({ hook_event_name: "SessionStart", session_id: sessionId }));
    return spawned;
  };
  agent = new ClaudeTtyAgent(createConnection([]), {
    ...TEST_TIMINGS,
    spawnPty,
    runtimeRoot,
    claudeConfigDir: configDirectory,
    stateDirectory: path.join(root, "state"),
    startupTimeoutMs: 500,
    readinessTimeoutMs: 0,
    submitDelayMs: 0,
    contextRefreshTimeoutMs: 0,
    transcriptPollIntervalMs: 10,
    subagentPollMs: 10,
    subagentSilenceMs: 5_000,
    subagentWakeMs: 100,
    backgroundShellMs: 10,
  });

  try {
    const session = await agent.newSession({ cwd, mcpServers: [] });
    const turn = agent.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "review it and serve it" }] });
    await waitFor(() => spawned !== null && spawned.writes.length === 2);
    const transcript = path.join(projectDirectory, `${session.sessionId}.jsonl`);
    const launch = [
      JSON.stringify({
        type: "assistant",
        uuid: "launcher",
        message: {
          content: [
            { type: "tool_use", id: "agent-tool", name: "Agent", input: { description: "Review the branch" } },
            { type: "tool_use", id: "bash-tool", name: "Bash", input: { command: "npm run dev", run_in_background: true } },
          ],
        },
      }),
      JSON.stringify({
        type: "user",
        uuid: "launched-agent",
        toolUseResult: { isAsync: true, status: "async_launched", agentId: "a1" },
        message: { content: [{ type: "tool_result", tool_use_id: "agent-tool", content: [] }] },
      }),
      JSON.stringify({
        type: "user",
        uuid: "launched-shell",
        toolUseResult: { stdout: "", stderr: "", backgroundTaskId: "b1" },
        message: { content: [{ type: "tool_result", tool_use_id: "bash-tool", content: [] }] },
      }),
    ];
    await writeFile(transcript, `${launch.join("\n")}\n`);

    let settled = false;
    void turn.then(() => {
      settled = true;
    });
    await agent.hooks.dispatch({ hook_event_name: "Stop", session_id: session.sessionId, last_assistant_message: "LAUNCHED" });
    // The command is a server, which never reports and is well past its bound, but the agent is still inside its own.
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(settled, false);

    const notification =
      '<task-notification> <task-id>a1</task-id> <tool-use-id>agent-tool</tool-use-id> <status>completed</status> <summary>Agent "Review the branch" finished</summary> </task-notification>';
    await writeFile(
      transcript,
      `${[...launch, JSON.stringify({ type: "user", uuid: "notified", message: { content: notification } })].join("\n")}\n`,
    );
    assert.deepEqual(await turn, { stopReason: "end_turn" });
  } finally {
    await agent.close();
    await rm(root, { force: true, recursive: true });
  }
});

test("takes a message during a turn held for a background agent without interrupting Claude", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "claude-runtime-chat-during-agent-test-"));
  const configDirectory = path.join(root, "claude");
  const runtimeRoot = path.join(root, "runtime");
  const cwd = "/work/agents-chat";
  const projectDirectory = path.join(configDirectory, "projects", escapeProjectDirName(cwd));
  await mkdir(projectDirectory, { recursive: true });
  await mkdir(runtimeRoot, { recursive: true });
  let agent!: ClaudeTtyAgent;
  let spawned: FakePty | null = null;
  const spawnPty = (_file: string, args: string[]): Pick<IPty, "pid" | "write" | "kill" | "onData" | "onExit"> => {
    spawned = new FakePty(3750);
    const sessionId = args[args.indexOf("--session-id") + 1]!;
    setImmediate(() => void agent.hooks.dispatch({ hook_event_name: "SessionStart", session_id: sessionId }));
    return spawned;
  };
  agent = new ClaudeTtyAgent(createConnection([]), {
    ...TEST_TIMINGS,
    spawnPty,
    runtimeRoot,
    claudeConfigDir: configDirectory,
    stateDirectory: path.join(root, "state"),
    startupTimeoutMs: 500,
    readinessTimeoutMs: 0,
    submitDelayMs: 0,
    contextRefreshTimeoutMs: 0,
    transcriptPollIntervalMs: 10,
  });

  try {
    const session = await agent.newSession({ cwd, mcpServers: [] });
    const turn = agent.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "launch an agent" }] });
    await waitFor(() => spawned !== null && spawned.writes.length === 2);
    await writeFile(
      path.join(projectDirectory, `${session.sessionId}.jsonl`),
      `${[
        JSON.stringify({
          type: "assistant",
          uuid: "launcher",
          message: { content: [{ type: "tool_use", id: "agent-tool", name: "Agent", input: { description: "Count the files" } }] },
        }),
        JSON.stringify({
          type: "user",
          uuid: "launched",
          toolUseResult: { isAsync: true, status: "async_launched", agentId: "a1" },
          message: { content: [{ type: "tool_result", tool_use_id: "agent-tool", content: [] }] },
        }),
      ].join("\n")}\n`,
    );
    await agent.hooks.dispatch({ hook_event_name: "Stop", session_id: session.sessionId, last_assistant_message: "LAUNCHED" });

    // Claude is back at its prompt and the turn is only being held so the agent's report has somewhere to
    // land, which is how every message sent while a subagent runs arrives: Paseo cancels, then re-prompts.
    await agent.cancel({ sessionId: session.sessionId });
    assert.deepEqual(await turn, { stopReason: "cancelled" });
    const keys = (spawned as unknown as FakePty).keystrokes;
    assert.ok(!keys.includes("\u001b"), `a held turn was cancelled with an Escape: ${JSON.stringify(keys)}`);

    // And the message that replaces it goes in as an ordinary prompt, with the agent still waited on.
    const second = agent.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "what do you think?" }] });
    await waitFor(() => (spawned as unknown as FakePty).writes.length === 4);
    assert.equal((spawned as unknown as FakePty).writes[2], "\u001b[200~what do you think? \u001b[201~");
    await agent.hooks.dispatch({ hook_event_name: "Stop", session_id: session.sessionId, last_assistant_message: "ANSWERED" });
    await agent.cancel({ sessionId: session.sessionId });
    assert.deepEqual(await second, { stopReason: "cancelled" }, "the second turn is held for the same agent, which is still running");
  } finally {
    await agent.close();
    await rm(root, { force: true, recursive: true });
  }
});

test("goes on holding the turn for a command the agent backgrounded, after the agent itself reported", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "claude-runtime-agent-shell-test-"));
  const configDirectory = path.join(root, "claude");
  const runtimeRoot = path.join(root, "runtime");
  const cwd = "/work/agent-shell";
  const projectDirectory = path.join(configDirectory, "projects", escapeProjectDirName(cwd));
  await mkdir(projectDirectory, { recursive: true });
  await mkdir(runtimeRoot, { recursive: true });
  let agent!: ClaudeTtyAgent;
  let spawned: FakePty | null = null;
  const spawnPty = (_file: string, args: string[]): Pick<IPty, "pid" | "write" | "kill" | "onData" | "onExit"> => {
    spawned = new FakePty(3780);
    const sessionId = args[args.indexOf("--session-id") + 1]!;
    setImmediate(() => void agent.hooks.dispatch({ hook_event_name: "SessionStart", session_id: sessionId }));
    return spawned;
  };
  agent = new ClaudeTtyAgent(createConnection([]), {
    ...TEST_TIMINGS,
    spawnPty,
    runtimeRoot,
    claudeConfigDir: configDirectory,
    stateDirectory: path.join(root, "state"),
    startupTimeoutMs: 500,
    readinessTimeoutMs: 0,
    submitDelayMs: 0,
    contextRefreshTimeoutMs: 0,
    transcriptPollIntervalMs: 10,
    subagentPollMs: 10,
    subagentWakeMs: 20,
    subagentSilenceMs: 5_000,
  });

  try {
    const session = await agent.newSession({ cwd, mcpServers: [] });
    const transcript = path.join(projectDirectory, `${session.sessionId}.jsonl`);
    const first = agent.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "count to sixty" }] });
    await waitFor(() => spawned !== null && spawned.writes.length === 2);
    const records = [
      JSON.stringify({
        type: "assistant",
        uuid: "launcher",
        message: { content: [{ type: "tool_use", id: "agent-tool", name: "Agent", input: { description: "Count" } }] },
      }),
      JSON.stringify({
        type: "user",
        uuid: "launched",
        toolUseResult: { isAsync: true, status: "async_launched", agentId: "a1" },
        message: { content: [{ type: "tool_result", tool_use_id: "agent-tool", content: [] }] },
      }),
    ];
    await writeFile(transcript, `${records.join("\n")}\n`);
    await agent.hooks.dispatch({ hook_event_name: "Stop", session_id: session.sessionId, last_assistant_message: "LAUNCHED" });

    // The agent backgrounds the counting itself and reports the moment it has launched it, so its own
    // report says nothing about whether the work is over.
    const subagents = subagentsDirectory(transcript);
    await mkdir(subagents, { recursive: true });
    await writeFile(
      path.join(subagents, "agent-a1.jsonl"),
      `${JSON.stringify({ type: "user", uuid: "bg", toolUseResult: { stdout: "", stderr: "", backgroundTaskId: "b9" } })}\n`,
    );
    await new Promise((resolve) => setTimeout(resolve, 400));
    records.push(
      JSON.stringify({
        type: "user",
        uuid: "agent-done",
        message: { content: "<task-notification> <task-id>a1</task-id> <status>completed</status> <summary>Agent finished</summary> </task-notification>" },
      }),
    );
    await writeFile(transcript, `${records.join("\n")}\n`);
    await new Promise((resolve) => setTimeout(resolve, 200));

    // A message now, which is what the session's own turn ends on. The command is still running, so it holds.
    await agent.cancel({ sessionId: session.sessionId });
    assert.deepEqual(await first, { stopReason: "cancelled" });
    const second = agent.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "is it done?" }] });
    let settled = false;
    void second.then(() => {
      settled = true;
    });
    await waitFor(() => (spawned as unknown as FakePty).writes.length === 4);
    await agent.hooks.dispatch({ hook_event_name: "Stop", session_id: session.sessionId, last_assistant_message: "STILL GOING" });
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(settled, false, "the session read as done while a command its agent backgrounded was still running");

    // It ends when that command reports, at the Stop of the turn that answered for it.
    // Only as a queue record: a command a subagent backgrounded is never reported in a user turn, and the
    // `queued_command` attachment beside it carries what was queued as a prompt rather than this.
    records.push(
      JSON.stringify({
        type: "queue-operation",
        operation: "enqueue",
        uuid: "shell-done",
        content: "<task-notification> <task-id>b9</task-id> <status>completed</status> <summary>Background command completed (exit code 0)</summary> </task-notification>",
      }),
    );
    await writeFile(transcript, `${records.join("\n")}\n`);
    await new Promise((resolve) => setTimeout(resolve, 200));
    await agent.hooks.dispatch({ hook_event_name: "Stop", session_id: session.sessionId, last_assistant_message: "It counted to sixty." });
    // Bounded, so a wait that never ends fails here rather than hanging the run.
    await waitFor(() => settled, 2_000);
    assert.deepEqual(await second, { stopReason: "end_turn" });
  } finally {
    await agent.close();
    await rm(root, { force: true, recursive: true });
  }
});

test("puts an agent back to work when Claude sends it another message", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "claude-runtime-agent-resume-test-"));
  const configDirectory = path.join(root, "claude");
  const runtimeRoot = path.join(root, "runtime");
  const cwd = "/work/agent-resume";
  const projectDirectory = path.join(configDirectory, "projects", escapeProjectDirName(cwd));
  await mkdir(projectDirectory, { recursive: true });
  await mkdir(runtimeRoot, { recursive: true });
  let agent!: ClaudeTtyAgent;
  let spawned: FakePty | null = null;
  const spawnPty = (_file: string, args: string[]): Pick<IPty, "pid" | "write" | "kill" | "onData" | "onExit"> => {
    spawned = new FakePty(3790);
    const sessionId = args[args.indexOf("--session-id") + 1]!;
    setImmediate(() => void agent.hooks.dispatch({ hook_event_name: "SessionStart", session_id: sessionId }));
    return spawned;
  };
  agent = new ClaudeTtyAgent(createConnection([]), {
    ...TEST_TIMINGS,
    spawnPty,
    runtimeRoot,
    claudeConfigDir: configDirectory,
    stateDirectory: path.join(root, "state"),
    startupTimeoutMs: 500,
    readinessTimeoutMs: 0,
    submitDelayMs: 0,
    contextRefreshTimeoutMs: 0,
    transcriptPollIntervalMs: 10,
    subagentPollMs: 10,
    subagentWakeMs: 1_000,
    subagentSilenceMs: 5_000,
  });

  try {
    const session = await agent.newSession({ cwd, mcpServers: [] });
    const transcript = path.join(projectDirectory, `${session.sessionId}.jsonl`);
    const first = agent.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "start an agent" }] });
    await waitFor(() => spawned !== null && spawned.writes.length === 2);
    const records = [
      JSON.stringify({
        type: "assistant",
        uuid: "launcher",
        message: { content: [{ type: "tool_use", id: "agent-tool", name: "Agent", input: { description: "Watch" } }] },
      }),
      JSON.stringify({
        type: "user",
        uuid: "launched",
        toolUseResult: { isAsync: true, status: "async_launched", agentId: "a1" },
        message: { content: [{ type: "tool_result", tool_use_id: "agent-tool", content: [] }] },
      }),
    ];
    await writeFile(transcript, `${records.join("\n")}\n`);
    await agent.hooks.dispatch({ hook_event_name: "Stop", session_id: session.sessionId, last_assistant_message: "LAUNCHED" });

    // Claude notifies every time an agent stops, and the same agent may notify many times over. This one
    // closes the card, and the turn that was holding for it ends.
    records.push(
      JSON.stringify({
        type: "user",
        uuid: "agent-stopped",
        message: { content: "<task-notification> <task-id>a1</task-id> <status>completed</status> <summary>Agent finished</summary> </task-notification>" },
      }),
    );
    await writeFile(transcript, `${records.join("\n")}\n`);
    await new Promise((resolve) => setTimeout(resolve, 200));
    await agent.hooks.dispatch({ hook_event_name: "Stop", session_id: session.sessionId, last_assistant_message: "IT REPORTED" });
    assert.deepEqual(await first, { stopReason: "end_turn" });

    // The turn that replaces it sends the agent another message, which starts it again.
    const second = agent.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "ask it how far it got" }] });
    let settled = false;
    void second.then(() => {
      settled = true;
    });
    await waitFor(() => (spawned as unknown as FakePty).writes.length === 4);
    records.push(
      JSON.stringify({
        type: "assistant",
        uuid: "messenger",
        message: { content: [{ type: "tool_use", id: "message-tool", name: "SendMessage", input: { to: "a1" } }] },
      }),
      JSON.stringify({
        type: "user",
        uuid: "messaged",
        toolUseResult: { success: true, message: "Resuming agent a1", resumedAgentId: "a1", pin: { id: "a1" } },
        message: { content: [{ type: "tool_result", tool_use_id: "message-tool", content: [] }] },
      }),
    );
    await writeFile(transcript, `${records.join("\n")}\n`);
    await new Promise((resolve) => setTimeout(resolve, 200));
    await agent.hooks.dispatch({ hook_event_name: "Stop", session_id: session.sessionId, last_assistant_message: "ASKED IT" });
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(settled, false, "the session read as done while the agent it had just messaged was running again");

    // And the agent's next report is what closes it, as it was the first time.
    records.push(
      JSON.stringify({
        type: "user",
        uuid: "agent-stopped-again",
        message: { content: "<task-notification> <task-id>a1</task-id> <status>completed</status> <summary>Agent finished</summary> </task-notification>" },
      }),
    );
    await writeFile(transcript, `${records.join("\n")}\n`);
    await new Promise((resolve) => setTimeout(resolve, 200));
    await agent.hooks.dispatch({ hook_event_name: "Stop", session_id: session.sessionId, last_assistant_message: "It got to twenty-seven." });
    await waitFor(() => settled, 2_000);
    assert.deepEqual(await second, { stopReason: "end_turn" });
  } finally {
    await agent.close();
    await rm(root, { force: true, recursive: true });
  }
});

test("a turn waiting on a background agent still cancels at once", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "claude-runtime-subagent-cancel-test-"));
  const configDirectory = path.join(root, "claude");
  const runtimeRoot = path.join(root, "runtime");
  const cwd = "/work/agents-cancel";
  const projectDirectory = path.join(configDirectory, "projects", escapeProjectDirName(cwd));
  await mkdir(projectDirectory, { recursive: true });
  await mkdir(runtimeRoot, { recursive: true });
  let agent!: ClaudeTtyAgent;
  let spawned: FakePty | null = null;
  const spawnPty = (_file: string, args: string[]): Pick<IPty, "pid" | "write" | "kill" | "onData" | "onExit"> => {
    spawned = new FakePty(3700);
    const sessionId = args[args.indexOf("--session-id") + 1]!;
    setImmediate(() => void agent.hooks.dispatch({ hook_event_name: "SessionStart", session_id: sessionId }));
    return spawned;
  };
  agent = new ClaudeTtyAgent(createConnection([]), {
    ...TEST_TIMINGS,
    spawnPty,
    runtimeRoot,
    claudeConfigDir: configDirectory,
    stateDirectory: path.join(root, "state"),
    startupTimeoutMs: 500,
    readinessTimeoutMs: 0,
    submitDelayMs: 0,
    contextRefreshTimeoutMs: 0,
    transcriptPollIntervalMs: 10,
  });

  try {
    const session = await agent.newSession({ cwd, mcpServers: [] });
    const turn = agent.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "launch an agent" }] });
    await waitFor(() => spawned !== null && spawned.writes.length === 2);
    await writeFile(
      path.join(projectDirectory, `${session.sessionId}.jsonl`),
      `${[
        JSON.stringify({
          type: "assistant",
          uuid: "launcher",
          message: { content: [{ type: "tool_use", id: "agent-tool", name: "Agent", input: { description: "Count the files" } }] },
        }),
        JSON.stringify({
          type: "user",
          uuid: "launched",
          toolUseResult: { isAsync: true, status: "async_launched", agentId: "a1" },
          message: { content: [{ type: "tool_result", tool_use_id: "agent-tool", content: [] }] },
        }),
      ].join("\n")}\n`,
    );
    await agent.hooks.dispatch({ hook_event_name: "Stop", session_id: session.sessionId, last_assistant_message: "LAUNCHED" });

    // Paseo replaces a prompt sent mid-turn by cancelling first, and gives the turn 2s to answer.
    // This runs on the production cancel timeout, because the budget is what the test is about.
    const startedAt = Date.now();
    await agent.cancel({ sessionId: session.sessionId });
    assert.deepEqual(await turn, { stopReason: "cancelled" });
    assert.ok(Date.now() - startedAt < 2_000, `a held turn took ${Date.now() - startedAt}ms to cancel`);
  } finally {
    await agent.close();
    await rm(root, { force: true, recursive: true });
  }
});

test("stops waiting when the agent that reported never wakes Claude to answer for it", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "claude-runtime-subagent-wake-test-"));
  const configDirectory = path.join(root, "claude");
  const runtimeRoot = path.join(root, "runtime");
  const cwd = "/work/agents-wake";
  const projectDirectory = path.join(configDirectory, "projects", escapeProjectDirName(cwd));
  await mkdir(projectDirectory, { recursive: true });
  await mkdir(runtimeRoot, { recursive: true });
  let agent!: ClaudeTtyAgent;
  let spawned: FakePty | null = null;
  const spawnPty = (_file: string, args: string[]): Pick<IPty, "pid" | "write" | "kill" | "onData" | "onExit"> => {
    spawned = new FakePty(3800);
    const sessionId = args[args.indexOf("--session-id") + 1]!;
    setImmediate(() => void agent.hooks.dispatch({ hook_event_name: "SessionStart", session_id: sessionId }));
    return spawned;
  };
  agent = new ClaudeTtyAgent(createConnection([]), {
    ...TEST_TIMINGS,
    spawnPty,
    runtimeRoot,
    claudeConfigDir: configDirectory,
    stateDirectory: path.join(root, "state"),
    startupTimeoutMs: 500,
    readinessTimeoutMs: 0,
    submitDelayMs: 0,
    contextRefreshTimeoutMs: 0,
    transcriptPollIntervalMs: 10,
    subagentPollMs: 10,
    subagentWakeMs: 30,
  });

  try {
    const session = await agent.newSession({ cwd, mcpServers: [] });
    const turn = agent.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "launch an agent" }] });
    await waitFor(() => spawned !== null && spawned.writes.length === 2);
    const notification =
      "<task-notification> <task-id>a1</task-id> <status>completed</status> <summary>Agent finished</summary> </task-notification>";
    await writeFile(
      path.join(projectDirectory, `${session.sessionId}.jsonl`),
      `${[
        JSON.stringify({
          type: "assistant",
          uuid: "launcher",
          message: { content: [{ type: "tool_use", id: "agent-tool", name: "Agent", input: { description: "Count the files" } }] },
        }),
        JSON.stringify({
          type: "user",
          uuid: "launched",
          toolUseResult: { isAsync: true, status: "async_launched", agentId: "a1" },
          message: { content: [{ type: "tool_result", tool_use_id: "agent-tool", content: [] }] },
        }),
      ].join("\n")}\n`,
    );
    await agent.hooks.dispatch({ hook_event_name: "Stop", session_id: session.sessionId, last_assistant_message: "LAUNCHED" });
    // The agent reports, and nothing else ever happens: no answer, and no Stop hook to end the turn.
    await writeFile(
      path.join(projectDirectory, `${session.sessionId}.jsonl`),
      `${JSON.stringify({ type: "user", uuid: "notified", message: { content: notification } })}\n`,
    );

    assert.deepEqual(await turn, { stopReason: "end_turn" });
  } finally {
    await agent.close();
    await rm(root, { force: true, recursive: true });
  }
});

test("goes on waiting while Claude is answering for the agent that reported", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "claude-runtime-subagent-answer-test-"));
  const configDirectory = path.join(root, "claude");
  const runtimeRoot = path.join(root, "runtime");
  const cwd = "/work/agents-answer";
  const projectDirectory = path.join(configDirectory, "projects", escapeProjectDirName(cwd));
  await mkdir(projectDirectory, { recursive: true });
  await mkdir(runtimeRoot, { recursive: true });
  let agent!: ClaudeTtyAgent;
  let spawned: FakePty | null = null;
  const spawnPty = (_file: string, args: string[]): Pick<IPty, "pid" | "write" | "kill" | "onData" | "onExit"> => {
    spawned = new FakePty(4000);
    const sessionId = args[args.indexOf("--session-id") + 1]!;
    setImmediate(() => void agent.hooks.dispatch({ hook_event_name: "SessionStart", session_id: sessionId }));
    return spawned;
  };
  agent = new ClaudeTtyAgent(createConnection([]), {
    ...TEST_TIMINGS,
    spawnPty,
    runtimeRoot,
    claudeConfigDir: configDirectory,
    stateDirectory: path.join(root, "state"),
    startupTimeoutMs: 500,
    readinessTimeoutMs: 0,
    submitDelayMs: 0,
    contextRefreshTimeoutMs: 0,
    transcriptPollIntervalMs: 10,
    subagentPollMs: 10,
    subagentWakeMs: 400,
  });

  try {
    const session = await agent.newSession({ cwd, mcpServers: [] });
    const turn = agent.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "launch an agent" }] });
    await waitFor(() => spawned !== null && spawned.writes.length === 2);
    const transcript = path.join(projectDirectory, `${session.sessionId}.jsonl`);
    const records = [
      JSON.stringify({
        type: "assistant",
        uuid: "launcher",
        message: { content: [{ type: "tool_use", id: "agent-tool", name: "Agent", input: { description: "Count the files" } }] },
      }),
      JSON.stringify({
        type: "user",
        uuid: "launched",
        toolUseResult: { isAsync: true, status: "async_launched", agentId: "a1" },
        message: { content: [{ type: "tool_result", tool_use_id: "agent-tool", content: [] }] },
      }),
    ];
    await writeFile(transcript, `${records.join("\n")}\n`);
    let settled = false;
    void turn.then(() => {
      settled = true;
    });
    await agent.hooks.dispatch({ hook_event_name: "Stop", session_id: session.sessionId, last_assistant_message: "LAUNCHED" });

    // The agent reports, and Claude wakes to answer for it — which is subagent silence, and work.
    records.push(
      JSON.stringify({
        type: "user",
        uuid: "notified",
        message: { content: "<task-notification> <task-id>a1</task-id> <status>completed</status> <summary>done</summary> </task-notification>" },
      }),
    );
    await writeFile(transcript, `${records.join("\n")}\n`);
    for (let index = 0; index < 6; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      records.push(JSON.stringify({ type: "assistant", uuid: `answer-${index}`, message: { content: [{ type: "text", text: `Reading the report, part ${index}` }] } }));
      await writeFile(transcript, `${records.join("\n")}\n`);
    }
    // Well past the wake bound, and the turn is still open because the session is still writing.
    assert.equal(settled, false);

    // It ends where it always ends: at the Stop hook of the turn that answered.
    await agent.hooks.dispatch({ hook_event_name: "Stop", session_id: session.sessionId, last_assistant_message: "The agent counted them." });
    assert.deepEqual(await turn, { stopReason: "end_turn" });
  } finally {
    await agent.close();
    await rm(root, { force: true, recursive: true });
  }
});

test("goes on waiting while Claude is running tools for the agent that reported, before it has said anything", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "claude-runtime-subagent-tools-test-"));
  const configDirectory = path.join(root, "claude");
  const runtimeRoot = path.join(root, "runtime");
  const cwd = "/work/agents-tools";
  const projectDirectory = path.join(configDirectory, "projects", escapeProjectDirName(cwd));
  await mkdir(projectDirectory, { recursive: true });
  await mkdir(runtimeRoot, { recursive: true });
  let agent!: ClaudeTtyAgent;
  let spawned: FakePty | null = null;
  const spawnPty = (_file: string, args: string[]): Pick<IPty, "pid" | "write" | "kill" | "onData" | "onExit"> => {
    spawned = new FakePty(4100);
    const sessionId = args[args.indexOf("--session-id") + 1]!;
    setImmediate(() => void agent.hooks.dispatch({ hook_event_name: "SessionStart", session_id: sessionId }));
    return spawned;
  };
  agent = new ClaudeTtyAgent(createConnection([]), {
    ...TEST_TIMINGS,
    spawnPty,
    runtimeRoot,
    claudeConfigDir: configDirectory,
    stateDirectory: path.join(root, "state"),
    startupTimeoutMs: 500,
    readinessTimeoutMs: 0,
    submitDelayMs: 0,
    contextRefreshTimeoutMs: 0,
    transcriptPollIntervalMs: 10,
    subagentPollMs: 10,
    subagentWakeMs: 400,
  });

  try {
    const session = await agent.newSession({ cwd, mcpServers: [] });
    const turn = agent.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "launch an agent" }] });
    await waitFor(() => spawned !== null && spawned.writes.length === 2);
    const transcript = path.join(projectDirectory, `${session.sessionId}.jsonl`);
    const records = [
      JSON.stringify({
        type: "assistant",
        uuid: "launcher",
        message: { content: [{ type: "tool_use", id: "agent-tool", name: "Agent", input: { description: "Count the files" } }] },
      }),
      JSON.stringify({
        type: "user",
        uuid: "launched",
        toolUseResult: { isAsync: true, status: "async_launched", agentId: "a1" },
        message: { content: [{ type: "tool_result", tool_use_id: "agent-tool", content: [] }] },
      }),
    ];
    await writeFile(transcript, `${records.join("\n")}\n`);
    let settled = false;
    void turn.then(() => {
      settled = true;
    });
    await agent.hooks.dispatch({ hook_event_name: "Stop", session_id: session.sessionId, last_assistant_message: "LAUNCHED" });

    // The agent reports, and Claude wakes to check its work: it thinks and runs tools, and has said nothing yet.
    records.push(
      JSON.stringify({
        type: "user",
        uuid: "notified",
        message: { content: "<task-notification> <task-id>a1</task-id> <status>completed</status> <summary>done</summary> </task-notification>" },
      }),
    );
    await writeFile(transcript, `${records.join("\n")}\n`);
    for (let index = 0; index < 6; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      records.push(
        JSON.stringify({
          type: "assistant",
          uuid: `check-${index}`,
          message: {
            content: [
              { type: "thinking", thinking: `Verifying part ${index}` },
              { type: "tool_use", id: `check-tool-${index}`, name: "Bash", input: { command: `ls ${index}`, description: "Check the count" } },
            ],
          },
        }),
      );
      await writeFile(transcript, `${records.join("\n")}\n`);
    }
    // Well past the wake bound, and the turn is still open because the session is still working.
    assert.equal(settled, false);

    await agent.hooks.dispatch({ hook_event_name: "Stop", session_id: session.sessionId, last_assistant_message: "The agent counted them." });
    assert.deepEqual(await turn, { stopReason: "end_turn" });
  } finally {
    await agent.close();
    await rm(root, { force: true, recursive: true });
  }
});

test("stops counting the agents a turn gave up on, so a later turn does not wait on them again", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "claude-runtime-subagent-abandon-test-"));
  const configDirectory = path.join(root, "claude");
  const runtimeRoot = path.join(root, "runtime");
  const cwd = "/work/agents-abandon";
  const projectDirectory = path.join(configDirectory, "projects", escapeProjectDirName(cwd));
  await mkdir(projectDirectory, { recursive: true });
  await mkdir(runtimeRoot, { recursive: true });
  let agent!: ClaudeTtyAgent;
  let spawned: FakePty | null = null;
  const spawnPty = (_file: string, args: string[]): Pick<IPty, "pid" | "write" | "kill" | "onData" | "onExit"> => {
    spawned = new FakePty(4100);
    const sessionId = args[args.indexOf("--session-id") + 1]!;
    setImmediate(() => void agent.hooks.dispatch({ hook_event_name: "SessionStart", session_id: sessionId }));
    return spawned;
  };
  // A poll this slow is what makes the difference visible: a turn that still counted the abandoned
  // agent would hold for a whole interval before giving up on it a second time.
  agent = new ClaudeTtyAgent(createConnection([]), {
    ...TEST_TIMINGS,
    spawnPty,
    runtimeRoot,
    claudeConfigDir: configDirectory,
    stateDirectory: path.join(root, "state"),
    startupTimeoutMs: 500,
    readinessTimeoutMs: 0,
    submitDelayMs: 0,
    contextRefreshTimeoutMs: 0,
    transcriptPollIntervalMs: 10,
    subagentPollMs: 1_000,
    subagentSilenceMs: 10,
    subagentWakeMs: 10,
  });

  try {
    const session = await agent.newSession({ cwd, mcpServers: [] });
    const first = agent.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "launch an agent" }] });
    await waitFor(() => spawned !== null && spawned.writes.length === 2);
    await writeFile(
      path.join(projectDirectory, `${session.sessionId}.jsonl`),
      `${[
        JSON.stringify({
          type: "assistant",
          uuid: "launcher",
          message: { content: [{ type: "tool_use", id: "agent-tool", name: "Agent", input: { description: "Count the files" } }] },
        }),
        JSON.stringify({
          type: "user",
          uuid: "launched",
          toolUseResult: { isAsync: true, status: "async_launched", agentId: "a1" },
          message: { content: [{ type: "tool_result", tool_use_id: "agent-tool", content: [] }] },
        }),
      ].join("\n")}\n`,
    );
    // The agent never writes anything, so the turn gives up on it.
    await agent.hooks.dispatch({ hook_event_name: "Stop", session_id: session.sessionId, last_assistant_message: "LAUNCHED" });
    assert.deepEqual(await first, { stopReason: "end_turn" });

    const second = agent.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "never mind the agent" }] });
    await waitFor(() => spawned !== null && spawned.writes.length === 4);
    const startedAt = Date.now();
    await agent.hooks.dispatch({ hook_event_name: "Stop", session_id: session.sessionId, last_assistant_message: "Never mind." });
    assert.deepEqual(await second, { stopReason: "end_turn" });
    assert.ok(Date.now() - startedAt < 500, `the next turn waited ${Date.now() - startedAt}ms on an abandoned agent`);
  } finally {
    await agent.close();
    await rm(root, { force: true, recursive: true });
  }
});

test("closes a background agent's card when the session it ran in is suspended", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "claude-runtime-subagent-suspend-test-"));
  const configDirectory = path.join(root, "claude");
  const runtimeRoot = path.join(root, "runtime");
  const cwd = "/work/agents-suspend";
  const projectDirectory = path.join(configDirectory, "projects", escapeProjectDirName(cwd));
  await mkdir(projectDirectory, { recursive: true });
  await mkdir(runtimeRoot, { recursive: true });
  const updates: SessionNotification[] = [];
  let agent!: ClaudeTtyAgent;
  let spawned: FakePty | null = null;
  const spawnPty = (_file: string, args: string[]): Pick<IPty, "pid" | "write" | "kill" | "onData" | "onExit"> => {
    let pty!: FakePty;
    pty = new FakePty(3900, (data) => {
      if (data === "\u0004") setImmediate(() => pty.emitExit());
    });
    spawned = pty;
    const sessionId = args[args.indexOf("--session-id") + 1]!;
    setImmediate(() => void agent.hooks.dispatch({ hook_event_name: "SessionStart", session_id: sessionId }));
    return pty;
  };
  agent = new ClaudeTtyAgent(createConnection(updates), {
    ...TEST_TIMINGS,
    spawnPty,
    runtimeRoot,
    claudeConfigDir: configDirectory,
    stateDirectory: path.join(root, "state"),
    startupTimeoutMs: 500,
    readinessTimeoutMs: 0,
    submitDelayMs: 0,
    contextRefreshTimeoutMs: 0,
    transcriptPollIntervalMs: 10,
    subagentPollMs: 10,
    subagentSilenceMs: 30,
    subagentWakeMs: 30,
    idleTimeoutMs: 20,
  });

  try {
    const session = await agent.newSession({ cwd, mcpServers: [] });
    const turn = agent.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "launch an agent" }] });
    await waitFor(() => spawned !== null && spawned.writes.length === 2);
    await writeFile(
      path.join(projectDirectory, `${session.sessionId}.jsonl`),
      `${[
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
      ].join("\n")}\n`,
    );
    // The agent goes quiet without ever reporting, so the turn gives up on it and the session goes idle.
    await agent.hooks.dispatch({ hook_event_name: "Stop", session_id: session.sessionId, last_assistant_message: "LAUNCHED" });
    assert.deepEqual(await turn, { stopReason: "end_turn" });
    // The suspension stops Claude, and with it any agent it was still running.
    await waitFor(() => updates.some((sent) => sent.update.sessionUpdate === "tool_call_update" && sent.update.status === "failed"));

    const closed = updates.map((update) => update.update).filter((update) => update.sessionUpdate === "tool_call_update").at(-1);
    assert.ok(closed?.sessionUpdate === "tool_call_update");
    assert.equal(closed.toolCallId, "agent-tool");
    assert.equal(closed.status, "failed");
    assert.deepEqual(closed.content, [
      { type: "content", content: { type: "text", text: "Claude stopped before this agent reported back." } },
    ]);
  } finally {
    await agent.close();
    await rm(root, { force: true, recursive: true });
  }
});

// Claude's footer is the indicator it keeps for the mode plus " on", and half of the indicators do not end in "mode".
// A fresh adapter-launched session has no other readiness signal: the status line suppresses `? for shortcuts`,
// the token badge needs context the session does not have yet, and the input box still holds its placeholder.
// The Default mode sends no flag, so that session starts in the mode Claude's own settings name, "don't ask" among them.
for (const [modeId, footer] of [
  ["bypassPermissions", "bypass permissions on"],
  ["acceptEdits", "accept edits on"],
  [undefined, "don't ask on"],
] as const) {
  test(`reads a fresh ${modeId ?? "settings-default"} session as ready from its "${footer}" footer`, async () => {
    const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "claude-runtime-mode-footer-test-"));
    const spawns: SpawnRecord[] = [];
    let agent!: ClaudeTtyAgent;
    const spawnPty = (file: string, args: string[], options: IPtyForkOptions): Pick<IPty, "pid" | "write" | "kill" | "onData" | "onExit"> => {
      const pty = new FakePty(5200 + spawns.length);
      spawns.push({ file, args, options, pty });
      const sessionId = args[args.indexOf("--session-id") + 1];
      setImmediate(() => {
        void agent.hooks.dispatch({ hook_event_name: "SessionStart", session_id: sessionId });
        pty.emitData(freshModeScreen(footer));
      });
      return pty;
    };
    agent = new ClaudeTtyAgent(createConnection([]), {
    ...TEST_TIMINGS,
      spawnPty,
      runtimeRoot,
      stateDirectory: path.join(runtimeRoot, "state"),
      startupTimeoutMs: 1_000,
      readinessTimeoutMs: 1_000,
      readyQuietMs: 5,
      submitDelayMs: 0,
      contextRefreshTimeoutMs: 0,
    });

    try {
      const created = await agent.newSession({ cwd: "/work/mode-footer", mcpServers: [] });
      if (modeId) await agent.setSessionMode({ sessionId: created.sessionId, modeId });
      const turn = agent.prompt({ sessionId: created.sessionId, prompt: [{ type: "text", text: "go" }] });
      await waitFor(() => spawns.length === 1 && spawns[0]!.pty.writes.some((write) => write.startsWith("\u001b[200~")), 3_000);
      const modeArgs = spawns[0]!.args.includes("--permission-mode") ? spawns[0]!.args.slice(2, 4) : [];
      assert.deepEqual(modeArgs, modeId ? ["--permission-mode", modeId] : []);
      await agent.hooks.dispatch({ hook_event_name: "Stop", session_id: created.sessionId, last_assistant_message: "done" });
      assert.deepEqual(await turn, { stopReason: "end_turn" });
    } finally {
      await agent.close();
      await rm(runtimeRoot, { force: true, recursive: true });
    }
  });
}

test("asks through ACP before accepting Claude's bypass permissions disclaimer", async () => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "claude-runtime-bypass-test-"));
  const cwd = "/work/unattended";
  const permissionRequests: RequestPermissionRequest[] = [];
  let agent!: ClaudeTtyAgent;
  let spawned: FakePty | null = null;
  const connection = {
    sessionUpdate: async () => undefined,
    requestPermission: async (request: RequestPermissionRequest): Promise<RequestPermissionResponse> => {
      permissionRequests.push(request);
      return { outcome: { outcome: "selected", optionId: "accept-bypass" } };
    },
    extNotification: async () => undefined,
  } as unknown as AgentSideConnection;
  const spawnPty = (_file: string, args: string[]): Pick<IPty, "pid" | "write" | "kill" | "onData" | "onExit"> => {
    const sessionId = args[args.indexOf("--session-id") + 1]!;
    let accepted = false;
    const pty = new FakePty(5300, (data) => {
      if (data === "\u001b[B") setImmediate(() => pty.emitData(bypassPermissionsScreen("accept")));
      // Claude only reaches its SessionStart hook once the disclaimer has been answered.
      if (data === "\r" && !accepted) {
        accepted = true;
        setImmediate(() => void agent.hooks.dispatch({ hook_event_name: "SessionStart", session_id: sessionId }));
      }
    });
    spawned = pty;
    setImmediate(() => pty.emitData(bypassPermissionsScreen("exit")));
    return pty;
  };
  agent = new ClaudeTtyAgent(connection, {
    ...TEST_TIMINGS,
    spawnPty,
    runtimeRoot,
    stateDirectory: path.join(runtimeRoot, "state"),
    startupTimeoutMs: 500,
    readinessTimeoutMs: 0,
    submitDelayMs: 0,
    contextRefreshTimeoutMs: 0,
    clearInputKeyMs: 0,
    bypassPermissionsKeyDelayMs: 0,
    bypassPermissionsSelectionTimeoutMs: ANSWERED_MENU_TIMEOUT_MS,
  });

  try {
    const session = await agent.newSession({ cwd, mcpServers: [] });
    await agent.setSessionMode({ sessionId: session.sessionId, modeId: "bypassPermissions" });
    const turn = agent.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "hello" }] });
    await waitFor(() => permissionRequests.length === 1 && spawned !== null && menuKeys(spawned.writes).length === 4);
    assert.equal(permissionRequests[0]!.toolCall.title, "Run Claude Code without asking permission for anything?");
    assert.deepEqual(permissionRequests[0]!.options, [
      { optionId: "deny-bypass", name: "No, exit", kind: "reject_once" },
      { optionId: "accept-bypass", name: "Yes, I accept", kind: "reject_once" },
    ]);
    assert.deepEqual(menuKeys((spawned as unknown as FakePty).writes), ["down", "\r", "\u001b[200~hello \u001b[201~", "\r"]);
    await agent.hooks.dispatch({ hook_event_name: "Stop", session_id: session.sessionId, last_assistant_message: "done" });
    assert.deepEqual(await turn, { stopReason: "end_turn" });
  } finally {
    await agent.close();
    await rm(runtimeRoot, { force: true, recursive: true });
  }
});

// A resumed session repaints its conversation before its input box exists, and a conversation about the disclaimer carries every string the dialog does.
test("leaves a session in another mode alone when its screen only quotes the disclaimer", async () => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "claude-runtime-quoted-disclaimer-test-"));
  const permissionRequests: RequestPermissionRequest[] = [];
  let agent!: ClaudeTtyAgent;
  const pty = new FakePty(5500);
  const connection = {
    sessionUpdate: async () => undefined,
    requestPermission: async (request: RequestPermissionRequest): Promise<RequestPermissionResponse> => {
      permissionRequests.push(request);
      return { outcome: { outcome: "selected", optionId: "accept-bypass" } };
    },
    extNotification: async () => undefined,
  } as unknown as AgentSideConnection;
  agent = new ClaudeTtyAgent(connection, {
    ...TEST_TIMINGS,
    spawnPty: (_file: string, args: string[]) => {
      const sessionId = args[args.indexOf("--session-id") + 1]!;
      setImmediate(() => pty.emitData(bypassPermissionsScreen("exit")));
      // Late enough that the startup loop reads the quoted dialog off the screen before Claude reports itself started.
      setTimeout(() => void agent.hooks.dispatch({ hook_event_name: "SessionStart", session_id: sessionId }), 150);
      return pty;
    },
    runtimeRoot,
    stateDirectory: path.join(runtimeRoot, "state"),
    startupTimeoutMs: 2_000,
    readinessTimeoutMs: 0,
    submitDelayMs: 0,
    contextRefreshTimeoutMs: 0,
  });

  try {
    const session = await agent.newSession({ cwd: "/work/quoted", mcpServers: [] });
    const turn = agent.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "hello" }] });
    await waitFor(() => pty.writes.length === 2, 3_000);
    assert.deepEqual(permissionRequests, []);
    // Nothing was answered on Claude's behalf: no menu keys, only the prompt.
    assert.deepEqual(pty.writes, ["\u001b[200~hello \u001b[201~", "\r"]);
    await agent.hooks.dispatch({ hook_event_name: "Stop", session_id: session.sessionId, last_assistant_message: "done" });
    assert.deepEqual(await turn, { stopReason: "end_turn" });
  } finally {
    await agent.close();
    await rm(runtimeRoot, { force: true, recursive: true });
  }
});

test("fails the start rather than run in another mode when the bypass disclaimer is declined", async () => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "claude-runtime-bypass-declined-test-"));
  const pty = new FakePty(5400);
  const connection = {
    sessionUpdate: async () => undefined,
    requestPermission: async (): Promise<RequestPermissionResponse> => ({ outcome: { outcome: "selected", optionId: "deny-bypass" } }),
    extNotification: async () => undefined,
  } as unknown as AgentSideConnection;
  const agent = new ClaudeTtyAgent(connection, {
    ...TEST_TIMINGS,
    spawnPty: () => {
      setImmediate(() => pty.emitData(bypassPermissionsScreen("exit")));
      return pty;
    },
    runtimeRoot,
    stateDirectory: path.join(runtimeRoot, "state"),
    startupTimeoutMs: 500,
    readinessTimeoutMs: 0,
    submitDelayMs: 0,
    contextRefreshTimeoutMs: 0,
    clearInputKeyMs: 0,
    bypassPermissionsKeyDelayMs: 0,
    bypassPermissionsSelectionTimeoutMs: ANSWERED_MENU_TIMEOUT_MS,
  });

  try {
    const session = await agent.newSession({ cwd: "/work/declined", mcpServers: [] });
    await agent.setSessionMode({ sessionId: session.sessionId, modeId: "bypassPermissions" });
    await assert.rejects(
      agent.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "hello" }] }),
      /Bypass Permissions disclaimer/,
    );
    assert.equal(pty.killed, true);
    // Nothing was answered on Claude's behalf.
    assert.deepEqual(pty.writes, []);
  } finally {
    await agent.close();
    await rm(runtimeRoot, { force: true, recursive: true });
  }
});

// The card Claude's disclaimer raises is waiting before the session has a turn, and an unattended session is the one with nobody to answer it.
test("lets a cancelled session go when nobody answers the bypass disclaimer", { timeout: 10_000 }, async () => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "claude-runtime-bypass-cancel-test-"));
  const pty = new FakePty(5600);
  let asked = false;
  const connection = {
    sessionUpdate: async () => undefined,
    requestPermission: (): Promise<RequestPermissionResponse> => {
      asked = true;
      return new Promise<RequestPermissionResponse>(() => undefined);
    },
    extNotification: async () => undefined,
  } as unknown as AgentSideConnection;
  const agent = new ClaudeTtyAgent(connection, {
    ...TEST_TIMINGS,
    spawnPty: () => {
      setImmediate(() => pty.emitData(bypassPermissionsScreen("exit")));
      return pty;
    },
    runtimeRoot,
    stateDirectory: path.join(runtimeRoot, "state"),
    startupTimeoutMs: 500,
    readinessTimeoutMs: 0,
    submitDelayMs: 0,
    contextRefreshTimeoutMs: 0,
  });

  try {
    const session = await agent.newSession({ cwd: "/work/unanswered", mcpServers: [] });
    await agent.setSessionMode({ sessionId: session.sessionId, modeId: "bypassPermissions" });
    const turn = agent.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "hello" }] });
    await waitFor(() => asked, 3_000);
    await agent.cancel({ sessionId: session.sessionId });
    await assert.rejects(turn, /Bypass Permissions disclaimer/);
    assert.equal(pty.killed, true);
  } finally {
    await agent.close();
    await rm(runtimeRoot, { force: true, recursive: true });
  }
});

/** What an adapter-launched session paints once it is up: a status line in place of the hints, and an input box still holding its placeholder. */
function freshModeScreen(footer: string): string {
  return [
    "\u001b[2J\u001b[H",
    "─".repeat(120),
    '❯ Try "fix the failing test"',
    "─".repeat(120),
    `  ⏵⏵ ${footer} (shift+tab to cycle) · ← for agents`,
  ].join("\r\n");
}

function bypassPermissionsScreen(selected: "exit" | "accept"): string {
  return [
    "\u001b[2J\u001b[H",
    "WARNING: Claude Code running in Bypass Permissions mode",
    "In Bypass Permissions mode, Claude Code will not ask for your approval before running potentially dangerous",
    "commands.",
    "This mode should only be used in a sandboxed container/VM that has restricted internet access and can easily be",
    "restored if damaged.",
    "By proceeding, you accept all responsibility for actions taken while running in Bypass Permissions mode.",
    "https://code.claude.com/docs/en/security",
    selected === "exit" ? "❯ No, exit" : "  No, exit",
    selected === "exit" ? "  Yes, I accept" : "❯ Yes, I accept",
    "Enter to confirm · Esc to cancel",
  ].join("\r\n");
}

test("goes on waiting on a silent agent while Claude itself is still working", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "claude-runtime-subagent-busy-test-"));
  const configDirectory = path.join(root, "claude");
  const runtimeRoot = path.join(root, "runtime");
  const cwd = "/work/agents-busy";
  const projectDirectory = path.join(configDirectory, "projects", escapeProjectDirName(cwd));
  await mkdir(projectDirectory, { recursive: true });
  await mkdir(runtimeRoot, { recursive: true });
  const updates: SessionNotification[] = [];
  let agent!: ClaudeTtyAgent;
  let spawned: FakePty | null = null;
  const spawnPty = (_file: string, args: string[]): Pick<IPty, "pid" | "write" | "kill" | "onData" | "onExit"> => {
    let pty!: FakePty;
    pty = new FakePty(4100, (data) => {
      if (data === "\u0004") setImmediate(() => pty.emitExit());
    });
    spawned = pty;
    const sessionId = args[args.indexOf("--session-id") + 1]!;
    setImmediate(() => void agent.hooks.dispatch({ hook_event_name: "SessionStart", session_id: sessionId }));
    return pty;
  };
  agent = new ClaudeTtyAgent(createConnection(updates), {
    ...TEST_TIMINGS,
    spawnPty,
    runtimeRoot,
    claudeConfigDir: configDirectory,
    stateDirectory: path.join(root, "state"),
    startupTimeoutMs: 500,
    readinessTimeoutMs: 0,
    submitDelayMs: 0,
    contextRefreshTimeoutMs: 0,
    transcriptPollIntervalMs: 10,
    subagentPollMs: 10,
    subagentSilenceMs: 120,
    subagentWakeMs: 500,
    idleTimeoutMs: 0,
  });

  try {
    const session = await agent.newSession({ cwd, mcpServers: [] });
    const turn = agent.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "launch an agent" }] });
    await waitFor(() => spawned !== null && spawned.writes.length === 2);
    const file = path.join(projectDirectory, `${session.sessionId}.jsonl`);
    const lines = [
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
    ];
    await writeFile(file, `${lines.join("\n")}\n`);
    await agent.hooks.dispatch({ hook_event_name: "Stop", session_id: session.sessionId, last_assistant_message: "LAUNCHED" });

    // The agent never writes again, well past its bound.
    // Claude does, all the way through it.
    let settled = false;
    void turn.then(() => {
      settled = true;
    });
    let busy = 0;
    const writing = setInterval(() => {
      busy += 1;
      void appendFile(file, `${JSON.stringify({ type: "assistant", uuid: `busy-${busy}`, message: { content: [{ type: "text", text: "still going" }] } })}\n`);
    }, 40);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    clearInterval(writing);
    assert.ok(busy > 0, "Claude wrote nothing during the bound, so the test proved nothing");
    assert.equal(settled, false);

    const quietAt = Date.now();
    assert.deepEqual(await turn, { stopReason: "end_turn" });
    assert.ok(Date.now() - quietAt < 2_000, `the turn waited ${Date.now() - quietAt}ms after Claude had gone quiet as well`);
  } finally {
    await agent.close();
    await rm(root, { force: true, recursive: true });
  }
});

test("stops the adapter once the directory of every session it holds is gone", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "claude-runtime-workspaces-test-"));
  const runtimeRoot = path.join(root, "runtime");
  const stateDirectory = path.join(root, "state");
  const created = path.join(root, "created");
  const loaded = path.join(root, "loaded");
  await mkdir(runtimeRoot, { recursive: true });
  await mkdir(created);
  await mkdir(loaded);
  const acpSessionId = "55555555-5555-4555-8555-555555555555";
  await new StateStore(stateDirectory).save({
    version: 1,
    acpSessionId,
    claudeSessionId: "66666666-6666-4666-8666-666666666666",
    cwd: loaded,
    model: "inherit",
    mode: "default",
    lastActivity: 1,
  });
  let removed = 0;
  const spawnPty = (): Pick<IPty, "pid" | "write" | "kill" | "onData" | "onExit"> => new FakePty(1);
  const agent = new ClaudeTtyAgent(createConnection([]), {
    ...TEST_TIMINGS,
    spawnPty,
    runtimeRoot,
    stateDirectory,
    claudeConfigDir: path.join(root, "claude"),
    startupTimeoutMs: 500,
    readinessTimeoutMs: 0,
    submitDelayMs: 0,
    contextRefreshTimeoutMs: 0,
    onWorkspacesRemoved: () => {
      removed += 1;
    },
    workspaceCheckIntervalMs: 10,
  });

  try {
    await agent.newSession({ cwd: created, mcpServers: [] });
    await agent.loadSession({ sessionId: acpSessionId, cwd: loaded, mcpServers: [] });

    await rm(created, { force: true, recursive: true });
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(removed, 0, "stopped an adapter that still had a session to serve");

    await rm(loaded, { force: true, recursive: true });
    await waitFor(() => removed === 1, 2_000);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(removed, 1, "stopped the adapter more than once");
  } finally {
    await agent.close();
    await rm(root, { force: true, recursive: true });
  }
});

test("lets go of the directories of a closed adapter's sessions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "claude-runtime-workspaces-closed-test-"));
  const runtimeRoot = path.join(root, "runtime");
  const cwd = path.join(root, "workspace");
  await mkdir(runtimeRoot, { recursive: true });
  await mkdir(cwd);
  let removed = 0;
  const spawnPty = (): Pick<IPty, "pid" | "write" | "kill" | "onData" | "onExit"> => new FakePty(1);
  const agent = new ClaudeTtyAgent(createConnection([]), {
    ...TEST_TIMINGS,
    spawnPty,
    runtimeRoot,
    stateDirectory: path.join(root, "state"),
    startupTimeoutMs: 500,
    readinessTimeoutMs: 0,
    submitDelayMs: 0,
    contextRefreshTimeoutMs: 0,
    onWorkspacesRemoved: () => {
      removed += 1;
    },
    workspaceCheckIntervalMs: 10,
  });

  try {
    await agent.newSession({ cwd, mcpServers: [] });
    await agent.close();

    await rm(cwd, { force: true, recursive: true });
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(removed, 0, "stopped a process whose adapter was already closed");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

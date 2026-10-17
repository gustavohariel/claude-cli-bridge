#!/usr/bin/env node
// claude-sdk-tty: a stand-in for the `claude` binary that the Claude Agent SDK spawns.
//
// The SDK runs `claude --input-format stream-json --output-format stream-json ...` and talks
// to it over stdio. This program answers that protocol, but runs each session in the real
// interactive Claude Code CLI inside a PTY (through claude-tty-acp's runtime), so usage is
// billed and cached the way an interactive session is. Transcript records are re-emitted as
// SDK messages, permission prompts go back to the SDK host as `can_use_tool` requests, and
// control requests the PTY cannot answer (initialize, get_usage, ...) go to a short-lived
// headless CLI that never receives a prompt.
//
// Anything that is not an SDK streaming session (`--version`, `-p` one-shots, the host's
// capability probe) is handed to the real CLI unchanged.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync, readdirSync, mkdirSync, appendFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TTY_ACP_DIST = process.env.CLAUDE_SDK_TTY_ACP_DIST || path.join(HERE, "..", "claude-tty-acp", "dist");
const STATE_DIR = process.env.CLAUDE_SDK_TTY_STATE_DIR || path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "claude-sdk-tty");
const LOG_FILE = path.join(STATE_DIR, "bridge.log");
const DELEGATE_IDLE_MS = 60_000;
const SDK_ENV_KEYS = ["CLAUDE_CODE_ENTRYPOINT", "CLAUDE_AGENT_SDK_VERSION", "CLAUDE_CODE_EXECPATH", "CLAUDE_AGENT_SDK_CLIENT_APP"];

// ── entry ───────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const realClaude = resolveRealClaude();

function isSdkSession(args) {
  if (process.env.CLAUDE_SDK_TTY_DISABLE === "1") return false;
  const input = flagValue(args, "--input-format");
  const output = flagValue(args, "--output-format");
  if (input !== "stream-json" || output !== "stream-json") return false;
  // The host's periodic capability probe never prompts, and structured output has no interactive form.
  if (args.includes("--no-session-persistence") || hasFlag(args, "--json-schema")) return false;
  return true;
}

function passthrough(args) {
  const child = spawn(realClaude, args, { stdio: "inherit" });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => child.kill(signal));
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 1);
  });
  child.on("error", (error) => {
    process.stderr.write(`claude-sdk-tty: could not start ${realClaude}: ${error.message}\n`);
    process.exit(127);
  });
}

function resolveRealClaude() {
  const configured = process.env.CLAUDE_SDK_TTY_REAL_CLAUDE;
  if (configured) return configured;
  const self = safeRealpath(process.argv[1]);
  const launcher = path.join(HERE, "bin");
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, "claude");
    if (!existsSync(candidate)) continue;
    const real = safeRealpath(candidate);
    if (real === self || real.startsWith(HERE) || dir === launcher) continue;
    return candidate;
  }
  return "claude";
}

function safeRealpath(file) {
  try {
    return realpathSync(file);
  } catch {
    return file;
  }
}

// ── argv ────────────────────────────────────────────────────────────

const BOOLEAN_FLAGS = new Set([
  "--verbose", "--include-partial-messages", "--strict-mcp-config", "--allow-dangerously-skip-permissions",
  "--dangerously-skip-permissions", "--fork-session", "--continue", "--no-session-persistence", "--include-hook-events",
  "--replay-user-messages", "--await-initialize", "--debug-to-stderr", "--hard-fail", "--porcelain", "--no-heading",
  "--plugin-dir-no-mcp", "--debug", "--permission-prompts",
]);
// Flags the interactive CLI takes as they are.
const PASSTHROUGH_FLAGS = new Set([
  "--add-dir", "--allowedTools", "--disallowedTools", "--tools", "--append-system-prompt", "--system-prompt",
  "--strict-mcp-config", "--allow-dangerously-skip-permissions", "--dangerously-skip-permissions", "--fork-session",
  "--fallback-model", "--plugin-dir", "--agent", "--agents", "--betas", "--setting-sources", "--debug-file",
  "--thinking-display", "--max-thinking-tokens",
]);

function parseArgs(args) {
  const flags = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith("--")) {
      flags.push([arg, null]);
      continue;
    }
    const eq = arg.indexOf("=");
    if (eq > 0) {
      flags.push([arg.slice(0, eq), arg.slice(eq + 1)]);
    } else if (BOOLEAN_FLAGS.has(arg) || i + 1 >= args.length || args[i + 1].startsWith("--")) {
      flags.push([arg, null]);
    } else {
      flags.push([arg, args[i + 1]]);
      i += 1;
    }
  }
  return flags;
}

function flagValue(args, name) {
  const found = parseArgs(args).findLast(([flag]) => flag === name);
  return found ? found[1] : undefined;
}

function hasFlag(args, name) {
  return parseArgs(args).some(([flag]) => flag === name);
}

// ── logging ─────────────────────────────────────────────────────────

let logReady = false;
function log(message, data) {
  try {
    if (!logReady) {
      mkdirSync(STATE_DIR, { recursive: true });
      logReady = true;
    }
    appendFileSync(LOG_FILE, `${new Date().toISOString()} [${process.pid}] ${message}${data === undefined ? "" : ` ${truncate(JSON.stringify(data), 2000)}`}\n`);
  } catch {}
}

function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

// ── bridge ──────────────────────────────────────────────────────────

class Bridge {
  constructor(args) {
    this.args = args;
    this.flags = parseArgs(args);
    this.cwd = process.cwd();
    const resume = this.flag("--resume");
    this.sessionId = resume || this.flag("--session-id") || randomUUID();
    this.resume = Boolean(resume);
    this.model = this.flag("--model") || "inherit";
    this.mode = this.flag("--permission-mode") || "default";
    this.effort = this.flag("--effort") || "inherit";
    this.canUseTool = this.flag("--permission-prompt-tool") === "stdio";
    this.sdkSettings = parseSettings(this.flag("--settings"));
    this.mcpServers = readMcpConfig(this.flag("--mcp-config"));
    this.appendSystemPrompt = this.flag("--append-system-prompt");
    this.systemPrompt = this.flag("--system-prompt");
    this.pendingControl = new Map();
    this.toolUseIds = new Map(); // tool name + input -> tool_use_id, from PreToolUse for the PermissionRequest that follows
    this.hostAsks = 0;
    this.queue = [];
    this.pumping = false;
    this.turn = null;
    this.turnEnded = null;
    this.seen = new Set();
    this.tasks = new Map(); // task_id -> { toolUseId, type, description, background, startedAt, toolUses, lastTool }
    this.agentToolUse = new Map(); // agentId -> toolUseId
    this.toolUseAgent = new Map(); // toolUseId -> agentId
    this.agentTools = new Map(); // toolUseId -> tool_use block (Agent/Task launches)
    this.backgroundShells = new Map(); // toolUseId -> description
    this.rootToolUses = new Set(); // tool_use ids the host has already been sent
    this.heldSubagentRecords = new Map(); // toolUseId -> [[record, agentId]] that arrived before their Agent call
    this.notifiedTasks = new Set();
    this.agentMeta = new Map();
    this.closed = false;
    this.delegate = null;
    this.version = null;
    this.commands = [];
    this.initialized = false;
    this.prestarted = null;
  }

  flag(name) {
    const found = this.flags.findLast(([flag]) => flag === name);
    return found ? (found[1] ?? true) : undefined;
  }

  send(message) {
    if (this.closed && message.type !== "control_response") return;
    process.stdout.write(`${JSON.stringify(message)}\n`);
  }

  async run() {
    log("bridge start", { args: this.args, cwd: this.cwd, realClaude });
    this.applyResumeSessionAt();
    this.seedSeen();
    await this.loadRuntime();
    const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
    rl.on("line", (line) => {
      if (!line.trim()) return;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        log("bad stdin line", line);
        return;
      }
      void this.onInput(message).catch((error) => log("input failed", String(error?.stack || error)));
    });
    rl.on("close", () => void this.shutdown(0));
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => void this.shutdown(0));
    process.on("uncaughtException", (error) => {
      log("uncaught", String(error?.stack || error));
    });
    process.on("unhandledRejection", (error) => {
      log("unhandled rejection", String(error?.stack || error));
    });
  }

  async shutdown(code) {
    if (this.closed) return;
    this.closed = true;
    log("bridge shutdown");
    this.killDelegate();
    try {
      await Promise.race([this.runtime?.close(), delay(3000)]);
    } catch (error) {
      log("runtime close failed", String(error));
    }
    process.exit(code);
  }

  // ── runtime wiring ────────────────────────────────────────────────

  async loadRuntime() {
    const [{ ClaudeRuntime }, { HookServer }, { TranscriptTranslator }, nodePty, { discoverCommands }, { enableLogFile }] = await Promise.all([
      import(path.join(TTY_ACP_DIST, "claude-runtime.js")),
      import(path.join(TTY_ACP_DIST, "hook-server.js")),
      import(path.join(TTY_ACP_DIST, "transcript-translator.js")),
      import(path.join(TTY_ACP_DIST, "..", "node_modules", "node-pty", "lib", "index.js")),
      import(path.join(TTY_ACP_DIST, "commands.js")),
      import(path.join(TTY_ACP_DIST, "log.js")),
    ]);
    // The PTY runtime's log (what was on Claude's screen when a prompt failed) goes beside this one.
    enableLogFile(path.join(STATE_DIR, "logs", "claude-tty-acp.log"));
    this.discoverCommands = discoverCommands;
    const bridge = this;

    class BridgeHookServer extends HookServer {
      register(sessionId, handler) {
        bridge.runtimeHook = handler;
        return super.register(sessionId, (payload) => bridge.onHook(payload, handler));
      }
    }

    // Keeps the ACP translator's bookkeeping (it drives the runtime's turn handling) and
    // re-emits every record as the SDK message the headless CLI would have printed.
    class BridgeTranslator extends TranscriptTranslator {
      async translate(records) {
        for (const record of records) bridge.onRecord(record, null);
        try {
          await super.translate(records);
        } catch (error) {
          log("acp translate failed", String(error?.stack || error));
        }
      }
      async translateSubagent(agentId, records) {
        for (const record of records) bridge.onRecord(record, agentId);
        try {
          await super.translateSubagent(agentId, records);
        } catch (error) {
          log("acp translateSubagent failed", String(error?.stack || error));
        }
      }
      // Background work is the host's to follow (task_* messages and wake turns), so the
      // runtime never holds a turn open for it.
      get runningSubagents() {
        return 0;
      }
      get runningBackgroundShells() {
        return 0;
      }
    }

    const connection = {
      sessionUpdate: async () => {},
      extNotification: async () => {},
      extMethod: async () => ({}),
      requestPermission: (params) => this.onAcpPermission(params),
    };
    this.translator = new BridgeTranslator(this.sessionId, this.cwd, connection);
    this.hooks = new BridgeHookServer();
    const spawnPty = (_file, args, options) => {
      const finalArgs = this.ttyArgs(args);
      log("spawn claude", { file: realClaude, args: finalArgs.map((arg) => truncate(arg, 200)) });
      return nodePty.spawn(realClaude, finalArgs, { ...options, env: this.ttyEnv(options.env) });
    };
    this.runtime = new ClaudeRuntime(this.sessionId, this.sessionId, this.cwd, connection, this.hooks, {
      spawnPty,
      translator: this.translator,
      resume: this.resume,
      model: this.model,
      mode: this.mode,
      effort: this.effort,
      autoAccept: async () => false,
    });
  }

  /** Session/model/mode/effort args come from the runtime; this adds what the SDK host asked for. */
  ttyArgs(runtimeArgs) {
    const args = [...runtimeArgs];
    const settingsIndex = args.indexOf("--settings");
    if (settingsIndex >= 0) this.mergeSettingsFile(args[settingsIndex + 1]);
    for (const [flag, value] of this.flags) {
      if (!PASSTHROUGH_FLAGS.has(flag)) continue;
      if (flag === "--append-system-prompt" || flag === "--system-prompt") continue;
      args.push(flag);
      if (value !== null) args.push(value);
    }
    if (this.systemPrompt) args.push("--system-prompt", this.systemPrompt);
    if (this.appendSystemPrompt) args.push("--append-system-prompt", this.appendSystemPrompt);
    if (this.mcpServers && Object.keys(this.mcpServers).length > 0 && this.mcpConfigPath) {
      args.push("--mcp-config", this.mcpConfigPath);
    }
    return args;
  }

  ttyEnv(base) {
    const env = { ...(base || process.env) };
    for (const key of SDK_ENV_KEYS) delete env[key];
    return env;
  }

  /** The runtime's settings file carries its hooks and status line; the host's settings go on top. */
  mergeSettingsFile(file) {
    if (!file) return;
    try {
      const own = JSON.parse(readFileSync(file, "utf8"));
      const merged = { ...this.sdkSettings, ...own };
      const hookCommand = own.hooks?.Stop?.[0]?.hooks?.[0];
      merged.hooks = { ...(this.sdkSettings.hooks || {}), ...own.hooks };
      if (hookCommand) {
        merged.hooks.PreCompact = [...(this.sdkSettings.hooks?.PreCompact || []), { hooks: [hookCommand] }];
        merged.hooks.UserPromptSubmit = [...(this.sdkSettings.hooks?.UserPromptSubmit || []), { hooks: [hookCommand] }];
      }
      // Written synchronously: the PTY is spawned right after this returns.
      const text = `${JSON.stringify(merged)}\n`;
      writeFileSyncMode(file, text);
      if (this.mcpServers && Object.keys(this.mcpServers).length > 0) {
        this.mcpConfigPath = path.join(path.dirname(file), "mcp.json");
        writeFileSyncMode(this.mcpConfigPath, `${JSON.stringify({ mcpServers: this.mcpServers })}\n`);
      }
    } catch (error) {
      log("settings merge failed", String(error));
    }
  }

  // ── stdin ─────────────────────────────────────────────────────────

  async onInput(message) {
    switch (message.type) {
      case "control_request":
        return this.onControlRequest(message);
      case "control_response": {
        const id = message.response?.request_id;
        const pending = this.pendingControl.get(id);
        if (pending) {
          this.pendingControl.delete(id);
          pending(message.response);
        }
        return;
      }
      case "control_cancel_request": {
        const pending = this.pendingControl.get(message.request_id);
        if (pending) {
          this.pendingControl.delete(message.request_id);
          pending({ subtype: "error", error: "cancelled" });
        }
        return;
      }
      case "user":
        return this.enqueuePrompt(message);
      case "keep_alive":
        return;
      default:
        log("ignored stdin message", { type: message.type });
    }
  }

  respond(request_id, response) {
    this.send({ type: "control_response", response: { subtype: "success", request_id, response } });
  }

  respondError(request_id, error) {
    this.send({ type: "control_response", response: { subtype: "error", request_id, error } });
  }

  async onControlRequest(message) {
    const { request_id: id, request } = message;
    log("control_request", { subtype: request?.subtype });
    try {
      switch (request?.subtype) {
        case "initialize": {
          if (typeof request.appendSystemPrompt === "string") this.appendSystemPrompt = request.appendSystemPrompt;
          if (typeof request.systemPrompt === "string") this.systemPrompt = request.systemPrompt;
          const response = await this.delegateRequest(request);
          if (response.subtype === "success") {
            this.commands = response.response?.commands || [];
            this.initialized = true;
            this.send({ type: "control_response", response: { ...response, request_id: id } });
          } else {
            // A headless CLI that will not start is no reason to refuse the session.
            this.commands = await this.discoverCommands(this.cwd).catch(() => []);
            this.respond(id, { commands: this.commands, agents: [], output_style: "default", available_output_styles: ["default"], models: [], account: {} });
          }
          this.schedulePrestart();
          return;
        }
        case "mcp_set_servers": {
          const before = Object.keys(this.mcpServers || {});
          this.mcpServers = { ...(request.servers || {}) };
          const after = Object.keys(this.mcpServers);
          this.respond(id, { added: after.filter((name) => !before.includes(name)), removed: before.filter((name) => !after.includes(name)), errors: {} });
          // MCP servers are a launch argument for the interactive CLI.
          if (this.runtime.started && !this.turn) await this.restart("mcp servers changed");
          this.schedulePrestart(0);
          return;
        }
        case "interrupt":
          this.interrupt();
          this.respond(id, {});
          return;
        case "set_permission_mode":
          this.respond(id, {});
          await this.setMode(request.mode);
          return;
        case "set_model":
          this.respond(id, {});
          await this.setModel(request.model ?? "inherit");
          return;
        case "stop_task":
          // The interactive CLI offers no way to stop one task from outside; an interrupt is the closest.
          this.respond(id, {});
          return;
        case "set_max_thinking_tokens":
          this.respond(id, {});
          return;
        case "mcp_status":
          this.respond(id, { mcpServers: Object.keys(this.mcpServers || {}).map((name) => ({ name, status: "connected" })) });
          return;
        default: {
          const response = await this.delegateRequest(request);
          this.send({ type: "control_response", response: { ...response, request_id: id } });
        }
      }
    } catch (error) {
      log("control request failed", { subtype: request?.subtype, error: String(error?.stack || error) });
      this.respondError(id, String(error?.message || error));
    }
  }

  /** Starts the interactive CLI ahead of the first prompt, once the host has had its say about MCP servers. */
  schedulePrestart(delayMs = 1000) {
    if (this.runtime.started || this.prestarted) return;
    if (this.prestartTimer) clearTimeout(this.prestartTimer);
    this.prestartTimer = setTimeout(() => {
      this.prestartTimer = null;
      if (this.runtime.started || this.turn || this.closed) return;
      this.prestarted = this.runtime.ensureStarted().catch((error) => log("prestart failed", String(error?.message || error)));
    }, delayMs);
  }

  /** Restarts Claude on the same conversation; prompts wait for it (see pump). */
  restart(reason) {
    const previous = this.restarting || Promise.resolve();
    const run = previous.then(async () => {
      log("restart claude", { reason });
      await this.runtime.reconfigure(this.model, this.mode, this.effort);
    });
    this.restarting = run.catch((error) => log("restart failed", String(error?.message || error)));
    return this.restarting;
  }

  // ── headless delegate (control plane only) ───────────────────────

  ensureDelegate() {
    if (this.delegate) return this.delegate;
    const args = [
      "--output-format", "stream-json", "--input-format", "stream-json", "--verbose",
      "--no-session-persistence", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
      "--settings", '{"disableAllHooks":true}',
    ];
    if (this.model !== "inherit") args.push("--model", this.model);
    const child = spawn(realClaude, args, { cwd: this.cwd, stdio: ["pipe", "pipe", "ignore"], env: { ...process.env, ENABLE_CLAUDEAI_MCP_SERVERS: "false" } });
    const waiting = new Map();
    const rl = readline.createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (message.type === "control_response") {
        const resolve = waiting.get(message.response?.request_id);
        if (resolve) {
          waiting.delete(message.response.request_id);
          resolve(message.response);
        }
      } else if (message.type === "control_request" && message.request?.subtype) {
        // It never runs a turn, so anything it asks is refused.
        child.stdin.write(`${JSON.stringify({ type: "control_response", response: { subtype: "error", request_id: message.request_id, error: "not available" } })}\n`);
      }
    });
    child.on("exit", () => {
      if (this.delegate?.child === child) this.delegate = null;
      for (const resolve of waiting.values()) resolve({ subtype: "error", error: "Claude exited" });
      waiting.clear();
    });
    child.on("error", () => {});
    this.delegate = { child, waiting, timer: null };
    return this.delegate;
  }

  async delegateRequest(request) {
    const delegate = this.ensureDelegate();
    if (delegate.timer) clearTimeout(delegate.timer);
    const requestId = `bridge-${randomUUID()}`;
    const response = await new Promise((resolve) => {
      delegate.waiting.set(requestId, resolve);
      delegate.child.stdin.write(`${JSON.stringify({ type: "control_request", request_id: requestId, request })}\n`);
      setTimeout(() => {
        if (delegate.waiting.delete(requestId)) resolve({ subtype: "error", error: "Claude did not answer" });
      }, 30_000).unref();
    });
    if (this.delegate === delegate) {
      delegate.timer = setTimeout(() => this.killDelegate(), DELEGATE_IDLE_MS);
      delegate.timer.unref();
    }
    return response;
  }

  killDelegate() {
    const delegate = this.delegate;
    this.delegate = null;
    if (!delegate) return;
    if (delegate.timer) clearTimeout(delegate.timer);
    try {
      delegate.child.stdin.end();
      delegate.child.kill("SIGTERM");
    } catch {}
  }

  // ── prompts and turns ─────────────────────────────────────────────

  enqueuePrompt(message) {
    const uuid = typeof message.uuid === "string" ? message.uuid : null;
    if (uuid) this.send({ type: "command_lifecycle", command_uuid: uuid, state: "queued", uuid: randomUUID(), session_id: this.sessionId });
    this.queue.push(message);
    void this.pump();
  }

  async pump() {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queue.length > 0 && !this.closed) {
        if (this.turn) await this.turnEnded;
        if (this.prestarted) await this.prestarted;
        if (this.restarting) await this.restarting;
        const message = this.queue.shift();
        await this.runPrompt(message);
      }
    } finally {
      this.pumping = false;
    }
  }

  async runPrompt(message) {
    const uuid = typeof message.uuid === "string" ? message.uuid : null;
    const blocks = toAcpContent(message.message?.content);
    const text = blocks.filter((block) => block.type === "text").map((block) => block.text).join("\n").trim();
    const compact = /^\/compact(\s|$)/.test(text);
    this.openTurn({ kind: "human", promptUuid: uuid, compact });
    if (uuid) this.send({ type: "command_lifecycle", command_uuid: uuid, state: "started", uuid: randomUUID(), session_id: this.sessionId });
    if (compact) this.sendStatus("compacting");
    try {
      const response = await this.runtime.prompt(blocks);
      if (this.turn && !this.turn.resultSent) {
        await this.finishTurn(response.stopReason === "cancelled" ? { kind: "interrupted" } : { kind: "success" });
      }
    } catch (error) {
      log("prompt failed", String(error?.stack || error));
      if (this.turn && !this.turn.resultSent) await this.finishTurn({ kind: "error", message: String(error?.message || error) });
    }
  }

  openTurn({ kind, promptUuid = null, compact = false }) {
    let resolve;
    this.turnEnded = new Promise((r) => (resolve = r));
    this.turn = {
      kind,
      promptUuid,
      compact,
      startedAt: Date.now(),
      usage: new Map(),
      numTurns: 0,
      lastText: "",
      resultSent: false,
      costBefore: this.contextReading()?.cost?.total_cost_usd ?? null,
      resolve,
    };
    this.sendInit();
  }

  sendInit() {
    const reading = this.contextReading();
    this.send({
      type: "system",
      subtype: "init",
      cwd: this.cwd,
      session_id: this.sessionId,
      tools: [],
      mcp_servers: Object.keys(this.mcpServers || {}).map((name) => ({ name, status: "connected" })),
      model: reading?.model?.id || (this.model === "inherit" ? "default" : this.model),
      permissionMode: this.mode,
      slash_commands: this.commands.map((command) => command.name),
      apiKeySource: "none",
      claude_code_version: reading?.version || this.version || "unknown",
      output_style: "default",
      agents: [],
      skills: [],
      plugins: [],
      uuid: randomUUID(),
    });
  }

  sendStatus(status) {
    this.send({ type: "system", subtype: "status", status, permissionMode: this.mode, session_id: this.sessionId, uuid: randomUUID() });
  }

  async finishTurn(outcome) {
    const turn = this.turn;
    if (!turn || turn.resultSent) return;
    turn.resultSent = true;
    if (turn.compact) this.sendStatus(null);
    const reading = this.contextReading();
    this.sendRateLimits(reading);
    const usage = sumUsage(turn.usage);
    const model = reading?.model?.id;
    const cost = reading?.cost?.total_cost_usd;
    const isError = outcome.kind === "error" || outcome.kind === "api_error";
    const result = {
      type: "result",
      subtype: outcome.kind === "interrupted" ? "error_during_execution" : "success",
      is_error: isError || outcome.kind === "interrupted",
      duration_ms: Date.now() - turn.startedAt,
      duration_api_ms: Date.now() - turn.startedAt,
      num_turns: Math.max(turn.numTurns, turn.compact ? 1 : 0),
      result: isError ? outcome.message || "Claude could not complete the turn." : outcome.text || turn.lastText || "",
      stop_reason: outcome.kind === "interrupted" ? null : "end_turn",
      session_id: this.sessionId,
      total_cost_usd: typeof cost === "number" && typeof turn.costBefore === "number" ? Math.max(0, cost - turn.costBefore) : 0,
      usage,
      modelUsage: model
        ? {
            [model]: {
              inputTokens: usage.input_tokens,
              outputTokens: usage.output_tokens,
              cacheReadInputTokens: usage.cache_read_input_tokens,
              cacheCreationInputTokens: usage.cache_creation_input_tokens,
              webSearchRequests: 0,
              costUSD: 0,
              contextWindow: reading?.context_window?.context_window_size ?? 200000,
              maxOutputTokens: 32000,
            },
          }
        : {},
      permission_denials: [],
      terminal_reason: outcome.kind === "interrupted" ? "aborted_streaming" : isError ? "api_error" : "completed",
      uuid: randomUUID(),
      ...(turn.promptUuid ? { user_message_uuid: turn.promptUuid, user_message_uuids: [turn.promptUuid] } : {}),
      ...(turn.kind === "task-notification" ? { origin: { kind: "task-notification" } } : {}),
    };
    if (outcome.kind === "interrupted") {
      result.errors = [];
      delete result.result;
    }
    this.send(result);
    this.turn = null;
    turn.resolve();
  }

  sendRateLimits(reading) {
    const limits = reading?.rate_limits;
    if (!limits) return;
    const windows = {};
    let worst = null;
    for (const [name, window] of Object.entries(limits)) {
      if (!window || typeof window.used_percentage !== "number") continue;
      const utilization = window.used_percentage / 100;
      windows[name] = { utilization, resetsAt: window.resets_at };
      if (!worst || utilization > worst.utilization) worst = { name, utilization, resetsAt: window.resets_at };
    }
    if (!worst) return;
    this.send({
      type: "rate_limit_event",
      rate_limit_info: {
        status: worst.utilization >= 1 ? "rejected" : worst.utilization >= 0.75 ? "allowed_warning" : "allowed",
        resetsAt: worst.resetsAt,
        rateLimitType: worst.name,
        utilization: worst.utilization,
        isUsingOverage: false,
        unifiedWindows: windows,
      },
      uuid: randomUUID(),
      session_id: this.sessionId,
    });
  }

  contextReading() {
    const file = this.runtime?.contextFilePath;
    if (!file) return this.lastReading ?? null;
    try {
      this.lastReading = JSON.parse(readFileSync(file, "utf8"));
      if (this.lastReading?.version) this.version = this.lastReading.version;
    } catch {}
    return this.lastReading ?? null;
  }

  interrupt() {
    if (!this.turn) return;
    log("interrupt");
    this.runtime.cancel();
  }

  async setMode(mode) {
    if (!mode || mode === this.mode) return;
    log("set mode", { from: this.mode, to: mode });
    const previous = this.mode;
    this.mode = mode;
    if (!this.runtime.started) return;
    // Shift+Tab cycles the mode in place, which keeps the process and its prompt cache.
    if (await this.cycleModeTo(mode)) return;
    if (this.turn) {
      log("mode change could not be applied mid-turn", { mode, previous });
      return;
    }
    await this.restart("permission mode");
  }

  async cycleModeTo(mode) {
    const indicator = MODE_INDICATOR[mode];
    if (!indicator) return false;
    const pty = this.runtime.pty;
    const screen = this.runtime.screen;
    if (!pty || !screen) return false;
    for (let attempt = 0; attempt < 7; attempt += 1) {
      const current = modeOnScreen(screen.snapshot());
      if (current === indicator) return true;
      pty.write("\u001b[Z");
      await delay(250);
    }
    return modeOnScreen(screen.snapshot()) === indicator;
  }

  async setModel(model) {
    if (model === this.model) return;
    log("set model", { from: this.model, to: model });
    this.model = model;
    if (!this.runtime.started) return;
    if (this.turn) await this.turnEnded;
    await this.restart("model");
  }

  // ── hooks ─────────────────────────────────────────────────────────

  async onHook(payload, original) {
    const event = payload.hook_event_name;
    log("hook", { event, tool: payload.tool_name, turn: this.turn?.kind ?? null });
    switch (event) {
      case "PreToolUse": {
        const name = payload.tool_name;
        if (typeof payload.tool_use_id === "string") {
          this.toolUseIds.set(toolKey(name, payload.tool_input), payload.tool_use_id);
          if (this.toolUseIds.size > 64) this.toolUseIds.delete(this.toolUseIds.keys().next().value);
        }
        if (!this.canUseTool || (name !== "AskUserQuestion" && name !== "ExitPlanMode")) return {};
        await this.flushTranscript();
        const decision = await this.askHost(payload);
        if (decision.behavior === "allow") {
          await this.applyPermissionUpdates(decision.updatedPermissions);
          return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: decision.updatedInput ?? payload.tool_input } };
        }
        return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: decision.message || "The user denied this action." } };
      }
      case "PermissionRequest": {
        if (!this.canUseTool) return original(payload);
        await this.flushTranscript();
        const decision = await this.askHost(payload);
        if (decision.behavior === "allow") {
          const modeUpdates = (decision.updatedPermissions || []).filter((update) => update?.type === "setMode");
          const ruleUpdates = (decision.updatedPermissions || []).filter((update) => update?.type !== "setMode");
          await this.applyPermissionUpdates(modeUpdates);
          return {
            hookSpecificOutput: {
              hookEventName: "PermissionRequest",
              decision: {
                behavior: "allow",
                ...(decision.updatedInput ? { updatedInput: decision.updatedInput } : {}),
                ...(ruleUpdates.length > 0 ? { updatedPermissions: ruleUpdates } : {}),
              },
            },
          };
        }
        if (decision.interrupt) setTimeout(() => this.interrupt(), 0);
        return {
          hookSpecificOutput: {
            hookEventName: "PermissionRequest",
            decision: { behavior: "deny", message: decision.message || "The user denied this action.", interrupt: Boolean(decision.interrupt) },
          },
        };
      }
      case "UserPromptSubmit":
        return {};
      case "PreCompact":
        if (this.turn && !this.turn.compact) this.sendStatus("compacting");
        return {};
      case "PostCompact":
        // The boundary goes out before the runtime sees the hook: for a typed `/compact` the runtime
        // ends the turn right there, and a host drops a boundary that arrives after the turn's result.
        await this.awaitCompactBoundary(payload);
        if (this.turn && !this.turn.compact) this.sendStatus(null);
        return original(payload);
      default: {
        const response = await original(payload);
        await this.afterLifecycleHook(payload);
        return response;
      }
    }
  }

  async afterLifecycleHook(payload) {
    switch (payload.hook_event_name) {
      // A hook can beat its turn's records to the transcript reader. Reading them first opens the
      // turn they belong to (a task notification's), so the hook closes it instead of leaving a turn
      // that opens after it and never ends, holding every later prompt in the queue.
      case "Stop":
        await this.flushTranscript(true);
        if (!this.turn) break;
        await this.awaitTranscript(payload.last_assistant_message);
        await this.finishTurn({ kind: "success", text: payload.last_assistant_message });
        break;
      case "StopFailure":
        await this.flushTranscript(true);
        if (this.turn) await this.finishTurn({ kind: "api_error", message: payload.last_assistant_message || payload.error });
        break;
      case "SessionStart":
        if (typeof payload.session_id === "string" && payload.session_id !== this.sessionId) {
          log("claude session changed", { from: this.sessionId, to: payload.session_id });
          this.sessionId = payload.session_id;
        }
        break;
    }
  }

  /** Claude can run the Stop hook before its last message reaches the transcript; the result must follow that message. */
  async awaitTranscript(lastMessage) {
    const expected = normalizeText(lastMessage);
    if (!expected || !this.turn) return;
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && this.turn && normalizeText(this.turn.lastText) !== expected) {
      await this.flushTranscript(true);
      if (normalizeText(this.turn?.lastText) === expected) return;
      await delay(50);
    }
    if (this.turn && normalizeText(this.turn.lastText) !== expected) log("stop arrived without its message in the transcript");
  }

  /** The interactive CLI writes its compact_boundary record lazily, with the next message, so one is sent now and the late record is dropped. */
  async awaitCompactBoundary(payload) {
    await this.flushTranscript(true);
    if (this.compactBoundarySeen) {
      this.compactBoundarySeen = false;
      return;
    }
    this.skipNextCompactBoundary = true;
    this.send({
      type: "system",
      subtype: "compact_boundary",
      session_id: this.sessionId,
      uuid: randomUUID(),
      compact_metadata: { trigger: payload.trigger === "manual" ? "manual" : "auto", pre_tokens: this.lastContextTokens ?? 0 },
    });
  }

  /**
   * Ends a `/compact` Claude did not carry out. Only PostCompact ends a compact turn, and a compact that
   * fails ("Not enough messages to compact.", "Error during compaction: You've hit your session limit")
   * fires none; it leaves only this line of output, and the turn would stay open until the next restart.
   * One that succeeds writes no such line.
   */
  endRefusedCompact(content) {
    const output = /<local-command-(stdout|stderr)>([\s\S]*?)<\/local-command-\1>/.exec(content);
    const failed = output?.[1] === "stderr";
    const text = (output?.[2] ?? content).replace(/\u001b\[[0-9;]*m/g, "").trim();
    // Not from inside this record's read: the runtime's handler flushes the transcript, which waits on it.
    setTimeout(async () => {
      await this.finishTurn(failed ? { kind: "error", message: text } : { kind: "success", text });
      // And the runtime's own turn, so its prompt returns and the next queued message goes in.
      await this.runtimeHook?.({ hook_event_name: "PostCompact", trigger: "manual" });
    });
  }

  async flushTranscript(force = false) {
    try {
      await this.runtime.transcript.flushUntilStable(force);
    } catch {}
  }

  async applyPermissionUpdates(updates) {
    for (const update of updates || []) {
      if (update?.type === "setMode" && update.mode) await this.setMode(update.mode);
    }
  }

  /** Puts a permission question to the SDK host, the way the headless CLI's `--permission-prompt-tool stdio` does. */
  askHost(payload) {
    const requestId = randomUUID();
    const request = {
      subtype: "can_use_tool",
      tool_name: payload.tool_name,
      input: payload.tool_input || {},
      tool_use_id: payload.tool_use_id || this.toolUseIds.get(toolKey(payload.tool_name, payload.tool_input)) || `toolu_bridge_${requestId}`,
      ...(Array.isArray(payload.permission_suggestions) ? { permission_suggestions: payload.permission_suggestions } : {}),
      ...(typeof payload.agent_id === "string" ? { agent_id: payload.agent_id } : {}),
    };
    this.hostAsks += 1;
    return new Promise((resolve) => {
      this.pendingControl.set(requestId, (response) => {
        this.hostAsks -= 1;
        if (response.subtype !== "success") {
          resolve({ behavior: "deny", message: response.error || "The permission request failed." });
          return;
        }
        resolve(response.response || { behavior: "deny" });
      });
      this.send({ type: "control_request", request_id: requestId, request });
    });
  }

  /**
   * The runtime's ACP cards: consents Claude asks for on its way up (workspace trust, bypass
   * disclaimer, external imports), notices, and questions Claude opens on screen. The headless CLI
   * never asks the first two, so they are accepted here; an on-screen question goes to the host as
   * an AskUserQuestion, which every SDK host already knows how to render.
   */
  async onAcpPermission(params) {
    const options = params.options || [];
    const input = params.toolCall?.rawInput || {};
    if (options.length === 0) return { outcome: { outcome: "cancelled" } };
    if (!input.claudeDialog) {
      // requestConsent lists the decline first and the accept second; a notice has only "OK".
      const accept = options.length > 1 ? options[1] : options[0];
      log("accepted claude consent", { title: params.toolCall?.title, option: accept.name });
      return { outcome: { outcome: "selected", optionId: accept.optionId } };
    }
    // Claude draws its own permission prompt while the PermissionRequest hook is asking the host;
    // the hook's answer closes it, and the watcher then withdraws this card.
    if (input.waitingFor === "permission prompt" || this.hostAsks > 0) return new Promise(() => {});
    if (!this.canUseTool) return { outcome: { outcome: "cancelled" } };
    const question = [input.question, params.toolCall?.title].filter(Boolean).join("\n") || "Claude is asking";
    const decision = await this.askHost({
      tool_name: "AskUserQuestion",
      tool_input: {
        questions: [{ question, header: "Claude", multiSelect: false, options: options.map((option) => ({ label: option.name, description: "" })) }],
      },
      tool_use_id: `toolu_dialog_${randomUUID()}`,
    });
    const answer = decision.behavior === "allow" ? Object.values(decision.updatedInput?.answers || {})[0] : undefined;
    const chosen = options.find((option) => option.name === answer);
    if (!chosen) return { outcome: { outcome: "cancelled" } };
    return { outcome: { outcome: "selected", optionId: chosen.optionId } };
  }

  /**
   * `--resume-session-at` rolls a session back to one message. The interactive CLI does not take
   * it, and resumes from the transcript's last line, so the transcript is cut after that message
   * (a copy of the whole file is kept under the state directory first).
   */
  applyResumeSessionAt() {
    const at = this.flag("--resume-session-at");
    if (!this.resume || typeof at !== "string") return;
    const file = transcriptPath(this.cwd, this.sessionId);
    try {
      const lines = readFileSync(file, "utf8").split("\n");
      const index = lines.findIndex((line) => line.includes(at) && safeJson(line)?.uuid === at);
      if (index < 0) {
        log("resume-session-at message not found", { at });
        return;
      }
      const backups = path.join(STATE_DIR, "rollback-backups");
      mkdirSync(backups, { recursive: true });
      writeFileSyncMode(path.join(backups, `${this.sessionId}.${Date.now()}.jsonl`), lines.join("\n"));
      writeFileSyncMode(file, `${lines.slice(0, index + 1).join("\n")}\n`);
      log("rolled transcript back", { at, kept: index + 1, dropped: lines.filter(Boolean).length - index - 1 });
    } catch (error) {
      log("resume-session-at failed", String(error?.message || error));
    }
  }

  // ── transcript → SDK messages ─────────────────────────────────────

  seedSeen() {
    if (!this.resume) return;
    const file = transcriptPath(this.cwd, this.sessionId);
    for (const record of readJsonl(file)) {
      const key = recordKey(record);
      if (key) this.seen.add(key);
      if (record.type === "assistant") for (const block of record.message?.content || []) if (block?.type === "tool_use") this.rootToolUses.add(block.id);
    }
    const subagents = path.join(path.dirname(file), this.sessionId, "subagents");
    try {
      for (const name of readdirSync(subagents)) {
        if (!name.endsWith(".jsonl")) continue;
        for (const record of readJsonl(path.join(subagents, name))) {
          const key = recordKey(record);
          if (key) this.seen.add(`${name}:${key}`);
        }
      }
    } catch {}
    log("seeded transcript", { records: this.seen.size });
  }

  onRecord(record, agentId) {
    if (!record || typeof record !== "object") return;
    const own = recordKey(record);
    const key = own && agentId ? `agent-${agentId}.jsonl:${own}` : own;
    if (key) {
      if (this.seen.has(key)) return;
      this.seen.add(key);
    }
    try {
      if (agentId) this.onSubagentRecord(record, agentId);
      else this.onRootRecord(record);
    } catch (error) {
      log("record translation failed", String(error?.stack || error));
    }
  }

  onRootRecord(record) {
    switch (record.type) {
      case "assistant": {
        const message = record.message || {};
        // Claude writes its own notices (a usage limit, an API error) as `<synthetic>` messages after
        // the turn's StopFailure; no hook follows them, so a turn opened for one would never end.
        if (!this.turn && message.model === "<synthetic>") return;
        if (!this.turn) this.openTurn({ kind: "wake" });
        const id = message.id;
        if (id && message.usage && message.model !== "<synthetic>") {
          if (!this.turn.usage.has(id)) this.turn.numTurns += 1;
          this.turn.usage.set(id, message.usage);
          this.lastContextTokens = usageTotal(message.usage);
        }
        for (const block of message.content || []) {
          if (block.type === "text" && block.text) this.turn.lastText = block.text;
        }
        this.send({
          type: "assistant",
          message,
          parent_tool_use_id: null,
          session_id: this.sessionId,
          uuid: record.uuid,
          ...(record.error ? { error: record.error } : {}),
          ...(record.requestId ? { request_id: record.requestId } : {}),
          ...(record.timestamp ? { timestamp: record.timestamp } : {}),
        });
        for (const block of message.content || []) if (block.type === "tool_use") this.onToolUse(block);
        return;
      }
      case "queue-operation":
        // Claude queues a <task-notification> the moment a background task ends, whether or not it is busy.
        if (record.operation === "enqueue" && typeof record.content === "string" && record.content.startsWith("<task-notification>")) {
          this.onTaskNotification(record.content);
        }
        return;
      case "user": {
        const content = record.message?.content;
        const toolResults = Array.isArray(content) ? content.filter((block) => block?.type === "tool_result") : [];
        if (toolResults.length > 0) {
          for (const block of toolResults) this.onToolResult(block, record.toolUseResult);
          this.send({
            type: "user",
            message: record.message,
            parent_tool_use_id: null,
            session_id: this.sessionId,
            uuid: record.uuid,
            ...(record.timestamp ? { timestamp: record.timestamp } : {}),
            ...(record.toolUseResult !== undefined ? { tool_use_result: record.toolUseResult } : {}),
          });
          return;
        }
        const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((block) => block?.text || "").join("") : "";
        if (record.origin?.kind === "task-notification" || text.startsWith("<task-notification>")) {
          this.onTaskNotification(text);
          // A notification that lands while no turn is open wakes Claude for a turn of its own.
          if (!this.turn) this.openTurn({ kind: "task-notification" });
          else if (this.turn.kind === "wake") this.turn.kind = "task-notification";
        }
        return;
      }
      case "system":
        if (record.subtype === "compact_boundary") {
          if (this.skipNextCompactBoundary) {
            this.skipNextCompactBoundary = false;
            return;
          }
          this.compactBoundarySeen = true;
          const metadata = record.compactMetadata || {};
          this.send({
            type: "system",
            subtype: "compact_boundary",
            session_id: this.sessionId,
            uuid: record.uuid,
            compact_metadata: {
              trigger: metadata.trigger || "auto",
              pre_tokens: metadata.preTokens ?? 0,
              ...(metadata.postTokens !== undefined ? { post_tokens: metadata.postTokens } : {}),
              ...(metadata.durationMs !== undefined ? { duration_ms: metadata.durationMs } : {}),
            },
            ...(record.logicalParentUuid ? { logical_parent_uuid: record.logicalParentUuid } : {}),
          });
        } else if (record.subtype === "local_command" && this.turn?.compact) {
          this.endRefusedCompact(String(record.content || ""));
        } else if (record.subtype === "api_error") {
          this.send({
            type: "system",
            subtype: "api_retry",
            attempt: record.retryAttempt ?? 1,
            max_retries: record.maxRetries ?? 10,
            retry_delay_ms: record.retryInMs ?? 0,
            error_status: record.error?.status ?? null,
            error: "unknown",
            session_id: this.sessionId,
            uuid: record.uuid,
          });
        }
        return;
    }
  }

  onSubagentRecord(record, agentId) {
    // Only conversation records stand for subagent activity. Bookkeeping lines (`api-request`,
    // `attachment`, ...) are not, and the uuid-less ones escape the resume dedup in `seen`: on a
    // `--resume` they would re-announce every subagent of the session, long after it finished.
    if (record.type !== "assistant" && record.type !== "user") return;
    const toolUseId = this.subagentToolUse(agentId);
    if (!toolUseId) return;
    // The host has to see the Agent call before anything its subagent does.
    if (!this.rootToolUses.has(toolUseId)) {
      const held = this.heldSubagentRecords.get(toolUseId) || [];
      held.push([record, agentId]);
      this.heldSubagentRecords.set(toolUseId, held);
      return;
    }
    this.linkAgent(agentId, toolUseId, this.agentMeta.get(agentId));
    const task = this.tasks.get(agentId);
    if (record.type === "assistant") {
      for (const block of record.message?.content || []) {
        if (block.type !== "tool_use" || !task) continue;
        task.toolUses += 1;
        task.lastTool = block.name;
        this.send({
          type: "system",
          subtype: "task_progress",
          task_id: agentId,
          tool_use_id: toolUseId,
          description: task.description,
          ...(task.subagentType ? { subagent_type: task.subagentType } : {}),
          usage: { total_tokens: usageTotal(record.message?.usage), tool_uses: task.toolUses, duration_ms: Date.now() - task.startedAt },
          last_tool_name: block.name,
          uuid: randomUUID(),
          session_id: this.sessionId,
        });
      }
      this.send({ type: "assistant", message: record.message, parent_tool_use_id: toolUseId, session_id: this.sessionId, uuid: record.uuid });
    } else if (record.type === "user") {
      const content = record.message?.content;
      if (Array.isArray(content) && content.some((block) => block?.type === "tool_result")) {
        this.send({
          type: "user",
          message: record.message,
          parent_tool_use_id: toolUseId,
          session_id: this.sessionId,
          uuid: record.uuid,
          ...(record.toolUseResult !== undefined ? { tool_use_result: record.toolUseResult } : {}),
        });
      }
    }
  }

  /** Which Agent tool call launched a subagent, from the meta file Claude writes beside its transcript. */
  subagentToolUse(agentId) {
    const known = this.agentToolUse.get(agentId);
    if (known) return known;
    const meta = path.join(path.dirname(transcriptPath(this.cwd, this.sessionId)), this.sessionId, "subagents", `agent-${agentId}.meta.json`);
    try {
      const parsed = JSON.parse(readFileSync(meta, "utf8"));
      if (typeof parsed.toolUseId !== "string") return null;
      this.agentMeta.set(agentId, parsed);
      this.agentToolUse.set(agentId, parsed.toolUseId);
      this.toolUseAgent.set(parsed.toolUseId, agentId);
      return parsed.toolUseId;
    } catch {
      return null;
    }
  }

  linkAgent(agentId, toolUseId, meta = {}) {
    if (this.tasks.has(agentId) || this.notifiedTasks.has(agentId)) return;
    this.agentToolUse.set(agentId, toolUseId);
    this.toolUseAgent.set(toolUseId, agentId);
    const launch = this.agentTools.get(toolUseId);
    const background = meta.requestShape === "background" || launch?.input?.run_in_background === true;
    const task = {
      toolUseId,
      type: "local_agent",
      description: launch?.input?.description || meta.description || "Agent",
      subagentType: launch?.input?.subagent_type || meta.agentType,
      background,
      startedAt: Date.now(),
      toolUses: 0,
    };
    this.tasks.set(agentId, task);
    this.send({
      type: "system",
      subtype: "task_started",
      task_id: agentId,
      tool_use_id: toolUseId,
      description: task.description,
      task_type: "local_agent",
      ...(task.subagentType ? { subagent_type: task.subagentType } : {}),
      ...(launch?.input?.prompt ? { prompt: launch.input.prompt } : {}),
      is_backgrounded: background,
      uuid: randomUUID(),
      session_id: this.sessionId,
    });
    if (background) this.sendBackgroundRoster();
  }

  onToolUse(block) {
    this.rootToolUses.add(block.id);
    if (block.name === "Agent" || block.name === "Task") this.agentTools.set(block.id, block);
    const held = this.heldSubagentRecords.get(block.id);
    if (held) {
      this.heldSubagentRecords.delete(block.id);
      for (const [record, agentId] of held) this.onSubagentRecord(record, agentId);
    }
    if (block.name === "Bash" && block.input?.run_in_background === true) this.backgroundShells.set(block.id, block.input.description || block.input.command || "Background command");
  }

  onToolResult(block, toolUseResult) {
    const toolUseId = block.tool_use_id;
    if (this.agentTools.has(toolUseId)) {
      const agentId = toolUseResult?.agentId;
      if (typeof agentId === "string") this.linkAgent(agentId, toolUseId);
      const id = typeof agentId === "string" ? agentId : this.toolUseAgent.get(toolUseId);
      const task = id ? this.tasks.get(id) : null;
      // An agent launched in the background reports through a <task-notification> instead.
      if (id && task && toolUseResult?.status !== "async_launched") this.finishTask(id, block.is_error ? "failed" : "completed", textOf(block.content));
      return;
    }
    if (this.backgroundShells.has(toolUseId)) {
      const description = this.backgroundShells.get(toolUseId);
      this.backgroundShells.delete(toolUseId);
      const shellId = toolUseResult?.backgroundTaskId || /with ID:\s*(\S+)/.exec(textOf(block.content))?.[1];
      if (!shellId) return;
      this.tasks.set(shellId, { toolUseId, type: "local_bash", description, background: true, startedAt: Date.now(), toolUses: 0 });
      this.send({ type: "system", subtype: "task_started", task_id: shellId, tool_use_id: toolUseId, description, task_type: "local_bash", is_backgrounded: true, uuid: randomUUID(), session_id: this.sessionId });
      this.sendBackgroundRoster();
    }
  }

  onTaskNotification(text) {
    const field = (name) => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text)?.[1]?.trim();
    const taskId = field("task-id");
    if (!taskId) return;
    const status = field("status") || "completed";
    this.finishTask(taskId, status, field("summary") || "", field("output-file") || "", field("tool-use-id"));
  }

  finishTask(taskId, status, summary, outputFile = "", toolUseId) {
    if (this.notifiedTasks.has(taskId)) return;
    const task = this.tasks.get(taskId);
    if (!task && !toolUseId) return;
    this.notifiedTasks.add(taskId);
    this.tasks.delete(taskId);
    this.send({
      type: "system",
      subtype: "task_notification",
      task_id: taskId,
      tool_use_id: task?.toolUseId || toolUseId,
      status: status === "killed" ? "stopped" : status,
      output_file: outputFile,
      summary: summary || task?.description || "",
      uuid: randomUUID(),
      session_id: this.sessionId,
    });
    if (task?.background) this.sendBackgroundRoster();
  }

  sendBackgroundRoster() {
    const tasks = [...this.tasks.entries()]
      .filter(([, task]) => task.background)
      .map(([task_id, task]) => ({ task_id, task_type: task.type, description: task.description }));
    this.send({ type: "system", subtype: "background_tasks_changed", tasks, uuid: randomUUID(), session_id: this.sessionId });
  }
}

// ── helpers ─────────────────────────────────────────────────────────

const MODE_INDICATOR = {
  default: "manual mode",
  acceptEdits: "accept edits",
  plan: "plan mode",
  auto: "auto mode",
  bypassPermissions: "bypass permissions",
  dontAsk: "don't ask",
};

function modeOnScreen(screen) {
  const match = /(auto mode|plan mode|manual mode|accept edits|bypass permissions|don't ask) on/i.exec(screen);
  return match ? match[1].toLowerCase() : null;
}

/** What identifies a transcript line across reads, so a resumed session does not replay its history. */
function recordKey(record) {
  if (typeof record?.uuid === "string") return record.uuid;
  if (record?.type === "queue-operation") return `queue:${record.timestamp}:${record.operation}:${String(record.content ?? "").length}`;
  return null;
}

function safeJson(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function normalizeText(text) {
  return typeof text === "string" ? text.replace(/\s+/g, " ").trim() : "";
}

function toolKey(name, input) {
  return `${name}:${JSON.stringify(input ?? {})}`;
}

function toAcpContent(content) {
  if (typeof content === "string") return [{ type: "text", text: content }];
  const blocks = [];
  for (const block of content || []) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text") blocks.push({ type: "text", text: block.text ?? "" });
    else if (block.type === "image" && block.source?.type === "base64") blocks.push({ type: "image", data: block.source.data, mimeType: block.source.media_type });
    else if (block.type === "document" && block.source?.type === "base64") {
      blocks.push({ type: "resource", resource: { uri: `attachment:${randomUUID()}`, blob: block.source.data, mimeType: block.source.media_type || "application/pdf" } });
    } else if (block.type === "document" && block.source?.type === "text") {
      blocks.push({ type: "text", text: block.source.data ?? "" });
    }
  }
  if (blocks.length === 0) return [{ type: "text", text: "" }];
  // Text goes first. An attachment reaches Claude's input box as an `@path` line, which Claude redraws
  // as an `[Image #1]` chip; the runtime confirms a prompt by finding the box's first line in what it
  // typed, so a prompt that opened with an image never matched, was never sent, and stayed in the box
  // to be glued onto the next one. A host puts images first (T3 does), so every image prompt did that.
  return [...blocks.filter((block) => block.type === "text"), ...blocks.filter((block) => block.type !== "text")];
}

function sumUsage(byMessage) {
  const total = {
    input_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 0,
    server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
    service_tier: "standard",
    cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
  };
  for (const usage of byMessage.values()) {
    total.input_tokens += usage.input_tokens || 0;
    total.cache_creation_input_tokens += usage.cache_creation_input_tokens || 0;
    total.cache_read_input_tokens += usage.cache_read_input_tokens || 0;
    total.output_tokens += usage.output_tokens || 0;
    total.cache_creation.ephemeral_1h_input_tokens += usage.cache_creation?.ephemeral_1h_input_tokens || 0;
    total.cache_creation.ephemeral_5m_input_tokens += usage.cache_creation?.ephemeral_5m_input_tokens || 0;
  }
  return total;
}

function usageTotal(usage) {
  if (!usage) return 0;
  return (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.output_tokens || 0);
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((block) => block?.text || "").join("");
  return "";
}

function parseSettings(value) {
  if (!value || value === true) return {};
  try {
    return JSON.parse(value);
  } catch {}
  try {
    return JSON.parse(readFileSync(value, "utf8"));
  } catch {
    return {};
  }
}

function readMcpConfig(value) {
  if (!value || value === true) return null;
  try {
    const parsed = JSON.parse(value.trim().startsWith("{") ? value : readFileSync(value, "utf8"));
    return parsed.mcpServers || null;
  } catch {
    return null;
  }
}

function transcriptPath(cwd, sessionId) {
  const configDir = process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), ".claude");
  return path.join(configDir, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${sessionId}.jsonl`);
}

function readJsonl(file) {
  try {
    if (!statSync(file).isFile()) return [];
    return readFileSync(file, "utf8")
      .split("\n")
      .flatMap((line) => {
        try {
          return line ? [JSON.parse(line)] : [];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

function writeFileSyncMode(file, text) {
  writeFileSync(file, text, { mode: 0o600 });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}


export { Bridge, toAcpContent };

// Last, so every declaration above is initialized. Imported (by tests), it only declares.
const invoked = process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked && !isSdkSession(argv)) {
  passthrough(argv);
} else if (invoked) {
  process.env.CLAUDE_TTY_ACP_STATE_DIR ||= STATE_DIR;
  await new Bridge(argv).run();
}

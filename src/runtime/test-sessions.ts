import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { ClaudeRuntime, type RuntimeDependencies } from "./claude-runtime.ts";
import { discoverCommands } from "./commands.ts";
import { HookServer } from "./hook-server.ts";
import type { AgentSideConnection, ContentBlock, PromptResponse } from "./protocol.ts";
import { INHERIT_EFFORT_ID, INHERIT_MODEL_ID } from "./session-options.ts";
import { TranscriptTranslator } from "./transcript-translator.ts";

type Session = {
  id: string;
  cwd: string;
  model: string;
  mode: string;
  translator: TranscriptTranslator;
  runtime: ClaudeRuntime | null;
  queue: Promise<unknown>;
  idleTimer: NodeJS.Timeout | null;
  readonly started: boolean;
};

export type TestSessionsDependencies = RuntimeDependencies & {
  /** Suspends Claude this long after a prompt ends, so the next prompt resumes it the way a restarted bridge does. */
  idleTimeoutMs?: number;
};

/**
 * Test support: runs one runtime per session on a shared hook server, wired the way `src/bridge.mjs`
 * wires its own, so a test can drive a session from prompt to hook without the bridge's stdio.
 * Prompts to one session go one at a time, as the bridge sends them.
 */
export class TestSessions {
  readonly hooks = new HookServer();
  readonly sessions = new Map<string, Session>();
  private readonly connection: AgentSideConnection;
  private readonly dependencies: RuntimeDependencies;
  private readonly idleTimeoutMs: number | undefined;

  constructor(connection: AgentSideConnection, dependencies: TestSessionsDependencies = {}) {
    const { idleTimeoutMs, ...runtimeDependencies } = dependencies;
    this.connection = connection;
    this.dependencies = runtimeDependencies;
    this.idleTimeoutMs = idleTimeoutMs;
  }

  async newSession(params: { cwd: string; mcpServers?: unknown[] }): Promise<{ sessionId: string }> {
    const id = randomUUID();
    const cwd = path.normalize(params.cwd);
    const session: Session = {
      id,
      cwd,
      model: INHERIT_MODEL_ID,
      mode: "default",
      translator: new TranscriptTranslator(id, cwd, this.connection),
      runtime: null,
      queue: Promise.resolve(),
      idleTimer: null,
      get started() {
        return this.runtime?.started ?? false;
      },
    };
    this.sessions.set(id, session);
    setImmediate(() => void this.publishCommands(session));
    return { sessionId: id };
  }

  prompt(params: { sessionId: string; prompt: ContentBlock[] }): Promise<PromptResponse> {
    const session = this.session(params.sessionId);
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.idleTimer = null;
    const run = async () => {
      // The bridge's runtime root is the system temp directory, which always exists; a test's may not yet.
      if (this.dependencies.runtimeRoot) await mkdir(this.dependencies.runtimeRoot, { recursive: true });
      session.runtime ??= new ClaudeRuntime(session.id, session.id, session.cwd, this.connection, this.hooks, {
        ...this.dependencies,
        resume: false,
        model: session.model,
        mode: session.mode,
        effort: INHERIT_EFFORT_ID,
        autoAccept: async () => false,
        translator: session.translator,
      });
      return session.runtime.prompt(params.prompt);
    };
    const result = session.queue.then(run, run);
    session.queue = result.catch(() => undefined);
    void result.finally(() => this.scheduleSuspension(session)).catch(() => undefined);
    return result;
  }

  /** The bridge's `set_model` and `set_permission_mode`: Claude takes both at launch, so a running one restarts. */
  async unstable_setSessionModel(params: { sessionId: string; modelId: string }): Promise<void> {
    const session = this.session(params.sessionId);
    await session.runtime?.reconfigure(params.modelId, session.mode, INHERIT_EFFORT_ID);
    session.model = params.modelId;
  }

  async setSessionMode(params: { sessionId: string; modeId: string }): Promise<void> {
    const session = this.session(params.sessionId);
    await session.runtime?.reconfigure(session.model, params.modeId, INHERIT_EFFORT_ID);
    session.mode = params.modeId;
  }

  async cancel(params: { sessionId: string }): Promise<void> {
    this.sessions.get(params.sessionId)?.runtime?.cancel();
  }

  async close(): Promise<void> {
    const sessions = [...this.sessions.values()];
    for (const session of sessions) if (session.idleTimer) clearTimeout(session.idleTimer);
    this.sessions.clear();
    await Promise.allSettled(sessions.map((session) => session.runtime?.close()));
    await this.hooks.close();
  }

  private scheduleSuspension(session: Session): void {
    if (this.idleTimeoutMs === undefined) return;
    session.idleTimer = setTimeout(() => {
      session.idleTimer = null;
      // Queued with the prompts, so the next one starts Claude only once this one has stopped it.
      const suspend = async () => session.runtime?.suspend();
      session.queue = session.queue.then(suspend, suspend).catch(() => undefined);
    }, this.idleTimeoutMs);
  }

  private session(sessionId: string): Session {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    return session;
  }

  private async publishCommands(session: Session): Promise<void> {
    try {
      const availableCommands = await discoverCommands(session.cwd, this.dependencies.claudeConfigDir);
      await this.connection.sessionUpdate({ sessionId: session.id, update: { sessionUpdate: "available_commands_update", availableCommands } });
    } catch {}
  }
}

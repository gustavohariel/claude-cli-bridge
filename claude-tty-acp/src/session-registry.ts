import { randomUUID } from "node:crypto";
import path from "node:path";
import type { AgentSideConnection, ContentBlock, PromptResponse, SessionConfigOption } from "@agentclientprotocol/sdk";
import { AUTO_ACCEPT_CONFIG_ID, readAutoAcceptDefault } from "./auto-accept.ts";
import { ClaudeRuntime, type RuntimeDependencies } from "./claude-runtime.ts";
import { discoverCommands } from "./commands.ts";
import { HookServer } from "./hook-server.ts";
import {
  assertEffortId,
  assertModeId,
  assertModelId,
  configOptions,
  EFFORT_CONFIG_ID,
  INHERIT_EFFORT_ID,
  INHERIT_MODEL_ID,
  migrateModelId,
  MODEL_CONFIG_ID,
  modeState,
  modelState,
  offeredEffortId,
  offeredModeId,
} from "./session-options.ts";
import { SessionLock } from "./session-lock.ts";
import { type PersistedSession, StateStore, stateScope, type StateScope, workspaceStateDirectory } from "./state-store.ts";
import { TranscriptReader } from "./transcript-reader.ts";
import { TranscriptTranslator } from "./transcript-translator.ts";
import { readIdleTimeout } from "./idle-timeout.ts";
import { enableLogFile, writeLog } from "./log.ts";
import { APP_NAME } from "./constants.ts";

export type SessionRegistryDependencies = RuntimeDependencies & {
  /**
   * Zero keeps the native Claude process alive until the logical session closes.
   * Left out in production, where the timeout is read per suspension so a change in Paseo reaches live sessions.
   */
  idleTimeoutMs?: number;
  /** Left out in production, where the host settings are read at each request so a change in Paseo reaches live sessions. */
  autoAcceptDefault?: (mode: string) => Promise<boolean>;
  /** Left out in production, where the environment says how session state is keyed under the root. */
  stateScope?: StateScope;
  /** Left out in production, where the log moves with the state it is about. Tests pass a no-op. */
  relocateLog?: (stateDirectory: string) => void;
};

/** How long a suspension stands aside when the session is busy or someone still has a card to answer. */
const SUSPENSION_RETRY_MS = 60_000;

type SessionOptions = {
  id: string;
  claudeSessionId: string;
  cwd: string;
  model: string;
  mode: string;
  effort: string;
  autoAccept: boolean | null;
  persisted: boolean;
};

export class ClaudeSession {
  readonly id: string;
  readonly createdAt = Date.now();
  readonly cwd: string;
  private currentClaudeSessionId: string;
  private model: string;
  private mode: string;
  private effort: string;
  /** Null follows the host settings for the session's mode; a boolean is what someone switched this agent to. */
  private autoAccept: boolean | null;
  /** What the host settings said at the last read, which is what a session following them shows. */
  private defaultAutoAccept = false;
  private persisted: boolean;
  private readonly connection: AgentSideConnection;
  private readonly hooks: HookServer;
  private readonly runtimeDependencies: RuntimeDependencies;
  private readonly fixedIdleTimeoutMs: number | undefined;
  private readonly readAutoAcceptDefault: (mode: string) => Promise<boolean>;
  private readonly stateStore: StateStore;
  private readonly lock: SessionLock;
  private readonly translator: TranscriptTranslator;
  private runtime: ClaudeRuntime | null = null;
  private queue: Promise<void> = Promise.resolve();
  private idleTimer: NodeJS.Timeout | null = null;
  private activityVersion = 0;
  /** When the last prompt ended, so a deferred or re-read suspension keeps the deadline it earned. */
  private idleSince = 0;

  constructor(
    options: SessionOptions,
    connection: AgentSideConnection,
    hooks: HookServer,
    dependencies: SessionRegistryDependencies,
    stateStore: StateStore,
  ) {
    this.id = options.id;
    this.currentClaudeSessionId = options.claudeSessionId;
    this.cwd = options.cwd;
    this.model = options.model;
    this.mode = options.mode;
    this.effort = options.effort;
    this.autoAccept = options.autoAccept;
    this.persisted = options.persisted;
    this.connection = connection;
    this.hooks = hooks;
    const { idleTimeoutMs, autoAcceptDefault, ...runtimeDependencies } = dependencies;
    this.runtimeDependencies = runtimeDependencies;
    this.fixedIdleTimeoutMs = idleTimeoutMs;
    this.readAutoAcceptDefault = autoAcceptDefault ?? ((mode) => readAutoAcceptDefault(mode));
    this.stateStore = stateStore;
    this.lock = new SessionLock(this.id, stateStore.locksDirectory);
    this.translator = new TranscriptTranslator(this.id, this.cwd, connection);
  }

  get started(): boolean {
    return this.runtime?.started ?? false;
  }

  get models() {
    return modelState(this.model);
  }

  get modes() {
    return modeState(this.mode);
  }

  get configOptions(): SessionConfigOption[] {
    return configOptions(this.model, this.effort, this.autoAccept ?? this.defaultAutoAccept);
  }

  prompt(content: ContentBlock[]): Promise<PromptResponse> {
    const activityVersion = this.beginActivity();
    const result = this.exclusive(async () => {
      await this.lock.acquire();
      const resume = this.persisted;
      await this.save();
      this.runtime ??= new ClaudeRuntime(this.id, this.currentClaudeSessionId, this.cwd, this.connection, this.hooks, {
        ...this.runtimeDependencies,
        resume,
        model: this.model,
        mode: this.mode,
        effort: this.effort,
        autoAccept: () => this.refreshAutoAccept({ publish: true }),
        translator: this.translator,
        onClaudeSessionChange: async (claudeSessionId) => {
          this.currentClaudeSessionId = claudeSessionId;
          await this.save();
        },
      });
      return this.runtime.prompt(content);
    });
    void result.finally(() => this.scheduleSuspension(activityVersion)).catch(() => undefined);
    return result;
  }

  async replayHistory(): Promise<void> {
    await this.lock.acquire();
    const reader = new TranscriptReader(this.currentClaudeSessionId, this.cwd, { configDir: this.runtimeDependencies.claudeConfigDir });
    const result = await reader.read();
    await this.translator.translate(result.records);
    // A timeline that came back empty is otherwise indistinguishable from one that was never sent.
    writeLog({ level: "info", message: "Replayed a loaded session's history", sessionId: this.id, records: result.records.length });
    // The lock is this session's proof that no Claude process is behind the history just replayed,
    // so a tool call the transcript leaves open — an agent launched to run on its own and never
    // reported — is finished as far as Paseo is concerned, whatever the record says.
    await this.translator.settleOpenToolCalls();
  }

  async emitCommands(): Promise<void> {
    const availableCommands = await discoverCommands(this.cwd, this.runtimeDependencies.claudeConfigDir);
    await this.connection.sessionUpdate({
      sessionId: this.id,
      update: { sessionUpdate: "available_commands_update", availableCommands },
    });
  }

  setModel(model: string): Promise<void> {
    if (this.runtime?.turnActive) return Promise.reject(new Error("Cannot change Claude model during an active turn"));
    return this.exclusive(async () => {
      assertModelId(model);
      if (this.runtime?.turnActive) throw new Error("Cannot change Claude model during an active turn");
      if (this.model === model) return;
      this.model = model;
      if (this.persisted) await this.save();
      await this.runtime?.reconfigure(this.model, this.mode, this.effort);
      await this.publishConfigOptions();
    });
  }

  setMode(mode: string): Promise<void> {
    if (this.runtime?.turnActive) return Promise.reject(new Error("Cannot change Claude mode during an active turn"));
    return this.exclusive(async () => {
      assertModeId(mode);
      if (this.runtime?.turnActive) throw new Error("Cannot change Claude mode during an active turn");
      if (this.mode === mode) return;
      this.mode = mode;
      if (this.persisted) await this.save();
      await this.runtime?.reconfigure(this.model, this.mode, this.effort);
      await this.connection.sessionUpdate({ sessionId: this.id, update: { sessionUpdate: "current_mode_update", currentModeId: mode } });
      // Bypass Permissions has a setting of its own, so a session following the settings may have just changed its answer.
      await this.refreshAutoAccept({ publish: true });
    });
  }

  setEffort(effort: string): Promise<void> {
    if (this.runtime?.turnActive) return Promise.reject(new Error("Cannot change Claude's effort level during an active turn"));
    return this.exclusive(async () => {
      assertEffortId(effort);
      if (this.runtime?.turnActive) throw new Error("Cannot change Claude's effort level during an active turn");
      if (this.effort === effort) return;
      this.effort = effort;
      if (this.persisted) await this.save();
      await this.runtime?.reconfigure(this.model, this.mode, this.effort);
      await this.publishConfigOptions();
    });
  }

  /**
   * Both selectors behind one request, which is the only way the plugin provider's bridge ever asks for either.
   * A running Claude cannot be told to change either one, so the change takes effect by restarting it on the
   * conversation it was in — which is why an active turn is refused rather than queued.
   */
  async setConfigOption(configId: string, value: string | boolean): Promise<SessionConfigOption[]> {
    if (configId === AUTO_ACCEPT_CONFIG_ID) {
      if (typeof value !== "boolean") throw new Error(`Configuration option ${configId} takes a boolean`);
      await this.setAutoAccept(value);
      return this.configOptions;
    }
    if (typeof value !== "string") throw new Error(`Configuration option ${configId} takes the id of an option, not a boolean`);
    if (configId === MODEL_CONFIG_ID) await this.setModel(value);
    else if (configId === EFFORT_CONFIG_ID) await this.setEffort(value);
    else throw new Error(`Unsupported configuration option ${configId}`);
    return this.configOptions;
  }

  /**
   * Whether the next permission request is answered without a card. A session nobody has switched reads
   * the host settings again each time and tells Paseo when the answer moved, so the toggle on the agent
   * shows what the next request gets. A settings document that cannot be read asks.
   */
  async refreshAutoAccept(options: { publish: boolean }): Promise<boolean> {
    if (this.autoAccept !== null) return this.autoAccept;
    let resolved: boolean;
    try {
      resolved = await this.readAutoAcceptDefault(this.mode);
    } catch (error) {
      writeLog({ level: "warn", message: "Could not read the auto-accept settings; asking instead", sessionId: this.id, error: errorMessage(error) });
      resolved = false;
    }
    if (resolved !== this.defaultAutoAccept) {
      this.defaultAutoAccept = resolved;
      if (options.publish) {
        await this.publishConfigOptions().catch((error: unknown) => {
          writeLog({ level: "warn", message: "Failed to publish the auto-accept toggle", sessionId: this.id, error: errorMessage(error) });
        });
      }
    }
    return resolved;
  }

  cancel(): void {
    this.runtime?.cancel();
  }

  async close(): Promise<void> {
    this.beginActivity();
    await this.runtime?.close();
    this.runtime = null;
    await this.lock.release();
  }

  /**
   * Kept out of the queue the selectors wait in, because a prompt holds that queue for its whole turn and
   * this is most wanted in the middle of one. Nothing restarts: the next request reads the new value.
   */
  private async setAutoAccept(value: boolean): Promise<void> {
    this.autoAccept = value;
    writeLog({ level: "info", message: `Switched auto-accept ${value ? "on" : "off"}`, sessionId: this.id });
    if (this.persisted) await this.save();
  }

  /** The answer to `session/set_config_option` already carries these, so this is for the model a `session/set_model` changed. */
  private async publishConfigOptions(): Promise<void> {
    await this.connection.sessionUpdate({ sessionId: this.id, update: { sessionUpdate: "config_option_update", configOptions: this.configOptions } });
  }

  private async save(): Promise<void> {
    const state: PersistedSession = {
      version: 1,
      acpSessionId: this.id,
      claudeSessionId: this.currentClaudeSessionId,
      cwd: this.cwd,
      model: this.model,
      mode: this.mode,
      effort: this.effort,
      ...(this.autoAccept === null ? {} : { autoAccept: this.autoAccept }),
      lastActivity: Date.now(),
    };
    await this.stateStore.save(state);
    this.persisted = true;
  }

  private beginActivity(): number {
    this.activityVersion += 1;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    return this.activityVersion;
  }

  private scheduleSuspension(activityVersion: number): void {
    if (activityVersion !== this.activityVersion || !this.runtime?.started) return;
    this.idleSince = Date.now();
    void this.idleTimeout().then((idleTimeoutMs) => {
      if (idleTimeoutMs === 0) return;
      this.armSuspension(activityVersion, idleTimeoutMs);
    });
  }

  private armSuspension(activityVersion: number, delayMs: number): void {
    // A prompt that landed while this was being scheduled owns the timer now.
    if (activityVersion !== this.activityVersion || !this.runtime?.started) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      void this.exclusive(() => this.suspendIfStillIdle(activityVersion));
    }, Math.max(0, delayMs));
    this.idleTimer.unref();
  }

  private async suspendIfStillIdle(activityVersion: number): Promise<void> {
    if (activityVersion !== this.activityVersion || !this.runtime?.started) return;
    // Read again rather than trusted from when the timer was armed, so a change made in Paseo reaches a session that has been idle since before it.
    const idleTimeoutMs = await this.idleTimeout();
    if (idleTimeoutMs === 0) return;
    // Somebody is looking at a permission or question card. Stopping Claude now cancels the request behind it and
    // leaves that card on screen in Paseo, answering to nothing.
    if (this.runtime.turnActive || this.runtime.interactionPending) {
      this.armSuspension(activityVersion, SUSPENSION_RETRY_MS);
      return;
    }
    // Idleness is observed, not inferred from the last prompt. Claude keeps working after a turn ends —
    // a task notification wakes it, it launches the next agent, that agent runs for half an hour — and
    // none of that is a prompt, so the clock runs from the last thing the session actually did.
    const quietSince = Math.max(this.idleSince, this.runtime.activityAt);
    const remaining = quietSince + idleTimeoutMs - Date.now();
    if (remaining > 0) {
      this.armSuspension(activityVersion, remaining);
      return;
    }
    try {
      await this.runtime.suspend();
      writeLog({ level: "info", message: "Suspended idle Claude session", sessionId: this.id, idleTimeoutMs });
    } catch (error) {
      // Trying once and giving up would keep this session's process alive for the rest of its life, which is what the timeout exists to prevent.
      writeLog({
        level: "warn",
        message: "Failed to suspend idle Claude session; will try again",
        sessionId: this.id,
        retryInMs: SUSPENSION_RETRY_MS,
        error: error instanceof Error ? error.message : String(error),
      });
      this.armSuspension(activityVersion, SUSPENSION_RETRY_MS);
    }
  }

  /** Zero disables suspension, which is also how an unreadable setting is treated: never stop a session over it. */
  private async idleTimeout(): Promise<number> {
    if (this.fixedIdleTimeoutMs !== undefined) return this.fixedIdleTimeoutMs;
    try {
      return await readIdleTimeout();
    } catch (error) {
      writeLog({
        level: "warn",
        message: "Could not read the idle timeout; keeping this session alive",
        sessionId: this.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return 0;
    }
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export class SessionRegistry {
  private readonly sessions = new Map<string, ClaudeSession>();
  private readonly connection: AgentSideConnection;
  private readonly hooks: HookServer;
  private readonly dependencies: SessionRegistryDependencies;
  private readonly stateStore: StateStore;
  private readonly workspaceStores = new Map<string, StateStore>();

  constructor(
    connection: AgentSideConnection,
    hooks: HookServer,
    dependencies: SessionRegistryDependencies = {},
    stateStore = new StateStore(dependencies.stateDirectory),
  ) {
    this.connection = connection;
    this.hooks = hooks;
    this.dependencies = dependencies;
    this.stateStore = stateStore;
  }

  create(cwd: string): ClaudeSession {
    if (!path.isAbsolute(cwd)) throw new Error("ACP session cwd must be an absolute path");
    const id = randomUUID();
    return this.createSession({
      id,
      claudeSessionId: id,
      cwd: path.normalize(cwd),
      model: INHERIT_MODEL_ID,
      mode: "default",
      effort: INHERIT_EFFORT_ID,
      autoAccept: null,
      persisted: false,
    });
  }

  async load(sessionId: string, cwd: string): Promise<ClaudeSession> {
    if (this.sessions.has(sessionId)) throw new Error(`ACP session ${sessionId} is already open in this adapter`);
    if (!path.isAbsolute(cwd)) throw new Error("ACP session cwd must be an absolute path");
    const state = await this.loadRehoming(sessionId, path.normalize(cwd));
    if (!state) throw new Error(`Persisted ACP session ${sessionId} was not found on this host`);
    const model = migrateModelId(state.model);
    assertModelId(model);
    const mode = offeredModeId(state.mode);
    if (mode !== state.mode) writeLog({ level: "warn", message: `Opened the session in ${mode} mode: this adapter does not offer the ${state.mode} mode it was left in`, sessionId });
    const effort = offeredEffortId(state.effort);
    if (state.effort !== undefined && effort !== state.effort) {
      writeLog({ level: "warn", message: `Opened the session at the default effort: this adapter does not offer the ${state.effort} effort it was left at`, sessionId });
    }
    if (path.normalize(cwd) !== path.normalize(state.cwd)) throw new Error(`ACP session ${sessionId} belongs to ${state.cwd}, not ${cwd}`);
    const session = this.createSession({
      id: state.acpSessionId,
      claudeSessionId: state.claudeSessionId,
      cwd: state.cwd,
      model,
      mode,
      effort,
      autoAccept: state.autoAccept ?? null,
      persisted: true,
    });
    // The history is not replayed here. It goes out after `session/load` has answered, because
    // nothing sent before that answer has a session to land on -- see `ClaudeTtyAgent.restoreSession`.
    return session;
  }

  get(sessionId: string): ClaudeSession | null {
    return this.sessions.get(sessionId) ?? null;
  }

  async delete(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    this.sessions.delete(sessionId);
    await session?.close();
  }

  async clear(): Promise<void> {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.allSettled(sessions.map((session) => session.close()));
  }

  get size(): number {
    return this.sessions.size;
  }

  /**
   * A session is read from where the current scope keys it, and failing that from where the other
   * scope would have — then moved, so a host that switches scope resumes every session it had and
   * lists each one once. The move is copy-then-remove of a file this adapter is about to lock, and
   * the stale copy is only removed after the new one is written.
   */
  private async loadRehoming(sessionId: string, cwd: string): Promise<PersistedSession | null> {
    const store = this.storeFor(cwd);
    const state = await store.load(sessionId);
    if (state !== null) return state;
    const previous = store === this.stateStore ? new StateStore(workspaceStateDirectory(this.stateStore.root, cwd)) : this.stateStore;
    const left = await previous.load(sessionId);
    if (left === null) return null;
    // A session that belongs to another working directory is not this one come home: leave it
    // where it is and let the caller's own cwd check word the refusal.
    if (path.normalize(left.cwd) !== cwd) return left;
    await store.save(left);
    await previous.remove(sessionId);
    writeLog({ level: "info", message: `Moved the persisted session from ${previous.root} to ${store.root}, where the state scope now keeps it`, sessionId });
    return left;
  }

  /**
   * The store a session's working directory keys. Under the historical `shared` scope every cwd
   * shares the root; under `workspace` each cwd gets its own slice, and the log file moves with the
   * newest one — one adapter process serves one workspace in practice, and a record written before
   * the workspace was known has already gone to the root's log.
   */
  private storeFor(cwd: string): StateStore {
    if ((this.dependencies.stateScope ?? stateScope()) === "shared") return this.stateStore;
    const directory = workspaceStateDirectory(this.stateStore.root, cwd);
    const held = this.workspaceStores.get(directory);
    if (held !== undefined) return held;
    const store = new StateStore(directory);
    this.workspaceStores.set(directory, store);
    const relocateLog = this.dependencies.relocateLog ?? ((root: string) => enableLogFile(path.join(root, "logs", `${APP_NAME}.log`)));
    relocateLog(directory);
    return store;
  }

  private createSession(options: SessionOptions): ClaudeSession {
    const session = new ClaudeSession(options, this.connection, this.hooks, this.dependencies, this.storeFor(options.cwd));
    this.sessions.set(session.id, session);
    return session;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

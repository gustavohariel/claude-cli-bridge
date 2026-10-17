import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { APP_NAME } from "./constants.ts";

export type PersistedSession = {
  version: 1;
  acpSessionId: string;
  claudeSessionId: string;
  cwd: string;
  model: string;
  mode: string;
  /** Absent in a file written before the effort selector existed, which reads as the default effort. */
  effort?: string;
  /** Present only once someone has switched Auto Accept on this session; absent follows the host settings. */
  autoAccept?: boolean;
  lastActivity: number;
};

export class StateStore {
  readonly root: string;
  readonly sessionsDirectory: string;
  readonly locksDirectory: string;

  constructor(root = defaultStateDirectory()) {
    this.root = root;
    this.sessionsDirectory = path.join(root, "sessions");
    this.locksDirectory = path.join(root, "locks");
  }

  async load(sessionId: string): Promise<PersistedSession | null> {
    validateSessionId(sessionId);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(this.sessionPath(sessionId), "utf8"));
    } catch (error) {
      if (isMissing(error)) return null;
      throw new Error(`Could not read persisted session ${sessionId}: ${errorMessage(error)}`);
    }
    if (!isPersistedSession(parsed) || parsed.acpSessionId !== sessionId) throw new Error(`Persisted session ${sessionId} is invalid`);
    return parsed;
  }

  async save(session: PersistedSession): Promise<void> {
    validateSessionId(session.acpSessionId);
    await mkdir(this.sessionsDirectory, { recursive: true, mode: 0o700 });
    const destination = this.sessionPath(session.acpSessionId);
    const temporary = path.join(this.sessionsDirectory, `.${session.acpSessionId}.${randomUUID()}.tmp`);
    await writeFile(temporary, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 });
    try {
      await rename(temporary, destination);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  sessionPath(sessionId: string): string {
    validateSessionId(sessionId);
    return path.join(this.sessionsDirectory, `${sessionId}.json`);
  }

  /** Removing a session that is already gone is the outcome this was asking for. */
  async remove(sessionId: string): Promise<void> {
    await unlink(this.sessionPath(sessionId)).catch((error) => {
      if (!isMissing(error)) throw error;
    });
  }
}

export function defaultStateDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.CLAUDE_TTY_ACP_STATE_DIR?.trim();
  if (configured) return configured;
  const stateHome = env.XDG_STATE_HOME?.trim() || path.join(env.HOME || os.homedir(), ".local", "state");
  return path.join(stateHome, APP_NAME);
}

/**
 * How session state is keyed under the root. `shared` is the historical layout: one `sessions/` and
 * `locks/` for every workspace this host runs. `workspace` keys them by the session's working
 * directory instead, for deployments where adapters run in containers or on separate hosts and each
 * should see only its own workspace's state rather than one mutable directory shared across all.
 */
export type StateScope = "shared" | "workspace";

export function stateScope(env: NodeJS.ProcessEnv = process.env): StateScope {
  const configured = env.CLAUDE_TTY_ACP_STATE_SCOPE?.trim();
  if (!configured || configured === "shared") return "shared";
  if (configured === "workspace") return "workspace";
  // A value that is neither must not quietly fall back to sharing what it asked to partition.
  throw new Error(`CLAUDE_TTY_ACP_STATE_SCOPE must be "shared" or "workspace", not "${configured}"`);
}

/**
 * A workspace's slice of the state root. The escape is Claude's own convention for naming a project
 * directory after its working directory, so the two layouts read the same way side by side.
 */
export function workspaceStateDirectory(root: string, cwd: string): string {
  return path.join(root, "workspaces", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
}

function isPersistedSession(value: unknown): value is PersistedSession {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    record.version === 1 &&
    typeof record.acpSessionId === "string" &&
    typeof record.claudeSessionId === "string" &&
    typeof record.cwd === "string" &&
    path.isAbsolute(record.cwd) &&
    typeof record.model === "string" &&
    typeof record.mode === "string" &&
    (record.effort === undefined || typeof record.effort === "string") &&
    (record.autoAccept === undefined || typeof record.autoAccept === "boolean") &&
    typeof record.lastActivity === "number"
  );
}

function validateSessionId(sessionId: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sessionId)) throw new Error(`Invalid ACP session ID ${sessionId}`);
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

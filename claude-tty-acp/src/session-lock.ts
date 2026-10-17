import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, unlink } from "node:fs/promises";
import path from "node:path";

type LockRecord = {
  pid: number;
  token: string;
  createdAt: number;
};

export class SessionLock {
  readonly sessionId: string;
  readonly directory: string;
  private token: string | null = null;

  constructor(sessionId: string, directory: string) {
    this.sessionId = sessionId;
    this.directory = directory;
  }

  async acquire(): Promise<void> {
    if (this.token) return;
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const lockPath = this.filePath();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const token = randomUUID();
      try {
        const handle = await open(lockPath, "wx", 0o600);
        try {
          await handle.writeFile(`${JSON.stringify({ pid: process.pid, token, createdAt: Date.now() })}\n`);
        } finally {
          await handle.close();
        }
        this.token = token;
        return;
      } catch (error) {
        if (!isExists(error)) throw error;
        const owner = await readLock(lockPath);
        if (owner && processIsAlive(owner.pid)) throw new Error(`ACP session ${this.sessionId} is already active in process ${owner.pid}`);
        await unlink(lockPath).catch((unlinkError) => {
          if (!isMissing(unlinkError)) throw unlinkError;
        });
      }
    }
    throw new Error(`Could not acquire lock for ACP session ${this.sessionId}`);
  }

  async release(): Promise<void> {
    const token = this.token;
    this.token = null;
    if (!token) return;
    const lockPath = this.filePath();
    const current = await readLock(lockPath);
    if (current?.token === token) await unlink(lockPath).catch(() => undefined);
  }

  private filePath(): string {
    return path.join(this.directory, `${this.sessionId}.lock`);
  }
}

async function readLock(filePath: string): Promise<LockRecord | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(filePath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    return typeof record.pid === "number" && typeof record.token === "string" && typeof record.createdAt === "number"
      ? { pid: record.pid, token: record.token, createdAt: record.createdAt }
      : null;
  } catch {
    return null;
  }
}

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

function isExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

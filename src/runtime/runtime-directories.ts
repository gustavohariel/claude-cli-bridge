import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { APP_NAME } from "./constants.ts";

// Owned directories are found again by this prefix, and abandoned ones swept, so a variant
// built beside this one must not sweep the other's: APP_NAME, not a literal.
const PREFIX = `${APP_NAME}-`;
const MISSING_OWNER_GRACE_MS = 60 * 60 * 1000;

export function runtimePrefix(root: string): string {
  return path.join(root, PREFIX);
}

export async function markRuntimeDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(path.join(directory, "owner.json"), `${JSON.stringify({ pid: process.pid, createdAt: Date.now() })}\n`, { mode: 0o600 });
}

export async function cleanupAbandonedRuntimeDirectories(root = os.tmpdir()): Promise<void> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(PREFIX)) continue;
    const directory = path.join(root, entry.name);
    const owner = await readOwner(directory);
    if (owner && isProcessAlive(owner.pid)) continue;
    if (!owner) {
      const info = await stat(directory).catch(() => null);
      if (info && Date.now() - info.mtimeMs < MISSING_OWNER_GRACE_MS) continue;
    }
    await rm(directory, { force: true, recursive: true }).catch(() => undefined);
  }
}

async function readOwner(directory: string): Promise<{ pid: number } | null> {
  try {
    const parsed = JSON.parse(await readFile(path.join(directory, "owner.json"), "utf8")) as { pid?: unknown };
    return Number.isInteger(parsed.pid) && Number(parsed.pid) > 0 ? { pid: Number(parsed.pid) } : null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import path from "node:path";
import { APP_NAME } from "./constants.ts";
import { defaultStateDirectory } from "./state-store.ts";

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogRecord = {
  level: LogLevel;
  message: string;
  // Every record is stamped with these, so a record that names a process of its own names it something else.
  app?: never;
  time?: never;
  pid?: never;
  [key: string]: unknown;
};

/**
 * One file is shared by every adapter process on the host, so a record carries its pid. When the
 * file reaches this size it is moved aside, so the log holds the last two of these at most; two
 * processes crossing the threshold together move it aside twice, which costs the older of them.
 */
const MAX_LOG_FILE_BYTES = 5 * 1024 * 1024;

let logFile: { path: string; maxBytes: number } | null = null;
let reportedFileFailure = false;

/** Mirrors the state store's directory, because the log is about the sessions kept there. */
export function logFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(defaultStateDirectory(env), "logs", `${APP_NAME}.log`);
}

/**
 * Stderr is where the daemon reads the adapter's logs — and drops them, so nothing of what a
 * session did survives the moment anyone asks. The server keeps a copy on disk; the diagnose
 * command and the tests do not, since neither is a session anyone will need to reconstruct.
 * Returns null when the directory to keep it in cannot be made, because a host that cannot hold
 * the log still has to be able to run sessions.
 */
export function enableLogFile(filePath?: string, maxBytes = MAX_LOG_FILE_BYTES): string | null {
  reportedFileFailure = false;
  // Resolved inside the guard, not as a default argument: naming the file reads the environment and
  // the passwd database, which is one of the ways a host that cannot hold the log says so.
  let resolved: string | undefined;
  try {
    resolved = filePath ?? logFilePath();
    mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });
  } catch (error) {
    logFile = null;
    reportFileFailure(resolved, error);
    return null;
  }
  logFile = { path: resolved, maxBytes };
  return resolved;
}

export function disableLogFile(): void {
  logFile = null;
}

export function writeLog(record: LogRecord): void {
  const line = `${JSON.stringify({ app: APP_NAME, time: new Date().toISOString(), pid: process.pid, ...record })}\n`;
  process.stderr.write(line);
  if (logFile) appendToLogFile(logFile, line);
}

function appendToLogFile(file: { path: string; maxBytes: number }, line: string): void {
  try {
    rotateIfFull(file);
    // Opened for every line rather than held open, so a process that goes on logging after another
    // has rotated the file lands in the new one instead of the one moved aside.
    appendFileSync(file.path, line, { mode: 0o600 });
    reportedFileFailure = false;
  } catch (error) {
    reportFileFailure(file.path, error);
  }
}

function rotateIfFull(file: { path: string; maxBytes: number }): void {
  if (currentSize(file.path) < file.maxBytes) return;
  try {
    renameSync(file.path, `${file.path}.1`);
  } catch (error) {
    // Another process crossed the threshold first and took the file with it, which is this one's work done.
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
  }
}

/** The file is a courtesy; losing it must never take a session down, and saying so once a spell is enough. */
function reportFileFailure(filePath: string | undefined, error: unknown): void {
  if (reportedFileFailure) return;
  reportedFileFailure = true;
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${JSON.stringify({ app: APP_NAME, time: new Date().toISOString(), pid: process.pid, level: "warn", message: "Could not write the adapter log file", file: filePath, error: message })}\n`);
}

function currentSize(filePath: string): number {
  try {
    return statSync(filePath).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return 0;
    throw error;
  }
}

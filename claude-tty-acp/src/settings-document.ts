import { readFile } from "node:fs/promises";
import { writeLog } from "./log.ts";

let settingsFile: string | null = null;

/**
 * The Claude TTY plugin passes the path of its settings snapshot at spawn.
 * An adapter run outside Paseo gets none and has only its environment.
 */
export function useSettingsFile(filePath: string | null): void {
  settingsFile = filePath;
}

export function currentSettingsFile(): string | null {
  return settingsFile;
}

/**
 * The plugin writes `{ idleTimeoutMs, autoAccept, bypassAutoAccept }` with its defaults applied.
 * Each reader validates the field it needs and falls back on its own default.
 * Null means there is no file to read.
 */
export async function readSettingsValues(filePath: string | null = settingsFile): Promise<Record<string, unknown> | null> {
  if (filePath === null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    // No file is the normal state outside Paseo.
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
      writeLog({ level: "warn", message: "Ignored an unreadable Claude TTY settings document", file: filePath, error: errorMessage(error) });
    }
    return null;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  return raw as Record<string, unknown>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { writeLog } from "./log.ts";

/**
 * Where the plugin leaves the answers a question card collected, mirrored by
 * `plugins/claude-tty/server/paths.ts`, which names the directory and writes the documents.
 *
 * Paseo's own protocol carries the answers as a permission response's `updatedInput`, but the ACP
 * bridge in `@getpaseo/plugin` collapses that response to the id of the option it matched and throws
 * the rest away, and there is no other way back down the ACP connection. So the plugin writes the
 * answers here before it forwards the response, and this side reads them once the option comes back:
 * the write happens first, so a file that is missing means nobody answered the card in Paseo.
 */
export const ANSWERS_DIRECTORY_FLAG = "--answers-dir";

/** Answers are a handful of short strings; anything this size is a document nobody here wrote. */
const MAX_ANSWERS_BYTES = 256 * 1024;

let answersDirectory: string | null = null;

export function useAnswersDirectory(directory: string | null): void {
  answersDirectory = directory;
}

/** The two sides name the same file, so both punch out everything a tool use id may carry. */
export function answersFileName(cardId: string): string {
  return `${cardId.replace(/[^A-Za-z0-9._-]/g, "-")}.json`;
}

/**
 * Reads the answers left for one card and drops the document, so a card answered twice — a client
 * that retried, a session that resumed — never reads the first answer a second time.
 */
export async function takeCardAnswers(cardId: string, directory: string | null = answersDirectory): Promise<Record<string, unknown> | null> {
  if (!directory) return null;
  const file = path.join(directory, answersFileName(cardId));
  let raw: string;
  try {
    raw = await readFile(file, { encoding: "utf8" });
  } catch (error) {
    // Nothing to read is the ordinary case: every client that is not Paseo's question form answers with an option alone.
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
      writeLog({ level: "warn", message: "Ignored unreadable question card answers", file, error: errorMessage(error) });
    }
    return null;
  }
  await rm(file, { force: true }).catch(() => undefined);
  if (raw.length > MAX_ANSWERS_BYTES) {
    writeLog({ level: "warn", message: "Ignored oversized question card answers", file, bytes: raw.length });
    return null;
  }
  let document: unknown;
  try {
    document = JSON.parse(raw);
  } catch (error) {
    writeLog({ level: "warn", message: "Ignored malformed question card answers", file, error: errorMessage(error) });
    return null;
  }
  const answers = objectValue(objectValue(document)?.answers);
  return answers;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

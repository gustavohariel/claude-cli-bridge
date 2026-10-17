import { readFile } from "node:fs/promises";
import path from "node:path";
import { claudeConfigDir } from "./transcript-reader.ts";

/**
 * What Claude says has the keyboard, or null when it says nothing has.
 *
 * Claude keeps a file per interactive process, `sessions/<pid>.json` under its config directory, whose
 * `status` goes to `waiting` for as long as something it has opened is holding the keys off the input
 * box; `waitingFor` beside it names the thing -- `dialog open` for the questions it draws in the box's
 * place, and `input needed` and `sandbox request` for the two that ask in their own way.
 *
 * It is the only account of that state there is. On the screen a question marks its selected row with
 * the same `❯` the input box is drawn with, and Claude draws the question where the box was, so every
 * reading the terminal offers says a box is there holding a line nobody typed.
 *
 * Anything unreadable is null rather than a guess -- no file, a Claude too old to write one, a
 * half-written one -- which leaves the caller exactly where it stood before this was here.
 */
export async function claudeIsWaitingFor(claudePid: number | undefined, configDir: string = claudeConfigDir()): Promise<string | null> {
  if (claudePid === undefined) return null;
  let state: { status?: unknown; waitingFor?: unknown };
  try {
    state = JSON.parse(await readFile(path.join(configDir, "sessions", `${claudePid}.json`), "utf8")) as typeof state;
  } catch {
    return null;
  }
  if (state.status !== "waiting") return null;
  // Every kind Claude has a name for is a dialog of some sort, but the table it reads them out of is
  // its own and grows; one it has not named is still one the adapter must not type over.
  return typeof state.waitingFor === "string" && state.waitingFor.length > 0 ? state.waitingFor : "an answer";
}

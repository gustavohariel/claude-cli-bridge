import { open } from "node:fs/promises";

/** A card is replaced whole on every update, so it carries the end of what a command printed rather than all of it. */
const TAIL_BYTES = 8_000;

/**
 * The end of what a background command has written so far, as plain text, or null while there is no file.
 * Claude writes the command's raw terminal output there, so colours are dropped and a line redrawn in place by a carriage return keeps only its last drawing.
 */
export async function readOutputTail(file: string, bytes = TAIL_BYTES): Promise<string | null> {
  let handle;
  try {
    handle = await open(file, "r");
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, bytes);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    let text = buffer.toString("utf8");
    // A tail starts wherever the byte count fell, which may be mid-line or mid-character.
    // A tail that is all one line keeps its broken start, since dropping it would leave nothing.
    if (length < size) {
      const firstBreak = text.trimEnd().indexOf("\n");
      text = `…${firstBreak === -1 ? text : text.slice(firstBreak + 1)}`;
    }
    return plainText(text);
  } finally {
    await handle.close();
  }
}

function plainText(text: string): string {
  return text
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .split("\n")
    .map((line) => line.replace(/\r+$/, "").split("\r").at(-1) ?? "")
    .join("\n")
    .trimEnd();
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

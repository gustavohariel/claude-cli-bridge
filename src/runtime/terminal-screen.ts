import { createRequire } from "node:module";
import type { IBufferCell, Terminal as XtermTerminal } from "@xterm/headless";

const require = createRequire(import.meta.url);
const { Terminal } = require("@xterm/headless") as { Terminal: typeof XtermTerminal };

// The size of the terminal Claude is given, and so of the screen it lays its output out for. Exported
// because the shape of what Claude draws follows from it: a prompt wraps at the width, and nothing it
// draws -- the input box included -- can be taller than the height.
export const TERMINAL_COLS = 120;
export const TERMINAL_ROWS = 40;

/**
 * A line of the screen and the colour its text is drawn in, where that is one colour.
 *
 * Claude says a great deal with colour that it says no other way. Its dialogs draw a title, the lines
 * describing it, the rows to choose between and the line naming the keys, and on the screen those are
 * told apart by the palette entry each is written in and by nothing else -- `/rewind` puts a
 * checkpoint's own line and the line summarising its changes in the same column, one in the default
 * colour and one in the grey everything secondary uses. `colour` is that entry where every visible cell
 * of the line shares one, and null where they do not; the parser compares lines to each other rather
 * than to any particular value, so a theme that renames the greys changes nothing.
 */
export type ScreenLine = {
  text: string;
  colour: string | null;
};

export class TerminalScreen {
  private readonly terminal: XtermTerminal = new Terminal({ allowProposedApi: true, cols: TERMINAL_COLS, rows: TERMINAL_ROWS, scrollback: 500 });
  private lastWriteAt = 0;

  write(data: string, callback?: () => void): void {
    this.lastWriteAt = Date.now();
    this.terminal.write(data, callback);
  }

  /** Claude paints continuously while it restores a conversation, so a screen that has stopped changing is the signal that it has finished. */
  quietFor(milliseconds: number): boolean {
    return Date.now() - this.lastWriteAt >= milliseconds;
  }

  snapshot(): string {
    return this.lines()
      .map((line) => line.text)
      .join("\n")
      .slice(-8_000);
  }

  /** The same lines the snapshot has, with what colour says about each of them kept. */
  lines(): ScreenLine[] {
    const buffer = this.terminal.buffer.active;
    const lines: ScreenLine[] = [];
    const firstLine = Math.max(0, buffer.length - TERMINAL_ROWS);
    for (let index = firstLine; index < buffer.length; index += 1) {
      const line = buffer.getLine(index);
      const text = line?.translateToString(true).trimEnd() ?? "";
      if (!text || !line) continue;
      lines.push({ text, colour: lineColour(line) });
    }
    return lines;
  }

  reset(): void {
    this.lastWriteAt = Date.now();
    this.terminal.reset();
  }

  dispose(): void {
    this.terminal.dispose();
  }
}

/** The colour every visible cell of a line shares, or null where more than one is in play. */
function lineColour(line: { length: number; getCell(column: number): IBufferCell | undefined }): string | null {
  let colour: string | null = null;
  for (let column = 0; column < line.length; column += 1) {
    const cell = line.getCell(column);
    if (!cell || cell.getChars().trim() === "") continue;
    const key = cellColour(cell);
    if (colour === null) colour = key;
    else if (colour !== key) return null;
  }
  return colour;
}

/**
 * A cell's foreground as something two cells can be compared by. Only the colour: Claude draws the
 * selected row of a dialog bold and its footer italic, and neither says what kind of line it is.
 */
function cellColour(cell: IBufferCell): string {
  if (cell.isFgDefault()) return "default";
  if (cell.isFgPalette()) return `p${cell.getFgColor()}`;
  if (cell.isFgRGB()) return `#${cell.getFgColor().toString(16)}`;
  return "unknown";
}

import type { ScreenLine } from "./terminal-screen.ts";

/**
 * Reading one of Claude's own dialogs off the terminal.
 *
 * Whether a dialog is up at all is never decided here: Claude draws one where the input box was and
 * marks its selected row with the same `❯`, so the screen cannot tell the two apart. `session-status.ts`
 * is what answers that, out of Claude's own state file, and this is only ever asked once it has.
 *
 * What the screen is good for is the rest, and Claude Code v2.1.269 draws all of these the same way --
 * measured by driving the real thing through `/model` and `/rewind`:
 *
 * ```
 * ▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔   a rule across the whole width, where the dialog starts
 *    Rewind                          the title
 *    Restore the code or conversat…  what it is about
 *      say hi                        a row
 *      No code changes               that row's own detail, in the colour everything secondary uses
 *    ❯ (current)                     the row the marker is on
 *    Enter to continue · Esc to canc the keys that answer it
 * ```
 *
 * The rule is what keeps the conversation above out of the title, and colour is what keeps a row's
 * detail from being read as a row of its own -- there is nothing else on the screen that separates
 * those two, and `/rewind` read without it offers "No code changes" as something to choose. Nothing
 * here is a contract, so every reading degrades in one direction: rows that cannot be made out come
 * back as none rather than as invented ones, and the card built from the reading still carries the text
 * as drawn and can still be dismissed. The one thing never guessed at is which row is selected, because
 * that is what answering moves.
 */

/** A row of a dialog, as the card will offer it. */
export type DialogChoice = {
  /** What the button says: the row's own text, without the column of detail Claude lines up beside it. */
  label: string;
  /** That column, where there was one, so the card can say what the row means. */
  detail: string;
  /** The marker is on this row, so Enter would take it. */
  selected: boolean;
  /** The number Claude drew ahead of the row, where it numbers them. */
  number: number | null;
};

export type DialogReading = {
  /** The line Claude draws at the top of the dialog, where the screen says where the dialog starts. */
  title: string;
  /** What the dialog says about itself under that title. */
  question: string;
  choices: DialogChoice[];
  /**
   * The list is longer than the window it is drawn in, so `choices` is what is on screen rather than
   * everything there is to choose. Claude says so with an `↑ 3 more above` line of its own.
   */
  scrolls: boolean;
  /** The dialog as drawn, which is what a reading with no rows in it still has to offer. */
  text: string;
};

/** The dialog is drawn in a box on some screens and bare on others, so the border is taken off both ways. */
const BORDERS = "│┃|╎┆┇┊┋║";
/** How far the rows of a dialog are followed away from the marker. Beyond this it is the conversation. */
const MAX_CHOICES = 12;
/** How many lines above the rows are read where no rule says where the dialog starts. */
const MAX_QUESTION_LINES = 6;
const MAX_QUESTION_CHARS = 400;
const MAX_TEXT_CHARS = 1_500;
const MAX_LABEL_CHARS = 120;
/**
 * How much of the detail column still belongs on the button. Claude lines a row's own state up beside
 * it -- `[✔]` on a checkbox question, `✔` on the model already in use -- and losing that makes two rows
 * read the same; a sentence of description is the card's to show rather than the button's.
 */
const MAX_LABEL_DETAIL = 16;
/** How much of a row has to be shared before one row can stand for another it was drawn as. */
const MIN_LABEL_MATCH = 4;

const MARKER = /^(\s*)❯(\s?)(.*)$/;
const NUMBERED = /^(\d+)[.)]\s+(.*)$/;
const BOX_TOP = /^\s*[╭┌╔]/;
const BOX_BOTTOM = /^\s*[╰└╚]/;
/** The line Claude draws a dialog under, across the whole width. Which character it uses is the theme's. */
const RULE = /^[▔▁─━═▬_]{20,}$/;
/**
 * The line Claude draws under a dialog to say which keys answer it. It is not a row of the dialog and
 * it is not part of the question, and it is what stops both readings from running away down the screen.
 */
const FOOTER = /(?:enter to (?:confirm|select|submit|set|continue)|esc(?:ape)? to |press (?:enter|esc)|↑\/↓|←\/→|tab to)/i;
/**
 * What Claude draws where a list is longer than the room it has: `↑ 1 more above`, `↓ 3 more below`.
 * It is not a row and it is not part of the question -- it is a fact about the window, and it changes
 * as the window moves, so a reading that kept it would call the same dialog a different one a moment
 * later. What it does say is worth keeping, which is what `scrolls` is for.
 */
const SCROLL_INDICATOR = /^[↑↓⌃⌄]\s*\d+\s+more\b/i;

/**
 * What the screen says about the dialog Claude is holding the keyboard for, or null where it has
 * painted nothing at all to read. Give it the screen's lines rather than its text wherever there are
 * any: what colour says is half of the reading.
 */
export function readDialog(screen: string | readonly ScreenLine[]): DialogReading | null {
  const lines = (typeof screen === "string" ? screen.split("\n").map((text) => ({ text, colour: null })) : screen).map(stripBorder);
  if (lines.every((line) => line.text.trim() === "")) return null;
  const markerIndex = lines.findLastIndex((line) => MARKER.test(line.text));
  if (markerIndex < 0) {
    // No row marked, so nothing to select and nothing to be sure a question is even on: what is under
    // the last rule -- or the tail of the screen, where there is none -- is the whole of the reading,
    // and the card it makes offers Dismiss and the text.
    const from = ruleAbove(lines, lines.length) ?? lines.length - MAX_QUESTION_LINES;
    const drawn = lines
      .slice(Math.max(0, from))
      .map((line) => line.text.trim())
      .filter((text) => text !== "");
    const said = drawn.filter((text) => !SCROLL_INDICATOR.test(text));
    return {
      title: "",
      question: clamp(said.join("\n"), MAX_QUESTION_CHARS),
      choices: [],
      scrolls: drawn.some((text) => SCROLL_INDICATOR.test(text)),
      text: clamp(drawn.join("\n"), MAX_TEXT_CHARS),
    };
  }
  const scrolls = lines.some((line) => SCROLL_INDICATOR.test(line.text.trim()));
  const marker = MARKER.exec(lines[markerIndex]!.text)!;
  const content = marker[3]!.trim();
  const column = marker[1]!.length + 1 + marker[2]!.length;
  const candidates = NUMBERED.test(content) ? numberedRows(lines, markerIndex) : alignedRows(lines, markerIndex, column);
  const rows = withoutDetailLines(lines, candidates, markerIndex);
  const choices = rows.map((index) => choiceAt(lines[index]!.text, index === markerIndex));
  const first = rows[0] ?? markerIndex;
  const last = (rows.at(-1) ?? markerIndex) + 1;
  const rule = ruleAbove(lines, first);
  // Where a dialog drawn in a box rather than under a rule starts. It bounds what is read as the
  // question, but no title is taken from it: the first line inside one of those boxes is a sentence
  // that happens to be first, and half of it as a title is worse than none.
  const start = rule ?? boxTopAbove(lines, first) ?? Math.max(0, first - MAX_QUESTION_LINES);
  // Under that and above the rows is what the dialog says about itself, its title first.
  const said = lines
    .slice(start, first)
    .map((line) => line.text.trim())
    .filter((text) => text !== "" && !FOOTER.test(text) && !BOX_TOP.test(text) && !BOX_BOTTOM.test(text) && !SCROLL_INDICATOR.test(text));
  // Only where the screen said where the dialog starts. A title taken off a few lines of conversation is
  // how the tail of a transcript ended up as the title of a card.
  const title = rule === null ? "" : (said.shift() ?? "");
  const text = lines
    .slice(start, Math.min(lines.length, last + 2))
    .map((line) => line.text)
    .filter((line) => line.trim() !== "");
  return {
    title: clamp(title, MAX_LABEL_CHARS),
    question: clamp(said.join("\n"), MAX_QUESTION_CHARS),
    choices,
    scrolls,
    text: clamp(text.join("\n"), MAX_TEXT_CHARS),
  };
}

/**
 * Whether a reading says anything at all.
 *
 * Claude writes its state file the moment it opens a dialog and draws the dialog a render later, so a
 * screen read in that gap is the one that was there before -- an input box, which is a marker row with
 * nothing on it and nothing above it. That is not a dialog anybody can be asked about, and it is not
 * the same as a dialog whose rows could not be made out: that one has its text.
 */
export function dialogIsReadable(dialog: DialogReading): boolean {
  return dialog.title.trim() !== "" || dialog.question.trim() !== "" || dialog.choices.some((choice) => choice.label !== "");
}

/**
 * Whether two readings are of the same dialog.
 *
 * Not the same window of it: `/rewind` scrolls, so the rows on screen when a card is answered are
 * routinely not the rows that were on screen when it was raised -- which is how an answer to a
 * perfectly live dialog came to be dropped as stale. What holds still is the title and what the dialog
 * says about itself; the rows are only asked to overlap, which two windows of one list do and two
 * different dialogs sharing a title do not.
 */
export function sameDialog(one: DialogReading | null, other: DialogReading | null): boolean {
  if (!one || !other) return false;
  if (one.title !== other.title || one.question !== other.question) return false;
  if (one.choices.length === 0 || other.choices.length === 0) return true;
  const labels = new Set(one.choices.map((choice) => choice.label));
  return other.choices.some((choice) => labels.has(choice.label));
}

/** Whether the marker sits on this row now, which is what answering one waits for. */
export function choiceSelected(screen: string | readonly ScreenLine[], label: string): boolean {
  return readDialog(screen)?.choices.some((choice) => choice.selected && labelMatches(choice.label, label)) === true;
}

/**
 * Whether a row on screen is the row a card was answered with.
 *
 * Not equality, because Claude rewrites a row while its dialog is up: the row the marker is on grows
 * what it can do inline, so `Summarize from here` becomes `Summarize from here: add context (optional)`
 * the moment the marker reaches it. One being the start of the other is what holds across that, with a
 * few characters required so that two short rows cannot pass for each other.
 */
export function labelMatches(row: string, chosen: string): boolean {
  if (row === chosen) return true;
  const [shorter, longer] = row.length <= chosen.length ? [row, chosen] : [chosen, row];
  return shorter.length >= MIN_LABEL_MATCH && longer.startsWith(shorter);
}

/**
 * Which row a card was answered with, or -1. An exact match wins; failing that a single row that
 * starts the same way is it, and two are nothing -- a row this cannot name is one to escape rather
 * than to guess at.
 */
export function findChoice(choices: readonly DialogChoice[], label: string): number {
  const exact = choices.findIndex((choice) => choice.label === label);
  if (exact >= 0) return exact;
  const matched = choices.flatMap((choice, index) => (labelMatches(choice.label, label) ? [index] : []));
  return matched.length === 1 ? matched[0]! : -1;
}

/** A title for the card: what Claude titled the dialog, and the best line there is where it did not. */
export function dialogTitle(dialog: DialogReading): string {
  const candidates = [dialog.title, dialog.question.split("\n")[0], dialog.text.split("\n").find((line) => line.trim() !== "")];
  const title = candidates.map((value) => value?.trim()).find((value) => value !== undefined && value !== "");
  return title ? clamp(title, MAX_LABEL_CHARS) : "Claude is asking something";
}

/** Where the dialog above `before` starts: the line after the nearest rule across the whole width. */
function ruleAbove(lines: readonly ScreenLine[], before: number): number | null {
  for (let index = Math.min(before, lines.length) - 1; index >= 0; index -= 1) {
    if (RULE.test(lines[index]!.text.trim())) return index + 1;
  }
  return null;
}

/** The line after the nearest box top above `before`, where Claude drew this one in a box. */
function boxTopAbove(lines: readonly ScreenLine[], before: number): number | null {
  for (let index = Math.min(before, lines.length) - 1; index >= 0; index -= 1) {
    if (BOX_TOP.test(lines[index]!.text)) return index + 1;
  }
  return null;
}

/** Claude numbers the rows of most of its dialogs, and a number is the surest thing on the screen. */
function numberedRows(lines: readonly ScreenLine[], markerIndex: number): number[] {
  const rows: number[] = [];
  const numbered = (index: number): boolean => {
    const line = lines[index]?.text;
    if (line === undefined || FOOTER.test(line) || SCROLL_INDICATOR.test(line.trim())) return false;
    return NUMBERED.test(withoutMarker(line));
  };
  for (let index = markerIndex - 1; index >= 0 && rows.length < MAX_CHOICES && numbered(index); index -= 1) rows.unshift(index);
  rows.push(markerIndex);
  for (let index = markerIndex + 1; index < lines.length && rows.length < MAX_CHOICES && numbered(index); index += 1) rows.push(index);
  return rows;
}

/**
 * The rows of a dialog that numbers none of them, which are the lines whose text starts in the same
 * column as the marked row's -- the column the marker itself is drawn in.
 */
function alignedRows(lines: readonly ScreenLine[], markerIndex: number, column: number): number[] {
  const rows: number[] = [];
  const aligned = (index: number): boolean => {
    const line = lines[index]?.text;
    if (line === undefined || FOOTER.test(line) || line.trim() === "" || SCROLL_INDICATOR.test(line.trim())) return false;
    const text = withoutMarker(line);
    return line.length - text.length === column && !BOX_TOP.test(line) && !BOX_BOTTOM.test(line) && !RULE.test(line.trim());
  };
  for (let index = markerIndex - 1; index >= 0 && rows.length < MAX_CHOICES && aligned(index); index -= 1) rows.unshift(index);
  rows.push(markerIndex);
  for (let index = markerIndex + 1; index < lines.length && rows.length < MAX_CHOICES && aligned(index); index += 1) rows.push(index);
  return rows;
}

/**
 * The rows, without the lines that are a row's own detail rather than a row.
 *
 * `/rewind` puts a checkpoint's line and the line summarising its changes in the same column and tells
 * them apart by colour alone: the summary is drawn in the grey Claude writes everything secondary in,
 * the line naming the keys included. So the line naming the keys is what says which grey that is, and a
 * candidate row written entirely in it is detail. The row the marker is on is never dropped, whatever
 * it is drawn in, because that one is where answering starts from.
 */
function withoutDetailLines(lines: readonly ScreenLine[], rows: readonly number[], markerIndex: number): number[] {
  const secondary = secondaryColour(lines, rows);
  if (secondary === null) return [...rows];
  const kept = rows.filter((index) => index === markerIndex || lines[index]!.colour !== secondary);
  // Everything but the marked row reading as detail says the reading is wrong rather than that Claude
  // drew a dialog with one row in it, so the rows go back rather than the card offering one button.
  return kept.length > 1 || rows.length === 1 ? kept : [...rows];
}

/** The colour Claude writes secondary text in, taken from the line that names the keys. */
function secondaryColour(lines: readonly ScreenLine[], rows: readonly number[]): string | null {
  const from = (rows.at(-1) ?? -1) + 1;
  for (let index = from; index < Math.min(lines.length, from + 3); index += 1) {
    const line = lines[index]!;
    if (FOOTER.test(line.text)) return line.colour;
  }
  return null;
}

function choiceAt(line: string, selected: boolean): DialogChoice {
  const text = withoutMarker(line).trim();
  const numbered = NUMBERED.exec(text);
  const row = numbered ? numbered[2]! : text;
  // Claude lines the detail up in a column of its own, which is a run of spaces wide enough to be one.
  const [first = "", ...rest] = row.split(/ {2,}/);
  const detail = collapse(rest.join(" "));
  const label = collapse(detail !== "" && detail.length <= MAX_LABEL_DETAIL ? `${first} ${detail}` : first);
  return {
    label: clamp(label, MAX_LABEL_CHARS),
    detail: clamp(detail, MAX_LABEL_CHARS),
    selected,
    number: numbered ? Number(numbered[1]) : null,
  };
}

/** The row without the marker or the spaces standing in for it, so rows line up whichever one this is. */
function withoutMarker(line: string): string {
  const marker = MARKER.exec(line);
  return marker ? marker[3]! : line.replace(/^\s+/, "");
}

/** A dialog drawn in a box carries its border on both ends of every line, and it is not part of the row. */
function stripBorder(line: ScreenLine): ScreenLine {
  const stripped = line.text.replace(new RegExp(`[${BORDERS}]\\s*$`), "");
  const opening = new RegExp(`^(\\s*)[${BORDERS}](\\s?)`).exec(stripped);
  return { text: opening ? stripped.slice(opening[0].length) : stripped, colour: line.colour };
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function clamp(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

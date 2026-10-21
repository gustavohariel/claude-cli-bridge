import assert from "node:assert/strict";
import test from "node:test";
import { choiceSelected, dialogIsReadable, dialogTitle, findChoice, labelMatches, readDialog, sameDialog } from "./dialog-screen.ts";
import type { ScreenLine } from "./terminal-screen.ts";

/** A fixture written the way the screen hands its lines over: the text, and the colour it is drawn in. */
function screen(lines: Array<[string, string | null]>): ScreenLine[] {
  return lines.map(([text, colour]) => ({ text, colour }));
}

function plain(lines: string[]): string {
  return lines.join("\n");
}

const RULE = "▔".repeat(96);

/**
 * `/model`, off a real Claude Code v2.1.269 driven through it in a PTY, with the colour of every line
 * as the terminal reported it. This is the screen the first version of this parser titled a card after
 * the transcript above the dialog, because nothing told it where the dialog started.
 */
const MODEL_DIALOG = screen([
  [" ▐▛███▛█   Claude Code v2.1.269", null],
  ["▝▜██████▀  Opus 5 (1M context) with high effort · API Usage Billing", null],
  ["  ▝▝ ▝▝    /tmp/live-work", null],
  ["  ⎿  Not logged in · Please run /login", null],
  ["✻ Cooked for 0s · done 7:18 PM", "p246"],
  [RULE, "p153"],
  ["   Select model", "p153"],
  ["   Switch between Claude models. Your pick becomes the default for new sessions. For other/previous model names,", "p246"],
  ["   specify with --model.", "p246"],
  ["   ❯ 1. Default (recommended) ✔  Use the default model (currently Opus 5 (1M context)) · $5/$25 per Mtok", null],
  ["     2. Opus (1M context)        Opus 5 with 1M context · Best for everyday, complex tasks · $5/$25 per Mtok", null],
  ["     3. Sonnet                   Sonnet 5 · Efficient for routine tasks · $2/$10 per Mtok", null],
  ["     4. Haiku                    Haiku 4.5 · Fastest for quick answers · $1/$5 per Mtok", null],
  ["   ● High effort (default) ←/→ to adjust", null],
  ["   Enter to set as default · s to use this session only · Esc to cancel", "p246"],
]);

/**
 * `/rewind`, off the same session. Its entries are not numbered and a checkpoint's line and the line
 * summarising its changes sit in the same column: colour is the only thing that says which is which,
 * and read without it this dialog offered "No code changes" as something to choose.
 */
const REWIND_DIALOG = screen([
  ["❯ say hi", null],
  ["  ⎿  Not logged in · Please run /login", null],
  ["✻ Cogitated for 0s · done 7:21 PM", "p246"],
  [RULE, "p153"],
  ["   Rewind", "p153"],
  ["   Restore the code and/or conversation to the point before…", "default"],
  ["     say hi", "default"],
  ["     No code changes", "p246"],
  ["   ❯ (current)", "p153"],
  ["   Enter to continue · Esc to cancel", "p246"],
]);

/**
 * `/rewind` on a session with more checkpoints than Claude draws at once, in the two windows a live
 * session showed: the one a card was built from, and the one on screen when that card was answered a
 * minute later. The list had scrolled, and the answer was dropped as belonging to another dialog.
 */
const REWIND_WINDOW_ONE = screen([
  [RULE, "p153"],
  ["   Rewind", "p153"],
  ["   Restore the code and/or conversation to the point before…", "default"],
  ["    ↑ 1 more above", "p246"],
  ["     Reply with exactly: THIRD", "default"],
  ["     No code changes", "p246"],
  ["   ❯ (current)", "p153"],
  ["   Enter to continue · Esc to cancel", "p246"],
]);

const REWIND_WINDOW_TWO = screen([
  [RULE, "p153"],
  ["   Rewind", "p153"],
  ["   Restore the code and/or conversation to the point before…", "default"],
  ["     Reply with exactly: READY", "default"],
  ["     No code changes", "p246"],
  ["   ❯ Reply with exactly: THIRD", "p153"],
  ["     No code changes", "p246"],
  ["    ↓ 1 more below", "p246"],
  ["   Enter to continue · Esc to cancel", "p246"],
]);

/**
 * The question `/rewind` asks once a checkpoint is chosen, in the two readings one live session took of
 * it a minute apart. It is one dialog that never closed, and almost nothing about it held still: the
 * timestamp ticks, the line under the question follows whichever row the marker is on, and that row
 * grows what it can do inline.
 */
const CONFIRM_WHEN_CARDED = screen([
  [RULE, "p153"],
  ["   Rewind", "p153"],
  ["   Confirm you want to restore to the point before you sent this message:", "default"],
  ["Reply with exactly: THIRD", "p246"],
  ["(24s ago)", "p246"],
  ["   The conversation will be forked.", "p246"],
  ["   The code will be unchanged.", "p246"],
  ["   ❯ 1. Restore conversation", "p153"],
  ["     2. Summarize from here", "default"],
  ["     3. Summarize up to here", "default"],
  ["     4. Never mind", "default"],
  ["   Enter to continue · Esc to cancel", "p246"],
]);

const CONFIRM_WHEN_ANSWERED = screen([
  [RULE, "p153"],
  ["   Rewind", "p153"],
  ["   Confirm you want to restore to the point before you sent this message:", "default"],
  ["Reply with exactly: THIRD", "p246"],
  ["(48s ago)", "p246"],
  ["   Messages after this point will be summarized.", "p246"],
  ["     1. Restore conversation", "default"],
  ["   ❯ 2. Summarize from here: add context (optional)", "p153"],
  ["     3. Summarize up to here", "default"],
  ["     4. Never mind", "default"],
  ["   Enter to continue · Esc to cancel", "p246"],
]);

/** The auto-mode setup question, which numbers nothing and marks the row it is on the same way. */
const CHECKBOX_DIALOG = plain([
  "Claude Code reads this project, your recent Claude sessions, and optionally your shell history.",
  "❯ Also scan shell history    [✔]",
  "  Also scan your other repos   [ ]",
  "Enter to confirm · Esc to cancel",
]);

/** A nudge drawn in a box rather than under a rule, which is the other shape Claude uses. */
const BOXED_DIALOG = plain([
  "  Read the file and found three call sites.",
  "╭────────────────────────────────────────────────────────╮",
  "│ Claude Code can use the Playwright plugin for this      │",
  "│ project.                                                │",
  "│                                                         │",
  "│ ❯ 1. Yes, add it                                        │",
  "│   2. No thanks                                          │",
  "│   3. Don't ask again for this project                   │",
  "│                                                         │",
  "│ Enter to confirm · Esc to cancel                        │",
  "╰────────────────────────────────────────────────────────╯",
]);

test("starts the dialog at the rule Claude draws it under, not in the conversation above it", () => {
  const dialog = readDialog(MODEL_DIALOG);
  assert.equal(dialog?.title, "Select model");
  assert.equal(
    dialog?.question,
    "Switch between Claude models. Your pick becomes the default for new sessions. For other/previous model names,\nspecify with --model.",
  );
  // None of the transcript above the rule, which is what the card was titled after before.
  assert.ok(!dialog!.title.includes("Cooked for"));
  assert.ok(!dialog!.question.includes("Not logged in"));
  assert.equal(dialogTitle(dialog!), "Select model");
});

test("reads a numbered dialog's rows without the column of description beside them", () => {
  const dialog = readDialog(MODEL_DIALOG);
  assert.deepEqual(
    dialog?.choices.map((choice) => choice.label),
    // The mark on the model already in use stays on the button, because it is what tells two rows apart;
    // the sentence explaining the row is the card's to show rather than the button's.
    ["Default (recommended) ✔", "Opus (1M context)", "Sonnet", "Haiku"],
  );
  assert.deepEqual(dialog?.choices[1]?.detail, "Opus 5 with 1M context · Best for everyday, complex tasks · $5/$25 per Mtok");
  assert.deepEqual(
    dialog?.choices.map((choice) => choice.selected),
    [true, false, false, false],
  );
  // The line about effort is not a row, and neither is the line naming the keys.
  assert.ok(!dialog!.choices.some((choice) => choice.label.includes("High effort")));
  // The dialog as drawn rides along whole.
  assert.ok(dialog!.text.includes("Enter to set as default"));
});

test("keeps a row's own detail line out of the rows, by the colour Claude draws it in", () => {
  const dialog = readDialog(REWIND_DIALOG);
  assert.equal(dialog?.title, "Rewind");
  assert.equal(dialog?.question, "Restore the code and/or conversation to the point before…");
  // "No code changes" is that checkpoint's summary, in the same grey as the line naming the keys.
  assert.deepEqual(
    dialog?.choices.map((choice) => ({ label: choice.label, selected: choice.selected })),
    [
      { label: "say hi", selected: false },
      { label: "(current)", selected: true },
    ],
  );
  // And the marker is followed onto the row above, which is what answering this one has to do.
  assert.ok(choiceSelected(REWIND_DIALOG, "(current)"));
  const moved = REWIND_DIALOG.map((line) =>
    line.text === "     say hi" ? { ...line, text: "   ❯ say hi" } : line.text === "   ❯ (current)" ? { ...line, text: "     (current)" } : line,
  );
  assert.ok(choiceSelected(moved, "say hi"));
  assert.ok(sameDialog(readDialog(REWIND_DIALOG), readDialog(moved)));
});

test("reads the same dialog without colour rather than refusing to read it", () => {
  // A screen handed over as text alone -- every test fixture below, and any caller that has only the
  // snapshot -- keeps every candidate row, because nothing there says which are detail.
  const dialog = readDialog(plain(REWIND_DIALOG.map((line) => line.text)));
  assert.deepEqual(
    dialog?.choices.map((choice) => choice.label),
    ["say hi", "No code changes", "(current)"],
  );
  assert.equal(dialog?.title, "Rewind");
});

test("reads a dialog Claude drew in a box, where no rule says where it starts", () => {
  const dialog = readDialog(BOXED_DIALOG);
  assert.equal(dialog?.title, "");
  assert.equal(dialog?.question, "Claude Code can use the Playwright plugin for this\nproject.");
  assert.deepEqual(
    dialog?.choices.map((choice) => choice.label),
    ["Yes, add it", "No thanks", "Don't ask again for this project"],
  );
  assert.ok(!dialog!.question.includes("call sites"));
  assert.equal(dialogTitle(dialog!), "Claude Code can use the Playwright plugin for this");
});

test("reads a dialog that numbers nothing from the column its rows start in", () => {
  const dialog = readDialog(CHECKBOX_DIALOG);
  assert.deepEqual(
    dialog?.choices.map((choice) => ({ label: choice.label, selected: choice.selected })),
    [
      { label: "Also scan shell history [✔]", selected: true },
      { label: "Also scan your other repos [ ]", selected: false },
    ],
  );
  assert.equal(dialog?.question, "Claude Code reads this project, your recent Claude sessions, and optionally your shell history.");
});

test("follows the marker rather than the row it started on", () => {
  const moved = CHECKBOX_DIALOG.replace("❯ Also scan shell history", "  Also scan shell history").replace(
    "  Also scan your other repos",
    "❯ Also scan your other repos",
  );
  assert.ok(choiceSelected(CHECKBOX_DIALOG, "Also scan shell history [✔]"));
  assert.ok(!choiceSelected(moved, "Also scan shell history [✔]"));
  assert.ok(choiceSelected(moved, "Also scan your other repos [ ]"));
  // Moving the marker is not a different dialog; the card raised for one is still the one on screen.
  assert.ok(sameDialog(readDialog(CHECKBOX_DIALOG), readDialog(moved)));
  assert.ok(!sameDialog(readDialog(CHECKBOX_DIALOG), readDialog(BOXED_DIALOG)));
});

test("offers no choices rather than invented ones when nothing on the screen is a row", () => {
  const dialog = readDialog(plain(["Claude needs to run a command outside its sandbox.", "npm install --global something"]));
  assert.deepEqual(dialog?.choices, []);
  // The text is still there, which is the whole of what makes such a card worth raising: a person can
  // read what Claude is asking even where nothing here could parse it, and dismiss it.
  assert.ok(dialog?.text.includes("outside its sandbox"));
  assert.equal(dialogTitle(dialog!), "Claude needs to run a command outside its sandbox.");
});

test("says nothing about a terminal that has painted nothing", () => {
  assert.equal(readDialog(""), null);
  assert.equal(readDialog("   \n  "), null);
  assert.equal(sameDialog(null, null), false);
});

test("tells a dialog from the input box that was on screen a render earlier", () => {
  // Claude writes its state file as it opens a dialog and draws the dialog after, so the first look at
  // the screen routinely finds the box that was there before: one marker row with nothing on it.
  const idle = readDialog(plain(["❯", "  ⏸ manual mode on"]));
  assert.equal(dialogIsReadable(idle!), false);
  assert.equal(dialogIsReadable(readDialog(MODEL_DIALOG)!), true);
  assert.equal(dialogIsReadable(readDialog(REWIND_DIALOG)!), true);
  assert.equal(dialogIsReadable(readDialog(CHECKBOX_DIALOG)!), true);
  // A dialog whose rows could not be made out is a different thing: it has its text, and a card carrying
  // that is worth raising even though nothing here could parse it.
  assert.equal(dialogIsReadable(readDialog("Claude needs to run a command outside its sandbox.")!), true);
});

test("reads a list longer than its window without the line that says so", () => {
  const dialog = readDialog(REWIND_WINDOW_TWO);
  // The `↓ 1 more below` line is neither a row nor part of the question. It is a fact about the window,
  // and one that changes as the window moves.
  assert.equal(dialog?.question, "Restore the code and/or conversation to the point before…");
  assert.deepEqual(
    dialog?.choices.map((choice) => choice.label),
    ["Reply with exactly: READY", "Reply with exactly: THIRD"],
  );
  // What it does say is kept, because a card built from it is offering part of a list.
  assert.equal(dialog?.scrolls, true);
  assert.equal(readDialog(REWIND_WINDOW_ONE)?.scrolls, true);
  assert.equal(readDialog(CHECKBOX_DIALOG)?.scrolls, false);
  // And the indicator is still in the dialog as drawn, which is what the card shows a person.
  assert.ok(dialog?.text.includes("1 more below"));
});

test("reads two windows of a scrolling list as the same dialog", () => {
  // This is the live failure: the card was raised on the first window and answered against the second,
  // and requiring the same rows made a dialog nobody had closed look like one that had gone.
  assert.ok(sameDialog(readDialog(REWIND_WINDOW_ONE), readDialog(REWIND_WINDOW_TWO)));
  // The question Claude opens *after* that one shares its title and is not the same dialog.
  const confirm = screen([
    [RULE, "p153"],
    ["   Rewind", "p153"],
    ["   Confirm you want to restore to the point before you sent this message:", "default"],
    ["   ❯ Restore conversation", "p153"],
    ["     Never mind", "default"],
    ["   Enter to continue · Esc to cancel", "p246"],
  ]);
  assert.ok(!sameDialog(readDialog(REWIND_WINDOW_ONE), readDialog(confirm)));
  // Neither is a window of some other list that happens to be titled the same way.
  const elsewhere = screen([
    [RULE, "p153"],
    ["   Rewind", "p153"],
    ["   Restore the code and/or conversation to the point before…", "default"],
    ["   ❯ Reply with exactly: SOMETHING ELSE", "p153"],
    ["   Enter to continue · Esc to cancel", "p246"],
  ]);
  assert.ok(!sameDialog(readDialog(REWIND_WINDOW_ONE), readDialog(elsewhere)));
});

test("reads a dialog that rewrites itself while it is up as one dialog with two faces", () => {
  const carded = readDialog(CONFIRM_WHEN_CARDED)!;
  const later = readDialog(CONFIRM_WHEN_ANSWERED)!;
  // The title is the one thing that holds still. The question does not -- the timestamp ticks and the
  // line under it follows the marker -- which is why the words cannot say whether a card is still live.
  assert.equal(carded.title, "Rewind");
  assert.equal(later.title, "Rewind");
  assert.notEqual(carded.question, later.question);
  assert.ok(carded.question.includes("(24s ago)"));
  assert.ok(later.question.includes("Messages after this point will be summarized."));
});

test("finds the row a card was answered with after Claude has rewritten it", () => {
  const later = readDialog(CONFIRM_WHEN_ANSWERED)!;
  // The marked row grew what it can do inline, and it is still the row that was offered.
  assert.equal(findChoice(later.choices, "Summarize from here"), 1);
  assert.ok(choiceSelected(CONFIRM_WHEN_ANSWERED, "Summarize from here"));
  // The rows that did not change are found the way they always were.
  assert.equal(findChoice(later.choices, "Never mind"), 3);
  assert.equal(findChoice(later.choices, "Restore conversation"), 0);
  // A row that is nowhere in the list is nowhere in the list.
  assert.equal(findChoice(later.choices, "Reply with exactly: THIRD"), -1);
  // Two rows that start the same way are not a match: a row this cannot name is one to escape.
  assert.equal(findChoice([{ label: "Yes, keep it", detail: "", selected: false, number: null }, { label: "Yes, and remember", detail: "", selected: false, number: null }], "Yes,"), -1);
  assert.ok(labelMatches("Summarize from here: add context (optional)", "Summarize from here"));
  assert.ok(!labelMatches("Summarize up to here", "Summarize from here"));
  // And a couple of characters in common is not a row being the same row.
  assert.ok(!labelMatches("Nope", "N"));
});

test("stops following rows at the line that says which keys answer them", () => {
  const dialog = readDialog(
    plain(["❯ 1. Keep going", "  2. Stop here", "  Enter to confirm · Esc to cancel", "  Some later line at the same indent"]),
  );
  assert.deepEqual(
    dialog?.choices.map((choice) => choice.label),
    ["Keep going", "Stop here"],
  );
});

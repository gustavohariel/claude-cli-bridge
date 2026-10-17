import assert from "node:assert/strict";
import test from "node:test";
import type { AgentSideConnection, RequestPermissionRequest, RequestPermissionResponse } from "@agentclientprotocol/sdk";
import { type DialogKey, DialogWatcher } from "./dialog-cards.ts";
import { InteractionBridge } from "./interactions.ts";
import type { ScreenLine } from "./terminal-screen.ts";
import { CARD_WITHDRAWN_METHOD, NOTICE_METHOD } from "./vendor-updates.ts";

const DIALOG_SCREEN = [
  "Claude Code can use the Playwright plugin for this project.",
  "❯ 1. Yes, add it",
  "  2. No thanks",
  "Enter to confirm · Esc to cancel",
].join("\n");

const IDLE_SCREEN = ["❯", "  ⏸ manual mode on"].join("\n");

/**
 * The question `/rewind` asks once a checkpoint is chosen, as one live session read it when the card
 * went up and again when it was answered. Claude never closed it and rewrote nearly all of it: the
 * timestamp ticked, the line under the question followed the marker, and the marked row grew what it
 * can do inline. Requiring the words to match dropped the answer.
 */
function confirmDialog(options: { seconds: number; marked: number }): ScreenLine[] {
  const rows = ["1. Restore conversation", "2. Summarize from here", "3. Summarize up to here", "4. Never mind"];
  // Claude writes the row the marker is on as what it can do, not as what it is called.
  if (options.marked === 1) rows[1] = "2. Summarize from here: add context (optional)";
  return [
    ["▔".repeat(96), "p153"],
    ["   Rewind", "p153"],
    ["   Confirm you want to restore to the point before you sent this message:", "default"],
    ["Reply with exactly: THIRD", "p246"],
    [`(${options.seconds}s ago)`, "p246"],
    [options.marked === 1 ? "   Messages after this point will be summarized." : "   The conversation will be forked.", "p246"],
    ...rows.map((row, index): [string, string | null] => [`   ${index === options.marked ? "❯ " : "  "}${row}`, index === options.marked ? "p153" : "default"]),
    ["   Enter to continue · Esc to cancel", "p246"],
  ].map(([text, colour]) => ({ text: text as string, colour: colour as string | null }));
}

/** Where `confirmDialog` draws its rows, for the marker to be moved between. */
const CONFIRM_ROWS = [6, 7, 8, 9];

/**
 * `/rewind` as a real Claude Code v2.1.269 drew it, colours included: two checkpoints' worth of rows
 * where one line is a row's own summary rather than a row, told apart by the grey it is written in.
 */
const REWIND_SCREEN: ScreenLine[] = [
  ["✻ Cogitated for 0s · done 7:21 PM", "p246"],
  ["▔".repeat(96), "p153"],
  ["   Rewind", "p153"],
  ["   Restore the code and/or conversation to the point before…", "default"],
  ["     say hi", "default"],
  ["     No code changes", "p246"],
  ["   ❯ (current)", "p153"],
  ["   Enter to continue · Esc to cancel", "p246"],
].map(([text, colour]) => ({ text: text!, colour: colour! }));

/**
 * A list longer than the window it is drawn in, as `/rewind` is on a session with a few checkpoints:
 * three rows on screen, the marker somewhere in them, and a line at each end saying how many more
 * there are. Moving the marker past an edge scrolls the window, which is what makes a row that was on
 * screen when the card went up reachable again after it has scrolled away.
 */
type ScrollingList = { rows: readonly string[]; marked: number; window?: number };

function scrollingList(rows: readonly string[], marked: number, window = 3): ScreenLine[] {
  const first = Math.min(Math.max(0, marked - Math.floor((window - 1) / 2)), Math.max(0, rows.length - window));
  const visible = rows.slice(first, first + window);
  const lines: Array<[string, string | null]> = [
    ["▔".repeat(96), "p153"],
    ["   Rewind", "p153"],
    ["   Restore the code and/or conversation to the point before…", "default"],
  ];
  if (first > 0) lines.push([`    ↑ ${first} more above`, "p246"]);
  for (const [index, row] of visible.entries()) lines.push([`   ${first + index === marked ? "❯ " : "  "}${row}`, "default"]);
  if (first + window < rows.length) lines.push([`    ↓ ${rows.length - first - window} more below`, "p246"]);
  lines.push(["   Enter to continue · Esc to cancel", "p246"]);
  return lines.map(([text, colour]) => ({ text, colour }));
}

/** A screen the tests hand over as text, which is what a caller with only the snapshot has. */
function asLines(screen: string | ScreenLine[]): ScreenLine[] {
  return typeof screen === "string" ? screen.split("\n").map((text) => ({ text, colour: null })) : screen;
}

/**
 * Claude's own lists, as they were measured to move: the marker steps between the rows and **stops** at
 * either end rather than coming round. `/rewind` opens with the marker on its last row, where Down does
 * nothing at all — which is how the first version of this reached no row it was asked for.
 */
function moveMarker(lines: ScreenLine[], rows: number[], direction: "up" | "down"): ScreenLine[] {
  const marked = lines.findIndex((line) => /^\s*❯/.test(line.text));
  const next = rows[rows.indexOf(marked) + (direction === "up" ? -1 : 1)];
  if (next === undefined || rows.indexOf(marked) < 0) return lines;
  return lines.map((line, index) => {
    if (index === marked) return { ...line, text: line.text.replace("❯ ", "  ") };
    if (index === next) return { ...line, text: line.text.replace(/^(\s*) {2}(?=\S)/, "$1❯ ") };
    return line;
  });
}

type Harness = {
  watcher: DialogWatcher;
  permissions: RequestPermissionRequest[];
  vendor: Array<{ method: string; params: Record<string, unknown> }>;
  keys: DialogKey[];
  escapes: number;
  answer(response: RequestPermissionResponse): void;
  setWaitingFor(value: string | null): void;
  setScreen(value: string | ScreenLine[]): void;
  interactions: InteractionBridge;
};

function harness(options: { rows?: number[]; list?: ScrollingList; startupScreen?: string; answerTimeoutMs?: number } = {}): Harness {
  const permissions: RequestPermissionRequest[] = [];
  const vendor: Array<{ method: string; params: Record<string, unknown> }> = [];
  const keys: DialogKey[] = [];
  let resolvePermission: ((response: RequestPermissionResponse) => void) | null = null;
  let waitingFor: string | null = null;
  let screen = asLines(IDLE_SCREEN);
  const state = { escapes: 0 };
  const connection = {
    sessionUpdate: async () => undefined,
    extNotification: async (method: string, params: Record<string, unknown>) => {
      vendor.push({ method, params });
    },
    requestPermission: (request: RequestPermissionRequest) => {
      permissions.push(request);
      return new Promise<RequestPermissionResponse>((resolve) => {
        resolvePermission = resolve;
      });
    },
  } as unknown as AgentSideConnection;
  const interactions = new InteractionBridge("session-1", "/work", connection);
  const watcher = new DialogWatcher({
    sessionId: "session-1",
    connection,
    interactions,
    waitingFor: async () => waitingFor,
    screen: () => screen.map((line) => line.text).join("\n"),
    lines: () => screen,
    escape: () => {
      state.escapes += 1;
    },
    press: (key) => {
      keys.push(key);
      // Enter takes whatever the marker is on, which is what stops Claude waiting.
      if (key === "enter") {
        waitingFor = null;
        return;
      }
      if (options.rows) screen = moveMarker(screen, options.rows, key);
      if (options.list) {
        // A list longer than its window: the marker steps and the window follows it, and neither end
        // comes round -- which is how Claude's own lists move.
        const list = options.list;
        if (key === "up") list.marked = Math.max(0, list.marked - 1);
        if (key === "down") list.marked = Math.min(list.rows.length - 1, list.marked + 1);
        screen = scrollingList(list.rows, list.marked, list.window);
      }
    },
    answeredByStartup: (value) => options.startupScreen !== undefined && value === options.startupScreen,
    pollIntervalMs: 10,
    answerKeyMs: 1,
    answerTimeoutMs: options.answerTimeoutMs ?? 50,
    settleMs: 100,
  });
  return {
    watcher,
    permissions,
    vendor,
    keys,
    get escapes() {
      return state.escapes;
    },
    interactions,
    answer: (response) => resolvePermission?.(response),
    setWaitingFor: (value) => {
      waitingFor = value;
    },
    setScreen: (value) => {
      screen = asLines(value);
    },
  };
}

async function waitFor(condition: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for test condition");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

test("raises a card with a button per row, and every one of them a declining option", async (t) => {
  const test1 = harness();
  t.after(() => test1.watcher.stop());
  test1.watcher.start();
  test1.setScreen(DIALOG_SCREEN);
  test1.setWaitingFor("dialog open");
  await waitFor(() => test1.permissions.length === 1);

  const request = test1.permissions[0]!;
  assert.equal(request.toolCall.title, "Claude Code can use the Playwright plugin for this project.");
  assert.deepEqual(request.options, [
    // Dismiss first: an answer that names no action takes the first option of its behaviour, and every
    // option here has the same one, because a question Claude is waiting on must never be answered by
    // Paseo's automatic modes.
    { optionId: "dialog-dismiss", name: "Dismiss (Esc)", kind: "reject_once" },
    { optionId: "dialog-choice-0", name: "Yes, add it", kind: "reject_once" },
    { optionId: "dialog-choice-1", name: "No thanks", kind: "reject_once" },
  ]);
  const input = request.toolCall.rawInput as Record<string, unknown>;
  assert.equal(input.claudeDialog, true);
  assert.equal(input.waitingFor, "dialog open");
  // The dialog as drawn rides along, so a reading that found no rows is still answerable by a person.
  assert.ok(String(input.terminal).includes("Enter to confirm"));

  // One card for the question, not one per poll.
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(test1.permissions.length, 1);
});

test("waits for Claude to draw the dialog rather than carding the screen before it", async (t) => {
  const painting = harness();
  t.after(() => painting.watcher.stop());
  painting.watcher.start();
  // The state file says a dialog is up; the screen is still the input box that was there a render ago.
  painting.setWaitingFor("dialog open");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(painting.permissions.length, 0);

  painting.setScreen(DIALOG_SCREEN);
  await waitFor(() => painting.permissions.length === 1);
  // And what it asks about is the dialog, not a card titled after an empty input box.
  assert.equal(painting.permissions[0]!.toolCall.title, "Claude Code can use the Playwright plugin for this project.");
});

test("offers the rows of a dialog Claude numbered none of, and not the lines describing them", async (t) => {
  const rewind = harness();
  t.after(() => rewind.watcher.stop());
  rewind.watcher.start();
  rewind.setScreen(REWIND_SCREEN);
  rewind.setWaitingFor("dialog open");
  await waitFor(() => rewind.permissions.length === 1);

  const request = rewind.permissions[0]!;
  assert.equal(request.toolCall.title, "Rewind");
  // "No code changes" is the summary of the checkpoint above it, not something to choose: offering it
  // is what made answering this dialog fall back to Escape, because no marker would ever land on it.
  assert.deepEqual(
    request.options.map((option) => option.name),
    ["Dismiss (Esc)", "say hi", "(current)"],
  );
  const input = request.toolCall.rawInput as Record<string, unknown>;
  assert.equal(input.question, "Restore the code and/or conversation to the point before…");
  assert.ok(String(input.terminal).includes("No code changes"));
});

test("answers by moving Claude's own marker the way Claude's own list moves", async (t) => {
  // The rows of the `/rewind` fixture, which is the shape that made this necessary: the marker opens on
  // the last of them, the line between them is a row's summary rather than a row, and the list does not
  // come round -- so reaching the row above means pressing Up, and pressing Down forever reaches nothing.
  const rewind = harness({ rows: [4, 6] });
  t.after(() => rewind.watcher.stop());
  rewind.watcher.start();
  rewind.setScreen(REWIND_SCREEN);
  rewind.setWaitingFor("dialog open");
  await waitFor(() => rewind.permissions.length === 1);

  rewind.answer({ outcome: { outcome: "selected", optionId: "dialog-choice-0" } });
  await waitFor(() => rewind.keys.includes("enter"));
  assert.deepEqual(rewind.keys, ["up", "enter"]);
  // And Claude stopped saying it was waiting, which is the only proof the answer landed.
  assert.equal(rewind.escapes, 0);
});

test("asks about the question answering one opened, and not about the one it answered", async (t) => {
  const chained = harness({ rows: [4, 6] });
  t.after(() => chained.watcher.stop());
  chained.watcher.start();
  chained.setScreen(REWIND_SCREEN);
  chained.setWaitingFor("dialog open");
  await waitFor(() => chained.permissions.length === 1);
  chained.answer({ outcome: { outcome: "selected", optionId: "dialog-choice-0" } });
  await waitFor(() => chained.keys.includes("enter"));

  // Claude goes on waiting, because answering that one opened the next -- which is what `/rewind` does,
  // and what the card must follow it into.
  chained.setWaitingFor("dialog open");
  await new Promise((resolve) => setTimeout(resolve, 40));
  // The same dialog still on screen is not a new question, whatever the state file says.
  assert.equal(chained.permissions.length, 1);

  chained.setScreen(DIALOG_SCREEN);
  await waitFor(() => chained.permissions.length === 2);
  assert.equal(chained.permissions[1]!.toolCall.title, "Claude Code can use the Playwright plugin for this project.");
});

test("presses towards the row rather than around the list, whichever way that is", async (t) => {
  const down = harness({ rows: [4, 6] });
  t.after(() => down.watcher.stop());
  down.watcher.start();
  // The same dialog with the marker on the first row instead, so the row asked for is below it.
  down.setScreen(moveMarker(REWIND_SCREEN, [4, 6], "up"));
  down.setWaitingFor("dialog open");
  await waitFor(() => down.permissions.length === 1);

  down.answer({ outcome: { outcome: "selected", optionId: "dialog-choice-1" } });
  await waitFor(() => down.keys.includes("enter"));
  assert.deepEqual(down.keys, ["down", "enter"]);
});

test("walks a list that scrolled to the row it was asked for, wherever the window has moved to", async (t) => {
  // `/rewind` on a session with a few checkpoints: five rows, three of them drawn, the marker at the
  // end where Claude opens it.
  const list: ScrollingList = { rows: ["ONE", "TWO", "THREE", "FOUR", "(current)"], marked: 4 };
  // Walking a list takes longer than stepping across one, which is what the bound is for.
  const scrolling = harness({ list, answerTimeoutMs: 2_000 });
  t.after(() => scrolling.watcher.stop());
  scrolling.setScreen(scrollingList(list.rows, list.marked));
  scrolling.watcher.start();
  scrolling.setWaitingFor("dialog open");
  await waitFor(() => scrolling.permissions.length === 1);

  // The card offers what the window was showing, and says there is more of it.
  assert.deepEqual(
    scrolling.permissions[0]!.options.map((option) => option.name),
    ["Dismiss (Esc)", "THREE", "FOUR", "(current)"],
  );
  assert.equal((scrolling.permissions[0]!.toolCall.rawInput as Record<string, unknown>).scrolls, true);

  // Before anybody answers, the list scrolls away from the row that was chosen -- which is what a live
  // session did in the minute between raising the card and answering it, and what made the answer read
  // as belonging to a dialog that had gone.
  list.marked = 0;
  scrolling.setScreen(scrollingList(list.rows, list.marked));
  scrolling.answer({ outcome: { outcome: "selected", optionId: "dialog-choice-1" } });

  // The row is nowhere in the window, so the marker is walked until it is drawn again -- one way until
  // the end of the list, then the other. Claude's lists do not come round, so there is no other way back.
  await waitFor(() => scrolling.keys.includes("enter") || scrolling.escapes > 0, 4_000);
  assert.equal(scrolling.escapes, 0);
  assert.equal(list.rows[list.marked], "FOUR", "the marker ended on the row the card was answered with");
  // Up first, where there was nothing, then back down to it.
  assert.deepEqual(scrolling.keys, ["up", "down", "down", "down", "enter"]);
});
test("answers a dialog Claude has rewritten under the card, rather than dropping the answer", async (t) => {
  const rewriting = harness({ rows: CONFIRM_ROWS, answerTimeoutMs: 2_000 });
  t.after(() => rewriting.watcher.stop());
  rewriting.setScreen(confirmDialog({ seconds: 24, marked: 0 }));
  rewriting.watcher.start();
  rewriting.setWaitingFor("dialog open");
  await waitFor(() => rewriting.permissions.length === 1);
  assert.deepEqual(
    rewriting.permissions[0]!.options.map((option) => option.name),
    ["Dismiss (Esc)", "Restore conversation", "Summarize from here", "Summarize up to here", "Never mind"],
  );

  // A minute passes with the card up and nobody answering. Claude redraws the dialog it never closed:
  // the timestamp has ticked, the description has followed the marker, and the marked row reads
  // differently. It is the same question -- Claude has not stopped waiting for a moment.
  rewriting.setScreen(confirmDialog({ seconds: 48, marked: 1 }));
  rewriting.answer({ outcome: { outcome: "selected", optionId: "dialog-choice-3" } });

  await waitFor(() => rewriting.keys.includes("enter") || rewriting.escapes > 0, 4_000);
  // Down from the second row to "Never mind", and Enter on it -- not an escape, and not silence.
  assert.deepEqual(rewriting.keys, ["down", "down", "enter"]);
  assert.equal(rewriting.escapes, 0);
});

test("drops an answer that outlived the question it was for, and presses nothing", async (t) => {
  const ended = harness({ rows: CONFIRM_ROWS, answerTimeoutMs: 2_000 });
  t.after(() => ended.watcher.stop());
  ended.setScreen(confirmDialog({ seconds: 24, marked: 0 }));
  ended.watcher.start();
  ended.setWaitingFor("dialog open");
  await waitFor(() => ended.permissions.length === 1);

  // Claude stops waiting -- the question was answered in its own terminal, or closed itself -- and a
  // poll sees it. Whatever it opens next is a question of its own, so the answer to this card is not
  // pressed into it.
  ended.setWaitingFor(null);
  await waitFor(() => ended.vendor.some((update) => update.method === CARD_WITHDRAWN_METHOD));
  ended.setWaitingFor("dialog open");
  ended.answer({ outcome: { outcome: "selected", optionId: "dialog-choice-3" } });

  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.deepEqual(ended.keys, []);
  assert.equal(ended.escapes, 0);
});

test("escapes the question when the card is dismissed, and when the row cannot be reached", async (t) => {
  const dismissed = harness();
  t.after(() => dismissed.watcher.stop());
  dismissed.watcher.start();
  dismissed.setScreen(DIALOG_SCREEN);
  dismissed.setWaitingFor("dialog open");
  await waitFor(() => dismissed.permissions.length === 1);
  dismissed.answer({ outcome: { outcome: "selected", optionId: "dialog-dismiss" } });
  await waitFor(() => dismissed.escapes === 1);
  dismissed.setWaitingFor(null);

  // A list that ignores the keys: nothing moves, so no row is ever reached.
  const stuck = harness();
  t.after(() => stuck.watcher.stop());
  stuck.watcher.start();
  stuck.setScreen(DIALOG_SCREEN);
  stuck.setWaitingFor("dialog open");
  await waitFor(() => stuck.permissions.length === 1);
  stuck.answer({ outcome: { outcome: "selected", optionId: "dialog-choice-1" } });
  // A row the marker will not go to leaves the question closed rather than pressed at: an unanswered
  // question of Claude's is what stops every later prompt to this session.
  await waitFor(() => stuck.escapes === 1);
  assert.ok(!stuck.keys.includes("enter"));
  stuck.setWaitingFor(null);
});

test("takes the card down in Paseo too when the session lets go of it at a turn boundary", async (t) => {
  const orphaned = harness();
  t.after(() => orphaned.watcher.stop());
  orphaned.watcher.start();
  orphaned.setScreen(DIALOG_SCREEN);
  orphaned.setWaitingFor("dialog open");
  await waitFor(() => orphaned.permissions.length === 1);
  const card = orphaned.permissions[0]!.toolCall.toolCallId;

  // A prompt arrives, which is what `beginTurn` does to every card this side is waiting on. Nothing
  // else will ever end this one: the adapter has stopped waiting, and Paseo is still showing it.
  orphaned.interactions.cancelPending();
  await waitFor(() => orphaned.vendor.some((update) => update.method === CARD_WITHDRAWN_METHOD));
  assert.equal(orphaned.vendor.find((update) => update.method === CARD_WITHDRAWN_METHOD)!.params.toolCallId, card);

  // And because the question is still up, it is asked about again rather than left unanswerable.
  await waitFor(() => orphaned.permissions.length === 2);
  assert.notEqual(orphaned.permissions[1]!.toolCall.toolCallId, card);
});

test("takes the card down when the question closes by itself", async (t) => {
  const test4 = harness();
  t.after(() => test4.watcher.stop());
  test4.watcher.start();
  test4.setScreen(DIALOG_SCREEN);
  test4.setWaitingFor("dialog open");
  await waitFor(() => test4.permissions.length === 1);

  // Claude closes two of its nudges after thirty seconds whatever anybody does.
  test4.setScreen(IDLE_SCREEN);
  test4.setWaitingFor(null);
  await waitFor(() => test4.vendor.some((update) => update.method === CARD_WITHDRAWN_METHOD));
  const withdrawal = test4.vendor.find((update) => update.method === CARD_WITHDRAWN_METHOD)!;
  assert.equal(withdrawal.params.toolCallId, test4.permissions[0]!.toolCall.toolCallId);
  // Nothing was pressed into a question that is no longer there.
  assert.equal(test4.escapes, 0);
  assert.deepEqual(test4.keys, []);
});

test("says in the timeline which question a prompt dismissed", async (t) => {
  const test5 = harness();
  t.after(() => test5.watcher.stop());
  test5.watcher.start();
  test5.setScreen(DIALOG_SCREEN);
  test5.setWaitingFor("dialog open");
  await waitFor(() => test5.permissions.length === 1);

  await test5.watcher.dismissedForPrompt("dialog open");
  const notice = test5.vendor.find((update) => update.method === NOTICE_METHOD);
  const details = notice?.params.notice as { severity: string; title: string; description: string };
  assert.equal(details.severity, "warning");
  assert.ok(details.title.includes("Playwright"));
  assert.ok(details.description.includes("Yes, add it"));
  // And the card goes with it: the question it stood for is gone.
  assert.ok(test5.vendor.some((update) => update.method === CARD_WITHDRAWN_METHOD));
});

test("leaves the dialogs the adapter answers itself alone, and the ones a hook is already asking about", async (t) => {
  const startup = harness({ startupScreen: "the workspace trust screen" });
  t.after(() => startup.watcher.stop());
  startup.watcher.start();
  startup.setScreen("the workspace trust screen");
  startup.setWaitingFor("dialog open");
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(startup.permissions.length, 0);

  const hooked = harness();
  t.after(() => hooked.watcher.stop());
  // A permission card of Claude's own is open and waiting for an answer; the session is `waiting` for
  // exactly that, and a second card would be a second answer to one question.
  void hooked.interactions.requestWorkspaceTrust();
  await waitFor(() => hooked.permissions.length === 1);
  hooked.watcher.start();
  hooked.setScreen(DIALOG_SCREEN);
  hooked.setWaitingFor("permission prompt");
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(hooked.permissions.length, 1);
  hooked.interactions.cancelPending();
});

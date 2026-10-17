import { randomUUID } from "node:crypto";
import type { AgentSideConnection, PermissionOption } from "@agentclientprotocol/sdk";
import { choiceSelected, type DialogReading, dialogIsReadable, dialogTitle, findChoice, readDialog, sameDialog } from "./dialog-screen.ts";
import type { ScreenLine } from "./terminal-screen.ts";
import type { InteractionBridge } from "./interactions.ts";
import { writeLog } from "./log.ts";
import { sendCardWithdrawn, sendNotice } from "./vendor-updates.ts";

/** How often Claude's state file is read while a session is up. It is a few hundred bytes and a stat. */
export const DIALOG_POLL_MS = 400;
/** How long each key gets to move the marker, and how long the whole of that may take. */
export const DIALOG_ANSWER_KEY_MS = 200;
/**
 * Long enough to walk a list that scrolls. A row is only ever offered because it was on screen when the
 * card went up, so the marker is never more than a window or two away from it -- but it may have to go
 * to one end of the list and back before the row is drawn again.
 */
export const DIALOG_ANSWER_TIMEOUT_MS = 6_000;
/** How long Claude is given to stop waiting once its question has been answered or dismissed. */
export const DIALOG_SETTLE_MS = 1_500;
/**
 * How many polls a dialog gets to appear on the screen before it is carded from whatever is there.
 *
 * Claude writes its state file as it opens a dialog and draws the dialog a render later, so the first
 * poll to see the wait routinely sees the screen from before it. Waiting for the screen to catch up
 * costs a poll or two; carding what was there instead is a card titled after an empty input box.
 * Bounded, because a dialog this can never read is still a dialog somebody has to be able to dismiss.
 */
const DIALOG_READ_ATTEMPTS = 5;
const SETTLE_POLL_MS = 25;

/**
 * How `plugins/claude-tty/server/dialog-cards.ts` tells this card from every other permission: a key in
 * the input that only this writes. Mirrored there as a string, because the plugin runs in the daemon and
 * cannot import this. It is the input rather than the tool's name because the version of ACP this SDK
 * speaks has no field for a name -- `ToolCallUpdate` carries a title and nothing else that travels --
 * and the title here is the question, which is what a person should be reading.
 */
export const DIALOG_INPUT_MARKER = "claudeDialog";

export const DISMISS_OPTION_ID = "dialog-dismiss";
export const CHOICE_OPTION_PREFIX = "dialog-choice-";

/** The keys answering a dialog is made of. */
export type DialogKey = "up" | "down" | "enter";

export type DialogWatcherOptions = {
  sessionId: string;
  connection: AgentSideConnection;
  interactions: InteractionBridge;
  /** What Claude's own state file says has the keyboard, or null when nothing has. */
  waitingFor: () => Promise<string | null>;
  /** The screen as text, for the log and for the startup dialogs, which are matched on their words. */
  screen: () => string;
  /** The same screen with what colour says about each line, which is half of reading a dialog. */
  lines: () => readonly ScreenLine[];
  /** The key that closes a dialog, straight into the PTY. */
  escape: () => void;
  press: (key: DialogKey) => void;
  /**
   * Whether the screen is showing one of the dialogs the adapter answers itself -- workspace trust,
   * the bypass disclaimer, the resume question. Those are answered on the startup path and must not
   * be carded on the way past.
   */
  answeredByStartup: (screen: string) => boolean;
  pollIntervalMs?: number;
  answerKeyMs?: number;
  answerTimeoutMs?: number;
  settleMs?: number;
};

type PendingCard = {
  id: string;
  dialog: DialogReading;
  /** The stretch of waiting this card was raised in; an answer that outlives it answers nothing. */
  episode: number;
  withdraw: () => void;
};

/**
 * Claude's own dialogs, as cards in Paseo.
 *
 * Claude asks a session two kinds of question. The ones it asks through a hook -- a permission, an
 * `AskUserQuestion`, a plan -- `interactions.ts` already answers, and they are not this. The rest it
 * draws in its terminal and waits on: the nudges (a plugin it suggests, an LSP it noticed, an effort
 * level it would rather use), the setup questions, the callouts. Nothing reaches the PTY from outside
 * this process, so before this those could only ever be escaped away -- and until they were, every
 * prompt sent to that session failed, because the keys that would have sent it would have answered the
 * question instead.
 *
 * So the state file is polled for as long as the session's process is up, and a dialog that is not one
 * of the adapter's own becomes a card with a button per row and Dismiss. Every one of them is a
 * declining option: Paseo's automatic permission modes accept an allow option without showing anybody
 * anything, and a question Claude is holding the keyboard for is exactly the thing that must not be
 * answered by a machine. Answering moves the marker and presses Enter, the way the startup dialogs are
 * answered, and then reads Claude's state back to see that the question really did go.
 *
 * Every transition into a dialog is logged with the screen it was on, because what Claude actually puts
 * up here is a list that grows, and the log is how the next dialog gets parsed properly.
 */
export class DialogWatcher {
  private readonly options: DialogWatcherOptions;
  private readonly pollIntervalMs: number;
  private readonly answerKeyMs: number;
  private readonly answerTimeoutMs: number;
  private readonly settleMs: number;
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private pending: PendingCard | null = null;
  /** This waiting episode has had its card; a dialog is asked about once rather than once per poll. */
  private carded = false;
  /** The last dialog seen on screen, which is what the notice for a dismissed one is written from. */
  private lastSeen: DialogReading | null = null;
  /**
   * The dialog whose card has just been answered. Answering one of these opens another often enough to
   * be ordinary -- `/rewind` asks which checkpoint and then asks what to restore -- so the next one gets
   * a card of its own; what must not happen is asking again about the one that was already answered.
   */
  private answered: DialogReading | null = null;
  /** How many polls this wait has been up for without the screen showing anything to ask about. */
  private unreadable = 0;
  /**
   * Which stretch of waiting this is. Claude holds the keyboard from the moment it opens a question
   * until whatever it opens is finally answered -- through a `/rewind` that asks twice, and through its
   * own redrawing -- and every poll that finds it no longer waiting starts the next stretch. That is
   * what says a card is still answerable: not the words on the screen, which tick and rewrite
   * themselves while the card is up.
   */
  private episode = 1;

  constructor(options: DialogWatcherOptions) {
    this.options = options;
    this.pollIntervalMs = options.pollIntervalMs ?? DIALOG_POLL_MS;
    this.answerKeyMs = options.answerKeyMs ?? DIALOG_ANSWER_KEY_MS;
    this.answerTimeoutMs = options.answerTimeoutMs ?? DIALOG_ANSWER_TIMEOUT_MS;
    this.settleMs = options.settleMs ?? DIALOG_SETTLE_MS;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.pollIntervalMs);
    this.timer.unref();
  }

  /** Stops watching and takes down whatever card is up: the process behind it is going or gone. */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.carded = false;
    this.lastSeen = null;
    // The process this was watching is going, so nothing raised under it can be answered any more.
    this.episode += 1;
    const pending = this.pending;
    this.pending = null;
    pending?.withdraw();
    if (pending) void this.withdrawCard(pending.id, "the session stopped");
  }

  /**
   * The prompt path got the keyboard back by closing a question. The card for it is taken down, and the
   * timeline says which question was closed to deliver the message -- otherwise the answer Claude was
   * waiting for simply disappears, and the session looks like it lost a nudge for no reason.
   */
  async dismissedForPrompt(waitingFor: string): Promise<void> {
    const dialog = this.pending?.dialog ?? this.lastSeen;
    await this.withdraw("a prompt arrived and the question was closed to deliver it");
    this.carded = false;
    this.lastSeen = null;
    await sendNotice(this.options.connection, this.options.sessionId, {
      id: `dialog-dismissed-${randomUUID()}`,
      severity: "warning",
      title: dialog ? `Dismissed Claude's question: ${dialogTitle(dialog)}` : `Dismissed what Claude had open (${waitingFor})`,
      description: [
        "Your message needed the keyboard, and Claude was holding it for a question of its own, so the question was closed unanswered.",
        dialog?.text,
      ]
        .filter((part): part is string => typeof part === "string" && part !== "")
        .join("\n\n"),
    });
  }

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const waitingFor = await this.options.waitingFor();
      if (waitingFor === null) {
        // Claude has the keyboard back, so this stretch of waiting is over and the next question --
        // even an identical one -- is a new one.
        if (this.carded || this.pending) this.episode += 1;
        this.carded = false;
        this.lastSeen = null;
        this.unreadable = 0;
        // The question that was answered is forgotten once it is off the screen, rather than the moment
        // Claude stops waiting: answering one of these opens the next, and Claude writes the state file
        // ahead of the redraw, so for a poll or two the answered dialog is still what is drawn.
        if (this.answered && !sameDialog(readDialog(this.options.lines()), this.answered)) this.answered = null;
        if (this.pending) await this.withdraw("Claude closed the question itself");
        return;
      }
      if (this.pending || this.carded) return;
      // A hook is what Claude is waiting on, and the card for it is already up: `interactions.ts` owns
      // that answer, and a second card for the same wait would be answering over it.
      if (this.options.interactions.pending) return;
      if (this.options.answeredByStartup(this.options.screen())) return;
      const dialog = readDialog(this.options.lines());
      if (!dialog) return;
      if (!dialogIsReadable(dialog)) {
        // The screen is still the one from before the dialog. A poll or two later it is not, and a wait
        // whose screen never says anything is carded anyway, on the text it does have.
        this.unreadable += 1;
        if (this.unreadable < DIALOG_READ_ATTEMPTS) return;
      }
      // The one just answered, still up: either the answer did not take or Claude has not moved on yet.
      // Either way it is not a new question, and asking about it again is how a loop would start.
      if (sameDialog(dialog, this.answered)) return;
      this.lastSeen = dialog;
      void this.raise(waitingFor, dialog).catch((error) => {
        // Asking is the only thing here that reaches outside this process, and a client that cannot be
        // asked is not a reason to go on asking every poll. The question stays up and the submit path
        // still closes it the next time somebody prompts this session.
        this.pending = null;
        this.carded = true;
        writeLog({ level: "warn", message: "Could not ask Paseo about a question Claude has open", sessionId: this.options.sessionId, error: errorMessage(error) });
      });
    } catch (error) {
      writeLog({ level: "debug", message: "Could not read Claude's dialog state", sessionId: this.options.sessionId, error: errorMessage(error) });
    } finally {
      this.ticking = false;
    }
  }

  private async raise(waitingFor: string, dialog: DialogReading): Promise<void> {
    const id = `dialog-${randomUUID()}`;
    const request = this.options.interactions.openRequest({
      toolCall: {
        toolCallId: id,
        title: dialogTitle(dialog),
        kind: "other",
        status: "pending",
        rawInput: {
          [DIALOG_INPUT_MARKER]: true,
          waitingFor,
          question: dialog.question,
          choices: dialog.choices.map((choice) => (choice.detail === "" ? choice.label : `${choice.label} — ${choice.detail}`)),
          // The rows are what the window shows, and Claude said there are more of them.
          scrolls: dialog.scrolls,
          // The dialog as drawn, so a card built from a reading that found no rows can still be read.
          terminal: dialog.text,
        },
      },
      options: dialogOptions(dialog),
    });
    this.pending = { id, dialog, episode: this.episode, withdraw: request.withdraw };
    this.carded = true;
    writeLog({
      level: "info",
      message: "Claude opened a question of its own, and Paseo was asked",
      sessionId: this.options.sessionId,
      waitingFor,
      title: dialog.title,
      question: dialog.question,
      choices: dialog.choices.map((choice) => choice.label),
      scrolls: dialog.scrolls,
      // The whole screen rather than the part that was parsed, because the point of this line is the
      // dialogs nobody has parsed yet: what a reading missed is never inside what it read.
      screen: this.options.screen(),
    });
    const response = await request.response;
    if (this.pending?.id !== id) return;
    const episode = this.pending.episode;
    this.pending = null;
    if (response.outcome.outcome === "cancelled") {
      // Not this class's doing -- a turn ended, or a prompt started, and `cancelPending` let go of every
      // card this side was waiting on. Paseo is still showing it, and nothing else will ever end it, so
      // it is taken down there too; the next tick asks again while the question is still up.
      //
      // Left standing it is worse than a card nobody can answer. The daemon drops its own record of the
      // pending cards when it interrupts a turn -- `resolvePendingPermissionsForAgent`, which tells the
      // provider nothing -- and rebuilds that record from the provider's own list the next time anybody
      // answers anything. A card the provider still holds then comes back from the dead, on top of
      // whatever is on screen at the time.
      this.carded = false;
      await this.withdrawCard(id, "the session let go of every card it was waiting on");
      return;
    }
    await this.answer(dialog, episode, response.outcome.optionId);
  }

  private async answer(dialog: DialogReading, episode: number, optionId: string): Promise<void> {
    if (optionId === DISMISS_OPTION_ID) {
      await this.escape("dismissed in Paseo");
      return;
    }
    const choice = dialog.choices[Number(optionId.slice(CHOICE_OPTION_PREFIX.length))];
    if (!choice) {
      await this.escape(`answered in Paseo with an option this session has no row for (${optionId})`);
      return;
    }
    let outcome: "confirmed" | "gone" | "stuck";
    try {
      outcome = await this.moveTo(dialog, episode, choice.label);
    } catch (error) {
      writeLog({ level: "warn", message: "Claude stopped before its question could be answered", sessionId: this.options.sessionId, choice: choice.label, error: errorMessage(error) });
      return;
    }
    if (outcome === "gone") {
      // Nothing is pressed into whatever is there instead: an answer to a question that has moved on is
      // a no-op, and what it was answering against goes in the log, because this is the one outcome
      // here that cannot be read off the screen afterwards.
      const now = readDialog(this.options.lines());
      const ended = this.episode !== episode;
      writeLog({
        level: "warn",
        message: ended
          ? "Claude's question was answered after it had stopped waiting for one"
          : "Claude's question was answered after another took the screen",
        sessionId: this.options.sessionId,
        choice: choice.label,
        carded: { title: dialog.title, question: dialog.question, choices: dialog.choices.map((entry) => entry.label) },
        onScreen: now === null ? null : { title: now.title, question: now.question, choices: now.choices.map((entry) => entry.label) },
        screen: this.options.screen(),
      });
      return;
    }
    if (outcome === "stuck") {
      // The marker would not go to the row, so the choice cannot be made. Closing the question is worth
      // more than pressing keys into it: an unanswered question blocks every prompt to this session.
      await this.escape(`could not be moved to "${choice.label}"`);
      return;
    }
    // Answered, so whatever is on screen next is a new question rather than this one asked twice.
    this.answered = dialog;
    this.carded = false;
    const settled = await this.settled();
    // Claude still waiting is not a failure on its own: answering one of its dialogs routinely opens the
    // next one, and the next poll raises a card for that. It is only worth the screen when what is up is
    // the same dialog, which says the answer did not land.
    const stillThere = !settled && sameDialog(readDialog(this.options.lines()), dialog);
    writeLog({
      level: stillThere ? "warn" : "info",
      message: stillThere
        ? "Answered a question Claude had open, and Claude went on waiting on the same one"
        : settled
          ? "Answered a question Claude had open"
          : "Answered a question Claude had open, and Claude opened another",
      sessionId: this.options.sessionId,
      choice: choice.label,
      ...(stillThere ? { screen: this.options.screen() } : {}),
    });
  }

  /**
   * Puts Claude's own marker on the row and presses Enter.
   *
   * Which key to press is read off the screen rather than guessed at: the marker is somewhere in the
   * list and the row is somewhere in the list, so the direction is whichever way closes the gap. The
   * startup menus are answered by pressing Down until the marker comes round, and that cannot answer
   * one of these -- measured on Claude Code v2.1.269, `/rewind` opens with the marker on its last row
   * and Down there does nothing at all, because the list does not wrap. Pressing towards the row works
   * whether it wraps or not, and a list that ignores the keys times out and is escaped instead.
   *
   * A list longer than its window needs one more thing. The rows on screen when the card is answered
   * are not always the rows that were on screen when it went up -- `/rewind` scrolls, and a minute of
   * a session moves it -- so a row that is nowhere in the window is looked for rather than given up on:
   * the marker is walked one way, which is what scrolls the list, until the row is drawn again or the
   * end of the list is reached, and then the other way. Only a row neither end turns up is escaped.
   *
   * What says the card is still answerable is the stretch of waiting it was raised in, and the title.
   * Not the words: Claude rewrites its own dialog while it is up -- a relative timestamp ticks, the
   * description follows the marker, the marked row grows what it can do inline -- and a reading taken a
   * minute later agrees with the carded one about almost none of it. Requiring the words was dropping
   * answers to questions nobody had closed. The card's own id carries the rest of the safety: it is one
   * ACP request, answered once, and a question that ended and came back is a new episode and a new card.
   */
  private async moveTo(dialog: DialogReading, episode: number, label: string): Promise<"confirmed" | "gone" | "stuck"> {
    const deadline = Date.now() + this.answerTimeoutMs;
    let searching: "up" | "down" = "up";
    let turned = 0;
    let previous = "";
    while (Date.now() < deadline) {
      const now = readDialog(this.options.lines());
      if (this.episode !== episode || !now || now.title !== dialog.title) return "gone";
      const target = findChoice(now.choices, label);
      const selected = now.choices.findIndex((choice) => choice.selected);
      if (selected < 0) return "stuck";
      if (target === selected) {
        // The marker moves before the state behind it does, so the row is read once more on the way out.
        await delay(this.answerKeyMs);
        if (!choiceSelected(this.options.lines(), label)) continue;
        this.options.press("enter");
        return "confirmed";
      }
      const window = windowOf(now);
      if (target < 0 && window === previous) {
        // The keys have stopped moving anything, so this end of the list has been reached. The row is
        // the other way, or it is not there at all.
        if (turned > 0) return "stuck";
        turned += 1;
        searching = searching === "up" ? "down" : "up";
      }
      previous = window;
      this.options.press(target < 0 ? searching : selected > target ? "up" : "down");
      await delay(this.answerKeyMs);
    }
    return "stuck";
  }

  private async escape(reason: string): Promise<void> {
    this.options.escape();
    const settled = await this.settled();
    writeLog({
      level: settled ? "info" : "warn",
      message: settled ? "Closed a question Claude had open" : "Could not close a question Claude had open",
      sessionId: this.options.sessionId,
      reason,
      ...(settled ? {} : { screen: this.options.screen() }),
    });
  }

  /** Whether Claude has stopped saying something has the keyboard, which is the only proof either way. */
  private async settled(): Promise<boolean> {
    const deadline = Date.now() + this.settleMs;
    do {
      if ((await this.options.waitingFor()) === null) return true;
      await delay(SETTLE_POLL_MS);
    } while (Date.now() < deadline);
    return false;
  }

  private async withdraw(reason: string): Promise<void> {
    const pending = this.pending;
    this.pending = null;
    if (!pending) return;
    pending.withdraw();
    await this.withdrawCard(pending.id, reason);
  }

  /** Says a card is over, whether this side was still waiting on it or had already been let go of. */
  private async withdrawCard(id: string, reason: string): Promise<void> {
    writeLog({ level: "info", message: "Took back the card for a question Claude was asking", sessionId: this.options.sessionId, reason, card: id });
    await sendCardWithdrawn(this.options.connection, this.options.sessionId, id);
  }
}

/**
 * One option per row Claude drew, and Dismiss whatever the reading found. They are all declining
 * options: Paseo's automatic modes accept an allow option without showing anybody a card, and this is
 * the one card that must never be answered by a machine -- some of these questions are about what
 * Claude may read, and the answer outlives the session that was asked.
 *
 * Dismiss goes first, because an answer that carries no action id -- `paseo permit deny`, a client with
 * a single button -- takes the first option of its behaviour, and here that is any of them.
 */
export function dialogOptions(dialog: DialogReading): PermissionOption[] {
  return [
    { optionId: DISMISS_OPTION_ID, name: "Dismiss (Esc)", kind: "reject_once" },
    // The index is the row's in the reading rather than in this list, because it is what answering looks
    // the row up by; a row with nothing on it is no button at all and is left out.
    ...dialog.choices
      .map((choice, index) => ({
        optionId: `${CHOICE_OPTION_PREFIX}${index}`,
        name: choice.label,
        kind: "reject_once" as const,
      }))
      .filter((option) => option.name !== ""),
  ];
}

/** What the window is showing, as one string: the rows in it and which of them the marker is on. */
function windowOf(dialog: DialogReading): string {
  return dialog.choices.map((choice) => `${choice.selected ? ">" : " "}${choice.label}`).join("\n");
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

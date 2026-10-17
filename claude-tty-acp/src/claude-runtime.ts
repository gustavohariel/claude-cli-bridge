import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentSideConnection, ContentBlock, PromptResponse } from "@agentclientprotocol/sdk";
import * as nodePty from "node-pty";
import { discoverCommands } from "./commands.ts";
import { type ContextWindow, contextWindow, formatTokens } from "./context-window.ts";
import { createDeferred, type Deferred } from "./deferred.ts";
import { DialogWatcher } from "./dialog-cards.ts";
import { type HookPayload, type HookRegistration, type HookResponse, HookServer } from "./hook-server.ts";
import { InteractionBridge } from "./interactions.ts";
import { writeLog } from "./log.ts";
import { cleanupPromptFiles, inputBoxPaste, materializePrompt, promptPastes } from "./prompt-content.ts";
import { markRuntimeDirectory, runtimePrefix } from "./runtime-directories.ts";
import { INHERIT_EFFORT_ID, INHERIT_MODEL_ID } from "./session-options.ts";
import { claudeIsWaitingFor } from "./session-status.ts";
import { TERMINAL_COLS, TERMINAL_ROWS, TerminalScreen } from "./terminal-screen.ts";
import { sendCardWithdrawn, sendModelChanged, sendNotice } from "./vendor-updates.ts";
import { SubagentWatcher } from "./subagent-watcher.ts";
import { TranscriptReader } from "./transcript-reader.ts";
import { type ModelFallback, TranscriptTranslator } from "./transcript-translator.ts";
import { TranscriptWatcher } from "./transcript-watcher.ts";

const STARTUP_TIMEOUT_MS = 15_000;
// Paseo replaces a prompt sent mid-turn by cancelling the running turn and waiting 2s for session/prompt to answer, then starts the replacement anyway and fails it when the old turn is still open.
// This fallback plus the transcript flush behind it has to settle well inside that budget.
const CANCEL_TIMEOUT_MS = 600;
const SUBMIT_DELAY_MS = 150;
/**
 * How long every subagent a turn launched may go without writing anything before the turn stops
 * waiting for them. Paseo reads a session as busy from the turn it has open, so an agent that never
 * reports would otherwise leave the session busy — and unsuspendable — for the rest of its life.
 */
const SUBAGENT_SILENCE_MS = 15 * 60_000;
/**
 * How long a held turn goes on after the last thing Claude wrote, whatever it is still waiting on, since a report wakes Claude for an answer that belongs inside the turn.
 * Claude writes a response to its transcript only once the whole of it has streamed, so a text followed by a long tool call — the prompt of the next agent it dispatches, say — shows nothing for as long as that call takes to generate, and a minute was not enough to cover one.
 */
const SUBAGENT_WAKE_MS = 5 * 60_000;
/**
 * How long a turn waits on a background command that has not reported.
 * The adapter does not follow the file a command writes its output to, so a running one shows nothing to measure a silence against: this is a flat bound from the moment the turn was held, started again whenever a command is launched or reports.
 * Thirty minutes because backgrounding is what Claude does with a command precisely when it takes a while, and the ones that run for longer than that are servers and poll loops, which never report at all and are exactly what the bound is here to let go of.
 */
const BACKGROUND_SHELL_MS = 30 * 60_000;
const SUBAGENT_POLL_MS = 5_000;
// Claude drops the submit key while it is still settling a paste, so the prompt is re-submitted until its input box lets go of it.
const SUBMIT_ATTEMPTS = 6;
const SUBMIT_CONFIRM_MS = 400;
const PASTE_ECHO_MS = 300;
// How long a paste that missed the window above is still waited for before the prompt is called undelivered.
// Claude reads a bracketed paste immediately and echoes it a render later, and on a loaded host that render
// is the thing that slips: the echo is what says the input box is holding the prompt, and a submit key sent
// before it lands leaves that prompt sitting there unsent, with no hook to end the turn waiting on it.
const LATE_PASTE_MS = 2_000;
const PROMPT_ECHO_CHARS = 40;
// How long Claude is given to read one batch of a prompt before the next is written: see `PASTE_WRITE_BYTES` in prompt-content.ts.
const PASTE_WRITE_GAP_MS = 10;
// Claude drops the submit key while it is still taking a prompt in, and one that takes several writes keeps it busy a while: 1,500 lines took one to two seconds on Claude Code v2.1.295.
// A still screen does not say it is done, because it stops painting while it works through a large input, so such a prompt is submitted only once its own end is on the screen, which the box scrolls to as it fills, and the screen has then been still this long.
// The bound is for an end that never reads back, as a line of wide characters the terminal draws differently from Claude can make it.
const PASTE_SETTLE_MS = 150;
const PASTE_SETTLE_LIMIT_MS = 10_000;
// How much of a prompt's end has to be on the screen, as `screenText` reads it: enough that a short line the prompt repeats does not pass for its end.
const PROMPT_END_CHARS = 120;
// How many times the keyboard is asked back off a question Claude has open, and how long each key is given
// to take effect. Bounded rather than patient: a question Escape does not close is one this cannot answer,
// and a prompt that fails saying so is worth more than one that goes on pressing keys into it.
const DIALOG_DISMISS_ATTEMPTS = 3;
const DIALOG_DISMISS_MS = 500;
// Claude keeps its completion menu open while the cursor sits at the end of an @mention or a /command, and the submit key then picks an entry instead of sending the prompt.
// A trailing space closes the menu, so every paste ends with one.
const COMPLETION_DISMISS = " ";
// Claude appends a bracketed paste to whatever its input box already holds rather than replacing it, so a
// prompt pasted into a box with something left in it reaches Claude as the two run together. Ctrl-U is what
// empties it, and costs nothing on the empty box that is the ordinary case.
const CLEAR_INPUT_LINE = "\u0015";
// Ctrl-U kills the line the cursor is on, and that is one *visual* line: Claude word-wraps a prompt too long
// for the width, and a single key then takes the last of those lines and leaves the rest sitting there. So a
// box is emptied by one key per line it has grown to, and since it is drawn on the screen it can never have
// grown past the height of it, which is the bound below.
//
// They have to arrive as keys, which means one key per write with a gap behind it. A screenful written in one
// go reaches Claude as *text*: the 40 control characters land in the input box as 40 literal U+0015 and go to
// Claude with the prompt, which is a clear that prepends garbage rather than clearing anything. Measured on
// Claude Code v2.1.269 and visible in its own transcripts -- around 60 prompts since 2026-09-13 begin with
// exactly forty U+0015, which `jq 'select(.type=="user") | .message.content | explode | index(21)'` reads out
// of `~/.claude/projects/*/*.jsonl`.
const CLEAR_INPUT_KEY_MS = 25;
// How many readings of an empty box end the clear. The screen is sampled rather than followed, so a single
// empty reading can be a render that has not caught up with a paste; a few in a row, a key apart, are the
// cheapest evidence there is that the box really is empty. A box the screen never shows empty -- a terminal
// nothing has painted, a reading that keeps coming back full -- takes the whole screenful and stops there.
const CLEAR_INPUT_CONFIRMATIONS = 3;
// How many keys a box that stops changing is given before the run ends.
//
// Not everything in Claude's input box is in Claude's input box. It offers a prompt of its own in an
// empty one -- grey ghost text, which reads exactly like typed text on a screen scraped for its
// characters -- and Ctrl-U does not remove it, because there is nothing there to remove. Without this
// every prompt sent to a session that was showing one paid the whole screenful, a second of keys, and
// then logged a box it had failed to empty. A key that changes nothing on the screen below the box did
// nothing, and a few of those in a row is the end of what this can do, whatever the reason.
const CLEAR_INPUT_UNCHANGED = 4;
const ESCAPE = "\u001b";
const CARRIAGE_RETURN = "\r";
const CONTROL_D = "\u0004";
const CURSOR_DOWN = "\u001b[B";
const CURSOR_UP = "\u001b[A";
const ENTER = "\r";
const STARTUP_POLL_INTERVAL_MS = 25;
// Claude re-renders its status line after the Stop hook rather than before it, measured at ~320ms, so the reading for the turn that just ended only lands once the file changes again.
const CONTEXT_REFRESH_TIMEOUT_MS = 1_000;
const CONTEXT_REFRESH_POLL_MS = 25;
// A session whose status line never writes would otherwise wait the whole budget on every turn for a reading that is not coming.
// After this many turns without one it stops waiting and only looks, which costs a stat.
const CONTEXT_WAIT_MISS_LIMIT = 3;
// Looking alone cannot find a reading Claude writes after the Stop hook, so one turn in this many waits properly.
// Without that a session which starts reporting again would never be noticed, because every look lands before the write it is looking for.
const CONTEXT_WAIT_RETRY_TURNS = 4;
const WORKSPACE_TRUST_KEY_DELAY_MS = 500;
const WORKSPACE_TRUST_SELECTION_TIMEOUT_MS = 3_000;
// Claude puts its bypass permissions disclaimer up the same way it puts the trust screen up, and it settles no faster.
const BYPASS_PERMISSIONS_KEY_DELAY_MS = 500;
const BYPASS_PERMISSIONS_SELECTION_TIMEOUT_MS = 3_000;
// Claude puts its external-imports question up the same way, and it settles no faster than the other two.
const EXTERNAL_IMPORTS_KEY_DELAY_MS = 500;
const EXTERNAL_IMPORTS_SELECTION_TIMEOUT_MS = 3_000;
// Claude asks how to resume a long or old conversation before it opens one, and answers that dialog the same way it answers the trust screen.
const STALE_RESUME_KEY_DELAY_MS = 200;
const STALE_RESUME_SELECTION_TIMEOUT_MS = 3_000;
// A resumed session paints its whole conversation before its input box exists, and text inside that conversation can satisfy every readiness signal on its own.
// Readiness therefore also requires Claude to have stopped painting, because a paste sent mid-restore is dropped without an echo to notice it by.
const READY_QUIET_MS = 400;
/**
 * How long a card that only tells somebody something stays up when nobody answers it.
 *
 * Nothing waits for one -- Claude has already done whatever the card is about -- so its whole purpose
 * is the push a new permission request sends. Left up forever it would keep the session unsuspendable,
 * since a session with a card open is one somebody may still be answering.
 */
const ACKNOWLEDGEMENT_MS = 10 * 60_000;

/** One of the menus Claude opens on its way up, as the adapter has to answer it. */
type StartupMenu = {
  /** Still asking, which is the only reason to go on answering it. */
  onScreen: (screen: string) => boolean;
  /** The marker is on the option to take, so the next key is the one that confirms it. */
  selected: (screen: string) => boolean;
  keyDelayMs: number;
  timeoutMs: number;
  /** What to throw when Claude exits mid-answer. */
  exited: string;
};

type PtyProcess = Pick<nodePty.IPty, "pid" | "write" | "kill" | "onData" | "onExit">;
type SpawnPty = (file: string, args: string[], options: nodePty.IPtyForkOptions) => PtyProcess;

export type RuntimeDependencies = {
  spawnPty?: SpawnPty;
  startupTimeoutMs?: number;
  readinessTimeoutMs?: number;
  cancelTimeoutMs?: number;
  contextRefreshTimeoutMs?: number;
  submitDelayMs?: number;
  pasteEchoMs?: number;
  submitConfirmMs?: number;
  latePasteMs?: number;
  pasteSettleMs?: number;
  dialogDismissMs?: number;
  clearInputKeyMs?: number;
  dialogPollMs?: number;
  dialogAnswerKeyMs?: number;
  dialogAnswerTimeoutMs?: number;
  dialogSettleMs?: number;
  transcriptPollIntervalMs?: number;
  transcriptFlushIntervalMs?: number;
  workspaceTrustKeyDelayMs?: number;
  workspaceTrustSelectionTimeoutMs?: number;
  bypassPermissionsKeyDelayMs?: number;
  bypassPermissionsSelectionTimeoutMs?: number;
  externalImportsKeyDelayMs?: number;
  externalImportsSelectionTimeoutMs?: number;
  staleResumeKeyDelayMs?: number;
  staleResumeSelectionTimeoutMs?: number;
  readyQuietMs?: number;
  subagentPollMs?: number;
  subagentSilenceMs?: number;
  subagentWakeMs?: number;
  backgroundShellMs?: number;
  runtimeRoot?: string;
  claudeConfigDir?: string;
  transcriptFilePath?: string;
  stateDirectory?: string;
  translator?: TranscriptTranslator;
  resume?: boolean;
  model?: string;
  mode?: string;
  effort?: string;
  /** Whether a permission request is answered without a card, asked at each request. */
  autoAccept?: () => Promise<boolean>;
  onClaudeSessionChange?: (claudeSessionId: string) => Promise<void>;
};

type TurnResult = {
  response: PromptResponse;
  assistantMessage?: string;
};

export class ClaudeRuntime {
  readonly sessionId: string;
  readonly cwd: string;
  private currentClaudeSessionId: string;
  private readonly spawnPty: SpawnPty;
  private readonly startupTimeoutMs: number;
  private readonly readinessTimeoutMs: number;
  private readonly cancelTimeoutMs: number;
  private readonly contextRefreshTimeoutMs: number;
  private readonly submitDelayMs: number;
  private readonly pasteEchoMs: number;
  private readonly submitConfirmMs: number;
  private readonly latePasteMs: number;
  private readonly pasteSettleMs: number;
  private readonly dialogDismissMs: number;
  private readonly clearInputKeyMs: number;
  private readonly transcriptPollIntervalMs: number | undefined;
  private readonly transcriptFlushIntervalMs: number | undefined;
  private readonly workspaceTrustKeyDelayMs: number;
  private readonly workspaceTrustSelectionTimeoutMs: number;
  private readonly bypassPermissionsKeyDelayMs: number;
  private readonly bypassPermissionsSelectionTimeoutMs: number;
  private readonly externalImportsKeyDelayMs: number;
  private readonly externalImportsSelectionTimeoutMs: number;
  private readonly staleResumeKeyDelayMs: number;
  private readonly staleResumeSelectionTimeoutMs: number;
  private readonly readyQuietMs: number;
  private readonly subagentPollMs: number;
  private readonly subagentSilenceMs: number;
  private readonly subagentWakeMs: number;
  private readonly backgroundShellMs: number;
  private readonly runtimeRoot: string;
  private readonly connection: AgentSideConnection;
  private readonly hooks: HookServer;
  private readonly claudeConfigDir: string | undefined;
  /** The transcript the watcher is reading now, so a SessionStart naming that same file leaves it, and its offset, alone. */
  private transcriptFilePath!: string;
  private resumeNextLaunch: boolean;
  private model: string;
  private mode: string;
  private effort: string;
  private readonly onClaudeSessionChange: ((claudeSessionId: string) => Promise<void>) | undefined;
  private readonly interactions: InteractionBridge;
  /** Claude's own questions, as cards; it watches only while the process it is about is up. */
  private readonly dialogs: DialogWatcher;
  private readonly translator: TranscriptTranslator;
  private transcript: TranscriptWatcher;
  private readonly screen = new TerminalScreen();
  private pty: PtyProcess | null = null;
  private runtimeDirectory: string | null = null;
  private hookRegistration: HookRegistration | null = null;
  private ready: Deferred<void> | null = null;
  private trustPrompt: Deferred<void> | null = null;
  private turn: Deferred<TurnResult> | null = null;
  private turnIsCompact = false;
  private cancelTimer: NodeJS.Timeout | null = null;
  private cancelRequested = false;
  private assistantBaseline = 0;
  private closed = false;
  private contextFilePath: string | null = null;
  private contextMtimeAtTurnEnd = 0;
  private contextWaitCancelled = false;
  private contextWaitMisses = 0;
  private staleResumeAnswered = false;
  private backgroundHold: NodeJS.Timeout | null = null;
  private heldAssistantMessage: string | undefined;
  private heldAt = 0;
  /** Cards that say something happened and wait for nobody: a prompt or a timeout takes one down. */
  private readonly acknowledgements = new Map<string, () => void>();
  /** When Claude last called a hook, which it does only while it is doing something. */
  private lastHookAt = 0;
  private intentionalExit: Deferred<void> | null = null;

  constructor(
    sessionId: string,
    claudeSessionId: string,
    cwd: string,
    connection: AgentSideConnection,
    hooks: HookServer,
    dependencies: RuntimeDependencies = {},
  ) {
    this.sessionId = sessionId;
    this.currentClaudeSessionId = claudeSessionId;
    this.cwd = cwd;
    this.connection = connection;
    this.hooks = hooks;
    this.claudeConfigDir = dependencies.claudeConfigDir;
    this.resumeNextLaunch = dependencies.resume === true;
    this.model = dependencies.model ?? INHERIT_MODEL_ID;
    this.mode = dependencies.mode ?? "default";
    this.effort = dependencies.effort ?? INHERIT_EFFORT_ID;
    this.onClaudeSessionChange = dependencies.onClaudeSessionChange;
    this.interactions = new InteractionBridge(sessionId, cwd, connection, dependencies.autoAccept);
    this.dialogs = new DialogWatcher({
      sessionId,
      connection,
      interactions: this.interactions,
      waitingFor: () => claudeIsWaitingFor(this.pty?.pid, this.claudeConfigDir),
      screen: () => this.screen.snapshot(),
      lines: () => this.screen.lines(),
      escape: () => this.pty?.write(ESCAPE),
      press: (key) => this.pty?.write(key === "up" ? CURSOR_UP : key === "down" ? CURSOR_DOWN : ENTER),
      answeredByStartup: (screen) =>
        isWorkspaceTrustScreen(screen) || isBypassPermissionsScreen(screen) || isExternalImportsScreen(screen) || isStaleResumeScreen(screen),
      ...(dependencies.dialogPollMs === undefined ? {} : { pollIntervalMs: dependencies.dialogPollMs }),
      ...(dependencies.dialogAnswerKeyMs === undefined ? {} : { answerKeyMs: dependencies.dialogAnswerKeyMs }),
      ...(dependencies.dialogAnswerTimeoutMs === undefined ? {} : { answerTimeoutMs: dependencies.dialogAnswerTimeoutMs }),
      ...(dependencies.dialogSettleMs === undefined ? {} : { settleMs: dependencies.dialogSettleMs }),
    });
    this.spawnPty = dependencies.spawnPty ?? nodePty.spawn;
    this.startupTimeoutMs = dependencies.startupTimeoutMs ?? STARTUP_TIMEOUT_MS;
    this.readinessTimeoutMs = dependencies.readinessTimeoutMs ?? STARTUP_TIMEOUT_MS;
    this.cancelTimeoutMs = dependencies.cancelTimeoutMs ?? CANCEL_TIMEOUT_MS;
    this.contextRefreshTimeoutMs = dependencies.contextRefreshTimeoutMs ?? CONTEXT_REFRESH_TIMEOUT_MS;
    this.submitDelayMs = dependencies.submitDelayMs ?? SUBMIT_DELAY_MS;
    this.pasteEchoMs = dependencies.pasteEchoMs ?? PASTE_ECHO_MS;
    this.submitConfirmMs = dependencies.submitConfirmMs ?? SUBMIT_CONFIRM_MS;
    this.latePasteMs = dependencies.latePasteMs ?? LATE_PASTE_MS;
    this.pasteSettleMs = dependencies.pasteSettleMs ?? PASTE_SETTLE_MS;
    this.dialogDismissMs = dependencies.dialogDismissMs ?? DIALOG_DISMISS_MS;
    this.clearInputKeyMs = dependencies.clearInputKeyMs ?? CLEAR_INPUT_KEY_MS;
    this.transcriptPollIntervalMs = dependencies.transcriptPollIntervalMs;
    this.transcriptFlushIntervalMs = dependencies.transcriptFlushIntervalMs;
    this.workspaceTrustKeyDelayMs = dependencies.workspaceTrustKeyDelayMs ?? WORKSPACE_TRUST_KEY_DELAY_MS;
    this.workspaceTrustSelectionTimeoutMs = dependencies.workspaceTrustSelectionTimeoutMs ?? WORKSPACE_TRUST_SELECTION_TIMEOUT_MS;
    this.bypassPermissionsKeyDelayMs = dependencies.bypassPermissionsKeyDelayMs ?? BYPASS_PERMISSIONS_KEY_DELAY_MS;
    this.bypassPermissionsSelectionTimeoutMs = dependencies.bypassPermissionsSelectionTimeoutMs ?? BYPASS_PERMISSIONS_SELECTION_TIMEOUT_MS;
    this.externalImportsKeyDelayMs = dependencies.externalImportsKeyDelayMs ?? EXTERNAL_IMPORTS_KEY_DELAY_MS;
    this.externalImportsSelectionTimeoutMs = dependencies.externalImportsSelectionTimeoutMs ?? EXTERNAL_IMPORTS_SELECTION_TIMEOUT_MS;
    this.staleResumeKeyDelayMs = dependencies.staleResumeKeyDelayMs ?? STALE_RESUME_KEY_DELAY_MS;
    this.staleResumeSelectionTimeoutMs = dependencies.staleResumeSelectionTimeoutMs ?? STALE_RESUME_SELECTION_TIMEOUT_MS;
    this.readyQuietMs = dependencies.readyQuietMs ?? READY_QUIET_MS;
    this.subagentPollMs = dependencies.subagentPollMs ?? SUBAGENT_POLL_MS;
    this.subagentSilenceMs = dependencies.subagentSilenceMs ?? SUBAGENT_SILENCE_MS;
    this.subagentWakeMs = dependencies.subagentWakeMs ?? SUBAGENT_WAKE_MS;
    this.backgroundShellMs = dependencies.backgroundShellMs ?? BACKGROUND_SHELL_MS;
    this.runtimeRoot = dependencies.runtimeRoot ?? os.tmpdir();
    this.translator = dependencies.translator ?? new TranscriptTranslator(sessionId, cwd, connection);
    this.transcript = this.createTranscriptWatcher(claudeSessionId, dependencies.transcriptFilePath);
    // Only a runtime reports these, which is the whole of why a replayed session never does: it has one
    // translator and no runtime at all until somebody prompts it.
    this.translator.setModelFallbackHandler((fallback) => void this.reportModelFallback(fallback));
  }

  get started(): boolean {
    return this.pty !== null;
  }

  get turnActive(): boolean {
    return this.turn !== null;
  }

  /** A permission or question card is on screen in Paseo and nobody has answered it yet. */
  get interactionPending(): boolean {
    return this.interactions.pending;
  }

  /**
   * When this session last showed any sign of life, whether or not a prompt was open: a hook Claude
   * called, a record it or one of its agents wrote, or a notification it was woken with. A turn is
   * only what Paseo asked for; Claude goes on working after one — launching agents, answering for
   * them — and that work is what this reports.
   */
  get activityAt(): number {
    return Math.max(this.translator.activityAt, this.lastHookAt);
  }

  async prompt(content: ContentBlock[]): Promise<PromptResponse> {
    if (this.closed) throw new Error(`Session ${this.sessionId} is closed`);
    if (this.turn) throw new Error(`Session ${this.sessionId} already has an active turn`);
    await this.ensureStarted();
    if (!this.runtimeDirectory) throw new Error(`Session ${this.sessionId} has no runtime directory`);
    const prompt = await materializePrompt(content, this.runtimeDirectory, this.cwd);
    const commands = prompt.text.startsWith("/") ? await discoverCommands(this.cwd, this.claudeConfigDir) : [];
    const turn = createDeferred<TurnResult>();
    this.turn = turn;
    this.turnIsCompact = /^\/compact(\s|$)/.test(prompt.text.trim());
    this.cancelRequested = false;
    this.contextWaitCancelled = false;
    this.interactions.beginTurn();
    // `beginTurn` lets go of every card this side is waiting on, and this is what says so to the client
    // for the ones nobody was going to answer. A message is being sent; the acknowledgement it would
    // have interrupted has been read by definition.
    await this.withdrawAcknowledgements();
    this.assistantBaseline = this.translator.assistantChunks;
    this.translator.trackBackgroundWork();
    try {
      await this.submit(promptPastes(prompt.text, commands));
      const result = await turn.promise;
      if (result.assistantMessage) {
        this.translator.suppressNextAssistantText(result.assistantMessage);
        await this.connection.sessionUpdate({
          sessionId: this.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            messageId: randomUUID(),
            content: { type: "text", text: result.assistantMessage },
          },
        });
      }
      await this.emitContextUsage(result.response.stopReason);
      return result.response;
    } catch (error) {
      // A prompt that never reached Claude has no hook coming to end its turn, so the turn is let go of
      // here. Left standing it would hold the session busy for good and refuse every prompt after it.
      if (this.turn === turn) {
        this.turn = null;
        this.interactions.cancelPending();
        writeLog({ level: "error", message: "Failed to put a prompt to Claude", sessionId: this.sessionId, error: errorMessage(error) });
      }
      throw error;
    } finally {
      await cleanupPromptFiles(prompt.files);
    }
  }

  /** Claude takes its model and its effort at launch and offers no way to change either after, so this restarts it on the same conversation. */
  async reconfigure(model: string, mode: string, effort: string): Promise<void> {
    if (this.turn) throw new Error("Cannot change Claude model, mode or effort during an active turn");
    this.model = model;
    this.mode = mode;
    this.effort = effort;
    if (!this.pty) return;
    await this.stopForRestart();
    await this.ensureStarted();
  }

  /** Stop the native process without closing the logical ACP session or its persisted lock. */
  async suspend(): Promise<void> {
    if (this.closed || !this.pty) return;
    if (this.turn) throw new Error("Cannot suspend Claude during an active turn");
    this.interactions.cancelPending();
    await this.stopForRestart();
  }

  cancel(): void {
    // The wait for Claude's last context reading outlives the turn, so this is set before the turn check or a stop during it is dropped.
    this.contextWaitCancelled = true;
    // A card Claude raises on its way up is waiting before there is a turn to cancel, and letting go of the request is the only thing that ends that wait.
    this.interactions.cancelPending();
    const turn = this.turn;
    if (!turn) return;
    this.cancelRequested = true;
    if (this.cancelTimer) clearTimeout(this.cancelTimer);
    // A turn held open only for background work has no foreground to interrupt. Claude answered and went
    // back to its prompt; the turn is this adapter's own bookkeeping, kept so the report that work still
    // owes has something to arrive in. Escape there stops nothing -- a subagent runs in its own loop and
    // outlives it -- and costs the turn before it, which Claude rewinds and puts back in the input box for
    // the next paste to land on. So the hold is simply let go of. Paseo cancels before it replaces a turn
    // and a message sent while a subagent runs arrives as exactly that, which makes this the path every
    // such message takes rather than a corner of one.
    if (this.backgroundHold) {
      this.cancelTimer = null;
      void this.finishCancelled();
      return;
    }
    if (!this.pty) {
      this.cancelTimer = null;
      void this.finishCancelled();
      return;
    }
    this.pty.write(ESCAPE);
    this.cancelTimer = setTimeout(() => void this.finishCancelled(), this.cancelTimeoutMs);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.dialogs.stop();
    this.translator.setModelFallbackHandler(null);
    await this.withdrawAcknowledgements();
    if (this.cancelTimer) clearTimeout(this.cancelTimer);
    this.cancelTimer = null;
    this.ready?.reject(new Error(`Session ${this.sessionId} closed before Claude became ready`));
    this.ready = null;
    this.intentionalExit?.resolve();
    this.intentionalExit = null;
    this.finishTurn({ response: { stopReason: "cancelled" } });
    this.interactions.cancelPending();
    this.hookRegistration?.unregister();
    this.hookRegistration = null;
    const pty = this.pty;
    this.pty = null;
    if (pty) {
      try {
        pty.kill();
      } catch (error) {
        writeLog({ level: "warn", message: "Failed to stop Claude PTY", sessionId: this.sessionId, error: errorMessage(error) });
      }
    }
    await this.transcript.close();
    await this.settleOpenToolCalls();
    this.screen.dispose();
    await this.removeRuntimeDirectory();
  }

  /**
   * Claude changed the model underneath this session, which is a thing that happens to a person rather
   * than something they did: `switchModelsOnFlag` retries a message the model's safeguards flagged on a
   * fallback model and writes a line to the transcript, and that line was all there was.
   *
   * Three things go out for one. A notice, which is Paseo's timeline notification and sends no push, so
   * the session carries the record of what happened whether or not anybody was looking. The model the
   * session's picker shows, where the switch was for the session rather than for one message -- the
   * launch flag is untouched, so a restart puts the model back to the one that was chosen, which is
   * what makes this a reading rather than a decision. And a card with a single OK, purely because a new
   * permission request is what makes Paseo push to a phone, and a model silently swapped mid-run is
   * worth waking somebody for.
   *
   * None of it blocks Claude: nothing is awaited on the transcript's path, and the card waits for an
   * answer nothing needs.
   */
  private async reportModelFallback(fallback: ModelFallback): Promise<void> {
    if (this.closed) return;
    writeLog({ level: "warn", message: "Claude switched the model under this session", sessionId: this.sessionId, subtype: fallback.subtype, title: fallback.title, model: fallback.model });
    await sendNotice(this.connection, this.sessionId, {
      id: fallback.id,
      severity: "warning",
      title: fallback.title,
      description: fallback.description,
    });
    if (fallback.model) await sendModelChanged(this.connection, this.sessionId, fallback.model);
    await this.acknowledge(fallback.id, fallback.title, fallback.description);
  }

  /**
   * A card that tells rather than asks. Its one option is a declining one, like every card whose answer
   * is not a decision, and nothing is done with the answer: the point of it is the push.
   */
  private async acknowledge(id: string, title: string, description: string): Promise<void> {
    const request = this.interactions.openRequest(
      {
        toolCall: {
          toolCallId: id,
          title,
          kind: "other",
          status: "pending",
          rawInput: { notice: description },
        },
        options: [{ optionId: "acknowledge", name: "OK", kind: "reject_once" }],
      },
      // Nothing is held up behind this card, so a session with one open is not a session anybody is
      // waiting for: it goes on suspending on its own schedule, and a question Claude opens afterwards
      // still gets a card of its own rather than being skipped as already asked about.
      { blocking: false },
    );
    this.acknowledgements.set(id, request.withdraw);
    const expiry = setTimeout(() => void this.withdrawAcknowledgement(id), ACKNOWLEDGEMENT_MS);
    expiry.unref();
    const response = await request.response;
    // A card somebody answered is gone from the client by itself. One resolved here without an answer is
    // not: `cancelPending` lets go of every card this side is waiting on at the end of every turn, and
    // saying nothing then would leave this one on screen for good. So it stays on the list, where a
    // prompt or the timeout takes it down on the client too.
    if (response.outcome.outcome === "cancelled" && this.acknowledgements.has(id)) return;
    clearTimeout(expiry);
    this.acknowledgements.delete(id);
  }

  private async withdrawAcknowledgement(id: string): Promise<void> {
    const withdraw = this.acknowledgements.get(id);
    if (!withdraw) return;
    this.acknowledgements.delete(id);
    withdraw();
    await sendCardWithdrawn(this.connection, this.sessionId, id);
  }

  private async withdrawAcknowledgements(): Promise<void> {
    for (const id of [...this.acknowledgements.keys()]) await this.withdrawAcknowledgement(id);
  }

  private async ensureStarted(): Promise<void> {
    if (this.pty) return;
    this.screen.reset();
    this.staleResumeAnswered = false;
    await this.hooks.start();
    this.runtimeDirectory = await mkdtemp(runtimePrefix(this.runtimeRoot));
    await chmod(this.runtimeDirectory, 0o700);
    await markRuntimeDirectory(this.runtimeDirectory);
    this.hookRegistration = this.hooks.register(this.currentClaudeSessionId, (payload) => this.handleHook(payload));
    const hookClientPath = path.join(this.runtimeDirectory, "hook-client.mjs");
    await writeFile(hookClientPath, hookClientSource(this.hookRegistration.endpoint), { mode: 0o600 });
    this.contextFilePath = path.join(this.runtimeDirectory, "context.json");
    const settingsPath = path.join(this.runtimeDirectory, "settings.json");
    const hookCommand = `${shellQuote(process.execPath)} ${shellQuote(hookClientPath)}`;
    await writeFile(settingsPath, `${JSON.stringify(createSettings(hookCommand, this.contextFilePath))}\n`, { mode: 0o600 });
    this.ready = createDeferred<void>();
    this.trustPrompt = createDeferred<void>();
    const claudeBin = process.env.CLAUDE_BIN || "claude";
    const sessionArgs = this.resumeNextLaunch
      ? ["--resume", this.currentClaudeSessionId]
      : ["--session-id", this.currentClaudeSessionId];
    try {
      this.pty = this.spawnPty(claudeBin, [...sessionArgs, ...selectionArgs(this.model, this.mode, this.effort), "--settings", settingsPath], {
        name: "xterm-256color",
        cols: TERMINAL_COLS,
        rows: TERMINAL_ROWS,
        cwd: this.cwd,
        env: process.env,
      });
    } catch (error) {
      await this.failedStartup(`Could not start ${claudeBin}: ${errorMessage(error)}`);
    }
    const started = this.pty;
    // A PTY that has been stopped can still flush its last output, and the screen it would land on now belongs to its replacement.
    started?.onData((data) => {
      if (this.pty !== started) return;
      this.screen.write(data, () => {
        const trustPrompt = this.trustPrompt;
        if (trustPrompt && isWorkspaceTrustScreen(this.screen.snapshot())) trustPrompt.resolve();
      });
    });
    started?.onExit(({ exitCode, signal }) => this.handleExit(started, exitCode, signal));
    try {
      await this.waitForSessionStart();
    } catch (error) {
      await this.failedStartup(errorMessage(error));
    } finally {
      this.ready = null;
      this.trustPrompt = null;
    }
    await this.waitForTerminalReady();
    // Only now: everything above is a dialog the adapter answers itself, and a card for one of those
    // would ask Paseo about a question that is already being answered.
    this.dialogs.start();
    await this.transcript.start();
    this.resumeNextLaunch = true;
    writeLog({ level: "info", message: "Started interactive Claude session", sessionId: this.sessionId, claudePid: this.pty?.pid, cwd: this.cwd });
  }

  private async failedStartup(message: string): Promise<never> {
    this.dialogs.stop();
    // The message carries the terminal snapshot, and it has only ever travelled to Paseo as an error.
    // A handshake that failed is the thing nobody can reconstruct afterwards, so the log keeps it too.
    writeLog({ level: "error", message, sessionId: this.sessionId });
    this.hookRegistration?.unregister();
    this.hookRegistration = null;
    this.ready = null;
    this.trustPrompt = null;
    const pty = this.pty;
    this.pty = null;
    if (pty) {
      try {
        pty.kill();
      } catch {}
    }
    await this.removeRuntimeDirectory();
    throw new Error(message);
  }

  private async handleHook(payload: HookPayload): Promise<HookResponse> {
    this.lastHookAt = Date.now();
    switch (payload.hook_event_name) {
      // Hooks arrive over their own channel, ahead of the transcript the watcher is still polling.
      // Draining first keeps the prompt from landing before the assistant text that explains it.
      case "PreToolUse":
        await this.transcript.flushUntilStable();
        return this.interactions.handlePreToolUse(payload);
      case "PermissionRequest":
        await this.transcript.flushUntilStable();
        return this.interactions.handlePermissionRequest(payload);
      case "SessionStart":
        await this.handleSessionStart(payload);
        this.ready?.resolve();
        break;
      case "Stop":
        this.contextMtimeAtTurnEnd = await this.contextMtime();
        await this.transcript.flushUntilStable(true);
        if (this.cancelRequested) {
          this.finishTurn({ response: { stopReason: "cancelled" } });
          break;
        }
        // Claude goes idle the moment it launches a background agent or a background command, but the work it launched has not happened yet.
        // A command is dispatched exactly as an asynchronous agent is: the tool answers at the launch, Claude idles, and a <task-notification> wakes it when the work ends.
        // The turn is the only thing that tells Paseo a session is busy, so it is held open until every one of them has reported — and Claude has answered for them, since the notification that closes one wakes Claude for a turn of its own that ends in another Stop.
        this.heldAssistantMessage = asString(payload.last_assistant_message);
        if (this.turn && this.outstandingBackgroundWork > 0) {
          this.holdForBackgroundWork();
          break;
        }
        this.finishTurn({
          response: { stopReason: "end_turn" },
          assistantMessage: this.translator.assistantChunks === this.assistantBaseline ? this.heldAssistantMessage : undefined,
        });
        break;
      // A typed `/compact` is a local command: Claude rewrites the conversation and never runs a model turn, so no Stop follows and the turn would stay open for good.
      case "PostCompact":
        if (!this.turn || !this.turnIsCompact) break;
        await this.transcript.flushUntilStable(true);
        this.finishTurn({ response: { stopReason: "end_turn" } });
        break;
      case "StopFailure":
        this.contextMtimeAtTurnEnd = await this.contextMtime();
        await this.transcript.flushUntilStable(true);
        this.finishTurn(
          this.cancelRequested
            ? { response: { stopReason: "cancelled" } }
            : {
                response: { stopReason: "refusal" },
                assistantMessage:
                  this.translator.assistantChunks === this.assistantBaseline
                    ? asString(payload.last_assistant_message) || asString(payload.error) || "Claude could not complete the turn."
                    : undefined,
              },
        );
        break;
      case "SessionEnd":
        await this.transcript.flushUntilStable(true);
        this.finishTurn({ response: { stopReason: "cancelled" } });
        break;
    }
    return {};
  }

  private handleExit(pty: PtyProcess, exitCode: number, signal?: number): void {
    if (this.closed) return;
    const current = this.pty === pty;
    if (current) this.dialogs.stop();
    if (this.intentionalExit) {
      if (current) this.pty = null;
      this.intentionalExit.resolve();
      return;
    }
    // A stop that outlived its own wait lands here after the restart has already replaced this PTY.
    // Tearing the session down on it would unregister the hooks, close the transcript and delete the runtime directory of the process that is now serving it.
    if (!current) return;
    const details = this.screen.snapshot();
    const error = new Error(`Claude PTY exited unexpectedly with code ${exitCode}${signal === undefined ? "" : ` and signal ${signal}`}.${details ? `\n${details}` : ""}`);
    this.ready?.reject(error);
    this.interactions.cancelPending();
    if (this.turn) {
      const turn = this.turn;
      this.turn = null;
      turn.reject(error);
    }
    this.pty = null;
    this.hookRegistration?.unregister();
    this.hookRegistration = null;
    void this.transcript
      .close()
      .catch((transcriptError) => {
        writeLog({ level: "warn", message: "Failed to stop Claude transcript watcher", sessionId: this.sessionId, error: errorMessage(transcriptError) });
      })
      .finally(() => this.settleOpenToolCalls());
    void this.removeRuntimeDirectory().catch((cleanupError) => {
      writeLog({ level: "warn", message: "Failed to remove Claude runtime directory", sessionId: this.sessionId, error: errorMessage(cleanupError) });
    });
  }

  private finishTurn(result: TurnResult): void {
    if (!this.turn) return;
    if (this.cancelTimer) clearTimeout(this.cancelTimer);
    this.cancelTimer = null;
    this.releaseBackgroundHold();
    this.cancelRequested = false;
    this.interactions.cancelPending();
    const turn = this.turn;
    this.turn = null;
    turn.resolve(result);
  }

  // Paseo's own usage meter is unreachable from an external ACP provider, so the reading goes in the timeline as text.
  // A cancelled turn is left alone, because Paseo only allows 2s for the prompt it is replacing to answer.
  private async emitContextUsage(stopReason: string): Promise<void> {
    if (stopReason === "cancelled" || this.closed || !this.contextFilePath) return;
    // The mtime rather than the contents marks this turn's reading, because two turns that land on the same numbers write identical files.
    // It is taken at the Stop hook rather than here, because draining the transcript and delivering the turn's last message both run in between and can outlast Claude's refresh.
    // It is compared against itself rather than against Date.now(), because Linux stamps files from a coarse clock that can date a write milliseconds before the wall clock that observed it.
    const before = this.contextMtimeAtTurnEnd;
    const waits = this.contextWaitMisses < CONTEXT_WAIT_MISS_LIMIT || this.contextWaitMisses % CONTEXT_WAIT_RETRY_TURNS === 0;
    const deadline = Date.now() + this.contextRefreshTimeoutMs;
    do {
      const window = await this.readContextWindow(before);
      // Neither of these returns counts towards the latch, because neither a session closing nor a stop says anything about whether Claude writes readings.
      // The close is checked ahead of the send because the wait outlives the turn: a throw against a connection being torn down rejects a prompt that has already completed.
      if (this.closed) return;
      if (window) {
        this.contextWaitMisses = 0;
        // Local patch for T3 Code: a trailing "Context:" message becomes the turn's final answer and hides the real reply.
        writeLog({ level: "info", message: "Context window", tokens: window.tokens, percent: window.percent, sessionId: this.sessionId });
        return;
      }
      if (this.contextWaitCancelled) return;
      if (!waits || Date.now() >= deadline) break;
      await delay(CONTEXT_REFRESH_POLL_MS);
    } while (true);
    this.contextWaitMisses += 1;
    if (this.contextWaitMisses === CONTEXT_WAIT_MISS_LIMIT) {
      writeLog({
        level: "debug",
        message: `Claude reported no context reading for ${CONTEXT_WAIT_MISS_LIMIT} turns; the adapter will wait on only one turn in ${CONTEXT_WAIT_RETRY_TURNS} from here`,
        sessionId: this.sessionId,
        contextFile: this.contextFilePath,
      });
    }
  }

  // Claude truncates the file before it rewrites it, so a torn read comes back as no reading and is waited out.
  // The catch is for the file going rather than for its contents: a close removes the runtime directory under a wait that has already stat'd it, and throwing here would reject a turn that has completed.
  private async readContextWindow(rewrittenAfter: number): Promise<ContextWindow | null> {
    if (!this.contextFilePath) return null;
    const mtime = await this.contextMtime();
    if (mtime <= rewrittenAfter) return null;
    try {
      return contextWindow(await readFile(this.contextFilePath, "utf8"));
    } catch {
      return null;
    }
  }

  private async contextMtime(): Promise<number> {
    if (!this.contextFilePath) return 0;
    try {
      return (await stat(this.contextFilePath)).mtimeMs;
    } catch {
      return 0;
    }
  }

  /** Everything Claude launched to run on its own and is still owed a report for. */
  private get outstandingBackgroundWork(): number {
    return this.translator.runningSubagents + this.translator.runningBackgroundShells;
  }

  /** Watches from outside the hook channel, because stuck work produces no hook to answer. */
  private holdForBackgroundWork(): void {
    if (this.backgroundHold) return;
    writeLog({
      level: "info",
      message: "Holding the turn open for background work",
      sessionId: this.sessionId,
      agents: this.translator.runningSubagents,
      shells: this.translator.runningBackgroundShells,
    });
    this.heldAt = Date.now();
    this.backgroundHold = setInterval(() => this.reviewBackgroundHold(), this.subagentPollMs);
    this.backgroundHold.unref();
  }

  /**
   * A hold that is simply over ends at the Stop hook.
   * This is only the way out of one that is not, and each kind of work waited on has a bound of its own: the turn ends when every one of them has run out, never while one is still inside its own.
   */
  private reviewBackgroundHold(): void {
    if (!this.turn) {
      this.releaseBackgroundHold();
      return;
    }
    const agents = this.translator.runningSubagents;
    const shells = this.translator.runningBackgroundShells;
    const now = Date.now();
    // Nothing is given up on while Claude is still writing, whatever it is that woke it: an answer cut off by the poll that follows the report it answers is the very thing the hold is for.
    if (now - this.answerProgressAt() < this.subagentWakeMs) return;
    if (agents > 0 && now - this.agentProgressAt() < this.subagentSilenceMs) return;
    if (shells > 0 && now - this.shellProgressAt() < this.backgroundShellMs) return;
    // The bound that ran out, which is the one the message below is about.
    const silent = now - (agents > 0 ? this.agentProgressAt() : shells > 0 ? this.shellProgressAt() : this.answerProgressAt());
    writeLog({
      level: "warn",
      message:
        agents > 0
          ? "Ending a turn whose background agents have gone quiet"
          : shells > 0
            ? "Ending a turn whose background commands never reported"
            : "Ending a turn Claude never answered its background work in",
      sessionId: this.sessionId,
      agents,
      shells,
      // Which ones, because a turn held by work that has already gone is the hard one to read back.
      agentIds: this.translator.outstandingSubagents,
      shellIds: this.translator.outstandingBackgroundShells,
      silentMs: silent,
    });
    // The turn has stopped waiting on this work, so nothing else goes on counting it either: every later turn would hold for a poll interval and give up again in the same breath.
    this.translator.abandonBackgroundWork();
    this.finishTurn({
      response: { stopReason: "end_turn" },
      assistantMessage: this.translator.assistantChunks === this.assistantBaseline ? this.heldAssistantMessage : undefined,
    });
  }

  /** An agent still running shows it by writing, and nothing Claude does says whether it is alive, so this reads only the agents and the hold itself. */
  private agentProgressAt(): number {
    return Math.max(this.translator.subagentActivityAt, this.heldAt);
  }

  /** When a background command was last launched or reported, or the hold began, whichever is latest. */
  private shellProgressAt(): number {
    return Math.max(this.translator.backgroundShellActivityAt, this.heldAt);
  }

  /** Claude answering for work that has reported is exactly what the wake bound waits for, so anything Claude writes counts towards it: what it says, what it thinks, and the tools it runs on the way. */
  private answerProgressAt(): number {
    return Math.max(
      this.translator.subagentActivityAt,
      this.translator.backgroundShellActivityAt,
      this.translator.assistantActivityAt,
      this.heldAt,
    );
  }

  /**
   * Anything Claude was running has stopped with it, so the cards standing for that work are closed
   * rather than left turning. Never worth failing a shutdown over: a session reloaded later replays
   * its transcript, which closes them again.
   */
  private async settleOpenToolCalls(): Promise<void> {
    try {
      await this.translator.settleOpenToolCalls();
    } catch (error) {
      writeLog({ level: "warn", message: "Could not close the tool calls a stopped session left running", sessionId: this.sessionId, error: errorMessage(error) });
    }
  }

  private releaseBackgroundHold(): void {
    if (this.backgroundHold) clearInterval(this.backgroundHold);
    this.backgroundHold = null;
    this.heldAssistantMessage = undefined;
  }

  private async finishCancelled(): Promise<void> {
    await this.transcript.flushUntilStable(true);
    this.finishTurn({ response: { stopReason: "cancelled" } });
  }

  private async handleSessionStart(payload: HookPayload): Promise<void> {
    const nextClaudeSessionId = asString(payload.session_id);
    const transcriptFilePath = asString(payload.transcript_path);
    const source = asString(payload.source);
    if (source === "clear" && nextClaudeSessionId && nextClaudeSessionId !== this.currentClaudeSessionId) {
      await this.transcript.close();
      this.currentClaudeSessionId = nextClaudeSessionId;
      this.hookRegistration?.addSessionId(nextClaudeSessionId);
      this.transcript = this.createTranscriptWatcher(nextClaudeSessionId, transcriptFilePath);
      await this.transcript.start();
      await this.onClaudeSessionChange?.(nextClaudeSessionId);
      return;
    }
    if (transcriptFilePath && transcriptFilePath !== this.transcriptFilePath) {
      await this.transcript.close();
      this.transcript = this.createTranscriptWatcher(this.currentClaudeSessionId, transcriptFilePath);
    }
  }

  private createTranscriptWatcher(claudeSessionId: string, filePath?: string): TranscriptWatcher {
    const reader = new TranscriptReader(claudeSessionId, this.cwd, { configDir: this.claudeConfigDir, filePath });
    this.transcriptFilePath = reader.filePath;
    return new TranscriptWatcher(
      reader,
      this.translator,
      this.transcriptPollIntervalMs,
      new SubagentWatcher(reader.filePath, this.translator, this.cwd),
      this.transcriptFlushIntervalMs,
    );
  }

  private async removeRuntimeDirectory(): Promise<void> {
    const directory = this.runtimeDirectory;
    this.runtimeDirectory = null;
    if (directory) await rm(directory, { force: true, recursive: true });
  }

  private async stopForRestart(): Promise<void> {
    const pty = this.pty;
    if (!pty) return;
    this.dialogs.stop();
    this.intentionalExit = createDeferred<void>();
    pty.write(CONTROL_D);
    await Promise.race([this.intentionalExit.promise, new Promise<void>((resolve) => setTimeout(resolve, 500))]);
    if (this.pty === pty) {
      try {
        pty.kill();
      } catch {}
      this.pty = null;
      await Promise.race([this.intentionalExit.promise, new Promise<void>((resolve) => setTimeout(resolve, 50))]);
    }
    this.intentionalExit = null;
    this.hookRegistration?.unregister();
    this.hookRegistration = null;
    // The last thing written may be the notification that closes an agent, and the reader has to be open to see it.
    await this.transcript.flushUntilStable(true);
    await this.transcript.close();
    await this.settleOpenToolCalls();
    await this.removeRuntimeDirectory();
  }

  /**
   * Empties Claude's input box so the paste that follows is the whole of what Claude reads.
   *
   * The box is not reliably empty when a prompt arrives. Interrupting a turn puts the prompt it
   * interrupted back for editing, and a submit a cancel abandons between its paste and its Enter leaves
   * that paste behind; Paseo interrupts before it replaces a turn, so both are one message away in any
   * session the daemon is steering. What Claude then receives is the two run together as a single
   * prompt nobody wrote, sent from before the turn the interrupt rewound.
   *
   * Emptying it takes a key per line rather than one key. Ctrl-U kills the visual line the cursor is on,
   * so on residue Claude had wrapped it cuts at the wrap and leaves every line above -- which is not a
   * box that failed to clear but a box holding the front of the old message, the half a reader is least
   * likely to notice is not theirs. Measured against Claude Code v2.1.269 at this terminal size: a
   * 193-character prompt wraps after 115, and one Ctrl-U leaves exactly those 115 characters behind.
   *
   * Those keys go one write at a time. Written as one string they are not keys at all: Claude reads the
   * burst as pasted text and puts every one of the 40 control characters into the box, so the clear that
   * was meant to empty it is what fills it, and the prompt goes to Claude behind forty U+0015. See the
   * constants above for the evidence in Claude's own transcripts.
   *
   * The box is read back between keys, which is also what ends the run early -- an empty box is the
   * ordinary case and a key on one does nothing, so paying 40 keys for it would put a second on the front
   * of every prompt. The reading is not trusted on its own, because the screen is sampled and a paste too
   * recent to have been rendered is exactly the residue worth clearing: the run ends on a few empty
   * readings in a row, and a box that never reads empty gets the screenful the bound allows and no more.
   *
   * It also ends where the keys have stopped changing anything. Claude puts a suggested prompt in an
   * empty box as grey ghost text, which is not content and cannot be killed, but reads as content to
   * anything that scrapes the characters off a screen -- so a box showing one would otherwise take every
   * key of the bound, every time, and report itself uncleared afterwards. What is compared is the screen
   * from the box down rather than the box's own line, because Ctrl-U kills the last of the lines a long
   * prompt wrapped onto and leaves the first, which is the line the box is read from: on a wrapped
   * residue that line reads the same between keys while the box is visibly emptying.
   */
  private async clearInputBox(): Promise<void> {
    const held = inputBoxContent(this.screen.snapshot());
    let keys = 0;
    let empties = 0;
    let unchanged = 0;
    let previous = inputBoxTail(this.screen.snapshot());
    while (keys < TERMINAL_ROWS && empties < CLEAR_INPUT_CONFIRMATIONS && unchanged < CLEAR_INPUT_UNCHANGED) {
      this.pty?.write(CLEAR_INPUT_LINE);
      keys += 1;
      await delay(this.clearInputKeyMs);
      const screen = this.screen.snapshot();
      // A screen with no input box on it at all -- a terminal Claude has painted nothing to yet -- says
      // nothing is being held any more than an empty box does, and is counted the same way.
      empties = (inputBoxContent(screen) || "") === "" ? empties + 1 : 0;
      const tail = inputBoxTail(screen);
      unchanged = tail === previous ? unchanged + 1 : 0;
      previous = tail;
    }
    if (held) {
      writeLog({
        level: "warn",
        message: "Cleared something out of Claude's input box before sending a prompt",
        sessionId: this.sessionId,
        held: held.slice(0, PROMPT_ECHO_CHARS),
        keys,
        // Whether the box was empty when the keys stopped, rather than the run simply having run out.
        emptied: empties >= CLEAR_INPUT_CONFIRMATIONS,
        // And whether they stopped because nothing was moving, which is what a suggestion Claude is
        // offering looks like from here: read as held, and not there to be cleared.
        unchanged: unchanged >= CLEAR_INPUT_UNCHANGED,
      });
    }
  }

  /**
   * Puts the prompt in Claude's input box and sends it, and says so when it could not.
   *
   * Every way a turn ends is a hook Claude fires, so a prompt Claude never took ends nothing: the turn
   * stays open for the rest of the session, the client shows it working, and the message is gone without
   * a line anywhere. That is worth an error rather than a silence, so this only returns on evidence that
   * the prompt went in — the input box letting go of it, or the turn moving on by itself.
   */
  private async submit(pastes: string[]): Promise<void> {
    const activityBefore = this.activityAt;
    const typed = pastes.map((text) => `${text}${COMPLETION_DISMISS}`);
    const echo = screenText(typed.join(""));
    const end = echo.slice(-PROMPT_END_CHARS);
    const paste = async (): Promise<void> => {
      await this.clearInputBox();
      const writes = typed.flatMap(inputBoxPaste);
      for (let index = 0; index < writes.length; index += 1) {
        if (index > 0) await delay(PASTE_WRITE_GAP_MS);
        this.pty?.write(writes[index]!);
      }
      if (writes.length > 1) {
        const deadline = Date.now() + PASTE_SETTLE_LIMIT_MS;
        const settled = () => this.screen.quietFor(this.pasteSettleMs) && screenText(this.screen.snapshot()).includes(end);
        while (!settled() && Date.now() < deadline) await delay(STARTUP_POLL_INTERVAL_MS);
      }
    };
    if ((await this.takeTheKeyboardBack(activityBefore)) === "delivered") return;
    await paste();
    let pasted = await this.screenSettles((screen) => inputBoxHolds(screen, echo), this.pasteEchoMs);
    for (let attempt = 0; attempt < SUBMIT_ATTEMPTS; attempt += 1) {
      await delay(this.submitDelayMs);
      if (this.cancelRequested) return;
      // A question can open between the paste and this key, and the key would answer it. Only asked after
      // a box that is not visibly holding the prompt, because a box that is holding it has the keys.
      if (!pasted) {
        const keyboard = await this.takeTheKeyboardBack(activityBefore);
        if (keyboard === "delivered") return;
        if (keyboard === "dismissed") {
          // The paste went into the question rather than into the box, so it goes again now the box has
          // the keys back; Claude has nothing of this prompt yet, and the key below would send an empty box.
          await paste();
          pasted = await this.screenSettles((screen) => inputBoxHolds(screen, echo), this.pasteEchoMs);
          continue;
        }
      }
      this.pty?.write(CARRIAGE_RETURN);
      if (pasted) {
        if (await this.screenSettles((screen) => !inputBoxHolds(screen, echo), this.submitConfirmMs)) return;
        continue;
      }
      // The key above went into an input box with nothing of ours in it, so it sent nothing. Claude
      // settles a long paste a render after it reads it, and a prompt that turns up behind a spent
      // submit key sits in the box unsent -- so the echo is waited for rather than assumed absent,
      // and sent properly on the next attempt once it lands.
      if (!inputBoxVisible(this.screen.snapshot())) return;
      pasted = await this.screenSettles((screen) => inputBoxHolds(screen, echo), this.latePasteMs);
      if (!pasted) {
        // An echo that never came is the shape a question opening behind the paste has: the paste went
        // into the question instead of the box, so there was never an echo to wait for. Asked here
        // rather than only before the key, because the wait above is two seconds long and a question
        // Claude opened during it would otherwise fail a prompt this can still deliver.
        const keyboard = await this.takeTheKeyboardBack(activityBefore);
        if (keyboard === "delivered") return;
        if (keyboard === "dismissed") {
          await paste();
          pasted = await this.screenSettles((screen) => inputBoxHolds(screen, echo), this.pasteEchoMs);
          continue;
        }
        if (this.submissionMovedOn(activityBefore)) return;
        throw new Error(`Claude never took the prompt for session ${this.sessionId}: it did not appear in Claude's input box.`);
      }
    }
    if (this.submissionMovedOn(activityBefore)) return;
    throw new Error(`Claude kept the prompt for session ${this.sessionId} in its input box after ${SUBMIT_ATTEMPTS} submit attempts.`);
  }

  /**
   * Gets the keyboard back off anything Claude has open, so the prompt goes to the input box or nowhere.
   *
   * A question Claude opens takes the box's place and marks its selected row with the same ❯, so every
   * reading the screen offers says a box is there holding a prompt nobody sent -- and what this would then
   * do to it is worse than a message not delivered. The screenful of Ctrl-U that empties a box walks the
   * selection, the space that closes Claude's completion menu toggles the checkbox under it, and the submit
   * key confirms whatever is left selected. Two sessions answered Claude Code v2.1.269's auto-mode setup
   * question that way by themselves, the same row logged as `[✔]` in one and `[ ]` nineteen minutes later.
   *
   * So the question is closed rather than typed over. Escape is what closes one and costs nothing anywhere
   * else -- on an idle input box it does not even clear the text -- and what makes it safe to send without
   * knowing which question is up is that Claude's own state says whether it worked. Nothing is assumed: the
   * key goes, the state is read back, and a question that will not close fails the prompt instead.
   *
   * `delivered` where the prompt turns out to have gone in already, because a question Claude opened
   * *because of* it is the turn running rather than a turn to fail.
   */
  private async takeTheKeyboardBack(activityBefore: number): Promise<"clear" | "dismissed" | "delivered"> {
    const waitingFor = await claudeIsWaitingFor(this.pty?.pid, this.claudeConfigDir);
    if (waitingFor === null) return "clear";
    if (this.submissionMovedOn(activityBefore)) return "delivered";
    for (let attempt = 0; attempt < DIALOG_DISMISS_ATTEMPTS; attempt += 1) {
      this.pty?.write(ESCAPE);
      const deadline = Date.now() + this.dialogDismissMs;
      do {
        await delay(STARTUP_POLL_INTERVAL_MS);
        if ((await claudeIsWaitingFor(this.pty?.pid, this.claudeConfigDir)) === null) {
          writeLog({ level: "warn", message: "Closed something Claude had open, to get the keyboard back for a prompt", sessionId: this.sessionId, waitingFor });
          // The card for that question stands for an answer nobody can give now, and the question went
          // unanswered to make room for this message, which is worth a line in the session's timeline.
          await this.dialogs.dismissedForPrompt(waitingFor);
          return "dismissed";
        }
      } while (Date.now() < deadline);
    }
    // Nothing outside this process can reach the PTY -- the adapter implements no ACP terminal and Paseo's
    // own terminals are workspace shells -- so a question Escape will not close is one nobody can answer
    // from the client. Saying which, with the screen it is on, is the whole of what can be offered.
    throw new Error(
      `Claude is waiting on ${waitingFor} in session ${this.sessionId} and did not let go of it. The prompt was not sent, because the keys that would have sent it would have answered that instead. Restarting Claude clears it -- changing the session's model or thinking level does that on the same conversation. Terminal output:\n${this.screen.snapshot()}`,
    );
  }

  /**
   * Whether the prompt went in after all, read from something other than the input box.
   * The box is sampled, not followed, so a prompt taken between two samples leaves no trace in it —
   * and calling that one undelivered would fail a turn that is running.
   */
  private submissionMovedOn(activityBefore: number): boolean {
    return this.turn === null || this.activityAt > activityBefore;
  }

  private async screenSettles(predicate: (screen: string) => boolean, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    do {
      if (predicate(this.screen.snapshot())) return true;
      await delay(25);
    } while (Date.now() < deadline);
    return false;
  }

  private async waitForTerminalReady(): Promise<void> {
    if (this.readinessTimeoutMs === 0) return;
    let deadline = Date.now() + this.readinessTimeoutMs;
    while (Date.now() < deadline) {
      const screen = this.screen.snapshot();
      if (!this.staleResumeAnswered && isStaleResumeScreen(screen)) {
        await this.keepFullSession();
        // Claude reads the whole conversation in only after the answer, so readiness gets a fresh window rather than the remains of this one.
        deadline = Date.now() + this.readinessTimeoutMs;
        continue;
      }
      if (isReadyScreen(screen) && this.screen.quietFor(this.readyQuietMs)) return;
      await delay(STARTUP_POLL_INTERVAL_MS);
    }
    await this.failedStartup(`Claude completed its SessionStart hook but its interactive prompt did not become ready within ${this.readinessTimeoutMs}ms. Check the terminal output:\n${this.screen.snapshot()}`);
  }

  /**
   * Claude offers to replace a long or old conversation with a summary of it before resuming.
   * The adapter always keeps the conversation, because that conversation is the ACP session it was asked to restore;
   * a summary would silently discard the history Paseo has already replayed into its timeline.
   */
  private async keepFullSession(): Promise<void> {
    this.staleResumeAnswered = true;
    const answer = await this.answerStartupMenu({
      onScreen: isStaleResumeScreen,
      selected: isFullSessionSelected,
      keyDelayMs: this.staleResumeKeyDelayMs,
      timeoutMs: this.staleResumeSelectionTimeoutMs,
      exited: "Claude exited before its resume question could be answered",
    });
    if (answer === "confirmed") {
      writeLog({ level: "info", message: "Kept the full conversation at Claude's resume question", sessionId: this.sessionId });
      return;
    }
    // The question is gone and Claude is resuming on an answer the adapter did not give. Which answer
    // that was is not on screen to read, and a session carrying on is worth more than a certain one.
    if (answer === "gone") {
      writeLog({ level: "warn", message: "Claude's resume question was answered before the adapter could take it", sessionId: this.sessionId });
      return;
    }
    await this.failedStartup(`Claude asked how to resume this session and the adapter could not select "Resume full session as-is". Terminal output:\n${this.screen.snapshot()}`);
  }

  /**
   * Answers one of the menus Claude opens on its way up: put the marker on the option, confirm it,
   * and wait for the question to go. Claude paints a menu just before its input state settles and
   * drops whatever arrives in that gap — the trust screen visibly rolls its selection back — so a
   * key is sent again for as long as the screen says the last one did not land, rather than once
   * after a delay guessed in advance.
   */
  private async answerStartupMenu(menu: StartupMenu): Promise<"confirmed" | "gone" | "stuck"> {
    const pty = this.pty;
    if (!pty) throw new Error(menu.exited);
    const deadline = Date.now() + menu.timeoutMs;
    // The menu has just been painted, so the first key waits for the input state behind it.
    await delay(menu.keyDelayMs);
    while (Date.now() < deadline) {
      if (this.pty !== pty) throw new Error(menu.exited);
      const screen = this.screen.snapshot();
      if (!menu.onScreen(screen)) return "gone";
      if (menu.selected(screen)) {
        // The marker moves before the input behind it does, so the choice is read once more on the way out.
        await delay(menu.keyDelayMs);
        if (this.pty !== pty) throw new Error(menu.exited);
        if (!menu.selected(this.screen.snapshot())) continue;
        pty.write(ENTER);
        return "confirmed";
      }
      pty.write(CURSOR_DOWN);
      await delay(Math.max(menu.keyDelayMs, STARTUP_POLL_INTERVAL_MS));
    }
    return menu.onScreen(this.screen.snapshot()) ? "stuck" : "gone";
  }

  private async waitForSessionStart(): Promise<void> {
    if (!this.ready) throw new Error("Claude startup readiness was not initialized");
    if (!this.trustPrompt) throw new Error("Claude workspace-trust detection was not initialized");
    const ready = this.ready.promise.then(() => "ready" as const);
    const trustPrompt = this.trustPrompt.promise.then(() => "trust-prompt" as const);
    let deadline = Date.now() + this.startupTimeoutMs;
    let trustHandled = false;
    let bypassHandled = false;
    let externalImportsHandled = false;
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(this.startupTimeoutMessage());
      const waits: Array<Promise<"ready" | "poll" | "trust-prompt">> = [
        ready,
        delay(Math.min(STARTUP_POLL_INTERVAL_MS, remaining)).then(() => "poll" as const),
      ];
      if (!trustHandled) waits.push(trustPrompt);
      const result = await Promise.race(waits);
      if (result === "ready") return;
      if (!this.staleResumeAnswered && isStaleResumeScreen(this.screen.snapshot())) {
        await this.keepFullSession();
        deadline = Date.now() + this.startupTimeoutMs;
        continue;
      }
      // Claude only raises the disclaimer for the mode that is gated on it, and a resumed session repaints a conversation that may quote the dialog it is asking about.
      if (!bypassHandled && this.mode === "bypassPermissions" && isBypassPermissionsScreen(this.screen.snapshot())) {
        bypassHandled = true;
        const accepted = await this.interactions.requestBypassPermissions();
        if (!accepted) throw new Error("Claude asks for the Bypass Permissions disclaimer before it will start in that mode, and it was not accepted in Paseo.");
        await this.acceptBypassPermissions();
        // As with workspace trust: the window that was running covered a handshake, not a person reading a warning.
        deadline = Date.now() + this.startupTimeoutMs;
        continue;
      }
      if (!externalImportsHandled && isExternalImportsScreen(this.screen.snapshot())) {
        externalImportsHandled = true;
        await this.answerExternalImports();
        // Same reason again: a person was reading a list of paths, not a handshake that was slow.
        deadline = Date.now() + this.startupTimeoutMs;
        continue;
      }
      if (trustHandled || (result !== "trust-prompt" && !isWorkspaceTrustScreen(this.screen.snapshot()))) continue;
      trustHandled = true;
      const approved = await this.interactions.requestWorkspaceTrust();
      if (!approved) throw new Error(`Claude requires workspace trust for ${this.cwd}, but it was not approved in Paseo.`);
      await this.confirmWorkspaceTrust();
      // A human may take longer than the normal startup window to answer the permission card.
      // Give Claude a full handshake window after the explicit decision.
      deadline = Date.now() + this.startupTimeoutMs;
    }
  }

  private startupTimeoutMessage(): string {
    return `Claude did not complete the SessionStart hook handshake within ${this.startupTimeoutMs}ms. Check Claude hook policy and the terminal output:\n${this.screen.snapshot()}`;
  }

  private async acceptBypassPermissions(): Promise<void> {
    const answer = await this.answerStartupMenu({
      onScreen: isBypassPermissionsScreen,
      selected: isBypassPermissionsAccepted,
      keyDelayMs: this.bypassPermissionsKeyDelayMs,
      timeoutMs: this.bypassPermissionsSelectionTimeoutMs,
      exited: "Claude exited before the Bypass Permissions disclaimer could be accepted",
    });
    if (answer === "gone") {
      writeLog({ level: "warn", message: "Claude's Bypass Permissions disclaimer was answered before the adapter could take it", sessionId: this.sessionId });
    }
    if (answer === "stuck") {
      throw new Error(`Claude did not select "Yes, I accept" on its Bypass Permissions disclaimer after it was accepted in Paseo. Terminal output:\n${this.screen.snapshot()}`);
    }
  }

  /**
   * Claude asks whether this project's CLAUDE.md may reach outside the workspace for the files it
   * `@`-imports, and that is the same kind of question as the trust screen: an import is read into
   * Claude's context as instructions, the files are chosen by whoever wrote the CLAUDE.md, and no
   * default the adapter could pick would be answering for anybody. So it goes to Paseo as a card, with
   * the paths Claude listed in it.
   *
   * Refusing is where this parts company with workspace trust. Trust is the session -- Claude exits
   * without it, so a denial fails the start -- but this dialog's No is a session that runs with the
   * imports left out. So a refusal takes that and carries on: a person who said no has said what they
   * want, and failing the start on top of it would refuse them the session as well. A card nobody
   * answers lands there too, which is half the reason for choosing it -- an unattended session comes up
   * on the safe side rather than sitting at a dialog until the handshake times out.
   *
   * What the session loses is not left silent. The notice puts the refusal and the files in the
   * timeline, because a Claude missing the instructions its CLAUDE.md promised is otherwise a session
   * behaving oddly for no visible reason.
   */
  private async answerExternalImports(): Promise<void> {
    const imports = externalImportPaths(this.screen.snapshot());
    const allowed = await this.interactions.requestExternalImports(imports);
    const option = allowed ? "Yes, allow external imports" : "No, disable external imports";
    const answer = await this.answerStartupMenu({
      onScreen: isExternalImportsScreen,
      selected: allowed ? isExternalImportsAllowed : isExternalImportsDisabled,
      keyDelayMs: this.externalImportsKeyDelayMs,
      timeoutMs: this.externalImportsSelectionTimeoutMs,
      exited: "Claude exited before its external-imports question could be answered",
    });
    // The question is gone and Claude is starting on an answer the adapter did not give, which for this
    // one is a session either way: it has the imports or it has not, and which is not on screen to read.
    if (answer === "gone") {
      writeLog({ level: "warn", message: "Claude's external-imports question was answered before the adapter could take it", sessionId: this.sessionId });
      return;
    }
    // Stuck is the dialog still standing, and Claude completes no handshake behind one, so the start is
    // lost whatever this says. An error naming the option beats waiting out the startup window for it.
    if (answer === "stuck") {
      throw new Error(`Claude did not select "${option}" on its external-imports question after it was answered in Paseo. Terminal output:\n${this.screen.snapshot()}`);
    }
    writeLog({ level: "info", message: "Answered Claude's external-imports question", sessionId: this.sessionId, allowed, imports });
    if (allowed) return;
    await sendNotice(this.connection, this.sessionId, {
      id: `external-imports-${randomUUID()}`,
      severity: "warning",
      title: "External CLAUDE.md imports are disabled for this session",
      description: [
        "This project's CLAUDE.md imports files from outside the workspace, and that was not approved, so Claude started without them.",
        ...(imports.length > 0 ? [`Left out:\n${imports.map((file) => `- ${file}`).join("\n")}`] : []),
      ].join("\n\n"),
    });
  }

  private async confirmWorkspaceTrust(): Promise<void> {
    const answer = await this.answerStartupMenu({
      onScreen: isWorkspaceTrustScreen,
      selected: isWorkspaceTrustSelected,
      keyDelayMs: this.workspaceTrustKeyDelayMs,
      timeoutMs: this.workspaceTrustSelectionTimeoutMs,
      exited: "Claude exited before workspace trust could be confirmed",
    });
    if (answer === "gone") {
      writeLog({ level: "warn", message: "Claude's workspace trust question was answered before the adapter could take it", sessionId: this.sessionId });
    }
    if (answer === "stuck") {
      throw new Error(`Claude did not select the workspace trust option after approval in Paseo. Terminal output:\n${this.screen.snapshot()}`);
    }
  }
}

function createSettings(command: string, contextFilePath: string): Record<string, unknown> {
  const lifecycleHook = { type: "command", command, timeout: 30 };
  // These two hooks render a card and wait for the person to answer it, which the default 600 seconds does not allow for.
  // At the timeout Claude kills the hook and treats the call as undecided, then asks its own permission pipeline instead, which reaches the user as a second card for a tool they are already looking at.
  const interactionHook = { type: "command", command, timeout: 86_400 };
  return {
    // Claude's status line is the only place it reports the tokens in the context window as a share of the window holding them.
    // Claude runs the command through a shell and renders its stdout, so this writes the payload to a file and prints nothing.
    // It runs when the reading changes rather than on a timer, which is at least once per assistant response.
    statusLine: { type: "command", command: `cat > ${shellQuote(contextFilePath)}` },
    hooks: {
      PreToolUse: [{ hooks: [interactionHook] }],
      PermissionRequest: [{ hooks: [interactionHook] }],
      SessionStart: [{ hooks: [lifecycleHook] }],
      Stop: [{ hooks: [lifecycleHook] }],
      StopFailure: [{ hooks: [lifecycleHook] }],
      PostCompact: [{ hooks: [lifecycleHook] }],
      SessionEnd: [{ hooks: [lifecycleHook] }],
    },
  };
}

// A hook that renders a card waits for as long as the person does, so this posts over node:http rather than fetch.
// Node's fetch is undici, whose headersTimeout gives up on the response after 300 seconds; node:http imposes no such deadline.
function hookClientSource(endpoint: string): string {
  return `import http from "node:http";
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const payload = Buffer.concat(chunks);
const status = await new Promise((resolve, reject) => {
  const request = http.request(${JSON.stringify(endpoint)}, { method: "POST", headers: { "content-type": "application/json", "content-length": payload.length } }, (response) => {
    const parts = [];
    response.on("data", (part) => parts.push(part));
    response.on("end", () => {
      const body = Buffer.concat(parts).toString();
      if (body) process.stdout.write(body);
      resolve(response.statusCode ?? 0);
    });
  });
  request.on("error", reject);
  request.end(payload);
});
if (status < 200 || status > 299) process.exitCode = 1;
`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function selectionArgs(model: string, mode: string, effort: string): string[] {
  const args: string[] = [];
  if (model !== INHERIT_MODEL_ID) args.push("--model", model);
  if (mode !== "default") args.push("--permission-mode", mode);
  if (effort !== INHERIT_EFFORT_ID) args.push("--effort", effort);
  return args;
}

/**
 * Whether Claude's input box is on screen at all, empty or not.
 * An empty box only means the prompt is not in it where there is a box to read: a session whose terminal
 * has painted nothing -- every test's fake PTY, and a real one before Claude's first render -- says nothing
 * either way, and is left to the submit key rather than called a failure.
 */
function inputBoxVisible(screen: string): boolean {
  return /^\s*❯/m.test(screen);
}

// The last prompt marker on screen is Claude's input box; the ones above it are prompts it has already taken.
// Null where the screen has no box on it at all, which says nothing about what Claude is holding.
function inputBoxContent(screen: string): string | null {
  const lines = screen.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const match = /^\s*❯\s?(.*)$/.exec(lines[index]!);
    if (match) return match[1]!.trim();
  }
  return null;
}

/**
 * The screen from Claude's input box down: the box, whatever it has wrapped onto, and the footer under
 * it. What a Ctrl-U that did something changes, and what one that did nothing leaves exactly as it was.
 */
function inputBoxTail(screen: string): string {
  const lines = screen.split("\n");
  const index = lines.findLastIndex((line) => /^\s*❯/.test(line));
  return (index < 0 ? lines : lines.slice(index)).join("\n");
}

/**
 * Whether the input box is showing the prompt `echo` is the `screenText` of. The box shows a prompt
 * from its first line, and one taller than the box from whichever line Claude has scrolled it to, so
 * what is read is the first visible line of it, which is a stretch of the prompt either way.
 */
function inputBoxHolds(screen: string, echo: string): boolean {
  const content = screenText(inputBoxContent(screen) ?? "");
  return content !== "" && echo.includes(content);
}

/**
 * Text as it can be found again on Claude's screen: with no whitespace, since Claude wraps and indents
 * where it likes and draws a tab as spaces, and nothing outside printable ASCII, since a terminal can
 * draw a wide character over the cells around it.
 */
function screenText(text: string): string {
  return text.replace(/[^\x21-\x7e]/g, "");
}

// Registering a status line makes Claude drop most footer hints, `? for shortcuts` among them, so that alternative cannot match in an adapter-launched session.
// The mode indicator carries readiness in its place and is present in every mode, `manual mode on` in the default one; the token badge is absent until a session has context, and the bare prompt marker does not match while the input box still holds its placeholder.
// Each indicator is spelled out because the footer is the indicator Claude keeps for the mode plus ` on`, and half of them do not end in `mode`: `accept edits on`, `bypass permissions on` and `don't ask on` are what those sessions print.
// `don't ask` is here although the mode selector does not offer it, because Paseo's Default mode sends no `--permission-mode` and leaves the session in whatever `permissions.defaultMode` Claude's settings name.
const MODE_INDICATORS = ["auto mode", "plan mode", "manual mode", "accept edits", "bypass permissions", "don't ask"];
const READY_SCREEN = new RegExp(
  `\\?\\s+for shortcuts|\\d+(?:\\.\\d+)?[km]?/\\d+(?:\\.\\d+)?[km]? tokens|(?:${MODE_INDICATORS.join("|")}) on|(^|\\n)\\s*❯\\s*($|\\n)`,
  "i",
);

function isReadyScreen(screen: string): boolean {
  return READY_SCREEN.test(screen);
}

function isWorkspaceTrustScreen(screen: string): boolean {
  return (
    /Accessing workspace:/i.test(screen) &&
    /Quick safety check:/i.test(screen) &&
    /No,\s*exit/i.test(screen) &&
    /Yes,\s*I trust this folder/i.test(screen) &&
    /Enter to confirm/i.test(screen)
  );
}

/**
 * Claude puts this up before it reads a CLAUDE.md that `@`-imports anything outside the working
 * directory, and it comes *before* the SessionStart hook, so a session whose project has one never
 * started at all until the startup loop learned to recognise it.
 *
 * The phrases are joined with `\s+` rather than spaces because a snapshot is a screen: Claude wraps its
 * own sentences at the terminal width, and the question and the two options are all long enough to land
 * with a newline inside them on a narrower one than this adapter asks for.
 */
function isExternalImportsScreen(screen: string): boolean {
  return (
    /Allow\s+external\s+CLAUDE\.md\s+file\s+imports\?/i.test(screen) &&
    /External\s+imports:/i.test(screen) &&
    /No,\s*disable\s+external\s+imports/i.test(screen) &&
    /Yes,\s*allow\s+external\s+imports/i.test(screen) &&
    /Enter to confirm/i.test(screen)
  );
}

function isExternalImportsAllowed(screen: string): boolean {
  return /(?:^|\n)[ \t]*❯[ \t]*Yes,[ \t]*allow external imports[ \t]*(?:$|\n)/i.test(screen);
}

/** Where Claude's own marker starts, so a refusal is confirmed without moving it. */
function isExternalImportsDisabled(screen: string): boolean {
  return /(?:^|\n)[ \t]*❯[ \t]*No,[ \t]*disable external imports[ \t]*(?:$|\n)/i.test(screen);
}

/**
 * The files Claude lists under `External imports:`, which are the whole of what the card is asking
 * about. Read by walking down from that heading for as long as the lines look like paths, because the
 * list has no closing line of its own -- what follows it is the `Important:` warning and Claude's
 * security link, and neither of those begins the way a path does.
 *
 * A path longer than the screen is wide is the one thing this reads short: Claude wraps it, and the
 * continuation stops the walk rather than joining the line above. The card is then missing a tail, not
 * a file, so the person still sees which import they are being asked about.
 */
function externalImportPaths(screen: string): string[] {
  const lines = screen.split("\n");
  const heading = lines.findIndex((line) => /^\s*External\s+imports:/i.test(line));
  if (heading < 0) return [];
  const paths: string[] = [];
  for (const line of lines.slice(heading + 1)) {
    const text = line.trim();
    if (!/^[~/.]/.test(text)) break;
    paths.push(text);
  }
  return paths;
}

/**
 * Claude gates bypass permissions on a one-time acknowledgement kept per host, in
 * `skipDangerousModePermissionPrompt`, and puts this dialog in front of the first session that asks
 * for the mode without it. Nothing else on the startup path carries this title next to these options.
 */
function isBypassPermissionsScreen(screen: string): boolean {
  return (
    /WARNING: Claude Code running in Bypass Permissions mode/i.test(screen) &&
    /No,\s*exit/i.test(screen) &&
    /Yes,\s*I accept/i.test(screen) &&
    /Enter to confirm/i.test(screen)
  );
}

function isBypassPermissionsAccepted(screen: string): boolean {
  return /(?:^|\n)[ \t]*❯[ \t]*Yes,[ \t]*I accept[ \t]*(?:$|\n)/i.test(screen);
}

// Claude shows this before it opens a conversation it considers long or old, and nothing else on its startup path offers these four lines together.
function isStaleResumeScreen(screen: string): boolean {
  return (
    /Resuming the full session will consume a substantial portion of your usage limits/i.test(screen) &&
    /Resume from summary/i.test(screen) &&
    /Resume full session as-is/i.test(screen) &&
    /Enter to confirm/i.test(screen)
  );
}

/** The options are numbered on screen, so the marker sits ahead of the number rather than the label. */
function isFullSessionSelected(screen: string): boolean {
  return /(?:^|\n)[ \t]*❯[ \t]*(?:\d+\.[ \t]*)?Resume full session as-is[ \t]*(?:$|\n)/i.test(screen);
}

function isWorkspaceTrustSelected(screen: string): boolean {
  return /(?:^|\n)[ \t]*❯[ \t]*Yes,[ \t]*I trust this folder(?:$|\n)/i.test(screen);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

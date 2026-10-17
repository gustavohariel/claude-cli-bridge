import { createHash } from "node:crypto";
import path from "node:path";
import type {
  AgentSideConnection,
  ContentBlock,
  PlanEntry,
  SessionUpdate,
  ToolCallContent,
  ToolCallLocation,
  ToolKind,
} from "@agentclientprotocol/sdk";
import { readOutputTail } from "./background-output.ts";
import { writeLog } from "./log.ts";
import { questionText } from "./question-text.ts";
import { MODELS } from "./session-options.ts";
import {
  backgroundOutputFile,
  launchedAgent,
  launchedBackgroundShell,
  messagedAgent,
  notificationFailed,
  parseTaskNotifications,
  subagentProse,
  subagentToolLine,
  SubagentLog,
  type TaskNotification,
} from "./subagent-transcript.ts";
import type { TranscriptRecord } from "./transcript-reader.ts";

const IGNORED_RECORD_TYPES = new Set([
  "agent-name",
  "agent-setting",
  "ai-title",
  "atis-latch",
  "bridge-session",
  "custom-title",
  "file-history-delta",
  "file-history-snapshot",
  "last-prompt",
  "mode",
  "permission-mode",
  "pr-link",
  "relocated",
  "summary",
  "worktree-state",
]);

const TOOL_KINDS: Record<string, ToolKind> = {
  Agent: "other",
  Bash: "execute",
  BashOutput: "execute",
  Edit: "edit",
  Glob: "search",
  Grep: "search",
  KillShell: "execute",
  MultiEdit: "edit",
  NotebookEdit: "edit",
  Read: "read",
  Task: "other",
  WebFetch: "fetch",
  WebSearch: "search",
  Write: "edit",
};

/**
 * The system records Claude writes when it changes the model underneath a session.
 *
 * `model_refusal_fallback` is the one a person meets: a message the model's own safeguards flagged is
 * silently retried on a fallback model, under `switchModelsOnFlag`. `model_fallback` is the same
 * machinery for a model that could not be used at all -- `model_not_found` and its siblings -- and
 * `model_consent_fallback` records a switch somebody consented to. Each carries Claude's own sentence
 * as `content`, the two models as `originalModel` and `fallbackModel`, a `direction` (`retry`,
 * `revert`, `sticky`) and a `scope` (`session`, `local`).
 */
const MODEL_FALLBACK_SUBTYPES = new Set(["model_refusal_fallback", "model_fallback", "model_consent_fallback"]);

/** The tools that hand work to a subagent, whose own transcript is where that work then happens. */
const AGENT_TOOLS = new Set(["Agent", "Task"]);

/** The tool Claude stops one of its own agents or background commands with, naming it by the id its launch reported. */
const STOP_TASK_TOOL = "TaskStop";

/** The last step on the card of a subagent whose session stopped before it said how it went. */
/** What a tool call still open when its session stopped is failed with, since nothing will report on it. */
const STOPPED_TOOL_CALL = "The session stopped before this tool call reported.";
const UNREPORTED_AGENT = "Claude stopped before this agent reported back.";

/** The last step on the card of a subagent the session it runs in stopped on purpose. */
const STOPPED_AGENT = "Claude stopped this agent.";

/** The last line on the card of a background command Claude stopped, which reports nothing of its own. */
const STOPPED_COMMAND = "Claude stopped this command.";
const UNREPORTED_COMMAND = "The session stopped before this command reported.";

/** A command's output is a file it appends to, and a card that follows it closely is a read on every transcript poll. */
const BACKGROUND_OUTPUT_POLL_MS = 1_000;

/**
 * A copy of every tool-call update, sent beside the update itself as a vendor notification.
 *
 * Paseo has two ACP bridges and they read a tool call differently. The daemon's own builds eight
 * kinds of card out of `kind`, `content` and `locations`; the one behind the plugin SDK's
 * `runAcpProvider` keeps `rawInput` and `rawOutput` and nothing else, and renders every call as an
 * edit or as raw JSON. The fields it drops are gone before any of the hooks it offers can see them,
 * so the only way a plugin can draw the card the daemon draws is to be handed the update a second
 * time on a channel the bridge does not consume. A client that does not know the method ignores it,
 * which is what both of Paseo's bridges do with an extension they were not written for.
 */
export const TOOL_CALL_MIRROR_METHOD = "_claude_tty/tool_call";

/**
 * The `_meta` key a background command's card carries its task and output file under.
 * The plugin opens a subsession for the command from it, since nothing else on a tool call says the command runs on after its launch.
 */
export const BACKGROUND_COMMAND_META = "claudeTty/backgroundCommand";

/**
 * A model Claude swapped under a running session, as everything that has to be said about one.
 *
 * It is handed to the runtime rather than emitted here, because what it turns into -- a notice, a card,
 * the model Paseo shows in the picker -- is said on channels the translator does not own, and because
 * the runtime only exists while Claude does: a session replaying its history has no runtime, which is
 * the second half of why none of this happens on a replay.
 */
export type ModelFallback = {
  /** Stable across re-reads of the record, so the notice for one switch is one notice. */
  id: string;
  subtype: string;
  title: string;
  /** Claude's own sentence about the switch. */
  description: string;
  /** The model Paseo should show for the session from here, or null where the record says nothing about that. */
  model: string | null;
};

/**
 * A subagent and the tool call standing for it. Nested subagents share their spawner's card, so one
 * card holds one log and an update never replaces another agent's steps with its own.
 */
type SubagentCard = {
  agentId: string;
  toolCallId: string | null;
  log: SubagentLog;
  status: "in_progress" | "completed" | "failed";
  /** Launched to run on its own and not yet reported, which is what keeps the session's turn open. */
  outstanding: boolean;
  /** Given up on by a turn that waited its bound out, so no later turn waits on it again. */
  abandoned: boolean;
};

/** A command Claude started in the background. */
type BackgroundShell = {
  outstanding: boolean;
  /** The launch's own tool call, kept open while the command runs; null where this session shows no card for it. */
  card: BackgroundShellCard | null;
};

type BackgroundShellCard = {
  taskId: string;
  toolCallId: string;
  outputFile: string | null;
  status: "in_progress" | "completed" | "failed";
  output: string;
};

export class TranscriptTranslator {
  private readonly sessionId: string;
  private readonly cwd: string;
  private readonly connection: AgentSideConnection;
  private readonly emitted = new Set<string>();
  private readonly emittedTools = new Set<string>();
  private readonly unknownKinds = new Set<string>();
  private readonly agentCalls = new Set<string>();
  /** The tool calls Paseo is still showing as running, which is what a stopped session has to close. */
  private readonly openToolCalls = new Set<string>();
  private readonly subagents = new Map<string, SubagentCard>();
  private readonly subagentsByToolCall = new Map<string, string>();
  /** The background commands this session has started, by the task id their notifications name. */
  private readonly backgroundShells = new Map<string, BackgroundShell>();
  private readonly backgroundShellsByToolCall = new Map<string, string>();
  /** The task each `TaskStop` call names, kept for the life of the session because a replay reads the call again and needs it again. */
  private readonly stoppedTasksByToolCall = new Map<string, string>();
  /** The diff each edit's tool call carried, until its result has sent it again. */
  private readonly diffsByToolCall = new Map<string, ToolCallContent[]>();
  /** The nested agents' reports already written onto a spawner's card, because one notification is delivered many times over. */
  private readonly notedNestedReports = new Set<string>();
  private lastSubagentActivity = 0;
  private lastBackgroundShellActivity = 0;
  private lastBackgroundOutputRead = 0;
  private lastAssistantActivity = 0;
  private lastActivity = 0;
  private trackingBackgroundWork = false;
  private lastPlan = "";
  /**
   * When this translator was made, which is what tells a record written now from one being replayed.
   * A loaded session replays its whole transcript through this, and a compaction has it re-read from
   * the start again; a card or a push for a model switch that happened days ago is noise at best.
   */
  private readonly liveFrom = Date.now();
  private modelFallbackHandler: ((fallback: ModelFallback) => void) | null = null;
  private lastUsage = "";
  private assistantChunkCount = 0;
  private suppressedAssistantText: string | null = null;

  constructor(sessionId: string, cwd: string, connection: AgentSideConnection) {
    this.sessionId = sessionId;
    this.cwd = cwd;
    this.connection = connection;
  }

  get assistantChunks(): number {
    return this.assistantChunkCount;
  }

  /** When Claude itself last said, thought or ran anything, whichever kind of record it was. */
  get assistantActivityAt(): number {
    return this.lastAssistantActivity;
  }

  /**
   * When anything last happened in this session: Claude's own records, a subagent's, or a user turn
   * Claude was woken with. Claude's own are deduplicated before they are sent, so replaying them
   * moves nothing; a subagent's launch and steps are stamped as they are read, replay or not, and a
   * replay follows a compaction, which is itself the session working.
   */
  get activityAt(): number {
    return Math.max(this.lastActivity, this.lastAssistantActivity, this.lastSubagentActivity);
  }

  /**
   * Subagents that were launched to run on their own and have not reported. Nested subagents share
   * their spawner's card, so they are counted once, as the one piece of work the session launched.
   */
  get runningSubagents(): number {
    return this.outstandingSubagents.length;
  }

  /** When any subagent last did anything, which is all there is to say whether one is still alive. */
  get subagentActivityAt(): number {
    return this.lastSubagentActivity;
  }

  /** The background commands that were started while a turn was in flight and have not reported. */
  get runningBackgroundShells(): number {
    return [...this.backgroundShells.values()].filter((shell) => shell.outstanding).length;
  }

  /** When a background command was last launched or reported. */
  get backgroundShellActivityAt(): number {
    return this.lastBackgroundShellActivity;
  }

  /** The agents still being waited on, for the log of a turn that stopped waiting for them. */
  get outstandingSubagents(): string[] {
    return [...new Set([...this.subagents.values()].filter((card) => card.outstanding).map((card) => card.agentId))];
  }

  /** The background commands still being waited on, for that same log. */
  get outstandingBackgroundShells(): string[] {
    return [...this.backgroundShells.entries()].filter(([, shell]) => shell.outstanding).map(([taskId]) => taskId);
  }

  /**
   * Stops counting the agents and background commands a turn has given up waiting on.
   * Their cards keep saying they are working, which is still true — nothing has reported — and they are closed when the process is.
   * Without this every later turn holds for a poll interval and gives up again in the same breath.
   */
  abandonBackgroundWork(): void {
    for (const card of this.subagents.values()) {
      if (!card.outstanding) continue;
      card.outstanding = false;
      card.abandoned = true;
    }
    this.letGoOfBackgroundShells();
  }

  /** An agent that has reported writes nothing more, so its transcript stops being worth reading. */
  subagentSettled(agentId: string): boolean {
    const card = this.subagents.get(agentId);
    return card !== undefined && card.status !== "in_progress";
  }

  /**
   * Called as a prompt starts.
   * Loading a persisted session replays its whole transcript first, and an agent or a background command launched in a session that has since been closed left its launch behind without the notification that would have ended it: history says it is running when nothing is.
   */
  trackBackgroundWork(): void {
    this.trackingBackgroundWork = true;
  }

  /**
   * Where a model switch goes while Claude is running. Set by the runtime as it is built and cleared
   * when it stops, so a switch is only ever reported by the session that is actually having one.
   */
  setModelFallbackHandler(handler: ((fallback: ModelFallback) => void) | null): void {
    this.modelFallbackHandler = handler;
  }

  suppressNextAssistantText(text: string): void {
    this.suppressedAssistantText = text.trim() || null;
  }

  async translate(records: TranscriptRecord[]): Promise<void> {
    for (const record of records) await this.translateRecord(record);
  }

  private async translateRecord(record: TranscriptRecord): Promise<void> {
    const type = stringValue(record.type);
    switch (type) {
      case "user":
        await this.translateUser(record);
        return;
      case "assistant":
        await this.translateAssistant(record);
        return;
      case "system":
        await this.translateSystem(record);
        return;
      case "attachment":
        await this.translateAttachment(record);
        return;
      case "queue-operation":
        await this.translateQueueOperation(record);
        return;
      default:
        if (type && !IGNORED_RECORD_TYPES.has(type)) this.reportUnknown(type);
    }
  }

  private async translateUser(record: TranscriptRecord): Promise<void> {
    const message = objectValue(record.message);
    const content = message?.content;
    const recordId = stringValue(record.uuid) || stableUuid(JSON.stringify(record));
    if (record.isMeta !== true && record.isSidechain !== true) this.suppressedAssistantText = null;
    await this.translateNotifications(content);
    if (typeof content === "string") {
      await this.emitUserText(`${recordId}:text`, recordId, content, record);
      return;
    }
    if (!Array.isArray(content)) return;
    for (let index = 0; index < content.length; index += 1) {
      const block = objectValue(content[index]);
      if (!block) continue;
      const key = `${recordId}:${index}:${String(block.type)}`;
      if (block.type === "text") await this.emitUserText(key, recordId, stringValue(block.text) || "", record);
      if (block.type === "image") await this.emitContent("user_message_chunk", key, recordId, imageContent(block));
      if (block.type === "tool_result") await this.translateToolResult(block, record);
    }
  }

  private async emitUserText(key: string, recordId: string, rawText: string, record: TranscriptRecord): Promise<void> {
    if (record.isMeta === true || record.isSidechain === true) return;
    const text = cleanUserText(rawText);
    if (text) await this.emitContent("user_message_chunk", key, recordId, { type: "text", text });
  }

  private async translateAssistant(record: TranscriptRecord): Promise<void> {
    const message = objectValue(record.message);
    const content = message?.content;
    if (!Array.isArray(content)) return;
    const recordId = stringValue(record.uuid) || stableUuid(JSON.stringify(record));
    const messageId = stringValue(record.requestId) || recordId;
    for (let index = 0; index < content.length; index += 1) {
      const block = objectValue(content[index]);
      if (!block) continue;
      const key = `${recordId}:${index}:${String(block.type)}`;
      switch (block.type) {
        case "text": {
          const text = stringValue(block.text)?.trim();
          if (text && text === this.suppressedAssistantText) {
            this.suppressedAssistantText = null;
            this.emitted.add(key);
          } else if (text) {
            await this.emitContent("agent_message_chunk", key, messageId, { type: "text", text });
          }
          break;
        }
        case "thinking": {
          const text = stringValue(block.thinking)?.trim();
          if (text) await this.emitContent("agent_thought_chunk", key, messageId, { type: "text", text });
          break;
        }
        case "tool_use":
          await this.translateToolUse(block);
          break;
        case "image":
          await this.emitContent("agent_message_chunk", key, messageId, imageContent(block));
          break;
        default:
          this.reportUnknown(`assistant:${String(block.type)}`);
      }
    }
    await this.translateUsage(record, message);
  }

  private async translateToolUse(block: TranscriptRecord): Promise<void> {
    const toolCallId = stringValue(block.id);
    const name = stringValue(block.name) || "Tool";
    const input = objectValue(block.input) || {};
    if (!toolCallId) {
      this.reportUnknown(`tool:${name}:missing-id`);
      return;
    }
    if (name === "TodoWrite") {
      await this.translatePlan(input.todos);
      return;
    }
    if (AGENT_TOOLS.has(name)) this.agentCalls.add(toolCallId);
    // Read before the guard below, so a replay of the transcript maps the call to its agent again.
    if (name === STOP_TASK_TOOL) {
      const stopped = stringValue(input.task_id);
      if (stopped) this.stoppedTasksByToolCall.set(toolCallId, stopped);
    }
    if (this.emittedTools.has(toolCallId)) return;
    this.emittedTools.add(toolCallId);
    this.openToolCalls.add(toolCallId);
    this.lastAssistantActivity = Date.now();
    const locations = toolLocations(input, this.cwd);
    const content = toolContents(name, input, this.cwd);
    if (content.some((item) => item.type === "diff")) this.diffsByToolCall.set(toolCallId, content);
    await this.send({
      sessionUpdate: "tool_call",
      toolCallId,
      title: toolTitle(name, input),
      kind: TOOL_KINDS[name] || "other",
      status: "in_progress",
      rawInput: input,
      ...(locations.length > 0 ? { locations } : {}),
      ...(content.length > 0 ? { content } : {}),
    });
  }

  private async translateToolResult(block: TranscriptRecord, record: TranscriptRecord): Promise<void> {
    const toolCallId = stringValue(block.tool_use_id);
    if (!toolCallId || !this.emittedTools.has(toolCallId)) return;
    const launch = this.agentCalls.has(toolCallId) ? launchedAgent(record.toolUseResult) : null;
    if (launch !== null) {
      await this.linkSubagent(launch.agentId, toolCallId, launch.running);
      // An asynchronous agent answers the moment it starts, so closing the card here would report a
      // minutes-long agent as finished before it had done anything. It is closed by its notification.
      if (launch.running) return;
      // A synchronous one has already finished, and the result below is its report. Its card is
      // settled on that, or a session stopping later would rewrite the report as a failure.
      this.settleSubagentCard(launch.agentId, block.is_error === true);
    }
    // A background command answers with the id its report will name, and goes on running after it.
    // Its card is closed by that report rather than by this result, which says only that it started.
    const shell = launchedBackgroundShell(record.toolUseResult);
    if (shell !== null) {
      const outputFile = backgroundOutputFile([...contentTexts(block.content), stringValue(objectValue(record.toolUseResult)?.stdout) ?? ""].join("\n"));
      const opened = this.trackBackgroundShell(shell.taskId, toolCallId, outputFile);
      if (opened !== null) await this.publishBackgroundShell(opened);
      if (this.backgroundShells.get(shell.taskId)?.card) {
        this.lastAssistantActivity = Date.now();
        return;
      }
    }
    // Messaging an agent is the only record that puts one back to work after its own report closed it.
    const messaged = messagedAgent(record.toolUseResult);
    if (messaged !== null) await this.resumeSubagentCard(messaged.agentId);
    // Stopped work writes no report and sends no notification, so nothing else ever ends it: it would go on being counted as running and hold every later turn open to its bound.
    // The stop names an agent or a background command through the one `task_id`, so it is offered to both.
    const stopped = this.stoppedTasksByToolCall.get(toolCallId);
    if (stopped !== undefined && block.is_error !== true) {
      await this.stopSubagentCard(stopped);
      await this.stopBackgroundShell(stopped);
    }
    const resultKey = `${toolCallId}:result:${createHash("sha256").update(JSON.stringify(block)).digest("hex")}`;
    if (this.emitted.has(resultKey)) return;
    this.emitted.add(resultKey);
    // A result is Claude's tool finishing, which is as much its own progress as calling it was.
    this.lastAssistantActivity = Date.now();
    // Content replaces what the call carried, and both of Paseo's bridges read an edit card's text as its unified diff.
    // So an edit's result sends its diff again rather than the line saying the file was updated, which would leave a card with no diff at all.
    // The result is still there in `rawOutput`.
    const content = this.diffsByToolCall.get(toolCallId) ?? resultContent(block.content);
    this.diffsByToolCall.delete(toolCallId);
    this.openToolCalls.delete(toolCallId);
    await this.send({
      sessionUpdate: "tool_call_update",
      toolCallId,
      status: block.is_error === true ? "failed" : "completed",
      rawOutput: block.content,
      ...(content.length > 0 ? { content } : {}),
    });
  }

  /**
   * The end of an asynchronous agent is reported in a notification and nowhere else, and the text carrying it is scrubbed before the user sees it, so it is read here on the way past.
   * It arrives as a user turn of its own, or as the queued command below.
   */
  private async translateNotifications(content: unknown): Promise<void> {
    for (const text of contentTexts(content)) {
      for (const notification of parseTaskNotifications(text)) await this.applyNotification(notification);
    }
  }

  /**
   * A task notification Claude queued while it was working, written as a record of the queue's own.
   *
   * For a command a *subagent* backgrounded this is the only record of the report there is: it never
   * reaches a user turn, and the `queued_command` attachment beside it carries what was queued as a
   * prompt rather than this. A wait left on one of those never ends, and the session reads as busy for
   * the rest of its life.
   *
   * Only the notifications are taken; the rest of what the queue writes is Claude's own bookkeeping.
   * The same notification is written on the way in, on the way out, and again at every turn boundary
   * the queue survives, which costs nothing: a card is closed only while it is open, and ending a wait
   * that has already ended changes nothing.
   */
  private async translateQueueOperation(record: TranscriptRecord): Promise<void> {
    await this.translateNotifications(record.content);
  }

  /**
   * A notification names an agent or a background command.
   * One for an agent whose launch is no longer in the transcript has no tool call to close, but still says the agent has stopped, which is what lets its transcript stop being followed.
   *
   * Only an open card is closed, because one notification is written many times over: queued while Claude is busy and again as the turn that delivers it, and the queue is rewritten at every turn boundary it survives.
   * Reading each of those as news would stack the same line onto the card.
   */
  private async applyNotification(notification: TaskNotification): Promise<void> {
    if (await this.settleBackgroundShell(notification)) return;
    const agentId =
      notification.taskId ??
      (notification.toolCallId === null ? null : this.subagentsByToolCall.get(notification.toolCallId) ?? null);
    const card = agentId === null ? undefined : this.subagents.get(agentId);
    if (card === undefined || agentId === null || card.status !== "in_progress") return;
    // A nested agent's report is written into *this* session's transcript rather than its spawner's,
    // and the card it resolves through is the spawner's, shared with it by the adoption. Settling
    // that card on it would call the spawner finished at the very moment it is being woken to carry
    // on -- the report is what wakes it -- and would take its transcript out of the watcher's reading
    // with it, leaving the card saying "completed" for however many hours the spawner still had to
    // run, and the turn free to end on a session that is still working. So it is a step and no more.
    if (card.agentId !== agentId) {
      await this.noteNestedReport(card, agentId, notification);
      return;
    }
    card.status = notificationFailed(notification.status) ? "failed" : "completed";
    card.outstanding = false;
    this.lastSubagentActivity = Date.now();
    card.log.append(notification.summary ?? `Agent ${notification.status ?? "finished"}`);
    await this.publishSubagent(card);
  }

  /**
   * Puts a nested agent's report on the card it shares with its spawner, and counts it as the
   * spawner working: the spawner writes again as soon as it has read the report, and a hold that
   * ran its bound out in between would end the turn with all of that still to come.
   *
   * Deduplicated by the line itself, keyed to the agent and the call that launched it, because one
   * notification is written many times over and none of the repeats is news. What that cannot tell
   * apart is a nested agent messaged back into work that then finishes again saying exactly what it
   * said the first time, which costs the repeat its line and nothing else.
   */
  private async noteNestedReport(card: SubagentCard, agentId: string, notification: TaskNotification): Promise<void> {
    const line = `↳ ${notification.summary ?? `Agent ${notification.status ?? "finished"}`}`;
    const key = `${agentId}:${notification.toolCallId ?? ""}:${line}`;
    if (this.notedNestedReports.has(key)) return;
    this.notedNestedReports.add(key);
    this.lastSubagentActivity = Date.now();
    card.log.append(line);
    await this.publishSubagent(card);
  }

  /**
   * A replayed launch does not start a background command over: one that has already reported, or that a turn gave up waiting on, is recorded here as settled and is not waited on again.
   * Nor is one whose launch is only history — a session being loaded replays commands that stopped with the process that ran them, and their launches close as the plain results they are.
   */
  private trackBackgroundShell(taskId: string, toolCallId: string | null, outputFile: string | null = null): BackgroundShellCard | null {
    if (this.backgroundShells.has(taskId)) return null;
    // Null for a command an agent backgrounded: the tool call that launched it is in that agent's own
    // transcript, not this session's, and its notification names it by task id rather than by call.
    const card: BackgroundShellCard | null =
      toolCallId !== null && this.trackingBackgroundWork ? { taskId, toolCallId, outputFile, status: "in_progress", output: "" } : null;
    this.backgroundShells.set(taskId, { outstanding: this.trackingBackgroundWork, card });
    if (toolCallId !== null) this.backgroundShellsByToolCall.set(toolCallId, taskId);
    this.lastBackgroundShellActivity = Date.now();
    return card;
  }

  /** Whether this report was a background command's. */
  private async settleBackgroundShell(notification: TaskNotification): Promise<boolean> {
    const taskId =
      notification.taskId ??
      (notification.toolCallId === null ? null : this.backgroundShellsByToolCall.get(notification.toolCallId) ?? null);
    const shell = taskId === null ? undefined : this.backgroundShells.get(taskId);
    if (shell === undefined) return false;
    if (shell.outstanding) this.lastBackgroundShellActivity = Date.now();
    shell.outstanding = false;
    const summary = notification.summary ?? `Background command ${notification.status ?? "finished"}`;
    await this.closeBackgroundShellCard(shell, notificationFailed(notification.status) ? "failed" : "completed", summary);
    return true;
  }

  /**
   * The steps a subagent took, streamed onto the tool call that launched it. They are never sent as
   * message chunks: a turn is judged finished by counting those, and a subagent still working after
   * its launcher has answered would keep the session's turn open for as long as it ran.
   */
  async translateSubagent(agentId: string, records: TranscriptRecord[]): Promise<void> {
    const card = this.subagentCard(agentId);
    // A nested subagent shares its spawner's card, so its steps are marked as its own.
    const prefix = card.agentId === agentId ? "" : "\u21b3 ";
    let appended = false;
    for (const record of records) appended = this.logSubagentRecord(card, record, prefix) || appended;
    if (!appended) return;
    this.lastSubagentActivity = Date.now();
    await this.publishSubagent(card);
  }

  private logSubagentRecord(card: SubagentCard, record: TranscriptRecord, prefix: string): boolean {
    const nested = launchedAgent(record.toolUseResult);
    if (nested !== null) this.adoptSubagent(nested.agentId, card);
    // An agent that backgrounds a command reports the moment it has launched it, so its own report says
    // nothing about whether the work is over. The command notifies this session directly when it ends --
    // the notification names it by task id -- so it is waited on here exactly as one of the session's own.
    const backgrounded = launchedBackgroundShell(record.toolUseResult);
    if (backgrounded !== null) this.trackBackgroundShell(backgrounded.taskId, null);
    const message = objectValue(record.message);
    const content = message?.content;
    if (stringValue(record.type) !== "assistant" || !Array.isArray(content)) return false;
    let appended = false;
    for (const value of content) {
      const block = objectValue(value);
      if (!block) continue;
      if (block.type === "text") {
        const text = subagentProse(stringValue(block.text) ?? "", this.cwd);
        if (text) {
          card.log.append(`${prefix}${text}`);
          appended = true;
        }
      }
      if (block.type === "tool_use") {
        const name = stringValue(block.name) || "Tool";
        card.log.append(`${prefix}• ${subagentToolLine(name, objectValue(block.input) || {}, this.cwd)}`);
        appended = true;
      }
    }
    return appended;
  }

  /**
   * Moves a subagent onto the card of the agent that launched it. Its transcript is often read
   * before the record naming it as nested, so whatever it has already logged is carried across
   * rather than left on a card of its own that nothing will ever show.
   */
  private adoptSubagent(agentId: string, card: SubagentCard): void {
    const existing = this.subagents.get(agentId);
    if (existing === card || (existing !== undefined && existing.toolCallId !== null)) return;
    for (const step of existing?.log.steps() ?? []) card.log.append(step.startsWith("↳") ? step : `↳ ${step}`);
    this.subagents.set(agentId, card);
  }

  private async linkSubagent(agentId: string, toolCallId: string, running: boolean): Promise<void> {
    const card = this.subagentCard(agentId);
    // A compaction rewrites the transcript, and the re-read that follows replays the launch of an
    // agent that has since reported, or that a turn gave up waiting on. Neither is waited on again.
    card.outstanding = running && this.trackingBackgroundWork && card.status === "in_progress" && !card.abandoned;
    this.lastSubagentActivity = Date.now();
    if (card.toolCallId === toolCallId) return;
    card.toolCallId = toolCallId;
    this.subagentsByToolCall.set(toolCallId, agentId);
    await this.publishSubagent(card);
  }

  /**
   * Closes the card of an agent this session stopped itself.
   * Its steps stay on the card — the work up to the stop is what there is to show — with a last line saying how it ended.
   */
  private async stopSubagentCard(agentId: string): Promise<void> {
    const card = this.subagents.get(agentId);
    if (card === undefined || card.status !== "in_progress") return;
    card.status = "failed";
    card.outstanding = false;
    card.log.append(STOPPED_AGENT);
    this.lastSubagentActivity = Date.now();
    await this.publishSubagent(card);
  }

  private async stopBackgroundShell(taskId: string): Promise<void> {
    const shell = this.backgroundShells.get(taskId);
    if (shell === undefined) return;
    if (shell.outstanding) this.lastBackgroundShellActivity = Date.now();
    shell.outstanding = false;
    await this.closeBackgroundShellCard(shell, "failed", STOPPED_COMMAND);
  }

  /** Only an open card is closed, because one notification is written many times over. */
  private async closeBackgroundShellCard(shell: BackgroundShell, status: "completed" | "failed", ending: string): Promise<void> {
    const card = shell.card;
    if (card === null || card.status !== "in_progress") return;
    card.status = status;
    card.output = (await this.readBackgroundOutput(card)) ?? card.output;
    await this.publishBackgroundShell(card, ending);
  }

  /**
   * Puts what each running background command has printed since the last look onto its card.
   * Throttled, because it is asked on every transcript poll; `force` is for the end of a turn.
   */
  async refreshBackgroundShells(force = false): Promise<void> {
    const now = Date.now();
    if (!force && now - this.lastBackgroundOutputRead < BACKGROUND_OUTPUT_POLL_MS) return;
    this.lastBackgroundOutputRead = now;
    for (const { card } of this.backgroundShells.values()) {
      if (card === null || card.status !== "in_progress") continue;
      const output = await this.readBackgroundOutput(card);
      if (output === null || output === card.output || card.status !== "in_progress") continue;
      card.output = output;
      // Not activity: a command printing is not Claude doing anything, and a prompt is judged delivered by activity.
      await this.publishBackgroundShell(card, undefined, { quiet: true });
    }
  }

  private async readBackgroundOutput(card: BackgroundShellCard): Promise<string | null> {
    if (card.outputFile === null) return null;
    return readOutputTail(card.outputFile).catch((error: unknown) => {
      writeLog({ level: "warn", message: "Could not read background command output", sessionId: this.sessionId, file: card.outputFile, error: String(error) });
      return null;
    });
  }

  private async publishBackgroundShell(card: BackgroundShellCard, ending?: string, { quiet = false } = {}): Promise<void> {
    if (card.status !== "in_progress") this.openToolCalls.delete(card.toolCallId);
    const waiting = card.status === "in_progress" && card.output === "" ? "Running in the background; no output yet." : "";
    const text = [card.output || waiting, ending ?? ""].filter((part) => part !== "").join("\n\n");
    const update: SessionUpdate = {
      sessionUpdate: "tool_call_update",
      toolCallId: card.toolCallId,
      status: card.status,
      content: text === "" ? [] : [{ type: "content", content: { type: "text", text } }],
      ...(card.status === "failed" ? { rawOutput: { error: text } } : {}),
      _meta: { [BACKGROUND_COMMAND_META]: { taskId: card.taskId, outputFile: card.outputFile } },
    };
    if (quiet) await this.deliver(update);
    else await this.send(update);
  }

  private letGoOfBackgroundShells(): void {
    for (const shell of this.backgroundShells.values()) shell.outstanding = false;
  }

  /**
   * Puts an agent that has already reported back to work.
   *
   * Its notification closed its card, which was right at the time -- Claude notifies each time an agent
   * stops, and the same agent may notify many times over, because a message sent to one starts it again.
   * Nothing else records that restart, so a card left closed stops holding the session's turn open while
   * the agent it stands for is running, and the session reads as done with work still going.
   *
   * Only a card this session already knows is reopened, so a message naming something that is not one of
   * its agents invents nothing, and never one a turn has given up on: that turn stopped counting it
   * deliberately, and every later turn would hold for a poll interval and give up again in the same breath.
   */
  private async resumeSubagentCard(agentId: string): Promise<void> {
    const card = this.subagents.get(agentId);
    if (card === undefined || card.status === "in_progress" || card.abandoned) return;
    card.status = "in_progress";
    card.outstanding = this.trackingBackgroundWork;
    this.lastSubagentActivity = Date.now();
    if (card.toolCallId !== null) this.openToolCalls.add(card.toolCallId);
    await this.publishSubagent(card);
  }

  /** Records how an agent went, on the card that has to go on saying so after Claude has stopped. */
  private settleSubagentCard(agentId: string, failed: boolean): void {
    const card = this.subagents.get(agentId);
    if (card === undefined || card.status !== "in_progress") return;
    card.status = failed ? "failed" : "completed";
    card.outstanding = false;
  }

  private subagentCard(agentId: string): SubagentCard {
    const existing = this.subagents.get(agentId);
    if (existing) return existing;
    const card: SubagentCard = {
      agentId,
      toolCallId: null,
      log: new SubagentLog(),
      status: "in_progress",
      outstanding: false,
      abandoned: false,
    };
    this.subagents.set(agentId, card);
    return card;
  }

  /**
   * Closes every tool call that is still shown as running. What closes one is written by the Claude
   * process that ran it — a result, or the notification that reports an asynchronous agent — so once
   * that process has stopped nothing is coming, and a card left open goes on saying it is working.
   */
  async settleOpenToolCalls(): Promise<void> {
    // A background command is a child of the process that has stopped, so its report is not coming either.
    this.letGoOfBackgroundShells();
    for (const shell of this.backgroundShells.values()) await this.closeBackgroundShellCard(shell, "failed", UNREPORTED_COMMAND);
    for (const card of new Set(this.subagents.values())) {
      if (card.status !== "in_progress") continue;
      card.status = "failed";
      card.outstanding = false;
      // An agent with no tool call has nothing to show the last step on, and is only marked so that its transcript is let go of.
      if (card.toolCallId === null) continue;
      card.log.append(UNREPORTED_AGENT);
      await this.publishSubagent(card);
    }
    for (const toolCallId of [...this.openToolCalls]) {
      this.openToolCalls.delete(toolCallId);
      await this.send({ sessionUpdate: "tool_call_update", toolCallId, status: "failed", rawOutput: { error: STOPPED_TOOL_CALL } });
    }
  }

  /** A tool call's content is replaced rather than added to, so the whole tail goes out each time. */
  private async publishSubagent(card: SubagentCard): Promise<void> {
    if (card.toolCallId === null) return;
    if (card.status !== "in_progress") this.openToolCalls.delete(card.toolCallId);
    const text = card.log.empty ? "Started; waiting for its first step." : card.log.text();
    await this.send({
      sessionUpdate: "tool_call_update",
      toolCallId: card.toolCallId,
      status: card.status,
      content: [{ type: "content", content: { type: "text", text } }],
      // A failed tool call the daemon is given no error for is one it cannot put in a timeline at all:
      // its schema wants a non-null error there, and the response carrying the item fails validation
      // whole, so the client refuses the agent's entire history rather than this one card.
      ...(card.status === "failed" ? { rawOutput: { error: text } } : {}),
    });
  }

  private async translatePlan(value: unknown): Promise<void> {
    if (!Array.isArray(value)) return;
    const entries: PlanEntry[] = [];
    for (const todo of value) {
      const item = objectValue(todo);
      const content = stringValue(item?.content);
      if (!item || !content) continue;
      const status = item.status === "completed" || item.status === "in_progress" ? item.status : "pending";
      entries.push({ content, priority: "medium", status });
    }
    const signature = JSON.stringify(entries);
    if (signature === this.lastPlan) return;
    this.lastPlan = signature;
    await this.send({ sessionUpdate: "plan", entries });
  }

  private async translateUsage(record: TranscriptRecord, message: TranscriptRecord | null): Promise<void> {
    const usage = objectValue(message?.usage) || objectValue(record.usage);
    if (!usage) return;
    const size = firstNumber(record.contextWindow, record.context_window, usage.contextWindow, usage.context_window);
    const input = firstNumber(usage.input_tokens, usage.inputTokens) || 0;
    const cacheRead = firstNumber(usage.cache_read_input_tokens, usage.cacheReadInputTokens) || 0;
    const cacheWrite = firstNumber(usage.cache_creation_input_tokens, usage.cacheCreationInputTokens) || 0;
    const used = firstNumber(record.contextUsed, record.context_used, usage.contextUsed, usage.context_used) ?? input + cacheRead + cacheWrite;
    if (size === null || size <= 0 || used < 0) return;
    const update = { sessionUpdate: "usage_update" as const, size, used: Math.min(used, size) };
    const signature = JSON.stringify(update);
    if (signature === this.lastUsage) return;
    this.lastUsage = signature;
    await this.send(update);
  }

  private async translateSystem(record: TranscriptRecord): Promise<void> {
    const content = stringValue(record.content)?.trim();
    const subtype = stringValue(record.subtype);
    if (!content || subtype === "turn_duration") return;
    const key = `${stringValue(record.uuid) || stableUuid(JSON.stringify(record))}:system`;
    if (subtype !== null && MODEL_FALLBACK_SUBTYPES.has(subtype) && this.reportModelFallback(record, subtype, content, key)) return;
    await this.emitContent("agent_message_chunk", key, key, { type: "text", text: content });
  }

  /**
   * A model swapped under the session, reported once and only while it is happening.
   *
   * Returns whether it was taken, and a switch that was taken does not also go into the conversation:
   * the notice carries Claude's own sentence as its description, and saying the same thing twice in one
   * timeline is worse than saying it once in the place that means "this happened to your session".
   * A switch read back out of history keeps that sentence exactly as it always has, because a
   * conversation that loses it says nothing about which model answered what.
   */
  private reportModelFallback(record: TranscriptRecord, subtype: string, content: string, key: string): boolean {
    const handler = this.modelFallbackHandler;
    if (!handler || !this.isLive(record) || this.emitted.has(key)) return false;
    // The conversation's key too, so a re-read of this record cannot put the sentence in after all.
    this.emitted.add(key);
    const original = stringValue(record.originalModel);
    const fallback = stringValue(record.fallbackModel);
    const direction = stringValue(record.direction);
    const scope = stringValue(record.scope);
    handler({
      id: `model-fallback-${stableUuid(key)}`,
      subtype,
      title:
        direction === "revert"
          ? `Model switched back to ${modelName(original ?? fallback)}`
          : `Model switched: ${modelName(original)} → ${modelName(fallback)}`,
      description: content,
      // A switch Claude made for one message says nothing about what the session is on; a session-scoped
      // one does, and a revert puts back what the session was launched with.
      model: direction === "revert" ? original : scope === "session" ? fallback : null,
    });
    this.lastActivity = Date.now();
    return true;
  }

  /** Whether this record was written by the session that is running rather than read back out of it. */
  private isLive(record: TranscriptRecord): boolean {
    const written = Date.parse(stringValue(record.timestamp) ?? "");
    // A record with no timestamp reads as history: a notice that never came is a smaller thing than a
    // card raised for a switch that happened last week, every time a session is opened.
    return Number.isFinite(written) && written >= this.liveFrom;
  }

  private async translateAttachment(record: TranscriptRecord): Promise<void> {
    const attachment = objectValue(record.attachment);
    const type = stringValue(attachment?.type);
    if (!attachment || !type) return;
    if (type === "queued_command") {
      await this.translateQueued(attachment, record);
      return;
    }
    if (type === "hook_system_message" || type === "hook_non_blocking_error" || type === "hook_cancelled") {
      const text = stringValue(attachment.content) || stringValue(attachment.stderr) || `${stringValue(attachment.hookName) || "Hook"} ${type.replace("hook_", "")}`;
      const key = `${stringValue(record.uuid) || stableUuid(JSON.stringify(record))}:attachment`;
      await this.emitContent("agent_message_chunk", key, key, { type: "text", text });
    }
  }

  /**
   * A message queued while Claude was working is absorbed mid-turn, at Claude's next tool result, and this attachment is the only record of it, so it is emitted as the user turn it never gets.
   * An agent's report is queued the same way and is read only for what it says about the agent.
   */
  private async translateQueued(attachment: TranscriptRecord, record: TranscriptRecord): Promise<void> {
    await this.translateNotifications(attachment.prompt);
    if (stringValue(attachment.commandMode) !== "prompt") return;
    // The queue's own id for the item, so a queue written out again under a new record says nothing new.
    const messageId = stringValue(attachment.source_uuid) || stringValue(record.uuid) || stableUuid(JSON.stringify(record));
    const texts = contentTexts(attachment.prompt);
    for (let index = 0; index < texts.length; index += 1) {
      const text = cleanUserText(texts[index] ?? "");
      if (text) await this.emitContent("user_message_chunk", `${messageId}:${index}:queued`, messageId, { type: "text", text });
    }
  }

  private async emitContent(
    sessionUpdate: "user_message_chunk" | "agent_message_chunk" | "agent_thought_chunk",
    key: string,
    sourceMessageId: string,
    content: ContentBlock | null,
  ): Promise<void> {
    if (!content || this.emitted.has(key)) return;
    this.emitted.add(key);
    if (sessionUpdate === "agent_message_chunk") this.assistantChunkCount += 1;
    if (sessionUpdate !== "user_message_chunk") this.lastAssistantActivity = Date.now();
    await this.send({ sessionUpdate, messageId: stableUuid(sourceMessageId), content });
  }

  private async send(update: SessionUpdate): Promise<void> {
    this.lastActivity = Date.now();
    await this.deliver(update);
  }

  private async deliver(update: SessionUpdate): Promise<void> {
    // Ahead of the update it copies, not behind it. The plugin bridge handles a vendor notification
    // where it sits in the stream and an update on a lane of its own, so a copy sent afterwards
    // still arrives first — but only by the depth of that lane, which is whatever a single read off
    // the pipe happened to carry. Sent first it is first by the order of the stream instead.
    if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
      await this.connection.extNotification(TOOL_CALL_MIRROR_METHOD, { sessionId: this.sessionId, update });
    }
    await this.connection.sessionUpdate({ sessionId: this.sessionId, update });
  }

  private reportUnknown(kind: string): void {
    if (this.unknownKinds.has(kind)) return;
    this.unknownKinds.add(kind);
    writeLog({ level: "warn", message: "Unknown Claude transcript kind", sessionId: this.sessionId, kind });
  }
}

/** What Paseo calls the model, where this build knows it, and Claude's own id where it does not. */
function modelName(modelId: string | null): string {
  if (!modelId) return "another model";
  return MODELS.find((model) => model.modelId === modelId)?.name ?? modelId;
}

function stableUuid(value: string): string {
  const bytes = createHash("sha256").update(value).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function objectValue(value: unknown): TranscriptRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as TranscriptRecord) : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** What a record says, written either as one string or as the blocks a richer message has. */
function contentTexts(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap((value) => {
    const block = objectValue(value);
    const text = block?.type === "text" ? stringValue(block.text) : null;
    return text ? [text] : [];
  });
}

function firstNumber(...values: unknown[]): number | null {
  for (const value of values) if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
}

function cleanUserText(text: string): string {
  return text
    .replace(/<(system-reminder|task-notification|user-prompt-submit-hook|local-command-stdout|local-command-stderr|command-message)>[\s\S]*?<\/\1>/g, "")
    .trim();
}

function imageContent(block: TranscriptRecord): ContentBlock | null {
  const source = objectValue(block.source);
  const data = stringValue(source?.data);
  if (!data) return null;
  return { type: "image", data, mimeType: stringValue(source?.media_type) || "image/png" };
}

function toolTitle(name: string, input: TranscriptRecord): string {
  const detail = stringValue(input.description) || stringValue(input.file_path) || stringValue(input.query) || stringValue(input.pattern) || stringValue(input.command)?.split("\n")[0];
  return detail ? `${name}: ${detail}` : name;
}

function toolLocations(input: TranscriptRecord, cwd: string): ToolCallLocation[] {
  const filePath = stringValue(input.file_path) || stringValue(input.path);
  if (!filePath) return [];
  return [{ path: path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath), ...(typeof input.offset === "number" ? { line: input.offset } : {}) }];
}

function toolContents(name: string, input: TranscriptRecord, cwd: string): ToolCallContent[] {
  if (name === "AskUserQuestion" && Array.isArray(input.questions)) {
    const questions = input.questions.flatMap((value) => {
      const question = objectValue(value);
      const text = stringValue(question?.question)?.trim();
      return question && text ? [questionText(question, text)] : [];
    });
    if (questions.length > 0) return [{ type: "content", content: { type: "text", text: questions.join("\n\n") } }];
  }
  const filePath = stringValue(input.file_path) || stringValue(input.notebook_path);
  const resolvedPath = filePath ? (path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath)) : null;
  if ((name === "Edit" || name === "NotebookEdit") && resolvedPath) {
    return [{ type: "diff", path: resolvedPath, oldText: stringValue(input.old_string), newText: stringValue(input.new_string) || "" }];
  }
  if (name === "MultiEdit" && resolvedPath && Array.isArray(input.edits)) {
    return input.edits.flatMap((value) => {
      const edit = objectValue(value);
      return edit ? [{ type: "diff" as const, path: resolvedPath, oldText: stringValue(edit.old_string), newText: stringValue(edit.new_string) || "" }] : [];
    });
  }
  if (name === "Write" && resolvedPath) return [{ type: "diff", path: resolvedPath, newText: stringValue(input.content) || "" }];
  const command = stringValue(input.command);
  return command ? [{ type: "content", content: { type: "text", text: command } }] : [];
}

function resultContent(value: unknown): ToolCallContent[] {
  const blocks = Array.isArray(value) ? value : typeof value === "string" ? [{ type: "text", text: value }] : [];
  const content: ToolCallContent[] = [];
  for (const blockValue of blocks) {
    const block = objectValue(blockValue);
    if (!block) continue;
    if (block.type === "text" && typeof block.text === "string") content.push({ type: "content", content: { type: "text", text: block.text } });
    if (block.type === "image") {
      const image = imageContent(block);
      if (image) content.push({ type: "content", content: image });
    }
  }
  return content;
}

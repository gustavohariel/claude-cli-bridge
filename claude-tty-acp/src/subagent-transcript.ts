import path from "node:path";

const FILE_PREFIX = "agent-";
const FILE_SUFFIX = ".jsonl";

/** How much of one subagent step is kept, and how many steps a card carries before the oldest go. */
const LINE_CHARS = 200;
const LOG_LINES = 40;
/** A card is a ticker for work still in progress, so what a subagent says is its first breath of it. */
const PROSE_CHARS = 120;
/** Beyond this a path is all prefix, and the card has one line to say what a step was. */
const PATH_CHARS = 60;

/**
 * Claude writes each subagent's turns to its own transcript beside the session's, in a directory
 * named after the session file, so the session transcript's path is the only input this needs.
 */
export function subagentsDirectory(transcriptFilePath: string): string {
  return path.join(path.dirname(transcriptFilePath), path.basename(transcriptFilePath, FILE_SUFFIX), "subagents");
}

export function agentIdFromFileName(name: string): string | null {
  if (!name.startsWith(FILE_PREFIX) || !name.endsWith(FILE_SUFFIX)) return null;
  const agentId = name.slice(FILE_PREFIX.length, -FILE_SUFFIX.length);
  return agentId === "" ? null : agentId;
}

/**
 * The agent a tool result launched, taken from the metadata Claude records beside it. A launch that
 * says `async_launched` has only started, which is what keeps its tool call from being closed.
 */
export function launchedAgent(toolUseResult: unknown): { agentId: string; running: boolean } | null {
  const record = asRecord(toolUseResult);
  const agentId = record?.agentId;
  if (typeof agentId !== "string" || agentId === "") return null;
  return { agentId, running: record?.status === "async_launched" };
}

/**
 * The agent a tool result sent a message to, which is the one thing that says an agent whose card is
 * closed is going to run again. Claude names it outright when the message resumes a stopped agent, and
 * names it in the pin it answers with when the message is queued for one that is still going. Both are
 * read the same way: the card is reopened, and the agent's next notification closes it again.
 */
export function messagedAgent(toolUseResult: unknown): { agentId: string } | null {
  const record = asRecord(toolUseResult);
  const resumed = record?.resumedAgentId;
  if (typeof resumed === "string" && resumed !== "") return { agentId: resumed };
  const pinned = asRecord(record?.pin)?.id;
  if (typeof pinned === "string" && pinned !== "") return { agentId: pinned };
  return null;
}

/** The id a background `Bash` result carries, which its notification will name. */
export function launchedBackgroundShell(toolUseResult: unknown): { taskId: string } | null {
  const record = asRecord(toolUseResult);
  const taskId = record?.backgroundTaskId;
  if (typeof taskId !== "string" || taskId === "") return null;
  return { taskId };
}

/**
 * Where a background command's output goes, which Claude says only in the sentence it answers the launch with.
 * The notification names the file too, but by then the command has finished.
 */
export function backgroundOutputFile(text: string): string | null {
  return /Output is being written to: (\S+\.output)/.exec(text)?.[1] ?? null;
}

export type TaskNotification = {
  /** The `<task-id>` the report names, which is an agent's id or a background shell's. */
  taskId: string | null;
  toolCallId: string | null;
  status: string | null;
  summary: string | null;
};

/**
 * Claude reports a background task's outcome by writing a `<task-notification>` into a user turn or a queued command.
 * It is the only record that says an asynchronous agent or a background command has stopped, so it is read before the block is scrubbed out of the text the user sees.
 */
export function parseTaskNotifications(text: string): TaskNotification[] {
  const notifications: TaskNotification[] = [];
  for (const match of text.matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)) {
    const body = match[1] ?? "";
    notifications.push({
      taskId: tag(body, "task-id"),
      toolCallId: tag(body, "tool-use-id"),
      status: tag(body, "status"),
      summary: tag(body, "summary"),
    });
  }
  return notifications;
}

/** Anything but a clean finish reads as a failure, which is all a tool call can say about it. */
export function notificationFailed(status: string | null): boolean {
  return status !== "completed";
}

function tag(body: string, name: string): string | null {
  const match = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(body);
  const value = match?.[1]?.trim();
  return value ? value : null;
}

/**
 * What a subagent has been doing, kept as a bounded tail: a tool call's content is replaced whole
 * on every update, so the card carries the recent steps rather than a transcript that only grows.
 */
export class SubagentLog {
  private readonly lines: string[] = [];
  private dropped = 0;

  append(line: string): void {
    const text = line.replace(/\s+/g, " ").trim();
    if (text === "") return;
    this.lines.push(text.length > LINE_CHARS ? `${text.slice(0, LINE_CHARS - 1)}…` : text);
    while (this.lines.length > LOG_LINES) {
      this.lines.shift();
      this.dropped += 1;
    }
  }

  get empty(): boolean {
    return this.lines.length === 0;
  }

  /** What has been kept, for a log that turns out to belong to another agent's card after all. */
  steps(): string[] {
    return [...this.lines];
  }

  text(): string {
    if (this.lines.length === 0) return "";
    const earlier = this.dropped > 0 ? [`… ${this.dropped} earlier step${this.dropped === 1 ? "" : "s"}`] : [];
    return [...earlier, ...this.lines].join("\n");
  }
}

/**
 * What a subagent said, as a card can show it. The card is rendered as plain text, so markdown
 * arrives as the punctuation it is made of: a report ending in a fenced listing reads as a line of
 * asterisks and backticks.
 */
export function subagentProse(text: string, cwd: string): string {
  const plain = text
    .replace(/```[\s\S]*?(?:```|$)/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    // A path costs the same line here as it does in a step of its own.
    .replace(/\/\S+/g, (token) => shortenPath(token, cwd))
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > PROSE_CHARS ? `${plain.slice(0, PROSE_CHARS - 1)}…` : plain;
}

/** One line for one tool call: what it was for, in the words the subagent had for it. */
export function subagentToolLine(name: string, input: Record<string, unknown>, cwd: string): string {
  // A search is named by what it looked for; the path it looked in is the scope, not the point.
  const filePath = text(input.file_path) ?? text(input.notebook_path) ?? text(input.url) ?? text(input.path);
  const detail =
    text(input.description) ??
    text(input.pattern) ??
    text(input.query) ??
    (filePath === null ? null : shortenPath(filePath, cwd)) ??
    text(input.command);
  return detail === null ? name : `${name}: ${detail}`;
}

/**
 * A path costs a card its whole line, and the head of one is never the part that says which file
 * this is: a scratchpad under `/tmp` is mostly the session ID that owns it.
 */
export function shortenPath(filePath: string, cwd: string): string {
  const relative = filePath.startsWith(`${cwd}/`) ? filePath.slice(cwd.length + 1) : filePath;
  if (relative.length <= PATH_CHARS) return relative;
  const segments = relative.split("/").filter((segment) => segment !== "");
  return segments.length > 2 ? `…/${segments.slice(-2).join("/")}` : relative;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

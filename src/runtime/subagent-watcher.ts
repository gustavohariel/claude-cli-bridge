import { readdir } from "node:fs/promises";
import path from "node:path";
import { writeLog } from "./log.ts";
import { TranscriptReader, type TranscriptRecord } from "./transcript-reader.ts";
import { agentIdFromFileName, subagentsDirectory } from "./subagent-transcript.ts";

/** A subagent's steps are worth following closely, but not as closely as the session's own turn. */
const POLL_INTERVAL_MS = 200;

/** All the transcript watcher needs of one, which is what lets a test stand in for it. */
export type SubagentReads = {
  sync(force?: boolean): Promise<void>;
  open(): void;
  close(): void;
};

export type SubagentSink = {
  translateSubagent(agentId: string, records: TranscriptRecord[]): Promise<void>;
  subagentSettled(agentId: string): boolean;
};

/**
 * Follows the transcript Claude writes for every subagent it runs. The session's own transcript
 * says only that an agent was launched, so without this the whole of a subagent's work — minutes of
 * it, for an asynchronous one — happens with nothing to show for it.
 */
export class SubagentWatcher {
  private readonly directory: string;
  private readonly sink: SubagentSink;
  private readonly cwd: string;
  private readonly pollIntervalMs: number;
  private readonly readers = new Map<string, TranscriptReader>();
  /** Agents read to the end of what they had to say, whose readers are kept for their offset rather than for the reading. */
  private readonly parked = new Set<string>();
  private lastPoll = 0;
  private closed = false;

  constructor(transcriptFilePath: string, sink: SubagentSink, cwd: string, pollIntervalMs = POLL_INTERVAL_MS) {
    this.directory = subagentsDirectory(transcriptFilePath);
    this.sink = sink;
    this.cwd = cwd;
    this.pollIntervalMs = pollIntervalMs;
  }

  /** `force` is for the end of a turn, where the cost of one more read is worth the last word. */
  async sync(force = false): Promise<void> {
    if (this.closed) return;
    const now = Date.now();
    if (!force && now - this.lastPoll < this.pollIntervalMs) return;
    this.lastPoll = now;
    await this.discover();
    for (const [agentId, reader] of [...this.readers]) {
      // A settled agent's transcript is not read at all: a session that runs hundreds of them would
      // otherwise go on stat'ing every finished one five times a second for the rest of its life.
      // Its reader is parked rather than dropped, because it holds how far into the file this has
      // read and an agent can be put back to work -- a message sent to one reopens its card, and a
      // reader starting again from the top would put every step it ever took on that card twice.
      if (this.parked.has(agentId)) {
        if (this.sink.subagentSettled(agentId)) continue;
        this.parked.delete(agentId);
      }
      const { records } = await reader.read().catch(() => ({ records: [] as TranscriptRecord[] }));
      if (records.length > 0) await this.sink.translateSubagent(agentId, records);
      // The read above is the last one an agent that has reported needs, so whatever it wrote on the
      // way out is on the card before its transcript is set aside.
      if (this.sink.subagentSettled(agentId)) this.parked.add(agentId);
    }
  }

  /**
   * Reopened rather than replaced when a suspended session wakes, because the readers hold how far
   * into each subagent's transcript this has read, and a fresh one would stream every step again.
   */
  open(): void {
    this.closed = false;
  }

  close(): void {
    this.closed = true;
  }

  /** A session that has never run a subagent has no directory, which is not a failure to report. */
  private async discover(): Promise<void> {
    let names: string[];
    try {
      names = await readdir(this.directory);
    } catch (error) {
      if (!isMissing(error)) {
        writeLog({ level: "warn", message: "Could not list subagent transcripts", directory: this.directory, error: String(error) });
      }
      return;
    }
    for (const name of names.sort()) {
      const agentId = agentIdFromFileName(name);
      if (agentId === null || this.readers.has(agentId)) continue;
      this.readers.set(agentId, new TranscriptReader(agentId, this.cwd, { filePath: path.join(this.directory, name) }));
    }
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

import type { TranscriptTranslator } from "./transcript-translator.ts";
import { TranscriptReader } from "./transcript-reader.ts";
import type { SubagentReads } from "./subagent-watcher.ts";

const POLL_INTERVAL_MS = 40;
const FLUSH_INTERVAL_MS = 20;
const FLUSH_ATTEMPTS = 15;

export class TranscriptWatcher {
  private readonly reader: TranscriptReader;
  private readonly translator: TranscriptTranslator;
  private readonly pollIntervalMs: number;
  private readonly flushIntervalMs: number;
  private readonly subagents: SubagentReads | null;
  private timer: NodeJS.Timeout | null = null;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    reader: TranscriptReader,
    translator: TranscriptTranslator,
    pollIntervalMs = POLL_INTERVAL_MS,
    subagents: SubagentReads | null = null,
    flushIntervalMs = FLUSH_INTERVAL_MS,
  ) {
    this.reader = reader;
    this.translator = translator;
    this.pollIntervalMs = pollIntervalMs;
    this.subagents = subagents;
    this.flushIntervalMs = flushIntervalMs;
  }

  async start(): Promise<void> {
    if (this.timer) return;
    this.subagents?.open();
    await this.sync();
    this.timer = setInterval(() => void this.sync().catch(() => undefined), this.pollIntervalMs);
    this.timer.unref();
  }

  sync(): Promise<void> {
    const operation = this.queue.then(
      () => this.syncOnce(),
      () => this.syncOnce(),
    );
    this.queue = operation.catch(() => undefined);
    return operation;
  }

  /**
   * Reads until the session's transcript stops growing. `force` is for the end of a turn, where one
   * read past the subagent throttle buys the last word; the flush a hook does before every tool call
   * leaves the throttle alone, because Claude is waiting on it and the subagents are not the point.
   */
  async flushUntilStable(force = false): Promise<void> {
    let previousSize: number | null | undefined;
    let stableReads = 0;
    let sawFile = false;
    for (let attempt = 0; attempt < FLUSH_ATTEMPTS; attempt += 1) {
      const { size, complete } = await this.syncWithState(false);
      if (size !== null) sawFile = true;
      stableReads = sawFile && complete && size === previousSize ? stableReads + 1 : 0;
      if (stableReads >= 2) break;
      previousSize = size;
      await delay(this.flushIntervalMs);
    }
    if (force) await this.syncWithState(true);
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.subagents?.close();
    await this.queue;
  }

  private async syncOnce(): Promise<void> {
    const result = await this.reader.read();
    await this.translator.translate(result.records);
    await this.subagents?.sync();
    await this.translator.refreshBackgroundShells();
  }

  private syncWithState(force: boolean): Promise<{ size: number | null; complete: boolean }> {
    let size: number | null = null;
    let complete = true;
    const read = async () => {
      const result = await this.reader.read();
      size = result.size;
      complete = result.complete;
      await this.translator.translate(result.records);
      await this.subagents?.sync(force);
      await this.translator.refreshBackgroundShells(force);
    };
    const operation = this.queue.then(read, read);
    this.queue = operation.catch(() => undefined);
    return operation.then(() => ({ size, complete }));
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

import { open, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const SIGNATURE_BYTES = 256;

export type TranscriptRecord = Record<string, unknown>;

export type TranscriptRead = {
  records: TranscriptRecord[];
  reset: boolean;
  size: number | null;
  complete: boolean;
};

export type TranscriptReaderOptions = {
  configDir?: string;
  filePath?: string;
};

export class TranscriptReader {
  readonly filePath: string;
  private offset = 0;
  private partialLine = "";
  private signature = "";
  private signatureBytes = 0;

  constructor(sessionId: string, cwd: string, options: TranscriptReaderOptions = {}) {
    const configDir = options.configDir ?? claudeConfigDir();
    this.filePath = options.filePath ?? path.join(configDir, "projects", escapeProjectDirName(cwd), `${sessionId}.jsonl`);
  }

  async read(): Promise<TranscriptRead> {
    let fileStat;
    try {
      fileStat = await stat(this.filePath);
    } catch (error) {
      if (isMissing(error)) return { records: [], reset: false, size: null, complete: true };
      throw error;
    }

    const comparableBytes = this.offset > 0 ? this.signatureBytes : Math.min(SIGNATURE_BYTES, fileStat.size);
    const currentSignature = await readRange(this.filePath, 0, comparableBytes);
    const reset = fileStat.size < this.offset || (this.offset > 0 && currentSignature !== this.signature);
    if (reset) {
      this.offset = 0;
      this.partialLine = "";
      this.signatureBytes = Math.min(SIGNATURE_BYTES, fileStat.size);
      this.signature = await readRange(this.filePath, 0, this.signatureBytes);
    } else if (this.offset === 0) {
      this.signatureBytes = comparableBytes;
      this.signature = currentSignature;
    }

    if (fileStat.size <= this.offset) return { records: [], reset, size: fileStat.size, complete: this.partialLine.length === 0 };
    const chunk = await readRange(this.filePath, this.offset, fileStat.size - this.offset);
    this.offset = fileStat.size;
    const lines = `${this.partialLine}${chunk}`.split("\n");
    this.partialLine = lines.pop() ?? "";
    const records: TranscriptRecord[] = [];
    for (const line of lines) {
      const parsed = parseLine(line);
      if (parsed) records.push(parsed);
    }
    return { records, reset, size: fileStat.size, complete: this.partialLine.length === 0 };
  }
}

export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.CLAUDE_CONFIG_DIR?.trim();
  return configured || path.join(env.HOME || os.homedir(), ".claude");
}

export function escapeProjectDirName(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

async function readRange(filePath: string, start: number, length: number): Promise<string> {
  if (length <= 0) return "";
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function parseLine(line: string): TranscriptRecord | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as TranscriptRecord) : null;
  } catch {
    return null;
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

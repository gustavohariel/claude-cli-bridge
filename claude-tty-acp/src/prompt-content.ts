import { chmod, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { AvailableCommand, ContentBlock } from "@agentclientprotocol/sdk";

const INLINE_RESOURCE_BYTES = 32 * 1024;
const BRACKETED_PASTE_START = "\u001b[200~";
const BRACKETED_PASTE_END = "\u001b[201~";
// Claude collapses a paste of more than three lines, or of more than about 800 characters, into a `[Pasted text]` placeholder, and hands it to the model inside `<pasted_content>` tags as text the user did not write themselves.
// A model told to follow such text only where the user's own message asks it to will then ask what to do with a prompt instead of answering it, since the whole prompt is the paste.
// So a prompt goes in a line at a time, each line as pastes no longer than this, with the newline key between lines: Claude reads every piece inline and the key as typed, and the prompt reaches the model unwrapped.
// Measured against Claude Code v2.1.295: a 4-line paste and a 1,000-character one came back wrapped, 401 lines and 16,710 characters sent this way came back plain.
const PASTE_CHUNK_CHARS = 500;
const NEWLINE_KEY = "\n";
// Claude reads its input in whatever pieces the terminal hands over, and a paste's opening sequence cut between two reads reaches it as text: a 404-line prompt written in one go came back with `200~` at the start of a line.
// So the pieces are written in batches no larger than this, each ending where a piece does, which `PASTE_WRITE_GAP_MS` then spaces out.
const PASTE_WRITE_BYTES = 1024;

export type MaterializedPrompt = {
  text: string;
  files: string[];
};

export async function materializePrompt(content: ContentBlock[], directory: string, cwd: string): Promise<MaterializedPrompt> {
  const parts: string[] = [];
  const files: string[] = [];
  try {
    for (let index = 0; index < content.length; index += 1) {
      const block = content[index]!;
      switch (block.type) {
        case "text":
          parts.push(block.text);
          break;
        case "image": {
          const file = await writeAttachment(directory, `image-${index}${extensionForMime(block.mimeType)}`, Buffer.from(block.data, "base64"));
          files.push(file);
          parts.push(`@${file}`);
          break;
        }
        case "audio":
          throw new Error("ACP audio prompt content is not supported by interactive Claude Code");
        case "resource_link": {
          const file = localResourcePath(block.uri, cwd);
          parts.push(`@${file}`);
          break;
        }
        case "resource": {
          const resource = block.resource;
          if ("text" in resource && Buffer.byteLength(resource.text) <= INLINE_RESOURCE_BYTES) {
            parts.push(`<resource uri=${JSON.stringify(resource.uri)}>\n${resource.text}\n</resource>`);
            break;
          }
          const data = "text" in resource ? Buffer.from(resource.text) : Buffer.from(resource.blob, "base64");
          const mimeType = resource.mimeType ?? ("text" in resource ? "text/plain" : "application/octet-stream");
          const file = await writeAttachment(directory, `resource-${index}${extensionForMime(mimeType)}`, data);
          files.push(file);
          parts.push(`@${file}`);
          break;
        }
      }
    }
    const text = parts.filter((part) => part.length > 0).join("\n");
    if (!text.trim()) throw new Error("Prompt must contain text or an attachment");
    return { text, files };
  } catch (error) {
    await cleanupPromptFiles(files);
    throw error;
  }
}

/**
 * The bracketed pastes a prompt is put into Claude's input box as, in order.
 * Claude collapses a long paste into a `[Pasted text]` placeholder, and a box that starts with one is not a command.
 * So a prompt that starts with a known command has that command pasted on its own and the rest after it, which Claude expands into the command's arguments.
 * Only a known one, because Claude drops a prompt that starts with an unknown command instead of sending it.
 */
export function promptPastes(text: string, commands: readonly AvailableCommand[]): string[] {
  const match = /^\/(\S+)\s*/.exec(text);
  if (!match || !commands.some((command) => command.name === match[1])) return [text];
  const rest = text.slice(match[0].length);
  return rest ? [`/${match[1]}`, rest] : [text];
}

/** The writes that put `text` in Claude's input box as the user's own words: see `PASTE_CHUNK_CHARS` and `PASTE_WRITE_BYTES`. */
export function inputBoxPaste(text: string): string[] {
  const pieces = text.split(/\r?\n/).flatMap((line, index) => {
    const characters = Array.from(line);
    const pastes: string[] = [];
    for (let start = 0; start < characters.length; start += PASTE_CHUNK_CHARS) {
      pastes.push(`${BRACKETED_PASTE_START}${characters.slice(start, start + PASTE_CHUNK_CHARS).join("")}${BRACKETED_PASTE_END}`);
    }
    return index === 0 ? pastes : [NEWLINE_KEY, ...pastes];
  });
  const writes: string[] = [];
  let current = "";
  for (const piece of pieces) {
    if (current !== "" && Buffer.byteLength(current + piece) > PASTE_WRITE_BYTES) {
      writes.push(current);
      current = "";
    }
    current += piece;
  }
  if (current !== "") writes.push(current);
  return writes;
}

export async function cleanupPromptFiles(files: string[]): Promise<void> {
  await Promise.allSettled(files.map((file) => rm(file, { force: true })));
}

function localResourcePath(uri: string, cwd: string): string {
  let candidate: string;
  if (uri.startsWith("file:")) candidate = fileURLToPath(uri);
  else if (path.isAbsolute(uri)) candidate = uri;
  else if (!uri.includes(":")) candidate = path.resolve(cwd, uri);
  else throw new Error(`ACP resource ${uri} is not a host-local file`);
  return path.normalize(candidate);
}

async function writeAttachment(directory: string, name: string, data: Buffer): Promise<string> {
  const file = path.join(directory, name);
  await writeFile(file, data, { mode: 0o600 });
  await chmod(file, 0o600);
  return file;
}

function extensionForMime(mimeType: string): string {
  const normalized = mimeType.toLowerCase().split(";")[0];
  return (
    {
      "image/png": ".png",
      "image/jpeg": ".jpg",
      "image/gif": ".gif",
      "image/webp": ".webp",
      "image/svg+xml": ".svg",
      "text/plain": ".txt",
      "text/markdown": ".md",
      "application/json": ".json",
      "application/pdf": ".pdf",
    }[normalized ?? ""] ?? ".bin"
  );
}

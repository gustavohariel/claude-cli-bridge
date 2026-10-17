import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { cleanupPromptFiles, inputBoxPaste, materializePrompt, promptPastes } from "./prompt-content.ts";

test("materializes images, local links, and bounded resources", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "prompt-content-test-"));
  try {
    const result = await materializePrompt(
      [
        { type: "text", text: "Inspect these" },
        { type: "image", mimeType: "image/png", data: Buffer.from("image").toString("base64") },
        { type: "resource_link", uri: "src/app.ts", name: "app.ts" },
        { type: "resource", resource: { uri: "memory://notes", mimeType: "text/plain", text: "notes" } },
      ],
      directory,
      "/work/project",
    );
    assert.match(result.text, /Inspect these/);
    assert.match(result.text, /@\/work\/project\/src\/app\.ts/);
    assert.match(result.text, /<resource uri="memory:\/\/notes">/);
    assert.equal(await readFile(result.files[0]!, "utf8"), "image");
    assert.equal((await stat(result.files[0]!)).mode & 0o777, 0o600);
    await cleanupPromptFiles(result.files);
    await assert.rejects(stat(result.files[0]!), /ENOENT/);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("rejects audio and non-local links", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "prompt-content-test-"));
  try {
    await assert.rejects(materializePrompt([{ type: "audio", mimeType: "audio/wav", data: "" }], directory, "/work"), /audio prompt content/);
    await assert.rejects(
      materializePrompt([{ type: "resource_link", uri: "https://example.com/file", name: "file" }], directory, "/work"),
      /not a host-local file/,
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("pastes a known command apart from what follows it", () => {
  const commands = [{ name: "implement-spec", description: "" }, { name: "plugin:review", description: "" }];
  assert.deepEqual(promptPastes("/implement-spec https://example.com/88\n<resource>card</resource>", commands), ["/implement-spec", "https://example.com/88\n<resource>card</resource>"]);
  assert.deepEqual(promptPastes("/implement-spec\n@/tmp/image.png", commands), ["/implement-spec", "@/tmp/image.png"]);
  assert.deepEqual(promptPastes("/plugin:review this", commands), ["/plugin:review", "this"]);
  assert.deepEqual(promptPastes("/implement-spec", commands), ["/implement-spec"]);
  assert.deepEqual(promptPastes("/unknown https://example.com\nmore", commands), ["/unknown https://example.com\nmore"]);
  assert.deepEqual(promptPastes("/etc/hosts is broken\nmore", commands), ["/etc/hosts is broken\nmore"]);
  assert.deepEqual(promptPastes("run /implement-spec", commands), ["run /implement-spec"]);
});

test("a prompt goes into Claude's input box a line at a time, each line as pastes short enough not to be collapsed", () => {
  const paste = (text: string) => `\u001b[200~${text}\u001b[201~`;
  assert.deepEqual(inputBoxPaste("one line "), [paste("one line ")]);
  assert.deepEqual(inputBoxPaste("first\r\n\nthird "), [`${paste("first")}\n\n${paste("third ")}`]);
  // A character outside the basic plane is two code units, and a cut between them would leave neither half valid.
  assert.deepEqual(inputBoxPaste("😀".repeat(501)), [paste("😀".repeat(500)), paste("😀")]);
});

test("a long prompt is written in batches that each end where a paste or a line break does", () => {
  const writes = inputBoxPaste(Array.from({ length: 200 }, (_, index) => `line ${index} ${"x".repeat(index % 7 === 0 ? 700 : 40)}`).join("\n"));
  assert.ok(writes.length > 1);
  for (const write of writes) {
    assert.ok(Buffer.byteLength(write) <= 1024 || !write.slice(1).includes("\u001b[200~"), "only a single paste may run past the batch size");
    assert.match(write, /^(\u001b\[200~|\n)/);
    assert.match(write, /(\u001b\[201~|\n)$/);
  }
  const text = writes.join("").replace(/\u001b\[20[01]~/g, "");
  assert.equal(text, Array.from({ length: 200 }, (_, index) => `line ${index} ${"x".repeat(index % 7 === 0 ? 700 : 40)}`).join("\n"));
});

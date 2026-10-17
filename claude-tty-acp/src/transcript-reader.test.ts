import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { escapeProjectDirName, TranscriptReader } from "./transcript-reader.ts";

test("reads appended JSONL records and holds partial lines", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "transcript-reader-test-"));
  const cwd = "/work/repo";
  const sessionId = "11111111-1111-4111-8111-111111111111";
  const projectDir = path.join(root, "projects", escapeProjectDirName(cwd));
  const filePath = path.join(projectDir, `${sessionId}.jsonl`);
  await mkdir(projectDir, { recursive: true });
  await writeFile(filePath, `${JSON.stringify({ type: "user", uuid: "first" })}\n`);
  const reader = new TranscriptReader(sessionId, cwd, { configDir: root });

  try {
    assert.deepEqual((await reader.read()).records.map((record) => record.uuid), ["first"]);
    const second = `${JSON.stringify({ type: "assistant", uuid: "second" })}\n`;
    await appendFile(filePath, second.slice(0, 15));
    const partial = await reader.read();
    assert.deepEqual(partial.records, []);
    assert.equal(partial.complete, false);
    await appendFile(filePath, second.slice(15));
    const complete = await reader.read();
    assert.deepEqual(complete.records.map((record) => record.uuid), ["second"]);
    assert.equal(complete.complete, true);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("replays a transcript after a compaction rewrite", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "transcript-reader-test-"));
  const cwd = "/work/repo";
  const sessionId = "22222222-2222-4222-8222-222222222222";
  const projectDir = path.join(root, "projects", escapeProjectDirName(cwd));
  const filePath = path.join(projectDir, `${sessionId}.jsonl`);
  await mkdir(projectDir, { recursive: true });
  await writeFile(filePath, `${JSON.stringify({ type: "user", uuid: "before", text: "a".repeat(300) })}\n`);
  const reader = new TranscriptReader(sessionId, cwd, { configDir: root });

  try {
    await reader.read();
    await writeFile(filePath, `${JSON.stringify({ type: "user", uuid: "after", text: "b".repeat(320) })}\n`);
    const rewritten = await reader.read();
    assert.equal(rewritten.reset, true);
    assert.deepEqual(rewritten.records.map((record) => record.uuid), ["after"]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("waits for delayed transcript creation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "transcript-reader-test-"));
  const cwd = "/work/repo";
  const sessionId = "33333333-3333-4333-8333-333333333333";
  const reader = new TranscriptReader(sessionId, cwd, { configDir: root });

  try {
    assert.equal((await reader.read()).size, null);
    const projectDir = path.join(root, "projects", escapeProjectDirName(cwd));
    await mkdir(projectDir, { recursive: true });
    await writeFile(path.join(projectDir, `${sessionId}.jsonl`), `${JSON.stringify({ type: "user", uuid: "late" })}\n`);
    assert.deepEqual((await reader.read()).records.map((record) => record.uuid), ["late"]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

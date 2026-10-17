import assert from "node:assert/strict";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { answersFileName, takeCardAnswers } from "./card-answers.ts";

async function directoryWith(cardId: string, contents: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "claude-tty-acp-card-answers-"));
  await writeFile(path.join(directory, answersFileName(cardId)), contents);
  return directory;
}

test("reads the answers left for a card once, and drops the document", async () => {
  const directory = await directoryWith("toolu_1-questions", JSON.stringify({ answers: { "Which way?": "Left" } }));

  assert.deepEqual(await takeCardAnswers("toolu_1-questions", directory), { "Which way?": "Left" });
  assert.deepEqual(await readdir(directory), []);
  assert.equal(await takeCardAnswers("toolu_1-questions", directory), null);
});

test("reads a card nobody answered as no answers rather than as a failure", async () => {
  const directory = await directoryWith("other-questions", "{}");

  assert.equal(await takeCardAnswers("toolu_2-questions", directory), null);
  assert.equal(await takeCardAnswers("toolu_2-questions", null), null);
});

test("ignores a document that holds anything but answers", async () => {
  const malformed = await directoryWith("card", "{ not json");
  const wrongShape = await directoryWith("card", JSON.stringify({ answers: "Left" }));

  assert.equal(await takeCardAnswers("card", malformed), null);
  assert.equal(await takeCardAnswers("card", wrongShape), null);
});

test("names the same file the plugin writes, whatever a tool use id carries", async () => {
  assert.equal(answersFileName("toolu_01A/../b-questions"), "toolu_01A-..-b-questions.json");
});

import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { readOutputTail } from "./background-output.ts";

test("reads the end of a command's output as plain text, from the first whole line", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "claude-tty-output-"));
  const file = path.join(directory, "b1.output");
  await writeFile(file, `${"early line\n".repeat(20)}\x1b]0;title\x07\x1b[1mlast\x1b[0m line\r\n`);

  assert.equal(await readOutputTail(file, 60), "…early line\nearly line\nlast line");
  // A tail that is all one line keeps what it has of it.
  const oneLine = path.join(directory, "b2.output");
  await writeFile(oneLine, `${"x".repeat(50)}\n`);
  assert.equal(await readOutputTail(oneLine, 10), `…${"x".repeat(9)}`);
  assert.equal(await readOutputTail(path.join(directory, "missing.output")), null);
});

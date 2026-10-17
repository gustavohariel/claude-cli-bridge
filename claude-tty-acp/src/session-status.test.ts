import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { claudeIsWaitingFor } from "./session-status.ts";

async function configDirectoryHolding(state: string | null, claudePid = 4242): Promise<string> {
  const configDirectory = await mkdtemp(path.join(os.tmpdir(), "claude-session-status-test-"));
  if (state !== null) {
    await mkdir(path.join(configDirectory, "sessions"), { recursive: true });
    await writeFile(path.join(configDirectory, "sessions", `${claudePid}.json`), state);
  }
  return configDirectory;
}

test("names what Claude says is holding the keyboard", async () => {
  const configDirectory = await configDirectoryHolding(JSON.stringify({ pid: 4242, status: "waiting", waitingFor: "dialog open" }));
  try {
    assert.equal(await claudeIsWaitingFor(4242, configDirectory), "dialog open");
  } finally {
    await rm(configDirectory, { force: true, recursive: true });
  }
});

test("says a session that is only working or idle is holding nothing", async () => {
  for (const status of ["idle", "busy", "shell"]) {
    const configDirectory = await configDirectoryHolding(JSON.stringify({ pid: 4242, status }));
    try {
      assert.equal(await claudeIsWaitingFor(4242, configDirectory), null);
    } finally {
      await rm(configDirectory, { force: true, recursive: true });
    }
  }
});

test("still refuses on a wait Claude has no name for, rather than reading it as free", async () => {
  const configDirectory = await configDirectoryHolding(JSON.stringify({ pid: 4242, status: "waiting" }));
  try {
    assert.equal(await claudeIsWaitingFor(4242, configDirectory), "an answer");
  } finally {
    await rm(configDirectory, { force: true, recursive: true });
  }
});

test("claims nothing where there is nothing to read", async () => {
  // A Claude too old to write the file, the file for another process, and one caught half-written: each
  // leaves the caller where it stood before this was here, rather than failing a turn on a guess.
  const missing = await configDirectoryHolding(null);
  const halfWritten = await configDirectoryHolding('{"pid":4242,"status":"wait');
  try {
    assert.equal(await claudeIsWaitingFor(4242, missing), null);
    assert.equal(await claudeIsWaitingFor(4242, halfWritten), null);
    assert.equal(await claudeIsWaitingFor(undefined, halfWritten), null);
  } finally {
    await rm(missing, { force: true, recursive: true });
    await rm(halfWritten, { force: true, recursive: true });
  }
});

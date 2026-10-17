import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SessionLock } from "./session-lock.ts";

const SESSION_ID = "77777777-7777-4777-8777-777777777777";

test("rejects a second live owner and releases only its own lock", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "session-lock-test-"));
  const first = new SessionLock(SESSION_ID, root);
  const second = new SessionLock(SESSION_ID, root);
  try {
    await first.acquire();
    await assert.rejects(second.acquire(), /already active/);
    await first.release();
    await second.acquire();
    await second.release();
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("recovers an abandoned or malformed lock", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "session-lock-test-"));
  await mkdir(root, { recursive: true });
  const lockPath = path.join(root, `${SESSION_ID}.lock`);
  const lock = new SessionLock(SESSION_ID, root);
  try {
    await writeFile(lockPath, `${JSON.stringify({ pid: 2_147_483_647, token: "stale", createdAt: 1 })}\n`);
    await lock.acquire();
    await lock.release();
    await writeFile(lockPath, "not-json\n");
    await lock.acquire();
    await lock.release();
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

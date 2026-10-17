import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { cleanupAbandonedRuntimeDirectories, markRuntimeDirectory } from "./runtime-directories.ts";

test("removes dead runtime directories and preserves live owners", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "runtime-cleanup-test-"));
  const live = path.join(root, "claude-tty-acp-live");
  const dead = path.join(root, "claude-tty-acp-dead");
  try {
    await markRuntimeDirectory(live);
    await mkdir(dead, { recursive: true });
    await writeFile(path.join(dead, "owner.json"), JSON.stringify({ pid: 999_999_999 }));
    await cleanupAbandonedRuntimeDirectories(root);
    assert.ok(await stat(live));
    await assert.rejects(stat(dead), /ENOENT/);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

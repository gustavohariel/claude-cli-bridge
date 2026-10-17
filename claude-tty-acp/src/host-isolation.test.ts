import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { HookServer } from "./hook-server.ts";
import { SessionLock } from "./session-lock.ts";
import { StateStore } from "./state-store.ts";

test("keeps identical provider sessions independent on two hosts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "host-isolation-test-"));
  const sessionId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const localStore = new StateStore(path.join(root, "local"));
  const remoteStore = new StateStore(path.join(root, "remote"));
  const localLock = new SessionLock(sessionId, localStore.locksDirectory);
  const remoteLock = new SessionLock(sessionId, remoteStore.locksDirectory);
  const localHooks = new HookServer();
  const remoteHooks = new HookServer();
  try {
    await Promise.all([
      localStore.save({ version: 1, acpSessionId: sessionId, claudeSessionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", cwd: "/local/work", model: "sonnet", mode: "default", lastActivity: 1 }),
      remoteStore.save({ version: 1, acpSessionId: sessionId, claudeSessionId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", cwd: "/remote/work", model: "opus", mode: "plan", lastActivity: 2 }),
      localLock.acquire(),
      remoteLock.acquire(),
      localHooks.start(),
      remoteHooks.start(),
    ]);
    assert.equal((await localStore.load(sessionId))?.cwd, "/local/work");
    assert.equal((await remoteStore.load(sessionId))?.cwd, "/remote/work");
    const localRegistration = localHooks.register(sessionId, async () => ({}));
    const remoteRegistration = remoteHooks.register(sessionId, async () => ({}));
    assert.notEqual(new URL(localRegistration.endpoint).port, new URL(remoteRegistration.endpoint).port);
    assert.notEqual(localRegistration.endpoint, remoteRegistration.endpoint);
    localRegistration.unregister();
    remoteRegistration.unregister();
  } finally {
    await Promise.allSettled([localLock.release(), remoteLock.release(), localHooks.close(), remoteHooks.close()]);
    await rm(root, { force: true, recursive: true });
  }
});

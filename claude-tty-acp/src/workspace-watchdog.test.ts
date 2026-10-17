import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WorkspaceWatchdog, watchDirectory } from "./workspace-watchdog.ts";

const settle = async (ms: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, ms));
};

const waitFor = async (predicate: () => boolean, message: string, timeoutMs = 2_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await settle(1);
  }
};

test("stops the adapter once a session's directory has stayed gone", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "claude-tty-workspace-"));
  const reports: boolean[] = [];
  const stop = watchDirectory(directory, (present) => {
    reports.push(present);
  }, 10);
  try {
    await settle(60);
    assert.deepEqual(reports, [], "gave up on a directory that was still there");

    await rm(directory, { force: true, recursive: true });
    await waitFor(() => reports.length === 1, "did not stop for a directory that had gone");
    assert.deepEqual(reports, [false]);

    // A directory that stays gone is reported once, not on every check after.
    await settle(60);
    assert.deepEqual(reports, [false]);
  } finally {
    stop();
    await rm(directory, { force: true, recursive: true });
  }
});

test("serves a session again whose directory comes back", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "claude-tty-workspace-returned-"));
  const directory = path.join(parent, "workspace");
  await mkdir(directory);
  const reports: boolean[] = [];
  const stop = watchDirectory(directory, (present) => {
    reports.push(present);
  }, 10);
  try {
    await rm(directory, { force: true, recursive: true });
    await waitFor(() => reports.length === 1, "did not report a directory that had gone");

    await mkdir(directory);
    await waitFor(() => reports.length === 2, "did not report a directory that came back");
    assert.deepEqual(reports, [false, true]);

    await rm(directory, { force: true, recursive: true });
    await waitFor(() => reports.length === 3, "did not report a returned directory going again");
    assert.deepEqual(reports, [false, true, false]);
  } finally {
    stop();
    await rm(parent, { force: true, recursive: true });
  }
});

test("keeps a session whose directory is replaced rather than removed", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "claude-tty-workspace-replaced-"));
  const directory = path.join(parent, "workspace");
  await mkdir(directory);
  const reports: boolean[] = [];
  // Four misses are asked for and the directory is back well inside them, so the checks that miss it are real ones — the count has to be reset by its return rather than never reached.
  const stop = watchDirectory(directory, (present) => {
    reports.push(present);
  }, 50, 4);
  try {
    await rm(directory, { force: true, recursive: true });
    await settle(120);
    await mkdir(directory);
    await settle(300);
    assert.deepEqual(reports, [], "stopped a session whose workspace was only replaced");
  } finally {
    stop();
    await rm(parent, { force: true, recursive: true });
  }
});

test("keeps a session whose directory cannot be read for any other reason", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "claude-tty-workspace-unreadable-"));
  const file = path.join(parent, "not-a-directory");
  await writeFile(file, "");
  const reports: boolean[] = [];
  // Anything under a regular file fails with ENOTDIR rather than ENOENT, which is a failure to look and not a directory that has gone.
  const stop = watchDirectory(path.join(file, "workspace"), (present) => {
    reports.push(present);
  }, 10);
  try {
    await settle(120);
    assert.deepEqual(reports, [], "stopped a session over a directory it could not read");
  } finally {
    stop();
    await rm(parent, { force: true, recursive: true });
  }
});

test("waits for every session's directory to go before stopping the adapter", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "claude-tty-workspaces-"));
  const first = path.join(parent, "first");
  const second = path.join(parent, "second");
  await mkdir(first);
  await mkdir(second);
  let stopped = 0;
  const watchdog = new WorkspaceWatchdog(() => {
    stopped += 1;
  }, 10);
  try {
    watchdog.watch("session-1", first);
    watchdog.watch("session-2", second);

    await rm(first, { force: true, recursive: true });
    await settle(120);
    assert.equal(stopped, 0, "stopped an adapter that still had a session to serve");

    await rm(second, { force: true, recursive: true });
    await waitFor(() => stopped === 1, "did not stop an adapter whose every session had gone");
    await settle(60);
    assert.equal(stopped, 1, "stopped the adapter more than once");
  } finally {
    watchdog.stop();
    await rm(parent, { force: true, recursive: true });
  }
});

test("keeps the adapter for a session whose directory came back while another's went", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "claude-tty-workspaces-returned-"));
  const first = path.join(parent, "first");
  const second = path.join(parent, "second");
  await mkdir(first);
  await mkdir(second);
  let stopped = 0;
  const watchdog = new WorkspaceWatchdog(() => {
    stopped += 1;
  }, 10);
  try {
    watchdog.watch("session-1", first);
    watchdog.watch("session-2", second);

    await rm(first, { force: true, recursive: true });
    await settle(120);
    await mkdir(first);
    await settle(120);

    await rm(second, { force: true, recursive: true });
    await settle(120);
    assert.equal(stopped, 0, "stopped an adapter whose first session had its directory back");

    await rm(first, { force: true, recursive: true });
    await waitFor(() => stopped === 1, "did not stop an adapter whose every session had gone");
  } finally {
    watchdog.stop();
    await rm(parent, { force: true, recursive: true });
  }
});

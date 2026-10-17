import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { disableLogFile, enableLogFile, logFilePath, writeLog } from "./log.ts";

// Mode bits are what the two failure tests take the file away with, and root is not subject to them.
const unwritable = process.getuid?.() === 0 ? { skip: "runs as root, which mode bits do not stop" } : {};

test("keeps the log under the state directory, beside the sessions it is about", () => {
  assert.equal(logFilePath({ CLAUDE_TTY_ACP_STATE_DIR: "/state/here" }), path.join("/state/here", "logs", "claude-tty-acp.log"));
  assert.equal(logFilePath({ HOME: "/home/someone" }), path.join("/home/someone", ".local", "state", "claude-tty-acp", "logs", "claude-tty-acp.log"));
});

test("writes every record to the file once it is enabled, and moves a full file aside", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "claude-tty-log-test-"));
  const file = path.join(root, "nested", "adapter.log");
  const stderr = process.stderr.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    enableLogFile(file, 200);
    writeLog({ level: "info", message: "first", sessionId: "s1" });
    const lines = (await readFile(file, "utf8")).trim().split("\n");
    assert.equal(lines.length, 1);
    const record = JSON.parse(lines[0]!);
    assert.equal(record.message, "first");
    assert.equal(record.sessionId, "s1");
    assert.equal(record.pid, process.pid);
    assert.equal(typeof record.time, "string");

    writeLog({ level: "info", message: "second", padding: "x".repeat(200) });
    // The file is over its size now, so the next record starts a new one and the old one is kept once.
    writeLog({ level: "info", message: "third" });
    const rotated = (await readFile(`${file}.1`, "utf8")).trim().split("\n");
    assert.deepEqual(
      rotated.map((line) => JSON.parse(line).message),
      ["first", "second"],
    );
    const current = (await readFile(file, "utf8")).trim().split("\n");
    assert.deepEqual(
      current.map((line) => JSON.parse(line).message),
      ["third"],
    );

    disableLogFile();
    writeLog({ level: "info", message: "fourth" });
    assert.equal((await stat(file)).size, Buffer.byteLength(`${current[0]}\n`));
  } finally {
    process.stderr.write = stderr;
    disableLogFile();
    await rm(root, { force: true, recursive: true });
  }
});

test("keeps logging when the file cannot be written, and says so once", unwritable, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "claude-tty-log-fail-"));
  const readOnly = path.join(root, "read-only");
  await mkdir(readOnly);
  await chmod(readOnly, 0o500);
  const written: string[] = [];
  const stderr = process.stderr.write;
  process.stderr.write = ((line: string) => {
    written.push(line);
    return true;
  }) as typeof process.stderr.write;
  try {
    // A directory that cannot be made is reported and gives up on the file, rather than throwing
    // into the server's first statement and taking every session on the host down with it.
    assert.equal(enableLogFile(path.join(readOnly, "logs", "adapter.log")), null);
    writeLog({ level: "info", message: "still running" });
    writeLog({ level: "info", message: "still running too" });

    const warnings = written.map((line) => JSON.parse(line)).filter((record) => record.message === "Could not write the adapter log file");
    assert.equal(warnings.length, 1, "the failure is reported once, not per record");
    assert.match(warnings[0]!.error, /EACCES|EPERM/);
    assert.deepEqual(
      written.map((line) => JSON.parse(line).message).filter((message) => message.startsWith("still running")),
      ["still running", "still running too"],
    );
  } finally {
    process.stderr.write = stderr;
    disableLogFile();
    await chmod(readOnly, 0o700);
    await rm(root, { force: true, recursive: true });
  }
});

test("reports a file that goes unwritable under it without failing the record", unwritable, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "claude-tty-log-lost-"));
  const directory = path.join(root, "logs");
  const file = path.join(directory, "adapter.log");
  const written: string[] = [];
  const stderr = process.stderr.write;
  process.stderr.write = ((line: string) => {
    written.push(line);
    return true;
  }) as typeof process.stderr.write;
  try {
    assert.equal(enableLogFile(file), file);
    writeLog({ level: "info", message: "before" });
    await rm(file);
    await chmod(directory, 0o500);
    assert.doesNotThrow(() => writeLog({ level: "info", message: "after" }));

    const warnings = () => written.map((line) => JSON.parse(line)).filter((record) => record.message === "Could not write the adapter log file");
    assert.equal(warnings().length, 1);
    assert.equal(warnings()[0]!.file, file);

    // A spell of failure is reported once, and the next one is reported again: a file that comes
    // back and goes away later has two failures to tell about, not one and then silence.
    await chmod(directory, 0o700);
    writeLog({ level: "info", message: "recovered" });
    await rm(file);
    await chmod(directory, 0o500);
    writeLog({ level: "info", message: "gone again" });
    assert.equal(warnings().length, 2);
  } finally {
    process.stderr.write = stderr;
    disableLogFile();
    await chmod(directory, 0o700);
    await rm(root, { force: true, recursive: true });
  }
});

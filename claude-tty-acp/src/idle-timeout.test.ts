import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DEFAULT_IDLE_TIMEOUT_MS,
  IDLE_TIMEOUT_ENV,
  MAX_IDLE_TIMEOUT_MS,
  idleTimeoutFromEnv,
  parseIdleTimeout,
  readIdleTimeout,
} from "./idle-timeout.ts";
import { useSettingsFile } from "./settings-document.ts";

async function withSettingsFile(contents: string | null, run: (filePath: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "claude-tty-idle-"));
  const filePath = path.join(directory, "settings.json");
  try {
    if (contents !== null) await writeFile(filePath, contents);
    await run(filePath);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

test("takes decimal integers in range and nothing else", () => {
  assert.equal(parseIdleTimeout("900000"), 900_000);
  assert.equal(parseIdleTimeout(" 0 "), 0);
  assert.equal(parseIdleTimeout(900_000), 900_000);
  assert.equal(parseIdleTimeout(String(MAX_IDLE_TIMEOUT_MS)), MAX_IDLE_TIMEOUT_MS);
  for (const rejected of ["soon", "-1", "1.5", "0x1c", "1e3", "", String(MAX_IDLE_TIMEOUT_MS + 1), null, true]) {
    assert.equal(parseIdleTimeout(rejected), null, `expected ${String(rejected)} to be rejected`);
  }
});

test("reports a malformed environment value instead of failing the process over it", () => {
  assert.equal(idleTimeoutFromEnv({}), null);
  assert.equal(idleTimeoutFromEnv({ [IDLE_TIMEOUT_ENV]: "900000" }), 900_000);
  assert.equal(idleTimeoutFromEnv({ [IDLE_TIMEOUT_ENV]: "0" }), 0);
  assert.equal(idleTimeoutFromEnv({ [IDLE_TIMEOUT_ENV]: "soon" }), null);
  assert.equal(idleTimeoutFromEnv({ [IDLE_TIMEOUT_ENV]: "2147483648" }), null);
});

test("defaults idle suspension to one hour when nothing configures it", async () => {
  assert.equal(await readIdleTimeout({}, null), DEFAULT_IDLE_TIMEOUT_MS);
  await withSettingsFile(null, async (filePath) => {
    assert.equal(await readIdleTimeout({}, filePath), DEFAULT_IDLE_TIMEOUT_MS);
  });
});

test("reads the timeout the plugin left, including a zero that disables suspension", async () => {
  await withSettingsFile(JSON.stringify({ idleTimeoutMs: 900_000 }), async (filePath) => {
    assert.equal(await readIdleTimeout({}, filePath), 900_000);
  });
  await withSettingsFile(JSON.stringify({ idleTimeoutMs: 0 }), async (filePath) => {
    assert.equal(await readIdleTimeout({}, filePath), 0);
  });
});

test("takes the document named at spawn as the default for every later read", async () => {
  await withSettingsFile(JSON.stringify({ idleTimeoutMs: 900_000 }), async (filePath) => {
    useSettingsFile(filePath);
    try {
      assert.equal(await readIdleTimeout({}), 900_000);
    } finally {
      useSettingsFile(null);
    }
  });
  assert.equal(await readIdleTimeout({}), DEFAULT_IDLE_TIMEOUT_MS);
});

test("lets the environment variable override the saved setting", async () => {
  await withSettingsFile(JSON.stringify({ idleTimeoutMs: 900_000 }), async (filePath) => {
    assert.equal(await readIdleTimeout({ [IDLE_TIMEOUT_ENV]: "60000" }, filePath), 60_000);
  });
});

test("falls back to the default for a settings document it cannot use", async () => {
  const unusable = ["not json", JSON.stringify([]), JSON.stringify({}), JSON.stringify({ idleTimeoutMs: "soon" })];
  for (const contents of unusable) {
    await withSettingsFile(contents, async (filePath) => {
      assert.equal(await readIdleTimeout({}, filePath), DEFAULT_IDLE_TIMEOUT_MS);
    });
  }
});

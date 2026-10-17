import assert from "node:assert/strict";
import test from "node:test";
import { parseCliArgs } from "./cli-options.ts";
import { APP_VERSION } from "./constants.ts";

test("serves ACP when no CLI flags are passed", () => {
  assert.deepEqual(parseCliArgs([]), { kind: "serve", settingsFile: null, answersDirectory: null });
});

test("takes the paths the plugin names at spawn, in either order", () => {
  assert.deepEqual(parseCliArgs(["--settings-file", "/paseo/plugin-settings/claude-tty/settings.json"]), {
    kind: "serve",
    settingsFile: "/paseo/plugin-settings/claude-tty/settings.json",
    answersDirectory: null,
  });
  assert.deepEqual(parseCliArgs(["--answers-dir", "/state/card-answers", "--settings-file", "/settings.json"]), {
    kind: "serve",
    settingsFile: "/settings.json",
    answersDirectory: "/state/card-answers",
  });
});

test("rejects a path flag without a path, and a flag given twice", () => {
  assert.throws(() => parseCliArgs(["--settings-file"]), /Unknown arguments/);
  assert.throws(() => parseCliArgs(["--settings-file", "--json"]), /Unknown arguments/);
  assert.throws(() => parseCliArgs(["--settings-file", ""]), /Unknown arguments/);
  assert.throws(() => parseCliArgs(["--answers-dir"]), /Unknown arguments/);
  assert.throws(() => parseCliArgs(["--answers-dir", "/a", "--answers-dir", "/b"]), /Unknown arguments/);
});

test("prints help and version without starting ACP", () => {
  const help = parseCliArgs(["--help"]);
  assert.equal(help.kind, "print");
  assert.match(help.text, /Usage:/);
  assert.deepEqual(parseCliArgs(["--version"]), { kind: "print", text: APP_VERSION });
});

test("selects host diagnostics", () => {
  assert.deepEqual(parseCliArgs(["--diagnose"]), { kind: "diagnose", json: false });
});

test("selects machine-readable diagnostics with the flags in either order", () => {
  assert.deepEqual(parseCliArgs(["--diagnose", "--json"]), { kind: "diagnose", json: true });
  assert.deepEqual(parseCliArgs(["--json", "--diagnose"]), { kind: "diagnose", json: true });
});

test("rejects --json without --diagnose", () => {
  assert.throws(() => parseCliArgs(["--json"]), /Unknown arguments/);
  assert.throws(() => parseCliArgs(["--json", "--json"]), /Unknown arguments/);
  assert.throws(() => parseCliArgs(["--diagnose", "--diagnose"]), /Unknown arguments/);
});

test("rejects unknown flags", () => {
  assert.throws(() => parseCliArgs(["--wat"]), /Unknown arguments/);
});

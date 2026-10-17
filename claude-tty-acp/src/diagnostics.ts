import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { defaultStateDirectory } from "./state-store.ts";

/** Stable across releases, so a caller can key off a check without matching its label or detail. */
export type CheckId = "node" | "claude" | "config" | "state";

export type Check = { id: CheckId; label: string; ok: boolean; detail: string };

export type Diagnostics = { output: string; ok: boolean; checks: Check[] };

export async function runDiagnostics(): Promise<Diagnostics> {
  const checks = await Promise.all([checkNode(), checkClaude(), checkConfig(), checkState()]);
  const lines = checks.map((check) => `${check.ok ? "OK" : "FAIL"}  ${check.label}: ${check.detail}`);
  if (checks.some((check) => !check.ok)) lines.push("Fix failed checks before configuring this executable as a Paseo provider.");
  return { output: `${lines.join("\n")}\n`, ok: checks.every((check) => check.ok), checks };
}

async function checkNode(): Promise<Check> {
  const major = Number(process.versions.node.split(".")[0]);
  return { id: "node", label: "Node.js", ok: major >= 22, detail: `${process.version}${major >= 22 ? "" : " (22 or newer required)"}` };
}

async function checkClaude(): Promise<Check> {
  const command = process.env.CLAUDE_BIN?.trim() || "claude";
  const result = spawnSync(command, ["--version"], { encoding: "utf8", env: process.env, timeout: 10_000 });
  if (result.error) return { id: "claude", label: "Claude CLI", ok: false, detail: `${command}: ${result.error.message}` };
  if (result.status !== 0) return { id: "claude", label: "Claude CLI", ok: false, detail: `${command} exited ${result.status}: ${(result.stderr || result.stdout).trim()}` };
  return { id: "claude", label: "Claude CLI", ok: true, detail: `${command} (${result.stdout.trim() || "version reported"})` };
}

async function checkConfig(): Promise<Check> {
  const directory = process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(process.env.HOME ?? os.homedir(), ".claude");
  try {
    await access(directory);
    return { id: "config", label: "Claude config", ok: true, detail: directory };
  } catch {
    return { id: "config", label: "Claude config", ok: false, detail: `${directory} is not accessible; run Claude interactively to authenticate` };
  }
}

async function checkState(): Promise<Check> {
  const directory = defaultStateDirectory();
  const probe = path.join(directory, `.diagnostic-${randomUUID()}`);
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(probe, "ok\n", { mode: 0o600 });
    await rm(probe, { force: true });
    return { id: "state", label: "State directory", ok: true, detail: directory };
  } catch (error) {
    return { id: "state", label: "State directory", ok: false, detail: `${directory}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

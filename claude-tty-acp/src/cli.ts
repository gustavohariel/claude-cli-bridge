#!/usr/bin/env node

import { parseCliArgs } from "./cli-options.ts";
import { APP_VERSION } from "./constants.ts";
import { runDiagnostics } from "./diagnostics.ts";
import { writeLog } from "./log.ts";
import { runAcpServer } from "./main.ts";

async function main(): Promise<void> {
  const action = parseCliArgs(process.argv.slice(2));
  if (action.kind === "print") {
    process.stdout.write(`${action.text.trimEnd()}\n`);
    return;
  }
  if (action.kind === "diagnose") {
    const diagnostics = await runDiagnostics();
    process.stdout.write(action.json ? `${JSON.stringify({ version: APP_VERSION, ok: diagnostics.ok, checks: diagnostics.checks })}\n` : diagnostics.output);
    if (!diagnostics.ok) process.exitCode = 1;
    return;
  }
  await runAcpServer(action.settingsFile, action.answersDirectory);
}

main().catch((error: unknown) => {
  writeLog({
    level: "error",
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
  process.exitCode = 1;
});

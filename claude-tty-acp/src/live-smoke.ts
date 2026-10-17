import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { Readable, Writable } from "node:stream";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ClientSideConnection, PROTOCOL_VERSION, ndJsonStream, type Client, type SessionNotification } from "@agentclientprotocol/sdk";

const EXPECTED = "PASEO_ACP_SMOKE_OK";
const TIMEOUT_MS = 120_000;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === "--") args.shift();
  const cwd = path.resolve(args[0] ?? process.cwd());
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "claude-tty-acp-smoke-"));
  const executable = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../bin/claude-tty-acp");
  const child = spawn(executable, [], {
    cwd,
    env: { ...process.env, CLAUDE_TTY_ACP_STATE_DIR: stateDirectory },
    stdio: ["pipe", "pipe", "pipe"],
  });
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
  } catch (error) {
    await rm(stateDirectory, { force: true, recursive: true });
    throw error;
  }
  child.stderr.pipe(process.stderr);
  const messages: string[] = [];
  const client: Client = {
    requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
    sessionUpdate: async (notification: SessionNotification) => {
      const update = notification.update;
      if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") messages.push(update.content.text);
    },
  };
  const connection = new ClientSideConnection(
    () => client,
    ndJsonStream(Writable.toWeb(child.stdin) as WritableStream<Uint8Array>, Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>),
  );
  let timer: NodeJS.Timeout | undefined;
  try {
    await connection.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {}, clientInfo: { name: "claude-tty-acp-smoke", version: "1" } });
    const session = await connection.newSession({ cwd, mcpServers: [] });
    const turn = connection.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: `Reply with exactly ${EXPECTED}. Do not use tools.` }],
    });
    const response = await Promise.race([
      turn,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Smoke prompt timed out after ${TIMEOUT_MS}ms`)), TIMEOUT_MS);
      }),
    ]).catch(async (error) => {
      await connection.cancel({ sessionId: session.sessionId }).catch(() => undefined);
      throw error;
    });
    if (response.stopReason !== "end_turn") throw new Error(`Smoke prompt stopped with ${response.stopReason}`);
    if (!messages.join("").includes(EXPECTED)) throw new Error(`Claude response did not contain ${EXPECTED}`);
    process.stdout.write(`Interactive ACP smoke test passed in ${cwd}\n`);
  } finally {
    if (timer) clearTimeout(timer);
    child.stdin.end();
    await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 3_000))]);
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 3_000))]);
    }
    await rm(stateDirectory, { force: true, recursive: true });
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

import { Readable, Writable } from "node:stream";
import { AgentSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";
import { ClaudeTtyAgent } from "./agent.ts";
import { useAnswersDirectory } from "./card-answers.ts";
import { readIdleTimeout } from "./idle-timeout.ts";
import { enableLogFile, writeLog } from "./log.ts";
import { cleanupAbandonedRuntimeDirectories } from "./runtime-directories.ts";
import { useSettingsFile } from "./settings-document.ts";

export async function runAcpServer(settingsFile: string | null, answersDirectory: string | null = null): Promise<void> {
  // The daemon reads stderr and keeps none of it, so the server also writes its log to disk.
  // A host that cannot hold the file has already said so on stderr, and still serves its sessions.
  const logFile = enableLogFile();
  if (logFile) writeLog({ level: "info", message: "Writing the adapter log to a file as well", file: logFile });
  await cleanupAbandonedRuntimeDirectories();
  useSettingsFile(settingsFile);
  useAnswersDirectory(answersDirectory);
  // Only reported here; each suspension reads the value again so a change in Paseo reaches sessions that are already connected.
  writeLog({ level: "info", message: "Resolved the idle timeout", idleTimeoutMs: await readIdleTimeout(), settingsFile, answersDirectory });
  const input = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;
  const output = Writable.toWeb(process.stdout) as WritableStream<Uint8Array>;
  let agent: ClaudeTtyAgent | null = null;

  const shutdown = async (signal: string): Promise<void> => {
    writeLog({ level: "info", message: "Stopping ACP adapter", signal });
    await agent?.close();
  };

  const connection = new AgentSideConnection((activeConnection) => {
    agent = new ClaudeTtyAgent(activeConnection, {
      // Nothing else will end the process: the connection is still open.
      onWorkspacesRemoved: () => {
        writeLog({ level: "warn", message: "Stopping the adapter: the directory of every session it holds is gone" });
        void shutdown("workspace_removed").finally(() => process.exit(0));
      },
    });
    return agent;
  }, ndJsonStream(output, input));

  const handleSignal = (signal: NodeJS.Signals): void => {
    void shutdown(signal).finally(() => process.exit(0));
  };
  process.once("SIGINT", handleSignal);
  process.once("SIGTERM", handleSignal);

  await connection.closed;
  process.off("SIGINT", handleSignal);
  process.off("SIGTERM", handleSignal);
  await shutdown("connection_closed");
}

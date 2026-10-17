import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PROTOCOL_VERSION, type AgentSideConnection, type SessionNotification } from "@agentclientprotocol/sdk";
import { ClaudeTtyAgent } from "./agent.ts";
import { createDeferred } from "./deferred.ts";

function createAgent(): ClaudeTtyAgent {
  return new ClaudeTtyAgent({ sessionUpdate: async () => undefined, extNotification: async () => undefined } as unknown as AgentSideConnection);
}

test("advertises the interactive ACP agent", async () => {
  const agent = createAgent();
  const initialized = await agent.initialize({ protocolVersion: PROTOCOL_VERSION });

  assert.equal(initialized.protocolVersion, PROTOCOL_VERSION);
  assert.equal(initialized.agentInfo?.name, "claude-tty-acp");
  assert.equal(initialized.agentCapabilities?.loadSession, true);
});

test("creates probe sessions without starting a runtime", async () => {
  const agent = createAgent();
  const created = await agent.newSession({ cwd: "/work/probe", mcpServers: [] });
  const session = agent.sessions.get(created.sessionId);

  assert.ok(session);
  assert.equal(session.cwd, "/work/probe");
  assert.equal(session.started, false);
  assert.equal(created.models?.currentModelId, "inherit");
  assert.deepEqual(
    created.models?.availableModels.map((model) => model.modelId),
    [
      "inherit",
      "opus",
      "fable",
      "sonnet",
      "haiku",
      "claude-opus-5-5",
      "claude-opus-5",
      "claude-fable-5",
      "claude-opus-4-8[1m]",
      "claude-opus-4-8",
      "claude-sonnet-5-5",
      "claude-sonnet-5-5[1m]",
      "claude-sonnet-5",
      "claude-sonnet-5[1m]",
      "claude-opus-4-7[1m]",
      "claude-opus-4-7",
      "claude-opus-4-6[1m]",
      "claude-opus-4-6",
      "claude-sonnet-4-6[1m]",
      "claude-sonnet-4-6",
      "claude-haiku-4-5",
    ],
  );
  assert.equal(created.modes?.currentModeId, "default");
  await agent.close();
});

test("publishes the model and the effort level as config options too", async () => {
  const agent = createAgent();
  const created = await agent.newSession({ cwd: "/work/probe", mcpServers: [] });
  const model = created.configOptions?.find((option) => option.category === "model");
  const effort = created.configOptions?.find((option) => option.category === "thought_level");

  // The plugin provider's ACP bridge reads no other model surface, and the daemon's own matches its fallback by value.
  assert.equal(model?.type, "select");
  assert.equal(model?.currentValue, "inherit");
  assert.deepEqual(
    model?.type === "select" ? model.options.map((option) => ("group" in option ? option.group : option.value)) : [],
    created.models?.availableModels.map((available) => available.modelId),
  );
  assert.equal(effort?.type, "select");
  assert.equal(effort?.currentValue, "inherit");
  assert.deepEqual(
    effort?.type === "select" ? effort.options.map((option) => ("group" in option ? option.group : option.value)) : [],
    ["inherit", "low", "medium", "high", "xhigh", "max"],
  );
  // With no settings document to read, a new session asks, and the bridge shows this as the agent's toggle.
  const autoAccept = created.configOptions?.find((option) => option.id === "auto_accept");
  assert.equal(autoAccept?.type, "boolean");
  assert.equal(autoAccept?.currentValue, false);
  await agent.close();
});

test("rejects injected MCP servers", async () => {
  const agent = createAgent();
  await assert.rejects(
    agent.newSession({
      cwd: "/work/probe",
      mcpServers: [{ name: "example", command: "example", args: [], env: [] }],
    }),
    /does not accept ACP-injected MCP servers/,
  );
});

test("publishes available commands after session/new responds", async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), "claude-tty-acp-commands-"));
  const published = createDeferred<{ afterResponse: boolean; update: SessionNotification["update"] }>();
  let responded = false;
  const agent = new ClaudeTtyAgent(
    {
      sessionUpdate: async (params: SessionNotification) => {
        published.resolve({ afterResponse: responded, update: params.update });
      },
      extNotification: async () => undefined,
    } as unknown as AgentSideConnection,
    { claudeConfigDir: configDir },
  );

  const created = await agent.newSession({ cwd: configDir, mcpServers: [] });
  responded = true;
  const notification = await published.promise;

  assert.equal(notification.afterResponse, true);
  assert.equal(notification.update.sessionUpdate, "available_commands_update");
  assert.ok(created.sessionId);
  await agent.close();
  await rm(configDir, { force: true, recursive: true });
});

import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AgentSideConnection, RequestPermissionRequest, RequestPermissionResponse } from "@agentclientprotocol/sdk";
import { answersFileName, useAnswersDirectory } from "./card-answers.ts";
import { InteractionBridge } from "./interactions.ts";

const answersDirectory = await mkdtemp(path.join(os.tmpdir(), "claude-tty-acp-answers-"));
useAnswersDirectory(answersDirectory);

function connectionWith(
  handler: (request: RequestPermissionRequest) => Promise<RequestPermissionResponse>,
): AgentSideConnection {
  return { requestPermission: handler } as AgentSideConnection;
}

function selected(optionId: string): RequestPermissionResponse {
  return { outcome: { outcome: "selected", optionId } };
}

/** What the plugin leaves behind before it forwards a response Paseo's question form filled in. */
async function handOff(cardId: string, answers: Record<string, string>): Promise<void> {
  await writeFile(path.join(answersDirectory, answersFileName(cardId)), JSON.stringify({ answers }));
}

test("correlates ordinary permissions and returns exact durable suggestions", async () => {
  const requests: RequestPermissionRequest[] = [];
  const suggestion = {
    type: "addRules",
    rules: [{ toolName: "Bash", ruleContent: "pnpm test" }],
    behavior: "allow",
    destination: "localSettings",
  };
  const bridge = new InteractionBridge(
    "session",
    "/work/repo",
    connectionWith(async (request) => {
      requests.push(request);
      return selected("allow-suggestion-0");
    }),
  );
  await bridge.handlePreToolUse({
    hook_event_name: "PreToolUse",
    session_id: "session",
    tool_use_id: "tool-1",
    tool_name: "Bash",
    tool_input: { command: "pnpm test", description: "Run tests" },
  });
  const response = await bridge.handlePermissionRequest({
    hook_event_name: "PermissionRequest",
    session_id: "session",
    tool_name: "Bash",
    tool_input: { command: "pnpm test", description: "Run tests" },
    permission_suggestions: [suggestion],
  });

  assert.equal(requests[0]?.toolCall.toolCallId, "tool-1");
  assert.equal(requests[0]?.options.some((option) => option.kind === "allow_once"), true);
  assert.deepEqual(response, {
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: { behavior: "allow", updatedPermissions: [suggestion] },
    },
  });
});

test("answers an ordinary permission itself while auto-accept is on, and takes none of Claude's suggestions", async () => {
  const requests: RequestPermissionRequest[] = [];
  let autoAccept = true;
  const bridge = new InteractionBridge(
    "session",
    "/work/repo",
    connectionWith(async (request) => {
      requests.push(request);
      return selected("deny");
    }),
    async () => autoAccept,
  );
  const permission = {
    hook_event_name: "PermissionRequest",
    session_id: "session",
    tool_name: "Bash",
    tool_input: { command: "cd build && rm -rf *" },
    permission_suggestions: [{ type: "addRules", rules: [{ toolName: "Bash" }], behavior: "allow", destination: "localSettings" }],
  };

  assert.deepEqual(await bridge.handlePermissionRequest(permission), {
    hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } },
  });
  assert.equal(requests.length, 0);

  // Asked per request, so switching it off reaches the very next one.
  autoAccept = false;
  const response = await bridge.handlePermissionRequest(permission);
  assert.equal(requests.length, 1);
  assert.equal((response.hookSpecificOutput as { decision: { behavior: string } }).decision.behavior, "deny");
});

test("still puts questions and plans in front of a person while auto-accept is on", async () => {
  const requests: RequestPermissionRequest[] = [];
  const bridge = new InteractionBridge(
    "session",
    "/work/repo",
    connectionWith(async (request) => {
      requests.push(request);
      return selected("reject");
    }),
    async () => true,
  );
  const plan = { plan: "1. Implement", allowedPrompts: [] };
  const question = { questions: [{ question: "Which one?", header: "Pick", options: [{ label: "A" }, { label: "B" }], multiSelect: false }] };

  const planResponse = await bridge.handlePermissionRequest({ tool_name: "ExitPlanMode", tool_input: plan });
  await bridge.handlePermissionRequest({ tool_name: "AskUserQuestion", tool_input: question });

  assert.deepEqual(
    requests.map((request) => request.toolCall.title),
    ["ExitPlanMode", "AskUserQuestion"],
  );
  assert.equal((planResponse.hookSpecificOutput as { decision: { behavior: string } }).decision.behavior, "deny");
});

test("raises one card for every question a tool call asks, and answers them all at once", async () => {
  const requests: RequestPermissionRequest[] = [];
  const bridge = new InteractionBridge(
    "session",
    "/work/repo",
    connectionWith(async (request) => {
      requests.push(request);
      await handOff("question-tool-questions", { "Choose runtime": "Bun", "Choose checks": "Types, Tests" });
      return selected("submit");
    }),
  );
  const questions = [
    { question: "Choose runtime", header: "Runtime", options: [{ label: "Node" }, { label: "Bun" }], multiSelect: false },
    { question: "Choose checks", header: "Checks", options: [{ label: "Types" }, { label: "Tests" }], multiSelect: true },
  ];
  const response = await bridge.handlePreToolUse({
    hook_event_name: "PreToolUse",
    session_id: "session",
    tool_use_id: "question-tool",
    tool_name: "AskUserQuestion",
    tool_input: { questions },
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.toolCall.toolCallId, "question-tool-questions");
  // The plugin matches on the name the bridge reads off the title, and republishes the whole input as its card.
  assert.equal(requests[0]?.toolCall.title, "AskUserQuestion");
  assert.deepEqual(requests[0]?.toolCall.rawInput, { questions });
  // Several questions leave no single option that answers them, so only the two that always mean something remain.
  assert.deepEqual(
    requests[0]?.options.map((option) => [option.optionId, option.kind]),
    [
      ["submit", "allow_once"],
      ["reply-in-chat", "reject_once"],
    ],
  );
  assert.deepEqual(response, {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      updatedInput: { questions, answers: { "Choose runtime": "Bun", "Choose checks": "Types, Tests" } },
    },
  });
});

test("offers one option per answer while a single question is on the card", async () => {
  const requests: RequestPermissionRequest[] = [];
  const bridge = new InteractionBridge(
    "session",
    "/work/repo",
    connectionWith(async (request) => {
      requests.push(request);
      return selected("answer-0-1");
    }),
  );
  const questions = [{ question: "Choose runtime", header: "Runtime", options: [{ label: "Node" }, { label: "Bun" }] }];
  const response = await bridge.handlePreToolUse({
    hook_event_name: "PreToolUse",
    session_id: "session",
    tool_use_id: "question-tool",
    tool_name: "AskUserQuestion",
    tool_input: { questions },
  });

  // Submit stays first: a client that allows without naming an action resolves the first affirmative one,
  // and that has to be the option that carries no answer of its own.
  assert.deepEqual(requests[0]?.options.map((option) => option.optionId), ["submit", "answer-0-0", "answer-0-1", "reply-in-chat"]);
  assert.deepEqual(requests[0]?.options.map((option) => option.name), ["Submit answers", "Node", "Bun", "Answer in chat"]);
  assert.deepEqual(response, {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      updatedInput: { questions, answers: { "Choose runtime": "Bun" } },
    },
  });
});

test("leaves the questions nobody answered to be asked in chat", async () => {
  const bridge = new InteractionBridge(
    "session",
    "/work/repo",
    connectionWith(async () => {
      await handOff("partial-questions", { "Name?": "Alice", "Proceed?": "Yes" });
      return selected("submit");
    }),
  );
  const question = await bridge.handlePreToolUse({
    tool_name: "AskUserQuestion",
    tool_use_id: "partial",
    tool_input: {
      questions: [
        { question: "Name?", options: [{ label: "Alice" }] },
        { question: "Notes?", options: [{ label: "None" }] },
        { question: "Proceed?", options: [{ label: "Yes" }] },
      ],
    },
  });
  assert.deepEqual(question, {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason:
        'The user left these questions to be asked in chat. Keep these completed answers: {"Name?":"Alice","Proceed?":"Yes"}. Ask only these deferred questions: ["Notes?"]. Restate the deferred questions conversationally in one message, then end this turn and wait for the user\'s response.',
    },
  });
});

test("falls back to chat for a card nobody answered", async () => {
  const responses = [selected("reply-in-chat"), selected("submit"), { outcome: { outcome: "cancelled" } } as RequestPermissionResponse];
  const bridge = new InteractionBridge("session", "/work/repo", connectionWith(async () => responses.shift()!));
  const input = { questions: [{ question: "Which way?", header: "Way", options: [{ label: "Left" }] }] };
  const reason =
    'The user left these questions to be asked in chat. Ask only these deferred questions: ["Which way?"]. Restate the deferred questions conversationally in one message, then end this turn and wait for the user\'s response.';

  for (const toolUseId of ["chat", "empty", "cancelled"]) {
    const response = await bridge.handlePreToolUse({ tool_name: "AskUserQuestion", tool_use_id: toolUseId, tool_input: input });
    assert.deepEqual(response, {
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
    });
  }
});

test("approves a plan on Paseo's own vocabulary", async () => {
  const requests: RequestPermissionRequest[] = [];
  const responses = [selected("implement"), selected("reject")];
  const bridge = new InteractionBridge(
    "session",
    "/work/repo",
    connectionWith(async (request) => {
      requests.push(request);
      return responses.shift()!;
    }),
  );
  const input = { plan: "1. Implement\n2. Verify", allowedPrompts: [] };

  assert.deepEqual(await bridge.handlePreToolUse({ tool_name: "ExitPlanMode", tool_use_id: "plan", tool_input: input }), {
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: input },
  });
  assert.equal(requests[0]?.toolCall.title, "ExitPlanMode");
  assert.deepEqual(requests[0]?.toolCall.rawInput, input);
  assert.deepEqual(requests[0]?.options.map((option) => option.optionId), ["implement", "reject"]);

  assert.deepEqual(await bridge.handlePreToolUse({ tool_name: "ExitPlanMode", tool_use_id: "plan-2", tool_input: input }), {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "The user did not approve leaving plan mode.",
    },
  });
});

test("cancels outstanding hook waits when the turn ends", async () => {
  let requested = false;
  const bridge = new InteractionBridge(
    "session",
    "/work/repo",
    connectionWith(async () => {
      requested = true;
      return new Promise<RequestPermissionResponse>(() => undefined);
    }),
  );
  const pending = bridge.handlePermissionRequest({ tool_name: "Bash", tool_input: { command: "pwd" } });
  await waitFor(() => requested);
  bridge.cancelPending();
  const response = await pending;
  assert.deepEqual(response, {
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: { behavior: "deny", message: "The permission request was cancelled.", interrupt: false },
    },
  });
});

test("answers the permission pipeline from the question card the killed PreToolUse hook left on screen", async () => {
  const requests: RequestPermissionRequest[] = [];
  let answer: ((response: RequestPermissionResponse) => void) | null = null;
  const bridge = new InteractionBridge(
    "session",
    "/work/repo",
    connectionWith(async (request) => {
      requests.push(request);
      return new Promise<RequestPermissionResponse>((resolve) => {
        answer = resolve;
      });
    }),
  );
  const questions = [{ question: "Choose runtime", options: [{ label: "Node" }, { label: "Bun" }], multiSelect: false }];
  const preTool = bridge.handlePreToolUse({
    tool_name: "AskUserQuestion",
    tool_use_id: "question-tool",
    tool_input: { questions },
  });
  await waitFor(() => requests.length > 0);

  // Claude killed that hook at its timeout and fell through to its permission pipeline for the same call.
  const permission = bridge.handlePermissionRequest({ tool_name: "AskUserQuestion", tool_input: { questions } });
  await waitFor(() => answer !== null);
  answer!(selected("answer-0-1"));

  assert.deepEqual(await permission, {
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: { behavior: "allow", updatedInput: { questions, answers: { "Choose runtime": "Bun" } } },
    },
  });
  assert.deepEqual(await preTool, {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      updatedInput: { questions, answers: { "Choose runtime": "Bun" } },
    },
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.toolCall.toolCallId, "question-tool-questions");
});

test("renders a question the permission pipeline asks about on its own", async () => {
  const requests: RequestPermissionRequest[] = [];
  const bridge = new InteractionBridge(
    "session",
    "/work/repo",
    connectionWith(async (request) => {
      requests.push(request);
      return selected("answer-0-0");
    }),
  );
  const questions = [{ question: "Proceed?", options: [{ label: "Yes" }] }];
  const response = await bridge.handlePermissionRequest({ tool_name: "AskUserQuestion", tool_input: { questions } });

  assert.deepEqual(requests[0]?.toolCall.rawInput, { questions });
  assert.deepEqual(response, {
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: { behavior: "allow", updatedInput: { questions, answers: { "Proceed?": "Yes" } } },
    },
  });
});

test("declines consent cards answered with a behaviour and no action id", async () => {
  const requests: RequestPermissionRequest[] = [];
  // `paseo permit` sends a bare behaviour, and @getpaseo/plugin 0.8.0 takes the first option whose kind matches it.
  const answerBare = (behavior: "allow" | "deny") =>
    connectionWith(async (request) => {
      requests.push(request);
      const option = request.options.find((candidate) => (candidate.kind.startsWith("allow") ? "allow" : "deny") === behavior);
      return option ? selected(option.optionId) : { outcome: { outcome: "cancelled" } };
    });

  for (const behavior of ["allow", "deny"] as const) {
    const bridge = new InteractionBridge("session", "/work/repo", answerBare(behavior));
    assert.equal(await bridge.requestWorkspaceTrust(), false);
    assert.equal(await bridge.requestBypassPermissions(), false);
  }
  assert.equal(requests.length, 4);
});

async function waitFor(predicate: () => boolean): Promise<void> {
  while (!predicate()) await new Promise((resolve) => setImmediate(resolve));
}

test("takes a card back down on its own, and tells a session apart from one that is waiting on somebody", async () => {
  const requests: RequestPermissionRequest[] = [];
  const bridge = new InteractionBridge(
    "session-1",
    "/work",
    connectionWith(async (request) => {
      requests.push(request);
      // The client goes on showing it: ACP has no way for an agent to take a permission request back,
      // which is the whole reason `withdraw` exists and the reason the plugin ends it on Paseo's side.
      return new Promise<RequestPermissionResponse>(() => undefined);
    }),
  );

  const question = bridge.openRequest({
    toolCall: { toolCallId: "dialog-1", title: "Claude is asking something", kind: "other", status: "pending", rawInput: {} },
    options: [{ optionId: "dialog-dismiss", name: "Dismiss (Esc)", kind: "reject_once" }],
  });
  // Claude is held up behind its own question, so this is a session somebody is being waited on for.
  assert.equal(bridge.pending, true);
  question.withdraw();
  assert.deepEqual(await question.response, { outcome: { outcome: "cancelled" } });
  assert.equal(bridge.pending, false);

  const told = bridge.openRequest(
    {
      toolCall: { toolCallId: "ack-1", title: "Model switched: Fable 5 → Opus 4.8", kind: "other", status: "pending", rawInput: {} },
      options: [{ optionId: "acknowledge", name: "OK", kind: "reject_once" }],
    },
    { blocking: false },
  );
  // A card that only says something happened is not a session waiting on anybody: nothing is held up
  // behind it, and reading it as busy would defer this session's suspension until somebody clicked it.
  assert.equal(bridge.pending, false);
  assert.equal(requests.length, 2);
  // It is still let go of with everything else at a turn boundary, so a prompt is never behind one.
  bridge.cancelPending();
  assert.deepEqual(await told.response, { outcome: { outcome: "cancelled" } });
});

test("keeps the tools waiting for a permission bounded, so a session working between prompts does not grow one", async () => {
  const requests: RequestPermissionRequest[] = [];
  const bridge = new InteractionBridge(
    "session",
    "/work/repo",
    connectionWith(async (request) => {
      requests.push(request);
      return selected("allow-once");
    }),
  );
  // Claude runs tools that raise no card, and only a prompt empties what they leave behind.
  // A session woken by a task notification is never prompted, so the count here is the run, not the turn.
  for (let index = 0; index < 150; index += 1) {
    await bridge.handlePreToolUse({
      hook_event_name: "PreToolUse",
      session_id: "session",
      tool_use_id: `tool-${index}`,
      tool_name: "Bash",
      tool_input: { command: `echo ${index}` },
    });
  }

  // The newest is still there to correlate with, which is the only one a PermissionRequest ever asks for.
  await bridge.handlePermissionRequest({
    hook_event_name: "PermissionRequest",
    session_id: "session",
    tool_name: "Bash",
    tool_input: { command: "echo 149" },
  });
  assert.equal(requests[0]?.toolCall.toolCallId, "tool-149");

  // The oldest has been let go of rather than held for the life of the process.
  await bridge.handlePermissionRequest({
    hook_event_name: "PermissionRequest",
    session_id: "session",
    tool_name: "Bash",
    tool_input: { command: "echo 0" },
  });
  assert.notEqual(requests[1]?.toolCall.toolCallId, "tool-0");
  assert.match(requests[1]!.toolCall.toolCallId, /^permission-/);
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  agentIdFromFileName,
  launchedAgent,
  notificationFailed,
  parseTaskNotifications,
  shortenPath,
  SubagentLog,
  subagentProse,
  subagentsDirectory,
  subagentToolLine,
} from "./subagent-transcript.ts";

test("finds the subagent transcripts beside the session's own", () => {
  assert.equal(
    subagentsDirectory("/home/me/.claude/projects/-work-repo/46ece69b.jsonl"),
    "/home/me/.claude/projects/-work-repo/46ece69b/subagents",
  );
  assert.equal(agentIdFromFileName("agent-a5135405597c5cb3c.jsonl"), "a5135405597c5cb3c");
  assert.equal(agentIdFromFileName("agent-.jsonl"), null);
  assert.equal(agentIdFromFileName("46ece69b.jsonl"), null);
});

test("reads the agent a tool result launched, and whether it is still running", () => {
  assert.deepEqual(launchedAgent({ isAsync: true, status: "async_launched", agentId: "a1" }), { agentId: "a1", running: true });
  assert.deepEqual(launchedAgent({ status: "completed", agentId: "a2" }), { agentId: "a2", running: false });
  assert.equal(launchedAgent({ status: "completed" }), null);
  assert.equal(launchedAgent("not a record"), null);
});

test("reads a task notification and treats anything but a clean finish as a failure", () => {
  const text = [
    "before",
    "<task-notification> <task-id>a1</task-id> <tool-use-id>toolu_1</tool-use-id> <status>completed</status> <summary>Agent \"Audit\" finished</summary> </task-notification>",
    "<task-notification> <task-id>a2</task-id> <status>killed</status> <summary>Stopped</summary> </task-notification>",
  ].join("\n");
  assert.deepEqual(parseTaskNotifications(text), [
    { taskId: "a1", toolCallId: "toolu_1", status: "completed", summary: 'Agent "Audit" finished' },
    { taskId: "a2", toolCallId: null, status: "killed", summary: "Stopped" },
  ]);
  assert.equal(notificationFailed("completed"), false);
  assert.equal(notificationFailed("killed"), true);
  assert.equal(notificationFailed(null), true);
  assert.deepEqual(parseTaskNotifications("nothing here"), []);
});

test("keeps a bounded tail of a subagent's steps", () => {
  const log = new SubagentLog();
  assert.equal(log.empty, true);
  for (let step = 1; step <= 45; step += 1) log.append(`• step ${step}`);
  log.append("   ");
  const lines = log.text().split("\n");
  assert.equal(log.empty, false);
  assert.equal(lines[0], "… 5 earlier steps");
  assert.equal(lines[1], "• step 6");
  assert.equal(lines.length, 41);
});

test("collapses a step onto one bounded line", () => {
  const log = new SubagentLog();
  log.append(`kept\n  across   lines ${"x".repeat(400)}`);
  const line = log.text();
  assert.equal(line.includes("\n"), false);
  assert.equal(line.startsWith("kept across lines xxx"), true);
  assert.equal(line.length, 200);
  assert.equal(line.endsWith("…"), true);
});

test("says what a tool call was for in the words the subagent had for it", () => {
  const cwd = "/work/repo";
  assert.equal(subagentToolLine("Bash", { command: "pnpm test", description: "Run the suite" }, cwd), "Bash: Run the suite");
  assert.equal(subagentToolLine("Bash", { command: "pnpm test" }, cwd), "Bash: pnpm test");
  assert.equal(subagentToolLine("Read", { file_path: `${cwd}/src/app.ts` }, cwd), "Read: src/app.ts");
  assert.equal(subagentToolLine("Grep", { pattern: "carriesList", path: "src" }, cwd), "Grep: carriesList");
  assert.equal(subagentToolLine("ToolSearch", {}, cwd), "ToolSearch");
});

test("keeps the tail of a path, which is the half that says which file this is", () => {
  const cwd = "/work/repo";
  assert.equal(shortenPath(`${cwd}/src/app.ts`, cwd), "src/app.ts");
  assert.equal(shortenPath("/tmp/short.py", cwd), "/tmp/short.py");
  assert.equal(
    shortenPath("/tmp/claude-1000/-home-kobe-projects-remi-plus/adf69443-83ac-4649-93e1-8f6b19ba32aa/scratchpad/fizzbuzz.py", cwd),
    "…/scratchpad/fizzbuzz.py",
  );
  // Nothing to drop but the name itself.
  assert.equal(shortenPath(`/${"long-".repeat(20)}name.py`, cwd), `/${"long-".repeat(20)}name.py`);
});

test("reads a subagent's report as text rather than as the markdown it was written in", () => {
  const cwd = "/work/repo";
  assert.equal(
    subagentProse("Done.\n\n**File:** `/tmp/claude-1000/-home-kobe-projects-remi-plus/adf69443-83ac-4649/scratchpad/fizzbuzz.py`\n\n## Source\n```python\nprint(1)\n```", cwd),
    "Done. File: …/scratchpad/fizzbuzz.py Source",
  );
  // A fence that has not been closed yet is the normal state of a report being written.
  assert.equal(subagentProse("Here it is:\n```python\nprint(1)", cwd), "Here it is:");
  assert.equal(subagentProse(`A ${"very ".repeat(60)}long answer`, cwd).length, 120);
  assert.equal(subagentProse("", cwd), "");
});

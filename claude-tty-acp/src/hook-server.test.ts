import assert from "node:assert/strict";
import test from "node:test";
import { HookServer } from "./hook-server.ts";

test("routes hooks only to their Claude session", async () => {
  const server = new HookServer();
  const received: string[] = [];

  try {
    await server.start();
    const registration = server.register("first", async (payload) => {
      received.push(String(payload.hook_event_name));
      return { handled: true };
    });
    registration.addSessionId("first-after-clear");
    const response = await fetch(registration.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session_id: "first", hook_event_name: "Stop" }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { handled: true });
    assert.deepEqual(received, ["Stop"]);

    const invalidToken = await fetch(registration.endpoint.replace(/.$/, "x"), { method: "POST", body: "{}" });
    assert.equal(invalidToken.status, 404);
    assert.deepEqual(await server.dispatch({ session_id: "first-after-clear", hook_event_name: "SessionStart" }), { handled: true });
    await assert.rejects(server.dispatch({ session_id: "second", hook_event_name: "Stop" }), /No active adapter session/);
  } finally {
    await server.close();
  }
});

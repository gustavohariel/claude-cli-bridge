import assert from "node:assert/strict";
import test from "node:test";
import { contextWindow, formatTokens } from "./context-window.ts";

const payload = (window: unknown): string => JSON.stringify({ session_id: "s", context_window: window });

test("reads the pair Claude reports and rounds the percentage to match the token count", () => {
  assert.deepEqual(contextWindow(payload({ total_input_tokens: 137_400, used_percentage: 69, context_window_size: 200_000 })), {
    tokens: 137_400,
    percent: 69,
  });
  // Claude reports a fractional percentage on some models; a rounded token count beside "23.5%" reads like two different measurements.
  assert.deepEqual(contextWindow(payload({ total_input_tokens: 47_000, used_percentage: 23.5 })), { tokens: 47_000, percent: 24 });
});

test("stays absent for every reading Claude has not actually made", () => {
  // Claude leaves the percentage null until a session has usage, which is the one that happens in practice.
  assert.equal(contextWindow(payload({ total_input_tokens: 0, used_percentage: null, context_window_size: 1_000_000 })), null);
  assert.equal(contextWindow(payload({ total_input_tokens: 137_400 })), null);
  assert.equal(contextWindow(payload({ used_percentage: 69 })), null);
  assert.equal(contextWindow(payload({ total_input_tokens: 0, used_percentage: 0 })), null);
  assert.equal(contextWindow(payload({ total_input_tokens: "137400", used_percentage: 69 })), null);
  assert.equal(contextWindow(payload({ total_input_tokens: Number.NaN, used_percentage: 69 })), null);
  assert.equal(contextWindow(payload(null)), null);
  assert.equal(contextWindow(payload([])), null);
  assert.equal(contextWindow(JSON.stringify({ session_id: "s" })), null);
  assert.equal(contextWindow(JSON.stringify([1, 2])), null);
  // Claude truncates the file before it rewrites it, so a read can catch a fragment.
  assert.equal(contextWindow('{"context_window":{"total_input_tok'), null);
  assert.equal(contextWindow(""), null);
});

test("scales token counts the way Claude's own reading reads", () => {
  assert.equal(formatTokens(812), "812");
  // The count just below the scale is the one that reads as "1k" if the threshold slips, the same way 999,950 reads as "1000k".
  assert.equal(formatTokens(999), "999");
  assert.equal(formatTokens(1000), "1k");
  assert.equal(formatTokens(33_656), "33.7k");
  assert.equal(formatTokens(137_000), "137k");
  assert.equal(formatTokens(999_949), "999.9k");
  // 999,950 rounds up to a thousand thousands, which must not read as "1000k".
  assert.equal(formatTokens(999_950), "1M");
  assert.equal(formatTokens(1_000_000), "1M");
  assert.equal(formatTokens(1_240_000), "1.2M");
});

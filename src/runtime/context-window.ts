export type ContextWindow = {
  tokens: number;
  percent: number;
};

// Both numbers are Claude's own: it sums the last message's input, cache creation and cache read tokens, and measures that against the window it resolved.
// Claude leaves the percentage null until a session has usage, which is what keeps the reading absent rather than nothing-shaped.
export function contextWindow(contents: string): ContextWindow | null {
  let payload: unknown;
  try {
    payload = JSON.parse(contents);
  } catch {
    return null;
  }
  const window = objectValue(objectValue(payload)?.context_window);
  if (!window) return null;
  const tokens = finiteNumber(window.total_input_tokens);
  const percent = finiteNumber(window.used_percentage);
  if (tokens === null || tokens <= 0 || percent === null) return null;
  // Claude reports a fractional percentage on some models, which would read oddly beside a rounded token count.
  return { tokens, percent: Math.round(percent) };
}

export function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  // A count that rounds up to a thousand thousands reads as 1M rather than 1000k.
  const thousands = tokens / 1000;
  const scaled = thousands < 999.95 ? { value: thousands, suffix: "k" } : { value: tokens / 1_000_000, suffix: "M" };
  return `${scaled.value.toFixed(1).replace(/\.0$/, "")}${scaled.suffix}`;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

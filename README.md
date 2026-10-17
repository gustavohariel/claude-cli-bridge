# claude-cli-bridge

Runs T3 Code's Claude provider on the interactive Claude CLI instead of the Agent SDK, which costs fewer tokens.

- `claude-sdk-tty/` is the bridge. T3's Claude `binaryPath` points at `claude-sdk-tty/bin/claude`, which speaks SDK stream-json to T3 and drives the CLI in a PTY.
- `claude-tty-acp/` is the PTY runtime it loads from `claude-tty-acp/dist`. It was extracted from sleeyax/paseo-plugins, with local fixes.

Build the runtime with `cd claude-tty-acp && bun install && bun run build`. Test the bridge with `cd claude-sdk-tty && node --test claude-sdk-tty.test.mjs`.

Logs go to `~/.local/state/claude-sdk-tty/`.

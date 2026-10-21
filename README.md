# claude-cli-bridge

A stand-in `claude` binary for hosts built on the Claude Agent SDK, such as T3 Code's Claude provider.
The host keeps speaking the SDK's stream-json protocol, but each session runs in the real interactive
Claude Code CLI inside a PTY, so usage and caching are those of an interactive session.

- `bin/claude` is what the host runs.
- `src/bridge.mjs` speaks the SDK protocol and turns Claude's transcript into SDK messages.
- `src/runtime/` drives the CLI: typing prompts, reading the screen, hooks, transcript and subagent watching.
- `docs/adr/` explains why it drives a PTY, reads the transcript and relies on hooks.

## Use it in T3 Code

```sh
npm install
```

Then Settings > Providers > Claude > Binary path: `<this checkout>/bin/claude`.

New Claude sessions use it; a running one keeps its process until it restarts. Clear the field to go
back to the SDK-driven CLI, or set `CLAUDE_CLI_BRIDGE_DISABLE=1` in the server's environment.

Needs Node 24 or newer (the runtime runs as TypeScript source). `bin/claude` picks the newest Node
that mise has installed; set `CLAUDE_CLI_BRIDGE_NODE` to choose one.

## What goes where

| SDK traffic | Handled by |
| --- | --- |
| prompts, images, PDFs | typed into the interactive CLI (attachments as `@file`) |
| assistant / tool results / subagent messages | re-emitted from the session transcript |
| `can_use_tool` | `PermissionRequest` and `PreToolUse` hooks (AskUserQuestion, ExitPlanMode) |
| `set_permission_mode` | Shift+Tab in place; restart only when that fails while idle |
| `set_model` | restart on the same conversation (waits for the turn to end) |
| `mcp_set_servers` | `--mcp-config` file (0600) at launch |
| `interrupt` | Escape |
| `--resume-session-at` | transcript cut after that message; a full copy goes to `rollback-backups/` |
| `initialize`, `get_usage`, other control requests | a headless CLI that never receives a prompt |
| `--version`, `-p` one-shots, the periodic capability probe | the real CLI, unchanged |

Startup consents the headless CLI never asks (workspace trust, the bypass disclaimer, external
imports) are accepted. Any other question Claude opens on screen reaches the host as an AskUserQuestion.

## Limits

- No token streaming: text and thinking arrive one completed block at a time.
- A prompt sent during a turn waits for that turn to end.
- `stop_task` is acknowledged but cannot stop a single subagent; Stop interrupts the turn.
- A model change restarts Claude with `--resume`, like T3's own restarts.

## Develop

```sh
npm test            # bridge and runtime tests
npm run typecheck
```

Logs: `~/.local/state/claude-cli-bridge/bridge.log` (bridge) and `logs/runtime.log` beside it (runtime).
`CLAUDE_CLI_BRIDGE_STATE_DIR` moves both.

## License

Apache 2.0. The runtime started as claude-tty-acp from [paseo-plugins](https://github.com/sleeyax/paseo-plugins); see `NOTICE`.

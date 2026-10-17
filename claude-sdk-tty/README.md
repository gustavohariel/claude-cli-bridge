# claude-sdk-tty

A stand-in `claude` binary for hosts built on the Claude Agent SDK, such as T3 Code's built-in
Claude provider. The SDK keeps speaking its stream-json protocol, but each session runs in the
real interactive Claude Code CLI inside a PTY, so usage and caching are those of an interactive
session. The PTY driving comes from `../claude-tty-acp` (its compiled `dist/`).

## Use it in T3 Code

Settings > Providers > Claude > Binary path:

```
/home/realgh/tools/paseo-plugins/apps/claude-sdk-tty/bin/claude
```

New Claude sessions use it; a running one keeps its process until it restarts. Clear the field to
go back to the SDK-driven CLI. `CLAUDE_SDK_TTY_DISABLE=1` in the server's environment does the same.

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
imports) are accepted. Any other question Claude opens on screen reaches the host as an
AskUserQuestion.

## Limits

- No token streaming: text and thinking arrive one completed block at a time.
- A prompt sent during a turn waits for that turn to end.
- `stop_task` is acknowledged but cannot stop a single subagent; Stop interrupts the turn.
- A model change restarts Claude with `--resume`, like T3's own restarts.

## Logs

`~/.local/state/claude-sdk-tty/bridge.log` (bridge) and `logs/claude-tty-acp.log` beside it (PTY runtime).

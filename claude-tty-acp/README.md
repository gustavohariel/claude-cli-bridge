# Claude TTY ACP

An [ACP](https://agentclientprotocol.com) adapter that runs the real interactive Claude Code CLI as a Paseo agent.
Each session is one `claude` process in a terminal, and you get Paseo's native timeline, tool calls, plans, permission cards and pickers on top of it.

## Why?

Paseo's built-in Claude agent runs on the Claude Agent SDK.
Agent SDK integrations appear to consume usage limits faster than the Claude Code CLI does, [as reported for t3code and similar tools](https://github.com/pingdotgg/t3code/issues/7338#issuecomment-5426425282).
This adapter avoids the SDK by driving the same CLI you would run in a terminal.
You keep its binary, login, billing, sessions, `CLAUDE.md` files, MCP servers, plugins, skills and permission rules.
The cost is that Paseo's features are rebuilt from Claude's transcripts, hooks and screen, which is where the [limitations](#limitations) come from.

## Installation

Requires:

- Linux or macOS
- Node.js 22 or newer
- Paseo 0.11 or newer
- Claude Code, logged in as the user the Paseo daemon runs as

Install it through the [Claude TTY plugin](../../plugins/claude-tty/README.md#installation), which builds this adapter and registers it as a provider.

Then run `claude` once, interactively, as the user the daemon runs as, and log in.
If the daemon runs under systemd, open a login shell for that account so the credentials land in its home directory.

The adapter runs on the daemon's host, so repeat both steps on every host that should offer Claude.

## Usage

### Sessions

A new session starts nothing until you send its first prompt.
Reopening a saved session replays its conversation and resumes the same Claude session on your next prompt.
A session can be open in only one adapter at a time.
After a quiet spell Claude is stopped and resumed on the next prompt; the plugin's [Suspend idle Claude](../../plugins/claude-tty/README.md#settings) setting controls when.

### Models, modes and effort

The model picker lists Claude Code's rolling aliases (`opus`, `fable`, `sonnet`, `haiku`) and specific releases, including the 1M-context variants.
**Default** passes no flag, so Claude uses whatever its own settings name.
The modes are Default, Accept Edits, Plan, Auto and Bypass Permissions.
The thinking picker holds Claude Code's effort levels, from Low to Max.

You can change any of them while the session is idle, and Claude restarts on the same conversation with the new setting.
During a turn the change is refused.

The first Bypass Permissions session on a host shows Claude's own disclaimer as a card.
Declining it fails the session start; once you accept it, Claude does not ask again on that host.

Auto Accept is covered in the plugin's [settings](../../plugins/claude-tty/README.md#settings).

### Dialogs Claude opens

When Claude stops at a question of its own, such as workspace trust, a plugin suggestion or `/rewind`, you get it as a card in Paseo.
Paseo never answers these cards for you, whatever mode the session is in.
Declining the external `CLAUDE.md` imports question starts the session without those files, and the timeline names them.

When Claude switches to a fallback model by itself, the timeline says so, the model picker follows, and a card with **OK** makes Paseo notify you.

### Attachments

Images, and embedded files that are binary or over 32 KB, are written to private temporary files and passed to Claude as `@path`.
Links to files on the host become `@path` references.
Audio and links to anything other than a host file are rejected.

## Environment variables

The adapter inherits the Paseo daemon's environment.

| Variable | Default | What it does |
| --- | --- | --- |
| `CLAUDE_BIN` | `claude` on `PATH` | The Claude Code executable. Use an absolute path when the daemon's `PATH` cannot find it. |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Claude's configuration, credentials, commands, skills and transcripts. |
| `CLAUDE_TTY_ACP_STATE_DIR` | `$XDG_STATE_HOME/claude-tty-acp` | Saved sessions, locks and the adapter log. |
| `XDG_STATE_HOME` | `~/.local/state` | Base of the default state directory. |
| `CLAUDE_TTY_ACP_STATE_SCOPE` | `shared` | `workspace` keeps each working directory's sessions and log under `workspaces/` in the state directory. Any other value makes sessions fail to open. |
| `CLAUDE_TTY_ACP_IDLE_TIMEOUT_MS` | `3600000` | Milliseconds of quiet before Claude is stopped; `0` never stops it. Overrides the plugin's setting. An invalid value is logged and ignored. |

For a systemd service, set `CLAUDE_BIN` to the output of `command -v claude` in that user's login shell.

## Limitations

- **No ACP-injected MCP servers.** A session that Paseo starts with MCP servers fails; Claude's own MCP servers work as usual.
- **A message sent mid-turn interrupts the turn.** Paseo cancels the running turn and sends yours as the next one, so Claude does not queue it the way its terminal does.
- **Auto mode can hang.** After too many classifier denials Claude asks at its own keyboard, which no hook reaches, so the turn never ends. Cancel the turn, or use Default mode.
- **No token usage meter.** Paseo ignores usage from ACP providers, so a `Context: 137.4k tokens (69%)` line ends each turn instead. It is not part of the saved history.
- **Question forms need the plugin.** Without it, a card with several questions can only be answered in chat.
- **Slash commands load late in a draft.** A draft agent's composer can wait up to 10 seconds for them.

## Troubleshooting

The adapter logs to `${XDG_STATE_HOME:-~/.local/state}/claude-tty-acp/logs/claude-tty-acp.log`, or under `CLAUDE_TTY_ACP_STATE_DIR`.
Paseo drops the adapter's stderr, so that file is the only copy.
The plugin's [Diagnostics](../../plugins/claude-tty/README.md#troubleshooting) checks the host for you.

| Symptom | What to do |
| --- | --- |
| `Could not start claude` | Set `CLAUDE_BIN` to an absolute path the daemon can run. |
| Claude shows a login screen | Log in as the daemon's user, and check that `HOME` or `CLAUDE_CONFIG_DIR` points where you logged in. |
| `did not complete the SessionStart hook handshake` | Check for an organization policy that blocks hooks, settings that disable them, and loopback access. The error includes the terminal screen. |
| `Persisted ACP session … was not found on this host` | Open it on the host that created it, with the same `CLAUDE_TTY_ACP_STATE_DIR`. |
| `ACP session … belongs to <path>` | Open the session from its original project directory. |
| `ACP session … is already active in process <pid>` | Close the other agent holding it, or stop that adapter from the plugin's session list. |
| `A foreground turn is already active` | The interrupted turn had not finished when Paseo sent yours. Send it again. |
| A turn in Auto mode never ends | Claude hit the classifier denial limit; see [Limitations](#limitations). |
| Commands, skills or plugins are missing | Check that the daemon sees the right `CLAUDE_CONFIG_DIR` and the project's `.claude` directory. |

Removing the plugin leaves the state directory behind.
Delete it only if you no longer need to resume old sessions.

## Development

For development instructions, see the [root README](../../README.md#development).

```sh
pnpm --filter @paseo-plugins/claude-tty-acp build
pnpm --filter @paseo-plugins/claude-tty-acp diagnose
```

`bin/claude-tty-acp --help` lists the flags; `--diagnose --json` prints the host checks as one JSON line.
The tests use no Claude usage.

`smoke:live` runs one real prompt through ACP and a Claude terminal, and does use Claude usage:

```sh
pnpm --filter @paseo-plugins/claude-tty-acp smoke:live -- /absolute/project/path
```

To run a changed adapter in Paseo, see the plugin's [Development](../../plugins/claude-tty/README.md#development) section.

Design decisions are in [docs/adr](docs/adr).

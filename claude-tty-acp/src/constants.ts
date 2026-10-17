/**
 * `APP_NAME` is this build's half of the plugin's identity, and the only line in the adapter that a
 * variant changes. It names the state directory under `$XDG_STATE_HOME` — sessions, locks, card
 * answers and this log — as well as the log file, the `app` field on every log record and the
 * agent name in the ACP handshake.
 *
 * It is `${plugin id}-acp`, and `plugins/claude-tty/shared/identity.ts` computes the same string on
 * the other side, where the plugin needs it to find the directory it just told the adapter to use.
 * The two cannot import each other — the plugin runs in the daemon, this is a package of its own —
 * so `plugins/claude-tty/scripts/set-identity.mjs` writes both, and `pnpm identity --check` is what
 * says they still agree.
 */
export const APP_NAME = "claude-tty-acp";
export const APP_TITLE = "Claude Code (interactive)";
/** The adapter reports this over ACP and prints it for `--version`, and release-please keeps it in step with `package.json`. */
export const APP_VERSION = "0.4.0"; // x-release-please-version

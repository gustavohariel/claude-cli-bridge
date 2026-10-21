# Working on claude-cli-bridge

Read `README.md` for the layout and `docs/adr/` for why the runtime types into a PTY, reads the transcript and relies on hooks.

## stdout is the SDK stream

The bridge speaks stream-json on stdout, so any other byte written there corrupts the host's connection.
Log with `log()` in `src/bridge.mjs` or `writeLog` from `src/runtime/log.ts`; both go to files under the state directory.

## How a write is cut up decides what Claude reads

Claude reads several characters that arrive together as pasted text, not as keys.
Send each control key as its own write with a gap after it, as the Ctrl-U clear does, or Claude inserts them as literal characters.
A large write goes the other way: the terminal can hand it over in several reads, and a paste's opening sequence cut between two of them reaches Claude as text.
So pastes go in batches that each end on a whole piece, see `PASTE_WRITE_BYTES`.

## Every turn must end

The host reads a session as busy from the open turn only, so every turn must end through a hook or an explicit release.
A prompt Claude never took fires no hook, so it must fail the prompt rather than return; otherwise the session reads busy forever.

## Claude's terminal UI is measured, not specified

Readiness, dialog detection and the input-box echo match what Claude Code draws, measured against the versions named in the code comments.
A Claude Code release can break them without any change here.
The runtime log records every dialog transition with its screen; turn those screens into test fixtures before changing a parser.

## Verifying

`npm test` and `npm run typecheck`. The runtime's tests drive it through `src/runtime/test-sessions.ts`, which wires it the way the bridge does.
For a change to prompt delivery or turn handling, also run one real session through `bin/claude`.

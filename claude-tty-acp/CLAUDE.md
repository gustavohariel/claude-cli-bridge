# Working on the adapter

Read the ADRs in `docs/adr/` first: they explain why the adapter types into a PTY, reads the transcript and relies on hooks.

## stdout is the ACP stream

The server speaks ACP as newline-delimited JSON on stdout, so any other byte written there corrupts the connection.
Log with `writeLog` from `src/log.ts`, which writes to stderr and to the log file under the state directory.
The daemon drops stderr, so the file is the only record of a session.

## How a write is cut up decides what Claude reads

Claude reads several characters that arrive together as pasted text, not as keys.
Send each control key as its own write with a gap after it, as the Ctrl-U clear does, or Claude inserts them as literal characters.
A large write goes the other way: the terminal can hand it over in several reads, and a paste's opening sequence cut between two of them reaches Claude as text.
So pastes go in batches that each end on a whole piece, see `PASTE_WRITE_BYTES`.

## The client has no session until the response

Paseo drops any session update for a session ID it has not been given yet.
Anything sent from `session/new` or `session/load` (commands, a replayed history) goes out after the handler returns, which is why both use `setImmediate`.

## Paseo reads "busy" from the open turn only

ACP has no other busy signal, so every turn must end through a hook or an explicit release.
A prompt Claude never took fires no hook, so it must fail the prompt rather than return; otherwise the session reads busy forever and is never suspended.
Paseo cancels before every mid-turn message and gives the cancelled `session/prompt` 2 seconds to answer, so anything added to the cancel path has to fit inside that budget.

## Cards Paseo must not answer use only reject kinds

Paseo's automatic permission modes accept an `allow_*` option without showing a card.
A card for a decision that must come from a person (startup consent, Claude's own dialogs) offers every option with a `reject_*` kind and tells them apart by `optionId`.

## A failed tool call carries an error

A `tool_call_update` with `status: "failed"` must carry a non-null `rawOutput`.
Paseo's timeline schema requires an error on failed items, and one item without it makes the client refuse the agent's whole history.

## Claude's terminal UI is measured, not specified

Readiness, dialog detection and the input-box echo match what Claude Code draws, measured against the versions named in the code comments.
A Claude Code release can break them without any change here.
The log records every dialog transition with its screen; turn those screens into test fixtures before changing a parser.

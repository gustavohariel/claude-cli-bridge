# Read output from the transcript, not the terminal

Everything the adapter sends to Paseo as conversation (messages, thinking, tool calls, plans, subagent steps) is translated from the JSONL transcripts Claude writes under its projects directory, never scraped from the terminal screen.
The transcript is structured, complete and stable across UI changes, and it is also what lets a reloaded session replay its history without starting Claude.
The headless terminal screen is kept for what the transcript cannot say: whether Claude is ready for input, whether a dialog is blocking it, and whether a prompt reached its input box.
The cost is latency and indirection: the adapter polls files, joins subagent transcripts to their launchers by ID, and has to flush the transcript before it ends a turn.

# Drive the interactive Claude CLI in a PTY

Each session owns one real, interactive `claude` process in a PTY, and the runtime types into it the way a person would: prompts as bracketed pastes, cancellation as Escape, a restart as Ctrl-D followed by `claude --resume`.
We chose this over the Claude Agent SDK and `claude -p` because Agent SDK integrations appear to consume usage limits faster than the CLI, and because the interactive CLI keeps the user's own login, settings, plugins, skills and sessions untouched.
The price is that everything the Agent SDK gives a host has to be rebuilt from outside the process, and that the runtime depends on how Claude's terminal UI behaves, which changes between Claude Code releases.
Moving to the SDK later would mean rewriting nearly all of the runtime.

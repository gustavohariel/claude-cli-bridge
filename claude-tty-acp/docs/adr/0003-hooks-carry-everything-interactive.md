# Hooks carry everything interactive, through a per-launch settings file

Permission requests, questions, plan approval and the end of every turn reach the adapter as Claude Code hooks, posted to a loopback HTTP server with a per-process secret and a per-session route.
The hooks are registered in a generated `settings.json` passed with `--settings` on each launch, so nothing is written into the user's Claude configuration and no global hooks are needed.
We chose hooks over detecting Claude's dialogs on the screen because a hook carries structured input and takes a structured answer, so a permission is never decided by keystrokes into a dialog the adapter misread.
The trade-off is that anything Claude asks outside a hook, such as the Auto mode denial-limit prompt or its own between-turn nudges, has to be handled separately or not at all.

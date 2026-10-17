# Hold the turn open while background work runs

A turn stays open after Claude's `Stop` hook for as long as a subagent or background command it launched has not reported, and ends at the first `Stop` with nothing left running.
Paseo reads a session as busy only from an open ACP turn, and Claude goes idle as soon as it launches background work, so without this a session doing ten minutes of work reads as ready and Claude's reply to the report lands outside any turn.
The cost is that a turn can outlive its prompt by a long time, so it is bounded: agents that write nothing for fifteen minutes, and commands that have not reported after thirty, stop being waited on.
Cancelling still ends a held turn at once, because Paseo cancels before every mid-turn message.

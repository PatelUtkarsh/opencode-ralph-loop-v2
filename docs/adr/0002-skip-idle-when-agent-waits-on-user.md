# Skip the idle event when the agent is waiting on the user

A Loop Session goes idle both when the agent finishes a turn and when it stops to ask a question, request a permission, or when a user message is already queued. Re-prompting in the second case buries the question and races the user's message. We treat those idles as a Skipped Idle: no Continuation Prompt, no Iteration increment, and the Loop resumes on the next idle. The trade-off is that a Loop can sit paused indefinitely if the user never answers; `/ralph-status` shows the paused state and `/cancel-ralph` ends it.

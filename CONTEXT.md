# Ralph Loop

An OpenCode V2 plugin that keeps re-prompting one session until the agent truthfully states that the task is complete.

## Language

**Loop**:
The unit of work started by `/ralph-loop`. One Loop is bound to exactly one Loop Session and runs until it stops.
_Avoid_: Job, run, task

**Loop Session**:
The OpenCode session in which `/ralph-loop` was invoked. Only this session is re-prompted; child sessions are never Loop Sessions.
_Avoid_: Parent session, owner session

**Task**:
The user-authored description of the work the Loop must finish. Repeated verbatim in every Continuation Prompt.
_Avoid_: Prompt, goal, instruction

**Iteration**:
One agent turn inside a Loop that was started by a Continuation Prompt. A Skipped Idle is not an Iteration.
_Avoid_: Cycle, round, attempt

**Turn End**:
The moment the Loop Session finishes an agent turn, signalled by a `session.execution.succeeded` event. The plugin decides at each Turn End whether to send a Continuation Prompt.
_Avoid_: Idle event, session idle

**Skipped Idle**:
A Turn End that the plugin ignores because the agent is waiting on the user (pending permission or question) or a user message is already queued. Does not count as an Iteration.
_Avoid_: Pause, hold

**Max Iterations**:
The Iteration count at which a Loop stops on its own. Defaults from the plugin option; a per-Loop flag can override it.
_Avoid_: Limit, budget

**Completion Promise**:
The exact `<promise>TEXT</promise>` marker the agent must output to stop the Loop. `TEXT` defaults to `DONE` and can be set per Loop.
_Avoid_: Done tag, completion tag, sentinel

**Continuation Prompt**:
The prompt the plugin injects when the Loop Session goes idle without a Completion Promise. Contains the Iteration header, the Rules, and the Task.
_Avoid_: Nudge, re-prompt, continue message

**Rules**:
The fixed instruction block inside every Continuation Prompt: do not output a false Completion Promise, do not stop early, report blockers instead.
_Avoid_: Guardrails, constraints

**Notice**:
A synthetic message the plugin posts to the Loop Session so the user can see a Loop start, complete, hit Max Iterations, fail, or be cancelled.
_Avoid_: Toast, log, status message

**Stop Reason**:
Why a Loop ended: completed, max iterations, cancelled, interrupted, failed, or session deleted.
_Avoid_: Exit code, outcome

**Hard Cap**:
The absolute Max Iterations the plugin permits (500). A larger requested value is clamped and a Notice is posted.
_Avoid_: Ceiling, safety limit

**Resume**:
On plugin load, re-attaching to Loops persisted from before a service restart when their Loop Session still exists.
_Avoid_: Recover, restore

**Indicator**:
The footer text under the prompt that shows the viewed session's Loop: Iteration, Max Iterations, and whether the Loop is paused on a Skipped Idle.
_Avoid_: Status bar, badge, widget

**Loop Status**:
The read-only view of one Loop exposed to the TUI: iteration, max iterations, paused flag, and Task. Absent when the session has no Loop.
_Avoid_: State snapshot, loop info

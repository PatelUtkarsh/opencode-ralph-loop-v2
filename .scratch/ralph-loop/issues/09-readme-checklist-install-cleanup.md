# 09: README, manual checklist, global install, remove old skills

**What to build:** A user can read the README to install and configure the plugin. The full manual checklist has been run once against the real service and passed. The plugin is loaded globally for the user, and the three old shell-based skills are gone so the agent can no longer write the stale state file.

**Blocked by:** 05 (`/cancel-ralph`, `/ralph-status`, and the remaining Stop Reasons), 06 (Resume Loops after a service restart), 08 (TUI Indicator, toasts, and attention notifications)

**Status:** ready-for-agent

- [ ] README: what it does, install by absolute path, options (`maxIterations`, `promise`, `stopOnFailure`, `notify`), commands, Completion Promise rules, `--minimum-release-age=0` note, credits
- [ ] Manual checklist executed and results recorded under `## Comments`: plugin list shows both ids active; `--max 3` loop hits Max Iterations; promise loop completes with cost delta; `/cancel-ralph`; Esc; permission pause shows `paused`; `opencode service restart` mid-loop resumes
- [ ] Plugin added to the user's global `opencode.json` `plugin`/`plugins` array by absolute path
- [ ] `~/.config/opencode/skills/ralph-loop`, `cancel-ralph`, `help` removed
- [ ] `.scratch/ralph-loop/spec.md` status left unchanged; this ticket marked done

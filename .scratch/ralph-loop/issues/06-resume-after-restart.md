# 06: Resume Loops after a service restart

**What to build:** A user restarts the OpenCode service while a Loop is running. When the plugin loads again, the Loop continues without a new `/ralph-loop`. Loops whose session no longer exists are discarded.

**Blocked by:** 03 (Turn End continues the Loop or completes it)

**Status:** ready-for-agent

- [ ] Setup scans storage prefix `loop/` with cursor pagination
- [ ] For each entry, `ctx.session.get`; not-found removes the key
- [ ] For an existing session that is not currently executing, the entry is handled as a Turn End
- [ ] For an executing session, nothing happens; the next Turn End event handles it
- [ ] Context-seam tests: missing session dropped, idle session re-prompted, busy session untouched

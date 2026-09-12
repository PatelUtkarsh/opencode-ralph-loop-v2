# 01: Scaffold the repo and load an empty plugin

**What to build:** A user can add the repo path to `plugins` in an OpenCode config, restart the service, and see `ralph-loop` listed as `active` in the plugin list. Nothing else happens yet. A maintainer can run `bun test` and `tsc --noEmit` and both pass.

**Blocked by:** None (can start immediately)

**Status:** done

- [x] `package.json` with name `opencode-ralph-loop-v2`, MIT, `type: module`, exports `.`, `./tui`, `./rpc`, dependency `@opencode/plugin@2.0.2`, peer deps for OpenTUI and solid-js
- [x] `tsconfig.json` strict, no emit; `bun test` and `tsc --noEmit` scripts
- [x] Server entry default-exports `Plugin.define({ id: "ralph-loop", setup })` with an empty setup that returns a cleanup function
- [x] Placeholder `./tui` and `./rpc` modules so the exports resolve
- [x] Test helper that builds a fake plugin `Context` recording `session.*`, `permission.list`, `storage.*`, `command.transform`, `rpc.register`, and exposing a push-based `event.subscribe`
- [x] One smoke test: `setup(fakeCtx)` resolves and cleanup runs without error
- [x] Repo `opencode.json` includes `"plugins": ["./"]` (a bare `.` is treated as an npm spec; see ADR-0005); loading in the repo shows `ralph-loop` active via `opencode api get /api/plugin -H "x-opencode-directory:$PWD"` with features `server`, `tui`, `rpc` all true
- [x] `.gitignore` covers `node_modules`; README note about `bun install --minimum-release-age=0`

## Comments

- Observed: `[('ralph-loop', {'status': 'active'}, {'type': 'local', 'path': '.../index.ts'}, {'server': True, 'tui': True, 'rpc': True})]`.
- Local-path loading ignores `package.json` `exports` and probes `<dir>/index`, `<dir>/tui`, `<dir>/rpc`. Root re-export files added; ADR-0005 records why.
- `bun test` 1 pass; `tsc --noEmit` clean.

# Universal Explorer

A runtime for agent harnesses (first: Hermes Agent), native and in-browser
(wasm) as equals. Root holds three directories: **machine** (read-only, from
Nix), **datacombs** (persistent, versioned, auditable), **cache** (discardable).
See `GLOSSARY.md`.

## Agent skills

Planning runs through the `/wayfinder` skill (vendored from mattpocock/skills
@ dd400c3, MIT — see `.claude/skills/`).

- Issue tracker: **local markdown**, see `docs/agents/issue-tracker.md`.
- Effort map: `.scratch/universal-explorer/map.md`; tickets in `.scratch/universal-explorer/issues/`.
- Domain language: `GLOSSARY.md`; decisions: `docs/adr/` (created lazily).

# Wayfinder

A Linux distro built on three storage tiers: a read-only system from Nix, a
read-write versioned/auditable ledger for persistent files, and a fast
self-cleaning RAM→disk cache.

## Agent skills

Planning runs through `/wayfinder` (vendored from mattpocock/skills @ dd400c3,
MIT — see `.claude/skills/`).

- Issue tracker: **local markdown** — see `docs/agents/issue-tracker.md`.
- Effort map: `.scratch/wayfinder-distro/map.md`, tickets in `.scratch/wayfinder-distro/issues/`.
- Domain language: `GLOSSARY.md` (created lazily); decisions: `docs/adr/`.

# What Hermes needs from its environment

Type: research
Status: resolved
Blocked by:

## Question

What does the Hermes Agent harness (Nous Research) need from the machine it runs on?
- language and runtime
- install method and Nix packaging status
- where it keeps state, memory and config
- how it runs tools and shells, including existing sandbox or "terminal backend" options
- network needs
- which directories churn heavily, which hold durable state, and which are reproducible

Findings: branch `research/hermes-environment`, `docs/research/hermes-environment.md`.

This feeds where its paths land across machine, datacombs and cache, and what one change in its history should mean.

## Answer

Hermes (NousResearch/hermes-agent @ a50406d) has these needs:

- **Runtime:** Python 3.11+ with Node, SQLite (FTS5, WAL), bash and Chromium. An upstream uv2nix flake and NixOS module exist, but upstream calls them best-effort and they track nixos-unstable.
- **State:** everything lives under one `HERMES_HOME` (`~/.hermes`), as one writable root. On Nix installs the code and venv already live outside it, in the store.
- **Tool execution:** a `terminal` tool with pluggable backends (local, docker, ssh, modal and others). The local backend gives no isolation; upstream says only OS-level isolation is a real boundary.

Mapping its directories onto our tiers:

- **machine:** the code, venv, bundled skills, Node and other tools, all from the flake.
- **datacombs:** config, secrets, `memories/`, `skills/`, cron, plugins, `home/`, `sandboxes/`, `state.db`, and the durable media and citations subdirectories of `cache/`.
- **cache:** `cache/{scratch,terminal,exec,spillover,web,...}`, browser profiles, checkpoints, and the downloadable runtimes and models (these can reach hundreds of GB). Hermes honours `TMPDIR`.

Constraints this surfaces for later tickets:

1. One `HERMES_HOME` has to be split across three tiers. Hermes's own `cache/` mixes discardable data with durable data.
2. `state.db` is a live multi-process SQLite file with WAL, so versioning it needs snapshot-style capture. WAL also needs mmap and fcntl locks, including in the browser.
3. `state.db` and `logs/` churn continuously, which pressures commit frequency.
4. We still have to decide whether the VM is the sandbox boundary.
5. We still have to decide whether to pin a Hermes revision.

Full findings: branch `research/hermes-environment`, `docs/research/hermes-environment.md`.

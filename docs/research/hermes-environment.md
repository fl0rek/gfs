# What Hermes needs from its environment

Research for ticket `01-what-hermes-needs-from-its-environment`.

- **Subject:** Hermes Agent by Nous Research, MIT-licensed.
- **Repository:** <https://github.com/NousResearch/hermes-agent>
- **Commit read:** `a50406d9b7474b060450d2dcaff8743c977d296a` (`main`, committed 2026-10-07). It was a shallow clone, read but never executed.
- **Citation form:** `path` means that file at the commit above, for example `https://github.com/NousResearch/hermes-agent/blob/a50406d9b7474b060450d2dcaff8743c977d296a/<path>`. Docs are under `website/docs/` in the same tree. The published docs site is <https://hermes-agent.nousresearch.com/docs/>.
- **Labels:** "Fact" means read in code or docs. "Suggestion" means my inference, and the human decides. Anything I did not verify is listed under Open questions.

## 1. Language and runtime

- **Fact: the core is Python.**
  - `pyproject.toml` has `requires-python = ">=3.11,<3.15"`.
  - Its comment says first-party installs run 3.14 and that the lower bound exists only so old installs can update (`pyproject.toml` lines 1-20).
  - `website/docs/getting-started/installation.md` line 157 says current first-party installs run Python 3.14.
- **Fact: entry points** are `hermes`, `hermes-agent` and `hermes-acp` (`pyproject.toml`, `[project.scripts]`).
- **Fact: a Node.js layer exists.**
  - There is a TUI (`ui-tui/`) and a dashboard (`web/`).
  - `website/docs/getting-started/installation.md` (around lines 69, 161 and 169) says PM provides pinned Python, Node.js, npm, ripgrep and FFmpeg.
  - On glibc Linux the managed Node links `libatomic.so.1`.
  - Playwright Chromium is used for browser tools, and the Dockerfile puts it in `/opt/hermes/tools`.
- **Fact: "PM" is Hermes's own package manager.**
  - It lives in `pm/`, with `pm/lock.json` as its lockfile, and it owns Python deps and tool binaries.
  - `pm/AGENTS.md` says never mutate Hermes environments with raw pip or uv.
  - `pm/paths.py` resolves the store: `HERMES_RUNTIME_DIR`, else the install stamp's `runtimeDir`, else `<HERMES_HOME>/tools` (`pm/environments.py`, `store_root`).
- **Fact: SQLite is a hard dependency.**
  - The state DB needs FTS5 (`hermes_state_schema.py` probes `CREATE VIRTUAL TABLE ... USING fts5`) and WAL mode.
  - The Dockerfile builds SQLite 3.53.4 from source because Debian's 3.46.1 has the upstream WAL-reset corruption bug (`Dockerfile` header comment).
- **Fact: Hermes needs bash.**
  - The `terminal` tool runs commands through bash, found by `_find_bash()` (`tools/environments/local.py` line 515).
  - On Windows that bash is Git for Windows, bundled by PM.
  - The error text reads "Hermes needs bash (Git for Windows on Windows)".
- **Fact: Hermes uses POSIX-style IPC where available.**
  - It uses AF_UNIX sockets (`gateway/shutdown_watchdog.py`, `<HERMES_HOME>/state/gateway.loop-tick.<pid>.sock`).
  - `execute_code` falls back to loopback TCP on Windows (`tools/code_execution_tool.py` line 39).
  - It also uses fcntl byte-range locks and mmap for SQLite WAL (`hermes_state_wal.py` lines 25-29).

## 2. Install method and Nix packaging

- **Fact: supported installs (Tier 1)** are desktop bundles, `install.sh` and `install.ps1`, and Docker.
  - Source: `website/docs/getting-started/platform-support.md`, `README.md` ("Quick Install").
  - `install.sh` clones `https://github.com/NousResearch/hermes-agent.git` into `${HERMES_HOME}/hermes-agent` by default (`scripts/install.sh` lines 23 and 85). It then runs PM for Python 3.14, Node, ripgrep and FFmpeg.
  - So on a source install the code and venv live inside the state directory (`~/.hermes/hermes-agent`).
  - The backup code excludes that directory with the comment "the codebase repo — re-clone instead" (`hermes_cli/backup.py` line 73).
- **Fact: Nix packaging exists in the upstream repo and is Tier 2, best effort.**
  - There is a flake (`flake.nix`, input `nixpkgs/nixos-unstable`) and `nix/` with uv2nix builds: `nix/packages.nix`, `nix/hermes-agent.nix`, `nix/python.nix`.
  - It also has a NixOS module (`nix/nixosModules.nix`), a Home Manager module (`nix/homeManagerModules.nix`) and a desktop package (`nix/desktop.nix`).
  - `website/docs/getting-started/nix-setup.md` says: "Tier 2 platform ... maintained on a best-effort basis only. Commits to `main` may break these packages at any point". `installation.md` line 179 says Nix is "no longer an explicitly supported install path".
  - The Nix package `default` is the `full` variant, with all platform-portable optional dependency groups prebuilt (`nix/packages.nix`).
  - Runtime tools are wrapped onto `PATH`: node, ripgrep, git, openssh and ffmpeg, plus wl-clipboard and xclip on Linux (`nix/hermes-agent.nix` lines 145-155).
  - The code and venv are in the store, sealed. The install stamp records `source = "nix"` and `updateMechanism = "external"`.
  - `HERMES_INSTALL_ROOT` points PM at the sealed tree (`pm/paths.py`).
  - Nix pins its Python from `pm/lock.json` via `nix/pythonLock.nix`.
- **Not verified:** whether `hermes-agent` is in nixpkgs itself. WebFetch of search.nixos.org returned no results and GitHub's nixpkgs tree is robots-blocked. The upstream flake follows `nixos-unstable`.
- **Fact: Docker is the other sealed packaging.**
  - `/opt/hermes` is the immutable root-owned app tree, `.pyc` writes are disabled, and mutable state lives only under `/opt/data`.
  - `website/docs/user-guide/docker.md`, "Immutable install tree" and `Dockerfile` env comments.
  - `docker-compose.yml` bind-mounts `~/.hermes:/opt/data`, uses `network_mode: host`, and the dashboard binds `127.0.0.1:9119`.
- **Fact: managed mode.** When `HERMES_MANAGED` is set, or a `.managed` marker file is in `HERMES_HOME`, config-mutating and update commands are blocked (`website/docs/getting-started/nix-setup.md`, "Managed Mode"; `hermes_constants.py` lines 769-781).

## 3. Where state, memory and config live

- **Fact: everything is rooted at one directory, `HERMES_HOME`.**
  - Resolution order is a context-local override, then the `HERMES_HOME` env var, then the platform default (`hermes_constants.py`, `get_hermes_home` line 111 and `_get_platform_default_hermes_home` line 51).
  - The default is `~/.hermes` on Linux and macOS, and `%LOCALAPPDATA%\hermes` on Windows. `HERMES_DATA_DIR_SUFFIX` appends a suffix.
  - The docs say `HERMES_HOME` is the authoritative resolver (`website/docs/developer-guide/session-storage.md`).
  - Profiles are isolated homes at `<root>/profiles/<name>/`, each with its own `state.db`, config and so on. `HOME` is not how profiles are selected.
- **Fact: top-level layout of `HERMES_HOME`**
  - Sources: `website/docs/user-guide/configuration.md` "Directory Structure", `website/docs/user-guide/docker.md` "Persistent volumes", and the dir list `_HERMES_HOME_SUBDIRS` in `hermes_cli/config.py` line 568. Every path below was also seen in a code reference.

| Path | What it is |
|---|---|
| `config.yaml` | all non-secret settings |
| `.env` | secrets and API keys |
| `auth.json` | OAuth credentials |
| `SOUL.md` | agent identity |
| `state.db` (+ `-wal`, `-shm`) | SQLite: sessions, messages, FTS5, gateway routing. Docs: `session-storage.md`. |
| `memories/` | `MEMORY.md` (2,200-char limit) and `USER.md` (1,375-char limit), written by the agent's `memory` tool. Docs: `user-guide/features/memory.md`. |
| `skills/` | agent-created skills, including a restorable `skills/.archive/` |
| `cron/` | scheduled jobs |
| `sessions/` | gateway sessions |
| `logs/` | `agent.log`, `errors.log`, `gateway.log` and others, rotating (`hermes_logging.py`) |
| `hooks/`, `plugins/`, `pairing/`, `skins/`, `mcp-tokens/` | user and extension state |
| `home/` | per-profile `HOME` for tool subprocesses, used in containers |
| `checkpoints/` | opt-in shadow git store for `/rollback` (`checkpoints-and-rollback.md`), default cap 500 MB, 7 days |
| `sandboxes/` | Docker-backend persistent bind dirs (`TERMINAL_SANDBOX_DIR`, `tools/environments/docker.py` line 825) |
| `state/` | gateway runtime sockets and the like |
| `cache/` | see section 6 |
| `installs/`, `tools/`, `models/`, `runtimes/`, `node/`, `hermes-agent/` | machine-specific runtime downloads and the source checkout |

- **Fact: config precedence** is CLI args, then `config.yaml`, then `.env`, then built-in defaults (`configuration.md`, "Configuration Precedence").
- **Fact: single writer per home.**
  - Memory docs: "Don't point two agent processes at the same Hermes home directory" (`features/memory.md`).
  - Docker docs: never run two gateway containers against one data dir (`docker.md`).
  - The gateway process and the CLI do share a home in normal use, for example via `addToSystemPackages` in the NixOS module. So the real rule is one agent identity and one gateway per home.
- **Fact: `state.db` filesystem constraints.**
  - WAL is the default and needs shared mmap and fcntl locks.
  - Hermes detects virtiofs and 9p and creates new DBs in DELETE journal mode. It never live-downgrades an existing WAL DB.
  - NFS, SMB and generic FUSE are not auto-detected, so set `database.journal_mode: delete` there (`docker.md`, "Filesystem requirements for state.db in containers"; `configuration.md`, "Database Settings"; `hermes_state_wal.py`).
- **Fact: Hermes has its own export and backup logic** (`hermes_cli/backup.py`). It snapshots `*.db` via `sqlite3.backup()` and excludes WAL, SHM and journal sidecars, because pairing a fresh snapshot with a stale sidecar produces a torn restore.

## 4. How Hermes executes tools and shells

- **Fact: the `terminal` tool is the execution surface, and it has seven pluggable backends.**
  - The backends are `local | docker | ssh | modal | daytona | vercel_sandbox | singularity`.
  - Config key: `terminal.backend` in `config.yaml`. Docs: `configuration.md`, "Terminal Backend Configuration". Code: `tools/environments/{local,docker,ssh,modal,managed_modal,daytona,vercel_sandbox,singularity}.py`, with `base.py` as the shared contract.
  - A plugin guide exists for adding more (`website/docs/developer-guide/terminal-environment-plugin.md`).
- **Fact: the file tools run through the same backend.** `read_file`, `write_file` and `patch` "are implemented on top of the shell contract" (`SECURITY.md` section 2.2). So switching backend moves both shell and file effects.
- **Fact: `local` is the default and has no isolation.** Commands run as the user. Subprocesses keep the real OS `HOME` by default (`terminal.home_mode: auto`). In `profile` mode, `HOME` becomes `<HERMES_HOME>/home` (`configuration.md`, "Local Backend").
  - The local backend spawns per call, with a session snapshot (`tools/environments/local.py` docstring).
  - Provider and internal secrets are stripped from the subprocess environment (`tools/environments/local_env_policy.py`).
- **Fact: `docker`**
  - One long-lived container is shared across sessions, `/new`, subagents and Hermes processes. Commands go through `docker exec`.
  - It runs with `--cap-drop ALL`, `--security-opt no-new-privileges` and PID limits (`tools/environments/docker.py` lines 308 and 379; `configuration.md`, "Docker Backend").
  - Persistent mode bind-mounts `/workspace` and `/root` from `~/.hermes/sandboxes/` (`docker.py` lines 825-890). Extra mounts come from `docker_volumes`, and `docker_mount_cwd_to_workspace` mounts the cwd.
  - `container_persistent: false` gives one fresh container per session.
  - This backend can use the optional iron-proxy egress proxy, which holds real API keys on the host and gives the sandbox only opaque tokens (`user-guide/egress/iron-proxy.md`).
- **Fact: `ssh`** runs commands on a remote host, with persistent shell on by default (`configuration.md`, "SSH Backend" and "Persistent shell").
- **Fact: `modal`, `daytona` and `vercel_sandbox`** are cloud sandboxes. `modal` has a direct mode and a Nous-managed gateway mode.
  - For `ssh`, `modal` and `daytona`, Hermes pushes `~/.hermes` state (credential files, skills, cache) into the sandbox, then syncs changed files back on teardown.
  - The sync-back has a 2 GiB archive cap (`terminal.sync_back_max_bytes`) and is retried up to 3 times (`configuration.md`, "Remote-to-Host State Sync on Teardown").
- **Fact: `singularity`** runs Apptainer with `--containall`, for HPC and shared hosts.
- **Fact: the approval gate is not a boundary.**
  - `tools/approval.py` does dangerous-command detection.
  - `SECURITY.md` section 2.2 says: "The only security boundary against an adversarial LLM is the operating system", and "Nothing inside the agent process constitutes containment".
  - It names terminal-backend isolation as one of two OS-level postures. I did not read the second posture, and I read only part of that file.
- **Fact: other execution surfaces**
  - `execute_code` runs Python scripts that call tools over RPC, via AF_UNIX or loopback TCP (`tools/code_execution_tool.py`).
  - `delegate_task` spawns subagents that share the parent's container.
  - There is a background process registry (`tools/process_registry.py`), browser automation through Playwright Chromium, CDP and other providers (`tools/browser_*.py`), and MCP servers as subprocesses or remote (`tools/mcp_tool.py`).
  - Memory provider plugins live in `plugins/memory/`: byterover, holographic and retaindb.

## 5. Network needs

- **Fact: outbound is the main need.**
  - The harness calls an LLM provider over HTTPS: Nous Portal, OpenRouter, OpenAI, Anthropic, a custom endpoint, a local server such as Ollama or vLLM, and others (`README.md`, `website/docs/integrations/providers`, and `docker.md` "Connecting to local inference servers").
  - TLS trust comes from the OS certificate store through `truststore` (`pyproject.toml` comments, `agent/ssl_verify.py`).
  - Other outbound destinations are web tools (`firecrawl`, `exa` and so on), model metadata from models.dev (cached to `~/.hermes/models_dev_cache.json`, `agent/models_dev.py` lines 4 and 217), skills hub and updates from GitHub, and messaging platform APIs (Telegram, Discord, Slack and others).
  - A built-in private-IP guard rejects RFC 1918, loopback, link-local and cloud-metadata destinations for web tools, the browser, vision and gateway media. It has a global opt-out (`user-guide/security.md`).
- **Fact: inbound listeners are optional and mostly default to loopback or off.**
  - The dashboard defaults to `127.0.0.1:9119` (`hermes_cli/main_dashboard.py` line 57).
  - The API server, off unless configured, defaults to port 8642. Generic webhooks default to 8644. Other platform webhooks use 8080, 8090, 8443, 8645 and 8646.
  - Port defaults are from `website/docs/reference/environment-variables.md`.
  - Docker compose uses host networking.
- **Fact: a fully offline run needs a local model endpoint.** I did not find any component that works without some LLM endpoint.
- **Fact: there is no outbound telemetry by default** in what I read: `PHOTON_TELEMETRY` defaults to false (`environment-variables.md` line 719). I did not audit all code paths for phone-home beyond this.

## 6. Churn, durability and reproducibility by path

Everything below is relative to `HERMES_HOME` unless stated. The classes are "heavy churn", "durable", and "reproducible", meaning it can be rebuilt from Nix or network.

### Reproducible: outside `HERMES_HOME` when packaged with Nix or Docker

| Path | Evidence |
|---|---|
| The Hermes code, the venv, `skills/` and `optional-skills/` bundled with the package, the TUI and web builds, Node, ripgrep, git, ffmpeg | In the Nix store via the wrapper, or `/opt/hermes` in Docker. Env vars `HERMES_BUNDLED_SKILLS`, `HERMES_OPTIONAL_SKILLS`, `HERMES_OPTIONAL_MCPS` and `HERMES_INSTALL_ROOT` relocate them (`hermes_constants.py` lines 380-410, `pm/paths.py`). |

### Reproducible but live inside `HERMES_HOME` on non-Nix installs

| Path | Evidence |
|---|---|
| `hermes-agent/` (source checkout), `installs/`, `tools/`, `node/`, `models/`, `runtimes/` | `hermes_cli/home_data_layout.py` ("Machine-specific state excluded from portable home transfers"); `hermes_constants.py` line 205 (`LOCAL_RUNTIME_ROOT_DIRS`: re-downloadable, "routinely tens to hundreds of GB"). |
| Browser profiles (`browser-profiles/`, `browser-profile/`, `browser_profiles/`) | Excluded from backups as regenerable (`backup.py` lines 74-99). |
| `__pycache__`, `.venv`, `node_modules`, tool caches | `backup.py` `_EXCLUDED_DIRS`. |

### Heavy churn, discardable

| Path | Evidence |
|---|---|
| `cache/scratch/` | Hermes points `TMPDIR`, `TMP` and `TEMP` for itself and all children here, but only if unset. Entries idle 24 h are pruned at most hourly, after killing processes whose cwd is inside and dropping `git worktree` registrations. `hermes_constants.py` lines 744 and 892; `hermes_constants_scratch.py`. |
| `cache/terminal/` | Background-process logs, pid and exit files, code-execution sandboxes and spilled tool results. Pruned after 24 h idle (`tools/environments/local.py`; `configuration.md`, "Terminal Backend Configuration"). `terminal.temp_dir` redirects it. |
| `cache/exec/`, `cache/spillover/`, `cache/web/`, `cache/vision/`, `cache/delegation/`, `cache/partials/` (PM download partials), `cache/model_catalog/`, `cache/piper-voices/`, `cache/ms-playwright/` | Seen in code references; I did not read all of them. `backup.py` lines 100-105 says `cache/` "mixes regenerable state ... with durable artifacts" and archives only the subdirs listed next. |

### Heavy churn, durable

| Path | Evidence |
|---|---|
| `state.db`, `state.db-wal`, `state.db-shm` | Written on every message in WAL mode. Holds the full message history. The WAL and SHM sidecars are not portable. `hermes_state*.py`; `session-storage.md`; `backup.py` line 124. Session compaction archives rows with `active=0` rather than deleting them. |
| `logs/` | Rotating logs (`hermes_logging.py` uses `RotatingFileHandler`). The prune log is 5 MB with 3 backups. Secrets are redacted (`configuration.md`). Durable-ish and not needed for correctness. |
| `checkpoints/` | Only if enabled. Capped (default 500 MB) and pruned by age. Excluded from portable backup as regenerable cache (`backup.py` line 76). |

### Durable, low churn

| Path | Evidence |
|---|---|
| `config.yaml`, `.env`, `auth.json`, `SOUL.md`, `memories/`, `skills/` (including `skills/.archive/`), `cron/`, `plugins/`, `hooks/`, `pairing/`, `mcp-tokens/`, `skins/`, `profiles/`, `sandboxes/`, `home/` | Never in the backup exclusion list. `skills/.archive/` is explicitly kept ("restorable user skills", `backup.py` lines 70-71). |
| `cache/{images,audio,videos,documents,screenshots,citations}` and `cache/generated` | The backup code keeps only these `cache/` subdirs because "nothing can rebuild" media the gateway delivered or received, and the grounded-citations evidence ledger (`backup.py` `_KEPT_CACHE_SUBDIRS`, lines 100-110). |
| `models_dev_cache.json` and other root-level `*.json` caches (`provider_models_cache.json`, `sticker_cache.json`) | Regenerable files that live outside `cache/`. Seen in code references only. |

### Runtime-only files

- `gateway.pid`, `cron.pid`, `.backup.lock`, `.mcp-discovery.lock`, `.clean_shutdown`, `.update_*`, and `state/*.sock`.
- `backup.py` excludes `gateway.pid`, `cron.pid` and `.backup.lock`, and import refuses to overwrite runtime state files that belong to the source machine's PIDs (`backup.py` lines 127-145).
- The others are listed here from code references only.

## 7. Implications for machine / datacombs / cache

This section maps paths to tiers. The "Fact" lines describe Hermes. The "Suggestion" lines are mine and decide nothing.

**Facts that constrain the mapping**

- Hermes wants one writable root, `HERMES_HOME`, and cannot split it by itself. It makes a single `cache/` under it that mixes discardable and durable data (section 6).
- On Nix and Docker installs the code is already outside `HERMES_HOME`. Nix needs `HERMES_INSTALL_ROOT` set (done by the wrapper), and the bundled-skills env vars must point at store paths.
- Hermes already treats `TMPDIR` as a thing to redirect and prune. It sets it to `cache/scratch` only when the variable is unset (`hermes_constants.py`), and `terminal.temp_dir` and `TERMINAL_TEMP_DIR` redirect the terminal temp.
- `state.db` needs a filesystem with working mmap shared memory and fcntl locks. Otherwise set `database.journal_mode: delete`. It is a live multi-writer SQLite file, with WAL and SHM sidecars.
- The `local` backend gives the agent the user's full privileges. Isolation comes from the OS or from a non-local backend, not from the agent process (`SECURITY.md` section 2.2).
- The `docker` backend's persistent state lands in `HERMES_HOME/sandboxes/` and `HERMES_HOME/home/`, so it lands wherever `HERMES_HOME` is.

**Path to tier, as a suggestion**

| Tier | Paths | Notes |
|---|---|---|
| **machine** (read-only, from Nix) | Hermes code and venv, bundled `skills/`, `optional-skills/`, `optional-mcps/`, TUI and web builds, Node, ripgrep, git, openssh, ffmpeg, Python 3.14, SQLite with FTS5 | The upstream flake already builds all of this (Tier 2, best effort). Use the `full` variant for optional groups. Hermes-specific env vars that must be set: `HERMES_HOME`, `HERMES_INSTALL_ROOT`, the bundled-skills vars, and `HERMES_MANAGED` if updates and config writes should be blocked. |
| **datacombs** (versioned, auditable) | `config.yaml`, `.env`, `auth.json`, `SOUL.md`, `memories/`, `skills/`, `cron/`, `plugins/`, `hooks/`, `profiles/`, `mcp-tokens/`, `pairing/`, `home/`, `sandboxes/`, `state.db`, and the durable media subdirs of `cache/` | A "change" in the history could map to a change in agent memory, skills or config. `memories/` and `skills/` are small text and fit a per-commit model naturally. `state.db` is the awkward member (see below). Secrets (`.env`, `auth.json`, `mcp-tokens/`) are in the same tree, which bears on the open question about encryption at rest and signing. |
| **cache** (RAM, spilled to disk, auto-cleaned) | `cache/scratch/`, `cache/terminal/`, `cache/exec/`, `cache/spillover/`, `cache/web/`, `cache/vision/`, `cache/delegation/`, `cache/partials/`, `browser-profiles/`, `checkpoints/`, `__pycache__`, and the PM store (`tools/`, `installs/`, `node/`, `models/`, `runtimes/`) if not provided by machine | `TMPDIR` is the natural bridge, since Hermes honours it. Hermes's own 24 h idle pruning would be redundant with cache cleanup but harmless. `models/` and `runtimes/` can be tens to hundreds of GB, so "held in RAM" needs a size policy. |

**Things the human needs to decide, flagged and not decided**

1. **`HERMES_HOME` is one directory, but the tiers want three.** Options include bind or overlay mounts of the subpaths above, symlinks, or a per-subdir env var where one exists. Hermes has a few per-dir overrides (`HERMES_BUNDLED_SKILLS`, `terminal.temp_dir`, `TERMINAL_SANDBOX_DIR`, `HERMES_RUNTIME_DIR`) but none for `cache/` as a whole. The stock `cache/` is a mix, so a mount of the whole of it as discardable would lose the durable media and citations (section 6).
2. **`state.db` as a versioned object.**
   - It is a single binary SQLite file with live WAL, and Hermes expects it to be opened by multiple processes. A byte-level commit per change would have to be taken as a `sqlite3.backup()`-style snapshot (what Hermes's own backup does), not a raw file copy.
   - It also means "preview its past" for sessions is an application-level question. Hermes has its own session export and rewind code (`hermes_state_rewind.py`, `hermes_state_timeline.py`, `hermes_state_portability.py`), which I only saw by filename and did not read.
   - The WAL filesystem constraint applies to whatever backs the datacombs mount, including a browser-backed one. This is relevant to the wasm check: SQLite WAL needs shared memory and locks.
3. **Churn inside a durable tier.** `logs/` and `state.db` are written continuously, so they set the commit frequency and history growth. Hermes already rotates `logs/` and prunes sessions only on request (`hermes sessions prune`).
4. **Where the sandbox boundary sits.** The `local` backend is not a boundary. A non-`local` backend, for example `docker`, would live next to or inside the harness. Which one, and whether the VM itself counts as the OS-level isolation that `SECURITY.md` asks for, is a design choice.
5. **Native, wasm and platform fit.** Hermes needs bash, subprocess spawning, fcntl and mmap-backed SQLite, and Chromium for browser tools. Those are Linux-VM-friendly. A browser-wasm build would need an emulated Linux guest, since the Python 3.14 stack, Node and Chromium are not wasm-native.
   - Hermes upstream supports Windows natively via Git for Windows bash, so Windows host specifics are a separate question.
   - I did not research wasm emulation here.
6. **Nix support is best-effort upstream.** The flake follows `nixos-unstable` and "commits to `main` may break these packages at any point". Pinning a Hermes revision is a decision for the human.

## 8. Open questions and things not verified

- Whether `hermes-agent` is packaged in nixpkgs itself (the fetch was blocked).
- The full contents of `sessions/` when using `state.db`. The docs call it "Gateway sessions", and the schema in `hermes_state_schema.py` is SQLite. I did not read the gateway session store.
- Log rotation limits other than the prune log, and the actual disk growth rate of `state.db`.
- The remaining `cache/*` subdirs were identified by grep only. Their lifetimes and pruning were read only for `scratch` and `terminal`.
- Size and churn numbers are not measured. Nothing was run.
- I read `SECURITY.md` only through the start of the terminal-backend isolation section, so the second OS-level posture is unread.
- Outbound network destinations were gathered from docs and the provider list, not from a complete code audit.

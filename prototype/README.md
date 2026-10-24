# pi on gfs — prototype

**Throwaway.** This is a single-node, browser-only prototype built to feel out the shape of Universal Explorer: a coding agent whose entire world is a versioned filesystem. Nothing here is the architecture; it exists to be reacted to.

What it is:

- **pi** (`@earendil-works/pi-agent-core` + `pi-ai`) runs in a **Web Worker**. Its four tools (`read`, `write`, `edit`, `bash`) are reimplemented over gfs with pi's own schemas, so a real model sees the tools it knows.
- **gfs** is a Rust crate compiled to wasm (`gfs-core/`): content-addressed objects (BLAKE3), trees, and a hash-chained history per comb. Every tool call that changes a comb becomes **one history entry** attributed to that call (tool name, call id, turn, args stored by hash, author = the session, committer = the node). Rollback appends an entry; nothing is rewritten. The chain can be verified.
- **bash is real**: GNU bash (WASIX, built by the flake in `machine/`) running under the Wasmer JS SDK's runtime, inside the same worker, and it sees the same root the harness does: `/datacombs/<comb>` for every comb, `/nix`, cwd `/datacombs/workspace`. The runtime only lets the host write under `/workspace` and forgets changes to `/` between processes, so each command runs in a wrapper bash that copies the host's staging mirror to `/`, runs the command, and copies the combs back for the host to diff; whatever changed is a history entry, and a change under `/nix` is a switch. The `@<entry>` views are not mounted in the shell. Every module is pinned by sha256 in `/nix/machine.json` and served from our own origin.
- **`!cmd`** in the console runs in that same shell directly, as you. Changes land as an `external` entry (author: you at the shell), distinct from pi's tool calls.
- **Persistence** is OPFS: every object and ref is written as it is created and loaded back on start. Reload the tab; the history, the files and the conversation are still there.
- **The conversation is itself a comb** (`/datacombs/session`): the transcript is committed once per turn, so "what was said" and "what changed" live in the same kind of history.
- **Network**: pi has a `fetch` tool. A page can only fetch what CORS allows, so `prototype/extension/` is the escape hatch: a WebExtension that relays fetches with host permissions; the worker falls back to it whenever a direct fetch is refused, for the tool and for the LLM calls alike. No relay server anywhere. bash has no sockets (an extension can't give TCP).
- **`/nix`**: a comb holding the running system's flake (`flake.nix`) and its built form (`machine.json`: the packages the shell sandbox loads, each pinned by sha256). Any history entry that changes `machine.json` rebuilds the shell from it — commit is switch — and the switch itself is then recorded as an entry of its own kind (`switch`: which entry is now running, which was before), shown in every comb's timeline. A package whose bytes don't match is refused and the old system keeps running; rolling `/nix` back switches back. The header shows `system /nix@<entry>`.
- **`machine/`**: the Nix flake that builds that system: a WASIX toolchain (stock nixpkgs LLVM 20 + binaryen + the prebuilt wasix-libc sysroot, flags from wasixcc) and GNU bash 5.2 (wasix-org fork), coreutils 9.12, grep, sed, gawk, findutils and diffutils as WASIX wasm: 12 modules, 108 commands, 18 MB. CI runs `nix build .#machine` and the web build turns its output into the deployed `machine.json`, so the hosted site runs a system that is 100 % Nix-built and never talks to wasmer.io (the registry packages remain only as a fallback when the flake isn't built). `machine/NOTES.md` has the build log, the gnulib cross-compile fixes, and the three Wasmer-runtime quirks shimmed in `compat/wasix-quirks.c` (lseek/fstat on pipes, `program_invocation_name`).
- Two views: pi's console, and the timeline of a comb from genesis to now, with the conversation interleaved, per-entry diffs, the tool-call arguments, the tree at any point (`/datacombs/<comb>@<entry>`), rollback and chain verification. A Files view lets you edit a comb by hand; saving is an `external` entry, which on `/nix` is the hand-driven switch.

## Run it

Hosted build: https://fl0rek.github.io/gfs/ (deployed from this branch by `.github/workflows/prototype-pages.yml`).

Locally (needs Rust, `wasm32-unknown-unknown`, `wasm-bindgen-cli` 0.2.129, Node 22, pnpm):

```sh
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.129 --locked
./prototype/build-wasm.sh          # gfs-core → web/src/gfs-wasm/
cd prototype/web && pnpm install && pnpm dev
```

The dev server sends COOP/COEP headers (the WASIX runtime needs `SharedArrayBuffer`). On GitHub Pages, which cannot send headers, `coi-serviceworker.js` adds them; the first load reloads once.

Models: **free** rides whichever free tier is up, using [ANUS](https://github.com/anus-dev/ANUS)'s ranked list and rest rules (MIT; `web/src/free.ts`): paste keys for OpenRouter, Google, Groq, Cerebras or Mistral and each request goes to the best awake model you hold a key for, with refused ones resting (a minute on a rate limit, until UTC midnight on a daily cap) and a cut-off answer retried elsewhere. **mock** (default) is a scripted agent that writes, runs bash, edits and answers, so everything works offline. **DeepSeek** and **OpenCode Zen** are wired through pi-ai; paste a key in the console (kept in `sessionStorage`, sent straight to the provider from the worker; CORS is the provider's decision). "openai-compatible" takes any base URL.

Tests (headless Chromium; `CHROME=/path/to/chromium`, with `pnpm build && pnpm preview` running): `test/e2e.mjs [url] [--extension]` runs a prompt, rollback, reload, verification and a `!` command; `test/system.mjs` covers `/nix` switching (good manifest, bad hash, rollback, reload); `test/egress.mjs` the fetch paths with and without the extension; `test/editor.mjs` the hand edit of `/nix`; `test/offline.mjs` proves the shell runs with wasmer.io blocked. `cargo test` in `gfs-core/`.

## What this prototype says

- pi's core packages are pure fetch-based TypeScript and run in a worker unchanged. Only the tools and the "session" wrapper are Node-bound. pi was the right pivot from Hermes for a browser-first prototype.
- One entry per tool call falls out naturally when the harness's tools are ours: the tool wrapper commits after each call, and `turn_id` comes from pi's `turn_start` event. No hook into the harness was needed.
- The WASIX shell works in a nested worker, but the Wasmer SDK must not be bundled (it spawns its pool from `import.meta.url`); it is copied verbatim and loaded at runtime.
- The Wasmer SDK resolves a package's dependencies by name against its registry (URL baked into the wasm core, 0.19.1), so shipping the `.webc` bytes alone is not enough; replaying the registry's recorded answer from our origin is. Wasmer's coreutils package has no grep/sed/awk/find; the system prompt says so.
- Two more Wasmer-SDK facts: `sandbox.fs` refuses paths outside `/workspace`, and the guest's `/` is fresh per process (symlinks at `/` can be created but not followed). Hence the wrapper-bash mirror. GNU `cp -a src/. dst/` fails on empty directories under WASIX (gnulib's return-to-cwd path); `cp -a src dst` works.
- The shell's filesystem is a mirror, not a mount: the SDK has no public custom-filesystem hook (there is an experimental host-filesystem RPC bridge used by their iOS prototype). The mirror is correct at tool-call granularity, which is the granularity history already has.
- Timeline + diff + "browse at @entry" + rollback-as-new-entry reads naturally; the conversation interleaved with entries is what makes "who changed what and why" legible.

Not here: replication, multi-node, signing, encryption, cache tier, Nix-built userland.

# pi on gfs — prototype

**Throwaway.** This is a single-node, browser-only prototype built to feel out the shape of Universal Explorer: a coding agent whose entire world is a versioned filesystem. Nothing here is the architecture; it exists to be reacted to.

What it is:

- **pi** (`@earendil-works/pi-agent-core` + `pi-ai`) runs in a **Web Worker**. Its four tools (`read`, `write`, `edit`, `bash`) are reimplemented over gfs with pi's own schemas, so a real model sees the tools it knows.
- **gfs** is a Rust crate compiled to wasm (`gfs-core/`): content-addressed objects (BLAKE3), trees, and a hash-chained history per comb. Every tool call that changes a comb becomes **one history entry** attributed to that call (tool name, call id, turn, args stored by hash, author = the session, committer = the node). Rollback appends an entry; nothing is rewritten. The chain can be verified.
- **bash is real**: `wasmer/bash` (WASIX) via the Wasmer JS SDK, inside the same worker. Its `/workspace` is synced from the comb before each command and back into it after, so a shell command is a tool call like any other.
- **Persistence** is OPFS: every object and ref is written as it is created and loaded back on start. Reload the tab; the history, the files and the conversation are still there.
- **The conversation is itself a comb** (`/datacombs/session`): the transcript is committed once per turn, so "what was said" and "what changed" live in the same kind of history.
- Two views: pi's console, and the timeline of a comb from genesis to now, with the conversation interleaved, per-entry diffs, the tool-call arguments, the tree at any point (`/datacombs/<comb>@<entry>`), rollback and chain verification.

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

Models: **mock** (default) is a scripted agent that writes, runs bash, edits and answers, so everything works offline. **DeepSeek** and **OpenCode Zen** are wired through pi-ai; paste a key in the console (kept in `sessionStorage`, sent straight to the provider from the worker; CORS is the provider's decision). "openai-compatible" takes any base URL.

Tests: `cargo test` in `gfs-core/`; `node test/e2e.mjs` drives the built page in headless Chromium (`CHROME=/path/to/chromium`, with `pnpm build && pnpm preview` running) through a prompt, rollback, reload and verification. `--shell=none` skips the WASIX shell.

## What this prototype says

- pi's core packages are pure fetch-based TypeScript and run in a worker unchanged. Only the tools and the "session" wrapper are Node-bound. pi was the right pivot from Hermes for a browser-first prototype.
- One entry per tool call falls out naturally when the harness's tools are ours: the tool wrapper commits after each call, and `turn_id` comes from pi's `turn_start` event. No hook into the harness was needed.
- The WASIX shell works in a nested worker, but the Wasmer SDK must not be bundled (it spawns its pool from `import.meta.url`); it is copied verbatim and loaded at runtime.
- The shell's filesystem is a mirror, not a mount: the SDK has no public custom-filesystem hook (there is an experimental host-filesystem RPC bridge used by their iOS prototype). The mirror is correct at tool-call granularity, which is the granularity history already has.
- Timeline + diff + "browse at @entry" + rollback-as-new-entry reads naturally; the conversation interleaved with entries is what makes "who changed what and why" legible.

Not here: replication, multi-node, signing, encryption, cache tier, Nix-built userland.

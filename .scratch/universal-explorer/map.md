# Universal Explorer

Label: wayfinder:map

## Destination

A proof-of-concept Universal Explorer runtime that you use daily to run the Hermes Agent harness, on every platform, natively and in a browser (wasm). A session boots from **machine**, writes to **datacombs**, and scratches in **cache**. You can see who changed what and when in a comb, verify its history chain, roll it back, and preview its past. After a restart, cache is gone and machine is unchanged. The map is done when everything needed to build that is decided.

## Notes

- Domain: OS and runtime for agent harnesses; content-addressed and versioned storage; Nix; VMs and wasm emulation.
- Skills every session should consult: `grilling` + `domain-modeling` (default), `research` for AFK fact-finding, `prototype` when "how should it look/behave" is the question. Read `GLOSSARY.md` first.
- Standing preferences:
  - Rust for anything we write.
  - **Native and wasm are first class.** Every format and mechanism decision must pass a "works in the browser too" check.
  - All platforms are the goal: Linux, macOS, Windows. **First host is the browser; the user's native host is Asahi Linux (aarch64).**
  - First iteration only has to run Hermes, not arbitrary nixpkgs.
  - Performance counts. It is meant to be a real tool, so no leaving performance on the table.
  - "Crypt-based" means content-addressed, hash-chained integrity. Replication across machines comes later, preferably by adopting an existing protocol rather than inventing one.
  - **No guest VM: we own the harness's world at the syscall level.** The userland is WASIX wasm built with Nix, gfs is the world's filesystem, and the same binaries run in the browser and natively (Wasmer). Heavy native work goes through offload.
  - Interfaces (paths like `/datacombs/nix`, how the past is previewed) emerge from use. Prototype before fixing them.
  - **Pace: start slow.** One ticket per session, no sudden ramp-ups.

## Decisions so far

<!-- one line per closed ticket -->

- [What Hermes needs from its environment](issues/01-what-hermes-needs-from-its-environment.md): Python + Node + WAL SQLite under one `HERMES_HOME`, whose subdirectories split cleanly across machine, datacombs and cache, except its mixed `cache/` and the live `state.db`. Pluggable terminal backends.
- [Booting a nixpkgs Linux image in the browser](issues/02-booting-a-nixpkgs-linux-image-in-the-browser.md): no full NixOS boot exists in a browser yet. qemu-wasm with an x86_64 guest is the only proven nixpkgs path (trynix). x86_64 and aarch64 are the only shared-image candidates. Browser persistence and networking are unsolved everywhere.
- [Native VM options per host platform](issues/03-native-vm-options-per-host-platform.md): guest arch must match host arch on Mac (aarch64 only) and under KVM. No single VMM library is clean across Linux, macOS and Windows; libkrun and OpenVMM come closest. A custom filesystem is easy on Linux (virtiofsd crate) but needs a vsock client on Mac.
- [Existing formats to adopt for datacombs](issues/04-existing-formats-to-adopt-for-datacombs.md): no single format covers every layer. git (gitoxide or isomorphic-git) has a history chain and browser builds; Xet, restic and borg bring content-defined chunking. `state.db` capture has four candidate approaches. Nothing has been benchmarked.
- [Guest architecture and platform matrix](issues/05-guest-architecture-and-platform-matrix.md): no guest VM. We own syscalls; the userland is WASIX wasm built with Nix; gfs is the world's filesystem; the same binaries run in browser and native at about 1.5×. Offload for heavy native work. qemu-wasm is the fallback.
- [What one datacomb is](issues/06-what-one-datacomb-is.md): a comb is one top-level directory with its own git-style history and is a full flake; its version is the head hash. Each node holds a subjective view of one global structure; same-named combs coexist as versions. Paths are `<comb>` (checkout), `<comb>@<hash>` (read-only) and `<comb>$<branch>` (moving). Sessions see only granted combs.
- [What one entry in a comb's history is](issues/07-what-one-entry-in-a-combs-history-is.md): one history entry per tool call that changed the comb; writes outside tool calls are coalesced per turn (or quiescence). The author is the session acting for you, with harness, model and principal recorded; the committer is the node. Arguments are stored by hash; messages are generated, never waiting on a model. A cross-comb call makes one entry per comb, sharing an ID. Outside edits are committed as an *external* entry and never dropped.

## Not yet specified

- **Replication / sync** between nodes, and between native and browser copies of a comb: which protocol to adopt. Same-named combs already coexist as separate versions with no implicit merge, so what's open is moving versions between nodes. A node is currently just a shared backing directory; p2p is the goal.
- **Signing and anchoring**: per-commit signatures, where keys live, whether the history head is anchored outside the machine (TPM, witness) to resist local root.
- **Encryption at rest** for combs: wanted at all, and when?
- **Browser persistence**: how combs live in the browser (OPFS?) and survive tab or close.
- **Offload protocol**: how files leave a comb for native execution and come back. Designed separately; the user will drive it.
- **Native host runtime**: Wasmer embedding versus alternatives, per platform.
- **Harness components WASIX can't run**: Hermes's Node TUI and Chromium browser tools.
- **Benchmark**: what "native vs Universal Explorer" workload proves we didn't leave performance on the table.
- **Harnesses beyond Hermes**: what the harness contract looks like once a second one arrives.
- **Retention and pruning** of comb history. Tool-call argument objects are stored by hash, so they can be pruned without breaking the chain.

## Out of scope

- Consensus, tokens, multi-party trust. Replication between one person's machines is in scope later; a blockchain network is not.
- Bare-metal daily-driver distro install. The destination is a runtime for harnesses.

# Existing formats to adopt for datacombs

Type: research
Status: resolved
Blocked by:

## Question

Which existing content-addressed, versioned storage formats or protocols could datacombs adopt rather than invent? Candidates include git objects, IPLD/CIDs, iroh / iroh-blobs (BLAKE3/Bao), ATProto repos (MST), Automerge, ostree, casync/desync, restic/borg repositories, and the Nix store itself.

Score each on:
- tamper-evident history (hash chain or Merkle)
- a path to replication later
- write performance for many small files and for large in-place-changing files (chunking)
- a Rust implementation that compiles to wasm
- maturity

## Answer

**No single format covers chunking, directory trees, history and sync together.**

- **History chain:** git, ATProto repos, ostree, Automerge and Hypercore define one. castore, Xet and iroh-blobs don't. restic snapshots aren't parent-linked.
- **git / gitoxide:**
  - No content-defined chunking; it uses pack deltas.
  - Gitoxide's core object and pack crates build for wasm32; the full `gix` crate doesn't.
  - isomorphic-git and wasm-git already run in browsers on IndexedDB or OPFS.
- **iroh-blobs:**
  - Its current release is self-described as not production quality.
  - The wasm build is in-memory only and browser connections are relay-only.
  - It hashes whole blobs with BLAKE3, with no content-defined chunking.
- **Content-defined chunking:** restic (Rabin), borg (buzhash) and Xet (Gearhash at about 64 KiB, with wasm CI) have it. Automerge's core and Hypercore target wasm.
- **`state.db`:** four options fit SQLite's format:
  1. whole-file snapshot
  2. page-aligned or content-defined chunks
  3. a WAL-frame log in the style of Litestream
  4. a logical export

**Gaps:** no benchmarks were run, and "compiles to wasm" means a CI job builds it, not that it performs well.

Full findings: branch `research/datacomb-formats`, `docs/research/datacomb-formats.md`.

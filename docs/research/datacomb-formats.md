# Existing formats to adopt for datacombs

Research for ticket `04-existing-formats-to-adopt-for-datacombs`.

- **Question:** which existing content-addressed, versioned storage formats or protocols could datacombs adopt rather than invent?
- **Date read:** 2026-10-07. Everything is read from primary sources: specs, official docs, READMEs, `Cargo.toml` and CI files, and the crates.io registry API. Nothing was installed, built or run.
- **Scope:** this note makes no decision. It gives facts, a comparison and trade-offs. Ratings in the table are my reading of the cited facts, not measurements.
- **Context from the tickets:** a datacomb will hold small text files (Hermes `memories/`, `skills/`, config) and a live SQLite WAL database (`state.db`), and it must work natively and in a browser as equals. Replication comes later and should preferably adopt an existing protocol. See the resolved ticket `01-what-hermes-needs-from-its-environment`.
- **Labels:** "Fact" means read in a cited source. "Inference" means my reasoning from facts, and the human decides. Anything not verified is listed in section 8.
- **Registry numbers** (version, date, licence) come from the crates.io API at the time of reading, for example <https://crates.io/api/v1/crates/gix>.

## 1. Comparison table

Ratings: **Yes** means the property is documented. **Partial** means it exists with a stated gap. **No** means documented absent or designed against. **?** means I found no primary-source statement. The sections below carry the citations.

| Candidate | Tamper-evident history | Path to replication | Many small files | Large in-place-changing files | Rust + wasm32 | Maturity and licence |
|---|---|---|---|---|---|---|
| **Git objects** (spec) | Yes: commit hash covers parent hash and tree. SHA-1 default; SHA-256 repo format exists | Yes: the git protocol, every host speaks it. SHA-256 on the wire is out of scope of the transition design | Loose object per file, `git gc --auto` packs after about 6700 loose objects | No CDC. Delta compression at pack time. Files over 512 MiB by default are never delta-compressed | See gitoxide and libgit2 rows | Spec; SHA-256 transition still in progress |
| **gitoxide** (`gix`) | Same as git | Fetch yes. Push, SHA-256 and reftable are unchecked in its status file | Loose write yes. Pack writing without delta compression | Pack delta compression is unchecked in its status file | Partial: CI builds a subset (`gix-hash`, `gix-object`, `gix-pack`, `gix-index`, others) for `wasm32-unknown-unknown`. `gix-odb`, `gix-ref`, `gix-protocol` and `gix` itself are not in that list | `gix` 0.88.0, 2026-09-25, MIT OR Apache-2.0 |
| **isomorphic-git** (JS) and **wasm-git** (libgit2) | Same as git | Smart-HTTP remotes, with a CORS proxy needed in browsers | Not measured | Not measured | Not Rust. Runs in browsers today (JS; libgit2 via Emscripten with IDBFS or OPFS) | isomorphic-git MIT, v1.38.7 (2026-07-11), two volunteer maintainers. wasm-git licence in a `COPYING` file I did not read |
| **IPLD / CID / CAR** | Partial: CIDs give per-block integrity. History is not part of IPLD, you define commits. CARv1 has no verification of its own | Partial: CAR is a transport container. Replication protocols are separate (bitswap, ATProto sync, iroh) | Per-block CIDs and one block per object | UnixFS leaves chunking to the implementation | Yes in principle: `cid` has `no_std` and `alloc` features. I saw no wasm CI | `cid` 0.11.3 MIT, `ipld-core` 0.4.3 MIT OR Apache-2.0 |
| **iroh-blobs** (BLAKE3 / Bao) | Partial: a blob hash is a BLAKE3 Merkle root with verified streaming. No history layer | Yes: native QUIC protocol with verified range requests. Browsers go through a relay | Not measured. Blob is whole content with no metadata | Whole-blob hash, no CDC. A changed file is a new hash. Verification granularity is a 16 KiB block | Partial: CI builds `wasm32-unknown-unknown` with `--no-default-features`, which drops the `fs-store` default | `iroh-blobs` 0.103.1, 2026-10-06, MIT OR Apache-2.0. README: not yet production quality, use 0.35 |
| **iroh-docs** | Partial: entries signed by namespace and author keys. No documented hash chain of history | Yes: range-based set reconciliation over iroh | Key-value entries pointing at blobs | As iroh-blobs | Partial: CI builds wasm32 with `--no-default-features` | `iroh-docs` 0.101.0, 2026-06-15, MIT/Apache-2.0 |
| **ATProto repo (MST)** | Yes: signed commit over a deterministic Merkle Search Tree root. `prev` is "virtually always null" in v3 | Yes: firehose of CAR diffs plus `getRepo` export | Records only, in a `<collection>/<rkey>` namespace, designed for single-digit millions of records | Records are DAG-CBOR with a 1 MB cap per record in sync events. Not for large files | ? Three Rust crates exist. I found no wasm statement for any | `atrium-repo` 0.1.8 MIT, `jacquard-repo` 0.12.2 MPL-2.0, `rsky-repo` 0.0.6 Apache-2.0 |
| **Automerge** | Yes: changes are SHA-256 hashed with hash dependencies. Signatures not seen | Partial: merging changes across devices without a central server is the stated design. Sync protocol not read | CRDT document, not a file tree | Binary or large content is not what it targets. I found no primary-source size guidance | Yes: the Rust core compiles to wasm for the JS package | `automerge` 0.12.0 MIT. Rust API "low level and not well documented" |
| **ostree** | Yes: SHA-256 object graph, commits link to dirtree. Summary can be GPG-signed | Yes: static HTTP, pull model | Per-file objects | Whole-file objects. Static deltas use bsdiff | No: C library, LGPL v2+, Rust bindings only | Mature, Linux-focused |
| **casync / desync** | Partial: chunk IDs and index digests, but no commit history | Yes: chunk store over HTTP, S3, SFTP and others (desync) | Archive format `.catar`, index `.caibx` | Yes: buzhash CDC | No Rust implementation found. casync is C (LGPL-2.1), desync is Go (BSD-3-Clause) | casync 685 commits. desync active |
| **restic repository** | Partial: SHA-256 IDs and MACs detect modification. Snapshots in the design doc have no parent link | ? not read | Pack files of 512 KiB to 8 MiB | Yes: Rabin CDC, blobs 512 KiB to 8 MiB | Partial: `rustic_core` implements the format, with no wasm statement | restic Go. `rustic_core` 0.13.0 Apache-2.0 OR MIT, "API subject to change" |
| **borg repository** | Partial: authenticated manifest, MAC encryption. No chain | ? not covered in the pages read | Segments of about 500 MB | Yes: buzhash CDC, target about 2 MiB | No Rust implementation found | Mature. Docs read were 1.4.5 |
| **Prolly trees** (Dolt) | Yes: Merkle tree, with Dolt adding commits | Yes in Dolt: push and pull remotes | Key-value rows in about 4 KB nodes | CDC over keys, not bytes of large files | Rust `prollytree` 0.4.1 (beta): no wasm target in its manifest | Dolt Go, Apache-2.0, 24.4k stars. `prollytree` Apache-2.0, 33 stars |
| **Nix store / NAR** | No history. Store paths are content or input addressed | ? not read | NAR is one serialized tree, no dedup | No chunking | No (see castore) | The reference format for machine, not for versioned writes |
| **snix castore** | Yes: Merkle DAG of Directory messages, BLAKE3 | Designed for substitution from untrusted sources | File node = BLAKE3 + size + exec bit | BLAKE3 identifies the whole blob. Physical chunking is a separate, variable layer | ? Rust crate, no wasm statement found | Crates.io entries are 2025 placeholders listing GPL-3.0-only. Source host blocked for me |
| **Xet (xet-core)** | Partial: Merkle hashes for files, no versioning ("not a versioning system") | Yes: CAS upload and download APIs | Not a goal | Yes: Gearhash CDC, about 64 KiB target | Yes: wasm builds run in its CI | `xet-core-structures` 1.7.0, 2026-10-06, Apache-2.0. Not meant to be used directly |
| **Hypercore** (`datrs/hypercore`) | Yes: signed append-only log | Partial: described as a distributed log. Replication protocol not read | Log entries | Not designed for it | Partial: "WASM for in-memory storage" | 0.17.0-alpha.1, MIT OR Apache-2.0, pre-1.0 |

## 2. Git objects and the git-family implementations

### Git format (the spec)

- **Fact: SHA-256 repositories exist.** The hash transition design defines `extensions.objectFormat = sha256` and an optional `compatObjectFormat = sha1` ([hash-function-transition](https://git-scm.com/docs/hash-function-transition)). It states that adding SHA-256 to the git protocol is "out of scope for this initial design" (same page). So a SHA-256 repo can speak to SHA-1 servers through a translation table, but SHA-256-native fetch and push are not what that document specifies.
- **Fact: delta compression happens at pack time.** Packs hold `OFS_DELTA` and `REF_DELTA` entries made of copy and add instructions ([pack-format](https://git-scm.com/docs/pack-format)). I found no content-defined chunking in the format.
- **Fact: large files skip delta compression.** `core.bigFileThreshold` defaults to 512 MiB, and larger files are "stored deflated in packfiles, without attempting delta compression" ([config/core.adoc](https://raw.githubusercontent.com/git/git/master/Documentation/config/core.adoc)). The same file says most projects get text delta-compressed "but not larger binary media files".
- **Fact: many small files.** New objects are loose, and `git gc --auto` packs them once there are about 6700 loose objects ([git-gc](https://git-scm.com/docs/git-gc)). `core.fsync` controls durability hardening ([config/core.adoc](https://raw.githubusercontent.com/git/git/master/Documentation/config/core.adoc)).
- **Fact: partial clone** lets a client omit objects (for example large blobs) and fetch them lazily from a promisor remote. Its page lists current limitations and future work ([partial-clone](https://git-scm.com/docs/partial-clone)).
- **Inference:** a git commit chain hashes each commit over its parent, so rewriting history changes every later ID. That is the tamper-evidence property. It only holds against an attacker who cannot also replace the head, which relates to the open signing and anchoring fog on the map.

### gitoxide (`gix`)

- **Fact:** dual-licensed MIT OR Apache-2.0 ([crates.io `gix`](https://crates.io/api/v1/crates/gix)), 0.88.0 published 2026-09-25, same page. The repository states the same licence pair ([repo](https://github.com/GitoxideLabs/gitoxide)).
- **Fact: wasm.** Its CI has a `wasm` job over `wasm32-unknown-unknown`, `wasm32-wasip1` and `wasm32-wasip2`. It builds these crates: `gix-actor`, `gix-attributes`, `gix-bitmap`, `gix-chunk`, `gix-command`, `gix-config-value`, `gix-date`, `gix-glob`, `gix-mailmap`, `gix-packetline`, `gix-path`, `gix-pathspec`, `gix-prompt`, `gix-quote`, `gix-url`, `gix-validate`, plus with the `sha1` feature `gix-commitgraph`, `gix-hash`, `gix-hashtable`, `gix-index`, `gix-object`, `gix-refspec`, `gix-revision`, `gix-traverse`, and `gix-pack` with all features ([ci.yml](https://raw.githubusercontent.com/GitoxideLabs/gitoxide/main/.github/workflows/ci.yml)). `gix-odb`, `gix-ref`, `gix-protocol`, `gix-transport` and the top-level `gix` are not in that list.
- **Fact: what is and is not done** ([crate-status.md](https://raw.githubusercontent.com/GitoxideLabs/gitoxide/main/crate-status.md)):
  - Loose objects: streaming write for blobs and buffer write for small objects are checked.
  - Packs: "create 'thin' pack" is checked, `delta compression` is unchecked.
  - Protocol: `push` is unchecked.
  - Git 3.0 compatibility (`SHA-256`, `reftable`) is an unchecked roadmap item.
- **Inference:** the object model and pack reading compile for the browser today, but a full repository abstraction (refs, odb, transport) is not in the wasm CI set.

### isomorphic-git and wasm-git (non-Rust browser git)

- **Fact: isomorphic-git** is pure JavaScript, MIT, runs in Node and browsers with a "bring your own" file system and HTTP client. Latest release v1.38.7 on 2026-07-11, maintained by two volunteers ([repo](https://github.com/isomorphic-git/isomorphic-git)). In browsers it uses LightningFS, and HTTP remotes need a CORS proxy ([quickstart](https://isomorphic-git.org/docs/en/quickstart)). I did not find `gc` or SHA-256 mentioned in the README.
- **Fact: wasm-git** compiles libgit2 to WebAssembly with Emscripten. Storage options are in-memory, IndexedDB (IDBFS) and OPFS, and OPFS needs a Web Worker ([repo](https://github.com/petersalomonsen/wasm-git)). Cloning from a browser needs CORS on the server (same page).
- **Fact: another system's view.** The snix castore authors wrote down why they rejected git objects: a binary tree format, SHA-1, and blob hashes that include a `blob <size>` header so they cannot match a plain content hash ([Why not Git](https://snix.dev/docs/components/castore/why-not-git/)).

## 3. IPLD, CIDs and CAR

- **Fact: CID v1** is `<version><content-type codec><multihash>`, "meant to be able to represent values of any format with any cryptographic hash" ([multiformats/cid](https://github.com/multiformats/cid)).
- **Fact: UnixFS** gives files and directories a representation (raw blocks, or dag-pb nodes, with HAMT-sharded large directories). It does **not** mandate a chunking algorithm. Implementations choose, and the spec recommends 256 KiB or 1 MiB blocks ([UnixFS spec](https://specs.ipfs.tech/unixfs/)). Directory entries are sorted for determinism (same page).
- **Fact: CARv1** is a header with one or more roots followed by length-prefixed blocks. It is ideal for streaming, has no index so random reads need a scan, and "contains no internal means, beyond the IPLD block formats and their CIDs, to verify or differentiate contents" ([CARv1](https://ipld.io/specs/transport/car/carv1/)).
- **Fact: Rust crates.**
  - `cid` 0.11.3, MIT, with `std`, `alloc` and `serde` features ([Cargo.toml](https://raw.githubusercontent.com/multiformats/rust-cid/master/Cargo.toml)).
  - `ipld-core` 0.4.3, MIT OR Apache-2.0 ([crates.io](https://crates.io/api/v1/crates/ipld-core)).
  - `serde_ipld_dagcbor` 0.7.0 ([crates.io](https://crates.io/api/v1/crates/serde_ipld_dagcbor)).
  - `iroh-car` last released 2024-10-25 ([crates.io](https://crates.io/api/v1/crates/iroh-car)).
  - `libipld` last released 2023-01-23 ([crates.io](https://crates.io/api/v1/crates/libipld)).
- **Inference:** IPLD supplies a naming scheme and a block codec, not a store, a history model or a sync protocol. Whoever adopts it still has to design the commit object and the directory layout. ATProto (section 5) and iroh (section 4) are two existing designs that sit on top of similar ideas.

## 4. iroh: iroh-blobs, iroh-docs, bao-tree

- **Fact: iroh** 1.3.0, published 2026-09-28, MIT OR Apache-2.0 ([crates.io](https://crates.io/api/v1/crates/iroh)). It dials by public key over QUIC, with hole-punching and relay fallback, and ships iroh-blobs, iroh-gossip and iroh-docs as protocols on top ([README](https://raw.githubusercontent.com/n0-computer/iroh/main/README.md)).
- **Fact: iroh-blobs** 0.103.1, published 2026-10-06, MIT OR Apache-2.0 ([crates.io](https://crates.io/api/v1/crates/iroh-blobs)).
  - Its README says "this version of iroh-blobs is not yet considered production quality. For now, if you need production quality, use iroh-blobs 0.35" ([README](https://raw.githubusercontent.com/n0-computer/iroh-blobs/main/README.md)).
  - A blob is "a sequence of bytes of arbitrary size, without any metadata". A link is its 32-byte BLAKE3 hash. A `HashSeq` is a blob of links. Requests name hashes and byte ranges, and answers are BLAKE3 verified streams (same README).
  - `IROH_BLOCK_SIZE` is 16 KiB ([store docs](https://docs.rs/iroh-blobs/latest/iroh_blobs/store/index.html)). Stores are `mem`, `readonly_mem` and `fs` (same page).
  - Fact: the `fs-store` feature, which pulls in `redb`, is on by default ([Cargo.toml](https://raw.githubusercontent.com/n0-computer/iroh-blobs/main/Cargo.toml)).
- **Fact: wasm.** The iroh-blobs CI builds `wasm32-unknown-unknown` with `--no-default-features` and checks that the output has no `import "env"` ([ci.yaml](https://raw.githubusercontent.com/n0-computer/iroh-blobs/main/.github/workflows/ci.yaml)). iroh-docs has the same job ([ci.yaml](https://raw.githubusercontent.com/n0-computer/iroh-docs/main/.github/workflows/ci.yaml)).
  - **Inference:** the tested wasm configuration excludes `fs-store`, so the tested browser store is in-memory. Persistence in a browser would have to be supplied by whoever embeds it. I did not find an OPFS or IndexedDB store in the docs.
- **Fact: iroh in browsers.** It compiles to wasm with `wasm-bindgen`. "All connections from browsers to somewhere else need to flow via a relay server", since the sandbox prevents UDP hole-punching. Traffic stays end-to-end encrypted ([wasm browser support](https://docs.iroh.computer/deployment/wasm-browser-support)). That page says gossip compiles for browsers and is silent on blobs and docs.
- **Fact: bao-tree** (0.16.1, MIT OR Apache-2.0) is the Merkle tree for BLAKE3 verified streaming. Its wire format is compatible with the `bao` crate, and it supports runtime-configurable chunk groups and multi-range queries ([README](https://raw.githubusercontent.com/n0-computer/bao-tree/main/README.md)).
- **Fact: iroh-docs** is a "multi-dimensional key-value document" whose entry value is the BLAKE3 hash, size and timestamp of content stored in iroh-blobs. Every entry is signed by a namespace key (write capability) and an author key. Sync uses range-based set reconciliation after Meyer's paper, and the persistent store is a single `redb` file ([README](https://raw.githubusercontent.com/n0-computer/iroh-docs/main/README.md)).
  - **Inference:** an entry is identified by namespace, author and key, so the model looks like current state with signatures. I did not find a documented per-key history or hash chain. Whether old values are retained is not stated in the pages I read.
- **Trade-off visible in the facts:** whole-blob hashes mean an edited file is a new blob, and the 16 KiB Bao blocks improve verification and range fetch, not storage sharing between versions. I found no statement that iroh-blobs deduplicates parts of two similar blobs.

## 5. ATProto repositories (Merkle Search Tree)

- **Fact: structure.** A repo is a signed commit (`sig`, `data` link to the MST root, `rev` as a monotonic logical clock, `prev` nullable and "virtually always null" in v3). The MST has fanout 4, derived from the leading zero bits of SHA-256 of the key, and its shape is "deterministic based on the current key/value content, regardless of the history of insertions and deletions" ([repository spec](https://atproto.com/specs/repository)).
- **Fact: limits.** Paths are `<collection>/<record-key>` with a restricted character set, and the spec says the design targets "single-digit millions" of records (same page).
- **Fact: sync.** Commits are announced as CAR slices of new blocks. Consumers verify by inverting the listed operations against the diff and checking that the result is the previous root. A broken chain means re-fetching the full repo through `com.atproto.sync.getRepo`. Event caps are 2 MB of blocks, 1 MB per record and 200 operations per commit ([sync spec](https://atproto.com/specs/sync)).
- **Fact: Rust crates.**
  - `atrium-repo` 0.1.8, MIT, published 2026-03-26 ([crates.io](https://crates.io/api/v1/crates/atrium-repo)). It has `blockstore`, `mst` and `repo` modules and depends on tokio ([docs.rs](https://docs.rs/atrium-repo)).
  - `jacquard-repo` 0.12.2, **MPL-2.0**, with MST, signed commits v2 and v3, CAR import and export, and memory, file and layered block stores ([docs.rs](https://docs.rs/jacquard-repo)).
  - `rsky-repo` 0.0.6, Apache-2.0, 19 downloads ([crates.io](https://crates.io/api/v1/crates/rsky-repo)).
  - I found no wasm statement for any of the three.
- **Inference:** the MST gives an order-independent root hash over a flat key space, which suits a path-to-hash map. The format is shaped for small records. Large binary values would live in separate blocks, and I did not find the spec saying how.

## 6. Other content-addressed stores

### Automerge

- **Fact:** a change hash is the SHA-256 of the change chunk, dependencies are expressed as hashes of ancestor changes, and the document chunk's head hashes can be verified against the rebuilt graph ([binary format spec](https://automerge.org/automerge-binary-format-spec/)). Each chunk also has a 4-byte checksum from the same hash (same page).
- **Fact:** `automerge` 0.12.0, MIT ([crates.io](https://crates.io/api/v1/crates/automerge)). The Rust core is built to wasm as `automerge-wasm`. The repo calls the Rust API "low level and not well documented" and points Rust users to `autosurgeon`. Automerge 3 cut memory use by "around a 10x reduction" ([repo](https://github.com/automerge/automerge)).
- **Inference:** Automerge models structured JSON-like documents with a conflict-free merge. It does not model a file tree or a SQLite file, so using it for datacombs would mean mapping each file into a document type.

### ostree

- **Fact:** objects are commit, dirtree, dirmeta and content objects, all SHA-256. File objects include uid, gid, mode, symlink target and xattrs. The format "intentionally does not contain timestamps". The summary file can be GPG-signed (detached) ([ostree repo docs](https://ostreedev.github.io/ostree/repo/)).
- **Fact:** repo modes are `bare`, `bare-split-xattrs`, `bare-user`, `bare-user-only` and `archive` (same page). Static deltas use a superblock plus part files with a restricted bytecode, and bsdiff for matching files ([formats](https://ostreedev.github.io/ostree/formats/)). Design priority is plain static web servers (same page).
- **Fact:** libostree is C, LGPL v2+, with Rust bindings, and its docs concentrate on Linux distributions ([repo](https://github.com/ostreedev/ostree)). The `ostree` crate is 0.20.5, MIT, last published 2025-09-30 ([crates.io](https://crates.io/api/v1/crates/ostree)). The repository's own docs do not mention Windows or macOS (I looked, and found none).

### casync and desync

- **Fact: casync** uses a buzhash rolling hash for variable chunks. Formats are `.catar` (archive), `.caidx` (tree index), `.caibx` (blob index), `.castr` (chunk store). Hash is SHA-512/256 (SHA-256 optional), compression is zstd, licence LGPL-2.1, build uses Meson and Linux libraries ([casync repo](https://github.com/systemd/casync)).
- **Fact: desync** is Go, BSD-3-Clause, wire-compatible with casync, with HTTP, S3, GCS and SFTP stores, FUSE mount, chunk encryption, and support for Linux, macOS, Windows and BSD ([desync repo](https://github.com/folbricht/desync)).
- **Fact:** a search for a Rust implementation of the casync formats turned up only chunkers: `fastcdc` 5.0.0, MIT, offering `ronomon`, `v2016` and `v2020` variants ([docs.rs](https://docs.rs/fastcdc/latest/fastcdc/)), and `clast`, which does not implement casync formats ([docs.rs](https://docs.rs/crate/clast/1.0.2)).

### restic and borg repositories

- **Fact: restic format.** IDs are SHA-256 of stored content, packs hold blobs of 512 KiB to 8 MiB, files under 512 KiB are not split, and chunking is Rabin-fingerprint CDC with a per-repo polynomial in `config`. Files are AES-256-CTR plus Poly1305-AES. Version 2 adds zstd. Locks are exclusive and non-exclusive JSON files ([design.rst](https://raw.githubusercontent.com/restic/restic/master/doc/design.rst)).
  - The snapshot example in that document has `time`, `tree`, `paths`, `hostname`, `username`, `uid`, `gid` and `tags`, with no parent pointer. Metadata edits make a new snapshot linked by an `original` field (same file).
  - **Inference:** snapshots are independent documents. Modifying data is detected by MAC and ID mismatch, but I found no chain that would show a deleted snapshot was deleted.
  - Fact: the design doc cites a 2025 paper on chunking attacks that can derive the secret chunker polynomial, mitigated in 0.18.0 by randomly assigning chunks to pack files (same file).
- **Fact: rustic_core** 0.13.0, Apache-2.0 OR MIT, "reads and writes the `restic` repository format". It says it is "in an early development stage and its API is subject to change" ([repo](https://github.com/rustic-rs/rustic_core)). I found no wasm statement.
- **Fact: borg.** Segments of about 500 MB with PUT, DELETE and COMMIT entries, a buzhash chunker defaulting to `CHUNK_MIN_EXP=19`, `CHUNK_MAX_EXP=23`, `HASH_MASK_BITS=21` (about 2 MiB targets), a manifest at an all-zero key as the object-graph root, AES-256-CTR with a MAC, and XXH64 checksums on indices and caches ([data structures](https://borgbackup.readthedocs.io/en/stable/internals/data-structures.html)). The page is the 1.4.5 documentation, so Borg 2 changes are not covered here.

### Prolly trees (Dolt and `prollytree`)

- **Fact:** a prolly tree splits at content-defined boundaries chosen from a hash. Dolt weights the choice by chunk size to hold nodes around 4 KB. The shape depends only on the data, not on insertion order. Diffs cost time proportional to the change, "O(d) versus O(n)" ([Dolt docs](https://www.dolthub.com/docs/architecture/storage-engine/prolly-tree/)).
- **Fact:** Dolt is Go, Apache-2.0, versions tables with Git-style push and pull ([repo](https://github.com/dolthub/dolt)).
- **Fact:** the Rust `prollytree` crate is 0.4.1 (beta), Apache-2.0. It offers commit, branch, merge, diff, Merkle proofs, optional SQL, and large values "externalized" as content-addressed objects ([repo](https://github.com/zhangfengcdt/prollytree)). Its manifest uses `gix` for the git backend, optional RocksDB and optional tokio, and has no wasm target or `cfg(target_arch = "wasm32")` ([Cargo.toml](https://github.com/zhangfengcdt/prollytree/blob/main/Cargo.toml)).
- **Inference:** prolly trees chunk a sorted key space. They fit a key-value or table store (and a path to hash map) better than the bytes of one large file.

### Nix store, NAR and the snix castore

- **Fact: NAR** serializes a file tree deterministically (directory entries ordered by name), keeps essentially the executable bit and no timestamps or ownership, and has no chunking or deduplication ([NAR spec](https://nix.dev/manual/nix/2.34/protocols/nix-archive/)).
- **Fact: castore** (from the Rust Nix reimplementation snix, formerly tvix) models a Merkle DAG of `Directory` messages. File nodes hold the BLAKE3 digest, length and executable bit, directory digests are the BLAKE3 of the canonical protobuf, and names reject `/`, NUL, `.` and `..` ([data model](https://snix.dev/docs/components/castore/data-model/), [API](https://snix.dev/docs/reference/snix-castore-api/)).
- **Fact: castore chunking.** A blob is identified by the BLAKE3 digest of its raw data, and the docs say chunking parameters "bleed into the root hash" in other designs. Castore keeps 1 KiB logical blocks (from the BLAKE3 tree) apart from variable-sized physical chunks, which can differ without changing the identifier. Range fetches may need extra logical blocks for verification ([chunking and verified streaming](https://snix.dev/docs/components/castore/blobstore-chunking-verified-streaming/)).
- **Fact: licensing and packaging.** The `snix-castore` and `nix-compat` entries on crates.io are `0.0.0-pre` placeholders from March 2025 that list GPL-3.0-only ([crates.io](https://crates.io/api/v1/crates/snix-castore)). I could not read the repository's licence file because the host blocked my fetches (robots.txt and proxy), so the current licence is **unverified**.
- **Inference:** the Nix store and NAR describe immutable, build-time content. They do not describe versioned history, which is what datacombs needs, so the relevant part for datacombs is the castore data model rather than NAR.

### Xet (Hugging Face `xet-core`)

- **Fact:** a content-addressed storage protocol with Gearhash content-defined chunking at about 64 KiB (minimum 8 KiB, maximum 128 KiB), xorbs of up to 64 MiB, shards, and multi-level Merkle hashes. The spec says it is "a storage/transfer protocol, not a versioning system" ([chunking](https://huggingface.co/docs/xet/chunking), [spec index](https://huggingface.co/docs/xet/index)).
- **Fact:** the Rust crates are Apache-2.0 (`xet-core-structures` 1.7.0 published 2026-10-06 on [crates.io](https://crates.io/api/v1/crates/xet-core-structures)). The repo says the library is "not meant to be used directly". Its CI compiles crates for `wasm32-unknown-unknown` and runs browser smoke tests, and the browser upload/download wrapper is "an example, not a published SDK"; the thin chunking and hashing module is published for JavaScript ([AGENTS.md](https://raw.githubusercontent.com/huggingface/xet-core/main/AGENTS.md), [wasm/AGENTS.md](https://raw.githubusercontent.com/huggingface/xet-core/main/wasm/AGENTS.md)).

### Hypercore

- **Fact:** the Rust port `datrs/hypercore` is a "secure, distributed append-only log with cryptographic verification", binary-compatible with the JS LTS disk format. It is pre-1.0 (0.17.0-alpha.1, MIT OR Apache-2.0), forbids unsafe code, and supports "WASM for in-memory storage" ([repo](https://github.com/datrs/hypercore), [crates.io](https://crates.io/api/v1/crates/hypercore)).

### Jujutsu, Irmin and Radicle (VCS designs on git)

- **Fact: Jujutsu** stores commits through a `GitBackend` that uses gitoxide, and keeps a separate operation log. Operations mirror git's model, "each commit object is instead an 'operation' and each tree object is instead a 'view'". Concurrent operations are three-way merged, so clones can be synchronized by rsync, Dropbox or NFS without a lock ([architecture](https://docs.jj-vcs.dev/latest/technical/architecture/), [concurrency](https://github.com/jj-vcs/jj/blob/main/docs/technical/concurrency.md)). `jj-lib` 0.45.1, Apache-2.0 ([crates.io](https://crates.io/api/v1/crates/jj-lib)). The docs say the library is meant to be reusable, and mention no wasm.
- **Fact: Irmin** (OCaml, MirageOS) offers "Bidirectional compatibility with the Git on-disk format" and claims to run "from Linux to web browsers and Xen unikernels" ([irmin.org](https://irmin.org/)). Not Rust.
- **Fact: Radicle heartwood** is a Rust (Apache-2.0 and MIT) peer-to-peer code collaboration protocol built on git ([repo](https://github.com/radicle-dev/heartwood)). I did not read its replication protocol.

### Transparency-log checkpoints (reference for the signing and anchoring fog)

- **Fact:** a C2SP checkpoint is a signed note with an origin, a tree size and an RFC 6962 Merkle root. Logs "MUST not sign any checkpoint which is inconsistent with any checkpoint it previously signed", and witnesses can cosign ([tlog-checkpoint](https://c2sp.org/tlog-checkpoint)). This is a possible external anchor for a history head, which the map lists as not yet specified.

## 7. Cross-cutting facts and trade-offs

### 7.1 What each candidate covers

No candidate that I found covers every layer. This is my summary of the sections above.

| Layer | Candidates that define it |
|---|---|
| Blob naming and chunking | git (whole-object plus pack delta), iroh-blobs/Bao, castore, restic, borg, casync, Xet, CIDs/UnixFS |
| Directory or key-space structure | git trees, ostree, castore, IPLD/UnixFS, ATProto MST, prolly trees, restic trees |
| History and authorship | git commits, ostree commits, ATProto signed commits, Automerge change graph, Jujutsu operation log, Hypercore log. Absent or weak in castore, Xet, iroh-blobs and restic (independent snapshots) |
| Sync protocol | git protocol, iroh (QUIC, range reconciliation), ATProto firehose and CAR, Dolt remotes, Hypercore, casync stores, ostree HTTP pull |

### 7.2 Chunking facts for large files that change in place

| Scheme | Algorithm and size | Source |
|---|---|---|
| git | No chunking. Delta at pack time. No delta over 512 MiB by default | [core.adoc](https://raw.githubusercontent.com/git/git/master/Documentation/config/core.adoc) |
| restic | Rabin CDC, blobs 512 KiB to 8 MiB | [design.rst](https://raw.githubusercontent.com/restic/restic/master/doc/design.rst) |
| borg | buzhash CDC, about 2 MiB target by default | [data structures](https://borgbackup.readthedocs.io/en/stable/internals/data-structures.html) |
| casync | buzhash CDC (parameters not read) | [casync](https://github.com/systemd/casync) |
| Xet | Gearhash CDC, about 64 KiB, 8 KiB to 128 KiB | [chunking](https://huggingface.co/docs/xet/chunking) |
| iroh-blobs, castore | Whole-blob BLAKE3 identity. 16 KiB or 1 KiB Bao blocks for verification. No CDC | [store docs](https://docs.rs/iroh-blobs/latest/iroh_blobs/store/index.html), [castore chunking](https://snix.dev/docs/components/castore/blobstore-chunking-verified-streaming/) |
| UnixFS | Left to the implementation | [UnixFS](https://specs.ipfs.tech/unixfs/) |
| Prolly trees | Content-defined over sorted keys, about 4 KB nodes | [Dolt docs](https://www.dolthub.com/docs/architecture/storage-engine/prolly-tree/) |

### 7.3 The `state.db` problem

- **Fact:** SQLite database pages are a power of two from 512 to 65536 bytes. "All reads from and writes to the main database file begin at a page boundary and all writes are an integer number of pages in size". A WAL frame is a 24-byte header plus one page, with cumulative checksums ([file format](https://www.sqlite.org/fileformat2.html)).
- **Fact:** Litestream replicates a live SQLite database by holding a read transaction to block other checkpoints, packaging new WAL pages into LTX files with increasing transaction IDs, compacting them in levels, and taking a full snapshot (every 24 hours by default). Restore is the latest snapshot plus LTX files in order ([how it works](https://litestream.io/how-it-works/)).
- **Options these facts allow (not a recommendation):**
  1. Treat `state.db` as a whole file snapshot at each commit, with whatever chunking the store offers. Per the ticket on Hermes, such a snapshot has to be a `sqlite3.backup()`-style copy and not a raw file read.
  2. Chunk on SQLite page boundaries or with CDC, so unchanged pages share storage (inference from the page-aligned write rule above; I did not find a primary source measuring dedup on SQLite files).
  3. Store WAL frames or page deltas as a log of entries, as Litestream does with LTX. No format in this note defines that, so it would be new framing on top of one of them.
  4. Version a logical export of the sessions rather than the file. That is an application-level choice and does not depend on the store.

### 7.4 Browser (wasm32) status

- **Compiles in a published CI job:** `gix-object`, `gix-pack`, `gix-hash` and others (not `gix-odb`, `gix-ref` or the protocol crates), iroh-blobs and iroh-docs with default features off, Xet's core crates, Automerge's Rust core (via its JS package), Hypercore in-memory only.
- **Already running in a browser, not Rust:** isomorphic-git and wasm-git, both with persistent browser storage options (LightningFS, IDBFS, OPFS).
- **No wasm statement found:** ATProto crates, `prollytree`, `rustic_core`, `jj-lib`, snix castore.
- **No wasm statement found, and implemented in C or Go (a wasm build would be a port or a toolchain exercise I did not check):** ostree, casync, desync, restic, Dolt.
- **Common gap:** the `iroh` browser transport is relay-only, and the wasm builds of iroh-blobs and iroh-docs exclude the file-system stores.

### 7.5 Licences and maintenance at a glance

- Permissive and dual-licensed: `gix`, `iroh*`, `bao-tree`, `cid`, `ipld-core`, `automerge` (MIT), `rustic_core`, `prollytree`, `xet-*` (Apache-2.0), `hypercore`, `jj-lib` (Apache-2.0).
- Copyleft or unclear: libostree and casync (LGPL), `jacquard-repo` (MPL-2.0), and snix castore (placeholders list GPL-3.0-only, current licence unverified).
- Stated immaturity: iroh-blobs ("not yet considered production quality"), `rustic_core` (API subject to change), Hypercore (pre-1.0 alpha), `prollytree` (beta, 33 stars), `atrium-repo` (0.1.x), Automerge Rust API (low level).
- Adoption signals I could read: `gix` has about 50.5 million downloads on crates.io, Dolt has 24.4k GitHub stars, `iroh` has about 3.05 million downloads.

## 8. Not verified and open questions

- **No benchmarks.** Write performance for many small files and for in-place edits is not measured here. I found no primary-source benchmark for most candidates, so the table's cells for those columns rest on format structure only.
- **Wasm claims are CI-based.** "Compiles" means a CI job builds it, not that it runs well in a browser. No timings or OPFS behaviour were checked. I did not check whether `atrium-repo` (which depends on tokio) or `jacquard-repo` build for wasm32.
- **snix:** the current licence and the full castore crate set. The git host and docs index returned blocks or empty pages.
- **iroh-docs:** whether old entry values are retained, and what the conflict rule is. The pages I read do not say.
- **Automerge:** the sync protocol, signatures, and size guidance for large or binary content.
- **casync:** chunk size parameters and its Rust alternatives beyond chunkers.
- **Borg:** Borg 2 changes, and its implementation language (not stated in the pages read).
- **wasm-git licence:** in a `COPYING` file I did not read.
- **Radicle and Jujutsu:** replication and wasm status were not read in depth.
- **Windows and macOS** behaviour of native candidates was not checked beyond desync's stated support.
- **Encryption at rest, signing and anchoring** are separate fog items on the map. Only restic, borg and Xet (shard HMAC) mention encryption or keyed integrity in the pages read, and git, ostree, ATProto and Hypercore mention signatures.

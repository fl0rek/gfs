# Existing formats to adopt for datacombs

Type: research
Status: open
Blocked by:

## Question

Which existing content-addressed, versioned storage formats or protocols could datacombs adopt rather than invent? Candidates include git objects, IPLD/CIDs, iroh / iroh-blobs (BLAKE3/Bao), ATProto repos (MST), Automerge, ostree, casync/desync, restic/borg repositories, and the Nix store itself.

Score each on:
- tamper-evident history (hash chain or Merkle)
- a path to replication later
- write performance for many small files and for large in-place-changing files (chunking)
- a Rust implementation that compiles to wasm
- maturity

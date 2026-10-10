# Universal Explorer

A runtime for agent harnesses in which every byte lives in exactly one of three
root directories, and each directory carries one set of guarantees.

## Runtime

**harness**:
An agent program that Universal Explorer runs, e.g. Hermes Agent.
_Avoid_: agent, app

**gfs**:
The filesystem Universal Explorer presents to a harness, composing machine, datacombs and cache into one root. The name is recursive ("gfs filesystem").
_Avoid_: VFS, root view, the filesystem

**offload**:
Running work natively on the host, outside the harness's wasm world, on files taken from gfs, with the results returned.
_Avoid_: escape hatch, passthrough

## Root directories

**machine**:
The read-only root directory holding everything built from Nix; reproducible, never written at runtime.
_Avoid_: system, rootfs, base

**datacombs**:
The read-write root directory for persistent data, where every change is versioned and auditable.
_Avoid_: ledger, persist, state

**cache**:
The read-write root directory for discardable data, held in RAM, spilled to disk, and cleaned up automatically.
_Avoid_: volatile, tmp, scratch

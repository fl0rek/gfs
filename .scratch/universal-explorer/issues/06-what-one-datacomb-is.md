# What one datacomb is

Type: grilling
Status: claimed
Blocked by: 04

## Question

What is a single datacomb?
- its identity and boundaries: per project, per harness, per user
- whether `/datacombs` holds many independent combs or one
- whether the Nix store is itself a comb (`/datacombs/nix`) with machine as a read-only view of it
- how a session gets granted and mounts combs

## Progress (grilling round 1, 2026-10-10)

Settled:
- Conceptually, datacombs is **one global structure that everybody edits**. Each node holds a subjective, partial view: its own actions now, and other nodes' data later.
- **Every top-level directory in `/datacombs` is a comb**: a separate repo with its own history. Name clashes are the only real concurrency issue, and per-directory repos are what resolve them. Two nodes holding `nix@hash1` and `nix@their_hash` reconcile through a seamless unrelated-tree merge. Rollback is independent per comb.
- The Nix store stays in **machine** for now. This is not locked in.
- History is **append-only**: a rollback appends an entry. Getting exactly the state you want after a rollback is manual for now; best practices may come later.

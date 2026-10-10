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

## Progress (grilling round 2, 2026-10-10)

Settled:
- **Node** in practice means everything connected to one store, because its objects are immediately available to them. On westfall the node is just the shared directory. That's not ideal, but it's simple and "not-worst" for now. Something better (p2p and the like) goes into the replication fog.
- **Same-named combs from different origins sit side by side.** They are "separate but equal": each shows up as another available version. References carry the version, so you can't pick the wrong one by accident. Nothing merges implicitly.
- Combs exist only at the **top level** of `/datacombs`; they don't nest.
- **A session sees only the combs it was granted.** It can create new combs. Who issues grants, and whether a grant can be read-only, belongs to "Where the sandbox boundary sits".

## Progress (grilling round 3, 2026-10-10)

Settled:
- **Version = head hash.** As in git, a head hash commits to the comb's entire state and history. "Another available version" means another head.
- **Paths in `/datacombs`:**
  - `/datacombs/<comb>` is the **local checkout**. It stays wherever the user left it.
  - `/datacombs/<comb>@<hash>` accesses one specific version, if it exists on the node.
  - `/datacombs/<comb>$<branch>` is a **branch**: it moves over time and persists, e.g. `/datacombs/nix$hostname1` or `/datacombs/gfs$fix-panic`.
  - Backend idea: one worktree per branch.
- **"Store"** means the engine that makes combs appear as files under `/datacombs` for the harness. It is not the Nix store. The first iteration may be just a backing directory that holds the structure.
- **Each comb is assumed to be a valid flake.**

## Progress (grilling round 4, 2026-10-10)

Settled:
- `/datacombs/<comb>@<hash>` is **read-only**. To branch from a version, make a `$branch` at that hash.
- **Every comb is a full flake**, data combs included.
- **"Datacombs" names the whole system** that supports each node's subjective view, not just the root directory. "Store" and "comb engine" are not used.

Waiting for the user to confirm the shared understanding before resolving.

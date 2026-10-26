# What the runtime exposes to the view

Type: grilling
Status: open
Blocked by: 12, 17

## Question

The view reads introspection data ([The view the harness programs for itself](17-the-view-the-harness-programs-for-itself.md)). We own syscalls, so `/proc` is whatever the runtime synthesizes. Decide:
- the channel: synthesized files under `/proc` read through gfs, a runtime API the comb's build calls, or both
- the first set of facts: processes (host and world, with the tool call that spawned each), memory and cache usage, mounts with their `@<hash>`, grants, `/machine` provenance
- which of these the harness itself may read, given [Where the sandbox boundary sits](12-where-the-sandbox-boundary-sits.md), and whether the view sees more than the harness does
- how fresh the data is: rendered once per history entry, or live-polled by the page

Where the prototype stands (2026-10-26): the page injects a snapshot of every `/machine` entry into the view as `window.ue.machine` (text per entry) and refreshes it every few seconds by `postMessage`; the view has no filesystem access of its own. That is one of the candidate channels, not the decision.

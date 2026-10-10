# How a live state.db lands in a history entry

Type: research
Status: open
Blocked by: 04, 07

## Question

Hermes's `state.db` is a live multi-process WAL SQLite file. Its churn is coalesced into one history entry per agent turn. How do we capture a consistent state of it at that boundary, natively and in the browser?
- checkpoint-then-copy, the backup API, page-level capture through gfs, or a VFS shim
- the cost of each per turn
- what the browser (WASIX, OPFS) supports

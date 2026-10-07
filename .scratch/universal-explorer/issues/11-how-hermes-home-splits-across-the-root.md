# How Hermes's home splits across the root

Type: grilling
Status: open
Blocked by: 06

## Question

Hermes wants one writable `HERMES_HOME`. How do its subdirectories land in machine, datacombs and cache?
- the mechanism: mounts, symlinks, or env overrides
- what happens to its mixed `cache/`, where some subdirectories are durable
- whether `state.db` lives in a comb, and how it is captured consistently
- whether we pin a Hermes revision

Context: the answer to [What Hermes needs from its environment](01-what-hermes-needs-from-its-environment.md).

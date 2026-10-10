# Where the sandbox boundary sits

Type: grilling
Status: open
Blocked by: 05, 13

## Question

With owned syscalls, the wasm runtime is the natural isolation boundary. What, if anything, crosses it?
- Hermes's `local` terminal backend inside the world, versus a custom Universal Explorer backend plugin
- network egress: Wisp relay in the browser, host sockets natively
- secrets: `.env`, `auth.json`
- offload
- comb grants: who issues them, whether a grant pins `<comb>@<hash>` or `<comb>$<branch>`, and whether a grant can be read-only (see [What one datacomb is](06-what-one-datacomb-is.md))

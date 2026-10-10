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

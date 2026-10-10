# Where datacombs runs

Type: grilling
Status: open
Blocked by: 04, 05, 13

## Question

The harness's world is wasm with owned syscalls (see "Guest architecture and platform matrix"). Where does gfs and datacombs sit in that, and how is it built?
- inside the wasm runtime's syscall layer, implemented in Rust
- as a separate process or worker the syscall layer talks to

The answer must cover both hosts: native Wasmer embedding, and a Web Worker plus OPFS in the browser.

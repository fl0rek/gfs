# Booting a nixpkgs Linux image in the browser

Type: research
Status: open
Blocked by:

## Question

What are the ways to boot a fully booted Linux image, built from the same nixpkgs as the native machine, inside a browser via wasm? Candidates include v86, container2wasm (Bochs/TinyEMU), QEMU-wasm, CheerpX/WebVM, and RISC-V emulators like TinyEMU or JSLinux-style.

For each, find out:
- guest architectures supported
- whether a NixOS or nixpkgs image boots on it, and any known examples
- realistic performance
- networking from the tab
- disk and filesystem options for persistence (OPFS, 9p, virtio)
- licence and maintenance health

Findings: branch `research/browser-linux-boot`, `docs/research/browser-linux-boot.md`.

Which guest arch keeps native and browser on one image?

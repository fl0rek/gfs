# Booting a nixpkgs Linux image in the browser

Type: research
Status: resolved
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

## Answer

No primary source shows a full NixOS (systemd) boot in a browser yet.

The closest is **trynix**: an x86_64 nixpkgs-built kernel with a busybox initramfs, running on **qemu-wasm**. It boots from a native-QEMU snapshot to a shell in about 1.5 s on a revisit. It uses 1 vCPU and fixed wasm memory of about 2.4 GB, and serves the Nix store over virtio-9p from cache.nixos.org.

The candidate engines:

| Engine | Guest arch | Licence | Status |
|---|---|---|---|
| qemu-wasm | x86_64, aarch64, riscv64 | GPL | Experimental MTTCG, wasm JIT, quiet since 2025-09 |
| container2wasm | x86_64 (Bochs), riscv64 (TinyEMU) | Apache-2.0 | Active |
| v86 | i686 only | BSD | Active, but nixpkgs dropped i686 images and caches after 23.11 |
| CheerpX | x86 | Proprietary | Syscall emulation, not a kernel boot |
| TinyEMU | riscv, x86 | MIT | Stale since 2019 |
| linux-wasm | Kernel compiled to wasm | | Not a shared image |

Networking from a tab is limited in every case: Fetch under CORS, or WebSocket/Tailscale relays. Persistence is not solved anywhere. No engine documents OPFS; CheerpX documents IndexedDB.

On one shared image: only **x86_64** and **aarch64** are both official in nixpkgs and runnable in the browser. Both run via qemu-wasm, but only x86_64 has a working nixpkgs example.

Full findings: branch `research/browser-linux-boot`, `docs/research/browser-linux-boot.md`.

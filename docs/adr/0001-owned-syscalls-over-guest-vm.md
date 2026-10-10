# 0001: Own the harness's syscalls instead of booting a guest VM

Status: accepted (2026-10-10)

## Context

Universal Explorer must run Hermes Agent in the browser and natively (Asahi Linux first), with the two as equals. We considered three options:
- **Guest VMs:** KVM natively, plus a wasm emulator in the browser.
- **One full-system emulator everywhere:** e.g. qemu-wasm.
- **Owning the syscall layer:** run a userland compiled to wasm.

## Decision

Universal Explorer runs the harness in a wasm world whose syscalls it implements:
- The userland (Python, bash, git, ripgrep and so on) is WASIX wasm, built with Nix.
- gfs is that world's filesystem directly.
- The same binaries run in the browser and natively (Wasmer).
- Performance-critical native work leaves through **offload**.

## Consequences

- **Performance:** about 1.5× native for CPU-bound work, compared with an estimated 5–30× for a wasm full-system emulator. KVM speed on Asahi is given up except via offload.
- **gfs:** sees every file operation first-hand, with no 9p hop.
- **Portability:** identical binaries in the browser and natively.
- **Risks:**
  - We depend on WASIX, which is non-standard and Wasmer-centric.
  - Nobody has run Hermes on it yet.
  - Node and Chromium parts of a harness may not port.
- **Fallback:** qemu-wasm full-system emulation (x86_64) with gfs over 9p.

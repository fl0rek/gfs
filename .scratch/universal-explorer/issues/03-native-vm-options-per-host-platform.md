# Native VM options per host platform

Type: research
Status: open
Blocked by:

## Question

For each host (Linux x86_64/aarch64, macOS Apple Silicon, Windows), what is the fastest way to boot a nixpkgs-built Linux guest per harness session? Candidates include Firecracker, cloud-hypervisor, crosvm, libkrun/krunvm, QEMU microvm, Virtualization.framework, WHPX/Hyper-V, and WSL2.

For each, find out:
- boot time
- host↔guest file sharing (virtiofs and DAX, 9p) and its performance
- whether a host-side process can serve a filesystem into the guest
- which guest arch is required on each host, and the cost of emulating the other arch

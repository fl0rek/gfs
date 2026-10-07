# Native VM options per host platform

Type: research
Status: resolved
Blocked by:

## Question

For each host (Linux x86_64/aarch64, macOS Apple Silicon, Windows), what is the fastest way to boot a nixpkgs-built Linux guest per harness session? Candidates include Firecracker, cloud-hypervisor, crosvm, libkrun/krunvm, QEMU microvm, Virtualization.framework, WHPX/Hyper-V, and WSL2.

For each, find out:
- boot time
- host↔guest file sharing (virtiofs and DAX, 9p) and its performance
- whether a host-side process can serve a filesystem into the guest
- which guest arch is required on each host, and the cost of emulating the other arch

## Answer

**Guest architecture on each host:**
- **Linux:** the guest arch equals the host arch under KVM. Options are Firecracker (about 125 ms boot, but no virtio-fs or 9p), Cloud Hypervisor, crosvm, QEMU, libkrun and alioth.
- **macOS on Apple Silicon:** aarch64 guests only, via Virtualization.framework (vfkit, Lima) or Hypervisor.framework VMMs (libkrun, alioth, OpenVMM, QEMU HVF). An x86_64 guest means slow QEMU emulation, or Rosetta for x86_64 userspace inside an aarch64 VM.
- **Windows:** WSL2, Hyper-V's host compute API, and WHP-based VMMs (QEMU, OpenVMM, libkrun's Windows backend on main).

**No single VMM library is clean across all three OSes:**
- libkrun's Windows support is unreleased; it exists only on main.
- OpenVMM covers all three, but its virtio-fs and 9p devices can't be snapshotted.
- QEMU covers all three, but virtio-fs is Linux-only.

**Serving a custom host-side filesystem:** on Linux, the `virtiofsd` crate's `FileSystem` trait over vhost-user-fs. On macOS, Virtualization.framework only shares directories, so a custom filesystem needs a guest-side client over vsock.

**Snapshots:** Firecracker and Cloud Hypervisor (lazy restore), and Virtualization.framework on macOS 14+.

**Performance data:** almost none is measured. The only numbers are 2019 sequential reads: 9p 27 MiB/s, virtio-fs 35 MiB/s, virtio-fs with DAX 245 MiB/s. DAX support today is contested.

Full findings: branch `research/native-vm-options`, `docs/research/native-vm-options.md`.

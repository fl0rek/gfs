# Native VM options per host platform

Research for the ticket "Native VM options per host platform". Facts and trade-offs only; no decisions.
Researched 2026-10-07. Every claim carries a source URL. Where a primary source was silent or unreachable, the text says "not found" or "unverified" instead of guessing.

Question: for each host (Linux x86_64 and aarch64, macOS on Apple Silicon, Windows), what is the fastest way to boot a nixpkgs-built Linux guest per agent-harness session? Context from the resolved ticket "Booting a nixpkgs Linux image in the browser": the browser can run an x86_64 guest (the only proven nixpkgs path) or aarch64, so the native guest arch should ideally be one of those two.

## Source-access caveats

- GitHub's HTML pages (commit lists, PRs, releases, tree views) block automated fetching, and the GitHub API was not available to this session. Primary sources were read as raw files from `raw.githubusercontent.com`, crates.io's API, crate tarballs on `static.crates.io`, and Apple's JSON documentation endpoint. GitLab (`gitlab.com`, home of virtiofsd and the virtio-fs site) was blocked, so virtiofsd was read from its crates.io tarball (1.14.0).
- "Last commit" and "latest release" dates below come from shallow `git fetch` of the named tag or branch head on 2026-10-07 (committer date), not from release pages.
- Several summaries of rendered web pages were produced by a fetch-and-summarise tool. Wherever a number or a limitation matters, it was re-checked against a raw source file; where it was not, that is noted.
- A first fetch of libkrun's GitHub releases page returned dates that did not match the crates.io publish dates (2026-09-29 for 1.19.6). The crates.io dates and the tag commit dates are used instead.

## Summary matrix

Boot times are vendor-stated or sample numbers from the project's own docs, measured on different hardware and different guests. They are not comparable across rows. "Not found" means no number in a primary source.

| Candidate | Host OS and arch | Boot time (primary source) | Host-folder sharing | Custom host-side FS into guest | Snapshot | Embedding | Licence | Health (2026-10-07) |
|---|---|---|---|---|---|---|---|---|
| Firecracker | Linux/KVM only; x86_64 and aarch64 | Spec: at most 125 ms from InstanceStart to guest `/sbin/init`, minimal kernel and rootfs | None (no virtio-fs, no 9p); block devices, virtio-pmem, vsock | No | Full and diff (diff is developer preview), lazy mmap restore | REST over UDS; no library crate | Apache-2.0 | v1.17.0 on 2026-09-04; main updated 2026-10-01; release every 2-3 months |
| Cloud Hypervisor | Linux (KVM or MSHV) only; x86_64 and aarch64 (riscv64 experimental) | Docs show a sample of about 106 ms mean (illustrative only) | virtio-fs via external virtiofsd; no DAX | Yes, any vhost-user-fs daemon | Snapshot and restore, optional userfaultfd lazy restore | REST over UDS, `ch-remote`, Rust workspace crates | Apache-2.0 AND BSD-3-Clause | v53.0 on 2026-07-12; main updated 2026-10-07 |
| crosvm | Linux (KVM and others) and Windows (WHPX, HAXM); no macOS listed; x86_64, aarch64, riscv64 | Not found | Built-in virtio-fs (with DAX window per microvm.nix), virtio-9p, vhost-user fs | Yes (vhost-user), plus runtime path allowlist socket | "Highly experimental" | Rust, auto-generated API docs, not a crates.io crate | BSD-3-Clause | main updated 2026-10-07 |
| QEMU (incl. microvm) | Linux KVM; macOS HVF; Windows WHPX; TCG everywhere; microvm is x86 only | microvm docs give relative numbers only (see below) | virtio-fs (Linux only in practice), virtio-9p (not on Windows) | vhost-user-fs on Linux only | savevm and migration; per-accelerator support unverified | C; QMP socket | GPL-2.0 | master updated 2026-10-06 |
| libkrun and krunvm | Linux KVM (x86_64, aarch64); macOS HVF arm64; Windows WHP code on main (x86_64) | No number in repo; goal is smallest boot time. Downstream microsandbox claims under 100 ms on M1 | virtio-fs in-process, DAX option in 2.0 API | In-process only (Rust `FileSystem` trait, in-memory overlay); generic vhost-user device on main (fs unconfirmed) | Pause and resume only in the C API | C API; Rust crates on crates.io | Apache-2.0 (libkrunfw: LGPL-2.1 plus GPL kernel) | v1.19.6 on 2026-09-29; main updated 2026-10-05 |
| Apple Virtualization.framework (via vfkit, vzvm, Lima, Containerization) | macOS only; guest arch equals host arch (aarch64 on Apple Silicon) | No number in Apple docs; Containerization claims sub-second container start | virtio-fs of one or several host directories; Rosetta share | No (closed set of share types); vsock gives a host-side channel | Save and restore, macOS 14 and later, VM must be paused | Swift or Objective-C; Rust bindings `objc2-virtualization` | Proprietary framework; vfkit Apache-2.0, vzvm MIT | vfkit v0.6.4 on 2026-07-06; Containerization 0.48.0 on 2026-09-29 |
| OpenVMM | Windows WHP (x64, Aarch64); Linux KVM or MSHV (x64, Aarch64); macOS Hypervisor.framework (Aarch64) | Not found | virtio-fs and virtio-9p (virtio-fs code is built for Windows and Linux only) | In-process in Rust; vhost-user not documented | Yes, but virtio-fs and virtio-9p are not snapshot-capable | Rust workspace, rustdoc published, not on crates.io | MIT | main updated 2026-10-06 |
| WSL2 and Hyper-V HCS | Windows only; x64 and Arm64 | WSL docs: "fast boot times", no number | 9p (Plan9) for Windows files, virtio-fs experimental | Windows to Linux: no documented hook; Linux to Windows: Plan9 server | HCS VMs support pause, resume, save, restore; WSL exposes none | WSL container API (C, C++, C#); HCS C API | WSL MIT; HCS is a Windows API | WSL 3.0.2 on 2026-10-02 |
| alioth | Linux KVM (x86_64, aarch64); macOS HVF (aarch64) | Not found | virtio-fs via virtiofsd, experimental DAX | Yes (vhost-user-fs) | Not found | Rust crate `alioth` 0.12.0 | Apache-2.0 | main updated 2026-10-07; self-described experimental |

## Guest architecture per host and the cost of the other one

| Host | Native (hardware-accelerated) guest arch | Foreign arch |
|---|---|---|
| Linux x86_64 | x86_64 (KVM) | aarch64 only through QEMU TCG |
| Linux aarch64 | aarch64 (KVM) | x86_64 only through QEMU TCG |
| macOS Apple Silicon | aarch64 (HVF, Virtualization.framework) | Whole x86_64 VM only through QEMU TCG; x86_64 userspace binaries inside an aarch64 VM through Rosetta (Virtualization.framework only) |
| Windows x64 | x86_64 (WHP, Hyper-V, WSL2) | aarch64 only through QEMU TCG |
| Windows on Arm | aarch64 (WHP, Hyper-V, WSL2) | x86_64 only through QEMU TCG (no primary source read on Windows-on-Arm x64 emulation for VMs) |

Sources and measured costs:

- QEMU's accelerator table: KVM (Linux; Arm, x86 and others), HVF (macOS; x86 and Arm), WHPX (Windows; Arm and x86), TCG on every host with the broadest guest list. A guest whose arch differs from the host's can only use TCG: https://www.qemu.org/docs/master/system/introduction.html (read through the fetch tool; the page lists accelerators per host).
- Apple: "A `VZVirtualMachine` object emulates a complete hardware machine of the same architecture as the underlying Mac computer": https://developer.apple.com/tutorials/data/documentation/virtualization/vzvirtualmachine.json . Lima's vz page: "Virtualization.framework doesn't support running 'intel guest on arm' and vice versa": https://raw.githubusercontent.com/lima-vm/lima/master/website/content/en/docs/config/vmtype/vz.md
- Rosetta in Linux VMs: `VZLinuxRosettaDirectoryShare` "enables running Intel binaries in Linux virtual machines through translation", Apple silicon only, macOS 13 and later: https://developer.apple.com/tutorials/data/documentation/virtualization/vzlinuxrosettadirectoryshare.json . vfkit documents wiring it up with binfmt_misc: https://raw.githubusercontent.com/crc-org/vfkit/main/doc/usage.md
- Cost of a full foreign-arch VM: Lima says "Running a VM with a foreign architecture is extremely slow" and offers a "fast mode" (QEMU user-mode emulation inside a native-arch VM) and Rosetta as alternatives: https://raw.githubusercontent.com/lima-vm/lima/master/website/content/en/docs/config/multi-arch.md . Lima's vmType page frames the macOS choice as "just need to run Intel userspace (fast), or entire Intel VM (slow)": https://lima-vm.io/docs/config/vmtype/
- No primary source with a measured TCG-versus-native slowdown for booting a Linux guest was found. The one academic hit (https://arxiv.org/abs/2501.03427) compares a proof-of-concept RISC-V emulator with TCG on synthetic code and is not a boot measurement.
- nixpkgs uses the Rosetta route for its macOS builder: `darwin.linux-builder-vz` "exposes Rosetta to the guest, so `x86_64-linux` builds are translated rather than emulated, which is substantially faster" and needs an Apple silicon host on macOS 13 or newer: https://raw.githubusercontent.com/NixOS/nixpkgs/master/doc/packages/darwin-builder.section.md

## Candidates

### Firecracker

- Hosts: "uses the Linux Kernel Virtual Machine (KVM)"; tested on Intel, AMD and Graviton instances running Amazon Linux hosts: https://raw.githubusercontent.com/firecracker-microvm/firecracker/main/README.md . No macOS or Windows host.
- Boot time: "It takes `<= 125 ms` to go from receiving the Firecracker InstanceStart API call to the start of the Linux guest user-space `/sbin/init` process", measured with the serial console disabled and a minimal kernel and root filesystem, backed by `test_boottime.py`: https://raw.githubusercontent.com/firecracker-microvm/firecracker/main/SPECIFICATION.md
- Devices: "only 6 emulated devices are available: virtio-net, virtio-balloon, virtio-block, virtio-vsock, serial console, and a minimal keyboard controller": https://raw.githubusercontent.com/firecracker-microvm/firecracker/main/FAQ.md . A virtio-pmem device now exists, and its docs describe mounting with DAX: https://raw.githubusercontent.com/firecracker-microvm/firecracker/main/docs/pmem.md
- Folder sharing: none. microvm.nix lists "no 9p/virtiofs shares": https://raw.githubusercontent.com/microvm-nix/microvm.nix/main/README.md
- Custom FS from a host process: no virtio-fs or 9p device exists. Host-side channels are the file-backed block device and vsock (both in the README feature list: https://raw.githubusercontent.com/firecracker-microvm/firecracker/main/README.md).
- Snapshot: full and diff snapshots, guest memory plus device state, restored through a `MAP_PRIVATE` mapping so pages load on demand; "Diff snapshots are still in developer preview"; network and vsock connections are not preserved; integrity is only a 64-bit CRC on the state file; restoring between different GIC versions on arm64 is not possible: https://raw.githubusercontent.com/firecracker-microvm/firecracker/main/docs/snapshotting/snapshot-support.md
- Guest inputs: "an uncompressed Linux kernel binary, and an ext4 file system image": https://raw.githubusercontent.com/firecracker-microvm/firecracker/main/docs/getting-started.md
- Embedding: a process with a RESTful control API ("The Firecracker process also provides a RESTful control API"): https://raw.githubusercontent.com/firecracker-microvm/firecracker/main/FAQ.md . No library crate found.
- Licence and health: Apache-2.0; "typically every two or three months": https://raw.githubusercontent.com/firecracker-microvm/firecracker/main/README.md . Tag v1.17.0 committed 2026-09-04, main head 2026-10-01 (git fetch).

### Cloud Hypervisor

- Hosts: "runs on top of the KVM hypervisor and the Microsoft Hypervisor (MSHV)"; main architectures x86-64 and AArch64, riscv64 experimental; guest OS "64-bit Linux and Windows 10/Windows Server 2019": https://raw.githubusercontent.com/cloud-hypervisor/cloud-hypervisor/main/README.md . Both hypervisors are Linux-side, so no macOS or Windows host.
- Boot time: the performance doc lists `boot_time_ms`, `boot_time_pmem_ms` and 16-vCPU variants, with a sample of mean 105.9 ms, min 92.4 ms and max 120.0 ms for `boot_time_pmem_ms` on v40.0, and states the sample "is for illustration purpose only and does not represent the actual performance": https://raw.githubusercontent.com/cloud-hypervisor/cloud-hypervisor/main/docs/performance_metrics.md
- Folder sharing: virtio-fs through an external `virtiofs` daemon over vhost-user; default `cache=never`, `cache=always` allowed; "Given the DAX feature is not stable yet from a daemon standpoint, it is not available in Cloud Hypervisor"; needs `--memory shared=on`: https://raw.githubusercontent.com/cloud-hypervisor/cloud-hypervisor/main/docs/fs.md
- Custom FS from a host process: yes, any process speaking vhost-user-fs can sit behind `--fs socket=...` (same doc). See "Serving a custom filesystem" below for the Rust building blocks.
- Snapshot: `pause`, `snapshot file://...`, `restore`; files are `config.json`, `memory-ranges`, `state.json`; restore can be eager copy or lazy through `userfaultfd` (`memory_restore_mode=ondemand`, needs Linux 6.6 or later for poisoning): https://raw.githubusercontent.com/cloud-hypervisor/cloud-hypervisor/main/docs/snapshot_restore.md . "Snapshot/restore is not supported across different versions": https://raw.githubusercontent.com/cloud-hypervisor/cloud-hypervisor/main/README.md
- Guest inputs: direct kernel boot with a `vmlinux` ELF (PVH) or bzImage on x86-64 and an `Image` on AArch64, or firmware boot (README above).
- Embedding: REST over a Unix socket (Apple's Containerization drives it that way: "controlled over its REST-on-UDS API by the standalone `CloudHypervisor` Swift package"): https://raw.githubusercontent.com/apple/containerization/main/README.md . Built on rust-vmm crates. The crates.io `cloud-hypervisor` crate is a 0.0.0 placeholder: https://crates.io/api/v1/crates/cloud-hypervisor
- Licence and health: Apache-2.0 AND BSD-3-Clause (same crates.io page). Tag v53.0 committed 2026-07-12, main head 2026-10-07.

### crosvm

- Hosts and arch: x86_64, aarch64, riscv64; "Linux/Android: KVM, Gunyah, GenieZone, Halla; Windows: WHPX, HAXM"; macOS is not listed: https://raw.githubusercontent.com/google/crosvm/main/README.md . Windows build: `cargo build --features all-msvc64,whpx`: https://raw.githubusercontent.com/google/crosvm/main/docs/book/src/building_crosvm/windows.md
- Boot time: not found.
- Folder sharing: "`virtio-fs` and `virtio-9p`": README above; usage in https://raw.githubusercontent.com/google/crosvm/main/docs/book/src/devices/fs.md . The doc warns that a virtio-fs root "performance will not be as good as running a root disk with virtio-block". microvm.nix says crosvm's built-in virtio-fs device supports DAX with a hard-coded 8 GiB window and that "virtiofsd cannot do DAX", but also that crosvm "9p shares broken": https://raw.githubusercontent.com/microvm-nix/microvm.nix/main/doc/src/shares.md
- Custom FS from a host process: vhost-user for "most virtio devices (block, net, etc)" so device emulation can run outside the VMM (https://raw.githubusercontent.com/google/crosvm/main/docs/book/src/devices/vhost_user.md). crosvm also runs its own fs backend as `crosvm device fs`, with "Dynamic Path Allowlist": a host process can add or remove allowed paths at runtime over a `SOCK_SEQPACKET` JSON socket (fs.md above).
- Snapshot: "highly experimental ... 100% not supported ... only supports a very limited set of devices": https://raw.githubusercontent.com/google/crosvm/main/docs/book/src/architecture/snapshotting.md
- Embedding: Rust; each device can be a minijail-sandboxed process; auto-generated API docs at https://crosvm.dev/doc/crosvm/ (README). Not published as a crates.io crate (crates.io API returned "does not exist" for `crosvm`).
- Licence and health: BSD-3-Clause (README badge and LICENSE: https://raw.githubusercontent.com/google/crosvm/main/LICENSE). GitHub mirror main head 2026-10-07.

### QEMU, including the microvm machine

- Hosts: KVM on Linux, HVF on macOS, WHPX on Windows (x86_64 and arm64): https://www.qemu.org/docs/master/system/introduction.html . WHPX on arm64 needs Windows 11 24H2 with the April or May 2025 updates: https://raw.githubusercontent.com/qemu/qemu/master/docs/system/whpx.rst
- `microvm`: "a minimalist machine type without PCI nor ACPI support, designed for short-lived guests", up to eight virtio-mmio devices, uses `qboot` by default, needs a host-side kernel (and optional initrd) because no firmware boots from virtio-mmio block; it is documented under `i386` and Ubuntu only ships `qemu-system-x86_64-microvm`: https://raw.githubusercontent.com/qemu/qemu/master/docs/system/i386/microvm.rst and https://ubuntu.com/server/docs/explanation/virtualisation/qemu-microvm/ . An aarch64 guest uses the `virt` machine, which is not a microvm-style machine (no aarch64 microvm doc was found).
- Boot time: no absolute Linux number in QEMU's docs. The microvm cover letter reports an OSv unikernel (not Linux) reaching userspace in 3.64 ms on microvm against 11.77 ms on q35, KVM, 64 MB RAM: https://patchew.org/QEMU/20191018105315.27511-1-slp@redhat.com/ . Ubuntu's page reports "282ms faster kernel start" from standard QEMU to microvm and a further "526ms" with qboot, "not in a very performance-controlled environment" (Ubuntu page above).
- Folder sharing: virtio-9p is built only for Linux, macOS and FreeBSD hosts (`virtio-9p (virtfs) requires Linux or macOS or FreeBSD`): https://raw.githubusercontent.com/qemu/qemu/master/meson.build . virtio-fs needs vhost-user, which is auto-disabled off Linux and an error on Windows (same file: `disable_auto_if(host_os != 'linux')`, `vhost-user is not available on Windows`). virtiofsd itself depends on libcap-ng and libseccomp (https://static.crates.io/crates/virtiofsd/virtiofsd-1.14.0.crate, `README.md`).
- Custom FS from a host process: yes on Linux through vhost-user-fs.
- Snapshot: live migration and `savevm` exist (docs/devel/migration); microvm "does *not* support ... Live migration across QEMU versions" (microvm.rst above). Whether migration or `savevm` works under HVF or WHPX: unverified, no statement found.
- Embedding: C program, QMP control socket. No embedding crate.
- Licence and health: GPL-2.0 (https://raw.githubusercontent.com/qemu/qemu/master/COPYING). master head 2026-10-06.

### libkrun, libkrunfw, krunvm, krunkit

- Hosts: "KVM Virtualization on Linux and HVF on macOS/ARM64": https://raw.githubusercontent.com/containers/libkrun/main/README.md . krunvm lists Linux/KVM on x86_64 and AArch64 and macOS/Hypervisor.framework on ARM64: https://raw.githubusercontent.com/containers/krunvm/main/README.md
- Windows: absent from the README, but main contains a Windows backend. The workspace has a `src/whp` member (`krun-whp`, "Windows Hypervisor Platform backend for libkrun", copyright 2026, built on `windows-sys` and the WHP x86 instruction emulator, x86_64 only in the code read): https://raw.githubusercontent.com/containers/libkrun/main/Cargo.toml and https://raw.githubusercontent.com/containers/libkrun/main/src/whp/src/lib.rs . The virtio-fs module has a `windows` passthrough implementation (https://raw.githubusercontent.com/containers/libkrun/main/src/devices/src/virtio/fs/mod.rs). libkrunfw's README documents a Windows build ("`libkrunfw.dll`", a kernel config with Hyper-V enlightenments, 4K alignment): https://raw.githubusercontent.com/containers/libkrunfw/main/README.md . Whether the stable 1.x releases include any of this: unverified.
- API status: "The `main` branch is now **libkrun 2.0**, which will not be backwards compatible with the 1.x API/ABI ... may change further before the first stable release"; 1.0 onward public API is stable per SemVer for the 1.x line (README above).
- Boot time: no number in the repo; the stated goal is "the smallest possible footprint in every aspect (RAM consumption, CPU usage and boot time)" (README). Microsandbox, a libkrun consumer, claims "Average boot times under 100 milliseconds" with the footnote "Boot time refers to guest boot on an M1 machine": https://raw.githubusercontent.com/superradcompany/microsandbox/main/README.md . That is a vendor claim for a different product.
- Folder sharing: virtio-fs, with `krun_fs_device_set_dax_window_size` ("When set, the guest can memory-map files from the shared filesystem directly into its address space ... If not set, no DAX window is allocated") in the 2.0 C header: https://raw.githubusercontent.com/containers/libkrun/main/include/libkrun.h . Security: libkrun "does not provide any protection against the guest attempting to access other directories in the same filesystem" (README).
- Custom FS from a host process: the 2.0 header offers `krun_fs_device_new_null` plus `krun_fs_overlay_*` (virtual in-memory directories and files layered over a null or real fs) and a generic `krun_vhost_user_device_new(device_type, socket_path, ...)` whose doc comment names RNG (4) and Sound (32) as examples (header above). Whether the vhost-user wrapper accepts type 26 (fs) was not confirmed; the wrapper's source includes `shmem_map`/`shmem_unmap` handling (https://raw.githubusercontent.com/containers/libkrun/main/src/devices/src/virtio/vhost_user/device.rs). An in-process Rust `FileSystem` trait exists (https://raw.githubusercontent.com/containers/libkrun/main/src/devices/src/virtio/fs/filesystem.rs) but is not exposed through the C API.
- Snapshot: the 2.0 header exposes `krun_vmm_handle_pause` and `krun_vmm_handle_resume`; no save or restore call (header above). Microsandbox, built on a libkrun fork, documents "Full snapshots" that capture "Disk, memory, and running processes" and fork/copy-on-write memory restore, without saying which platforms: https://docs.microsandbox.dev/sandboxes/snapshots
- Guest kernel: libkrunfw bundles a kernel as a shared library (guest `NR_CPUS` 16 for x86_64, aarch64 and Windows builds); an external kernel can be loaded with `krun_payload_load_external(kernel_path, format, initrd_path, cmdline)`. TSI networking "Requires a custom kernel (like the one bundled in libkrunfw)" (README).
- Embedding: C API; Rust FFI crate `krun-sys` 1.10.1 (2025-02-27, Apache-2.0, 17,070 downloads) lags the library: https://crates.io/api/v1/crates/krun-sys . The library's own crates are also published on crates.io (`libkrun` 1.19.6, `krun-vmm`, `krun-devices`, `krun-hvf`, all 2026-09-29): https://crates.io/api/v1/crates/libkrun . A fork publishes `msb_krun` ("Native Rust API for libkrun microVMs", 0.1.40 on 2026-10-02): https://crates.io/api/v1/crates/msb_krun
- Licence and health: libkrun Apache-2.0. libkrunfw's wrapper code is LGPL-2.1-only and the bundled kernel is GPL-2.0-only; "other programs linking against this library are not required to be licensed under the GPL-2.0-only nor the LGPL-2.1-only licenses": libkrunfw README above. Tag v1.19.6 committed 2026-09-29, main head 2026-10-05; releases on crates.io 1.18.0 (2026-04-28), 1.19.0 (2026-06-10), 1.19.3 (2026-06-29), 1.19.6 (2026-09-29).
- Downstream: Microsandbox's README lists "Linux: KVM enabled; macOS: Apple Silicon; Windows: WHP enabled" and Rust, TypeScript and Go SDKs; it calls itself "beta software" and Apache-2.0 (README above).

### Apple Virtualization.framework (and vfkit, vzvm, Lima, Containerization)

- Host and arch: macOS only; the VM matches the Mac's architecture (quote above). The Linux sample requires an `aarch64` kernel and ramdisk on Apple silicon: https://developer.apple.com/tutorials/data/documentation/virtualization/running-linux-in-a-virtual-machine.json
- Boot: `VZLinuxBootLoader` with `kernelURL`, `commandLine`, optional `initialRamdiskURL`, only with `VZGenericPlatformConfiguration`: https://developer.apple.com/tutorials/data/documentation/virtualization/vzlinuxbootloader.json . vfkit adds that on Apple silicon the kernel "must be uncompressed" with `--bootloader linux`, and exits with an error on a compressed kernel; EFI boot has no such requirement: https://raw.githubusercontent.com/crc-org/vfkit/main/doc/usage.md
- Boot time: no number in Apple's documentation. Apple's Containerization says "Containers achieve sub-second start times using an optimized Linux kernel configuration and a minimal root filesystem with a lightweight init system": https://raw.githubusercontent.com/apple/containerization/main/README.md . No independent measurement found.
- Folder sharing: `VZVirtioFileSystemDeviceConfiguration` exposes host directories by tag, "single or multiple directories with read/write or read-only access" (macOS 12 and later): https://developer.apple.com/tutorials/data/documentation/virtualization/vzvirtiofilesystemdeviceconfiguration.json . No DAX option is documented. No Apple-published performance figure found.
- Custom FS from a host process: `VZDirectoryShare` is a base class with exactly three subclasses: single, multiple, Rosetta: https://developer.apple.com/tutorials/data/documentation/virtualization/vzdirectoryshare.json . `VZVirtioSocketDevice` lets the host listen on and connect to guest vsock ports (https://developer.apple.com/tutorials/data/documentation/virtualization/vzvirtiosocketdevice.json); vfkit exposes each vsock port as a Unix socket on the host (usage.md above). A host-side filesystem server would therefore need a guest-side client over vsock (FUSE, NFS or 9p); no ready-made one was found in the sources read.
- Snapshot: `saveMachineStateTo` needs a paused VM, macOS 14.0 and later; `validateSaveRestoreSupport()` warns "Not all configuration options can be safely saved and restored": https://developer.apple.com/tutorials/data/documentation/virtualization/vzvirtualmachine/savemachinestateto(url:completionhandler:).json and https://developer.apple.com/tutorials/data/documentation/virtualization/vzvirtualmachineconfiguration/validatesaverestoresupport().json . Apple DTS said speed "is primarily determined by guest RAM size"; one developer measured save 1.50 s for 1248 MB and restore 3.36 s for 1280 MB after tuning (macOS 15.7.7, guest OS not stated): https://developer.apple.com/forums/thread/828750 . vfkit's usage doc has no save or restore option.
- Embedding: Swift or Objective-C. Rust bindings `objc2-virtualization` 0.3.2 (2025-10-04, Zlib OR Apache-2.0 OR MIT): https://crates.io/api/v1/crates/objc2-virtualization . The process needs the virtualization entitlement (`vzvm` signs its binary with one: https://raw.githubusercontent.com/NixOS/nixpkgs/master/pkgs/by-name/vz/vzvm/package.nix). vfkit is a Go CLI plus a Go config package (https://raw.githubusercontent.com/crc-org/vfkit/main/README.md).
- Licence and health: the framework is Apple's; vfkit Apache-2.0 (tag v0.6.4 on 2026-07-06, main 2026-09-18; adopters include podman 5.0 and minikube per its README); `vzvm` MIT, "Minimal Linux VM monitor", `aarch64-darwin` only, "Highly specialized for use as linux-builder" (nixpkgs package file above); Containerization needs macOS 26 and Xcode 26 (README above), tag 0.48.0 on 2026-09-29; Lima 2.2.1 on 2026-10-03.
- Related: Lima also ships a `krunkit` driver (libkrun based; Lima 2.0 or newer, macOS 14 or newer, Apple Silicon, "experimental"): https://raw.githubusercontent.com/lima-vm/lima/master/website/content/en/docs/config/vmtype/krunkit.md

### OpenVMM (Microsoft)

- Hosts: a table in the guide: Windows x64 and Aarch64 on WHP; Linux x64 and Aarch64 on KVM or MSHV; macOS Aarch64 on Hypervisor.framework. Boot modes: UEFI, BIOS, "Linux Direct Boot" (`--kernel` must be "an uncompressed kernel (vmlinux, not bzImage)"): https://raw.githubusercontent.com/microsoft/openvmm/main/Guide/src/user_guide/openvmm.md and https://raw.githubusercontent.com/microsoft/openvmm/main/Guide/src/user_guide/openvmm/run.md
- Focus: "Although it can function as a traditional VMM, OpenVMM's development is currently focused on its role in the OpenHCL paravisor": https://raw.githubusercontent.com/microsoft/openvmm/main/README.md
- Boot time: not found.
- Folder sharing: virtio-fs and virtio-9p are listed devices. The virtiofs crate is compiled only for Windows and Linux (`#![cfg(any(windows, target_os = "linux"))]`), implemented in-process over a FUSE protocol layer, and maps a DAX shared-memory region (the device unmaps "DAX region on reset"): https://raw.githubusercontent.com/microsoft/openvmm/main/vm/devices/virtio/virtiofs/src/lib.rs and https://raw.githubusercontent.com/microsoft/openvmm/main/vm/devices/virtio/virtiofs/src/virtio.rs . The guide's virtio-fs reference pages are empty stubs.
- Custom FS from a host process: the virtiofs device is in-process; vhost-user was not found in the guide.
- Snapshot: `save-snapshot` and `--restore-snapshot`, with file-backed memory, a manifest, device state; the VM stays paused after saving; memory and processor count must match; "virtio-9p, virtiofs" and virtio-console are in the not-supported list, so a VM with a shared folder cannot be snapshotted; snapshots are not portable across architectures: https://raw.githubusercontent.com/microsoft/openvmm/main/Guide/src/user_guide/openvmm/snapshots.md
- Embedding: Rust workspace with rustdoc, management by CLI, interactive console, gRPC and ttrpc ("evolving"); no crate named `openvmm` exists on crates.io (API returned "does not exist").
- Licence and health: MIT (https://raw.githubusercontent.com/microsoft/openvmm/main/LICENSE). main head 2026-10-06.

### WSL2 and the Windows Host Compute System (HCS)

- WSL2: "uses a lightweight utility virtual machine (VM)", with distributions as isolated namespaces inside one shared VM (same kernel, memory, network namespace): https://learn.microsoft.com/en-us/windows/wsl/about . The VM is created through HCS: `wslservice.exe` passes a JSON VM description to `HcsCreateComputeSystem()`, boots Microsoft's kernel or a custom one from `.wslconfig` with a minimal initramfs, then mounts the distro VHD: https://wsl.dev/technical-documentation/boot-process/ and https://learn.microsoft.com/en-us/windows/wsl/wsl-config . WSL2 needs the "Virtual Machine Platform" feature, available on Home editions; "WSL supports x64 and Arm64 CPUs": https://learn.microsoft.com/en-us/windows/wsl/faq
- Boot time: "Fast boot times" is a ticked feature for both WSL versions; no number: https://learn.microsoft.com/en-us/windows/wsl/compare-versions . The boot-process doc has "no explicit timing statements".
- Folder sharing: the `\\wsl$` direction is a Plan9 server inside the distro reached over Hyper-V sockets (https://wsl.dev/technical-documentation/plan9/); Lima notes WSL2's disk sharing "uses a 9P protocol server, making the performance similar to Lima's 9p mode": https://raw.githubusercontent.com/lima-vm/lima/master/website/content/en/docs/config/mount.md . `.wslconfig` has an experimental `virtiofs` setting for Windows filesystem shares (needs `virtio` and `hostFileSystemAccess`). Microsoft says Linux-side file operations are faster on WSL2 (for example "2-5x faster" for `git clone`) while access to Windows files is slower than on WSL1: https://learn.microsoft.com/en-us/windows/wsl/compare-versions
- Custom FS from a host process: no documented hook for serving a custom filesystem into a WSL2 distro. HCS's published schema for devices lists `Plan9`, `VirtualSmb`, `HvSocket` shares and no virtio-fs entry: https://raw.githubusercontent.com/microsoft/hcsshim/main/internal/hcs/schema2/devices.go (schema 2.2 in hcsshim; WSL may use newer private pieces).
- Snapshot: HCS: "For VMs, additional operations such pause, resume, save and restore are supported": https://learn.microsoft.com/en-us/virtualization/api/hcs/overview . No WSL-level snapshot of the running VM was found. WSL2 distros share one utility VM (about page above), so starting a distro is a namespace start rather than a VM boot; whether a session in the WSL container API gets its own VM is not stated in the pages read.
- Direct kernel boot through HCS: the schema carries `LinuxKernelDirect` with `KernelFilePath`, `InitRdPath`, `KernelCmdLine`: https://raw.githubusercontent.com/microsoft/hcsshim/main/internal/hcs/schema2/linux_kernel_direct.go
- Custom guest: WSL2 imports a tar root filesystem, not a VM disk image (Lima: "WSL2 requires a `tar` formatted rootfs archive instead of a VM image"): https://raw.githubusercontent.com/lima-vm/lima/master/website/content/en/docs/config/vmtype/wsl2.md . NixOS-WSL ships a `.wsl` file that installs by double-click on WSL 2.4.4 or newer: https://raw.githubusercontent.com/nix-community/NixOS-WSL/main/README.md
- Embedding: the WSL container API gives C (`wslcsdk.h`), C++ and C# bindings with a Session, Container, Process hierarchy, image pull and import, VHD volumes, port mapping and volume mounting, and needs WSL 2.9.3 or newer: https://wsl.dev/api-reference/ and https://learn.microsoft.com/windows/wsl/wsl-container . It is container-shaped (OCI images); support for custom kernel or rootfs through it is not documented in those pages. HCS has a C API. Rust: `windows-sys` has `Win32_System_Hypervisor` (used by libkrun's WHP crate); the `hcs-rs` crate was last updated 2020-01-06: https://crates.io/api/v1/crates/hcs-rs
- Lima drivers on Windows: `wsl2` (experimental) and `hcs` (experimental; Lima 2.3 or newer; "We tested it works only on Windows 11 (x86_64)"; plain mode only, no file mounts; only one instance at a time; requires the Hyper-V Administrators group): https://raw.githubusercontent.com/lima-vm/lima/master/website/content/en/docs/config/vmtype/hcs.md
- Windows Hypervisor Platform (WHP, the API QEMU, libkrun and OpenVMM use): C API in `WinHvPlatform.dll`, available since the April 2018 Update, x64 and Arm64, provides partitions, vCPUs, memory mapping and optional local APIC emulation (no device models): https://learn.microsoft.com/en-us/virtualization/api/hypervisor-platform/hypervisor-platform . Whether it is available on Home editions: not stated in the page read; QEMU's doc says client editions enable it as the "Windows Hypervisor Platform" feature: https://raw.githubusercontent.com/qemu/qemu/master/docs/system/whpx.rst
- Licence and health: WSL repo MIT (https://raw.githubusercontent.com/microsoft/WSL/master/LICENSE); tag 3.0.2 committed 2026-10-02. hcsshim MIT, main head 2026-10-04.

### alioth

- Hosts: "KVM on Linux and Apple's Hypervisor framework on macOS"; x86_64 on Linux, aarch64 on Linux and macOS; Nix flake provided; "experimental ... NOT an officially supported Google product": https://raw.githubusercontent.com/google/alioth/main/README.md
- Folder sharing: `fs` device "Backed by virtiofsd with experimental Direct Access (DAX) support" (README). microvm.nix agrees that alioth and crosvm are the only two hypervisors with DAX shares and that alioth keeps "virtiofsd" as the server (https://raw.githubusercontent.com/microvm-nix/microvm.nix/main/doc/src/shares.md). This conflicts with the virtiofsd 1.14.0 source, where the SetupMapping and RemoveMapping handlers return `ENOSYS` (see below); the conflict is unresolved here.
- Embedding: Rust crate `alioth` 0.12.0 (2026-03-14, Apache-2.0): https://crates.io/api/v1/crates/alioth . Boot time and snapshot: not found.
- Health: main head 2026-10-07.

## Serving a custom filesystem into the guest

| Mechanism | Hosts | What the host process provides |
|---|---|---|
| vhost-user-fs daemon | QEMU, Cloud Hypervisor, crosvm, alioth on Linux | A separate process answering FUSE requests over a Unix socket |
| In-process virtio-fs device | libkrun (Linux, macOS, Windows code), crosvm built-in, OpenVMM | Compiled into the VMM; libkrun's C API only offers real directories and an in-memory overlay |
| Fixed directory shares | Virtualization.framework | Host directories only |
| vsock plus a guest-side client | Virtualization.framework, libkrun, Firecracker, Hyper-V sockets | Anything, but the guest needs a client (FUSE, NFS, 9p) |
| Plan9 / SMB shares | WSL2, HCS | Fixed share types |

Rust building blocks for the vhost-user route:

- The `virtiofsd` crate (1.14.0, 2026-07-06, Apache-2.0 AND BSD-3-Clause) has a library target. `VhostUserFsBackendBuilder::build<F: FileSystem + SerializableFileSystem + Send + Sync>` takes any type implementing its `FileSystem` trait, so a custom filesystem can be served by a small Rust daemon: https://static.crates.io/crates/virtiofsd/virtiofsd-1.14.0.crate (`src/lib.rs`, `src/vhost_user.rs`, `src/filesystem.rs`). Its README requires running as root or a user-namespace root and uses seccomp and capability dropping; the CI binary is x86_64 Linux only.
- `fuse-backend-rs` 0.14.0 (2026-02-26, Apache-2.0 AND BSD-3-Clause): "A rust library for Fuse servers and virtio-fs devices", with pluggable backends (passthrough, pseudo, overlay) and vhost-user-fs servers; Linux first, macOS and FreeBSD through fuse-t, Windows unsupported; used by nydusd: https://raw.githubusercontent.com/cloud-hypervisor/fuse-backend-rs/master/README.md
- `vhost-user-backend` 0.23.0 and `vhost` 0.17.0 (rust-vmm, 2026-07): https://crates.io/api/v1/crates/vhost-user-backend

Constraints found:

- DAX needs the daemon to handle the FUSE SetupMapping and RemoveMapping requests. In virtiofs 1.14.0 both handlers reply `ENOSYS` (`src/server.rs`), and Cloud Hypervisor's doc says DAX is unavailable. microvm.nix: "On crosvm virtiofs cannot do DAX, so the share is handed to crosvm's own built-in virtio-fs device instead" (shares.md above).
- Snapshots with virtiofsd: its state can ride in the front-end's migration stream, but "virtiofsd never migrates any data"; the shared directory must be restored to the same content by other means: virtiofsd `doc/migration.md` in the crate tarball above.
- crosvm gives a host process live control of what a share exposes (path allowlist socket, fs.md above); nothing equivalent was found elsewhere.

## File-sharing performance

Measured data in primary sources is thin and old.

- virtio-fs patch series cover letter (Vivek Goyal, 2019), fio on ramfs, 4 files of 2 GB, KVM guest: sequential read, one job, psync engine: 9p cache=none 27 MiB/s, virtio-fs cache=none 35 MiB/s, virtio-fs cache=none with DAX 245 MiB/s; with several jobs: 117, 162 and 894 MiB/s. The same series reports mmap workloads failing (0 KiB/s) on virtio-fs without DAX and working with it, and warns that DAX "window reclaim logic is slower and if file size is bigger than dax window size, performance slows down" (the test used an 8 GB window): https://lkml.iu.edu/hypermail/linux/kernel/1908.2/05325.html
- The earlier RFC cover letter reported DAX results "not as fast as we were expecting" at that stage: https://lwn.net/Articles/774495/
- Cloud Hypervisor: `thread-pool-size` "is critical to getting an acceptable performance compared to native" on NVMe, and `cache=always` can improve performance at the cost of host memory: fs.md above.
- Lima mounts: macOS default is virtiofs on vz; QEMU default is 9p on non-Windows; WSL2 mount performance is described as similar to 9p. No numbers are given: https://raw.githubusercontent.com/lima-vm/lima/master/website/content/en/docs/config/mount.md
- microvm.nix: "Expect `virtiofs` to yield better performance over `9p`"; also advises that volumes (block devices) give "fast performance" but need exclusive access: https://raw.githubusercontent.com/microvm-nix/microvm.nix/main/doc/src/shares.md
- Not found: measurements for Virtualization.framework virtio-fs, libkrun virtio-fs (any host), OpenVMM virtio-fs, crosvm DAX, or WSL2's experimental virtiofs.

## Snapshot summary

| Candidate | State saved | Shared-folder device in the snapshot | Notes |
|---|---|---|---|
| Firecracker | Memory and device state | Not applicable (no fs device) | Lazy mmap restore; diff is developer preview |
| Cloud Hypervisor | Memory, device state, config | Not covered in the docs read | Optional userfaultfd lazy restore; not across versions |
| crosvm | Memory and device state (limited devices) | Not found | "Highly experimental", not supported |
| QEMU | `savevm` and migration | virtiofsd state migrates but data does not | Per-accelerator support unverified |
| libkrun | Pause and resume only | n/a | Full snapshots only in a downstream fork's product |
| Virtualization.framework | Memory and device state | Config must pass `validateSaveRestoreSupport` | macOS 14 or newer; one forum report of 1.5 s save and 3.4 s restore for about 1.2 GB |
| OpenVMM | RAM, device state, manifest | virtio-fs and virtio-9p block snapshotting | Memory and CPU count must match; not portable across arch |
| HCS | Pause, resume, save, restore (documented) | Not stated | WSL2 itself exposes no such control |

## Is there one library for all three host OSes?

Facts, no ranking:

- libkrun: one C library, one Rust code base. README lists Linux and macOS/ARM64; `main` also carries a WHP (Windows) backend and a Windows virtio-fs passthrough, and libkrunfw documents a Windows build. The Windows code reads as x86_64 only. `main` is the unstable 2.0 API. Microsandbox (a downstream) lists Linux, macOS and Windows support and calls itself beta. Snapshot is not part of the C API.
- OpenVMM: one Rust code base for Windows (x64 and Aarch64, WHP), Linux (x64 and Aarch64, KVM or MSHV) and macOS (Aarch64 only, Hypervisor.framework). Direct Linux boot needs an uncompressed `vmlinux`. Snapshot exists but excludes virtio-fs and virtio-9p. Its stated focus is the OpenHCL paravisor, and it is not published as crates.
- QEMU: one codebase and CLI over KVM, HVF and WHPX, but some features are per-OS (vhost-user and so virtio-fs: Linux only; virtio-9p: not Windows; microvm: x86 only).
- Per-OS only: Firecracker and Cloud Hypervisor (Linux), Virtualization.framework (macOS), WSL2 and HCS (Windows). crosvm covers Linux and Windows but not macOS. alioth covers Linux and macOS but not Windows.
- Abstraction-layer precedents (not a single VMM): Apple's Containerization uses Virtualization.framework on macOS and Cloud Hypervisor plus virtiofsd plus KVM on Linux behind one `VirtualMachineManager` protocol (README above); Lima has `qemu`, `vz`, `krunkit`, `wsl2` and `hcs` drivers (https://lima-vm.io/docs/config/vmtype/); microvm.nix drives eight hypervisors, with macOS only through vfkit (README above).

## What exists on the nixpkgs side

- microvm.nix builds NixOS guests and runs them on NixOS/Linux hosts and macOS (via vfkit); hypervisors: qemu, cloud-hypervisor, firecracker, crosvm, kvmtool, stratovirt, alioth, vfkit; read-only root as squashfs or erofs with optional host `/nix/store` share and writable overlay; MIT licence (https://raw.githubusercontent.com/microvm-nix/microvm.nix/main/LICENSE); main head 2026-10-06: https://raw.githubusercontent.com/microvm-nix/microvm.nix/main/README.md and https://raw.githubusercontent.com/microvm-nix/microvm.nix/main/doc/src/shares.md
- nixpkgs: `darwin.linux-builder` (QEMU on macOS; the README shows an `aarch64` NixOS guest console) and `darwin.linux-builder-vz` (Virtualization.framework through `pkgs.vzvm`, Rosetta, host-guest transport over vsock, optional nested virtualization on macOS 15 and later with M3 or newer): https://raw.githubusercontent.com/NixOS/nixpkgs/master/doc/packages/darwin-builder.section.md
- alioth has a Nix flake, and `nix run github:google/alioth#vm` boots "a Linux kernel and BusyBox from the NixOS binary cache": README above.
- NixOS-WSL for WSL2 (Apache-2.0): README above.
- Guest kernel image formats differ per VMM: Firecracker wants an uncompressed kernel binary; Cloud Hypervisor takes vmlinux (PVH) or bzImage on x86-64 and Image on AArch64; vfkit wants an uncompressed arm64 kernel with its Linux bootloader; OpenVMM wants an uncompressed `vmlinux`; Containerization needs VIRTIO drivers built in (not modules) and tests from kernel 6.14.9. Which of those formats nixpkgs kernel outputs provide was not checked in this research.

## Open or unverified items

- Boot-time numbers for libkrun, Virtualization.framework, WSL2, crosvm, OpenVMM and QEMU-with-Linux in a primary source. The numbers above are vendor claims or illustrative samples taken under different conditions.
- Whether libkrun's Windows backend is usable and which release carries it; whether libkrun's vhost-user wrapper accepts a virtio-fs backend.
- QEMU snapshot behaviour under HVF and WHPX.
- crosvm virtio-fs on a Windows host.
- Whether HCS or WSL2 can mount a user-space-served filesystem without a guest-side client.
- Windows on Arm: which VMMs actually run (QEMU WHPX arm64 is documented; libkrun and OpenVMM Windows Arm paths were not checked beyond OpenVMM's table).
- The DAX discrepancy between microvm.nix and alioth's README on one side and virtiofsd 1.14.0's `ENOSYS` handlers on the other.
- Quantified cost of TCG for a full Linux guest on each host.

# Booting a nixpkgs Linux image in the browser

Research for ticket `02-booting-a-nixpkgs-linux-image-in-the-browser`. Facts only; no decisions.
Researched 2026-10-07. Every claim carries a source URL. Where a primary source was unreachable or silent, that is stated as "not found" rather than guessed.

Source-access caveats: GitHub's commit-history and directory pages block automated fetching (robots.txt) and the GitHub API was not available to this session, so repo "last commit" dates come from release pages, README text, and package registries instead. Several summaries were produced by fetching raw README/docs files.

## Summary table

| Candidate | Guest arch | Nixpkgs-built image known to boot? | Multi-core | JIT | Licence | Health |
|---|---|---|---|---|---|---|
| v86 | 32-bit x86 only | None found | No | x86-to-wasm JIT | BSD-2-Clause | Active (npm release 2026-10-04) |
| container2wasm (Bochs) | x86_64 | None found | Not documented | Interpreter (Bochs) | Apache-2.0 (bundles GPL/LGPL parts) | Active (v0.8.4, 2026-03-16) |
| container2wasm (TinyEMU) | riscv64 | None found | Not documented | None documented | Apache-2.0 (TinyEMU is MIT) | same |
| container2wasm `--to-js` / qemu-wasm | x86_64, AArch64, RISC-V64 | trynix (x86_64, but not full NixOS) | MTTCG supported, "experimental" | Hybrid TCI + per-TB wasm JIT | GPL/LGPL (QEMU) | Fork's last commit seen 2025-09-04; no releases |
| CheerpX / WebVM | x86 (bitness not found in docs) | None found | Not documented | x86-to-wasm JIT | Proprietary runtime, free for individuals/FOSS | Active vendor product |
| TinyEMU / JSLinux | RISC-V 32/64/128, x86 | None found | Not documented | None documented | MIT | Last release 2019-12-21 |
| linux-wasm (kernel as wasm) | wasm32/wasm64 nommu | No (not a nixpkgs target) | Not documented | n/a (native wasm) | Not found | Tech demo, active |

## Constraint context: what nixpkgs can build

- NixOS officially offers installer ISOs for x86_64 and aarch64 only: https://nixos.org/download/
- i686 (32-bit x86): the NixOS team removed the 32-bit ISO and over 2,000 i686 tests and stopped publishing i686 in release channels after 23.11 (announced 2024-01-02, effective 24.05); only 32-bit packages needed by 64-bit systems (Steam, Wine) stay cached: https://discourse.nixos.org/t/limited-cache-availability-for-i686-32-bits-x86-architecture/37626
- riscv64: "NixOS has no official support for riscv64-linux architecture on the nixpkgs-unstable and stable channel"; third-party binary caches exist; QEMU riscv64 emulation "occasionally" segfaults though it works on hardware: https://wiki.nixos.org/wiki/RISC-V
- riscv64 official cache: a NixOS infrastructure member said in May 2024 "there are no plans for the official infra so far (`{hydra,cache}.nixos.org`)", and a reply suggested cross-compiling from x86 instead: https://discourse.nixos.org/t/binary-cache-for-riscv64/44934
- The NixOS 26.05 announcement mentions architecture changes only for x86_64-darwin; nothing on i686/riscv64/aarch64: https://nixos.org/blog/announcements/2026/nixos-2605/

## v86

- **Guest arch:** x86 PC emulator, "instruction set is around Pentium 4 level, including full SSE3". Linux "works pretty well" but 64-bit kernels are not supported. Missing: multicore, task gates and far calls in protected mode. https://github.com/copy/v86/blob/master/Readme.md
- **Nixpkgs/NixOS:** no example found. The repo's image-building doc covers 32-bit Arch Linux and points to an Alpine setup; NixOS is not mentioned: https://raw.githubusercontent.com/copy/v86/master/docs/archlinux.md . Given the i686 status above, a current NixOS release has no official 32-bit image or cache.
- **Performance/JIT:** "Machine code is translated to WebAssembly modules at runtime" (x86-to-wasm JIT): https://github.com/copy/v86/blob/master/Readme.md . No benchmark numbers found in primary sources. Single core (no SMP).
- **Networking:** NIC options ne2k and virtio. Backends: in-browser BroadcastChannel (guest-to-guest only), WebSocket relay of raw ethernet frames (needs a proxy server), WISP (TCP/UDP over WebSocket, client sockets only), and a fetch() backend (needs a CORS proxy for cross-origin): https://raw.githubusercontent.com/copy/v86/master/docs/networking.md
- **Disk/FS:** IDE disk, virtio filesystem (9p) and virtio-net/balloon: https://github.com/copy/v86/blob/master/Readme.md . 9p in browser: "loads files over HTTP on-demand into an in-memory filesystem in JS", built from an `fs.json` plus a sha256-named file directory; the doc does not describe OPFS or IndexedDB persistence: https://raw.githubusercontent.com/copy/v86/master/docs/filesystem.md
- **Licence:** Simplified BSD (npm: BSD-2-Clause): https://registry.npmjs.org/v86
- **Health:** npm latest 0.5.470 published 2026-10-04, previous 0.5.469 on 2026-10-01: https://registry.npmjs.org/v86

## container2wasm (c2w)

Converts a container image to a wasm image bundling an emulator plus Linux kernel plus the container rootfs.

- **Guest arch and backends:** x86_64 via Bochs (wasi-sdk), riscv64 via TinyEMU (wasi-sdk); other architectures need extra QEMU emulation and are slow; `--to-js` uses QEMU-Wasm with JIT in the browser: https://raw.githubusercontent.com/container2wasm/container2wasm/main/README.md
- **Nixpkgs/NixOS:** no example found. The input is an OCI container image, so a nixpkgs-built image (for example from `dockerTools`) is a possible input, but no documented case was found. Not tested here.
- **Performance:** README says non-native-architecture containers are "slow because of additional emulation": https://raw.githubusercontent.com/container2wasm/container2wasm/main/README.md . Bochs and TinyEMU are interpreters; no JIT is documented for those two backends. Multi-core: not documented. `--to-js` carries the QEMU-Wasm properties below.
- **Networking:** (1) in-browser stack `c2w-net-proxy` (gvisor-tap-vsock based) forwarding HTTP/HTTPS through the Fetch API (CORS applies); (2) WebSocket to a host-side `c2w-net` (Linux-tested); (3) `sock_*` for WASI runtimes: same README.
- **Disk/FS:** WASI filesystem maps host directories into the guest via virtio-9p: same README. No OPFS/IndexedDB persistence documented there.
- **Licence:** c2w Apache-2.0; generated images bundle GPL v2 (Linux, GRUB), LGPL v2.1 (Bochs), MIT (TinyEMU, tini), Apache-2.0 components: same README.
- **Health:** v0.8.4 on 2026-03-16 (LLM-in-browser example), v0.8.3 2025-07-28, v0.8.2 2025-05-21 (QEMU-Wasm fix for Firefox 138): https://github.com/container2wasm/container2wasm/releases

## QEMU compiled to wasm (qemu-wasm by ktock)

- **Guest arch:** x86_64, AArch64, RISCV64; examples include x86_64, x86_64-alpine, riscv64, raspi3ap (emulated Raspberry Pi), networking, virtfs, migration: https://raw.githubusercontent.com/ktock/qemu-wasm/master/examples/README.md and https://raw.githubusercontent.com/ktock/qemu-wasm/master/README.md
- **JIT / cores:** "each TB is translated to a Wasm module"; hybrid mode runs translation blocks in the TCI interpreter and compiles only blocks that run many times (README says e.g. 1000; the FOSDEM slides say e.g. 1500) because browsers cannot create thousands of modules cheaply. Multi-Threaded TCG via emscripten pthreads. README labels it experimental. https://raw.githubusercontent.com/ktock/qemu-wasm/master/README.md , https://archive.fosdem.org/2025/events/attachments/fosdem-2025-6290-running-qemu-inside-browser/slides/238760/slides_1dDtpcS.pdf
- **Performance:** slides state "Still slower than other backends. Further improvement is needed"; one benchmark (pigz compressing 10 MB) is shown only as a graph versus a Bochs port, no numbers extractable: slides above. Real-world measurements from trynix (below).
- **Upstreaming:** TCI for 32-bit guests upstreamed in QEMU 10.1; TCI for 64-bit guests and TCG (JIT) mode "under discussion": README above.
- **Networking:** WebSocket to a host-side network stack, or an in-browser stack proxying HTTP(S) over Fetch ("HTTP(S) only", "limited destination by CORS"): slides above.
- **Disk/FS:** QEMU virtfs (9p) shared between JS and guest; migration of a native-QEMU VM snapshot into the browser: examples README above. OPFS/IndexedDB persistence: not found.
- **Requirements:** slides report testing on Chrome 130; trynix reports a fixed ~2.41 GB wasm memory (below).
- **Licence:** GPL and LGPL (repo carries COPYING and COPYING.LIB): https://github.com/ktock/qemu-wasm
- **Health:** no GitHub releases; most recent commits seen are 2025-09-04 (docs) and 2025-08-27: https://github.com/ktock/qemu-wasm/commits (fetched view). Used by c2w v0.8.2 (May 2025) and by trynix (Sept 2026).

### Concrete nixpkgs example: trynix

- trynix (Farid Zakaria, post dated 2026-09-04) runs an x86_64 Linux kernel in the browser on qemu-wasm; the guest is "a trimmed Linux kernel and a busybox initramfs" built with Nix flakes, not a full NixOS system. https://fzakaria.com/2026/09/04/any-nix-package-live-in-your-browser , https://github.com/fzakaria/trynix , https://simonwillison.net/2026/sep/10/trynix
- Boot: the VM is booted once on native QEMU of the same build and snapshotted just before mounting the store; the browser resumes from that migration snapshot. Reported "about three seconds" to a shell on a warm cache in the README; the blog reports about 7.5 s first visit and 1.5 s revisit. https://github.com/fzakaria/trynix , https://fzakaria.com/2026/09/04/any-nix-package-live-in-your-browser
- Store: closure fetched from cache.nixos.org (and other CORS-enabled caches), each NAR decompressed into an in-memory filesystem exposed through virtio-9p. https://github.com/fzakaria/trynix
- Limits from its performance notes: one vCPU; fixed ~2.41 GB wasm memory with no growth (512 MiB guest RAM, 500 MiB TCG code buffer, ~1.2 GB left for the unpacked closure); cold binary run about 2.5 s versus about 1 s warm; in a cold run the interpreter and translator dominate. Devices that cannot grant the reservation get no VM. https://raw.githubusercontent.com/fzakaria/trynix/main/docs/performance.md
- Networking: no guest networking documented. Licence: MIT. 74 commits at time of reading. https://github.com/fzakaria/trynix

## CheerpX / WebVM (Leaning Technologies)

- **Guest arch:** "a two-tier emulator for the x86 architecture" with an interpreter and an x86-to-WebAssembly JIT; WebVM README: x86 only. 32-bit versus 64-bit: **not stated in the docs reached**. https://cheerpx.io/docs/overview , https://github.com/leaningtech/webvm
- **Kernel model:** WebVM README lists "Linux syscall emulator" as a component, i.e. it runs Linux userspace binaries against emulated syscalls rather than booting a kernel image. https://github.com/leaningtech/webvm . (So it is not a full-boot environment in the sense of the ticket; stated for classification only.)
- **Nixpkgs/NixOS:** no example found. WebVM images are ext2 disks built from Dockerfiles (Debian by default): https://github.com/leaningtech/webvm
- **Performance/cores:** JIT for hot code including self-modifying code: https://cheerpx.io/docs/overview . No benchmark or multi-core statement found. Requires SharedArrayBuffer, so cross-origin isolation (COOP/COEP headers): https://cheerpx.io/docs/getting-started
- **Networking:** via Tailscale (WireGuard VPN tunnelled over WebSocket); an exit node is needed only for internet access; ICMP/ping unavailable: https://cheerpx.io/docs/guides/Networking , https://github.com/leaningtech/webvm
- **Disk/FS:** `HttpBytesDevice` (read-only ext2 over HTTP), `IDBDevice` (read-write, IndexedDB), `OverlayDevice` (combines the two for a persistent writable disk), `DataDevice` (in-memory), `WebDevice`. OPFS and 9p not mentioned: https://cheerpx.io/docs/guides/File-System-support
- **Licence:** the webvm repo is Apache-2.0, but the CheerpX runtime is loaded as a binary from Leaning's CDN (docs show `cxrtnc.leaningtech.com/1.2.8/cx.esm.js`) and its terms are a free Community License for individuals, FOSS projects and technical evaluation; multi-person companies, internal apps, OEM and self-hosting need a commercial licence. https://cheerpx.io/docs/licensing , https://cheerpx.io/docs/getting-started , https://github.com/leaningtech/webvm
- **Health:** WebVM 2.0 (Xorg/KMS, IndexedDB storage, Tailscale) announced late 2024: https://labs.leaningtech.com/blog/webvm-20 ; repo had 525 commits and 12 open issues when read: https://github.com/leaningtech/webvm . Release dates for CheerpX beyond the pinned 1.2.8 CDN path: not found.

## TinyEMU / JSLinux (Fabrice Bellard)

- **Guest arch:** RISC-V (RV32/RV64/RV128) and x86; a JavaScript/wasm build runs Linux in the browser. https://bellard.org/tinyemu/ , https://bellard.org/jslinux/tech.html
- **Nixpkgs/NixOS:** no example found. Context: riscv64 is unofficial in nixpkgs (see above).
- **Performance:** the only figure on the tech page is the x86 emulator at "about 100 MIPS" on a 2017 desktop PC with Firefox; the page does not describe a JIT, and SMP is not mentioned. https://bellard.org/jslinux/tech.html
- **Networking:** a websocket VPN service, capped at 40 kB/s with limited connections per IP, per the tech page. https://bellard.org/jslinux/tech.html
- **Disk/FS:** VirtIO 9P and VirtIO block device (remote, fetched over HTTP): https://bellard.org/jslinux/tech.html , https://bellard.org/tinyemu/ . No OPFS/IndexedDB persistence documented.
- **Licence:** MIT. **Health:** latest TinyEMU release dated 2019-12-21: https://bellard.org/tinyemu/ . TinyEMU is also the RISC-V backend inside container2wasm (above).

## Newer / different approach: Linux kernel compiled to wasm (linux-wasm)

- Joel Severin's port compiles the Linux kernel itself to WebAssembly, with no CPU emulation; announced 2025-11-01 as a demonstration that "crashes" in some browsers, Chrome included. https://phoronix.com/news/Linux-Kernel-WebAssembly , https://github.com/joelseverin/linux-wasm
- Repo: kernel 7.0 ported to wasm32_nommu and wasm64_nommu, LLVM 18.1.2, musl 1.2.5 and BusyBox 1.36.1 userland; MMU support, ELF support, and drivers (virtio, WASI) listed as future work. https://github.com/joelseverin/linux-wasm
- Consequence stated by the repo's own feature list: no ELF loader or MMU yet, so existing ELF userland (including nixpkgs binaries) is not runnable as-is. nixpkgs has no wasm-Linux target in the sources read; not investigated further.

## Which guest architecture can share one image between native and browser

Findings only, from the sources above.

1. **x86_64.** nixpkgs/NixOS' primary architecture with an official cache and ISO (https://nixos.org/download/). Browser-capable engines: qemu-wasm (x86_64 supported, JIT, MTTCG) and container2wasm via Bochs (interpreter). trynix demonstrates a nixpkgs-built x86_64 kernel plus busybox initramfs and nix-store closure on qemu-wasm, and the snapshot is produced by native QEMU of the same build (https://github.com/fzakaria/trynix). Trade-offs observed: wasm memory is fixed (~2.41 GB in trynix), TCG JIT is not upstream in QEMU, cold-run speed is dominated by interpreter and translation.
2. **AArch64.** Also an official NixOS ISO architecture (https://nixos.org/download/) and supported by qemu-wasm (https://raw.githubusercontent.com/ktock/qemu-wasm/master/README.md). c2w mentions an aarch64 Safari stack fix in v0.8.3 (https://github.com/container2wasm/container2wasm/releases). No nixpkgs-on-browser example found. A native AArch64 image would also run natively on Apple Silicon and ARM Linux hosts without emulation, which is relevant to the map's all-platforms goal but was not researched here.
3. **riscv64.** Supported by TinyEMU, container2wasm (TinyEMU backend) and qemu-wasm. nixpkgs support is unofficial with no official binary cache and reported QEMU segfaults (https://wiki.nixos.org/wiki/RISC-V , https://discourse.nixos.org/t/binary-cache-for-riscv64/44934). Native hosts on riscv64 hardware are not mainstream; native use would itself be emulated or niche.
4. **i686 (32-bit x86).** The only arch v86 runs; NixOS no longer ships 32-bit images or caches (https://discourse.nixos.org/t/limited-cache-availability-for-i686-32-bits-x86-architecture/37626). Native machine and browser could share an image only if the native image is also i686.
5. **wasm-native Linux.** Does not share an ELF image with a native machine (different kernel arch and nommu; https://github.com/joelseverin/linux-wasm).

Cross-cutting facts: all browser engines emulate or translate, so the browser guest is slower than native for the same arch (qemu-wasm slides call it slower than other backends: see link above); only an engine whose guest arch equals the native host arch lets native run without emulation. Browser networking from a tab is limited to HTTP(S) via Fetch under CORS, or to WebSocket/Tailscale tunnels through a server, in every candidate. OPFS-backed persistence was not documented by any candidate's primary sources; CheerpX documents IndexedDB, v86/c2w/qemu-wasm/TinyEMU document 9p/virtio with in-memory or HTTP-fetched backing.

## Gaps and not found

- No primary-source example of a full NixOS system (systemd, stage-2) booting on any candidate. trynix is the only nixpkgs-built guest found and it is a custom busybox initramfs.
- CheerpX x86 bitness, SMP, and kernel model beyond "syscall emulator": not stated in docs reached.
- Quantitative performance versus native: none found in primary sources except trynix timings.
- Multi-core status for Bochs and TinyEMU: not documented in sources reached.
- Last-commit dates for v86 and linux-wasm: not retrievable (robots.txt); npm release date used for v86.

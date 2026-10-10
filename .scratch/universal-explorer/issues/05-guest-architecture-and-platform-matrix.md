# Guest architecture and platform matrix

Type: grilling
Status: claimed
Blocked by: 02, 03

## Question

Which guest architecture(s) does machine get built for, and what runs where?
- one arch everywhere (emulated on some hosts)
- native arch per host plus a separate browser arch, from the same nixpkgs
- something else

This also covers which host gets which VM technology for the PoC.

## Progress (grilling round 1, 2026-10-10)

Settled:
- Browser guest arch: x86_64 first (proven via trynix); aarch64 not ruled out.
- One kernel config with both virtio-9p and virtio-fs; how datacombs are served is left to "Where the datacomb engine runs".
- First host: **the browser**. Native host: **Asahi Linux** (aarch64, Apple Silicon, KVM).
- First iteration only needs to run Hermes, not arbitrary nixpkgs.

Open, waiting on research: "one definition, per-arch builds" vs **wasm everywhere** (run the same wasm artifact natively too). How much performance does Hermes actually need, and how much does wasm emulation cost compared with KVM on Asahi?

Findings for the wasm question: branch `research/wasm-everywhere`, `docs/research/wasm-everywhere.md`. User reaction: the slowdown is acceptable for a harness, given a native escape hatch (copy files out, build locally) and the fact that we control the harness's whole environment, which is where gfs fits.

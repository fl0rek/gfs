# Wasm everywhere: performance cost for Hermes

Source: Claude extended-research run, 2026-10-10, for the "Guest architecture and platform matrix" ticket. These are condensed findings. **(m)** marks a measurement, **(e)** an estimate, and **(v)** a vendor claim.

## Slowdowns

- **Plain wasm vs native:** 1.3–1.55× (m). Jangda et al., USENIX ATC 2019: https://arxiv.org/pdf/1901.09056
- **QEMU TCG vs hardware acceleration:** 8× for an x86-64 guest, 12× for an aarch64 guest (m). Linaro: https://www.linaro.org/blog/qemu-a-tale-of-performance-analysis/
- **v86 vs QEMU TCG:** 1.7–4.1× slower (m). Combined with the TCG figure, roughly 15–35× slower than KVM (e). https://github.com/copy/v86/pull/388
- **CheerpX:** 5–10× slower than native, 2–3× at best, 32-bit x86 only (v). https://labs.leaningtech.com/blog/cx-10
- **qemu-wasm:** no published number against native or KVM. Translation blocks run interpreted (TCI) until warm, so fork/exec-heavy work is worst. **Measure this ourselves.**
- **Running natively outside a browser:** JIT emulators (qemu-wasm, v86, CheerpX) need a JS host such as Node or Deno, because they generate wasm modules at runtime. Under wasmtime or wasmer only interpreters run (Bochs, TinyEMU, TCI).

## Hermes as wasm without a VM

- **CPython on WASI:** wasip1 is Tier 2 since Python 3.13. WASI has no process creation, even in 0.3 (released June 2026), so `subprocess` is impossible. https://peps.python.org/pep-0011/ and https://wasi.dev/releases/wasi-p3
- **Pyodide:** no threads, subprocess or sockets. https://pyodide.org/en/stable/usage/wasm-constraints.html
- **WASIX/Wasmer:**
  - Provides fork/exec, threads and sockets.
  - CPython 3.12 WASIX has fixes for asyncio, sqlite and subprocess. https://wasmer.io/wasmer/python@3.12.5+build.7
  - bash, coreutils and Python run unchanged in a browser, with subprocess working. https://github.com/ai-ecoverse/slicc/pull/3649
  - git, sqlite, curl and ripgrep are packaged, plus "wasinix" (Nix-based).
  - The same binaries run in Wasmer natively and in the browser. WASIX is non-standard.
- **BrowserPod (Leaning Technologies):** a wasm-native kernel with Linux syscalls, one Web Worker per process, and binaries built from source with Nix. It runs Claude Code unmodified, but is proprietary and browser-only. https://browserpod.io/blog/browserpod-deep-dive/

## How much performance Hermes needs

Tool execution is 13–48% of Hermes's end-to-end latency, peaking on Terminal-Bench 2, measured with a fast local model (m). https://arxiv.org/pdf/2607.29069 Another study puts LLM time at 71–98% of runtime (m). https://arxiv.org/pdf/2605.26297

Task stretch factor (e), where f is the share of time spent in tools:

| f | 5× | 10× | 30× |
|---|---|---|---|
| 5% | 1.2 | 1.45 | 2.45 |
| 18% | 1.7 | 2.6 | 6.2 |
| 48% | 2.9 | 5.3 | 14.9 |

## Browser constraints (every option)

- **Memory:** 4 GB wasm32 limit. Memory64 is in Chrome 133 and Firefox 134 but not Safari (reported), and can cost 10–100% in speed. https://spidermonkey.dev/blog/2025/01/15/is-memory64-actually-worth-using.html
- **Threads:** need SharedArrayBuffer, which needs COOP/COEP headers.
- **Networking:** no raw TCP from a tab, so a WebSocket relay is required, e.g. Wisp with TLS in wasm (epoxy-tls). https://github.com/wasix-org/epoxy-tls
- **Storage:** OPFS sync handles are Worker-only. SQLite's `opfs-sahpool` VFS is the fastest option, at about 3× slower than native. https://sqlite.org/wasm/doc/trunk/persistence.md

## Integration seam

Hermes supports third-party terminal-backend plugins (`kind: backend`). https://hermes-agent.nousresearch.com/docs/developer-guide/terminal-environment-plugin

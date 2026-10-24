# machine tier prototype: build notes

Throwaway. A Nix flake that builds WASIX wasm modules with stock nixpkgs LLVM
20 + binaryen and the prebuilt wasix-libc sysroot, no wasix-org LLVM fork.
Chronological; each section says what worked, what failed, and how long.

Environment: 2 cores, 7 GB, Nix 2.34 single-user, nixpkgs-unstable
5adc5083 (2026-10-20) from the local store. Nix fetched LLVM/lld/binaryen
from cache.nixos.org; nothing native was compiled.

## 1. Toolchain (`wasix.nix`) and `hello` — ~40 min

Approach: a cc-wrapper-style shell script `wasm32-wasi-clang` around
`llvmPackages_20.clang-unwrapped`, with lld via `-fuse-ld=lld -B<lld>/bin`
and binaryen called by absolute path after every link. Flags are copied from
wasixcc `src/compiler.rs` (compile_inputs / build_link_args / run_wasm_opt)
and recorded as lists at the top of `wasix.nix`. Differences from wasixcc:

- The link goes through the clang driver with `-nostdlib`, and the wasm-ld
  flags are forwarded as `-Wl,`; wasixcc calls wasm-ld directly. Same flags,
  same order (user inputs, then the sysroot libs, then `crt1.o`).
- wasixcc's current default is exnref wasm exceptions
  (`WASM_EXCEPTIONS` unset -> `Exnref`, sysroot-exnref-eh). We default to the
  asyncify mode (`sysroot.tar.gz`, `-fno-exceptions`, `wasm-opt --asyncify`)
  as briefed, because Node 22's V8 has no exnref. `mode = "eh"` is wired but
  not exercised (its sysroot hash is empty).
- wasixcc also adds `-msimd128 -mrelaxed-simd -mextended-const`
  (DEFAULT_WASM_CLANG_FLAGS). Left out: not needed and one less thing the
  SDK's engine must support.
- `--no-wasm-opt` is passed to clang at link, and binaryen is deliberately
  not on PATH: clang's wasm driver otherwise runs `wasm-opt -O` itself on
  the output when it finds one.

Two things bit:

1. The native `stdenv.cc` setup hook unconditionally exports `CC=gcc`, so the
   first hello.wasm was an x86-64 ELF. Fixed with a setup hook in the
   toolchain package that is listed *last* in `nativeBuildInputs` and
   re-exports `CC`/`AR`/... (keeping the native one as `CC_FOR_BUILD`).
2. `stddef.h` not found: nixpkgs puts clang's resource dir in the `lib`
   output, so the wrapper passes `-resource-dir=${clang.lib}/lib/clang/20`.

Result: `hello.wasm` 87 KB (-O2, asyncify), runs under `@wasmer/sdk` 0.19.1
in Node 22: stdio, argv, a pthread, exit code 3 on request. The runner is
`<scratchpad>/machine-work/run.mjs`.

Sysroot: `v2026-07-03.1/sysroot.tar.gz`,
sha256 32dfb61abd7dd5e84f3da67917ff8b2221e0b2aecfc53929a329f82b6db37a3c
(`sha256-Mt+2Gr191ehPPaZ5F/+LIiHgsq7PxTkpoyn4K22zejw=`).

Nix quirk in this container: `github:`/`fetchFromGitHub` URLs that go via
api.github.com or github.com/.../archive are 403 through the proxy (only
git clone and release downloads pass), so nixpkgs is pinned by its
releases.nixos.org tarball + narHash in `flake.lock`, and the bash source was
pre-seeded into the store with `nix store add-path --name source` from a
`git archive` export (same hash as fetchFromGitHub produces). On a normal
machine `nix build` fetches both itself.

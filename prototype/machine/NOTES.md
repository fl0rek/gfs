# machine tier prototype: build notes

Throwaway. A Nix flake that builds WASIX wasm modules with stock nixpkgs LLVM
20 + binaryen and the prebuilt wasix-libc sysroot, no wasix-org LLVM fork.
Chronological; each section says what worked, what failed, and how long.

```
nix build .#machine          # result/bin/*.wasm + result/manifest.json
node test/smoke.mjs result   # runs everything under @wasmer/sdk in Node
```

Environment: 2 cores, 7 GB, Nix 2.34 single-user, nixpkgs-unstable
5adc5083 (2026-10-20) from the local store. Nix fetched LLVM/lld/binaryen
from cache.nixos.org; nothing native was compiled. Whole session ~2h40.

## Status

| package   | version | module(s)                     | size    | SDK test |
|-----------|---------|-------------------------------|---------|----------|
| hello     | -       | hello.wasm                    | 86 KB   | ok: stdio, argv, pthread, exit code |
| bash      | wasix-org fork `wasix-compat` fc80964 (dist.16) | bash.wasm (`bash`, `sh`) | 1.9 MB | ok: pipes, subshells, `$(..)`, heredocs, arrays, `read` loops, exit codes, stdin scripts, spawning other modules |
| grep      | 3.12    | grep.wasm                     | 1.2 MB  | ok: files, pipes, `-r`, `-E`, `-c`, `-v`, `-o` |
| sed       | 4.10    | sed.wasm                      | 1.0 MB  | ok: pipes, `-n`, `-i`, multiple `-e` |
| gawk      | 5.4.1   | gawk.wasm (`gawk`, `awk`)     | 3.6 MB  | ok: fields, math, string fns, `"cmd" \| getline` (via `sh`) |
| findutils | 4.11.0  | find.wasm, xargs.wasm         | 1.7 + 0.5 MB | ok: `-type -name -maxdepth -exec {} +`, `-print0 \| xargs -0` |
| diffutils | 3.12    | diff, cmp, diff3, sdiff .wasm | 1.1 + 0.3 + 0.3 + 0.3 MB | ok: normal/unified diff, stdin `-`, exit codes, cmp |
| coreutils | 9.12    | coreutils.wasm (multi-call, 97 names) | 6.0 MB | ok: ls cat sort uniq wc cp mv rm -r mkdir seq tail tr cut sha256sum date env pwd touch ln -s tee basename dirname du ... |

Total `bin/`: 18 MB. `nix flake check` passes (the checks are the packages).
Everything runs under `@wasmer/sdk` 0.19.1 in Node 22 as raw modules in one
`packages.create({modules, commands})` package; bash finds the others as
`/usr/bin/<cmd>` (the SDK sets argv[0] to the command name, which is what
the coreutils multi-call binary dispatches on).

Not built: stat, df (need `statfs()`, absent from wasi-libc), stdbuf (needs a
shared library), chroot, nice, pinky, who/users/uptime (no utmp), locate
(no updatedb).

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
  not exercised (its sysroot hash is empty). Nothing needed the EH mode.
- wasixcc also adds `-msimd128 -mrelaxed-simd -mextended-const`
  (DEFAULT_WASM_CLANG_FLAGS). Left out: not needed and one less thing the
  SDK's engine must support.
- `--no-wasm-opt` is passed to clang at link, and binaryen is deliberately
  not on PATH: clang's wasm driver otherwise runs `wasm-opt -O` itself on
  the output when it finds one.
- `-g` on the link line makes wasm-opt keep the name section (`-g`), like
  wasixcc; otherwise stack traces from the SDK are bare indices.

Two things bit:

1. The native `stdenv.cc` setup hook unconditionally exports `CC=gcc`, so the
   first hello.wasm was an x86-64 ELF. Fixed with a setup hook in the
   toolchain package that is listed *last* in `nativeBuildInputs` and
   re-exports `CC`/`AR`/... (keeping the native one as `CC_FOR_BUILD`).
2. `stddef.h` not found: nixpkgs puts clang's resource dir in the `lib`
   output, so the wrapper passes `-resource-dir=${clang.lib}/lib/clang/20`.

Sysroot: `v2026-07-03.1/sysroot.tar.gz`,
sha256 32dfb61abd7dd5e84f3da67917ff8b2221e0b2aecfc53929a329f82b6db37a3c
(`sha256-Mt+2Gr191ehPPaZ5F/+LIiHgsq7PxTkpoyn4K22zejw=`).

Nix quirk in this container: `github:` flake refs and `fetchFromGitHub`
(api.github.com, github.com/.../archive) are 403 through the proxy; only git
clones and release downloads pass. So nixpkgs is pinned by its
releases.nixos.org tarball + narHash in `flake.lock`, and the bash source was
pre-seeded into the store with `nix store add-path --name source` from a
`git archive` export (same hash fetchFromGitHub produces). On a normal
machine `nix build` fetches both itself. Also: the flake has to be built as
`nix build path:$PWD#...` until the files are tracked by git.

## 2. bash — ~35 min

The fork (wasix-org/bash, `wasix-compat`, "Release 1.0.25", `wasmer.toml`
says it is `wasmer/bash` 1.0.25 depending on `wasmer/coreutils`) has no
configure; `config.h` and `builtins/*.c` are pre-generated and a hand-written
`Makefile` (+ sub-Makefiles in builtins/, lib/{sh,glob,readline,termcap})
hardcodes `CC=clang-19`, `--target=wasm32-wasmer-wasi`, `--sysroot
../wasix-libc/sysroot32`, `-Werror`, and links with `-flto -g` then
`wasm-opt -O2 --asyncify --fpcast-emu`. `build-wasi.sh` is a stub.
`pkgs/bash.nix` seds those four things out of the Makefiles, runs their
object targets with `make -j`, and links with our wrapper (`-O2`, no LTO, no
`-g`). Stock clang 20 compiled everything with no source changes
(`-Werror` dropped; no new warnings turned up anyway). 27 s.

First run: `bash --version` fine, every `bash -c` died with
`RuntimeError: null function or function signature mismatch`. A `-g` build
put it in `unwind_frame_run_internal` (unwind_prot.c): bash registers
cleanup functions of assorted C signatures (`void(void)`, `void(int)`,
`void(char*)`) and calls them all through one `void (*)(void *)` pointer.
Harmless natively, a trap in wasm. That is what the fork's `--fpcast-emu`
is for, so bash gets `WASIX_WASM_OPT_FLAGS=--fpcast-emu` (binaryen rewrites
every indirect call through a signature-normalising thunk). With it, all of
the briefed tests pass; no other tool needed it.

`--version` reports `GNU bash, version dist.16(1) (wasm32-nix-wasix)`: the
vendor/OS/machtype make vars are overridden so our build is told apart from
Wasmer's `(wasm32-wasmer-wasi)`.

## 3. machine + smoke test — ~15 min

`pkgs/machine.nix` symlinks every userland `bin/*.wasm` and writes
`manifest.json` (`commands`, `sysroot`, `toolchain`, `built`) from each
package's `passthru.commands` (default: its own name). `test/smoke.mjs` loads
such a directory into one SDK package and runs the tests in the table.

## 4. GNU tools via autotools (`pkgs/gnu.nix`) — ~75 min for all six

`./configure --host=wasm32-wasi --build=<native> --disable-nls` with
`CC=wasm32-wasi-clang` works as a cross build. Issues, all generic, all fixed
in `gnu.nix` once (grep took the hits, the rest mostly just built):

- gnulib `opendirat(int, char const *, int, int *)` vs wasi-libc's own
  2-argument `opendirat()` in `<dirent.h>`: gnulib's is renamed with sed
  in every `.c/.h` that mentions it (grep, findutils, coreutils use fts).
- `gnulib-tests/` is in `SUBDIRS` and hits `#error "Please port gnulib
  getlocalename_l-unsafe.c"`; removed from SUBDIRS (we never run tests).
  findutils has the same file in its real lib: its musl branch
  (`nl_langinfo_l (NL_LOCALE_NAME (category))`, which wasi-libc supports) is
  gated on `__linux__`; sed adds `|| defined __wasi__`.
- gnulib `mountlist.c`: `#error` when no method applies; replaced with an
  empty mount list (`find -fstype` and `df` need it).
- Cross-compile *guesses* that were wrong for WASIX and are overridden via
  configure cache variables (verified with probes under the SDK):
  `ac_cv_type_getgroups=gid_t` (guess `int` -> gnulib stub conflicts with
  the prototype), `gl_cv_func_open_directory_works=yes` (guess no -> gnulib
  never registers directory fds, its fchdir emulation fails, and find prints
  "Failed to restore initial working directory: Not a directory" after every
  run), `gl_cv_func_fdopendir_works=yes`, `gl_cv_func_getcwd_null=yes`,
  `gl_cv_func_getcwd_path_max=yes`, `gl_cv_struct_dirent_d_ino=yes`,
  `gl_cv_func_strcasecmp_works=yes` (diffutils' configure aborts without a
  guess for it).
- coreutils: `--enable-single-binary=symlinks` gives one 6 MB module. Every
  program is still compiled even when excluded from install, so the four
  that cannot be (stat/df: `struct statfs`; nice: `getpriority`; chroot: no
  prototype; pinky: utmp) are replaced by one-line stubs in postPatch. The
  command list in `flake.nix` is what its configure chose to build.
- Installed shell-script wrappers (egrep, fgrep) and the versioned
  `gawk-5.4.1` copy are dropped; `bin/<name>` files that start with `\0asm`
  become `bin/<name>.wasm`.

Build times on 2 cores: grep 1m10, sed 1m20, gawk 0m40, findutils 1m55,
diffutils 1m25, coreutils 3m05.

## 5. Runtime quirks of the Wasmer JS SDK (`compat/wasix-quirks.c`)

Found while testing, confirmed with small probes run as `bash -c 'printf x
| probe'` under the SDK, and papered over in a shim linked into every
executable with `wasm-ld --wrap` (so libc-internal callers are covered too):

1. `lseek()` on a pipe fails with **EACCES** instead of ESPIPE. GNU grep's
   `reset()` treats any lseek error on stdin other than ESPIPE as fatal, so
   `printf .. | grep ..` died with "(standard input): Permission denied"
   while `grep .. < file` worked (also seen by the coordinator in Chrome).
   The shim maps EACCES -> ESPIPE when `fstat` says the fd is not a regular
   file. wasi-libc's `<unistd.h>` turns `lseek(fd, 0, SEEK_CUR)` into
   `__wasilibc_tell(fd)` with a macro, so that symbol is wrapped too.
2. `fstat()` on a pipe returns `st_mode == 0` (no type bits). The shim sets
   `S_IFIFO` when the type field is empty.
3. `program_invocation_name` / `__progname` stay NULL (wasi-libc's startup
   never sets them), so gnulib's `getprogname()` printed `(null):` in every
   error message. The shim wraps `__main_argc_argv` (clang's name for the
   user's `main`; libc's `__main_void` calls it with argv in hand) and sets
   all four variables from `argv[0]`.

Seen but not shimmed: `getcwd(buf, 4)` writes "/tmp" plus NUL into a
4-byte buffer and returns success instead of ERANGE (no caller hit it, but
it is a buffer overflow waiting for a long cwd); `ls -l` shows `----------`
because the runtime reports no permission bits. `WASIX_NO_QUIRKS=1` links
without the shim.

## Open problems

- The shim is a workaround for runtime behaviour; the right fix is in
  Wasmer (`fd_seek` on pipes, `fd_filestat_get` filetype) or wasix-libc
  (`program_invocation_name`). Whether native `wasmer run` shows the same
  was not checked (the native CLI was not installed).
- `--fpcast-emu` on bash costs indirect-call overhead; the alternative is
  patching bash's unwind_protect registrations to uniform signatures.
- LTO (`-flto`, which the fork uses) was not tried; modules are a bit larger
  than Wasmer's. `-Oz` + `--strip` would shrink further.
- The EH mode (`mode = "eh"`, sysroot-eh) is wired but untested; its hash is
  empty. Asyncify was enough for everything here.
- No `sysroot-eh`/C++ support, no pcre2 (grep `-P` disabled), no gettext.
- The bash source is pinned by `fetchFromGitHub`; in this container that URL
  is 403 and the store had to be pre-seeded (see section 1).
- `nix flake check` only covers x86_64-linux here; the other systems in
  `systems` are declared but unbuilt (the toolchain is pure nixpkgs, so they
  should work).

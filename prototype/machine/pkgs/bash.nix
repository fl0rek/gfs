# PROTOTYPE. GNU bash for WASIX, from the wasix-org fork (branch
# wasix-compat), which is what the Wasmer registry's `wasmer/bash` is built
# from. The fork ships a hand-written Makefile (no configure; config.h and the
# builtins/*.c are pre-generated) that hardcodes clang-19 + the wasix-org LLVM
# triple wasm32-wasmer-wasi and `--sysroot ../wasix-libc/sysroot32`. We keep
# its object list and CFLAGS, strip the toolchain-specific bits, and do the
# final link through our wrapper (which already runs wasm-opt --asyncify, so
# the Makefile's own `shell:` link+wasm-opt rule is not used).
{ wasix, pkgs, bash }:
wasix.mkDerivation {
  pname = "bash-wasix";
  version = "5.2-dist.16-wasix-compat";   # version.c says dist.16; fork release 1.0.25
  src = bash;

  dontConfigure = true;
  enableParallelBuilding = true;

  postPatch = ''
    for m in Makefile builtins/Makefile lib/sh/Makefile lib/glob/Makefile \
             lib/readline/Makefile lib/termcap/Makefile lib/malloc/Makefile; do
      [ -f "$m" ] || continue
      sed -i \
        -e '/^CC=clang-19/d' \
        -e '/^LLD_PATH=/d' \
        -e '/^export PATH :=/d' \
        -e 's|--target=wasm32-wasmer-wasi||' \
        -e 's|--sysroot [^ ]*||' \
        -e '/^ *-Werror \\$/d' \
        "$m"
    done
    # expose the object list to the build phase
    printf 'print-objs: ; @echo $(OBJS)\n' >> Makefile
  '';

  # make vars override the `=` assignments in the fork's Makefiles, incl. in
  # the sub-makes (command-line overrides travel through MAKEFLAGS).
  makeFlags = [
    "CC=wasm32-wasi-clang"
    "VENDOR=nix"
    "OS=wasix"
    "MACHTYPE=wasm32-nix-wasix"
  ];

  buildPhase = ''
    runHook preBuild
    local mf=( ''${makeFlags[@]} )
    # the fork's sub-makes (builtins/, lib/{sh,glob,readline,termcap}) and the
    # top-level objects, in parallel
    make -j$NIX_BUILD_CORES "''${mf[@]}" sh builtins glob readline termcap
    objs=$(make -s "''${mf[@]}" print-objs)
    make -j$NIX_BUILD_CORES "''${mf[@]}" $objs shell.o
    # link: the fork links with -flto -g, then `wasm-opt -O2 --asyncify
    # --fpcast-emu`. The wrapper does `--asyncify -O2`; --fpcast-emu is
    # required: bash's unwind_protect calls cleanup functions of assorted C
    # signatures through one `void (*)(void *)` pointer, which traps in wasm
    # ("null function or function signature mismatch" in
    # unwind_frame_run_internal, hit by any `bash -c`). See NOTES.md.
    WASIX_CC_VERBOSE=1 WASIX_WASM_OPT_FLAGS=--fpcast-emu $CC -O2 -o bash.wasm shell.o $objs
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    mkdir -p $out/bin
    cp bash.wasm $out/bin/bash.wasm
    runHook postInstall
  '';

  passthru.commands = { bash = "bash.wasm"; sh = "bash.wasm"; };
}

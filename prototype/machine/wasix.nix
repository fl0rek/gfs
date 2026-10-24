# PROTOTYPE. A WASIX cross toolchain from stock nixpkgs LLVM + binaryen + the
# prebuilt wasix-libc sysroot. Mirrors what wasixcc (wasix-org/wasixcc,
# src/compiler.rs) does, as a cc-wrapper-style shell script, so that plain
# `./configure --host=wasm32-wasi CC=wasm32-wasi-clang` works.
#
# Returns an attribute set:
#   sysroot        the unpacked sysroot (include/, lib/wasm32-wasi/, share/)
#   cc             the wrapper package: bin/wasm32-wasi-{clang,cc,gcc,ar,ranlib,nm,strip,objdump}
#   mkDerivation   stdenvNoCC.mkDerivation with the toolchain wired in
#   stdenv         the same thing as a (NoCC) stdenv, for overrideAttrs users
{ pkgs
, llvmPackages ? pkgs.llvmPackages_20
, # "asyncify" (default; setjmp/longjmp via binaryen --asyncify, sysroot.tar.gz)
  # or "eh" (wasm exceptions + sjlj lowering, needs sysroot-eh.tar.gz).
  mode ? "asyncify"
}:
let
  inherit (pkgs) lib;

  sysrootRelease = "v2026-07-03.1";
  sysrootSources = {
    asyncify = {
      name = "sysroot.tar.gz";
      hash = "sha256-Mt+2Gr191ehPPaZ5F/+LIiHgsq7PxTkpoyn4K22zejw=";
    };
    eh = {
      name = "sysroot-eh.tar.gz";
      # filled in when/if the eh mode is exercised; nix will print the right one.
      hash = "";
    };
  };

  sysroot = pkgs.stdenvNoCC.mkDerivation {
    pname = "wasix-sysroot-${mode}";
    version = sysrootRelease;
    src = pkgs.fetchurl {
      url = "https://github.com/wasix-org/wasix-libc/releases/download/${sysrootRelease}/${sysrootSources.${mode}.name}";
      hash = sysrootSources.${mode}.hash;
    };
    # tarball root is wasix-sysroot/sysroot/{include,lib,share}
    sourceRoot = "wasix-sysroot/sysroot";
    dontBuild = true;
    dontFixup = true;
    installPhase = ''
      mkdir -p $out
      cp -r include lib share $out/
    '';
  };

  clang = llvmPackages.clang-unwrapped;
  lld = llvmPackages.lld;
  llvm = llvmPackages.llvm;        # llvm-ar, llvm-nm, ...
  binaryen = pkgs.binaryen;

  target = "wasm32-wasi";

  # ---- flags, verbatim from wasixcc -------------------------------------
  # compile_inputs(): every compile gets these.
  compileFlags = [
    "--sysroot=${sysroot}"
    "--target=${target}"
    # nixpkgs splits clang's resource dir (stddef.h & co.) into the lib output
    "-resource-dir=${lib.getLib clang}/lib/clang/${lib.versions.major llvmPackages.release_version}"
    "-matomics" "-mbulk-memory" "-mmutable-globals"
    "-pthread" "-mthread-model" "posix"
    "-fno-trapping-math"
    "-D_WASI_EMULATED_MMAN" "-D_WASI_EMULATED_SIGNAL" "-D_WASI_EMULATED_PROCESS_CLOCKS"
    "-ftls-model=local-exec"
  ] ++ (if mode == "eh" then [
    "-fwasm-exceptions"
    "-mllvm" "--wasm-enable-eh"
    "-mllvm" "--wasm-enable-sjlj"
    "-mllvm" "--wasm-use-legacy-eh=false"
  ] else [
    "-fno-exceptions"
  ]);

  # build_link_args(): wasm-ld flags. We drive the link through the clang
  # driver (-nostdlib, so it adds no crt/libs of its own) and forward these
  # with -Wl, so that -o/-l/-L/inputs keep their natural handling.
  ldFlags = [
    "--extra-features=atomics" "--extra-features=bulk-memory" "--extra-features=mutable-globals"
    "--shared-memory" "--max-memory=4294967296" "--import-memory"
    "--export-dynamic" "--export=__wasm_call_ctors" "--no-demangle"
  ] ++ lib.optionals (mode == "eh") [
    "-mllvm" "--wasm-enable-eh" "-mllvm" "--wasm-enable-sjlj"
    "-mllvm" "--wasm-use-legacy-eh=false" "-mllvm" "--exception-model=wasm"
  ] ++ [
    "--export=__wasm_init_tls" "--export=__wasm_signal"
    "--export=__tls_size" "--export=__tls_align" "--export=__tls_base"
    "--export-if-defined=__indirect_function_table"
    "--export-if-defined=__stack_pointer" "--export-if-defined=__heap_base" "--export-if-defined=__data_end"
    "-z" "stack-size=8388608"
  ];
  # default libs for an executable (StaticMain), in wasixcc's order, then crt1.o
  ldLibs = [
    "-L${sysroot}/lib" "-L${sysroot}/lib/${target}"
    "-lwasi-emulated-getpid" "-lwasi-emulated-mman" "-lwasi-emulated-process-clocks"
    "-lc" "-lresolv" "-lrt" "-lm" "-lpthread" "-lutil"
  ] ++ lib.optionals (mode == "eh") [ "-lunwind" ]
  ++ [ "-lclang_rt.builtins-wasm32" ];

  # run_wasm_opt(): post-link pass. asyncify mode: --asyncify (+ -O<n> from the
  # compile line). eh mode with exnref: nothing to do (we don't use legacy EH).
  wasmOptFeatures = [
    "--enable-threads" "--enable-mutable-globals" "--enable-bulk-memory" "--enable-bulk-memory-opt"
    "--enable-exception-handling" "--enable-simd" "--enable-relaxed-simd" "--enable-extended-const"
  ];

  # Note: binaryen is deliberately NOT put on PATH, because clang's wasm driver
  # runs `wasm-opt` on its own when it finds one there; we call it by path.
  ccScript = pkgs.writeTextFile {
    name = "wasm32-wasi-clang";
    executable = true;
    destination = "/bin/${target}-clang";
    text = ''
      #!${pkgs.runtimeShell}
      # PROTOTYPE wasix cc wrapper (mode: ${mode}). See wasix.nix for the why.
      set -euo pipefail

      link=1            # becomes 0 for -c/-S/-E/-M*/-r/--version/-print-*/-dumpmachine
      have_input=0
      out="a.out"
      next_is_out=0
      optlevel=""
      debug=0
      user_wasm_opt=''${WASIX_WASM_OPT:-}        # set to "skip" to leave the module alone
      for a in "$@"; do
        if [ $next_is_out = 1 ]; then out=$a; next_is_out=0; continue; fi
        case "$a" in
          -c|-S|-E|-M|-MM|-r|--relocatable|-fsyntax-only|-shared|--version|-dumpmachine|-dumpversion|-print-*|-###|-v) link=0 ;;
          -o) next_is_out=1 ;;
          -o*) out=''${a#-o} ;;
          -O0|-O1|-O2|-O3|-O4|-Os|-Oz) optlevel=$a ;;
          -O) optlevel=-O1 ;;
          -g|-g1|-g2|-g3|-ggdb*) debug=1 ;;
          -*) ;;
          *) have_input=1 ;;
        esac
      done
      [ $have_input = 1 ] || link=0

      args=(${lib.escapeShellArgs compileFlags})
      if [ $link = 1 ]; then
        args+=("-fuse-ld=lld" "-B${lld}/bin" "-nostdlib" "--no-wasm-opt")
        for f in ${lib.escapeShellArgs ldFlags}; do args+=("-Wl,$f"); done
      fi
      args+=("$@")
      if [ $link = 1 ]; then
        args+=(${lib.escapeShellArgs ldLibs} "${sysroot}/lib/${target}/crt1.o")
      fi

      [ -z "''${WASIX_CC_VERBOSE:-}" ] || echo "+ clang ''${args[*]}" >&2
      ${clang}/bin/clang "''${args[@]}"

      if [ $link = 1 ] && [ "$user_wasm_opt" != skip ]; then
        passes=()
        ${if mode == "asyncify" then ''passes+=(--asyncify)'' else ""}
        [ -z "$optlevel" ] || passes+=("$optlevel")
        [ $debug = 0 ] || passes+=(-g)        # keeps the name section (wasixcc does the same)
        passes+=(''${WASIX_WASM_OPT_FLAGS:-})
        # drop empty words
        set -- "''${passes[@]}"; passes=(); for p in "$@"; do [ -n "$p" ] && passes+=("$p"); done
        if [ ''${#passes[@]} -gt 0 ]; then
          [ -z "''${WASIX_CC_VERBOSE:-}" ] || echo "+ wasm-opt ''${passes[*]} $out" >&2
          ${binaryen}/bin/wasm-opt "''${passes[@]}" --no-validation ${lib.escapeShellArgs wasmOptFeatures} -o "$out" "$out"
        fi
      fi
    '';
  };

  toolchain = pkgs.symlinkJoin {
    name = "wasix-toolchain-${mode}";
    paths = [ ccScript ];
    postBuild = ''
      cd $out/bin
      ln -s ${target}-clang ${target}-cc
      ln -s ${target}-clang ${target}-gcc
      ln -s ${target}-clang wasix-clang
      for t in ar ranlib nm strip objdump objcopy readelf; do
        ln -s ${llvm}/bin/llvm-$t ${target}-$t
      done
      # Setup hook: exports the cross tools. It must run AFTER the native
      # stdenv.cc hook (which unconditionally exports CC=gcc etc.), so
      # mkDerivation below lists this package last in nativeBuildInputs. The
      # native compiler is kept as CC_FOR_BUILD for host-side helper programs.
      mkdir -p $out/nix-support
      cat > $out/nix-support/setup-hook <<EOF
      export CC_FOR_BUILD="\''${CC:-cc}"
      export CXX_FOR_BUILD="\''${CXX:-c++}"
      export CC=${target}-clang
      export CXX=${target}-clang
      export AR=${target}-ar
      export RANLIB=${target}-ranlib
      export NM=${target}-nm
      export STRIP=${target}-strip
      export OBJDUMP=${target}-objdump
      export WASIX_SYSROOT=${sysroot}
      EOF
    '';
    passthru = { inherit sysroot mode clang lld binaryen; };
  };

  mkDerivation = args: pkgs.stdenvNoCC.mkDerivation (
    (builtins.removeAttrs args [ "nativeBuildInputs" "configureFlags" ]) // {
      nativeBuildInputs = [ pkgs.stdenv.cc pkgs.updateAutotoolsGnuConfigScriptsHook ]
        ++ (args.nativeBuildInputs or [ ])
        ++ [ toolchain ];          # last: its setup hook overrides CC & co.
      # stdenv's configurePhase adds --build/--host from these when set.
      configurePlatforms = args.configurePlatforms or [ ];
      configureFlags = [ "--host=${target}" "--build=${pkgs.stdenv.hostPlatform.config}" ]
        ++ (args.configureFlags or [ ]);
      dontStrip = true;              # llvm-strip on a wasm binary: not needed, keeps names
      dontPatchELF = true;
    });
in
{
  inherit sysroot toolchain mkDerivation mode target;
  inherit compileFlags ldFlags ldLibs wasmOptFeatures;
  cc = toolchain;
  llvmVersion = llvmPackages.release_version;
  binaryenVersion = binaryen.version;
}

# PROTOTYPE. Generic GNU autotools package -> WASIX wasm.
#   ./configure --host=wasm32-wasi --build=<native> ... && make && make install
# then every executable in $out/bin becomes bin/<name>.wasm (the file make
# installed is already a wasm module; it only lacks the extension).
{ wasix, pkgs }:
{ pname, version, hash, configureFlags ? [ ], extraEnv ? { }, commands ? null
, postInstallWasm ? "", ... }@args:
wasix.mkDerivation ({
  inherit pname version;
  src = pkgs.fetchurl {
    url = "https://ftp.gnu.org/gnu/${pname}/${pname}-${version}.tar.xz";
    inherit hash;
  };
  nativeBuildInputs = (args.nativeBuildInputs or [ ]) ++ [ pkgs.perl ];
  enableParallelBuilding = true;
  # cross build: configure may not run test programs, so some gnulib checks
  # need answers. These are the common ones; per-package extras go via
  # extraEnv / configureFlags.
  configureFlags = [
    "--disable-nls"
    "--disable-dependency-tracking"
    "--disable-silent-rules"
  ] ++ configureFlags;
  # gnulib's opendirat(int, char const *, int, int *) collides with the
  # 2-argument opendirat() that wasi-libc declares in <dirent.h>; rename
  # gnulib's (used by fts.c in grep/findutils/coreutils).
  postPatch = (args.postPatch or "") + ''
    for f in $(grep -rl --include='*.c' --include='*.h' '\bopendirat\b' lib gnulib/lib 2>/dev/null); do
      sed -i -e 's/\bopendirat\b/gl_opendirat/g' -e 's/gl_opendirat\.h/opendirat.h/g' "$f"
    done
  '';
  # fpcast-emu is only known to be needed by bash; leave the tools lean.
  postInstall = ''
    cd $out/bin
    for f in *; do
      if [ -f "$f" ] && [ ! -L "$f" ] && head -c4 "$f" | grep -q $'\0asm'; then
        mv "$f" "$f.wasm"
      fi
    done
    # symlinks (coreutils single-binary) -> drop; the manifest maps names
    find . -type l -delete
    rm -f ./*.wasm.wasm 2>/dev/null || true
    ${postInstallWasm}
    rm -rf $out/share/man $out/share/info $out/libexec 2>/dev/null || true
  '';
  passthru = (args.passthru or { }) // pkgs.lib.optionalAttrs (commands != null) { inherit commands; };
} // extraEnv // builtins.removeAttrs args [
  "pname" "version" "hash" "configureFlags" "extraEnv" "commands" "postInstallWasm" "nativeBuildInputs" "passthru" "postPatch"
])

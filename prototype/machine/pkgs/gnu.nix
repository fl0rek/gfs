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
  postPatch = (args.postPatch or "") + "\n" + ''
    # gnulib's test suite (gnulib-tests/) is in SUBDIRS and does not port to
    # wasi (#error in getlocalename_l-unsafe.c); we do not run tests anyway.
    sed -i -E 's/^(SUBDIRS *=.*) gnulib-tests( |$)/\1\2/' Makefile.in
    # gnulib's getlocalename_l-unsafe.c has a musl branch (nl_langinfo_l with
    # NL_LOCALE_NAME, which wasi-libc also has) but keys it on __linux__.
    for f in $(find . -name 'getlocalename_l-unsafe.c'); do
      sed -i -e 's/defined __linux__ && HAVE_LANGINFO_H/(defined __linux__ || defined __wasi__) \&\& HAVE_LANGINFO_H/g' "$f"
    done
    # gnulib's mountlist.c (find -fstype, df) has no method for wasi; an
    # empty mount list is the honest answer.
    for f in $(find . -name 'mountlist.c'); do
      sed -i 's/^# error "Please port gnulib mountlist.c to your platform!"/\/* wasi: no mount table *\//' "$f"
    done
    for f in $(grep -rl --include='*.c' --include='*.h' '\bopendirat\b' . 2>/dev/null); do
      sed -i -e 's/\bopendirat\b/gl_opendirat/g' -e 's/gl_opendirat\.h/opendirat.h/g' "$f"
    done
  '';
  # configure cannot run test programs for a cross target and guesses; the
  # guesses below were wrong (or needlessly pessimistic) for WASIX. Verified
  # with probes under the Wasmer SDK (see NOTES.md):
  ac_cv_type_getgroups = "gid_t";              # guess "int": gnulib stub then conflicts with <unistd.h>
  gl_cv_func_open_directory_works = "yes";     # guess "no": gnulib then never registers dir fds and its
                                               # fchdir emulation fails (find: "Failed to restore initial working directory")
  gl_cv_func_fdopendir_works = "yes";          # guess "no": gnulib's replacement is built on fchdir
  gl_cv_func_getcwd_null = "yes";              # getcwd (NULL, 0) allocates
  gl_cv_func_getcwd_path_max = "yes";          # avoid gnulib's getcwd that walks ".." comparing inodes
  gl_cv_struct_dirent_d_ino = "yes";
  gl_cv_func_strcasecmp_works = "yes";         # diffutils' configure has no cross guess for it and aborts
  # fpcast-emu is only known to be needed by bash; leave the tools lean.
  postInstall = ''
    cd $out/bin
    for f in *; do
      [ -f "$f" ] && [ ! -L "$f" ] || continue
      if [ "$(head -c4 "$f" | od -An -tx1 | tr -d ' \n')" = 0061736d ]; then
        mv "$f" "$f.wasm"
      else
        rm -f "$f"            # shell-script wrappers (egrep, fgrep, ...) are useless here
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

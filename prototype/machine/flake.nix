# PROTOTYPE. The "machine" tier of Universal Explorer, built as WASIX wasm
# modules that run under Wasmer (native CLI or the JS SDK in a browser/Node).
#
#   nix build .#hello      # C smoke test
#   nix build .#bash       # GNU bash (wasix-org fork) -> result/bin/bash.wasm
#   nix build .#machine    # bin/*.wasm + manifest.json, what the web app loads
#
# Toolchain: stock nixpkgs LLVM 20 (clang-unwrapped + lld) and binaryen, plus
# the prebuilt wasix-libc sysroot. No wasix-org LLVM fork. See wasix.nix and
# NOTES.md.
{
  description = "Universal Explorer machine tier: WASIX wasm userland";

  # nixpkgs-unstable, pinned by the release tarball (rev 5adc50831c259f87faeb09ddf930d43597197473,
  # 2026-10-20). A tarball URL rather than github: because api.github.com is
  # not reachable from every build host we use; the lock pins the narHash.
  inputs.nixpkgs.url = "https://releases.nixos.org/nixpkgs/nixpkgs-26.11pre1097770.5adc50831c25/nixexprs.tar.zst";

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "aarch64-darwin" "x86_64-darwin" ];
      forAll = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
      mkWasix = pkgs: import ./wasix.nix { inherit pkgs; };
      mkPackages = pkgs:
        let
          wasix = mkWasix pkgs;
          sources = import ./sources.nix { inherit pkgs; };
          # every userland package: name -> derivation producing bin/<name>.wasm
          gnu = import ./pkgs/gnu.nix { inherit wasix pkgs; };
          # Only packages that build AND run under the SDK go into `userland`
          # (and therefore into `machine`); the rest stay reachable as
          # packages for debugging. See NOTES.md for the status of each.
          attempts = {
            sed = gnu {
              pname = "sed"; version = "4.10";
              hash = "sha256-uOchgrLslqNXTimYxHt6qmTMIM4ADY6awxPMB87PKMc=";
            };
            gawk = gnu {
              pname = "gawk"; version = "5.4.1";
              hash = "sha256-B/b3NCt/6+QxP8LCVCrZPWT+IK2HFyABCfEFqCb1/Tc=";
              configureFlags = [ "--disable-extensions" "--disable-mpfr" "--disable-pma" ];
              commands = { gawk = "gawk.wasm"; awk = "gawk.wasm"; };
            };
            findutils = gnu {
              pname = "findutils"; version = "4.11.0";
              hash = "sha256-v9GcsGzHHzNS1WfpAoTYzawCrIl3S76t8LUzsMEUMv0=";
              commands = { find = "find.wasm"; xargs = "xargs.wasm"; };
            };
            diffutils = gnu {
              pname = "diffutils"; version = "3.12";
              hash = "sha256-fIt/n8hgkUH96pzs6FJJ0whiQ5H/Yd7a9Sj8szdyff0=";
              commands = { diff = "diff.wasm"; cmp = "cmp.wasm"; diff3 = "diff3.wasm"; sdiff = "sdiff.wasm"; };
            };
            coreutils = gnu {
              pname = "coreutils"; version = "9.12";
              hash = "sha256-pIAZhVlzPps9qZnpBUOsb4iKLKpUTY1mTFofF+Uo4hA=";
              # one multi-call module; the manifest maps every tool name to it
              configureFlags = [ "--enable-single-binary=symlinks" "--enable-no-install-program=stdbuf" ];
            };
          };
          userland = {
            hello = import ./pkgs/hello.nix { inherit wasix; };
            bash = import ./pkgs/bash.nix { inherit wasix pkgs; inherit (sources) bash; };
            grep = gnu {
              pname = "grep"; version = "3.12";
              hash = "sha256-JkmyfA6Q5jLq3NdXvgbG6aT0jZQd5R58D4P/dkCKB7k=";
              configureFlags = [ "--disable-perl-regexp" ];   # no pcre2 in the sysroot
            };
          };
        in attempts // userland // {
          wasix-sysroot = wasix.sysroot;
          wasix-toolchain = wasix.toolchain;
          machine = import ./pkgs/machine.nix { inherit pkgs wasix userland; };
          default = self.packages.${pkgs.stdenv.hostPlatform.system}.machine;
        };
    in
    {
      lib = { inherit mkWasix; };
      overlays.default = final: prev: { wasix = mkWasix final; };
      packages = forAll mkPackages;
      checks = forAll (pkgs: { inherit (mkPackages pkgs) hello bash machine; });
    };
}

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
            grep = gnu {
              pname = "grep"; version = "3.12";
              hash = "sha256-JkmyfA6Q5jLq3NdXvgbG6aT0jZQd5R58D4P/dkCKB7k=";
              configureFlags = [ "--disable-perl-regexp" ];
            };
          };
          userland = {
            hello = import ./pkgs/hello.nix { inherit wasix; };
            bash = import ./pkgs/bash.nix { inherit wasix pkgs; inherit (sources) bash; };
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

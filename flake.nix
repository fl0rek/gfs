# PROTOTYPE. Builds and runs the pi-on-gfs prototype (prototype/) with the WayQuest view.
#
#   nix run                 # build, then serve on http://127.0.0.1:4173/  (--port N for another)
#   nix run .#nix-built     # the same, with the Nix-built WASIX userland from prototype/machine
#   nix build               # just the built site, in ./result
#   nix develop             # node, pnpm, Rust with wasm32, wasm-bindgen, binaryen
#
# The deployed site (fl0rek.github.io/gfs) is built by CI from prototype/pi-on-gfs only; nothing here
# deploys anything.
{
  description = "Universal Explorer prototype: pi on gfs, with the WayQuest view";

  # The same nixpkgs as prototype/machine: a release tarball rather than github:, so hosts that can't
  # reach api.github.com can still lock it. rust-overlay comes from FlakeHub for the same reason.
  inputs = {
    nixpkgs.url = "https://releases.nixos.org/nixpkgs/nixpkgs-26.11pre1097770.5adc50831c25/nixexprs.tar.zst";
    rust-overlay = {
      url = "https://flakehub.com/f/oxalica/rust-overlay/*.tar.gz";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    { self, nixpkgs, rust-overlay }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "aarch64-darwin" ]; # nixpkgs 26.11 dropped x86_64-darwin
      forAll =
        f:
        nixpkgs.lib.genAttrs systems (
          system: f (import nixpkgs { inherit system; overlays = [ rust-overlay.overlays.default ]; })
        );

      # prototype/machine is a flake of its own; evaluate it here, on this (the same) nixpkgs.
      machineFlake =
        let
          m = (import ./prototype/machine/flake.nix).outputs { self = m; inherit nixpkgs; };
        in
        m;

      # The WASIX packages the shell runs when the userland isn't Nix-built: the same pins as
      # PACKAGES in prototype/web/scripts/fetch-packages.mjs (keep the two in step).
      webcPins = {
        "wasmer/bash@1.0.25" = "059606d132e2e6bc1afe3b432ee64dcb1b1b059815c8bb213cf3b24798ef21e1";
        "wasmer/coreutils@1.0.27" = "35028c4e6b9fa8cccdffdcab2007d1df3af31b3f2b22fb890d022d7ae723bbd3";
      };

      rustFor = pkgs: pkgs.rust-bin.stable.latest.minimal.override { targets = [ "wasm32-unknown-unknown" ]; };

      packagesFor =
        pkgs:
        let
          inherit (pkgs) lib;
          rust = rustFor pkgs;
          rustPlatform = pkgs.makeRustPlatform { cargo = rust; rustc = rust; };

          # The datacombs engine (prototype/gfs-core) as wasm, what build-wasm.sh makes.
          gfs-core-wasm = rustPlatform.buildRustPackage {
            pname = "gfs-core-wasm";
            version = "0.0.0";
            src = ./prototype/gfs-core;
            cargoLock.lockFile = ./prototype/gfs-core/Cargo.lock;
            nativeBuildInputs = [ pkgs.wasm-bindgen-cli_0_2_129 pkgs.binaryen ];
            buildPhase = ''
              runHook preBuild
              cargo build --release --offline --target wasm32-unknown-unknown
              runHook postBuild
            '';
            installPhase = ''
              runHook preInstall
              wasm-bindgen --target web --out-dir $out --out-name gfs_core \
                target/wasm32-unknown-unknown/release/gfs_core.wasm
              wasm-opt -Os -o $out/gfs_core_bg.wasm $out/gfs_core_bg.wasm
              runHook postInstall
            '';
            doCheck = false;
          };

          webc = lib.mapAttrsToList (
            _: sha256: pkgs.fetchurl { url = "https://cdn.wasmer.io/webcimages/${sha256}.webc"; name = "${sha256}.webc"; inherit sha256; }
          ) webcPins;

          pnpmDeps = pkgs.fetchPnpmDeps {
            pname = "pi-on-gfs-web";
            version = "0.0.0";
            src = lib.fileset.toSource {
              root = ./prototype/web;
              fileset = lib.fileset.unions [ ./prototype/web/package.json ./prototype/web/pnpm-lock.yaml ];
            };
            pnpm = pkgs.pnpm_10;
            fetcherVersion = 3;
            hash = "sha256-hdkTzzVxOj3uuBeeb45owcd9/o3bqv5K7GBMv7q6Ltw=";
          };

          # The site: prototype/web built with vite, offline. `machine` null: the shell runs the pinned
          # registry packages; else that Nix-built userland (prototype/machine), as on the deployed site.
          web =
            { machine ? null }:
            pkgs.stdenv.mkDerivation {
              pname = "pi-on-gfs-web" + lib.optionalString (machine != null) "-nix-built";
              version = "0.0.0";
              # prototype/web as committed, minus anything a local build leaves behind.
              src = lib.fileset.toSource {
                root = ./prototype;
                fileset = lib.fileset.difference (lib.fileset.unions [ ./prototype/web ./prototype/machine/flake.nix ]) (
                  lib.fileset.unions (
                    map lib.fileset.maybeMissing [
                      ./prototype/web/node_modules
                      ./prototype/web/dist
                      ./prototype/web/src/gfs-wasm
                      ./prototype/web/public/system
                      ./prototype/web/public/machine
                    ]
                  )
                );
              };
              sourceRoot = "source/web";
              inherit pnpmDeps;
              nativeBuildInputs = [ pkgs.nodejs_22 pkgs.pnpm_10 pkgs.pnpmConfigHook ];
              buildPhase = ''
                runHook preBuild
                mkdir -p src/gfs-wasm public/packages
                cp ${gfs-core-wasm}/* src/gfs-wasm/
                ${lib.concatMapStringsSep "\n" (f: "cp ${f} public/packages/${f.name}") webc}
                ${lib.optionalString (machine != null) "export MACHINE_OUT=${machine}"}
                OFFLINE=1 node scripts/fetch-packages.mjs
                BASE_PATH=/ node node_modules/vite/bin/vite.js build
                runHook postBuild
              '';
              installPhase = ''
                runHook preInstall
                cp -r dist $out
                runHook postInstall
              '';
            };
        in
        rec {
          inherit gfs-core-wasm;
          machine = machineFlake.packages.${pkgs.stdenv.hostPlatform.system}.machine;
          web-registry = web { };
          web-nix-built = web { inherit machine; };
          default = web-registry;
        };

      serve =
        pkgs: site: name:
        pkgs.writeShellApplication {
          inherit name;
          runtimeInputs = [ pkgs.python3 ];
          text = ''
            port=4173
            while [ $# -gt 0 ]; do
              case "$1" in
                --port) port="$2"; shift 2 ;;
                *) echo "usage: ${name} [--port N]" >&2; exit 2 ;;
              esac
            done
            exec python3 ${./prototype/serve.py} ${site} "$port"
          '';
        };
    in
    {
      packages = forAll packagesFor;

      apps = forAll (
        pkgs:
        let
          p = self.packages.${pkgs.stdenv.hostPlatform.system};
          app = site: name: description: {
            type = "app";
            meta.description = description;
            program = "${serve pkgs site name}/bin/${name}";
          };
        in
        {
          default = app p.web-registry "pi-on-gfs" "Build the prototype and serve it on localhost";
          nix-built = app p.web-nix-built "pi-on-gfs-nix-built" "The same, with the Nix-built WASIX userland";
        }
      );

      devShells = forAll (pkgs: {
        default = pkgs.mkShell {
          packages = [
            (rustFor pkgs)
            pkgs.wasm-bindgen-cli_0_2_129
            pkgs.binaryen
            pkgs.nodejs_22
            pkgs.pnpm_10
            pkgs.python3
          ];
        };
      });

      formatter = forAll (pkgs: pkgs.nixfmt);
    };
}

{
  description = "Does Hermes run on WASIX Python? Throwaway runner for the ticket's checks";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    # The Hermes commit the static audit was done against.
    hermes = {
      url = "github:NousResearch/hermes-agent/5a487bcaeba3b8a17ab11ac8a4b026374324acd5";
      flake = false;
    };
  };

  outputs = { self, nixpkgs, hermes }:
    let
      systems = [ "aarch64-linux" "x86_64-linux" "aarch64-darwin" "x86_64-darwin" ];
      forAll = f: nixpkgs.lib.genAttrs systems (s: f nixpkgs.legacyPackages.${s});
    in
    {
      packages = forAll (pkgs:
        let
          hostPy = pkgs.python314.withPackages (p: [ p.pip p.packaging ]);
        in
        {
          default = pkgs.writeShellApplication {
            name = "hermes-wasix-smoke";
            runtimeInputs = with pkgs; [
              wasmer uv hostPy git unzip coreutils findutils gnugrep gnused
              stdenv.cc # psutil is git-pinned upstream; the host baseline builds it
            ];
            text = ''
              export HERMES_SRC=${hermes}
              export SMOKE_PY=${./smoke.py}
              export FILTER_PY=${./filter_reqs.py}
              export HOST_PY=${hostPy}/bin/python3
            '' + builtins.readFile ./run.sh;
          };
        });

      apps = forAll (pkgs: {
        default = {
          type = "app";
          program = "${self.packages.${pkgs.stdenv.hostPlatform.system}.default}/bin/hermes-wasix-smoke";
        };
      });
    };
}

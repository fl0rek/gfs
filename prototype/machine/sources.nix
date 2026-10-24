# PROTOTYPE. Pinned upstream sources.
{ pkgs }:
{
  # wasix-org/bash, branch wasix-compat ("Release 1.0.25"), the source of the
  # Wasmer registry package wasmer/bash.
  bash = pkgs.fetchFromGitHub {
    owner = "wasix-org";
    repo = "bash";
    rev = "fc8096485478055f4fcf31402004fdd8ff6b72b7";
    hash = "sha256-lAEJ7e82sIosub9Xi7TEQjjbIEcN0GU+sUnq0s2CFfY=";
  };
}

# PROTOTYPE. Join every userland package into one directory:
#   bin/<name>.wasm
#   manifest.json   { commands: { <cmd>: { module: "bin/<name>.wasm" } }, ... }
# This is what the web app loads into a Wasmer package.
{ pkgs, wasix, userland }:
let
  inherit (pkgs) lib;
  # a package may declare passthru.commands = { cmd = "file.wasm"; }, else
  # its single command is its own name.
  commandsOf = name: drv:
    let c = drv.passthru.commands or { ${name} = "${name}.wasm"; };
    in lib.mapAttrs (_: file: { module = "bin/${file}"; }) c;
  manifest = {
    commands = lib.foldl' (acc: name: acc // commandsOf name userland.${name}) { } (builtins.attrNames userland);
    sysroot = {
      release = wasix.sysroot.version;
      mode = wasix.mode;
      url = wasix.sysroot.src.url;
      hash = wasix.sysroot.src.outputHash;
    };
    built = lib.mapAttrs (name: drv: {
      version = drv.version or null;
      store = "${drv}";
    }) userland;
    toolchain = {
      llvm = wasix.llvmVersion;
      binaryen = wasix.binaryenVersion;
      target = wasix.target;
    };
  };
in
pkgs.runCommand "machine" {
  manifestJson = builtins.toJSON manifest;
  passAsFile = [ "manifestJson" ];
} ''
  mkdir -p $out/bin
  ${lib.concatMapStringsSep "\n" (name: ''
    for f in ${userland.${name}}/bin/*.wasm; do
      ln -s "$f" "$out/bin/$(basename "$f")"
    done
  '') (builtins.attrNames userland)}
  ${pkgs.jq}/bin/jq . "$manifestJsonPath" > $out/manifest.json
''

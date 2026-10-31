# PROTOTYPE. C hello world through the WASIX toolchain.
{ wasix }:
wasix.mkDerivation {
  pname = "hello-wasix";
  version = "0";
  src = ../hello;
  dontConfigure = true;
  buildPhase = ''
    WASIX_CC_VERBOSE=1 $CC -O2 -o hello.wasm hello.c
  '';
  installPhase = ''
    mkdir -p $out/bin
    cp hello.wasm $out/bin/
  '';
}

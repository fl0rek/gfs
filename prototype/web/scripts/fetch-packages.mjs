// PROTOTYPE. Fetch the WASIX packages the shell needs, pinned by sha256, into public/packages/.
// Run at build time so the hosted site never depends on the Wasmer CDN at runtime.
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync, readFileSync, copyFileSync } from "node:fs";

// The running system's source, deployed alongside so /nix can be seeded with it.
const systemDir = new URL("../public/system/", import.meta.url);
mkdirSync(systemDir, { recursive: true });
const flakeSrc = new URL("../../machine/flake.nix", import.meta.url);
if (existsSync(flakeSrc)) copyFileSync(flakeSrc, new URL("flake.nix", systemDir));
else writeFileSync(new URL("flake.nix", systemDir), "# prototype/machine/flake.nix was not present at build time\n");

// The exact query @wasmer/sdk 0.19.1 sends when resolving a dependency by name (captured from a browser run).
const QUERY = readFileSync(new URL("./registry-query.graphql", import.meta.url), "utf8");

export const PACKAGES = {
  "wasmer/bash@1.0.25": "059606d132e2e6bc1afe3b432ee64dcb1b1b059815c8bb213cf3b24798ef21e1",
  "wasmer/coreutils@1.0.27": "35028c4e6b9fa8cccdffdcab2007d1df3af31b3f2b22fb890d022d7ae723bbd3",
};

const out = new URL("../public/packages/", import.meta.url);
mkdirSync(out, { recursive: true });
for (const [name, sha] of Object.entries(PACKAGES)) {
  const file = new URL(`${sha}.webc`, out);
  if (existsSync(file) && createHash("sha256").update(readFileSync(file)).digest("hex") === sha) {
    console.log(`${name}: cached`);
    continue;
  }
  const url = `https://cdn.wasmer.io/webcimages/${sha}.webc`;
  let bytes;
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url);
    if (res.ok) { bytes = new Uint8Array(await res.arrayBuffer()); break; }
    if (attempt >= 5) throw new Error(`${url}: ${res.status}`);
    console.log(`${name}: ${res.status}, retrying`);
    await new Promise((r) => setTimeout(r, 2000 * attempt));
  }
  const got = createHash("sha256").update(bytes).digest("hex");
  if (got !== sha) throw new Error(`${name}: sha256 mismatch ${got}`);
  writeFileSync(file, bytes);
  console.log(`${name}: ${bytes.length} bytes`);
}
// The SDK resolves a package's `use` dependencies by name through the registry's GraphQL API
// (the URL is baked into its wasm core). Record the registry's answer for each pinned package so
// the worker can serve it locally (see shell.ts, registryShim) and the site needs no wasmer.io at all.
const registry = {};
for (const name of Object.keys(PACKAGES)) {
  const bare = name.split("@")[0];
  const query = QUERY.replace('"wasmer/coreutils"', JSON.stringify(bare));
  const res = await fetch("https://registry.wasmer.io/graphql", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query }) });
  const json = await res.json();
  const pkg = json.data?.getPackage;
  if (!pkg) throw new Error(`registry has no ${bare}: ${JSON.stringify(json).slice(0, 200)}`);
  // keep only the pinned version, and only if its webc is one we ship
  pkg.versions = pkg.versions.filter((v) => Object.values(PACKAGES).includes(v.v3?.piritaSha256Hash));
  if (!pkg.versions.length) throw new Error(`${bare}: pinned hash not among registry versions`);
  registry[bare] = { data: { ...json.data, getPackage: pkg } };
  console.log(`${bare}: recorded registry answer (${pkg.versions.map((v) => v.version).join(", ")})`);
}
writeFileSync(new URL("index.json", out), JSON.stringify({ packages: PACKAGES, registry }, null, 1));

// ---- the deployed system (/nix/machine.json seed) ----
// If the machine flake was built (prototype/machine/result, or $MACHINE_OUT), its wasm modules are
// copied into public/machine/ and become the system; the registry .webc packages fill in whatever the
// flake does not provide yet (e.g. coreutils while only bash is built). Otherwise the .webc packages
// alone are the system.
const machineOut = process.env.MACHINE_OUT ?? new URL("../../machine/result/", import.meta.url).pathname;
const systemPackages = [];
let systemName;
if (existsSync(`${machineOut}/manifest.json`)) {
  const m = JSON.parse(readFileSync(`${machineOut}/manifest.json`, "utf8"));
  const dest = new URL("../public/machine/", import.meta.url);
  mkdirSync(dest, { recursive: true });
  for (const [cmd, { module }] of Object.entries(m.commands ?? {})) {
    const bytes = readFileSync(`${machineOut}/${module}`);
    const sha = createHash("sha256").update(bytes).digest("hex");
    const file = module.split("/").pop();
    writeFileSync(new URL(file, dest), bytes);
    systemPackages.push({ kind: "wasm", name: `nix:${file}`, url: `machine/${file}`, sha256: sha, command: cmd });
  }
  const nixCmds = Object.keys(m.commands ?? {});
  systemName = `nix-built (${nixCmds.join(", ")}; llvm ${m.toolchain?.llvm ?? "?"}, sysroot ${m.sysroot?.release ?? "?"})`;
  console.log(`machine: ${nixCmds.length} nix-built command(s): ${nixCmds.join(", ")}`);
  if (nixCmds.includes("bash")) {
    // bash from Nix; keep Wasmer's coreutils for the utilities until the flake provides them.
    for (const [name, sha] of Object.entries(PACKAGES)) if (!name.startsWith("wasmer/bash")) systemPackages.push({ kind: "webc", name, url: `packages/${sha}.webc`, sha256: sha });
  } else {
    for (const [name, sha] of Object.entries(PACKAGES)) systemPackages.push({ kind: "webc", name, url: `packages/${sha}.webc`, sha256: sha });
    systemName += " + wasmer registry bash/coreutils";
  }
} else {
  for (const [name, sha] of Object.entries(PACKAGES)) systemPackages.push({ kind: "webc", name, url: `packages/${sha}.webc`, sha256: sha });
  systemName = "wasmer registry packages (bash + coreutils), served from this origin";
}
writeFileSync(new URL("machine.json", systemDir), JSON.stringify({ name: systemName, shell: "bash", packages: systemPackages }, null, 2) + "\n");
console.log(`system: ${systemName}`);

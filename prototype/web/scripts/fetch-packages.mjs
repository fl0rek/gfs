// PROTOTYPE. Fetch the WASIX packages the shell needs, pinned by sha256, into public/packages/.
// Run at build time so the hosted site never depends on the Wasmer CDN at runtime.
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";

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

// PROTOTYPE. Load a `machine` output (bin/*.wasm + manifest.json) into one
// Wasmer package under the @wasmer/sdk Node build and run smoke tests.
//
//   node prototype/machine/test/smoke.mjs prototype/machine/result
//
// Needs the SDK from prototype/web/node_modules (pnpm install there first).
// Behind the agent proxy: NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=...
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const sdkPath = join(here, "../../web/node_modules/@wasmer/sdk/dist/node.js");
const { Wasmer } = await import(sdkPath);

const dir = process.argv[2] || join(here, "../result");
const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
const modules = {};
const commands = {};
for (const [cmd, { module }] of Object.entries(manifest.commands)) {
  const name = module.replace(/^bin\//, "").replace(/\.wasm$/, "");
  modules[name] ??= readFileSync(join(dir, module));
  commands[cmd] = { module: name };
}
console.log("modules:", Object.keys(modules).join(" "), "| commands:", Object.keys(commands).join(" "));

const wasmer = new Wasmer({ cache: { directory: process.env.WASMER_CACHE || join(tmpdir(), "wasmer-sdk-cache") } });
const pkg = await wasmer.packages.create({ modules, commands });

async function run(cmd, args, opts = {}) {
  const sandbox = await wasmer.sandboxes.create({ packages: [pkg] });
  const t0 = Date.now();
  const r = await sandbox.command(cmd, args).run({ check: false, timeoutMs: 60000, ...opts });
  return { code: r.exitCode, out: r.stdout.text(), err: r.stderr.text(), ms: Date.now() - t0 };
}

let failed = 0;
async function expect(name, cmd, args, want, opts) {
  if (!(cmd in commands)) { console.log(`skip  ${name} (no ${cmd})`); return; }
  const r = await run(cmd, args, opts);
  const ok = r.code === want.code && (want.out === undefined || r.out === want.out)
    && (want.outIncludes === undefined || r.out.includes(want.outIncludes));
  console.log(`${ok ? "ok   " : "FAIL "} ${name} (${r.ms}ms, exit ${r.code})`);
  if (!ok) {
    failed++;
    console.log("  want:", JSON.stringify(want));
    console.log("  got code:", r.code, "\n  stdout:", JSON.stringify(r.out), "\n  stderr:", JSON.stringify(r.err.slice(0, 800)));
  }
  return r;
}

await expect("hello argv+thread+exit", "hello", ["fail"], { code: 3, outIncludes: "thread says: hi" });

await expect("bash --version", "bash", ["--version"], { code: 0, outIncludes: "GNU bash" });
await expect("bash builtins: pipes, subshell, arithmetic, read loop, exit", "bash", ["-c",
  'echo hi; x=1; echo $((x+1)); echo a b c | while read l; do echo got $l; done; (echo sub; exit 4); echo "sub exit=$?"; f() { return 7; }; f; echo "f=$?"; exit 5'],
  { code: 5, out: "hi\n2\ngot a b c\nsub\nsub exit=4\nf=7\n" });
await expect("bash: heredoc, $(...), files, glob, arrays, printf", "bash", ["-c",
  'cd /tmp || cd /; echo content > f.txt; while read -r l; do echo "$l"; done < f.txt; v=$(echo captured); cat() { while read -r l; do echo "$l"; done; }; cat <<EOF\nheredoc $v\nEOF\necho *; arr=(1 2 3); echo "${#arr[@]} ${arr[2]}"; printf "%05.2f\\n" 3.14159'],
  { code: 0, out: "content\nheredoc captured\nf.txt\n3 3\n03.14\n" });
await expect("bash runs another module as an external command", "bash", ["-c", "hello a; echo rc=$?; hello fail; echo rc=$?"],
  { code: 0, outIncludes: "argv[1]=a\n" });
await expect("bash stdin script", "bash", [], { code: 0, out: "from stdin\n" }, { stdin: "echo from stdin\n" });

for (const [cmd, args, inc] of [
  ["grep", ["--version"], "GNU grep"],
  ["sed", ["--version"], "GNU sed"],
  ["gawk", ["--version"], "GNU Awk"],
  ["awk", ["--version"], "GNU Awk"],
  ["find", ["--version"], "GNU findutils"],
  ["diff", ["--version"], "GNU diffutils"],
  ["coreutils", ["--version"], "GNU coreutils"],
  ["ls", ["--version"], "GNU coreutils"],
]) await expect(`${cmd} ${args.join(" ")}`, cmd, args, { code: 0, outIncludes: inc });

// pipelines across modules, when the tools are there
if ("grep" in commands) await expect("bash | grep", "bash", ["-c", "printf 'a\\nb\\nab\\n' | grep a; echo rc=$?"], { code: 0, out: "a\nab\nrc=0\n" });
if ("sed" in commands) await expect("bash | sed", "bash", ["-c", "echo hello | sed s/l/L/g"], { code: 0, out: "heLLo\n" });
if ("gawk" in commands) await expect("bash | awk", "bash", ["-c", "printf '1 2\\n3 4\\n' | gawk '{s+=$2} END {print s}'"], { code: 0, out: "6\n" });
if ("coreutils" in commands || "ls" in commands) await expect("bash | coreutils", "bash", ["-c", "cd /tmp || cd /; touch x y; ls | sort | wc -l"], { code: 0, out: "2\n" });

await wasmer.close();
console.log(failed ? `${failed} FAILED` : "all passed");
process.exit(failed ? 1 : 0);

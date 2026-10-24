// The deployed system is fully Nix-built: no wasmer.io, no .webc; GNU userland in the browser.
import puppeteer from "puppeteer-core";
const browser = await puppeteer.launch({ executablePath: process.env.CHROME ?? "/opt/pw-browsers/chromium-1248/chrome-linux64/chrome", headless: true, protocolTimeout: 180000, args: ["--no-sandbox", "--disable-gpu"] });
const page = await browser.newPage();
await page.setRequestInterception(true);
const ext = new Set();
page.on("request", (r) => { if (!r.url().startsWith("http://localhost")) { ext.add(r.url()); r.abort("failed"); } else r.continue(); });
page.on("pageerror", (e) => console.log(`  [pageerror] ${e.message}`));
let failures = 0;
const check = (c, m) => { console.log(`${c ? "ok " : "FAIL"} ${m}`); if (!c) failures++; };
const call = (req) => page.evaluate((r) => window.__pi.worker.call(r), req);
const tool = (name, params) => call({ method: "debugTool", name, params });
const text = (r) => r.content.map((c) => c.text).join("");
const t0 = Date.now();
await page.goto("http://localhost:4173/", { waitUntil: "load" });
await page.waitForFunction(() => window.__pi.state().info?.system, { timeout: 180000 });
const st = await page.evaluate(() => window.__pi.state());
check(/nix-built/.test(st.info.system.name), `system: ${st.info.system.name.slice(0, 80)}… (boot ${Date.now() - t0}ms)`);
const m = JSON.parse(text(await tool("read", { path: "/nix/machine.json" })));
check(m.packages.every((p) => p.name.startsWith("nix:")), `every package is Nix-built (${m.packages.length} modules)`);
const script = `
set -e
bash --version | head -1
mkdir -p src && printf 'alpha 1\\nbeta 2\\ngamma 3\\n' > src/data.txt && printf 'alpha 1\\nbeta 22\\ngamma 3\\n' > src/data2.txt
grep -n beta src/data.txt
sed -n 's/gamma/GAMMA/p' src/data.txt
awk '{ s += $2 } END { print "sum", s }' src/data.txt
find . -name '*.txt' | sort | xargs wc -l | tail -1
diff src/data.txt src/data2.txt || echo "diff exit $?"
echo hello | sha256sum | cut -c1-16
seq 1 5 | tr '\\n' ' '; echo
`;
const r = await tool("bash", { command: script });
console.log("  " + text(r).trim().split("\n").join("\n  "));
const out = text(r);
check(!r.isError, "the multi-tool script ran");
check(/wasm32-nix-wasix/.test(out), "bash is the Nix-built one");
check(/2:beta 2/.test(out) && /GAMMA 3/.test(out) && /sum 6/.test(out) && /total/.test(out) && /diff exit 1/.test(out) && /5891b5b522d5df08/.test(out) && /1 2 3 4 5/.test(out), "grep, sed, awk, find|xargs|wc, diff, sha256sum, seq|tr all correct");
const log = await call({ method: "log", comb: "workspace" });
check(log[0].summary.added.includes("src/data.txt"), "the files it created are a history entry");
const notList = [...ext].filter((u) => !u.includes("free-models.json"));
check(notList.length === 0, `no request left this origin except the free-model list (${notList.join(", ") || "none"})`);
await browser.close();
console.log(failures ? `${failures} FAILED` : "all checks passed");
process.exit(failures ? 1 : 0);

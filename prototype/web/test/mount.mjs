// Mount semantics and latency over the live gfs mount.
import puppeteer from "puppeteer-core";
const browser = await puppeteer.launch({ executablePath: process.env.CHROME ?? "/opt/pw-browsers/chromium-1248/chrome-linux64/chrome", headless: true, protocolTimeout: 180000, args: ["--no-sandbox", "--disable-gpu"] });
const page = await browser.newPage();
page.on("pageerror", (e) => console.log(`  [pageerror] ${e.message}`));
let failures = 0;
const check = (c, m) => { console.log(`${c ? "ok " : "FAIL"} ${m}`); if (!c) failures++; };
const call = (req) => page.evaluate((r) => window.__pi.worker.call(r), req);
const tool = (name, params) => call({ method: "debugTool", name, params });
const text = (r) => r.content.map((c) => c.text).join("");
const sh = async (c) => { const t0 = Date.now(); const r = await tool("bash", { command: c }); return { out: text(r), ms: Date.now() - t0, err: r.isError }; };
await page.goto("http://localhost:4173/", { waitUntil: "load" });
await page.waitForFunction(() => window.__pi.state().info?.system, { timeout: 180000 });

// latency
const t = await sh("true");
const t2 = await sh("true");
console.log(`  bash -c true: ${t.ms} ms (first), ${t2.ms} ms (second)`);
check(t2.ms < 400, `a trivial command takes ${t2.ms} ms`);

// write, then the file is in the comb without any sync step
let r = await sh("cd workspace && mkdir -p a/b && echo deep > a/b/c.txt && echo top > top.txt && ls -R");
check(!r.err && /c\.txt/.test(r.out), `mkdir -p + writes: ${JSON.stringify(r.out).slice(0, 80)}`);
const tree = await call({ method: "tree", comb: "workspace" });
check(tree.some(([p]) => p === "a/b/c.txt") && tree.some(([p]) => p === "top.txt"), `gfs sees them immediately: ${tree.map(([p]) => p).join(", ")}`);

// an empty directory exists until something else happens
r = await sh("cd workspace && mkdir empty && ls -d empty && rmdir empty && ls");
check(!r.err && /^empty$/m.test(r.out) && !/empty\n.*empty/s.test(r.out), "mkdir/rmdir of an empty directory");

// mv, rm -r, cp between combs
r = await sh("cd workspace && mv top.txt moved.txt && cp a/b/c.txt /nix/copied.txt && rm -r a && ls; ls /nix");
check(!r.err && /moved\.txt/.test(r.out) && !/\ba\b/.test(r.out.split("\n")[0] + r.out.split("\n")[1]) && /copied\.txt/.test(r.out), `mv, cp across combs, rm -r: ${JSON.stringify(r.out).slice(0, 100)}`);
const log = await call({ method: "log", comb: "workspace" });
check(log[0].summary.removed.includes("a/b/c.txt") && log[0].summary.added.includes("moved.txt"), "the rm/mv landed as one entry on workspace");
const nixLog = await call({ method: "log", comb: "nix" });
check(nixLog[0].summary.added.includes("copied.txt") && nixLog[0].kind === "tool_call", "the cp landed on /nix as an entry (machine.json unchanged: no switch)");

// the past, from bash
const past = log[log.length - 2]; // first entry after genesis
r = await sh(`ls /datacombs/workspace@${past.id}; cat /datacombs/workspace@${past.id}/top.txt; echo x > /datacombs/workspace@${past.id}/y.txt; echo exit=$?`);
check(/top\.txt/.test(r.out) && /^top$/m.test(r.out) && /Permission denied|Operation not permitted/.test(r.out), `@entry view from bash is readable and read-only: ${JSON.stringify(r.out).slice(0, 120)}`);

// many small files
r = await sh("cd workspace && for i in $(seq 1 100); do echo $i > f$i.txt; done; ls | wc -l; cat f*.txt | wc -l");
console.log(`  100 files written and read back in ${r.ms} ms`);
check(/^10[0-9]$/m.test(r.out.trim().split("\n")[0]) && /^100$/m.test(r.out), "100 small files");

// a write outside any comb is refused clearly
r = await sh("echo nope > stray.txt; mkdir stray; echo exit=$?");
check(/Permission denied|Operation not permitted/.test(r.out) && /exit=1/.test(r.out), `writing at /datacombs itself is refused: ${JSON.stringify(r.out).slice(0, 100)}`);
await browser.close();
console.log(failures ? `${failures} FAILED` : "all checks passed");
process.exit(failures ? 1 : 0);

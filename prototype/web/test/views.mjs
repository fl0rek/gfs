// PROTOTYPE. Views, plural, and the WayQuest view: every project in datacombs.
// Usage: node test/views.mjs [url] [--maps=gfs:/path/to/.scratch/effort,wayquest:/path/...] [--shots=dir]
// Writes wayfinder maps into combs through pi's own write tool (one history entry per file), opens the
// wayquest view, checks it charts them, then changes a ticket and checks the view follows without a reload.
// Needs: vite preview (COOP/COEP) and Chromium (CHROME).
import puppeteer from "puppeteer-core";
import { readdirSync, readFileSync, mkdirSync } from "node:fs";

const base = process.argv[2]?.startsWith("http") ? process.argv[2] : "http://localhost:4173/";
const arg = (k) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const maps = (arg("maps") ?? "").split(",").filter(Boolean).map((s) => { const [comb, dir] = s.split(":"); return { comb, dir }; });
const shots = arg("shots");
if (shots) mkdirSync(shots, { recursive: true });
if (maps.length < 2) throw new Error("give two maps: --maps=comb:/path/.scratch/<effort>,comb:/path/...");

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME ?? "/tmp/chromium",
  headless: true,
  protocolTimeout: 120000,
  args: ["--no-sandbox", "--disable-gpu", "--enable-features=SharedArrayBuffer"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 860 });
page.on("console", (m) => { if (["error", "warn"].includes(m.type())) console.log(`  [page:${m.type()}] ${m.text()}`); });
page.on("pageerror", (e) => console.log(`  [pageerror] ${e.message}`));
let failures = 0;
const check = (cond, msg) => { console.log(`${cond ? "ok " : "FAIL"} ${msg}`); if (!cond) failures++; };
const state = () => page.evaluate(() => window.__pi.state());
const call = (req) => page.evaluate((r) => window.__pi.worker.call(r), req);
const until = async (pred, label, ms = 60000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await pred()) return true; await new Promise((r) => setTimeout(r, 250)); }
  throw new Error(`timeout waiting for ${label}`);
};
const write = (path, content) => call({ method: "debugTool", name: "write", params: { path, content } });
const frame = () => page.frames().find((f) => f !== page.mainFrame());
const inFrame = async (fn, ...args) => { const f = frame(); return f ? f.evaluate(fn, ...args) : null; };
const shot = async (name) => { if (shots) await page.screenshot({ path: `${shots}/${name}.png` }); };

try {
  await page.goto(base, { waitUntil: "load" });
  await until(async () => (await state()).info !== null || (await state()).error, "worker init");
  check(!(await state()).error, `page up (${(await state()).error ?? "no error"})`);
  const tabs = await page.$$eval(".surfaces .tab", (b) => b.map((x) => x.textContent.trim()));
  check(tabs.includes("view") && tabs.includes("wayquest"), `one tab per view: ${tabs.join(" | ")}`);

  // Two projects, written file by file as pi would.
  for (const { comb, dir } of maps) {
    const effort = dir.replace(/\/+$/, "").split("/").pop();
    await write(`/datacombs/${comb}/.scratch/${effort}/map.md`, readFileSync(`${dir}/map.md`, "utf8"));
    for (const f of readdirSync(`${dir}/issues`).filter((n) => /^\d+.*\.md$/.test(n)).sort())
      await write(`/datacombs/${comb}/.scratch/${effort}/issues/${f}`, readFileSync(`${dir}/issues/${f}`, "utf8"));
  }
  const combs = (await call({ method: "viewRead", op: "combs", arg: "" })).map((c) => c.name);
  check(maps.every((m) => combs.includes(m.comb)), `combs exist: ${combs.join(", ")}`);
  const listed = await call({ method: "viewRead", op: "list", arg: `/datacombs/${maps[0].comb}/.scratch` });
  check(listed.some(([p]) => p.endsWith("/map.md")), `ue.list sees the map (${listed.length} files)`);
  const log = await call({ method: "viewRead", op: "log", arg: maps[0].comb });
  const past = await call({ method: "viewRead", op: "list", arg: `/datacombs/${maps[0].comb}@${log[log.length - 2].id}/.scratch` });
  check(past.length === 1, `@<entry> reads the past (${past.length} file then, ${listed.length} now)`);

  // The wayquest view.
  await page.click(".surfaces .tab:nth-child(3)");
  // One world: a region per comb, so the panel lists every comb, charted or not.
  await until(async () => (await inFrame(() => document.querySelectorAll(".proj-row").length)) === combs.length, "a region for every comb");
  const rows = await inFrame(() => [...document.querySelectorAll(".proj-row")].map((e) => e.querySelector(".name").textContent + " | " + e.querySelector(".proj").textContent));
  check(rows.filter((r) => !r.endsWith("no map")).length === maps.length, `regions: ${rows.join(" / ")}`);
  check(["/datacombs/workspace", "/datacombs/session", "/nix"].every((n) => rows.includes(`${n} | no map`)), "workspace, session and nix are land without a map");
  const world = await inFrame(() => { const c = document.querySelector(".world canvas"); return c && c.width > 0; });
  check(world, "the world is drawn");
  await until(async () => (await inFrame(() => document.querySelectorAll(".feed .row").length)) > 0, "recent changes", 30000);
  const feed = await inFrame(() => document.querySelector(".feed .row")?.innerText);
  check(/pi|session/.test(feed ?? ""), `changes are attributed to the session: ${feed?.replace(/\s+/g, " ").slice(0, 120)}`);
  await new Promise((r) => setTimeout(r, 800));
  await shot("app-atlas");

  // A live change: claim an open ticket as the player; the view re-reads that comb, no reload.
  const effort0 = maps[0].dir.replace(/\/+$/, "").split("/").pop();
  const files0 = readdirSync(`${maps[0].dir}/issues`).filter((n) => /^\d+.*\.md$/.test(n)).sort();
  const open = files0.find((f) => /^Status:\s*open/mi.test(readFileSync(`${maps[0].dir}/issues/${f}`, "utf8")) && !/^Type:\s*(grilling|prototype)/mi.test(readFileSync(`${maps[0].dir}/issues/${f}`, "utf8")))
    ?? files0.find((f) => /^Status:\s*open/mi.test(readFileSync(`${maps[0].dir}/issues/${f}`, "utf8")));
  const before = await inFrame(() => document.querySelector(".needs")?.innerText ?? "");
  const marker = await inFrame(() => { window.__notReloaded = true; return true; });
  const text = readFileSync(`${maps[0].dir}/issues/${open}`, "utf8").replace(/^Status:\s*open\s*$/mi, "Status: claimed\nClaimed by: florek");
  await write(`/datacombs/${maps[0].comb}/.scratch/${effort0}/issues/${open}`, text);
  await until(async () => (await inFrame(() => document.querySelector(".needs")?.innerText ?? "")) !== before, "the view follows the change", 30000);
  check(marker && (await inFrame(() => window.__notReloaded === true)), `the view updated in place (claimed ${open} as the player)`);
  const yours = await inFrame(() => document.querySelector(".needs")?.innerText.includes("your move"));
  check(yours, "the player's claim shows as 'your move' under Needs you");
  await until(async () => (await inFrame(() => document.querySelector(".feed .row")?.innerText ?? "")).includes("held by florek"), "the change in the feed", 30000);
  check(true, "the feed says who took it: " + (await inFrame(() => document.querySelector(".feed .row")?.innerText.replace(/\s+/g, " ").slice(0, 100))));

  // Into one region, and a ticket.
  await (await frame().$(".proj-row")).click();
  await until(async () => !!(await inFrame(() => document.querySelector(".panel .crumbs"))), "a region");
  check(true, `region panel: ${await inFrame(() => document.querySelector(".panel h3")?.textContent)}`);
  await new Promise((r) => setTimeout(r, 800));
  await shot("app-world");
  await (await frame().$(".panel .row.click")).click();
  await until(async () => !!(await inFrame(() => document.querySelector(".panel .kv"))), "a ticket");
  const title = await inFrame(() => document.querySelector(".panel h3")?.textContent);
  check(!!title, `ticket panel: ${title}`);
  await new Promise((r) => setTimeout(r, 500));
  await shot("app-ticket");

  // A view's state survives a reload of the page.
  await page.reload({ waitUntil: "load" });
  await until(async () => (await inFrame(() => document.querySelector(".panel h3")?.textContent)) === title, "the same ticket after a reload", 60000);
  check(true, "after a reload the page reopens the wayquest view on the same ticket");

  // The first view still works.
  await page.click(".surfaces .tab:nth-child(2)");
  await until(async () => (await inFrame(() => document.body.innerText.includes("uptime") || document.body.innerText.length > 200)), "the first view");
  check(true, "the introspection view still renders");
} catch (e) {
  console.log("FAIL", e.message);
  failures++;
  await shot("app-failure");
}
await browser.close();
console.log(failures ? `${failures} failure(s)` : "all ok");
process.exit(failures ? 1 : 0);

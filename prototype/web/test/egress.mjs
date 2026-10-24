// Egress: direct fetch for a CORS-friendly URL; extension bridge for a CORS-less one.
// Runs twice: without and with the unpacked extension loaded.
import puppeteer from "puppeteer-core";
import http from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";

// A local server that sends NO CORS headers → direct fetch from the page must fail.
const nocors = http.createServer((req, res) => { res.writeHead(200, { "content-type": "text/plain" }); res.end(`no-cors server says hi to ${req.url}`); }).listen(4176);

const ext = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../extension");
let failures = 0;
const check = (c, m) => { console.log(`${c ? "ok " : "FAIL"} ${m}`); if (!c) failures++; };

for (const withExt of [false, true]) {
  const args = ["--no-sandbox", "--disable-gpu"];
  if (withExt) args.push(`--disable-extensions-except=${ext}`, `--load-extension=${ext}`);
  const browser = await puppeteer.launch({ executablePath: process.env.CHROME ?? "/tmp/chromium", headless: true, args });
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.log(`  [pageerror] ${e.message}`));
  await page.goto("http://localhost:4173/?shell=none", { waitUntil: "load" });
  await page.waitForFunction(() => window.__pi.state().info !== null, { timeout: 60000 });
  await new Promise((r) => setTimeout(r, 800));
  const st = await page.evaluate(() => window.__pi.state());
  check(!!st.bridgeVersion === withExt, `extension detected = ${!!st.bridgeVersion} (expected ${withExt})`);

  // Drive the fetch tool directly through the agent with a one-off prompt? Simpler: call the worker's smartFetch via a tool call.
  const run = (url) => page.evaluate(async (u) => {
    // use the mock agent's transcript path: ask the worker to run the fetch tool by prompting would be slow; instead use a debug RPC
    return window.__pi.worker.call({ method: "debugFetch", url: u });
  }, url);
  const a = await run("https://api.github.com/repos/fl0rek/gfs");
  check(a.ok && /full_name/.test(a.text), `CORS-friendly URL fetched directly (${a.ok ? a.status : a.error})`);
  const b = await run("http://localhost:4176/x");
  if (withExt) check(b.ok && /no-cors server says hi/.test(b.text), `CORS-less URL fetched through the extension (${b.ok ? b.status : b.error})`);
  else check(!b.ok && /Failed to fetch|bridge/.test(b.error), `CORS-less URL refused without the extension (${b.error})`);
  await browser.close();
}
nocors.close();
console.log(failures ? `${failures} FAILED` : "all checks passed");
process.exit(failures ? 1 : 0);

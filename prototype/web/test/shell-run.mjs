import puppeteer from "puppeteer-core";
const browser = await puppeteer.launch({ executablePath: process.env.CHROME ?? "/tmp/chromium", headless: true, args: ["--no-sandbox", "--disable-gpu"] });
const page = await browser.newPage();
page.on("console", (m) => console.log(`[page:${m.type()}] ${m.text().slice(0, 300)}`));
page.on("pageerror", (e) => console.log(`[pageerror] ${e.message}`));
await page.goto("http://localhost:4173/", { waitUntil: "load" });
await page.waitForFunction(() => window.__pi.state().info !== null, { timeout: 60000 });
for (const cmd of process.argv.slice(2)) {
  const t0 = Date.now();
  try {
    const r = await page.evaluate((c) => window.__pi.worker.call({ method: "shellRun", command: c, timeoutMs: 20000 }), cmd);
    console.log(`$ ${cmd}\n  exit ${r.exitCode} in ${Date.now()-t0}ms\n${r.output.split("\n").map(l=>"  | "+l).join("\n")}`);
  } catch (e) { console.log(`$ ${cmd}\n  failed after ${Date.now()-t0}ms: ${e.message}`); }
}
await browser.close();

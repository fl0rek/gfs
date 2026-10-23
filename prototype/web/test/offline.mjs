// Can the shell run with the Wasmer registry/CDN unreachable? (bundled packages only)
import puppeteer from "puppeteer-core";
const browser = await puppeteer.launch({ executablePath: "/tmp/chromium", headless: true, args: ["--no-sandbox", "--disable-gpu"] });
const page = await browser.newPage();
await page.setRequestInterception(true);
page.on("request", (r) => (r.url().includes("wasmer.io") ? r.abort("failed") : r.continue()));
await page.goto("http://localhost:4173/", { waitUntil: "load" });
await page.waitForFunction(() => window.__pi.state().info !== null, { timeout: 60000 });
try {
  const r = await page.evaluate(() => window.__pi.worker.call({ method: "shellRun", command: "echo offline ok; ls /bin | wc -l; printf 'a\\nb\\n' | grep b; date +%Y", timeoutMs: 60000 }));
  console.log(r.output, "exit", r.exitCode);
} catch (e) { console.log("FAILED:", e.message); }
await browser.close();

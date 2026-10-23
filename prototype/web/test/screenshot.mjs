// Open the page wide, click the newest edit entry, take a screenshot.
import puppeteer from "puppeteer-core";
const browser = await puppeteer.launch({ executablePath: process.env.CHROME ?? "/tmp/chromium", headless: true, args: ["--no-sandbox", "--disable-gpu"] });
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900 });
await page.goto(process.argv[2] ?? "http://localhost:4173/", { waitUntil: "load" });
await page.waitForFunction(() => window.__pi.state().info !== null, { timeout: 60000 });
await page.type("textarea", "Draft a release checklist");
await page.keyboard.press("Enter");
await page.waitForFunction(() => window.__pi.state().busy, { timeout: 10000 });
await page.waitForFunction(() => !window.__pi.state().busy, { timeout: 120000 });
await new Promise((r) => setTimeout(r, 500));
const rows = await page.$$(".item.entry.tool_call");
if (rows.length) await rows[rows.length - 1].click();
await new Promise((r) => setTimeout(r, 800));
await page.screenshot({ path: process.env.SHOT ?? "shot.png" });
await browser.close();

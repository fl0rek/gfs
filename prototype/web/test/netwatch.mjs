// Run e2e while logging any request leaving localhost.
import puppeteer from "puppeteer-core";
const browser = await puppeteer.launch({ executablePath: "/tmp/chromium", headless: true, args: ["--no-sandbox", "--disable-gpu"] });
const page = await browser.newPage();
const ext = new Set();
page.on("request", (r) => { if (!r.url().startsWith("http://localhost")) ext.add(r.url().slice(0, 100)); });
page.on("console", (m) => { if (/bundled packages/.test(m.text())) console.log(m.text()); });
page.on("response", async (r) => { if (r.url().includes("graphql")) { try { console.log("graphql:", (await r.text()).slice(0, 300)); } catch {} } });
page.on("request", (r) => { if (r.url().includes("graphql")) console.log("graphql query:", (r.postData() ?? "").slice(0, 400)); });
await page.goto("http://localhost:4173/", { waitUntil: "load" });
await page.waitForFunction(() => window.__pi.state().info !== null, { timeout: 60000 });
const r = await page.evaluate(() => window.__pi.worker.call({ method: "shellRun", command: "echo bundled ok; ls /bin | head -3; bash --version | head -1", timeoutMs: 60000 }));
console.log(r.output, "exit", r.exitCode);
console.log("external requests:", ext.size ? [...ext] : "none");
await browser.close();

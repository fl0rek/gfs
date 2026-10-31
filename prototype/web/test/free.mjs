// The free-tier router: no keys → clear failure; keys → tries the top awake model per provider,
// rests refused ones (429 → 1 min, 403 → until midnight), and an answering one wins.
// Provider endpoints are intercepted in the browser so no real keys are needed.
import puppeteer from "puppeteer-core";
const browser = await puppeteer.launch({ executablePath: process.env.CHROME ?? "/opt/pw-browsers/chromium-1248/chrome-linux64/chrome", headless: true, protocolTimeout: 180000, args: ["--no-sandbox", "--disable-gpu"] });
const page = await browser.newPage();
page.on("pageerror", (e) => console.log(`  [pageerror] ${e.message}`));
let failures = 0;
const check = (c, m) => { console.log(`${c ? "ok " : "FAIL"} ${m}`); if (!c) failures++; };
const call = (req) => page.evaluate((r) => window.__pi.worker.call(r), req);
const hits = [];
const sse = (text) => [
  `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] })}`,
  `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}`,
  "data: [DONE]", ""].join("\n\n");
await page.setRequestInterception(true);
page.on("request", (r) => {
  const u = r.url();
  const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" };
  if (u.startsWith("http://localhost")) return r.continue();
  if (u.includes("anus.dev")) return r.abort("failed"); // use the snapshot
  if (r.method() === "OPTIONS") return r.respond({ status: 204, headers: cors });
  const host = new URL(u).host;
  hits.push(host + " " + (JSON.parse(r.postData() ?? "{}").model ?? ""));
  if (host.includes("groq")) return r.respond({ status: 429, headers: { ...cors, "content-type": "application/json" }, body: JSON.stringify({ error: { message: "Rate limit reached, too many requests" } }) });
  if (host.includes("cerebras")) return r.respond({ status: 403, headers: { ...cors, "content-type": "application/json" }, body: JSON.stringify({ error: { message: "daily quota exhausted" } }) });
  if (host.includes("openrouter")) return r.respond({ status: 200, headers: { ...cors, "content-type": "text/event-stream" }, body: sse("hello from the free tier") });
  return r.respond({ status: 500, headers: cors, body: "unexpected provider " + host });
});
await page.goto("http://localhost:4173/?shell=none", { waitUntil: "load" });
await page.waitForFunction(() => window.__pi.state().info !== null, { timeout: 60000 });
await new Promise((r) => setTimeout(r, 800));

// 1. no keys
await call({ method: "configure", config: { provider: "free", model: "free", apiKey: "", freeKeys: {} } });
let st0 = await call({ method: "freeStatus" });
check(st0.models.length >= 15 && st0.models.every((m) => m.state === "no key"), `list loaded (${st0.models.length} models), all "no key"`);
await call({ method: "prompt", text: "hi" });
await page.waitForFunction(() => !window.__pi.state().busy, { timeout: 60000 });
let st = await page.evaluate(() => window.__pi.state());
let last = st.transcript.filter((m) => m.role === "assistant").pop();
check(last.stopReason === "error" && /No free model to use/.test(last.errorMessage), `no keys → ${last.errorMessage?.slice(0, 60)}`);

// 2. keys for groq (will 429), cerebras (403) and openrouter (answers)
await call({ method: "configure", config: { provider: "free", model: "free", apiKey: "", freeKeys: { groq: "k1", cerebras: "k2", openrouter: "k3" } } });
await call({ method: "prompt", text: "hi again" });
await page.waitForFunction(() => !window.__pi.state().busy, { timeout: 60000 });
st = await page.evaluate(() => window.__pi.state());
last = st.transcript.filter((m) => m.role === "assistant").pop();
check(last.stopReason !== "error" && /hello from the free tier/.test(last.content.map((c) => c.text ?? "").join("")), `answer came from a free model: ${JSON.stringify(last.content).slice(0, 80)}`);
console.log("  providers tried in order:", hits.join(" → "));
check(hits[0].startsWith("api.cerebras") || hits[0].startsWith("api.groq"), "the list's order was followed (cerebras/groq before openrouter)");
const s2 = await call({ method: "freeStatus" });
const byKey = Object.fromEntries(s2.models.map((m) => [m.key, m]));
const groq = Object.values(byKey).find((m) => m.provider === "groq");
const cer = Object.values(byKey).find((m) => m.provider === "cerebras");
check(groq.state === "resting" && groq.until - Date.now() < 61_000, `groq rests a minute after 429 (${Math.round((groq.until - Date.now()) / 1000)}s)`);
const midnight = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate() + 1);
check(cer.state === "resting" && Math.abs(cer.until - midnight) < 120_000, `cerebras rests until UTC midnight after a quota error (${new Date(cer.until).toISOString()})`);
check(/openrouter/.test(s2.routed ?? ""), `routed = ${s2.routed}`);

// 3. a second prompt skips the resting ones
hits.length = 0;
await call({ method: "prompt", text: "third" });
await page.waitForFunction(() => !window.__pi.state().busy, { timeout: 60000 });
check(hits.length === 1 && hits[0].startsWith("openrouter"), `second request went straight to openrouter (${hits.join(" → ")})`);
await browser.close();
console.log(failures ? `${failures} FAILED` : "all checks passed");
process.exit(failures ? 1 : 0);

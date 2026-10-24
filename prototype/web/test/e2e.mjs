// PROTOTYPE. Drives the built page in headless Chromium.
// Usage: node test/e2e.mjs [url] [--shell=none]
// Needs: a server with COOP/COEP (vite preview), and a Chromium (puppeteer-core + executable path in CHROME).
import puppeteer from "puppeteer-core";

const base = process.argv[2] ?? "http://localhost:4173/";
const shellArg = process.argv.find((a) => a.startsWith("--shell="))?.slice(8);
const url = shellArg ? `${base}?shell=${shellArg}` : base;
const exe = process.env.CHROME ?? "/tmp/chromium";

const extDir = new URL("../../extension", import.meta.url).pathname;
const withExt = process.argv.includes("--extension");
const browser = await puppeteer.launch({
  executablePath: exe,
  headless: true,
  protocolTimeout: 60000,
  args: ["--no-sandbox", "--disable-gpu", "--enable-features=SharedArrayBuffer", ...(withExt ? [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`] : [])],
});
const page = await browser.newPage();
page.on("console", (m) => console.log(`  [page:${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => console.log(`  [pageerror] ${e.message}`));
let failures = 0;
const check = (cond, msg) => {
  console.log(`${cond ? "ok " : "FAIL"} ${msg}`);
  if (!cond) failures++;
};
const state = () => page.evaluate(() => window.__pi.state());
const call = (req) => page.evaluate((r) => window.__pi.worker.call(r), req);
const until = async (pred, label, ms = 120000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await pred()) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timeout waiting for ${label}`);
};

console.log("open", url);
await page.goto(url, { waitUntil: "load" });
await until(async () => (await state()).info !== null || (await state()).error, "worker init");
let s = await state();
check(s.info && !s.error, `worker initialised (${s.error ?? "no error"})`);
check(await page.evaluate(() => crossOriginIsolated), "page is cross-origin isolated");
check(s.info.persistence === "opfs", `persistence = ${s.info.persistence}`);
check(s.info.combs.includes("workspace") && s.info.combs.includes("session"), `combs: ${s.info.combs.join(", ")}`);
const objectsBefore = s.info.objectCount;

// 1. a prompt with the mock model
await page.type("textarea", "Plan the weekend");
await page.keyboard.press("Enter");
await until(async () => (await state()).busy, "agent start", 10000);
await until(async () => !(await state()).busy, "agent end");
s = await state();
check(!s.error, `no error after run (${s.error ?? ""})`);
const roles = s.transcript.map((m) => m.role);
check(roles.filter((r) => r === "toolResult").length >= 4, `tool results in transcript: ${roles.filter((r) => r === "toolResult").length}`);
const results = s.transcript.filter((m) => m.role === "toolResult");
for (const r of results) console.log(`  tool ${r.toolName}: ${r.isError ? "ERROR " : ""}${r.content.map((c) => c.text).join("").slice(0, 160).replace(/\n/g, "⏎")}`);
const bashResult = results.find((r) => r.toolName === "bash");
if (shellArg !== "none") {
  check(bashResult && !bashResult.isError, "bash tool call succeeded");
  check(bashResult && /plan-the-weekend\.md/.test(bashResult.content[0].text), "bash saw the file written by the write tool (ls)");
}

const fetchResult = results.find((r) => r.toolName === "fetch");
check(fetchResult && !fetchResult.isError && /full_name/.test(fetchResult.content[0].text), "fetch tool returned the GitHub API response");
const log = await call({ method: "log", comb: "workspace" });
check(!log.some((e) => e.tool_name === "fetch"), "fetch left no history entry (it changed nothing)");
const kinds = log.map((e) => (e.kind === "tool_call" ? e.tool_name : e.kind)).reverse();
console.log("  workspace history:", kinds.join(" → "));
check(kinds[0] === "genesis", "history starts at genesis");
check(kinds.includes("write") && kinds.includes("edit"), "write and edit tool calls are entries");
if (shellArg !== "none") check(kinds.includes("bash"), "bash tool call is an entry (it changed log.txt)");
const editEntry = log.find((e) => e.tool_name === "edit");
const detail = await call({ method: "entry", entryId: editEntry.id });
check(detail.files.length === 1 && detail.files[0].status === "modified", "edit entry modified exactly one file");
check(/\+.*then edited in place/.test(detail.diffs[detail.files[0].path] ?? ""), "unified diff shows the edit");
check(detail.args && Array.isArray(detail.args.edits), "tool-call arguments are retrievable by hash");
const verify1 = await call({ method: "verify", comb: "workspace" });
check(verify1.ok && verify1.entries === log.length, `chain verifies: ${verify1.entries} entries, ${verify1.objects_checked} objects`);
const sessionLog = await call({ method: "log", comb: "session" });
check(sessionLog.some((e) => e.kind === "turn"), `session comb has turn entries (${sessionLog.length})`);
const treeThen = await call({ method: "treeAt", entryId: log.find((e) => e.tool_name === "write").id });
check(treeThen.length === 1, `tree at the write entry has 1 file: ${treeThen.map((f) => f[0]).join(",")}`);

// 2. rollback to the write entry
const writeId = log.find((e) => e.tool_name === "write").id;
const rbId = await call({ method: "rollback", comb: "workspace", entryId: writeId });
const log2 = await call({ method: "log", comb: "workspace" });
check(log2[0].id === rbId && log2[0].kind === "rollback", "rollback appended a rollback entry at head");
check(log2.length === log.length + 1, "nothing was deleted from history");
const treeNow = await call({ method: "tree", comb: "workspace" });
check(treeNow.length === 1 && treeNow[0][0] === "plan-the-weekend.md", `working tree after rollback: ${treeNow.map((f) => f[0]).join(",")}`);
const fileNow = await call({ method: "file", comb: "workspace", path: "plan-the-weekend.md" });
check(!fileNow.includes("then edited in place"), "file content is the pre-edit version");

// 3. reload: everything must come back from OPFS
await page.reload({ waitUntil: "load" });
await until(async () => (await state()).info !== null || (await state()).error, "worker re-init");
s = await state();
check(s.info && s.info.objectCount > objectsBefore, `objects persisted across reload: ${s.info.objectCount}`);
const log3 = await call({ method: "log", comb: "workspace" });
check(log3.length === log2.length && log3[0].id === rbId, "history identical after reload");
check(s.transcript.length === roles.length + 1, `transcript restored, plus the rollback note (${s.transcript.length} messages)`);
const verify2 = await call({ method: "verify", comb: "workspace" });
check(verify2.ok, "chain still verifies after reload");

// 4. a second prompt continues the same session and sees the rollback note
await page.type("textarea", "Second prompt");
await page.keyboard.press("Enter");
await until(async () => (await state()).busy, "agent start 2", 10000);
await until(async () => !(await state()).busy, "agent end 2");
s = await state();
const userTexts = s.transcript.filter((m) => m.role === "user").map((m) => (typeof m.content === "string" ? m.content : m.content[0].text));
check(userTexts.some((t) => /rolled workspace back/.test(t)), "the model was told about the rollback in the transcript");
const log4 = await call({ method: "log", comb: "workspace" });
check(log4.length > log3.length, `more entries after second prompt: ${log4.length}`);

// 5. "!" passthrough: a direct shell command, recorded as an external entry
if (shellArg !== "none") {
  await page.type("textarea", "!echo manual > by-hand.txt && ls");
  await page.keyboard.press("Enter");
  await until(async () => (await state()).busy, "shell start", 10000);
  await until(async () => !(await state()).busy, "shell end");
  const log5 = await call({ method: "log", comb: "workspace" });
  check(log5[0].kind === "external" && log5[0].author.harness === "shell", `"!" command became an external entry by the shell (${log5[0].kind}/${log5[0].author.harness})`);
  check(log5[0].summary.added.includes("by-hand.txt"), "external entry added by-hand.txt");
  const shown = await page.$$eval(".msg.shell pre", (els) => els.map((e) => e.textContent));
  check(shown.some((t) => /by-hand\.txt/.test(t)), "shell output is shown in the console");
}

await page.screenshot({ path: process.env.SHOT ?? "e2e.png", fullPage: true });
await browser.close();
console.log(failures ? `\n${failures} FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);

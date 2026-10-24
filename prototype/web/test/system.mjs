// /proc and /nix: read /proc, edit /nix/machine.json via the edit tool → switch; bad hash → refused.
import puppeteer from "puppeteer-core";
const browser = await puppeteer.launch({ executablePath: process.env.CHROME ?? "/opt/pw-browsers/chromium-1248/chrome-linux64/chrome", headless: true, protocolTimeout: 120000, args: ["--no-sandbox", "--disable-gpu"] });
const page = await browser.newPage();
page.on("pageerror", (e) => console.log(`  [pageerror] ${e.message}`));
let failures = 0;
const check = (c, m) => { console.log(`${c ? "ok " : "FAIL"} ${m}`); if (!c) failures++; };
const call = (req) => page.evaluate((r) => window.__pi.worker.call(r), req);
const tool = (name, params) => call({ method: "debugTool", name, params });
const text = (r) => r.content.map((c) => c.text).join("");

await page.goto("http://localhost:4173/", { waitUntil: "load" });
await page.waitForFunction(() => window.__pi.state().info !== null, { timeout: 90000 });
let st = await page.evaluate(() => window.__pi.state());
check(st.info.combs.includes("nix"), `combs: ${st.info.combs.join(", ")}`);
check(st.info.system?.entry, `running system is /nix@${st.info.system?.entry?.slice(0, 8)}`);

// /proc
const procList = text(await tool("read", { path: "/proc" }));
check(/session[\s\S]*system[\s\S]*mounts/.test(procList), `/proc lists: ${procList.trim().split("\n").join(" ")}`);
const sys = JSON.parse(text(await tool("read", { path: "/proc/system" })));
check(sys.entry === st.info.system.entry && sys.shell === "bash", `/proc/system agrees with the header (shell ${sys.shell}, ${sys.packages.length} packages)`);
const shellInfo = JSON.parse(text(await tool("read", { path: "/proc/shell" })));
check(shellInfo.commands.includes("bash") && shellInfo.commands.includes("ls"), `/proc/shell lists ${shellInfo.commands.length} commands`);
const combs = text(await tool("read", { path: "/proc/combs" }));
check(/^nix\t[0-9a-f]{64}$/m.test(combs), "/proc/combs has heads");
let err = null;
try { await tool("write", { path: "/proc/session", content: "x" }); } catch (e) { err = e.message; }
check(/read-only/.test(err ?? ""), `/proc is read-only (${err})`);

// /nix contents
const readme = text(await tool("read", { path: "/nix/README.md" }));
check(/commit = switch|switch/.test(readme), "/nix/README.md explains the switch");
const flake = text(await tool("read", { path: "/nix/flake.nix" }));
check(flake.length > 20, `/nix/flake.nix present (${flake.length} chars)`);
const before = await call({ method: "log", comb: "nix" });

// 1. a no-op change to machine.json (rename the system) → entry + switch
const m = JSON.parse(text(await tool("read", { path: "/nix/machine.json" })));
await tool("edit", { path: "/nix/machine.json", edits: [{ oldText: `"name": "${m.name}"`, newText: `"name": "renamed system"` }] });
await new Promise((r) => setTimeout(r, 500));
const after1 = await call({ method: "log", comb: "nix" });
check(after1.length === before.length + 1 && after1[0].tool_name === "edit", "editing machine.json made a history entry on /nix");
st = await page.evaluate(() => window.__pi.state());
check(st.info.system.entry === after1[0].id, `system switched to the new entry /nix@${after1[0].id.slice(0, 8)}`);
const sys2 = JSON.parse(text(await tool("read", { path: "/proc/system" })));
check(sys2.name === "renamed system", "/proc/system shows the new manifest");
const ls = await tool("bash", { command: "echo still alive; ls" });
check(!ls.isError && /still alive/.test(text(ls)), "bash works after the switch");

// 2. a bad hash → refused, old system keeps running
const bad = { ...sys2, packages: undefined };
const m2 = JSON.parse(text(await tool("read", { path: "/nix/machine.json" })));
const corrupt = { ...m2, packages: m2.packages.map((p, i) => (i === 0 ? { ...p, sha256: "0".repeat(64) } : p)) };
await tool("write", { path: "/nix/machine.json", content: JSON.stringify(corrupt, null, 2) + "\n" });
await new Promise((r) => setTimeout(r, 500));
const after2 = await call({ method: "log", comb: "nix" });
st = await page.evaluate(() => window.__pi.state());
check(after2.length === after1.length + 1, "the bad manifest is still recorded as history");
check(st.info.system.entry === after1[0].id, "but the running system did not change");
check(/refused|mismatch/.test(st.error ?? ""), `and the refusal is reported: ${st.error?.slice(0, 100)}`);
const ls2 = await tool("bash", { command: "echo survivor" });
check(!ls2.isError && /survivor/.test(text(ls2)), "bash still works on the old system");

// 3. roll /nix back → switch back
await call({ method: "rollback", comb: "nix", entryId: after1[0].id });
await new Promise((r) => setTimeout(r, 1500));
const after3 = await call({ method: "log", comb: "nix" });
st = await page.evaluate(() => window.__pi.state());
check(after3[0].kind === "rollback", "rollback entry on /nix");
const sys3 = JSON.parse(text(await tool("read", { path: "/proc/system" })));
check(sys3.name === "renamed system" && st.info.system.entry === after3[0].id, `rollback switched the system (now /nix@${after3[0].id.slice(0, 8)})`);

// 4. reload: the system comes back from the comb
await page.reload({ waitUntil: "load" });
await page.waitForFunction(() => window.__pi.state().info !== null, { timeout: 90000 });
st = await page.evaluate(() => window.__pi.state());
check(st.info.system.entry === after3[0].id, "after reload the running system is the comb's head");

await browser.close();
console.log(failures ? `${failures} FAILED` : "all checks passed");
process.exit(failures ? 1 : 0);

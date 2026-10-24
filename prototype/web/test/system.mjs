// /nix: edit machine.json via the edit tool → switch; bad hash → refused; rollback → switch back; reload.
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
await page.waitForFunction(() => window.__pi.state().info?.system || /unavailable|refused|failed/.test(window.__pi.state().statusText), { timeout: 180000 });
let st = await page.evaluate(() => window.__pi.state());
check(st.info.combs.includes("nix"), `combs: ${st.info.combs.join(", ")}`);
check(st.info.system?.entry, `running system is /nix@${st.info.system?.entry?.slice(0, 8)}`);

// /nix contents
const readme = text(await tool("read", { path: "/nix/README.md" }));
check(/switch/.test(readme), "/nix/README.md explains the switch");
const flake = text(await tool("read", { path: "/nix/flake.nix" }));
check(flake.length > 20, `/nix/flake.nix present (${flake.length} chars)`);
const before = await call({ method: "log", comb: "nix" });

// 1. a no-op change to machine.json (rename the system) → entry + switch
const m = JSON.parse(text(await tool("read", { path: "/nix/machine.json" })));
await tool("edit", { path: "/nix/machine.json", edits: [{ oldText: `"name": "${m.name}"`, newText: `"name": "renamed system"` }] });
await new Promise((r) => setTimeout(r, 500));
await page.waitForFunction((n) => window.__pi.state().logs.nix?.length >= n + 2, { timeout: 60000 }, before.length);
const after1 = await call({ method: "log", comb: "nix" });
check(after1[1].tool_name === "edit", "editing machine.json made a history entry on /nix");
check(after1[0].kind === "switch" && after1[0].at_entry === after1[1].id && after1[0].previous === st.info.system.entry, `…followed by a switch entry (now @${after1[0].at_entry.slice(0, 8)}, was @${(after1[0].previous ?? "").slice(0, 8)})`);
st = await page.evaluate(() => window.__pi.state());
check(st.info.system.entry === after1[1].id, `system switched to the new entry /nix@${after1[1].id.slice(0, 8)}`);
check(st.info.system.name === "renamed system", "the header shows the new manifest");
const ls = await tool("bash", { command: "echo still alive; ls" });
check(!ls.isError && /still alive/.test(text(ls)), "bash works after the switch");

// 2. a bad hash → refused, old system keeps running
const m2 = JSON.parse(text(await tool("read", { path: "/nix/machine.json" })));
const corrupt = { ...m2, packages: m2.packages.map((p, i) => (i === 0 ? { ...p, sha256: "0".repeat(64) } : p)) };
await tool("write", { path: "/nix/machine.json", content: JSON.stringify(corrupt, null, 2) + "\n" });
await new Promise((r) => setTimeout(r, 500));
const after2 = await call({ method: "log", comb: "nix" });
st = await page.evaluate(() => window.__pi.state());
check(after2.length === after1.length + 1 && after2[0].kind !== "switch", "the bad manifest is still recorded as history, with no switch entry");
check(st.info.system.entry === after1[1].id, "but the running system did not change");
check(/refused|mismatch/.test(st.error ?? ""), `and the refusal is reported: ${st.error?.slice(0, 100)}`);
const ls2 = await tool("bash", { command: "echo survivor" });
check(!ls2.isError && /survivor/.test(text(ls2)), "bash still works on the old system");

// 3. roll /nix back → switch back
await call({ method: "rollback", comb: "nix", entryId: after1[1].id });
await new Promise((r) => setTimeout(r, 1500));
const after3 = await call({ method: "log", comb: "nix" });
st = await page.evaluate(() => window.__pi.state());
check(after3[0].kind === "rollback", "rollback entry on /nix");
check(st.info.system.name === "renamed system" && st.info.system.entry === after3[0].id, `rollback switched the system (now /nix@${after3[0].id.slice(0, 8)})`);
const ws = await page.evaluate(() => { const sel = document.querySelector(".pane.timeline select"); sel.value = "workspace"; sel.dispatchEvent(new Event("change")); return true; });
await new Promise((r) => setTimeout(r, 500));
const tags = await page.$$eval(".item.entry .tag", (els) => els.map((e) => e.textContent));
check(tags.includes("system"), `the workspace timeline shows the switch too (${tags.filter((t) => t === "system").length} system events)`);

// 4. reload: the system comes back from the comb
await page.reload({ waitUntil: "load" });
await page.waitForFunction(() => window.__pi.state().info?.system || /unavailable|refused|failed/.test(window.__pi.state().statusText), { timeout: 180000 });
st = await page.evaluate(() => window.__pi.state());
check(st.info.system.entry === after3[0].id, "after reload the running system is the comb's head");

await browser.close();
console.log(failures ? `${failures} FAILED` : "all checks passed");
process.exit(failures ? 1 : 0);

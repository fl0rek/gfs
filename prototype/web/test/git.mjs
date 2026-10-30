// PROTOTYPE. Combs backed by git, end to end in headless Chromium.
// Usage: node test/git.mjs [page-url]   (needs `pnpm build && pnpm preview` on :4173, CHROME=<chromium>)
//
// Starts its own servers: git http-backend with CORS (a Forgejo stand-in, with OAuth+PKCE)
// on :4177, the same without CORS (github.com-like) on :4179, and a fake GitHub REST API
// on :4178. Every repository it writes is checked with the git CLI (log, show, fsck).
import puppeteer from "puppeteer-core";
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const base = process.argv[2] ?? "http://localhost:4173/";
const exe = process.env.CHROME ?? "/tmp/chromium";
const ext = path.resolve(here, "../../extension");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gfs-git-e2e-"));
const root = path.join(tmp, "repos");
fs.mkdirSync(root);

let failures = 0;
const check = (c, m) => {
  console.log(`${c ? "ok " : "FAIL"} ${m}`);
  if (!c) failures++;
};
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, GIT_AUTHOR_NAME: "elsewhere", GIT_AUTHOR_EMAIL: "e@x", GIT_COMMITTER_NAME: "elsewhere", GIT_COMMITTER_EMAIL: "e@x" }, ...opts }).trim();
const git = (repo, ...args) => sh("git", ["--git-dir", path.join(root, repo), ...args]);
const tryGit = (repo, ...args) => {
  try {
    return git(repo, ...args);
  } catch {
    return null;
  }
};
const bare = (name) => sh("git", ["init", "-q", "--bare", "-b", "main", path.join(root, name)]);
/** Someone else commits to `repo` (through the filesystem, not HTTP). */
function commitElsewhere(repo, file, content) {
  const wt = fs.mkdtempSync(path.join(tmp, "wt-"));
  sh("git", ["clone", "-q", path.join(root, repo), wt]);
  fs.writeFileSync(path.join(wt, file), content);
  sh("git", ["-C", wt, "add", "-A"]);
  sh("git", ["-C", wt, "commit", "-q", "-m", `elsewhere: ${file}`]);
  sh("git", ["-C", wt, "push", "-q", "origin", "HEAD:main"]);
  return sh("git", ["-C", wt, "rev-parse", "HEAD"]);
}

// ----- repositories -----
for (const r of ["ws.git", "oauth.git", "gh.git", "nocors.git"]) bare(r);
{
  const wt = path.join(tmp, "seed-wt");
  sh("git", ["init", "-q", "-b", "main", wt]);
  fs.writeFileSync(path.join(wt, "README.md"), "# seeded\n");
  fs.writeFileSync(path.join(wt, "tool.sh"), "#!/bin/sh\necho tool\n", { mode: 0o755 });
  fs.symlinkSync("README.md", path.join(wt, "link"));
  sh("git", ["-C", wt, "add", "-A"]);
  sh("git", ["-C", wt, "commit", "-q", "-m", "seed"]);
  sh("git", ["clone", "-q", "--bare", wt, path.join(root, "seed.git")]);
}

// ----- servers -----
const kids = [
  spawn("node", [path.join(here, "git-server.mjs"), root, "4177"], { stdio: "inherit" }),
  spawn("node", [path.join(here, "git-server.mjs"), root, "4179", "--no-cors"], { stdio: "inherit" }),
  spawn("node", [path.join(here, "fake-github.mjs"), path.join(root, "gh.git"), "4178"], { stdio: "inherit" }),
];
await new Promise((r) => setTimeout(r, 800));

async function open(withExt) {
  const args = ["--no-sandbox", "--disable-gpu"];
  if (withExt) args.push(`--disable-extensions-except=${ext}`, `--load-extension=${ext}`);
  const browser = await puppeteer.launch({ executablePath: exe, headless: true, protocolTimeout: 120000, args });
  const page = await browser.newPage();
  page.on("console", (m) => /^git\[/.test(m.text()) && console.log(`  [page] ${m.text()}`));
  page.on("pageerror", (e) => console.log(`  [pageerror] ${e.message}`));
  return { browser, page };
}

const ctx = (page) => {
  const state = () => page.evaluate(() => window.__pi.state());
  const call = (req) => page.evaluate((r) => window.__pi.worker.call(r), req);
  const until = async (pred, label, ms = 60000) => {
    const t0 = Date.now();
    let last;
    while (Date.now() - t0 < ms) {
      last = await pred();
      if (last) return last;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`timeout waiting for ${label}`);
  };
  const remote = async (comb) => (await state()).remoteStatus.find((r) => r.comb === comb);
  const settled = (comb, want = "synced", ms) =>
    until(async () => {
      const r = await remote(comb);
      return r && r.state === want && (want !== "synced" || r.ahead === 0) ? r : null;
    }, `${comb} ${want}`, ms);
  const workerEval = (code) =>
    page.evaluate(
      (code) =>
        new Promise((resolve) => {
          const tag = Math.random().toString(36).slice(2);
          const w = window.__pi.worker.worker;
          const on = (e) => {
            if (e.data?.debugEvalResult !== tag) return;
            w.removeEventListener("message", on);
            resolve(e.data.out);
          };
          w.addEventListener("message", on);
          w.postMessage({ debugEval: code, tag });
        }),
      code,
    );
  const newComb = (name) => workerEval(`if (!__dbg.dc.hasComb(${JSON.stringify(name)})) await __dbg.dc.createComb(${JSON.stringify(name)}, { session: "test", harness: "test", model: "", principal: "user" }); return "ok";`);
  const boot = async (url) => {
    await page.goto(url, { waitUntil: "load" });
    await page.waitForFunction(() => window.__pi && (window.__pi.state().info !== null || window.__pi.state().error), { timeout: 60000 });
    await until(async () => Array.isArray((await state()).remoteStatus), "remotes configured");
  };
  return { state, call, until, remote, settled, workerEval, newComb, boot };
};

const gitRemote = (comb, repo, port = 4177, extra = {}) => ({ comb, transport: "git", url: `http://127.0.0.1:${port}/${repo}`, branch: "main", username: "gfs", token: "secret-token", auto: true, ...extra });

try {
  // ======================= phase 1: plain tab, no extension =======================
  {
    const { browser, page } = await open(false);
    const t = ctx(page);
    await t.boot(`${base}?shell=none`);
    check(!(await t.state()).bridgeVersion, "phase 1 runs without the extension");

    // --- 1. push: every entry becomes a commit ---
    await page.evaluate((c) => window.__pi.connect(c), gitRemote("workspace", "ws.git"));
    await t.call({ method: "prompt", text: "Plan the weekend" });
    await t.until(async () => {
      const tr = await t.call({ method: "transcript" });
      return !(await t.state()).busy && tr.some((m) => m.role === "assistant" && m.stopReason === "stop");
    }, "the scripted agent's run", 60000);
    let st = await t.settled("workspace");
    const log = await t.call({ method: "log", comb: "workspace" });
    const withFiles = log.filter((e) => e.kind !== "genesis");
    const commits = git("ws.git", "rev-list", "main").split("\n");
    check(commits.length === withFiles.length, `one git commit per history entry (${commits.length} commits, ${withFiles.length} entries)`);
    const tipMsg = git("ws.git", "log", "-1", "--format=%an <%ae>%n%cn <%ce>%n%B", "main");
    check(tipMsg.includes(`Gfs-Entry: ${log[0].id}`), "tip commit carries the head entry's id");
    check(/^pi \(mock\/scripted-agent\) <pi-.*@browser-node>\nbrowser-node <browser-node@gfs.invalid>/.test(tipMsg), `author is the session, committer the node (${tipMsg.split("\n").slice(0, 2).join(" | ")})`);
    const file = withFiles.find((e) => e.tool_name === "write").summary.added[0];
    check(git("ws.git", "show", `main:${file}`) === (await t.call({ method: "file", comb: "workspace", path: file })).trim(), `git has ${file} as the comb has it`);
    check(st.pushed[log[0].id] === commits[0], "the page knows which commit stands for the head entry");
    check(tryGit("ws.git", "fsck", "--strict", "--no-dangling") !== null, "git fsck --strict passes on what the browser pushed");

    const machine = await t.call({ method: "debugTool", name: "read", params: { path: "/machine/git" } });
    const mtext = machine.content.map((c) => c.text).join("");
    check(/"comb": "workspace"/.test(mtext) && /"state": "synced"/.test(mtext), "/machine/git shows the comb's remote and sync state to the harness");

    // --- 2. auto-propagation of a hand edit ---
    await t.call({ method: "saveFile", comb: "workspace", path: "notes/by-hand.txt", content: "edited in the Files view\n" });
    await t.until(async () => tryGit("ws.git", "show", "main:notes/by-hand.txt") === "edited in the Files view", "hand edit pushed", 20000);
    check(true, "a hand edit was pushed on its own, without asking");

    // --- 3. someone else pushes: the comb pulls ---
    const theirs = commitElsewhere("ws.git", "from-elsewhere.txt", "pushed by someone else\n");
    await t.call({ method: "remoteSync", comb: "workspace" });
    st = await t.settled("workspace");
    const head = (await t.call({ method: "log", comb: "workspace" }))[0];
    check(head.kind === "pull" && head.commit === theirs, `their commit landed as a pull entry (${head.kind} ${head.commit?.slice(0, 8)})`);
    check((await t.call({ method: "file", comb: "workspace", path: "from-elsewhere.txt" })) === "pushed by someone else\n", "their file is in the comb");
    check(git("ws.git", "rev-parse", "main") === theirs, "pulling pushed nothing back (the remote tip is still theirs)");

    // --- 4. both moved: diverged → keep mine ---
    const theirs2 = commitElsewhere("ws.git", "theirs-2.txt", "two\n");
    await t.call({ method: "saveFile", comb: "workspace", path: "mine-2.txt", content: "mine\n" });
    st = await t.settled("workspace", "diverged", 20000);
    check(st.diverged === theirs2, "a local entry plus a remote commit = diverged, nothing merged on its own");
    await t.call({ method: "remoteResolve", comb: "workspace", choice: "mine" });
    st = await t.settled("workspace");
    const parents = git("ws.git", "rev-list", "--parents", "-n", "1", "main").split(" ");
    check(parents.length === 3 && parents.includes(theirs2), "keep mine: the new tip merges their commit as a second parent");
    check(git("ws.git", "show", "main:mine-2.txt") === "mine" && tryGit("ws.git", "show", "main:theirs-2.txt") === null, "keep mine: the tree is ours");
    check(tryGit("ws.git", "merge-base", "--is-ancestor", theirs2, "main") !== null, "no force push: their commit stays reachable");

    // --- 5. both moved again: take theirs ---
    const theirs3 = commitElsewhere("ws.git", "theirs-3.txt", "three\n");
    await t.call({ method: "saveFile", comb: "workspace", path: "mine-3.txt", content: "mine three\n" });
    await t.settled("workspace", "diverged", 20000);
    await t.call({ method: "remoteResolve", comb: "workspace", choice: "theirs" });
    st = await t.settled("workspace");
    check((await t.call({ method: "file", comb: "workspace", path: "theirs-3.txt" })) === "three\n", "take theirs: their file is in the comb");
    check(tryGit("ws.git", "show", "main:mine-3.txt") === null, "take theirs: the tip tree is theirs");
    check(git("ws.git", "log", "--format=%s", "main").includes("external: add mine-3.txt"), "take theirs: our entry is still in git history, under the merge");
    check(tryGit("ws.git", "fsck", "--strict", "--no-dangling") !== null, "git fsck passes after merges");

    // --- 6. a clone with exec bits and symlinks round-trips ---
    await t.newComb("seeded");
    await page.evaluate((c) => window.__pi.connect(c), gitRemote("seeded", "seed.git"));
    await t.settled("seeded");
    check((await t.call({ method: "file", comb: "seeded", path: "link" })) === "README.md", "a symlink arrives as a file holding its target");
    await t.call({ method: "saveFile", comb: "seeded", path: "README.md", content: "# seeded, then edited in gfs\n" });
    await t.until(async () => /edited in gfs/.test(tryGit("seed.git", "show", "main:README.md") ?? ""), "seeded edit pushed", 20000);
    const modes = git("seed.git", "ls-tree", "main");
    check(/^100755 blob \S+\ttool.sh$/m.test(modes) && /^120000 blob \S+\tlink$/m.test(modes), "exec bit and symlink survive the round trip through gfs");

    // --- 7. GitHub REST API transport (fake), empty repository ---
    await t.newComb("ghcomb");
    await t.call({ method: "saveFile", comb: "ghcomb", path: "a.txt", content: "one\n" });
    await t.call({ method: "saveFile", comb: "ghcomb", path: "dir/b.txt", content: "two\n" });
    await page.evaluate((c) => window.__pi.connect(c), { comb: "ghcomb", transport: "github", url: "http://127.0.0.1:4178/owner/repo", branch: "main", token: "ghtoken", auto: true });
    st = await t.settled("ghcomb");
    check(git("gh.git", "rev-list", "--count", "main") === "2", "GitHub API: two entries, two commits");
    check(tryGit("gh.git", "show", "main:.gfs-bootstrap") === null && git("gh.git", "show", "main:dir/b.txt") === "two", "GitHub API: the empty-repo bootstrap commit was replaced by ours");
    check(st.events.some((e) => /commit ids match the local encoding/.test(e.text)), "GitHub API: the server's commit ids equal the ones git.rs computes");
    check(tryGit("gh.git", "fsck", "--strict", "--no-dangling") !== null, "GitHub API: git fsck passes");
    {
      const wt = fs.mkdtempSync(path.join(tmp, "ghwt-"));
      sh("git", ["clone", "-q", path.join(root, "gh.git"), wt]);
      fs.mkdirSync(path.join(wt, "x"));
      fs.writeFileSync(path.join(wt, "x/run.sh"), "#!/bin/sh\n", { mode: 0o755 });
      sh("git", ["-C", wt, "add", "-A"]);
      sh("git", ["-C", wt, "commit", "-q", "-m", "from elsewhere"]);
      sh("git", ["-C", wt, "push", "-q", "origin", "HEAD:main"]);
    }
    await t.call({ method: "remoteSync", comb: "ghcomb" });
    await t.settled("ghcomb");
    check((await t.call({ method: "file", comb: "ghcomb", path: "x/run.sh" })) === "#!/bin/sh\n", "GitHub API: a remote commit is pulled through the REST API (tree rebuilt and verified)");

    // --- 8. github.com-like server (no CORS), no extension: a clear refusal ---
    await t.newComb("nocors");
    await t.call({ method: "saveFile", comb: "nocors", path: "f.txt", content: "x\n" });
    await page.evaluate((c) => window.__pi.connect(c), gitRemote("nocors", "nocors.git", 4179));
    st = await t.settled("nocors", "error", 20000);
    check(/CORS/.test(st.error), `without CORS or the extension the comb says why (${st.error.slice(0, 90)}…)`);

    // --- 9. device flow without the extension: refused, with the reason ---
    const dev = await page.evaluate(() => window.__pi.worker.call({ method: "loginDeviceStart", host: "http://127.0.0.1:4178", clientId: "Iv1.gfs-test", scope: "repo" }).then(() => "ok", (e) => e.message));
    check(/no CORS/.test(dev), `GitHub-style device flow needs the extension (${dev.slice(0, 80)}…)`);

    // --- 10. Forgejo-style OAuth2 + PKCE, a real redirect ---
    await t.newComb("oauthcomb");
    await t.call({ method: "saveFile", comb: "oauthcomb", path: "signed-in.txt", content: "via oauth\n" });
    await Promise.all([
      page.waitForNavigation({ waitUntil: "load" }),
      page.evaluate(() => window.__pi.signInForgejo({ comb: "oauthcomb", transport: "git", url: "http://127.0.0.1:4177/oauth.git", branch: "main", username: "", token: "", auto: true }, "gfs-test-client")),
    ]);
    await page.waitForFunction(() => window.__pi && window.__pi.state().info !== null, { timeout: 60000 });
    await t.until(async () => (await t.state()).remoteConfigs.some((c) => c.comb === "oauthcomb"), "oauth config saved");
    const cfg = (await t.state()).remoteConfigs.find((c) => c.comb === "oauthcomb");
    check(cfg.oauth?.flow === "forgejo-pkce" && cfg.token && cfg.token !== "secret-token" && cfg.oauth.refreshToken, "PKCE: code exchanged for an access + refresh token, kept in localStorage");
    check(!(await page.evaluate(() => location.search)).includes("code="), "PKCE: the code was stripped from the URL");
    await t.settled("oauthcomb", "synced", 30000);
    check(git("oauth.git", "show", "main:signed-in.txt") === "via oauth", "PKCE: the issued token pushes over git HTTP");
    await browser.close();
  }

  // ======================= phase 2: with the egress extension =======================
  {
    const { browser, page } = await open(true);
    const t = ctx(page);
    await t.boot(`${base}?shell=none`);
    await t.until(async () => (await t.state()).bridgeVersion, "extension detected", 10000);
    await t.newComb("nocors");
    await t.call({ method: "saveFile", comb: "nocors", path: "f.txt", content: "through the extension\n" });
    await page.evaluate((c) => window.__pi.connect(c), gitRemote("nocors", "nocors.git", 4179));
    await t.settled("nocors", "synced", 30000);
    check(git("nocors.git", "show", "main:f.txt") === "through the extension", "a CORS-less git server (github.com-like) works through the extension");
    const code = await t.call({ method: "loginDeviceStart", host: "http://127.0.0.1:4178", clientId: "Iv1.gfs-test", scope: "repo" });
    check(code.user_code === "GFS-TEST", "device flow: code issued through the extension");
    let tok = null;
    for (let i = 0; i < 5 && !tok; i++) {
      const r = await t.call({ method: "loginDevicePoll", host: "http://127.0.0.1:4178", clientId: "Iv1.gfs-test", deviceCode: code.device_code });
      if (r.token) tok = r.token;
    }
    check(tok && /^ghu_/.test(tok.access_token) && tok.refresh_token, "device flow: polling yields a token once approved");

    // A fresh browser profile is another browser: connect, and the comb comes back from git.
    await page.evaluate((c) => window.__pi.connect(c), gitRemote("workspace", "ws.git"));
    await t.settled("workspace", "synced", 30000);
    const files = (await t.call({ method: "tree", comb: "workspace" })).map(([p]) => p).sort();
    const want = git("ws.git", "ls-tree", "-r", "--name-only", "main").split("\n").sort();
    check(JSON.stringify(files) === JSON.stringify(want), `another browser: connecting a fresh comb pulls the remote tree (${files.length} files)`);
    await browser.close();
  }
} catch (e) {
  console.log(`FAIL ${e.stack ?? e}`);
  failures++;
} finally {
  for (const k of kids) k.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(failures ? `${failures} FAILED` : "all checks passed");
process.exit(failures ? 1 : 0);

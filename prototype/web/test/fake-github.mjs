// PROTOTYPE test fixture: the slice of GitHub's REST API the GitHub transport uses
// (Git Data endpoints + contents PUT), backed by a real bare repository through git
// plumbing, served GitHub-Enterprise style under /api/v3 with CORS. Plus the device
// flow at /login/*, WITHOUT CORS, as github.com does it.
//
// It checks request shapes against GitHub's documentation as read for this prototype,
// not GitHub itself; the repository it writes is checked with git fsck by the test.
//
// Usage: node test/fake-github.mjs <bare-repo-dir> <port>     token: "ghtoken" (or one from the device flow)
import http from "node:http";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const [repo, port = "4178"] = process.argv.slice(2);
const tokens = new Set(["ghtoken"]);
const devices = new Map(); // device_code → {approved, polls}
export const DEVICE_CLIENT = "Iv1.gfs-test";

const git = (args, opts = {}) => execFileSync("git", ["--git-dir", repo, ...args], { encoding: opts.encoding ?? "utf8", input: opts.input, env: { ...process.env, ...opts.env } });
const tryGit = (args) => {
  try {
    return git(args).trim();
  } catch {
    return null;
  }
};
const isEmpty = () => !git(["for-each-ref"]).trim();

const corsHeaders = (req) => ({
  "Access-Control-Allow-Origin": req.headers.origin ?? "*",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, Accept, X-GitHub-Api-Version",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, PUT, OPTIONS",
});

async function readBody(req) {
  const parts = [];
  for await (const c of req) parts.push(c);
  return Buffer.concat(parts).toString();
}

function toGitDate(iso) {
  return `@${Math.floor(new Date(iso).getTime() / 1000)} +0000`;
}

http
  .createServer(async (req, res) => {
    const u = new URL(req.url, "http://x");
    const send = (status, json, headers = {}) => {
      res.writeHead(status, { "Content-Type": "application/json", ...headers });
      res.end(JSON.stringify(json));
    };

    // ----- device flow, github.com style: no CORS -----
    if (u.pathname.startsWith("/login/")) {
      if (req.method === "OPTIONS") {
        res.writeHead(404);
        return res.end();
      }
      const form = new URLSearchParams(await readBody(req));
      if (form.get("client_id") !== DEVICE_CLIENT) return send(200, { error: "incorrect_client_credentials" });
      if (u.pathname === "/login/device/code") {
        const device_code = randomBytes(10).toString("hex");
        devices.set(device_code, { polls: 0 });
        return send(200, { device_code, user_code: "GFS-TEST", verification_uri: `http://127.0.0.1:${port}/login/device`, expires_in: 900, interval: 1 });
      }
      if (u.pathname === "/login/oauth/access_token") {
        const d = devices.get(form.get("device_code"));
        if (!d) return send(200, { error: "expired_token" });
        if (++d.polls < 2) return send(200, { error: "authorization_pending" }); // the user approves on the second poll
        devices.delete(form.get("device_code"));
        const t = `ghu_${randomBytes(12).toString("hex")}`;
        tokens.add(t);
        return send(200, { access_token: t, token_type: "bearer", scope: "", expires_in: 28800, refresh_token: `ghr_${randomBytes(12).toString("hex")}` });
      }
      return send(404, { message: "Not Found" });
    }

    // ----- REST API -----
    const h = corsHeaders(req);
    if (req.method === "OPTIONS") {
      res.writeHead(204, h);
      return res.end();
    }
    const reply = (status, json) => send(status, json, h);
    const auth = (req.headers.authorization ?? "").replace(/^(Bearer|token) /, "");
    if (!tokens.has(auth)) return reply(401, { message: "Bad credentials" });
    const m = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(u.pathname);
    if (!m) return reply(404, { message: "Not Found" });
    const rest = m[3] ?? "";
    const body = req.method === "GET" ? null : JSON.parse((await readBody(req)) || "{}");

    try {
      if (rest === "" && req.method === "GET") return reply(200, { default_branch: "main", full_name: `${m[1]}/${m[2]}` });
      let r;
      if ((r = /^\/git\/ref\/heads\/(.+)$/.exec(rest)) && req.method === "GET") {
        if (isEmpty()) return reply(409, { message: "Git Repository is empty." });
        const sha = tryGit(["rev-parse", "--verify", `refs/heads/${decodeURIComponent(r[1])}`]);
        return sha ? reply(200, { ref: `refs/heads/${r[1]}`, object: { sha, type: "commit" } }) : reply(404, { message: "Not Found" });
      }
      if ((r = /^\/git\/commits\/([0-9a-f]{40})$/.exec(rest)) && req.method === "GET") {
        const tree = git(["rev-parse", `${r[1]}^{tree}`]).trim();
        const parents = git(["rev-list", "--parents", "-n", "1", r[1]]).trim().split(" ").slice(1);
        return reply(200, { sha: r[1], tree: { sha: tree }, parents: parents.map((sha) => ({ sha })) });
      }
      if ((r = /^\/git\/trees\/([0-9a-f]{40})$/.exec(rest)) && req.method === "GET") {
        const rows = git(["ls-tree", "-r", "-t", "--full-tree", r[1]]).split("\n").filter(Boolean);
        const tree = rows.map((row) => {
          const [meta, p] = row.split("\t");
          const [mode, type, sha] = meta.split(" ");
          return { path: p, mode, type, sha };
        });
        return reply(200, { sha: r[1], tree, truncated: false });
      }
      if ((r = /^\/git\/blobs\/([0-9a-f]{40})$/.exec(rest)) && req.method === "GET") {
        const content = execFileSync("git", ["--git-dir", repo, "cat-file", "blob", r[1]]);
        return reply(200, { sha: r[1], content: content.toString("base64").replace(/(.{60})/g, "$1\n"), encoding: "base64", size: content.length });
      }
      if (rest === "/git/blobs" && req.method === "POST") {
        if (isEmpty()) return reply(409, { message: "Git Repository is empty." });
        const sha = git(["hash-object", "-w", "--stdin"], { input: Buffer.from(body.content, body.encoding === "base64" ? "base64" : "utf8") }).trim();
        return reply(201, { sha });
      }
      if (rest === "/git/trees" && req.method === "POST") {
        if (isEmpty()) return reply(409, { message: "Git Repository is empty." });
        const index = path.join(os.tmpdir(), `fake-gh-index-${process.pid}-${Date.now()}`);
        const env = { GIT_INDEX_FILE: index };
        try {
          if (body.base_tree) git(["read-tree", body.base_tree], { env });
          else git(["read-tree", "--empty"], { env });
          for (const it of body.tree ?? []) {
            if (it.sha === null) git(["update-index", "--force-remove", "--", it.path], { env });
            else git(["update-index", "--add", "--cacheinfo", `${it.mode},${it.sha},${it.path}`], { env });
          }
          return reply(201, { sha: git(["write-tree"], { env }).trim() });
        } finally {
          fs.rmSync(index, { force: true });
        }
      }
      if (rest === "/git/commits" && req.method === "POST") {
        if (!body.author?.name || !body.author?.email || !body.author?.date) return reply(422, { message: "author needs name, email and date" });
        const args = ["commit-tree", body.tree, ...(body.parents ?? []).flatMap((p) => ["-p", p]), "-F", "-"];
        const env = {
          GIT_AUTHOR_NAME: body.author.name,
          GIT_AUTHOR_EMAIL: body.author.email,
          GIT_AUTHOR_DATE: toGitDate(body.author.date),
          GIT_COMMITTER_NAME: (body.committer ?? body.author).name,
          GIT_COMMITTER_EMAIL: (body.committer ?? body.author).email,
          GIT_COMMITTER_DATE: toGitDate((body.committer ?? body.author).date),
        };
        return reply(201, { sha: git(args, { input: body.message, env }).trim() });
      }
      if ((r = /^\/git\/refs\/heads\/(.+)$/.exec(rest)) && req.method === "PATCH") {
        const ref = `refs/heads/${decodeURIComponent(r[1])}`;
        const cur = tryGit(["rev-parse", "--verify", ref]);
        if (!cur) return reply(422, { message: "Reference does not exist" });
        if (!body.force && tryGit(["merge-base", "--is-ancestor", cur, body.sha]) === null) return reply(422, { message: "Update is not a fast forward" });
        git(["update-ref", ref, body.sha]);
        return reply(200, { ref, object: { sha: body.sha } });
      }
      if (rest === "/git/refs" && req.method === "POST") {
        if (tryGit(["rev-parse", "--verify", body.ref])) return reply(422, { message: "Reference already exists" });
        git(["update-ref", body.ref, body.sha]);
        return reply(201, { ref: body.ref, object: { sha: body.sha } });
      }
      if ((r = /^\/contents\/(.+)$/.exec(rest)) && req.method === "PUT") {
        const branch = body.branch ?? "main";
        const blob = git(["hash-object", "-w", "--stdin"], { input: Buffer.from(body.content, "base64") }).trim();
        const index = path.join(os.tmpdir(), `fake-gh-index-${process.pid}-${Date.now()}`);
        const env = { GIT_INDEX_FILE: index };
        const parent = tryGit(["rev-parse", "--verify", `refs/heads/${branch}`]);
        git(parent ? ["read-tree", parent] : ["read-tree", "--empty"], { env });
        git(["update-index", "--add", "--cacheinfo", `100644,${blob},${decodeURIComponent(r[1])}`], { env });
        const tree = git(["write-tree"], { env }).trim();
        fs.rmSync(index, { force: true });
        const who = { GIT_AUTHOR_NAME: "web-flow", GIT_AUTHOR_EMAIL: "noreply@github.com", GIT_COMMITTER_NAME: "web-flow", GIT_COMMITTER_EMAIL: "noreply@github.com" };
        const sha = git(["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", body.message], { env: who }).trim();
        git(["update-ref", `refs/heads/${branch}`, sha]);
        return reply(201, { content: { path: r[1] }, commit: { sha } });
      }
      return reply(404, { message: `Not Found: ${req.method} ${rest}` });
    } catch (e) {
      return reply(422, { message: String(e.stderr ?? e.message ?? e).slice(0, 300) });
    }
  })
  .listen(+port, "127.0.0.1", () => console.log(`fake GitHub API on ${port}, repo ${repo}`));

// PROTOTYPE test fixture: git's own smart HTTP server (git http-backend, CGI) with CORS
// and Basic auth, standing in for a Forgejo with [repository] ACCESS_CONTROL_ALLOW_ORIGIN
// and [cors] set. Also a minimal OAuth2 provider (authorization code + PKCE S256, public
// client, refresh tokens) at Forgejo's paths, so the sign-in redirect can be driven for real.
//
// Usage: node test/git-server.mjs <root> <port> [--no-cors]   (repositories are <root>/<name>.git)
// Credentials: user "gfs", token "secret-token" (or any token issued by the OAuth endpoint).
import http from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";

const [root, port = "4177"] = process.argv.slice(2);
const cors = !process.argv.includes("--no-cors");
const backend = path.join(execFileSync("git", ["--exec-path"]).toString().trim(), "git-http-backend");
const tokens = new Set(["secret-token"]);
const codes = new Map(); // code → {challenge, clientId, redirect}
const refresh = new Map(); // refresh token → clientId
export const CLIENT_ID = "gfs-test-client";

const b64url = (b) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function corsHeaders(req) {
  return cors ? { "Access-Control-Allow-Origin": req.headers.origin ?? "*", "Access-Control-Allow-Headers": "Authorization, Content-Type, Accept", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", Vary: "Origin" } : {};
}

async function body(req) {
  const parts = [];
  for await (const c of req) parts.push(c);
  return Buffer.concat(parts);
}

function issue(res, h, clientId) {
  const access = b64url(randomBytes(24));
  const r = b64url(randomBytes(24));
  tokens.add(access);
  refresh.set(r, clientId);
  res.writeHead(200, { ...h, "Content-Type": "application/json" });
  res.end(JSON.stringify({ access_token: access, token_type: "bearer", expires_in: 3600, refresh_token: r }));
}

http
  .createServer(async (req, res) => {
    const h = corsHeaders(req);
    if (req.method === "OPTIONS") {
      res.writeHead(cors ? 204 : 405, h);
      return res.end();
    }
    const u = new URL(req.url, "http://x");

    // ----- OAuth2 (Forgejo's paths) -----
    if (u.pathname === "/login/oauth/authorize") {
      const q = u.searchParams;
      if (q.get("client_id") !== CLIENT_ID || q.get("code_challenge_method") !== "S256" || !q.get("code_challenge")) {
        res.writeHead(400);
        return res.end("bad authorize request");
      }
      const code = b64url(randomBytes(16));
      codes.set(code, { challenge: q.get("code_challenge"), redirect: q.get("redirect_uri") });
      // A real forge shows a consent page here; the test approves at once.
      res.writeHead(302, { Location: `${q.get("redirect_uri")}?${new URLSearchParams({ code, state: q.get("state") })}` });
      return res.end();
    }
    if (u.pathname === "/login/oauth/access_token" && req.method === "POST") {
      const form = new URLSearchParams((await body(req)).toString());
      const fail = (error) => {
        res.writeHead(400, { ...h, "Content-Type": "application/json" });
        res.end(JSON.stringify({ error }));
      };
      if (form.get("client_id") !== CLIENT_ID) return fail("invalid_client");
      if (form.get("grant_type") === "authorization_code") {
        const c = codes.get(form.get("code"));
        codes.delete(form.get("code"));
        if (!c) return fail("invalid_grant");
        if (c.redirect !== form.get("redirect_uri")) return fail("invalid_grant");
        if (b64url(createHash("sha256").update(form.get("code_verifier") ?? "").digest()) !== c.challenge) return fail("invalid_grant");
        return issue(res, h, CLIENT_ID);
      }
      if (form.get("grant_type") === "refresh_token" && refresh.has(form.get("refresh_token"))) {
        refresh.delete(form.get("refresh_token"));
        return issue(res, h, CLIENT_ID);
      }
      return fail("unsupported_grant_type");
    }

    // ----- git smart HTTP -----
    const auth = req.headers.authorization ?? "";
    const pass = auth.startsWith("Basic ") ? Buffer.from(auth.slice(6), "base64").toString().split(":").slice(1).join(":") : null;
    const ok = pass !== null && tokens.has(pass);
    const write = u.searchParams.get("service") === "git-receive-pack" || u.pathname.endsWith("/git-receive-pack");
    if (!ok && (write || process.env.PRIVATE)) {
      res.writeHead(401, { ...h, "WWW-Authenticate": 'Basic realm="git"', "Content-Type": "text/plain" });
      return res.end("authentication required");
    }
    const input = await body(req);
    const env = {
      ...process.env,
      GIT_PROJECT_ROOT: root,
      GIT_HTTP_EXPORT_ALL: "1",
      PATH_INFO: u.pathname,
      QUERY_STRING: u.search.slice(1),
      REQUEST_METHOD: req.method,
      CONTENT_TYPE: req.headers["content-type"] ?? "",
      CONTENT_LENGTH: String(input.length),
      REMOTE_USER: ok ? "gfs" : "",
      REMOTE_ADDR: "127.0.0.1",
      ...(req.headers["content-encoding"] ? { HTTP_CONTENT_ENCODING: req.headers["content-encoding"] } : {}),
    };
    const child = spawn(backend, [], { env });
    const out = [];
    child.stdout.on("data", (d) => out.push(d));
    child.stderr.on("data", (d) => process.stderr.write(`[http-backend] ${d}`));
    child.stdin.end(input);
    child.on("close", () => {
      const buf = Buffer.concat(out);
      let split = buf.indexOf("\r\n\r\n");
      let sep = 4;
      if (split < 0) {
        split = buf.indexOf("\n\n");
        sep = 2;
      }
      const head = buf.subarray(0, split).toString().split(/\r?\n/);
      let status = 200;
      const headers = { ...h };
      for (const line of head) {
        const i = line.indexOf(":");
        const k = line.slice(0, i).trim();
        const v = line.slice(i + 1).trim();
        if (k.toLowerCase() === "status") status = parseInt(v, 10);
        else if (k) headers[k] = v;
      }
      res.writeHead(status, headers);
      res.end(buf.subarray(split + sep));
    });
  })
  .listen(+port, "127.0.0.1", () => console.log(`git server on ${port} (${cors ? "CORS" : "no CORS"}), root ${root}`));

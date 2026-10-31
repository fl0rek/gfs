// Serve a directory with COOP/COEP headers (for tests). node test/static-server.mjs <dir> <port>
import http from "node:http"; import fs from "node:fs"; import path from "node:path";
const [dir = ".", port = "4174"] = process.argv.slice(2);
const types = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm", ".css": "text/css", ".json": "application/json", ".webc": "application/octet-stream" };
http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (p.endsWith("/")) p += "index.html";
  const f = path.join(dir, p);
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end("nope " + p); }
  res.writeHead(200, { "Content-Type": types[path.extname(f)] ?? "application/octet-stream", "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp", "Cross-Origin-Resource-Policy": "same-origin", "Cache-Control": "no-cache" });
  fs.createReadStream(f).pipe(res);
}).listen(+port, () => console.log("serving", dir, "on", port));

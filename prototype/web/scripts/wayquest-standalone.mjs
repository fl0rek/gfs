// PROTOTYPE. Builds the WayQuest view as one standalone HTML file, for looking at it outside the app.
//
// The page is src/views/wayquest/index.html unchanged. In place of the app's window.ue it gets a stand-in
// serving a snapshot of a node: one comb per git repository given (only its wayfinder maps and tickets, with one
// history entry per commit that touched .scratch/, carrying the commit's session and model trailers),
// plus the nix comb holding the views, and the empty workspace and session combs every node has.
//
//   node scripts/wayquest-standalone.mjs out.html gfs=/path/to/gfs@main wayquest=/path/to/wayquest@main
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const here = new URL("../src/", import.meta.url);
const [out, ...specs] = process.argv.slice(2);
if (!out || !specs.length) {
  console.error("usage: wayquest-standalone.mjs out.html name=/repo@ref ...");
  process.exit(1);
}
const git = (dir, ...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", maxBuffer: 1 << 28 });
const takenAt = Date.now();
const trees = {}; // entry id → { path → blob id }
const blobs = {}; // blob id → text
const bin = {}; // nix path → base64
const combs = [];

function diff(a, b) {
  const added = [], modified = [], removed = [];
  for (const [p, h] of Object.entries(b)) if (!(p in a)) added.push(p); else if (a[p] !== h) modified.push(p);
  for (const p of Object.keys(a)) if (!(p in b)) removed.push(p);
  return { added, modified, removed };
}
const trailer = (body, key) => (new RegExp(`^${key}:\\s*(.+)$`, "mi").exec(body) || [])[1]?.trim() ?? null;

for (const spec of specs) {
  const [name, rest] = spec.split("=");
  const [dir, ref = "HEAD"] = rest.split("@");
  const raw = git(dir, "log", "--reverse", "--no-merges", "--format=%H%x1f%at%x1f%an%x1f%B%x1e", ref, "--", ".scratch");
  const entries = [];
  let prevTree = {};
  for (const rec of raw.split("\x1e").map((r) => r.trim()).filter(Boolean)) {
    const [sha, at, author, body] = rec.split("\x1f");
    const tree = {};
    for (const line of git(dir, "ls-tree", "-r", sha, "--", ".scratch").split("\n").filter(Boolean)) {
      const [meta, path] = line.split("\t");
      if (!/^\.scratch\/[^/]+\/(map\.md|issues\/[^/]+\.md)$/.test(path)) continue; // the maps, nothing else
      const blob = meta.split(" ")[2];
      tree[path] = blob;
      if (!(blob in blobs)) blobs[blob] = git(dir, "cat-file", "-p", blob);
    }
    const session = trailer(body, "Claude-Session");
    const model = trailer(body, "Co-Authored-By");
    const id = sha.padEnd(64, "0");
    trees[id] = tree;
    entries.push({
      id, comb: name, parent: entries.length ? entries[entries.length - 1].id : null, tree: sha, kind: "pull",
      remote: `https://github.com/fl0rek/${name}`, commit: sha,
      author: {
        session: session ? session.replace(/^.*\//, "") : `git:${sha.slice(0, 8)}`,
        harness: author === "Claude" ? "claude-code" : "git",
        model: model ? model.replace(/\s*<.*>$/, "") : "",
        principal: author === "Claude" ? "user" : author,
      },
      committer: "snapshot", time: Number(at) * 1000, message: body.split("\n")[0], summary: diff(prevTree, tree),
    });
    prevTree = tree;
  }
  const all = git(dir, "ls-tree", "-r", "-l", ref).split("\n").filter(Boolean);
  const branch = ref === "HEAD" ? git(dir, "rev-parse", "--abbrev-ref", "HEAD").trim() : ref.replace(/^origin\//, "");
  const newest = entries[entries.length - 1];
  combs.push({
    name, head: newest.id, entries: entries.length, files: all.length,
    bytes: all.reduce((n, l) => n + (parseInt(l.split(/\s+/)[3], 10) || 0), 0),
    created: entries[0].time,
    last: { id: newest.id, time: newest.time, kind: newest.kind, message: newest.message, tool_name: undefined, author: newest.author, summary: newest.summary },
    remote: { label: "github", url: `https://github.com/fl0rek/${name}`, branch, state: "synced", ahead: 0, lastSync: takenAt },
    log: entries.slice().reverse(),
  });
  console.log(`${name}: ${entries.length} entries touching .scratch, ${all.length} files at ${ref}`);
}

// /nix: the views, as the app seeds them.
const nixFiles = {
  "view/index.html": readFileSync(new URL("view-seed.html", here), "utf8"),
  "view/wayquest/index.html": readFileSync(new URL("views/wayquest/index.html", here), "utf8"),
  "view/wayquest/README.md": readFileSync(new URL("views/wayquest/README.md", here), "utf8"),
  "view/wayquest/world.js": readFileSync(new URL("views/wayquest/world.js", here), "utf8"),
};
for (const f of ["world_bg.wasm", "sheets/roguelike.png", "sheets/tiny-town.png", "sheets/tiny-dungeon.png"]) bin[`view/wayquest/${f}`] = readFileSync(new URL(`views/wayquest/${f}`, here)).toString("base64");
const nixTree = {};
for (const [p, text] of Object.entries(nixFiles)) { const id = `nix:${p}`; blobs[id] = text; nixTree[p] = id; }
for (const p of Object.keys(bin)) nixTree[p] = `bin:${p}`;
const sys = { session: "snapshot", harness: "system", model: "", principal: "user" };
const genesis = (name) => {
  const id = `${name}-genesis`.padEnd(64, "0");
  trees[id] = {};
  const e = { id, comb: name, parent: null, tree: "", kind: "genesis", author: sys, committer: "snapshot", time: takenAt - 60000, message: "genesis", summary: { added: [], modified: [], removed: [] } };
  return e;
};
for (const name of ["workspace", "session"]) {
  const e = genesis(name);
  combs.push({ name, head: e.id, entries: 1, files: 0, bytes: 0, created: e.time, last: e, remote: null, log: [e] });
}
{
  const g = genesis("nix");
  const id = "nix-views".padEnd(64, "0");
  trees[id] = nixTree;
  const e = { id, comb: "nix", parent: g.id, tree: "", kind: "external", author: sys, committer: "snapshot", time: takenAt - 30000, message: "seed the views", summary: { added: Object.keys(nixTree), modified: [], removed: [] } };
  combs.push({ name: "nix", head: id, entries: 2, files: Object.keys(nixTree).length, bytes: 0, created: g.time, last: e, remote: null, log: [e, g] });
}

const when = new Date(takenAt).toISOString().slice(0, 16).replace("T", " ");
const snapshot = {
  takenAt, trees, blobs, bin, combs,
  note: `Snapshot (${when} UTC): a node whose datacombs hold ${specs.map((s) => s.split("=")[0]).join(" and ")}, history from their git logs. In Universal Explorer this view reads the live combs.`,
};

// The stand-in for the app's window.ue: same calls, answered from the snapshot.
const shim = `<script>(function(){
var D=${JSON.stringify(snapshot).replace(/</g, "\\u003c")};
var byName={};D.combs.forEach(function(c){byName[c.name]=c});
function resolve(p){var parts=p.split("/").filter(Boolean);var comb,at,rest;
  if(parts[0]==="nix"){comb="nix";rest=parts.slice(1)}else if(parts[0]==="datacombs"&&parts[1]){var s=parts[1].split("@");comb=s[0];at=s[1];rest=parts.slice(2)}else throw new Error(p+": outside gfs");
  var c=byName[comb];if(!c)throw new Error(p+": no comb "+comb);return{comb:c,tree:D.trees[at||c.head]||{},path:rest.join("/")}}
function text(id){if(id.indexOf("bin:")===0)return atob(D.bin[id.slice(4)]);return D.blobs[id]}
function bytes(id){if(id.indexOf("bin:")===0){var s=atob(D.bin[id.slice(4)]),b=new Uint8Array(s.length);for(var i=0;i<s.length;i++)b[i]=s.charCodeAt(i);return b}return new TextEncoder().encode(D.blobs[id])}
function file(p){var r=resolve(p),id=r.tree[r.path];if(!id)throw new Error(p+": no such file");return id}
var state=null;try{state=JSON.parse(localStorage.getItem("wayquest-standalone")||"null")}catch(e){}
window.ue={machine:{},view:{path:"/nix/view/wayquest/index.html",name:"wayquest",entry:byName.nix.head,note:D.note,promptAck:"This is a snapshot: in Universal Explorer that would go to pi, as a message from you."},
  combs:D.combs.map(function(c){var o={};for(var k in c)if(k!=="log")o[k]=c[k];return o}),state:state,
  read:function(p){return new Promise(function(res){res(text(file(p)))})},
  bytes:function(p){return new Promise(function(res){res(bytes(file(p)))})},
  list:function(p){return new Promise(function(res){var r=resolve(p),pre=r.path?r.path.replace(/\\/+$/,"")+"/":"";res(Object.keys(r.tree).filter(function(k){return k.indexOf(pre)===0}).map(function(k){return[k.slice(pre.length),0]}))})},
  log:function(c){return new Promise(function(res,rej){byName[c]?res(byName[c].log):rej(new Error("no comb "+c))})},
  prompt:function(t){console.log("ue.prompt:",t)},
  onUpdate:function(){},onHistory:function(){},
  setState:function(s){window.ue.state=s;try{localStorage.setItem("wayquest-standalone",JSON.stringify(s))}catch(e){}}};
})();</script>`;
// WayQuest's world glue, run up front as a classic script (the page would otherwise import it from a blob URL,
// which a strict content security policy refuses). The same transform as classicGlue() in the page.
const glueJs = nixFiles["view/wayquest/world.js"];
const names = [...glueJs.matchAll(/^export function (\w+)/gm)].map((m) => m[1]);
const glue = glueJs.replace(/^export function /gm, "function ").replace(/import\.meta\.url/g, "location.href")
  .replace(/^export \{([^}]*)\};?\s*$/m, (_, list) => `window.__wqWorld = { ${[...names, ...list.split(",").map((x) => x.trim()).filter(Boolean).map((x) => x.replace(/^(\w+) as (\w+)$/, "$2: $1"))].join(", ")} };`);
if (!glue.includes("window.__wqWorld")) throw new Error("world.js: could not find its export list");
const page = nixFiles["view/wayquest/index.html"];
const at = page.search(/<head[^>]*>/i);
const html = page.slice(0, page.indexOf(">", at) + 1) + shim + `<script>(function(){${glue.replace(/<\/script/gi, "<\\/script")}\n})();</script>` + page.slice(page.indexOf(">", at) + 1);
writeFileSync(out, html);
console.log(`${out}: ${(html.length / 1024).toFixed(0)} KB`);

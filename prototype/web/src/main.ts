// PROTOTYPE. The page: pi's console on the left, the comb's history on the right.

import { AgentWorker } from "./rpc";
import type { EntryDetail, HistoryEntry, InitInfo, MachineView, ModelConfig, VerifyReport, ViewReadOp } from "./protocol";
import type { RemoteConfig, RemoteStatus } from "./remotes";
import { CWD, NIX_COMB, VIEW_PATH, WORKSPACE } from "./paths";

// An OAuth redirect lands here with ?code&state; keep them before anything rewrites the URL.
const oauthReturn = location.search;
const worker = new AgentWorker();
const app = document.getElementById("app")!;

// ---------- state ----------
let info: InitInfo | null = null;
let transcript: any[] = [];
// Direct shell commands ("!cmd"), kept in sessionStorage so they survive a reload.
let shellLog: { time: number; command: string; output: string; exitCode: number | null; running?: boolean }[] = loadShellLog();
function loadShellLog() {
  try { return JSON.parse(sessionStorage.getItem("pi-on-gfs.shell") ?? "[]"); } catch { return []; }
}
function saveShellLog() {
  try { sessionStorage.setItem("pi-on-gfs.shell", JSON.stringify(shellLog.slice(-200))); } catch {}
}
let streamingText = "";
let streamingThinking = "";
let busy = false;
let statusText = "booting worker…";
let logs: Record<string, HistoryEntry[]> = {};
let selectedComb = WORKSPACE;
let selectedEntry: string | null = null;
let detail: EntryDetail | null = null;
let verify: VerifyReport | null = null;
let treeAt: { entryId: string; files: [string, string, number][]; open?: { path: string; text: string } } | null = null;
// The "files" view: the selected comb's working tree, editable by hand.
let filesView: { comb: string; files: [string, string, number][]; open?: { path: string; text: string; dirty: boolean } } | null = null;
let error: string | null = null;
let config: ModelConfig = loadConfig();
// Surfaces: the console (chat + history) or one of the views, pages the harness programs for itself in /nix.
// Every view/index.html under /nix is a view: view/index.html is "view", view/<name>/index.html is "<name>".
// You switch; the harness only controls what is inside a view (and can add one by writing its index.html).
type Surface = "console" | `view:${string}`;
let surface: Surface = loadSurface();
function loadSurface(): Surface {
  const s = sessionStorage.getItem("pi-on-gfs.surface");
  if (s === "view") return "view:"; // before there was more than one view
  return s?.startsWith("view:") ? (s as Surface) : "console";
}
/** View names found in /nix ("" is view/index.html). */
let views: string[] = [];
const viewName = (s: Surface) => (s.startsWith("view:") ? s.slice(5) : null);
const viewPathOf = (name: string) => (name ? `view/${name}/index.html` : VIEW_PATH);
const viewLabel = (name: string) => name || "view";
let staleViews = new Set<string>(); // views whose files changed while you were elsewhere
// Git remotes: configs (tokens included) live in this browser's localStorage, like model keys; the worker syncs.
let remoteConfigs: RemoteConfig[] = loadRemotes();
let remoteStatus: RemoteStatus[] = [];
let gitView: {
  comb: string;
  draft: RemoteConfig | null; // null: show the connected remote; else the form
  clientId: string;
  device?: { code: string; uri: string; until: number };
  busy?: string;
} | null = null;
function loadRemotes(): RemoteConfig[] {
  try { return JSON.parse(localStorage.getItem("pi-on-gfs.remotes") ?? "[]"); } catch { return []; }
}
function saveRemotes() {
  try { localStorage.setItem("pi-on-gfs.remotes", JSON.stringify(remoteConfigs)); } catch {}
}
let viewEntry: string | null = null; // the /nix entry the frame was rendered from
let viewError: string | null = null;

function loadConfig(): ModelConfig {
  try {
    const s = localStorage.getItem("pi-on-gfs.config") ?? sessionStorage.getItem("pi-on-gfs.config");
    if (s) return JSON.parse(s);
  } catch {}
  return { provider: "mock", model: "scripted-agent", apiKey: "" };
}
function saveConfig() {
  localStorage.setItem("pi-on-gfs.config", JSON.stringify(config));
}

// ---------- helpers ----------
type Child = Node | string | null | undefined | false | Child[];
function h(tag: string, attrs: Record<string, any> = {}, ...children: Child[]): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "class") el.className = v;
    else if (k === "style") el.setAttribute("style", v);
    else if (k in el) (el as any)[k] = v;
    else el.setAttribute(k, v);
  }
  const add = (c: Child) => {
    if (c == null || c === false) return;
    if (Array.isArray(c)) c.forEach(add);
    else el.append(c instanceof Node ? c : document.createTextNode(c));
  };
  children.forEach(add);
  return el;
}
const short = (id?: string | null) => (id ? id.slice(0, 8) : "");
const fmtTime = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const textOf = (m: any) =>
  typeof m.content === "string" ? m.content : (m.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");

// ---------- egress bridge (extension) ----------
let bridgeVersion: string | null = null;
let systemNotice: string | null = null;
window.addEventListener("message", (ev) => {
  if (ev.source !== window || !ev.data || ev.data.source !== "gfs-bridge-ext") return;
  const m = ev.data;
  if (m.event === "hello") {
    if (!bridgeVersion) {
      bridgeVersion = m.version;
      void worker.call({ method: "bridgeAvailable", available: true });
      render();
    }
    return;
  }
  const { id, source: _s, ...event } = m;
  worker.raw({ bridge: true, id, event });
});
window.postMessage({ source: "gfs-bridge", type: "ping" }, "*");

// ---------- worker events ----------
worker.on(async (n) => {
  if (n.type === "bridge") {
    if (n.req) window.postMessage({ source: "gfs-bridge", type: "fetch", id: n.reqId, url: n.req.url, init: n.req.init }, "*");
    else window.postMessage({ source: "gfs-bridge", type: "abort", id: n.reqId }, "*");
  } else if (n.type === "system") {
    if (info) info.system = { entry: n.entry, name: n.name };
    systemNotice = `switched to /nix@${n.entry.slice(0, 8)} (${n.reason})`;
    render();
  } else if (n.type === "status") {
    statusText = n.text;
    render();
  } else if (n.type === "remotes") {
    remoteStatus = n.status;
    render();
  } else if (n.type === "remoteAuth") {
    remoteConfigs = remoteConfigs.map((c) => (c.comb === n.comb ? { ...c, ...n.patch } : c));
    saveRemotes();
  } else if (n.type === "error") {
    error = n.message;
    busy = false;
    render();
  } else if (n.type === "history") {
    if (info) info.objectCount = n.objectCount;
    if (info && !info.combs.includes(n.comb)) info.combs = [...info.combs, n.comb]; // a comb the session just created
    await refreshLog(n.comb);
    if (n.comb === NIX_COMB) await onNixEntry();
    pushHistory(n.comb);
    render();
  } else if (n.type === "agent") {
    await onAgentEvent(n.event as any);
  }
});

async function onAgentEvent(ev: any) {
  switch (ev.type) {
    case "agent_start":
      busy = true;
      streamingText = "";
      streamingThinking = "";
      break;
    case "message_update":
      if (ev.inner?.type === "text_delta") streamingText += ev.inner.delta;
      if (ev.inner?.type === "thinking_delta") streamingThinking += ev.inner.delta;
      break;
    case "message_end":
    case "tool_execution_end":
    case "turn_end":
      streamingText = "";
      streamingThinking = "";
      transcript = await worker.call({ method: "transcript" });
      break;
    case "agent_end":
      busy = false;
      streamingText = "";
      transcript = await worker.call({ method: "transcript" });
      break;
  }
  render();
}

async function refreshLog(comb: string) {
  logs[comb] = await worker.call({ method: "log", comb });
  if (comb === selectedComb && selectedEntry && !logs[comb].some((e) => e.id === selectedEntry)) {
    selectedEntry = null;
    detail = null;
  }
}

async function selectEntry(id: string | null) {
  selectedEntry = id;
  detail = null;
  treeAt = null;
  render();
  if (id) {
    detail = await worker.call({ method: "entry", entryId: id });
    render();
  }
}

// ---------- actions ----------
async function send(text: string) {
  if (!text.trim() || busy) return;
  error = null;
  if (text.startsWith("!")) return runShell(text.slice(1).trim());
  busy = true;
  render();
  try {
    await worker.call({ method: "prompt", text });
  } catch (e: any) {
    error = e.message;
    busy = false;
    render();
  }
}

/** `!cmd`: run in the WASIX shell directly. Changes land as an "external" entry attributed to you. */
async function runShell(command: string) {
  if (!command) return;
  const item = { time: Date.now(), command, output: "", exitCode: null as number | null, running: true };
  shellLog.push(item);
  busy = true;
  render();
  try {
    const r = await worker.call<{ output: string; exitCode: number }>({ method: "shellRun", command, timeoutMs: 120000 });
    item.output = r.output;
    item.exitCode = r.exitCode;
  } catch (e: any) {
    item.output = String(e.message ?? e);
    item.exitCode = -1;
  }
  item.running = false;
  busy = false;
  saveShellLog();
  render();
}

async function applyConfig() {
  saveConfig();
  try {
    await worker.call({ method: "configure", config });
    error = null;
  } catch (e: any) {
    error = e.message;
  }
  render();
}

async function doRollback(comb: string, entryId: string) {
  if (!confirm(`Roll ${comb} back to ${short(entryId)}? This appends a new history entry; nothing is deleted.`)) return;
  try {
    const id = await worker.call<string>({ method: "rollback", comb, entryId });
    await refreshLog(comb);
    await selectEntry(id);
  } catch (e: any) {
    error = e.message;
    render();
  }
}

async function doVerify(comb: string) {
  verify = await worker.call({ method: "verify", comb });
  render();
}

async function browseAt(entryId: string) {
  treeAt = { entryId, files: await worker.call({ method: "treeAt", entryId }) };
  render();
}

async function openAt(entryId: string, path: string) {
  const text = await worker.call<string>({ method: "fileAt", entryId, path });
  if (treeAt) treeAt.open = { path, text };
  render();
}

async function openFiles(comb: string) {
  filesView = { comb, files: await worker.call({ method: "tree", comb }) };
  selectedEntry = null;
  detail = null;
  render();
}
async function openFile(comb: string, path: string) {
  const text = await worker.call<string>({ method: "file", comb, path });
  if (filesView) filesView.open = { path, text, dirty: false };
  render();
}
async function saveFile() {
  if (!filesView?.open) return;
  const { comb } = filesView;
  const { path, text } = filesView.open;
  try {
    await worker.call({ method: "saveFile", comb, path, content: text });
    filesView.open.dirty = false;
    filesView.files = await worker.call({ method: "tree", comb });
    await refreshLog(comb);
  } catch (e: any) {
    error = e.message;
  }
  render();
}

// ---------- the views ----------
// The frame lives outside #app so re-renders of the page never reload it (moving an iframe in the DOM reloads it).
const viewHost = h("div", { class: "view-host", hidden: true }) as HTMLDivElement;
const viewFrame = h("iframe", { class: "view-frame", sandbox: "allow-scripts allow-forms", title: "view" }) as HTMLIFrameElement;
viewHost.append(viewFrame);
document.body.append(viewHost);
let viewTimer: number | null = null;
let shownView: string | null = null; // the view the frame holds

function setSurface(s: Surface) {
  surface = s;
  try { sessionStorage.setItem("pi-on-gfs.surface", s); } catch {}
  const name = viewName(s);
  if (name != null) { staleViews.delete(name); void loadView(); }
  else stopViewUpdates();
  render();
}

/** Which views /nix holds: every view/index.html and view/<name>/index.html. */
async function refreshViews() {
  try {
    const files = await worker.call<[string, string, number][]>({ method: "tree", comb: NIX_COMB });
    views = files
      .map(([p]) => /^view\/(?:([^/]+)\/)?index\.html$/.exec(p))
      .filter((m): m is RegExpExecArray => !!m)
      .map((m) => m[1] ?? "")
      .sort((a, b) => (a === "" ? -1 : b === "" ? 1 : a.localeCompare(b)));
  } catch {
    views = [];
  }
}

/**
 * A /nix entry landed. The first view ("view") re-renders on every /nix entry, as it always has; a named view
 * re-renders when the entry touched its own directory. Either way every view hears about it through ue.onHistory.
 */
async function onNixEntry() {
  await refreshViews();
  const latest = logs[NIX_COMB]?.[0];
  const touched = latest ? [...latest.summary.added, ...latest.summary.modified, ...latest.summary.removed] : [];
  for (const name of views) {
    const hit = name === "" || touched.some((p) => p.startsWith(`view/${name}/`));
    if (!hit) continue;
    if (viewName(surface) === name) void loadView();
    else staleViews.add(name);
  }
  const current = viewName(surface);
  if (current != null && !views.includes(current) && info) setSurface("console");
}

/** Per-view state the page keeps for it (ue.state / ue.setState), so a re-render or reload keeps its place. */
function viewState(name: string): unknown {
  try { return JSON.parse(sessionStorage.getItem(`pi-on-gfs.view-state:${name}`) ?? "null"); } catch { return null; }
}

/** Read a view's index.html from /nix and render it in the sandbox with a fresh snapshot and the ue API. */
async function loadView() {
  stopViewUpdates();
  viewError = null;
  const name = viewName(surface);
  if (name == null) return;
  try {
    const snap = await worker.call<MachineView>({ method: "machine" });
    if (!snap.view.entry) throw new Error("no /nix comb (shell disabled?)");
    const path = viewPathOf(name);
    const html = await worker.call<string>({ method: "file", comb: NIX_COMB, path });
    const data = JSON.stringify({ ...snap, view: { ...snap.view, path: `/nix/${path}`, name: viewLabel(name) }, state: viewState(name) }).replace(/</g, "\\u003c");
    viewFrame.srcdoc = injectUe(html, data);
    shownView = name;
    viewEntry = snap.view.entry;
    viewTimer = window.setInterval(pushMachine, 4000);
  } catch (e: any) {
    viewError = e.message;
  }
  render();
}

/**
 * window.ue, the API every view gets (see /nix/README.md). Reads go through the page to the worker; all are
 * read-only and take gfs paths, so `/datacombs/<comb>@<entry>/…` is the past, as it is for the harness.
 */
function injectUe(html: string, data: string): string {
  const boot = `<script>(function(){var D=${data};var fns=[],hist=[],calls={},next=1;
function call(op,arg){return new Promise(function(res,rej){var id=next++;calls[id]={res:res,rej:rej};parent.postMessage({type:"ue:call",id:id,op:op,arg:String(arg)},"*")})}
window.ue={machine:D.machine,view:D.view,combs:D.combs||[],state:D.state,
prompt:function(t){parent.postMessage({type:"ue:prompt",text:String(t)},"*")},
onUpdate:function(f){fns.push(f)},onHistory:function(f){hist.push(f)},
read:function(p){return call("read",p)},bytes:function(p){return call("bytes",p)},list:function(p){return call("list",p)},log:function(c){return call("log",c)},
setState:function(s){window.ue.state=s;parent.postMessage({type:"ue:state",state:JSON.parse(JSON.stringify(s))},"*")}};
function each(a,x){a.forEach(function(f){try{f(x)}catch(err){console.error(err)}})}
window.addEventListener("message",function(e){var d=e.data;if(!d||e.source!==parent)return;
if(d.type==="ue:reply"){var c=calls[d.id];if(!c)return;delete calls[d.id];if(d.ok)c.res(d.result);else c.rej(new Error(d.error));return}
if(d.type==="ue:machine"){window.ue.machine=d.machine;window.ue.view.entry=d.view.entry;if(d.combs)window.ue.combs=d.combs;each(fns)}
if(d.type==="ue:history"){if(d.combs)window.ue.combs=d.combs;each(hist,d.comb);each(fns)}})})();<\/script>`;
  const at = html.search(/<head[^>]*>/i);
  return at >= 0 ? html.slice(0, html.indexOf(">", at) + 1) + boot + html.slice(html.indexOf(">", at) + 1) : boot + html;
}

async function pushMachine() {
  if (viewName(surface) == null || !viewFrame.contentWindow) return;
  try {
    const snap = await worker.call<MachineView>({ method: "machine" });
    viewFrame.contentWindow.postMessage({ type: "ue:machine", ...snap }, "*");
  } catch {}
}
/** Tell the shown view that a comb has a new history entry. */
async function pushHistory(comb: string) {
  if (viewName(surface) == null || !viewFrame.contentWindow) return;
  try {
    const combs = await worker.call({ method: "viewRead", op: "combs", arg: "" });
    viewFrame.contentWindow.postMessage({ type: "ue:history", comb, combs }, "*");
  } catch {}
}
function stopViewUpdates() {
  if (viewTimer != null) clearInterval(viewTimer);
  viewTimer = null;
}
const VIEW_READS: ViewReadOp[] = ["combs", "log", "list", "read", "bytes"];
// The view may ask the harness for something (a prompt from you, in the console), read gfs, or keep its state.
window.addEventListener("message", async (ev) => {
  if (ev.source !== viewFrame.contentWindow || !ev.data) return;
  const d = ev.data;
  if (d.type === "ue:prompt") {
    const text = String(d.text ?? "").trim();
    if (!text) return;
    statusText = `sent to pi from the view: ${text.slice(0, 60)}`;
    void send(text);
  } else if (d.type === "ue:state" && shownView != null) {
    try { sessionStorage.setItem(`pi-on-gfs.view-state:${shownView}`, JSON.stringify(d.state)); } catch {}
  } else if (d.type === "ue:call" && typeof d.id === "number") {
    const reply = (m: object, transfer: Transferable[] = []) => viewFrame.contentWindow?.postMessage({ type: "ue:reply", id: d.id, ...m }, "*", transfer);
    if (!VIEW_READS.includes(d.op)) return reply({ ok: false, error: `ue: no such read: ${d.op}` });
    try {
      const result = await worker.call({ method: "viewRead", op: d.op, arg: String(d.arg ?? "") });
      reply({ ok: true, result }, result instanceof Uint8Array ? [result.buffer] : []);
    } catch (e: any) {
      reply({ ok: false, error: e.message });
    }
  }
});

async function wipe() {
  if (!confirm("Wipe everything stored in this browser (all combs, the whole history, the transcript)?")) return;
  await worker.call({ method: "wipe" });
  location.reload();
}

// ---------- rendering ----------
let draft = ""; // the prompt box survives re-renders

function render() {
  // Keep focus and caret across the full re-render (status updates arrive while you type).
  const active = document.activeElement as HTMLElement | null;
  const key = active?.dataset?.key;
  const sel = active && "selectionStart" in active ? [(active as HTMLTextAreaElement).selectionStart, (active as HTMLTextAreaElement).selectionEnd] : null;
  renderInner();
  if (key) {
    const el = app.querySelector<HTMLElement>(`[data-key="${key}"]`);
    if (el) {
      el.focus({ preventScroll: true });
      if (sel && "setSelectionRange" in el) (el as HTMLTextAreaElement).setSelectionRange(sel[0]!, sel[1]!);
    }
  }
}

function renderInner() {
  app.replaceChildren(h("div", { class: "root" },
    h("header", { class: "top" },
      h("div", { class: "brand" }, h("b", {}, "pi on gfs"), h("span", { class: "muted" }, " · prototype, throwaway")),
      h("div", { class: "surfaces", role: "tablist" },
        h("button", { class: `tab${surface === "console" ? " active" : ""}`, role: "tab", "aria-selected": surface === "console", onClick: () => setSurface("console") }, "console"),
        views.map((name) => {
          const s: Surface = `view:${name}`;
          return h("button", { class: `tab${surface === s ? " active" : ""}`, role: "tab", "aria-selected": surface === s, title: `/nix/${viewPathOf(name)}`, onClick: () => setSurface(s) }, viewLabel(name), staleViews.has(name) ? h("span", { class: "dot", title: "its files changed; it will re-render" }) : null);
        }),
      ),
      h("div", { class: "status" },
        busy || statusText.endsWith("…") ? h("span", { class: "spinner" }) : null,
        h("span", {}, statusText),
        info ? h("span", { class: "muted" }, ` · ${info.persistence === "opfs" ? "persisted in OPFS" : "memory only"} · ${info.objectCount} objects`) : null,
        h("span", { class: "muted", title: bridgeVersion ? `egress extension v${bridgeVersion}: any URL` : "no egress extension: CORS applies" }, ` · egress: ${bridgeVersion ? "extension" : "direct only"}`),
        info?.system ? h("span", { class: "muted mono", title: info.system.name }, ` · system /nix@${info.system.entry.slice(0, 8)}`) : null,
      ),
    ),
    error ? h("div", { class: "error" }, error, h("button", { class: "link", onClick: () => { error = null; render(); } }, "dismiss")) : null,
    systemNotice ? h("div", { class: "notice" }, "system ", systemNotice, h("button", { class: "link", onClick: () => { systemNotice = null; render(); } }, "ok")) : null,
    viewName(surface) != null ? renderViewSurface() : h("main", { class: "split" }, renderConsole(), renderTimeline()),
  ));
  // The frame is fixed under the header; show it only on the view surface.
  const main = app.querySelector("main");
  viewHost.hidden = viewName(surface) == null || !!viewError;
  if (main && viewName(surface) != null) viewHost.style.top = `${main.getBoundingClientRect().top}px`;
}

function renderViewSurface() {
  return h("main", { class: "view-surface" },
    viewError
      ? h("div", { class: "empty", style: "padding:14px" }, h("p", {}, "The view could not be rendered: ", viewError), h("button", { onClick: () => void loadView() }, "Retry"))
      : h("div", { class: "view-bar muted small" },
          h("span", { class: "mono" }, `/nix/${viewPathOf(viewName(surface) ?? "")}`), viewEntry ? h("span", { class: "mono" }, ` @${short(viewEntry)}`) : null,
          h("span", {}, viewName(surface) ? " · pi programs this page; it re-renders when its files in /nix change" : " · pi programs this page; it re-renders on every /nix entry"),
        ),
  );
}

function renderConsole() {
  const msgs: Node[] = [];
  const rows: { time: number; node: () => Node }[] = [];
  for (const m of transcript) {
    if (m.role === "system") continue;
    rows.push({ time: m.timestamp ?? 0, node: () => renderMessage(m) });
  }
  for (const sh of shellLog) rows.push({ time: sh.time, node: () => renderShellItem(sh) });
  rows.sort((a, b) => a.time - b.time);
  for (const r of rows) msgs.push(r.node());
  if (streamingThinking) msgs.push(h("div", { class: "msg assistant thinking" }, h("details", { open: true }, h("summary", {}, "thinking…"), streamingThinking)));
  if (streamingText) msgs.push(h("div", { class: "msg assistant streaming" }, streamingText));
  if (busy && !streamingText) msgs.push(h("div", { class: "msg assistant muted" }, "…"));

  const input = h("textarea", {
    "data-key": "prompt",
    placeholder: busy ? "working…" : `Ask pi to do something in ${CWD} — or !cmd to run it in the shell yourself`,
    rows: 3,
    disabled: busy,
    value: draft,
    onInput: (e: any) => (draft = e.target.value),
    onKeydown: (e: KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        const t = (e.target as HTMLTextAreaElement).value;
        (e.target as HTMLTextAreaElement).value = "";
        draft = "";
        void send(t);
      }
    },
  }) as HTMLTextAreaElement;

  const list = h("div", { class: "messages" }, msgs.length ? msgs : h("div", { class: "empty" },
    h("p", {}, "This is pi's console. The agent lives in a Web Worker; its only filesystem is gfs."),
    h("p", {}, "With the ", h("b", {}, "mock"), " model it plays a scripted routine (write → bash → edit) so you can watch history entries appear on the right. Pick DeepSeek or OpenCode Zen below and paste a key to talk to a real model."),
  ));
  queueMicrotask(() => (list.scrollTop = list.scrollHeight));

  return h("section", { class: "pane console" },
    h("div", { class: "pane-head" }, h("h2", {}, "pi console"), h("span", { class: "muted mono" }, CWD)),
    list,
    h("div", { class: "composer" },
      input,
      h("div", { class: "row" },
        h("button", { class: "primary", disabled: busy, onClick: () => { void send(input.value); input.value = ""; draft = ""; } }, "Send"),
        busy ? h("button", { onClick: () => worker.call({ method: "abort" }) }, "Abort") : null,
      ),
    ),
    renderConfig(),
  );
}

function renderMessage(m: any): Node {
  if (m.role === "user") {
    const t = textOf(m);
    if (/^\[.*\]$/s.test(t.trim())) return h("div", { class: "msg note" }, t);
    return h("div", { class: "msg user" }, t);
  }
  if (m.role === "assistant") {
    const parts: Node[] = [];
    for (const c of m.content ?? []) {
      if (c.type === "text" && c.text.trim()) parts.push(h("div", { class: "text" }, c.text));
      else if (c.type === "thinking" && c.thinking) parts.push(h("details", { class: "thinking" }, h("summary", {}, "thinking"), c.thinking));
      else if (c.type === "toolCall")
        parts.push(
          h("details", { class: "toolcall" },
            h("summary", {}, h("span", { class: "tag" }, c.name), " ", h("span", { class: "mono muted" }, summarizeArgs(c.name, c.arguments))),
            h("pre", {}, JSON.stringify(c.arguments, null, 2)),
          ),
        );
    }
    if (m.stopReason === "error") parts.push(h("div", { class: "error inline" }, m.errorMessage ?? "error"));
    return h("div", { class: "msg assistant" }, parts);
  }
  if (m.role === "toolResult") {
    const out = textOf(m);
    return h("div", { class: `msg toolresult${m.isError ? " iserror" : ""}` },
      h("details", {}, h("summary", {}, h("span", { class: "tag dim" }, m.toolName), m.isError ? " failed" : " result", h("span", { class: "muted" }, ` · ${out.length} chars`)), h("pre", {}, out)),
    );
  }
  return h("div", { class: "msg muted" }, m.role);
}

function renderShellItem(sh: { time: number; command: string; output: string; exitCode: number | null; running?: boolean }): Node {
  return h("div", { class: `msg shell${sh.exitCode && sh.exitCode !== 0 ? " iserror" : ""}` },
    h("div", { class: "cmd" }, h("span", { class: "prompt" }, "$ "), sh.command, sh.running ? h("span", { class: "spinner" }) : sh.exitCode ? h("span", { class: "muted" }, ` → exit ${sh.exitCode}`) : null),
    sh.output ? h("pre", {}, sh.output) : null,
  );
}

function summarizeArgs(name: string, a: any): string {
  if (!a) return "";
  if (name === "bash") return a.command ?? "";
  if (a.path) return a.path;
  return JSON.stringify(a).slice(0, 80);
}

function renderConfig() {
  const providers: ModelConfig["provider"][] = ["mock", "free", "deepseek", "opencode", "openai-compatible"];
  const defaults: Record<string, string> = { mock: "scripted-agent", free: "free", deepseek: "deepseek-v4-pro", opencode: "claude-sonnet-4-6", "openai-compatible": "" };
  return h("details", { class: "config", open: config.provider !== "mock" && !config.apiKey },
    h("summary", {}, "model: ", h("b", {}, `${config.provider} / ${config.model}`), config.provider !== "mock" && !config.apiKey ? h("span", { class: "warn" }, " · no API key") : null),
    h("div", { class: "grid" },
      h("label", {}, "provider",
        h("select", { value: config.provider, onChange: (e: any) => { config.provider = e.target.value; config.model = defaults[config.provider]; render(); } },
          providers.map((p) => h("option", { value: p, selected: p === config.provider }, p))),
      ),
      h("label", {}, "model", h("input", { value: config.model, onInput: (e: any) => (config.model = e.target.value) })),
      config.provider === "openai-compatible" ? h("label", {}, "base URL", h("input", { value: config.baseUrl ?? "", placeholder: "https://host/v1", onInput: (e: any) => (config.baseUrl = e.target.value) })) : null,
      config.provider === "free" ? renderFreeKeys() : config.provider !== "mock" ? h("label", {}, "API key (kept in this browser's localStorage)", h("input", { type: "password", value: config.apiKey, onInput: (e: any) => (config.apiKey = e.target.value) })) : null,
      h("div", { class: "row" },
        h("button", { onClick: applyConfig }, "Apply"),
        h("button", { onClick: () => worker.call({ method: "shellWarmup" }).catch((e) => { error = e.message; render(); }) }, "Start bash now"),
        h("button", { class: "danger", onClick: wipe }, "Wipe browser storage"),
      ),
      h("p", { class: "muted small" }, "Keys go straight from this tab to the provider and are kept in this browser's localStorage. Requests are made from the worker."),
    ),
  );
}

// ----- free-tier router -----
const FREE_PROVIDERS = [
  ["openrouter", "OpenRouter", "https://openrouter.ai/keys"],
  ["google", "Google Gemini", "https://aistudio.google.com/apikey"],
  ["groq", "Groq", "https://console.groq.com/keys"],
  ["cerebras", "Cerebras", "https://cloud.cerebras.ai"],
  ["mistral", "Mistral", "https://console.mistral.ai/api-keys"],
] as const;
let freeStatus: { updated: string; routed: string | null; models: { key: string; state: string; ping?: string; until?: number }[] } | null = null;
async function refreshFreeStatus() {
  freeStatus = await worker.call({ method: "freeStatus" });
  render();
}
function renderFreeKeys(): Node {
  config.freeKeys ??= {};
  return h("div", { class: "free" },
    h("p", { class: "muted small" }, "Rides whichever free tier is up, from ", h("a", { href: "https://github.com/anus-dev/ANUS", target: "_blank" }, "ANUS"), "'s ranked list. Keys are still needed; they stay in this browser's localStorage."),
    FREE_PROVIDERS.map(([id, name, url]) =>
      h("label", {}, h("span", {}, name, " ", h("a", { href: url, target: "_blank", class: "muted" }, "(get a key)")),
        h("input", { type: "password", value: config.freeKeys![id] ?? "", placeholder: "no key", onInput: (e: any) => (config.freeKeys![id] = e.target.value) }))),
    h("div", { class: "row" }, h("button", { onClick: refreshFreeStatus }, "Show models")),
    freeStatus ? h("ul", { class: "free-list" },
      h("li", { class: "muted" }, `list updated ${freeStatus.updated || "?"}${freeStatus.routed ? ` · last answer from ${freeStatus.routed}` : ""}`),
      freeStatus.models.map((m) => h("li", { class: m.state }, h("span", { class: "mono" }, m.key), ` · ${m.state}${m.until ? ` until ${new Date(m.until).toLocaleTimeString()}` : ""}${m.ping && m.ping !== "ok" ? ` · ping ${m.ping}` : ""}`))) : null,
  );
}

// ----- timeline -----
interface Item { time: number; kind: "entry" | "prompt" | "assistant" | "shell"; entry?: HistoryEntry; text?: string; }

function timelineItems(): Item[] {
  const items: Item[] = [];
  for (const e of logs[selectedComb] ?? []) items.push({ time: e.time, kind: "entry", entry: e });
  if (selectedComb === WORKSPACE) {
    for (const m of transcript) {
      if (m.role === "user" && !/^\[.*\]$/s.test(textOf(m).trim())) items.push({ time: m.timestamp, kind: "prompt", text: textOf(m) });
      else if (m.role === "assistant") {
        const t = textOf(m).trim();
        if (t) items.push({ time: m.timestamp, kind: "assistant", text: t });
      }
    }
  }
  if (selectedComb === WORKSPACE) for (const sh of shellLog) items.push({ time: sh.time, kind: "shell", text: `$ ${sh.command}` });
  if (selectedComb !== "nix") for (const e of logs.nix ?? []) if (e.kind === "switch") items.push({ time: e.time, kind: "entry", entry: e });
  items.sort((a, b) => a.time - b.time || (a.kind === "entry" ? 1 : -1));
  return items;
}

function renderTimeline() {
  const combs = info?.combs ?? [WORKSPACE];
  const items = timelineItems();
  const list = h("div", { class: "entries" },
    items.length ? items.map(renderItem) : h("div", { class: "empty" }, "No history yet."),
  );
  queueMicrotask(() => { if (!selectedEntry) list.scrollTop = list.scrollHeight; });
  return h("section", { class: "pane timeline" },
    h("div", { class: "pane-head" },
      h("h2", {}, "history"),
      h("select", { value: selectedComb, onChange: async (e: any) => { selectedComb = e.target.value; selectedEntry = null; detail = null; verify = null; await refreshLog(selectedComb); render(); } },
        combs.map((c) => h("option", { value: c, selected: c === selectedComb }, c === "nix" ? "/nix (running system)" : `/datacombs/${c}`))),
      h("button", { onClick: () => doVerify(selectedComb) }, "Verify chain"),
      h("button", { class: filesView?.comb === selectedComb ? "active" : "", onClick: () => (filesView?.comb === selectedComb ? ((filesView = null), render()) : openFiles(selectedComb)) }, "Files"),
      h("button", { class: gitView?.comb === selectedComb ? "active" : "", title: "back this comb with a git remote", onClick: () => toggleGit(selectedComb) }, "Git", gitChip(selectedComb)),
      verify ? h("span", { class: verify.ok ? "ok" : "warn" }, verify.ok ? ` ✓ ${verify.entries} entries, ${verify.objects_checked} objects hash correctly` : ` ✗ ${verify.problems.join("; ")}`) : null,
    ),
    h("div", { class: "timeline-body" }, list, gitView?.comb === selectedComb ? renderGit() : filesView?.comb === selectedComb ? renderFiles() : selectedEntry ? renderDetail() : null),
  );
}

function renderItem(it: Item): Node {
  if (it.kind === "prompt") return h("div", { class: "item prompt" }, h("span", { class: "time" }, fmtTime(it.time)), h("span", { class: "who" }, "you"), h("span", { class: "text" }, it.text));
  if (it.kind === "shell") return h("div", { class: "item shell" }, h("span", { class: "time" }, fmtTime(it.time)), h("span", { class: "who" }, "you · shell"), h("span", { class: "text mono" }, it.text));
  if (it.kind === "assistant") return h("div", { class: "item assistant" }, h("span", { class: "time" }, fmtTime(it.time)), h("span", { class: "who" }, "pi"), h("span", { class: "text" }, it.text));
  const e = it.entry!;
  const n = e.summary.added.length + e.summary.modified.length + e.summary.removed.length;
  return h("div", { class: `item entry ${e.kind}${selectedEntry === e.id ? " selected" : ""}`, onClick: () => selectEntry(selectedEntry === e.id ? null : e.id) },
    h("span", { class: "time" }, fmtTime(e.time)),
    h("span", { class: `tag ${e.kind}` }, e.kind === "tool_call" ? e.tool_name : e.kind === "switch" ? "system" : e.kind),
    h("span", { class: "text" }, e.message),
    h("span", { class: "meta mono" },
      n ? `${e.summary.added.length ? "+" + e.summary.added.length + " " : ""}${e.summary.modified.length ? "~" + e.summary.modified.length + " " : ""}${e.summary.removed.length ? "−" + e.summary.removed.length + " " : ""}` : "",
      "@", short(e.id), gitMark(e)),
  );
}

function renderDetail(): Node {
  const e = detail?.entry ?? (logs[selectedComb] ?? []).find((x) => x.id === selectedEntry);
  if (!e) return h("div", { class: "detail" }, "loading…");
  const rows: [string, Child][] = [
    ["entry", h("span", { class: "mono" }, e.id)],
    ["parent", e.parent ? h("a", { href: "#", onClick: (ev: Event) => { ev.preventDefault(); selectEntry(e.parent!); } }, short(e.parent)) : "none (genesis)"],
    ["tree", h("span", { class: "mono" }, short(e.tree))],
    ["kind", e.kind + (e.tool_name ? ` · ${e.tool_name}` : "") + (e.to_entry ? ` → ${short(e.to_entry)}` : "") + (e.kind === "switch" ? ` · now running /nix@${short(e.at_entry)}${e.previous ? `, was @${short(e.previous)}` : ""}` : "")],
    ["when", new Date(e.time).toLocaleString()],
    ["author", `${e.author.harness || "?"} session ${e.author.session}${e.author.model ? ` · model ${e.author.model}` : ""} · for ${e.author.principal}`],
    ["committer", `node ${e.committer}`],
    ["turn", e.turn_id ?? "—"],
    ["tool call", e.tool_call_id ? h("span", { class: "mono" }, e.tool_call_id) : "—"],
    ["path", h("span", { class: "mono" }, `/datacombs/${e.comb}@${e.id}`)],
  ];
  return h("div", { class: "detail" },
    h("div", { class: "detail-head" },
      h("b", {}, e.message),
      h("span", { class: "grow" }),
      e.kind !== "genesis" || true ? h("button", { onClick: () => doRollback(e.comb, e.id) }, "Roll back to here") : null,
      h("button", { onClick: () => browseAt(e.id) }, "Browse files at this point"),
      h("button", { class: "link", onClick: () => selectEntry(null) }, "close"),
    ),
    h("table", { class: "kv" }, rows.map(([k, v]) => h("tr", {}, h("th", {}, k), h("td", {}, v)))),
    detail?.args != null ? h("details", { open: true, class: "args" }, h("summary", {}, "tool-call arguments (stored by hash)"), h("pre", {}, JSON.stringify(detail.args, null, 2))) : null,
    detail ? h("div", { class: "files" },
      h("h3", {}, `${detail.files.length} file(s) changed`),
      detail.files.map((f) =>
        h("details", { open: detail!.files.length <= 3 },
          h("summary", {}, h("span", { class: `tag ${f.status}` }, f.status), " ", h("span", { class: "mono" }, f.path)),
          detail!.diffs[f.path] ? renderDiff(detail!.diffs[f.path]) : h("p", { class: "muted" }, "binary or empty"),
        )),
    ) : h("p", { class: "muted" }, "loading diff…"),
    treeAt && treeAt.entryId === e.id ? renderTreeAt() : null,
  );
}

function renderFiles(): Node {
  const fv = filesView!;
  const where = fv.comb === "nix" ? "/nix" : `/datacombs/${fv.comb}`;
  return h("div", { class: "detail files-view" },
    h("div", { class: "detail-head" },
      h("b", {}, `files in ${where}`),
      h("span", { class: "muted" }, fv.comb === "nix" ? " — saving machine.json switches the running system" : " — saving commits an external entry, as you"),
      h("span", { class: "grow" }),
      h("button", { class: "link", onClick: () => { filesView = null; render(); } }, "close"),
    ),
    h("div", { class: "files-split" },
      h("ul", { class: "file-list" }, fv.files.length ? fv.files.map(([p, hash, size]) =>
        h("li", { class: fv.open?.path === p ? "selected" : "" }, h("a", { href: "#", onClick: (ev: Event) => { ev.preventDefault(); openFile(fv.comb, p); } }, p), h("span", { class: "muted mono" }, ` ${size} B · ${short(hash)}`))) : h("li", { class: "muted" }, "empty")),
      fv.open ? h("div", { class: "editor" },
        h("div", { class: "row" }, h("span", { class: "mono" }, fv.open.path), fv.open.dirty ? h("span", { class: "warn" }, " · modified") : null, h("span", { class: "grow" }),
          h("button", { class: "primary", disabled: !fv.open.dirty, onClick: saveFile }, "Save & commit")),
        h("textarea", { "data-key": "editor", class: "mono", rows: 18, value: fv.open.text, spellcheck: false, onInput: (e: any) => { fv.open!.text = e.target.value; if (!fv.open!.dirty) { fv.open!.dirty = true; render(); } } }),
      ) : h("div", { class: "muted" }, "pick a file"),
    ),
  );
}

function renderDiff(d: string): Node {
  return h("pre", { class: "diff" }, d.split("\n").map((line) => {
    const cls = line.startsWith("+") && !line.startsWith("+++") ? "add" : line.startsWith("-") && !line.startsWith("---") ? "del" : line.startsWith("@@") ? "hunk" : "";
    return h("div", { class: cls }, line || " ");
  }));
}

function renderTreeAt(): Node {
  const t = treeAt!;
  return h("div", { class: "tree" },
    h("h3", {}, "files at ", h("span", { class: "mono" }, `/datacombs/${selectedComb}@${short(t.entryId)}`), ` (${t.files.length})`),
    t.files.length ? h("ul", {}, t.files.map(([p, hash, size]) =>
      h("li", {}, h("a", { href: "#", onClick: (ev: Event) => { ev.preventDefault(); openAt(t.entryId, p); } }, p), h("span", { class: "muted mono" }, ` ${size} B · ${short(hash)}`)))) : h("p", { class: "muted" }, "empty tree"),
    t.open ? h("div", {}, h("h4", { class: "mono" }, t.open.path), h("pre", { class: "file" }, t.open.text)) : null,
  );
}

// ---------- git remotes ----------
const statusOf = (comb: string) => remoteStatus.find((r) => r.comb === comb) ?? null;
const configOf = (comb: string) => remoteConfigs.find((r) => r.comb === comb) ?? null;

function gitChip(comb: string): Node | null {
  const st = statusOf(comb);
  if (!st) return null;
  const text = st.state === "synced" ? (st.ahead ? `↑${st.ahead}` : "✓") : st.state === "syncing" ? "…" : st.state;
  return h("span", { class: `chip ${st.state}`, title: st.error ?? `${st.label}: ${st.state}` }, text);
}

function gitMark(e: HistoryEntry): Node | null {
  const st = statusOf(e.comb);
  const sha = st?.pushed[e.id];
  if (!sha) return null;
  return st!.web
    ? h("a", { class: "gitmark", href: `${st!.web}/commit/${sha}`, target: "_blank", title: `git commit ${sha}`, onClick: (ev: Event) => ev.stopPropagation() }, ` · git ${sha.slice(0, 7)}`)
    : h("span", { class: "gitmark", title: `git commit ${sha}` }, ` · git ${sha.slice(0, 7)}`);
}

function clientIdFor(url: string): string {
  try { return JSON.parse(localStorage.getItem("pi-on-gfs.oauthClients") ?? "{}")[new URL(url).origin] ?? ""; } catch { return ""; }
}
function rememberClientId(url: string, id: string) {
  try {
    const m = JSON.parse(localStorage.getItem("pi-on-gfs.oauthClients") ?? "{}");
    m[new URL(url).origin] = id;
    localStorage.setItem("pi-on-gfs.oauthClients", JSON.stringify(m));
  } catch {}
}

function toggleGit(comb: string) {
  if (gitView?.comb === comb) gitView = null;
  else {
    const cfg = configOf(comb);
    gitView = { comb, draft: cfg ? null : newDraft(comb), clientId: "" };
    filesView = null;
  }
  render();
}

function newDraft(comb: string): RemoteConfig {
  return { comb, transport: bridgeVersion ? "git" : "github", url: "", branch: "main", username: "", token: "", corsProxy: "", auto: true };
}

async function upsertRemote(cfg: RemoteConfig) {
  remoteConfigs = [...remoteConfigs.filter((c) => c.comb !== cfg.comb), cfg];
  if (gitView?.comb === cfg.comb) gitView.draft = null;
  saveRemotes();
  remoteStatus = await worker.call({ method: "remotesConfigure", remotes: remoteConfigs });
  render();
}
async function disconnectRemote(comb: string) {
  remoteConfigs = remoteConfigs.filter((c) => c.comb !== comb);
  saveRemotes();
  remoteStatus = await worker.call({ method: "remotesConfigure", remotes: remoteConfigs });
  render();
}

const isGitHub = (url: string) => { try { return new URL(url).host === "github.com"; } catch { return false; } };

function renderGit(): Node {
  const gv = gitView!;
  const where = gv.comb === NIX_COMB ? "/nix" : `/datacombs/${gv.comb}`;
  return h("div", { class: "detail git-view" },
    h("div", { class: "detail-head" },
      h("b", {}, `git remote for ${where}`),
      h("span", { class: "muted" }, " — every history entry becomes one git commit, pushed as it lands"),
      h("span", { class: "grow" }),
      h("button", { class: "link", onClick: () => { gitView = null; render(); } }, "close"),
    ),
    gv.draft ? renderGitForm(gv, gv.draft) : renderGitStatus(gv),
  );
}

function renderGitStatus(gv: NonNullable<typeof gitView>): Node {
  const cfg = configOf(gv.comb);
  const st = statusOf(gv.comb);
  if (!cfg) return h("p", { class: "muted" }, "not connected");
  const link = (sha: string | null) => (sha ? (st?.web ? h("a", { href: `${st.web}/commit/${sha}`, target: "_blank", class: "mono" }, sha.slice(0, 12)) : h("span", { class: "mono" }, sha.slice(0, 12))) : "—");
  const act = async (label: string, f: () => Promise<unknown>) => {
    gv.busy = label; render();
    try { await f(); error = null; } catch (e: any) { error = e.message; }
    gv.busy = undefined; render();
  };
  return h("div", {},
    h("table", { class: "kv" },
      h("tr", {}, h("th", {}, "remote"), h("td", {}, h("span", { class: "mono" }, cfg.url), ` · ${cfg.transport === "github" ? "GitHub REST API" : "git smart HTTP"}${cfg.corsProxy ? ` via ${cfg.corsProxy}` : ""}`)),
      h("tr", {}, h("th", {}, "branch"), h("td", { class: "mono" }, cfg.branch)),
      h("tr", {}, h("th", {}, "state"), h("td", {}, gitChip(gv.comb), st ? ` ${st.state}${st.ahead ? ` · ${st.ahead} entr${st.ahead === 1 ? "y" : "ies"} not pushed yet` : ""}` : " starting")),
      h("tr", {}, h("th", {}, "remote tip"), h("td", {}, link(st?.remoteHead ?? null))),
      h("tr", {}, h("th", {}, "on the remote"), h("td", {}, `${Object.keys(st?.pushed ?? {}).length} entries`)),
      h("tr", {}, h("th", {}, "last sync"), h("td", {}, st?.lastSync ? new Date(st.lastSync).toLocaleTimeString() : "—")),
      h("tr", {}, h("th", {}, "signed in"), h("td", {}, cfg.oauth ? `${cfg.oauth.flow}${cfg.oauth.expiresAt ? `, token until ${new Date(cfg.oauth.expiresAt).toLocaleTimeString()}` : ""}` : cfg.token ? "access token" : h("span", { class: "warn" }, "no token (read-only, public repositories)"))),
    ),
    st?.error ? h("div", { class: `error inline` }, st.error) : null,
    st?.state === "diverged" ? h("div", { class: "row diverged" },
      h("button", { disabled: !!gv.busy, onClick: () => act("keeping ours", () => worker.call({ method: "remoteResolve", comb: gv.comb, choice: "mine" })) }, "Keep mine"),
      h("span", { class: "muted small" }, "push ours; the tip merges theirs as a second parent, ours wins the tree"),
      h("button", { disabled: !!gv.busy, onClick: () => act("taking theirs", () => worker.call({ method: "remoteResolve", comb: gv.comb, choice: "theirs" })) }, "Take theirs"),
      h("span", { class: "muted small" }, "their tree lands as a pull entry; our entries are pushed underneath it"),
    ) : null,
    h("div", { class: "row" },
      h("button", { class: "primary", disabled: !!gv.busy, onClick: () => act("syncing", () => worker.call({ method: "remoteSync", comb: gv.comb })) }, gv.busy ?? "Sync now"),
      h("button", { onClick: () => { gv.draft = { ...cfg }; gv.clientId = cfg.oauth?.clientId ?? clientIdFor(cfg.url); render(); } }, "Edit"),
      h("button", { class: "danger", onClick: () => { if (confirm(`Disconnect ${gv.comb} from ${cfg.url}? Nothing is deleted on either side.`)) void disconnectRemote(gv.comb); } }, "Disconnect"),
    ),
    st?.events.length ? h("ul", { class: "git-events" }, [...st.events].reverse().map((e) => h("li", {}, h("span", { class: "muted mono" }, fmtTime(e.time)), " ", e.text))) : null,
  );
}

function renderGitForm(gv: NonNullable<typeof gitView>, d: RemoteConfig): Node {
  const gh = isGitHub(d.url);
  const field = (label: string, key: keyof RemoteConfig, attrs: Record<string, any> = {}) =>
    h("label", {}, label, h("input", { value: (d[key] as string) ?? "", onInput: (e: any) => { (d as any)[key] = e.target.value; }, onChange: () => render(), ...attrs }));
  const reach =
    d.transport === "github"
      ? "Works from a plain tab: api.github.com answers CORS. Needs a token for anything but reading public repositories."
      : gh
        ? bridgeVersion ? "github.com's git endpoints send no CORS headers; the egress extension relays them." : d.corsProxy ? "Through the CORS proxy (it sees your token)." : "github.com's git endpoints send no CORS headers: install the egress extension, set a CORS proxy, or pick the GitHub API transport."
        : "The server must send CORS for this page (Forgejo/Gitea: [repository] ACCESS_CONTROL_ALLOW_ORIGIN = " + location.origin + "), or the egress extension relays it.";
  return h("div", { class: "git-form" },
    h("div", { class: "grid" },
      h("label", {}, "transport",
        h("select", { onChange: (e: any) => { d.transport = e.target.value; render(); } },
          h("option", { value: "git", selected: d.transport === "git" }, "git smart HTTP — any git server (Forgejo, GitHub, GitLab, …)"),
          h("option", { value: "github", selected: d.transport === "github" }, "GitHub REST API — github.com from a plain tab"),
        )),
      field("repository URL", "url", { placeholder: d.transport === "github" ? "https://github.com/you/repo" : "https://forgejo.example/you/repo.git", "data-key": "git-url" }),
      field("branch", "branch", { placeholder: "main" }),
      d.transport === "git" ? field("user name (Basic auth; Forgejo: your login · GitHub: x-access-token)", "username") : null,
      field(gh || d.transport === "github" ? "token (fine-grained PAT, Contents: read and write)" : "token (access token with write:repository, or sign in below)", "token", { type: "password", autocomplete: "off" }),
      d.transport === "git" ? field("CORS proxy (optional, e.g. https://cors.isomorphic-git.org — it sees your token)", "corsProxy") : null,
      h("details", {}, h("summary", {}, "committer (the node's git identity)"),
        field("name", "committerName", { placeholder: info?.node ?? "browser-node" }),
        field("email", "committerEmail", { placeholder: `${info?.node ?? "browser-node"}@gfs.invalid` }),
      ),
    ),
    h("p", { class: "muted small" }, reach),
    renderSignIn(gv, d, gh),
    gv.device ? h("div", { class: "notice device" }, "Open ", h("a", { href: gv.device.uri, target: "_blank" }, gv.device.uri), " and enter ", h("b", { class: "mono" }, gv.device.code), ". Waiting for approval…") : null,
    h("div", { class: "row" },
      h("button", { class: "primary", disabled: !d.url || !d.branch, onClick: () => { const cfg = { ...d, url: d.url.trim(), branch: d.branch.trim() || "main" }; gv.draft = null; gv.device = undefined; void upsertRemote(cfg); } }, configOf(gv.comb) ? "Save" : "Connect"),
      h("button", { onClick: () => { if (configOf(gv.comb)) { gv.draft = null; gv.device = undefined; render(); } else { gitView = null; render(); } } }, "Cancel"),
    ),
  );
}

function renderSignIn(gv: NonNullable<typeof gitView>, d: RemoteConfig, gh: boolean): Node | null {
  if (!d.url) return null;
  if (!gv.clientId) gv.clientId = clientIdFor(d.url);
  const idField = h("input", { value: gv.clientId, placeholder: "OAuth client ID", onInput: (e: any) => (gv.clientId = e.target.value) });
  if (gh || d.transport === "github") {
    return h("div", { class: "signin" },
      h("b", {}, "Sign in with GitHub"), h("span", { class: "muted small" }, " (device flow; client ID of your OAuth or GitHub App with device flow enabled)"),
      h("div", { class: "row" }, idField,
        h("button", { disabled: !bridgeVersion || !!gv.device, onClick: () => void githubSignIn(gv, d) }, "Sign in"),
        bridgeVersion ? null : h("span", { class: "warn small" }, "needs the egress extension: github.com/login/* sends no CORS headers"),
      ),
    );
  }
  return h("div", { class: "signin" },
    h("b", {}, "Sign in with Forgejo"), h("span", { class: "muted small" }, ` (OAuth2 + PKCE; a public client whose redirect URI is ${location.origin + location.pathname}; token endpoint needs [cors] or the extension)`),
    h("div", { class: "row" }, idField, h("button", { onClick: () => void forgejoSignIn(d, gv.clientId) }, "Sign in")),
  );
}

async function githubSignIn(gv: NonNullable<typeof gitView>, d: RemoteConfig) {
  const host = new URL(d.url).origin;
  const clientId = gv.clientId.trim();
  if (!clientId) { error = "enter the OAuth client ID first"; render(); return; }
  rememberClientId(d.url, clientId);
  try {
    const dc = await worker.call<{ device_code: string; user_code: string; verification_uri: string; expires_in: number; interval: number }>({ method: "loginDeviceStart", host, clientId, scope: "repo" });
    gv.device = { code: dc.user_code, uri: dc.verification_uri, until: Date.now() + dc.expires_in * 1000 };
    render();
    let interval = dc.interval;
    while (gv.device && Date.now() < gv.device.until) {
      await new Promise((r) => setTimeout(r, interval * 1000));
      const r = await worker.call<any>({ method: "loginDevicePoll", host, clientId, deviceCode: dc.device_code });
      if (r.token) {
        d.token = r.token.access_token;
        if (d.transport === "git" && !d.username) d.username = "x-access-token";
        d.oauth = { flow: "github-device", clientId, tokenUrl: `${host}/login/oauth/access_token`, refreshToken: r.token.refresh_token, expiresAt: r.token.expires_in ? Date.now() + r.token.expires_in * 1000 : undefined };
        gv.device = undefined;
        systemNotice = `signed in to ${new URL(host).host}; press ${configOf(gv.comb) ? "Save" : "Connect"}`;
        render();
        return;
      }
      if (r.slowDown) interval = r.slowDown;
    }
    gv.device = undefined;
  } catch (e: any) {
    gv.device = undefined;
    error = e.message;
  }
  render();
}

const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** Forgejo, authorization code + PKCE: off to the forge; finishForgejoSignIn picks it up on return. */
async function forgejoSignIn(d: RemoteConfig, clientId: string) {
  clientId = clientId.trim();
  if (!clientId) { error = "enter the OAuth client ID first"; render(); return; }
  rememberClientId(d.url, clientId);
  const base = new URL(d.url).origin;
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const redirect = location.origin + location.pathname;
  sessionStorage.setItem("pi-on-gfs.oauth", JSON.stringify({ state, verifier, clientId, base, redirect, draft: d }));
  location.assign(`${base}/login/oauth/authorize?${new URLSearchParams({ client_id: clientId, redirect_uri: redirect, response_type: "code", code_challenge: challenge, code_challenge_method: "S256", state })}`);
}

async function finishForgejoSignIn() {
  const got = new URLSearchParams(oauthReturn);
  const saved = sessionStorage.getItem("pi-on-gfs.oauth");
  if (!saved || !(got.has("code") || got.has("error"))) return;
  sessionStorage.removeItem("pi-on-gfs.oauth");
  const rest = new URLSearchParams(oauthReturn);
  for (const k of ["code", "state", "error", "error_description"]) rest.delete(k);
  history.replaceState(null, "", location.pathname + (rest.size ? `?${rest}` : ""));
  const s = JSON.parse(saved);
  if (got.get("error")) { error = `sign-in refused: ${got.get("error")} ${got.get("error_description") ?? ""}`; return; }
  if (got.get("state") !== s.state) { error = "sign-in: state mismatch, ignored"; return; }
  try {
    const tokenUrl = `${s.base}/login/oauth/access_token`;
    const t = await worker.call<any>({ method: "loginToken", tokenUrl, form: { grant_type: "authorization_code", client_id: s.clientId, code: got.get("code")!, code_verifier: s.verifier, redirect_uri: s.redirect } });
    const d: RemoteConfig = s.draft;
    const cfg: RemoteConfig = { ...d, token: t.access_token, username: d.username || "oauth2", oauth: { flow: "forgejo-pkce", clientId: s.clientId, tokenUrl, refreshToken: t.refresh_token, expiresAt: t.expires_in ? Date.now() + t.expires_in * 1000 : undefined } };
    remoteConfigs = [...remoteConfigs.filter((c) => c.comb !== cfg.comb), cfg];
    saveRemotes();
    systemNotice = `signed in to ${new URL(s.base).host}; ${cfg.comb} is connected to ${cfg.url}`;
  } catch (e: any) {
    error = `sign-in: ${e.message}`;
  }
}

// ---------- boot ----------
render();
setTimeout(() => {
  if (!info && !error) {
    error = `the worker has not answered in 15 s. ${crossOriginIsolated ? "" : "This page is not cross-origin isolated (service worker inactive?). "}${typeof navigator.storage?.getDirectory === "function" ? "" : "No OPFS in this browser. "}Open the browser console for details.`;
    render();
  }
}, 15000);
(async () => {
  try {
    info = await worker.call<InitInfo>({ method: "init", shell: new URLSearchParams(location.search).get("shell") ?? undefined, trace: new URLSearchParams(location.search).get("trace") === "1" });
    statusText = "ready; starting the system…";
    config = { ...info.config, ...config };
    await worker.call({ method: "configure", config });
    transcript = await worker.call({ method: "transcript" });
    for (const c of info.combs) await refreshLog(c);
    await finishForgejoSignIn();
    remoteStatus = await worker.call({ method: "remotesConfigure", remotes: remoteConfigs });
    await refreshViews();
    render();
    if (viewName(surface) != null) {
      if (views.includes(viewName(surface)!)) void loadView();
      else setSurface("console");
    }
    void worker.call({ method: "boot" });
  } catch (e: any) {
    error = `worker failed to start: ${e.message}`;
    statusText = "failed";
    console.error(e);
  }
  render();
})();

// Exposed for the headless test driver.
(window as any).__pi = {
  worker,
  state: () => ({ info, transcript, logs, busy, error, statusText, bridgeVersion, remoteStatus, remoteConfigs, notice: systemNotice }),
  connect: (cfg: RemoteConfig) => upsertRemote(cfg),
  disconnect: (comb: string) => disconnectRemote(comb),
  signInForgejo: (d: RemoteConfig, clientId: string) => forgejoSignIn(d, clientId),
};

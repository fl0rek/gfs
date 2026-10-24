// PROTOTYPE. The page: pi's console on the left, the comb's history on the right.

import { AgentWorker } from "./rpc";
import type { EntryDetail, HistoryEntry, InitInfo, ModelConfig, VerifyReport } from "./protocol";
import { CWD, WORKSPACE } from "./paths";

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
let error: string | null = null;
let config: ModelConfig = loadConfig();

function loadConfig(): ModelConfig {
  try {
    const s = sessionStorage.getItem("pi-on-gfs.config");
    if (s) return JSON.parse(s);
  } catch {}
  return { provider: "mock", model: "scripted-agent", apiKey: "" };
}
function saveConfig() {
  sessionStorage.setItem("pi-on-gfs.config", JSON.stringify(config));
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
  } else if (n.type === "error") {
    error = n.message;
    busy = false;
    render();
  } else if (n.type === "history") {
    if (info) info.objectCount = n.objectCount;
    await refreshLog(n.comb);
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

async function wipe() {
  if (!confirm("Wipe everything stored in this browser (all combs, the whole history, the transcript)?")) return;
  await worker.call({ method: "wipe" });
  location.reload();
}

// ---------- rendering ----------
function render() {
  app.replaceChildren(h("div", { class: "root" },
    h("header", { class: "top" },
      h("div", { class: "brand" }, h("b", {}, "pi on gfs"), h("span", { class: "muted" }, " · prototype, throwaway")),
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
    h("main", { class: "split" }, renderConsole(), renderTimeline()),
  ));
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
    placeholder: busy ? "working…" : `Ask pi to do something in ${CWD} — or !cmd to run it in the shell yourself`,
    rows: 3,
    disabled: busy,
    onKeydown: (e: KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        const t = (e.target as HTMLTextAreaElement).value;
        (e.target as HTMLTextAreaElement).value = "";
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
        h("button", { class: "primary", disabled: busy, onClick: () => { void send(input.value); input.value = ""; } }, "Send"),
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
  const providers: ModelConfig["provider"][] = ["mock", "deepseek", "opencode", "openai-compatible"];
  const defaults: Record<string, string> = { mock: "scripted-agent", deepseek: "deepseek-v4-pro", opencode: "claude-sonnet-4-6", "openai-compatible": "" };
  return h("details", { class: "config", open: config.provider !== "mock" && !config.apiKey },
    h("summary", {}, "model: ", h("b", {}, `${config.provider} / ${config.model}`), config.provider !== "mock" && !config.apiKey ? h("span", { class: "warn" }, " · no API key") : null),
    h("div", { class: "grid" },
      h("label", {}, "provider",
        h("select", { value: config.provider, onChange: (e: any) => { config.provider = e.target.value; config.model = defaults[config.provider]; render(); } },
          providers.map((p) => h("option", { value: p, selected: p === config.provider }, p))),
      ),
      h("label", {}, "model", h("input", { value: config.model, onInput: (e: any) => (config.model = e.target.value) })),
      config.provider === "openai-compatible" ? h("label", {}, "base URL", h("input", { value: config.baseUrl ?? "", placeholder: "https://host/v1", onInput: (e: any) => (config.baseUrl = e.target.value) })) : null,
      config.provider !== "mock" ? h("label", {}, "API key (kept in sessionStorage only)", h("input", { type: "password", value: config.apiKey, onInput: (e: any) => (config.apiKey = e.target.value) })) : null,
      h("div", { class: "row" },
        h("button", { onClick: applyConfig }, "Apply"),
        h("button", { onClick: () => worker.call({ method: "shellWarmup" }).catch((e) => { error = e.message; render(); }) }, "Start bash now"),
        h("button", { class: "danger", onClick: wipe }, "Wipe browser storage"),
      ),
      h("p", { class: "muted small" }, "The key goes straight from this tab to the provider; CORS is the provider's call. Requests are made from the worker."),
    ),
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
      verify ? h("span", { class: verify.ok ? "ok" : "warn" }, verify.ok ? ` ✓ ${verify.entries} entries, ${verify.objects_checked} objects hash correctly` : ` ✗ ${verify.problems.join("; ")}`) : null,
    ),
    h("div", { class: "timeline-body" }, list, selectedEntry ? renderDetail() : null),
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
    h("span", { class: `tag ${e.kind}` }, e.kind === "tool_call" ? e.tool_name : e.kind),
    h("span", { class: "text" }, e.message),
    h("span", { class: "meta mono" },
      n ? `${e.summary.added.length ? "+" + e.summary.added.length + " " : ""}${e.summary.modified.length ? "~" + e.summary.modified.length + " " : ""}${e.summary.removed.length ? "−" + e.summary.removed.length + " " : ""}` : "",
      "@", short(e.id)),
  );
}

function renderDetail(): Node {
  const e = detail?.entry ?? (logs[selectedComb] ?? []).find((x) => x.id === selectedEntry);
  if (!e) return h("div", { class: "detail" }, "loading…");
  const rows: [string, Child][] = [
    ["entry", h("span", { class: "mono" }, e.id)],
    ["parent", e.parent ? h("a", { href: "#", onClick: (ev: Event) => { ev.preventDefault(); selectEntry(e.parent!); } }, short(e.parent)) : "none (genesis)"],
    ["tree", h("span", { class: "mono" }, short(e.tree))],
    ["kind", e.kind + (e.tool_name ? ` · ${e.tool_name}` : "") + (e.to_entry ? ` → ${short(e.to_entry)}` : "")],
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

// ---------- boot ----------
render();
(async () => {
  try {
    info = await worker.call<InitInfo>({ method: "init", shell: new URLSearchParams(location.search).get("shell") ?? undefined });
    statusText = "ready";
    config = { ...info.config, ...config };
    await worker.call({ method: "configure", config });
    transcript = await worker.call({ method: "transcript" });
    for (const c of info.combs) await refreshLog(c);
  } catch (e: any) {
    error = `worker failed to start: ${e.message}`;
    statusText = "failed";
  }
  render();
})();

// Exposed for the headless test driver.
(window as any).__pi = { worker, state: () => ({ info, transcript, logs, busy, error, statusText, bridgeVersion }) };

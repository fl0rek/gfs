// PROTOTYPE. The agent worker: pi (pi-agent-core + pi-ai) on a gfs-backed world.
//
// Owns: the datacombs engine (wasm) and its OPFS persistence, the pi Agent and
// its four tools, the WASIX shell, and the session transcript comb. The page
// only ever talks to it through postMessage (see protocol.ts).

import { Agent, type AgentEvent, type AgentMessage } from "@earendil-works/pi-agent-core";
import { createModels, createProvider, type Model, type MutableModels } from "@earendil-works/pi-ai";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { opencodeProvider } from "@earendil-works/pi-ai/providers/opencode";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import { groqProvider } from "@earendil-works/pi-ai/providers/groq";
import { cerebrasProvider } from "@earendil-works/pi-ai/providers/cerebras";
import { mistralProvider } from "@earendil-works/pi-ai/providers/mistral";
import { FreeRouter, loadFreeList } from "./free";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { Datacombs, type EntryKind } from "./gfs";
import { makeTools } from "./tools";
import { WasixShell, UnavailableShell, installRegistryShim, loadDeployedSystem, processLog, runtimeHeapBytes, type Shell, type SystemManifest } from "./shell";
import { readMachine, machineSnapshot, type MachineSources } from "./machine";
import { createMockProvider, MOCK_MODEL_ID, MOCK_PROVIDER_ID } from "./mock-model";
import { CWD, WORKSPACE, NIX_COMB, resolvePath } from "./paths";
import type { Author, BridgeInbound, EntryDetail, InitInfo, ModelConfig, Notification, Reply, Request } from "./protocol";
import { installBridge, onBridgeEvent, setBridgeAvailable, smartFetch, egressMode } from "./egress";

const NODE = "browser-node";
const SESSION_COMB = "session";
const BASH_PACKAGE = "wasmer/bash";

const dc = new Datacombs();
let models: MutableModels;
let agent: Agent | null = null;
let shell: Shell = new UnavailableShell("not started yet");
let config: ModelConfig = { provider: "mock", model: MOCK_MODEL_ID, apiKey: "" };
let sessionId = "";
let turnIndex = 0;
let currentTurnId = "";
const startedAt = Date.now();
let switchCount = 0;
let toolCallCount = 0;
/** The system the shell is running: the /nix comb's machine.json as of the entry it was switched at. */
let runningSystem: { manifest: SystemManifest; entry: string; switchedAt: number } | null = null;
let shellOrigin: URL = new URL(import.meta.env.BASE_URL, self.location.href);
let pendingBoot = false;

/** Why the shell cannot run here, if it cannot. Checked before trying, so phones get an answer, not a hang. */
function shellBlocker(): string | null {
  if (typeof SharedArrayBuffer === "undefined" || !(self as any).crossOriginIsolated)
    return "no SharedArrayBuffer: the page is not cross-origin isolated (the COOP/COEP service worker did not take effect; reload once, or this browser blocks it)";
  return null;
}

let bootInProgress: Promise<void> | null = null;
function bootSystem(): Promise<void> {
  if (!bootInProgress) bootInProgress = bootSystemOnce().finally(() => (bootInProgress = null));
  return bootInProgress;
}
async function currentShell(): Promise<Shell> {
  if (pendingBoot || bootInProgress) await bootSystem();
  return shell;
}
async function bootSystemOnce() {
  if (!pendingBoot) return;
  pendingBoot = false;
  const why = shellBlocker();
  if (why) {
    shell = new UnavailableShell(why);
    if (agent) agent.state.tools = makeToolsFor();
    status(`shell unavailable: ${why}`, false);
    post({ type: "system", entry: dc.head(NIX_COMB), name: "(shell unavailable)", reason: why });
    return;
  }
  const watchdog = setTimeout(() => status("the system is taking long to start (18 MB of wasm; slow network or device?)…", true), 20000);
  try {
    await switchSystem("boot");
  } finally {
    clearTimeout(watchdog);
  }
}
const mock = createMockProvider();
let free: FreeRouter;

const post = (n: Notification) => self.postMessage(n);
installBridge({ send: (id, req) => post({ type: "bridge", reqId: id, req }) });
const status = (text: string, busy?: boolean) => post({ type: "status", text, busy });

function author(): Author {
  return { session: sessionId, harness: "pi", model: `${config.provider}/${config.model}`, principal: "user" };
}

function turnId() {
  return currentTurnId;
}

async function init(shellParam?: string): Promise<InitInfo> {
  await dc.open(NODE);
  sessionId = `pi-${new Date().toISOString().slice(0, 19).replace(/[-:]/g, "")}-${Math.random().toString(36).slice(2, 6)}`;
  if (!dc.hasComb(WORKSPACE)) await dc.createComb(WORKSPACE, author());
  if (!dc.hasComb(SESSION_COMB)) await dc.createComb(SESSION_COMB, author());

  models = createModels();
  models.setProvider(mock.provider);
  models.setProvider(deepseekProvider());
  models.setProvider(opencodeProvider());
  for (const p of [openrouterProvider(), googleProvider(), groqProvider(), cerebrasProvider(), mistralProvider()]) models.setProvider(p);
  free = new FreeRouter(models, () => config.freeKeys ?? {}, (m) => console.log(m));
  models.setProvider(free.provider());
  void loadFreeList(smartFetch, new URL("free-models.json", shellOrigin)).then((l) => {
    free.list = l;
    console.log(`free: ${l.models.length} models, list updated ${l.updated}`);
  });

  // Shell: real WASIX bash from the registry; the page may override the source for tests.
  if (shellParam === "none") shell = new UnavailableShell("disabled with ?shell=none");
  else if (shellParam?.startsWith("module:")) {
    const [url, command] = shellParam.slice("module:".length).split(",");
    const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
    shell = new WasixShell(dc, { kind: "module", bytes, command: command || "sh" }, status);
  } else if (shellParam === "registry") {
    shell = new WasixShell(dc, { kind: "registry", name: BASH_PACKAGE }, status);
  } else {
    // Default: whatever /nix says. The comb is seeded from the system this build deployed.
    const deployed = await loadDeployedSystem(shellOrigin);
    installRegistryShim(new URL("packages/", shellOrigin), { packages: Object.fromEntries(deployed.manifest.packages.map((p) => [p.name, p.sha256])), registry: deployed.registry });
    if (!dc.hasComb(NIX_COMB)) {
      await dc.createComb(NIX_COMB, { session: sessionId, harness: "system", model: "", principal: "user" });
      dc.writeFile(NIX_COMB, "flake.nix", deployed.flake);
      dc.writeFile(NIX_COMB, "machine.json", JSON.stringify(deployed.manifest, null, 2) + "\n");
      dc.writeFile(
        NIX_COMB,
        "README.md",
        [
          "# /nix — the running system",
          "",
          "This comb holds the flake of the system this session runs on.",
          "",
          "- `machine.json` is the built system: the packages the shell sandbox loads, each pinned by sha256. Change it and commit (any tool call that edits it does) and the shell is rebuilt from the new manifest: that is the switch. A package whose bytes don't match its hash is refused and the old system keeps running.",
          "- `flake.nix` is the source of that system. The browser cannot run `nix build`; CI (or your machine) builds the flake and publishes the result, which then lands here as a new `machine.json`.",
          "",
          "Every switch is a history entry of this comb, so the timeline shows which system was running when.",
          "",
        ].join("\n"),
      );
      await dc.commit(NIX_COMB, { kind: "external" }, { session: sessionId, harness: "system", model: "", principal: "user" });
    }
    // Don't block the page on 18 MB of wasm: the system comes up after init returns.
    pendingBoot = true;
  }

  buildAgent(restoreTranscript());
  return {
    node: NODE,
    sessionId,
    combs: dc.listCombs(),
    persistence: dc.persistence,
    objectCount: dc.objectCount(),
    config,
    system: runningSystem ? { entry: runningSystem.entry, name: runningSystem.manifest.name ?? "" } : null,
  };
}

/**
 * Commit a change to a comb. For /nix this is atomic with the switch: the new system is
 * booted from the working tree first; only if that succeeds are the change and a `switch`
 * entry committed, otherwise the working tree is reset to head and the error is thrown
 * to whoever made the change. So /nix's head is always the running system.
 */
async function commitComb(comb: string, kind: EntryKind, author: Author, reason: string): Promise<string | null> {
  if (comb !== NIX_COMB) {
    const id = await dc.commit(comb, kind, author);
    if (id) post({ type: "history", comb, objectCount: dc.objectCount() });
    return id;
  }
  const changed = dc.status(NIX_COMB);
  if (changed.length === 0) return null;
  const manifestChanged = changed.some((d) => d.path === "machine.json");
  let next: WasixShell | null = null;
  let manifest: SystemManifest | null = null;
  if (manifestChanged) {
    try {
      manifest = parseManifest(dc.readText(NIX_COMB, "machine.json"));
      if (!runningSystem || JSON.stringify(runningSystem.manifest) !== JSON.stringify(manifest)) {
        next = new WasixShell(dc, { kind: "system", base: shellOrigin, manifest }, status);
        await next.warmup();
      }
    } catch (e: any) {
      await next?.close();
      dc.resetWorking(NIX_COMB);
      status(`switch refused: ${e.message}`, false);
      post({ type: "error", message: `switch refused, /nix change dropped: ${e.message}` });
      throw new Error(`switch refused: ${e.message}. /nix/machine.json was reverted to the running system; nothing was committed.`);
    }
  }
  const id = await dc.commit(NIX_COMB, kind, author);
  post({ type: "history", comb: NIX_COMB, objectCount: dc.objectCount() });
  if (id && manifest) await adoptSystem(next, manifest, id, reason);
  return id;
}

function parseManifest(text: string): SystemManifest {
  const m = JSON.parse(text);
  if (!m.shell || !Array.isArray(m.packages)) throw new Error("machine.json needs {shell, packages[]}");
  return m;
}

/** Make `next` (already warmed up; null when the packages are unchanged) the running system at /nix@entry. */
async function adoptSystem(next: WasixShell | null, manifest: SystemManifest, entry: string, reason: string) {
  const previous = runningSystem?.entry ?? null;
  if (next) {
    const old = shell;
    shell = next;
    await old.close();
    if (agent) agent.state.tools = makeToolsFor();
  }
  runningSystem = { manifest, entry, switchedAt: Date.now() };
  switchCount++;
  // The switch is an event of its own in /nix's history: same tree, different kind.
  await dc.commit(NIX_COMB, { kind: "switch", at_entry: entry, previous, system: manifest.name ?? "" }, { session: sessionId, harness: "node", model: "", principal: "user" });
  post({ type: "history", comb: NIX_COMB, objectCount: dc.objectCount() });
  status(`system: /nix@${entry.slice(0, 8)} (${reason})`, false);
  post({ type: "system", entry, name: manifest.name ?? "", reason });
}

/** Boot: run whatever /nix's head says (the last committed system). */
async function switchSystem(reason: string): Promise<boolean> {
  const head = dc.head(NIX_COMB);
  // The entry the running system corresponds to: head, or what the last switch pointed at.
  const headEntry = dc.entry(head);
  const at = headEntry.kind === "switch" && headEntry.at_entry ? headEntry.at_entry : head;
  let manifest: SystemManifest;
  try {
    manifest = parseManifest(dc.readText(NIX_COMB, "machine.json"));
  } catch (e: any) {
    status(`/nix/machine.json is invalid (${e.message}); no system`, false);
    post({ type: "error", message: `boot refused: ${e.message}` });
    return false;
  }
  const next = new WasixShell(dc, { kind: "system", base: shellOrigin, manifest }, status);
  try {
    await next.warmup();
  } catch (e: any) {
    status(`the system failed to start: ${e.message}`, false);
    post({ type: "error", message: `/nix@${at.slice(0, 8)} failed to start: ${e.message}` });
    await next.close();
    shell = new UnavailableShell(`the system failed to start: ${e.message}`);
    if (agent) agent.state.tools = makeToolsFor();
    return false;
  }
  const old = shell;
  shell = next;
  await old.close();
  runningSystem = { manifest, entry: at, switchedAt: Date.now() };
  if (agent) agent.state.tools = makeToolsFor();
  status(`system: /nix@${at.slice(0, 8)} (${reason})`, false);
  post({ type: "system", entry: at, name: manifest.name ?? "", reason });
  return true;
}

function restoreTranscript(): AgentMessage[] {
  try {
    if (dc.exists(SESSION_COMB, "transcript.json")) {
      const saved = JSON.parse(dc.readText(SESSION_COMB, "transcript.json"));
      turnIndex = saved.turnIndex ?? 0;
      return saved.messages ?? [];
    }
  } catch (e) {
    console.warn("could not restore transcript", e);
  }
  return [];
}

function systemPrompt() {
  return [
    "You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.",
    "",
    "<tools>",
    "- read: Read file contents",
    "- bash: Execute bash commands (ls, grep, find, etc.)",
    "- edit: Make precise file edits with exact text replacement, including multiple disjoint edits in one call",
    "- write: Create or overwrite files",
    "</tools>",
    "",
    "<rules>",
    "- Use bash for file operations like ls, rg, find",
    "- Use read to examine files instead of cat or sed.",
    "- Use edit for precise changes (edits[].oldText must match exactly)",
    "- Use write only for new files or complete rewrites.",
    "- Be concise in your responses",
    "- Show file paths clearly when working with files",
    "</rules>",
    "",
    "<environment>",
    `Your working directory is ${CWD}. It is a comb: a versioned directory whose every tool call becomes one history entry. The past is readable at ${CWD}@<entry-id>/<path>.`,
    `/nix is the comb holding the running system's flake: machine.json lists the packages the shell sandbox runs, pinned by sha256; editing it (any tool call that changes it) switches the system; flake.nix is its source but cannot be built here.`,
    `/machine is read-only and describes this node (read /machine for the index: session, system, shell, processes, runtime, agent, storage, egress, mounts, uptime).`,
    `bash runs in a WASIX sandbox over the same root (/datacombs/<comb>, /nix, /machine; the @<entry> views are not mounted there). The Nix-built system has bash, coreutils, grep, sed, awk, find, xargs, diff; no git. It has no network; use the fetch tool for HTTP. Prefer the read tool over cat.`,
    "</environment>",
    "",
    `<cwd>${CWD}</cwd>`,
  ].join("\n");
}

function currentModel(): Model<any> {
  if (config.provider === "mock") return mock.getModel();
  if (config.provider === "free") return models.getModel("free", "free")!;
  if (config.provider === "openai-compatible") {
    const id = "custom";
    const m: Model<"openai-completions"> = {
      id: config.model,
      name: config.model,
      api: "openai-completions",
      provider: id,
      baseUrl: config.baseUrl || "",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 16384,
    };
    models.setProvider(
      createProvider({
        id,
        name: "OpenAI-compatible",
        baseUrl: m.baseUrl,
        auth: { apiKey: { name: "API key", resolve: async () => ({ auth: {} }) } },
        models: [m],
        api: openAICompletionsApi(),
      }) as any,
    );
    return m;
  }
  const m = models.getModel(config.provider, config.model);
  if (!m) throw new Error(`unknown model ${config.provider}/${config.model}`);
  return m;
}

/** What /machine is made of. */
const machineSources: MachineSources = {
  startedAt,
  session: () => ({ id: sessionId, node: NODE, started: new Date(startedAt).toISOString(), harness: "pi", model: `${config.provider}/${config.model}`, turn: currentTurnId || null, turns: turnIndex }),
  system: () =>
    runningSystem
      ? { entry: runningSystem.entry, path: `/nix@${runningSystem.entry}`, since: new Date(runningSystem.switchedAt).toISOString(), name: runningSystem.manifest.name ?? null, shell: runningSystem.manifest.shell, packages: runningSystem.manifest.packages.map((p) => ({ name: p.name, sha256: p.sha256, url: p.url })) }
      : { entry: null, note: "no system running (shell unavailable or still booting)" },
  shell: () => ({ ready: shell instanceof WasixShell, booting: !!(pendingBoot || bootInProgress), commands: shell.commands(), packages: shell.packages(), bootedAt: shell.bootedAt, switches: switchCount }),
  egress: () => egressMode(),
  combs: () => dc.listCombs().map((c) => { const files = dc.listAll(c); return { name: c, head: dc.head(c), files: files.length, bytes: files.reduce((n, [, , size]) => n + size, 0) }; }),
  objectCount: () => dc.objectCount(),
  storageEstimate: async () => { try { const e = await navigator.storage.estimate(); return { usage: e.usage, quota: e.quota }; } catch { return null; } },
  agent: () => {
    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
    for (const m of agent?.state.messages ?? []) {
      if (m.role !== "assistant") continue;
      const u = (m as any).usage;
      if (!u) continue;
      usage.input += u.input ?? 0; usage.output += u.output ?? 0; usage.cacheRead += u.cacheRead ?? 0; usage.cacheWrite += u.cacheWrite ?? 0; usage.cost += u.cost?.total ?? 0;
    }
    return { model: `${config.provider}/${config.model}`, turn: currentTurnId || null, turns: turnIndex, toolCalls: toolCallCount, usage, free: config.provider === "free" ? free.status() : null };
  },
  processes: () => processLog,
  runtimeHeap: runtimeHeapBytes,
  sdkVersion: () => "@wasmer/sdk 0.19.1",
};

function makeToolsFor() {
  return makeTools({
    machine: (path) => readMachine(machineSources, path),
    machineAll: () => machineSnapshot(machineSources),
    dc,
    shell: currentShell,
    fetch: smartFetch,
    author,
    turnId,
    commit: (comb, kind, author) => commitComb(comb, kind, author, "commit by tool call"),
  });
}

function buildAgent(messages: AgentMessage[]) {
  const tools = makeToolsFor();
  agent = new Agent({
    initialState: { systemPrompt: systemPrompt(), model: currentModel(), tools, messages },
    streamFn: (model, context, options) =>
      models.streamSimple(model, context, { ...options, apiKey: config.apiKey || undefined, fetch: smartFetch }),
    getApiKey: () => config.apiKey || undefined,
    toolExecution: "sequential",
    sessionId,
  });
  agent.subscribe(onAgentEvent);
}

async function onAgentEvent(ev: AgentEvent) {
  if (ev.type === "tool_execution_start") toolCallCount++;
  if (ev.type === "turn_start") {
    turnIndex++;
    currentTurnId = `${sessionId}#${turnIndex}`;
  }
  // Keep traffic small: text deltas without the full partial message.
  if (ev.type === "message_update") {
    const e: any = ev.assistantMessageEvent;
    post({ type: "agent", event: { type: "message_update", inner: { type: e.type, contentIndex: e.contentIndex, delta: e.delta } } });
  } else {
    post({ type: "agent", event: ev });
  }
  if (ev.type === "turn_end" || ev.type === "agent_end") {
    await saveTranscript();
  }
}

async function saveTranscript() {
  if (!agent) return;
  dc.writeFile(SESSION_COMB, "transcript.json", JSON.stringify({ sessionId, turnIndex, messages: agent.state.messages }, null, 1));
  const id = await dc.commit(SESSION_COMB, { kind: "turn", turn_id: currentTurnId }, author());
  if (id) post({ type: "history", comb: SESSION_COMB, objectCount: dc.objectCount() });
}

async function prompt(text: string) {
  if (!agent) throw new Error("agent not ready");
  if (agent.state.isStreaming) throw new Error("the agent is busy");
  void agent.prompt(text).catch((e) => post({ type: "error", message: String(e?.message ?? e) }));
}

async function entryDetail(entryId: string): Promise<EntryDetail> {
  const entry = dc.entry(entryId);
  const files = dc.diffEntry(entryId);
  const diffs: Record<string, string> = {};
  for (const f of files) {
    const sample = f.new_hash ?? f.old_hash;
    if (!sample) continue;
    if (!looksText(dc.blob(sample))) continue;
    diffs[f.path] = dc.unifiedDiff(f.path, f.old_hash, f.new_hash);
  }
  let args: unknown = null;
  if (entry.args_hash) {
    try {
      args = JSON.parse(new TextDecoder().decode(dc.blob(entry.args_hash)));
    } catch {}
  }
  return { entry, files, diffs, args };
}

function looksText(b: Uint8Array) {
  const n = Math.min(b.length, 4096);
  for (let i = 0; i < n; i++) if (b[i] === 0) return false;
  return true;
}

async function rollback(comb: string, entryId: string) {
  if (agent?.state.isStreaming) throw new Error("wait for the agent to finish");
  let next: WasixShell | null = null;
  let manifest: SystemManifest | null = null;
  if (comb === NIX_COMB) {
    // Atomic like any other /nix change: the target system must boot before the rollback is recorded.
    try {
      manifest = parseManifest(new TextDecoder().decode(dc.readFileAt(entryId, "machine.json")));
      if (!runningSystem || JSON.stringify(runningSystem.manifest) !== JSON.stringify(manifest)) {
        next = new WasixShell(dc, { kind: "system", base: shellOrigin, manifest }, status);
        await next.warmup();
      }
    } catch (e: any) {
      await next?.close();
      throw new Error(`rollback refused: the system at /nix@${entryId.slice(0, 8)} does not start: ${e.message}`);
    }
  }
  const id = await dc.rollback(comb, entryId, { ...author(), harness: "timeline", model: "" });
  post({ type: "history", comb, objectCount: dc.objectCount() });
  if (manifest) await adoptSystem(next, manifest, id, "rollback");
  // Tell the model, as part of the transcript, so it survives a reload and shows in the console.
  if (agent) {
    agent.state.messages = [
      ...agent.state.messages,
      { role: "user", content: `[The user rolled ${comb} back to history entry ${entryId.slice(0, 12)}; its files are now as they were then. Re-read before editing.]`, timestamp: Date.now() },
    ];
    await saveTranscript();
  }
  return id;
}

async function handle(req: Request): Promise<unknown> {
  switch (req.method) {
    case "init":
      return init(req.shell);
    case "configure": {
      config = req.config;
      const m = currentModel();
      if (agent) agent.state.model = m;
      return { ok: true };
    }
    case "prompt":
      await prompt(req.text);
      return null;
    case "abort":
      agent?.abort();
      return null;
    case "log":
      return dc.log(req.comb);
    case "entry":
      return entryDetail(req.entryId);
    case "fileAt":
      return new TextDecoder().decode(dc.readFileAt(req.entryId, req.path));
    case "treeAt":
      return dc.listAllAt(req.entryId);
    case "tree":
      return dc.listAll(req.comb);
    case "file":
      return new TextDecoder().decode(dc.readFile(req.comb, req.path));
    case "args":
      return JSON.parse(new TextDecoder().decode(dc.blob(req.hash)));
    case "verify":
      return dc.verify(req.comb);
    case "rollback":
      return rollback(req.comb, req.entryId);
    case "transcript":
      return agent?.state.messages ?? [];
    case "shellWarmup":
      await (await currentShell()).warmup();
      return null;
    case "boot":
      void bootSystem();
      return null;
    case "shellRun": {
      // "!cmd" from the console: the user at the shell, outside any tool call. Changes land as an "external" entry.
      if (agent?.state.isStreaming) throw new Error("wait for the agent to finish");
      status(`$ ${req.command}`, true);
      let res;
      try {
        res = await (await currentShell()).run(req.command, { cwd: CWD, timeoutMs: req.timeoutMs, machine: await machineSnapshot(machineSources), by: "shell" });
      } finally {
        status("shell ready", false);
      }
      let refused = "";
      for (const comb of res.changed) {
        try {
          await commitComb(comb, { kind: "external" }, { session: sessionId, harness: "shell", model: "", principal: "user" }, "commit from the shell");
        } catch (e: any) {
          refused += `\n${e.message}`;
        }
      }
      return { output: res.output + refused, exitCode: refused ? 1 : res.exitCode };
    }
    case "wipe":
      await dc.wipe();
      return null;
    case "freeStatus":
      return free.status();
    case "saveFile": {
      // An edit made by you in the page's editor: outside any tool call, so an "external" entry.
      if (agent?.state.isStreaming) throw new Error("wait for the agent to finish");
      dc.writeFile(req.comb, req.path, req.content);
      return commitComb(req.comb, { kind: "external" }, { session: sessionId, harness: "editor", model: "", principal: "user" }, "commit from the editor");
    }
    case "debugTool": {
      const tool = agent?.state.tools.find((t) => t.name === req.name);
      if (!tool) throw new Error(`no tool ${req.name}`);
      const params = tool.prepareArguments ? tool.prepareArguments(req.params) : req.params;
      return tool.execute(`debug-${Date.now()}`, params);
    }
    case "debugFetch": {
      try {
        const r = await smartFetch(req.url);
        return { ok: true, status: r.status, text: (await r.text()).slice(0, 2000) };
      } catch (e: any) {
        return { ok: false, error: String(e?.message ?? e) };
      }
    }
    case "bridgeAvailable":
      setBridgeAvailable(req.available);
      status(`egress: ${egressMode()}`);
      return null;
  }
}

self.onmessage = async (e: MessageEvent<Request | BridgeInbound>) => {
  if ((e.data as BridgeInbound).bridge) {
    const b = e.data as BridgeInbound;
    onBridgeEvent(b.id, b.event);
    return;
  }
  const req = e.data as Request;
  let reply: Reply;
  try {
    reply = { id: req.id, ok: true, result: await handle(req) };
  } catch (err: any) {
    console.error(err);
    reply = { id: req.id, ok: false, error: String(err?.message ?? err) };
  }
  self.postMessage(reply);
};

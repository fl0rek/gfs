// PROTOTYPE. The agent worker: pi (pi-agent-core + pi-ai) on a gfs-backed world.
//
// Owns: the datacombs engine (wasm) and its OPFS persistence, the pi Agent and
// its four tools, the WASIX shell, and the session transcript comb. The page
// only ever talks to it through postMessage (see protocol.ts).

import { Agent, type AgentEvent, type AgentMessage } from "@earendil-works/pi-agent-core";
import { createModels, createProvider, type Model, type MutableModels } from "@earendil-works/pi-ai";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { opencodeProvider } from "@earendil-works/pi-ai/providers/opencode";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { Datacombs } from "./gfs";
import { makeTools } from "./tools";
import { WasixShell, UnavailableShell, type Shell } from "./shell";
import { createMockProvider, MOCK_MODEL_ID, MOCK_PROVIDER_ID } from "./mock-model";
import { CWD, WORKSPACE } from "./paths";
import type { Author, EntryDetail, InitInfo, ModelConfig, Notification, Reply, Request } from "./protocol";

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
const mock = createMockProvider();

const post = (n: Notification) => self.postMessage(n);
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

  // Shell: real WASIX bash from the registry; the page may override the source for tests.
  if (shellParam === "none") shell = new UnavailableShell("disabled with ?shell=none");
  else if (shellParam?.startsWith("module:")) {
    const [url, command] = shellParam.slice("module:".length).split(",");
    const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
    shell = new WasixShell(dc, { kind: "module", bytes, command: command || "sh" }, status);
  } else {
    shell = new WasixShell(dc, { kind: "registry", name: BASH_PACKAGE }, status);
  }

  buildAgent(restoreTranscript());
  return {
    node: NODE,
    sessionId,
    combs: dc.listCombs(),
    persistence: dc.persistence,
    objectCount: dc.objectCount(),
    config,
  };
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
    `Your working directory is ${CWD}. It is a comb: a versioned directory whose every tool call becomes one history entry. The past is readable at ${CWD}@<entry-id>/<path>. Nothing outside /datacombs exists. bash runs in a WASIX sandbox over the same directory; its network is disabled.`,
    "</environment>",
    "",
    `<cwd>${CWD}</cwd>`,
  ].join("\n");
}

function currentModel(): Model<any> {
  if (config.provider === "mock") return mock.getModel();
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

function buildAgent(messages: AgentMessage[]) {
  const tools = makeTools({
    dc,
    shell,
    author,
    turnId,
    onEntry: (comb) => post({ type: "history", comb, objectCount: dc.objectCount() }),
  });
  agent = new Agent({
    initialState: { systemPrompt: systemPrompt(), model: currentModel(), tools, messages },
    streamFn: (model, context, options) => models.streamSimple(model, context, { ...options, apiKey: config.apiKey || undefined }),
    getApiKey: () => config.apiKey || undefined,
    toolExecution: "sequential",
    sessionId,
  });
  agent.subscribe(onAgentEvent);
}

async function onAgentEvent(ev: AgentEvent) {
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
  const id = await dc.rollback(comb, entryId, { ...author(), harness: "timeline", model: "" });
  post({ type: "history", comb, objectCount: dc.objectCount() });
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
      await shell.warmup();
      return null;
    case "shellRun": {
      // Direct shell access from the page (debugging). Changes land as an "external" entry.
      const res = await shell.run(WORKSPACE, req.command, { cwd: CWD, timeoutMs: req.timeoutMs, onData: (c) => post({ type: "status", text: c.slice(0, 80) }) });
      const id = await dc.commit(WORKSPACE, { kind: "external" }, { ...author(), harness: "shell", model: "" });
      if (id) post({ type: "history", comb: WORKSPACE, objectCount: dc.objectCount() });
      return res;
    }
    case "wipe":
      await dc.wipe();
      return null;
  }
}

self.onmessage = async (e: MessageEvent<Request>) => {
  const req = e.data;
  let reply: Reply;
  try {
    reply = { id: req.id, ok: true, result: await handle(req) };
  } catch (err: any) {
    console.error(err);
    reply = { id: req.id, ok: false, error: String(err?.message ?? err) };
  }
  self.postMessage(reply);
};

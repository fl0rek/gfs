// PROTOTYPE. A real WASIX bash (Wasmer JS SDK) with gfs mounted into it.
//
// The sandbox is built through the SDK's core with host mounts (see hostfs.ts):
//   /datacombs   every comb's working tree, plus <comb>@<entry> read-only views
//   /nix         the nix comb (read-write; a change there is a switch)
//   /machine     the node describing itself (read-only, generated on read)
// Every filesystem call under those paths is answered from gfs in this worker,
// so there is no copy in or out: what a command writes is in the comb the
// moment it is written, and becomes one history entry like any other tool call.

import type { Wasmer, Sandbox } from "@wasmer/sdk/browser";
import { GfsHostFs, installHostFs, MOUNT_DATACOMBS, MOUNT_NIX, MOUNT_MACHINE } from "./hostfs";

/** Load the SDK unbundled (see vite.config.ts). */
async function loadSdk(): Promise<typeof import("@wasmer/sdk/browser")> {
  const url = import.meta.env.DEV
    ? "/node_modules/@wasmer/sdk/dist/index.js"
    : new URL(`${import.meta.env.BASE_URL}wasmer-sdk/dist/index.js`, self.location.href).href;
  return import(/* @vite-ignore */ url);
}
async function loadHostFsBridge(): Promise<{ respondToHostFileSystem: (req: any, res: any) => void; isHostFileSystemRequest: (m: unknown) => boolean }> {
  const url = import.meta.env.DEV
    ? "/node_modules/@wasmer/sdk/dist/host-filesystem.js"
    : new URL(`${import.meta.env.BASE_URL}wasmer-sdk/dist/host-filesystem.js`, self.location.href).href;
  return import(/* @vite-ignore */ url);
}
import type { Datacombs } from "./gfs";
import { DATACOMBS, NIX_COMB } from "./paths";

export interface RunOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  onData?: (chunk: string) => void;
  cwd: string;
  env?: Record<string, string>;
  /** Who runs this ("tool:<id>", "shell"), for the process log. */
  by?: string;
}

export interface RunResult {
  output: string;
  exitCode: number;
  /** Combs whose working tree the command changed. */
  changed: string[];
}

export interface Shell {
  /** Run a command over the whole gfs root; returns the combs it changed. */
  run(command: string, opts: RunOptions): Promise<RunResult>;
  warmup(): Promise<void>;
  close(): Promise<void>;
  /** Commands the shell's sandbox offers, once warmed up. */
  commands(): string[];
  /** Installed packages, with how many commands each provides. */
  packages(): { id: string; commands: number }[];
  bootedAt: number | null;
}

/** Commands spawned in any sandbox so far (a ring of the last 200). */
export const processLog: import("./machine").ProcessRecord[] = [];
let nextPid = 1;

let sdkStarted = false;

/** The runtime's own heap: the SDK's WebAssembly.Memory, via the cached glue module. Only once the SDK is up: init() on a cold module would instantiate a second runtime. */
export async function runtimeHeapBytes(): Promise<number | null> {
  if (!sdkStarted) return null;
  try {
    const url = import.meta.env.DEV
      ? "/node_modules/@wasmer/sdk/pkg/wasmer_sdk_js.js"
      : new URL(`${import.meta.env.BASE_URL}wasmer-sdk/pkg/wasmer_sdk_js.js`, self.location.href).href;
    const glue: any = await import(/* @vite-ignore */ url);
    const exports = await glue.default(); // already initialised by the SDK: returns the exports
    return exports?.memory?.buffer?.byteLength ?? null;
  } catch {
    return null;
  }
}

/**
 * Answer the Wasmer SDK's registry lookups from our own origin. The SDK resolves `use`
 * dependencies by package name against https://registry.wasmer.io/graphql (not configurable
 * in 0.19.1) and downloads from cdn.wasmer.io; with this shim installed, both come from
 * `${base}packages/` instead, so the shell works offline and never depends on their CDN.
 */
export function installRegistryShim(base: URL, index: { packages: Record<string, string>; registry: Record<string, any> }) {
  const realFetch = self.fetch.bind(self);
  const shas = new Set(Object.values(index.packages));
  const local = (sha: string) => new URL(`${sha}.webc`, base).href;
  self.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("https://registry.wasmer.io/graphql")) {
      const body = init?.body ?? (input instanceof Request ? await input.clone().text() : "");
      const text = typeof body === "string" ? body : "";
      const m = /getPackage\(name:\s*\\?"([^"\\]+)\\?"\)/.exec(text);
      const recorded = m && index.registry[m[1]];
      if (recorded) {
        // The registry's full answer as recorded at build time, with downloads pointed at our origin.
        const answer = JSON.parse(JSON.stringify(recorded));
        for (const v of answer.data.getPackage.versions) {
          for (const d of [v.v2, v.v3]) if (d?.piritaSha256Hash && shas.has(d.piritaSha256Hash)) d.piritaDownloadUrl = local(d.piritaSha256Hash);
        }
        return new Response(JSON.stringify(answer), { headers: { "content-type": "application/json" } });
      }
      console.warn("registry shim: no local answer for", text.slice(0, 120));
    }
    const cdn = /^https:\/\/cdn\.wasmer\.io\/webcimages\/([0-9a-f]{64})\.webc$/.exec(url);
    if (cdn && shas.has(cdn[1])) return realFetch(local(cdn[1]), init);
    return realFetch(input as any, init);
  }) as typeof fetch;
}

/**
 * The running system, as /nix/machine.json describes it. Every package is pinned by
 * sha256 and refused if the bytes differ. A `.webc` package brings its own commands;
 * a raw `.wasm` module is one command.
 */
export interface SystemManifest {
  /** Free-form label shown in the header. */
  name?: string;
  shell: string;
  packages: SystemPackage[];
}
export type SystemPackage =
  | { kind: "webc"; name: string; url: string; sha256: string }
  | { kind: "wasm"; name: string; url: string; sha256: string; commands: string[] };

export type ShellSource =
  | { kind: "registry"; name: string }
  | { kind: "system"; base: URL; manifest: SystemManifest }
  | { kind: "module"; bytes: Uint8Array; command: string };

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The default system: what the site deployed. */
export async function loadDeployedSystem(base: URL): Promise<{ manifest: SystemManifest; flake: string; registry: Record<string, any> }> {
  const index = await (await fetch(new URL("packages/index.json", base))).json();
  const manifest: SystemManifest = await (await fetch(new URL("system/machine.json", base))).json();
  const flakeRes = await fetch(new URL("system/flake.nix", base));
  const flake = flakeRes.ok ? await flakeRes.text() : "# no flake deployed with this build\n";
  return { manifest, flake, registry: index.registry ?? {} };
}

const dec = new TextDecoder();

export class WasixShell implements Shell {
  private wasmer: Wasmer | null = null;
  private sandbox: Sandbox | null = null;
  private commandName = "bash";
  private ready: Promise<void> | null = null;
  bootedAt: number | null = null;
  private pkgCores: any[] = [];

  constructor(
    private dc: Datacombs,
    private source: ShellSource,
    private status: (text: string, busy?: boolean) => void,
    private hostfs: GfsHostFs,
  ) {}

  warmup(): Promise<void> {
    if (!this.ready) this.ready = this.boot();
    return this.ready;
  }

  async close() {
    try {
      await this.sandbox?.close();
      await this.wasmer?.close();
    } catch {}
    this.sandbox = null;
    this.wasmer = null;
  }

  commands(): string[] {
    const all = new Set<string>();
    for (const p of this.pkgCores) for (const c of p.commands as string[]) all.add(c);
    return [...all].sort();
  }

  packages() {
    return this.pkgCores.map((p) => ({ id: p.id as string, commands: (p.commands as string[]).length }));
  }

  private async boot() {
    this.status("starting WASIX runtime…", true);
    const { Wasmer, Sandbox } = await loadSdk();
    const bridge = await loadHostFsBridge();
    installHostFs(this.hostfs, bridge.respondToHostFileSystem, bridge.isHostFileSystemRequest, (m) => console.log(m));
    this.wasmer = new Wasmer({ parallelism: 2 });
    await this.wasmer.ready();
    sdkStarted = true;
    const client: any = await (this.wasmer as any).getCore();
    if (this.source.kind === "registry") {
      this.status(`fetching ${this.source.name} from the Wasmer registry…`, true);
      const core = await client.loadPackage(this.source.name);
      this.pkgCores.push(core);
      this.commandName = core.entrypoint ?? "bash";
    } else if (this.source.kind === "system") {
      const { base, manifest } = this.source;
      const modules: Record<string, Uint8Array> = {};
      const commands: Record<string, { module: string }> = {};
      for (const p of manifest.packages) {
        this.status(`fetching ${p.name}…`, true);
        const res = await fetch(new URL(p.url, base));
        if (!res.ok) throw new Error(`${p.name}: ${p.url} → ${res.status}`);
        const bytes = new Uint8Array(await res.arrayBuffer());
        const got = await sha256Hex(bytes);
        if (got !== p.sha256) throw new Error(`${p.name}: sha256 mismatch (manifest ${p.sha256.slice(0, 12)}…, got ${got.slice(0, 12)}…); refusing to run it`);
        if (p.kind === "webc") {
          this.status(`loading ${p.name}…`, true);
          this.pkgCores.push(await client.loadPackageBytes(bytes));
        } else {
          const mod = p.url.split("/").pop()!.replace(/[^A-Za-z0-9._+-]/g, "_");
          modules[mod] = bytes;
          for (const c of p.commands) commands[c] = { module: mod };
        }
      }
      if (Object.keys(modules).length) this.pkgCores.push(await client.createPackage({ modules, commands }));
      if (!this.pkgCores.some((p) => p.hasCommand(manifest.shell))) throw new Error(`no package in the system provides the shell "${manifest.shell}"`);
      this.commandName = manifest.shell;
      console.log("system packages:", this.pkgCores.map((p) => `${p.id} [${p.commands.length} cmds]`).join(", "));
    } else {
      const def = { modules: { app: this.source.bytes }, commands: { [this.source.command]: { module: "app" } } };
      this.pkgCores.push(await client.createPackage(def));
      this.commandName = this.source.command;
    }
    this.status("mounting gfs into the sandbox…", true);
    // The public sandboxes.create() has no mount option; build through the core.
    const step = (m: string) => console.log(`shell boot: ${m}`);
    const builder = client.sandbox();
    step(`builder created; ${this.pkgCores.length} package(s)`);
    for (const core of this.pkgCores) builder.package(core);
    step("packages added");
    builder.mountHost(DATACOMBS, MOUNT_DATACOMBS, false);
    builder.mountHost("/nix", MOUNT_NIX, false);
    builder.mountHost("/machine", MOUNT_MACHINE, true);
    step("mounts added");
    builder.network("disabled");
    const sandboxCore = await builder.start();
    step("sandbox started");
    this.sandbox = new Sandbox(this.wasmer, sandboxCore);
    this.hostfs.refreshMachine();
    this.bootedAt = Date.now();
    this.status("shell ready", false);
  }

  async run(command: string, opts: RunOptions): Promise<RunResult> {
    await this.warmup();
    const sandbox = this.sandbox!;
    this.hostfs.takeTouched();
    const rec: import("./machine").ProcessRecord = { id: nextPid++, command, started: Date.now(), ms: null, exit: null, changed: [], by: opts.by ?? "shell" };
    processLog.push(rec);
    if (processLog.length > 200) processLog.shift();
    const env = { HOME: opts.cwd, TERM: "dumb", ...(opts.env ?? {}) };
    const cmd = sandbox.command(this.commandName, ["-c", command], { cwd: opts.cwd, env });
    const proc = await cmd.spawn({ stdin: "closed", stdout: "pipe", stderr: "pipe", timeoutMs: opts.timeoutMs });
    const chunks: string[] = [];
    const pump = async (stream: AsyncIterable<Uint8Array> | null) => {
      if (!stream) return;
      for await (const c of stream) {
        const s = dec.decode(c);
        chunks.push(s);
        opts.onData?.(s);
      }
    };
    const onAbort = () => void proc.kill();
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      await Promise.all([pump(proc.stdout), pump(proc.stderr)]);
      const out = await proc.wait({ check: false });
      if (opts.signal?.aborted) throw new Error("Command aborted");
      if (out.reason === "timeout") throw new Error(`Command timed out after ${(opts.timeoutMs ?? 0) / 1000} seconds`);
      const changed = this.hostfs.takeTouched();
      rec.ms = Date.now() - rec.started;
      rec.exit = out.exitCode;
      rec.changed = changed;
      return { output: chunks.join(""), exitCode: out.exitCode, changed };
    } catch (e) {
      rec.ms = Date.now() - rec.started;
      rec.exit = -1;
      throw e;
    } finally {
      opts.signal?.removeEventListener("abort", onAbort);
    }
  }
}

/** Used until the WASIX shell is wanted, or when it cannot start. */
export class UnavailableShell implements Shell {
  bootedAt = null;
  constructor(private reason: string) {}
  packages() {
    return [];
  }
  get unavailable() {
    return this.reason;
  }
  async warmup() {}
  async close() {}
  commands() {
    return [];
  }
  async run(): Promise<RunResult> {
    throw new Error(`bash is unavailable: ${this.reason}`);
  }
}

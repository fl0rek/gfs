// PROTOTYPE. A real WASIX bash (Wasmer JS SDK) whose /workspace is a comb.
//
// The SDK's sandbox has its own in-memory filesystem; we don't yet mount gfs
// into it directly (the SDK's host-filesystem bridge is experimental). Instead,
// around every command the comb's working tree is synced into /workspace and
// whatever the command changed is synced back, so the tool call's changes
// land in gfs and become one history entry like any other tool call.

import type { Wasmer, Sandbox, Package } from "@wasmer/sdk/browser";

/** Load the SDK unbundled (see vite.config.ts). */
async function loadSdk(): Promise<typeof import("@wasmer/sdk/browser")> {
  const url = import.meta.env.DEV
    ? "/node_modules/@wasmer/sdk/dist/index.js"
    : new URL(`${import.meta.env.BASE_URL}wasmer-sdk/dist/index.js`, self.location.href).href;
  return import(/* @vite-ignore */ url);
}
import type { Datacombs } from "./gfs";
import { DATACOMBS } from "./paths";

export interface RunOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  onData?: (chunk: string) => void;
  cwd: string;
  env?: Record<string, string>;
}

export interface RunResult {
  output: string;
  exitCode: number;
}

export interface Shell {
  run(comb: string, command: string, opts: RunOptions): Promise<RunResult>;
  warmup(): Promise<void>;
  close(): Promise<void>;
  /** Commands the shell's sandbox offers, once warmed up. */
  commands(): string[];
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
  /** Free-form label shown in /proc/system. */
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
  private pkg: Package | null = null;
  private extraPkgs: Package[] = [];
  private commandName = "bash";
  private ready: Promise<void> | null = null;
  /** What the sandbox's /workspace currently holds: path → blob hash. */
  private mirrored = new Map<string, string>();

  constructor(
    private dc: Datacombs,
    private source: ShellSource,
    private status: (text: string, busy?: boolean) => void,
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
    for (const p of [this.pkg, ...this.extraPkgs]) for (const c of p?.commands ?? []) all.add(c);
    return [...all].sort();
  }

  private async boot() {
    this.status("starting WASIX runtime…", true);
    const { Wasmer } = await loadSdk();
    this.wasmer = new Wasmer({ parallelism: 2 });
    await this.wasmer.ready();
    if (this.source.kind === "registry") {
      this.status(`fetching ${this.source.name} from the Wasmer registry…`, true);
      this.pkg = await this.wasmer.packages.load(this.source.name, {
        onProgress: (p) => {
          const pct = p.download.percent == null ? "" : ` ${Math.round(p.download.percent)}%`;
          this.status(`${p.phase} ${this.source.kind === "registry" ? this.source.name : ""}${pct}`, p.phase !== "ready");
        },
      });
      this.commandName = this.pkg.entrypoint ?? "bash";
    } else if (this.source.kind === "system") {
      const { base, manifest } = this.source;
      const pkgs: Package[] = [];
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
          pkgs.push(await this.wasmer.packages.load(bytes));
        } else {
          const mod = p.url.split("/").pop()!.replace(/[^A-Za-z0-9._+-]/g, "_");
          modules[mod] = bytes;
          for (const c of p.commands) commands[c] = { module: mod };
        }
      }
      if (Object.keys(modules).length) pkgs.push(await this.wasmer.packages.create({ modules, commands }));
      const shellPkg = pkgs.find((p) => p.commands.includes(manifest.shell));
      if (!shellPkg) throw new Error(`no package in the system provides the shell "${manifest.shell}"`);
      this.pkg = shellPkg;
      this.extraPkgs = pkgs.filter((p) => p !== shellPkg);
      this.commandName = manifest.shell;
      console.log("system packages:", pkgs.map((p) => `${p.id} [${p.commands.length} cmds]`).join(", "));
    } else {
      this.pkg = await this.wasmer.packages.create({
        modules: { app: this.source.bytes },
        commands: { [this.source.command]: { module: "app" } },
      });
      this.commandName = this.source.command;
    }
    this.status("creating sandbox…", true);
    // Dependencies first, so the shell's `use` edges resolve against what is already installed.
    this.sandbox = await this.wasmer.sandboxes.create({ packages: [...this.extraPkgs, this.pkg] });
    await this.sandbox.fs.mkdir("/workspace", { recursive: true }).catch(() => {});
    this.mirrored.clear();
    this.status("shell ready", false);
  }

  async run(comb: string, command: string, opts: RunOptions): Promise<RunResult> {
    await this.warmup();
    const sandbox = this.sandbox!;
    await this.syncIn(comb);
    const env = {
      HOME: "/workspace",
      PWD: `/workspace`,
      TERM: "dumb",
      PI_GFS_CWD: opts.cwd,
      PI_GFS_ROOT: DATACOMBS,
      ...(opts.env ?? {}),
    };
    const cmd = sandbox.command(this.pkg!.command(this.commandName), ["-c", command], { cwd: "/workspace", env });
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
      await this.syncOut(comb);
      return { output: chunks.join(""), exitCode: out.exitCode };
    } finally {
      opts.signal?.removeEventListener("abort", onAbort);
    }
  }

  /** Bring /workspace up to date with the comb's working tree. */
  private async syncIn(comb: string) {
    const fs = this.sandbox!.fs;
    const want = new Map<string, string>();
    for (const [path, hash] of this.dc.listAll(comb)) want.set(path, hash);
    for (const [path] of this.mirrored) {
      if (!want.has(path)) await fs.remove(`/workspace/${path}`).catch(() => {});
    }
    for (const [path, hash] of want) {
      if (this.mirrored.get(path) === hash) continue;
      const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
      if (dir) await fs.mkdir(`/workspace/${dir}`, { recursive: true }).catch(() => {});
      await fs.writeFile(`/workspace/${path}`, this.dc.readFile(comb, path));
    }
    this.mirrored = want;
  }

  /** Write back what the command changed under /workspace. */
  private async syncOut(comb: string) {
    const fs = this.sandbox!.fs;
    const seen = new Set<string>();
    const walk = async (dir: string) => {
      const entries = await fs.readDir(dir);
      for (const e of entries) {
        const full = dir === "/workspace" ? e.name : `${dir.slice("/workspace/".length)}/${e.name}`;
        if (e.kind === "directory") {
          await walk(`/workspace/${full}`);
          continue;
        }
        seen.add(full);
        const bytes = await fs.readFile(`/workspace/${full}`);
        let same = false;
        try {
          same = this.dc.exists(comb, full) && bytesEqual(this.dc.readFile(comb, full), bytes);
        } catch {}
        if (!same) this.dc.writeFile(comb, full, bytes);
      }
    };
    await walk("/workspace");
    for (const [path] of this.dc.listAll(comb)) {
      if (!seen.has(path)) this.dc.remove(comb, path);
    }
    // Refresh the mirror record from the comb (hashes come from gfs).
    this.mirrored = new Map(this.dc.listAll(comb).map(([p, h]) => [p, h]));
  }
}

function bytesEqual(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Used until the WASIX shell is wanted, or when it cannot start. */
export class UnavailableShell implements Shell {
  constructor(private reason: string) {}
  async warmup() {}
  async close() {}
  commands() {
    return [];
  }
  async run(): Promise<RunResult> {
    throw new Error(`bash is unavailable: ${this.reason}`);
  }
}

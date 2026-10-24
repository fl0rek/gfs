// PROTOTYPE. A real WASIX bash (Wasmer JS SDK) that sees the gfs root.
//
// The SDK's sandbox has its own in-memory filesystem; we don't yet mount gfs
// into it directly (the SDK's host-filesystem bridge is experimental). Instead,
// every command sees the root the harness sees:
//   /datacombs/<comb>   every comb's working tree (read-write)
//   /nix                the nix comb (read-write; a change there is a switch)
//   /proc               a snapshot of the session (writes are dropped)
// Two SDK facts shape how: the host may only touch `/workspace`, and changes
// to `/` do not survive from one guest process to the next. So the host keeps
// an incremental mirror under /workspace/.gfs, and each command runs inside a
// wrapper bash that copies it to /, runs the command in a child bash at
// /datacombs/workspace, and copies the combs back to /workspace/.gfs/out,
// which the host diffs against gfs. Whatever changed lands in gfs and becomes
// one history entry like any other tool call.

import type { Wasmer, Sandbox, Package } from "@wasmer/sdk/browser";

/** Load the SDK unbundled (see vite.config.ts). */
async function loadSdk(): Promise<typeof import("@wasmer/sdk/browser")> {
  const url = import.meta.env.DEV
    ? "/node_modules/@wasmer/sdk/dist/index.js"
    : new URL(`${import.meta.env.BASE_URL}wasmer-sdk/dist/index.js`, self.location.href).href;
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
  /** /proc contents to expose, path → text. */
  proc?: Record<string, string>;
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
  /** What the sandbox currently holds per comb: path → blob hash. */
  private mirrored = new Map<string, Map<string, string>>();
  private procFiles = new Set<string>();

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
    for (const d of [`${STAGE}/datacombs`, `${STAGE}/nix`, `${STAGE}/proc`]) await this.sandbox.fs.mkdir(d, { recursive: true }).catch(() => {});
    this.mirrored.clear();
    this.status("shell ready", false);
  }

  async run(command: string, opts: RunOptions): Promise<RunResult> {
    await this.warmup();
    const sandbox = this.sandbox!;
    await this.syncIn(opts.proc ?? {});
    const env = {
      HOME: opts.cwd,
      PWD: opts.cwd,
      TERM: "dumb",
      GFS_CMD: command,
      GFS_CWD: opts.cwd,
      ...(opts.env ?? {}),
    };
    const cmd = sandbox.command(this.pkg!.command(this.commandName), ["-c", WRAPPER], { cwd: "/", env });
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
      const changed = await this.syncOut();
      return { output: chunks.join(""), exitCode: out.exitCode, changed };
    } finally {
      opts.signal?.removeEventListener("abort", onAbort);
    }
  }

  /** Bring every comb and /proc up to date in the sandbox. */
  private async syncIn(proc: Record<string, string>) {
    const fs = this.sandbox!.fs;
    const combs = this.dc.listCombs();
    // combs that vanished (not expected, but keep the mirror honest)
    for (const comb of [...this.mirrored.keys()]) {
      if (!combs.includes(comb)) {
        await fs.remove(stageDir(comb), { recursive: true }).catch(() => {});
        this.mirrored.delete(comb);
      }
    }
    for (const comb of combs) {
      const root = stageDir(comb);
      const have = this.mirrored.get(comb) ?? new Map<string, string>();
      if (!this.mirrored.has(comb)) await fs.mkdir(root, { recursive: true }).catch(() => {});
      const want = new Map<string, string>();
      for (const [path, hash] of this.dc.listAll(comb)) want.set(path, hash);
      for (const [path] of have) if (!want.has(path)) await fs.remove(`${root}/${path}`).catch(() => {});
      for (const [path, hash] of want) {
        if (have.get(path) === hash) continue;
        const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
        if (dir) await fs.mkdir(`${root}/${dir}`, { recursive: true }).catch(() => {});
        await fs.writeFile(`${root}/${path}`, this.dc.readFile(comb, path));
      }
      this.mirrored.set(comb, want);
    }
    // /proc: rewritten every time; small
    for (const name of this.procFiles) if (!(name in proc)) await fs.remove(`${STAGE}/proc/${name}`).catch(() => {});
    for (const [name, text] of Object.entries(proc)) await fs.writeText(`${STAGE}/proc/${name}`, text);
    this.procFiles = new Set(Object.keys(proc));
  }

  /** Write back what the command changed under any comb. Returns the combs that changed. */
  private async syncOut(): Promise<string[]> {
    const fs = this.sandbox!.fs;
    const changed: string[] = [];
    for (const comb of this.dc.listCombs()) {
      const root = outDir(comb);
      const seen = new Set<string>();
      let dirty = false;
      const walk = async (dir: string) => {
        let entries: readonly { name: string; kind: string }[] = [];
        try {
          entries = await fs.readDir(dir);
        } catch {
          return;
        }
        for (const e of entries) {
          const full = dir === root ? e.name : `${dir.slice(root.length + 1)}/${e.name}`;
          if (e.kind === "directory") {
            await walk(`${root}/${full}`);
            continue;
          }
          seen.add(full);
          const bytes = await fs.readFile(`${root}/${full}`);
          let same = false;
          try {
            same = this.dc.exists(comb, full) && bytesEqual(this.dc.readFile(comb, full), bytes);
          } catch {}
          if (!same) {
            this.dc.writeFile(comb, full, bytes);
            dirty = true;
          }
        }
      };
      await walk(root);
      for (const [path] of this.dc.listAll(comb)) {
        if (!seen.has(path)) {
          this.dc.remove(comb, path);
          dirty = true;
        }
      }
      if (dirty) changed.push(comb);
      // The staging copy is now stale for whatever changed; the next syncIn rewrites those files.
    }
    return changed;
  }
}

/** Where a comb appears in the shell's root. */
export function combDir(comb: string): string {
  return comb === NIX_COMB ? "/nix" : `${DATACOMBS}/${comb}`;
}

/** The host's side of the mirror (the only place it may write). */
const STAGE = "/workspace/.gfs";
const stageDir = (comb: string) => `${STAGE}${combDir(comb)}`;
const outDir = (comb: string) => `${STAGE}/out${combDir(comb)}`;

/** Runs as the sandbox's bash: materialise the root, run the user's command, hand the combs back. */
// (`cp -a src/. dst/` breaks on empty directories under WASIX; the plain form works.)
const WRAPPER = [
  `cp -a ${STAGE}/datacombs /datacombs || echo "gfs: could not materialise /datacombs" >&2`,
  `cp -a ${STAGE}/nix /nix || echo "gfs: could not materialise /nix" >&2`,
  `cp -a ${STAGE}/proc /proc || echo "gfs: could not materialise /proc" >&2`,
  'cd "$GFS_CWD" 2>/dev/null || cd /datacombs/workspace',
  'bash -c "$GFS_CMD"',
  "rc=$?",
  `rm -rf ${STAGE}/out; mkdir -p ${STAGE}/out`,
  `cp -a /datacombs ${STAGE}/out/datacombs || echo "gfs: could not read back /datacombs" >&2`,
  `cp -a /nix ${STAGE}/out/nix || echo "gfs: could not read back /nix" >&2`,
  "exit $rc",
].join("\n");

function bytesEqual(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Used until the WASIX shell is wanted, or when it cannot start. */
export class UnavailableShell implements Shell {
  constructor(private reason: string) {}
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

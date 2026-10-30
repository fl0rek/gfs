// PROTOTYPE. /machine: what the node can say about itself, generated on read.
//
// Everything here is observable from the worker without patching the runtime.
// The Wasmer SDK's public surface has no telemetry, so the runtime section is
// its own heap (the SDK's WebAssembly.Memory, reachable because the glue module
// is cached and init() hands the exports back), the package inventory, and our
// own log of the processes we spawned. Guest memory, CPU time, the guest's
// process table and syscall counts live inside the runtime and would need it
// patched to come out.

export interface ProcessRecord {
  id: number;
  command: string;
  started: number;
  ms: number | null;
  exit: number | null;
  changed: string[];
  by: string; // "tool:<id>" | "shell" | "boot"
}

export interface MachineSources {
  session: () => Record<string, unknown>;
  system: () => Record<string, unknown>;
  shell: () => { ready: boolean; booting: boolean; commands: string[]; packages: { id: string; commands: number }[]; bootedAt: number | null; switches: number };
  egress: () => string;
  combs: () => { name: string; head: string; files: number; bytes: number }[];
  objectCount: () => number;
  storageEstimate: () => Promise<{ usage?: number; quota?: number } | null>;
  agent: () => { model: string; turn: string | null; turns: number; toolCalls: number; usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number }; free: unknown };
  processes: () => ProcessRecord[];
  runtimeHeap: () => Promise<number | null>;
  sdkVersion: () => string;
  git: () => unknown;
  startedAt: number;
}

const j = (v: unknown) => JSON.stringify(v, null, 2) + "\n";

export function machineEntries(src: MachineSources): Record<string, () => Promise<string> | string> {
  return {
    README: () =>
      [
        "/machine — the node, as it can describe itself. Read-only; generated on read.",
        "",
        "  session     who is running: session id, harness, model, turn",
        "  system      the running system: /nix entry, name, packages",
        "  shell       the WASIX sandbox: packages, commands, age, switches",
        "  processes   commands run in the sandbox (id, who, wall time, exit, combs changed)",
        "  runtime     the Wasmer runtime: SDK version, heap, parallelism, isolation, host hints",
        "  agent       pi: model, turns, tool calls, token usage and cost; the free-tier router",
        "  storage     combs (head, files, bytes), object count, OPFS usage/quota",
        "  egress      how HTTP leaves the page",
        "  git         combs backed by git remotes: url, branch, sync state, last events",
        "  mounts      the root the harness sees",
        "  uptime      seconds since the worker started",
        "",
        "Not here (inside the runtime, needs it patched): guest memory, CPU, the guest process table, syscall counts.",
        "",
      ].join("\n"),
    session: () => j(src.session()),
    system: () => j(src.system()),
    shell: () => j(src.shell()),
    processes: () => {
      const rows = src.processes();
      const head = "id\tby\tstarted\tms\texit\tchanged\tcommand\n";
      return head + rows.map((p) => `${p.id}\t${p.by}\t${new Date(p.started).toISOString()}\t${p.ms ?? "…"}\t${p.exit ?? "…"}\t${p.changed.join(",") || "-"}\t${p.command.replace(/\s+/g, " ").slice(0, 80)}`).join("\n") + "\n";
    },
    runtime: async () => {
      const nav: any = typeof navigator !== "undefined" ? navigator : {};
      const mem: any = (performance as any).memory;
      return j({
        sdk: src.sdkVersion(),
        heapBytes: await src.runtimeHeap(),
        parallelism: 2,
        crossOriginIsolated: (self as any).crossOriginIsolated ?? false,
        sharedArrayBuffer: typeof SharedArrayBuffer !== "undefined",
        host: {
          userAgent: nav.userAgent ?? null,
          hardwareConcurrency: nav.hardwareConcurrency ?? null,
          deviceMemoryGiB: nav.deviceMemory ?? null,
          jsHeapBytes: mem ? { used: mem.usedJSHeapSize, total: mem.totalJSHeapSize, limit: mem.jsHeapSizeLimit } : null,
        },
      });
    },
    agent: () => j(src.agent()),
    storage: async () => j({ combs: src.combs(), objects: src.objectCount(), opfs: await src.storageEstimate() }),
    egress: () => src.egress() + "\n",
    git: () => j(src.git()),
    mounts: () => ["/datacombs\tdatacombs\trw", "/nix\tcomb nix\trw (commit = switch, atomic)", "/machine\tmachine\tro (generated)"].join("\n") + "\n",
    uptime: () => `${Math.round((Date.now() - src.startedAt) / 1000)}\n`,
  };
}

export async function readMachine(src: MachineSources, path: string): Promise<string> {
  const entries = machineEntries(src);
  if (path === "") return Object.keys(entries).join("\n") + "\n";
  const f = entries[path];
  if (!f) throw new Error(`/machine/${path}: not found`);
  return await f();
}

export async function machineSnapshot(src: MachineSources): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [k, f] of Object.entries(machineEntries(src))) {
    try {
      out[k] = await f();
    } catch (e: any) {
      out[k] = `error: ${e.message}\n`;
    }
  }
  return out;
}

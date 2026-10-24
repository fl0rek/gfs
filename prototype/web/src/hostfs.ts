// PROTOTYPE. gfs as a filesystem mounted into the WASIX sandbox.
//
// The Wasmer SDK (0.19.1) has an experimental host-filesystem hook: a sandbox
// built with `mountHost(path, mountId, readOnly)` routes every filesystem call
// under `path` to `globalThis.__wasmerHostFileSystem(mountId, method, args)` in
// the pool worker, which posts it to its parent and blocks on a SharedArrayBuffer;
// the parent (this worker) answers with `respondToHostFileSystem`. The parent
// side must define `__wasmerHandleFileSystemRpc`, which the runtime calls for
// every message a pool worker sends. Protocol from js/bindgen/src/host_filesystem.rs:
//   stat(path) / fileStat(id) → { kind: "file"|"directory", size, accessed?, modified?, created? }  (times: decimal ns strings)
//   readDir(path) → [{ name, ...metadata }]
//   open(path, read, write, create, createNew, truncate, append) → id
//   read(id, offset, len) → bytes      write(id, offset, bytes) → n
//   setLen(id, len)  flush(id)  close(id)  mkdir(path)  remove(path)  rename(from, to)  sync()  setTimes(path, atime?, mtime?)
// Errors: { error: { code: "ENOENT" | "EEXIST" | "EACCES" | "ENOTDIR" | "EISDIR" | "ENOTEMPTY" | "ENOTSUP", message } }.
//
// Mounts: 1 = /datacombs (every comb, plus <comb>@<entry> read-only views),
//         2 = /nix (the nix comb), 3 = /machine (generated, read-only).

import type { Datacombs } from "./gfs";
import { NIX_COMB } from "./paths";

export const MOUNT_DATACOMBS = 1;
export const MOUNT_NIX = 2;
export const MOUNT_MACHINE = 3;

type Reply = { value: unknown } | { error: { code: string; message: string } };
const err = (code: string, message = code): Reply => ({ error: { code, message } });
const ok = (value: unknown): Reply => ({ value });

interface Handle {
  comb: string;
  path: string;
  at?: string; // read-only view
  machine?: string; // /machine file
  write: boolean;
  buf: Uint8Array; // current contents (writes land here, then in gfs on flush/close)
  dirty: boolean;
}

interface Target {
  comb: string;
  path: string;
  at?: string;
}

export class GfsHostFs {
  private handles = new Map<number, Handle>();
  private nextId = 1;
  /** Directories created with mkdir that hold nothing yet (gfs trees have no empty dirs). */
  private emptyDirs = new Set<string>(); // "comb/path"
  /** Combs touched by writes since the last take(). */
  private touched = new Set<string>();
  private machineCache: Record<string, string> | null = null;

  constructor(
    private dc: Datacombs,
    private machine: () => Promise<Record<string, string>>,
    private now = () => Date.now(),
  ) {}

  /** Combs written through the mount since the last call. */
  takeTouched(): string[] {
    const t = [...this.touched];
    this.touched.clear();
    return t;
  }

  private ns() {
    return String(this.now()) + "000000";
  }
  private meta(kind: "file" | "directory", size: number) {
    const t = this.ns();
    return { kind, size, accessed: t, modified: t, created: t };
  }

  // ----- path resolution -----

  private resolve(mount: number, p: string): Target | { root: true } | { nocomb: string } | null {
    const path = p.replace(/^\/+/, "").replace(/\/+$/, "");
    if (mount === MOUNT_NIX) return { comb: NIX_COMB, path };
    if (mount === MOUNT_DATACOMBS) {
      if (path === "") return { root: true };
      const [spec, ...rest] = path.split("/");
      const at = spec.indexOf("@");
      const comb = at >= 0 ? spec.slice(0, at) : spec;
      if (!this.dc.hasComb(comb)) return { nocomb: spec };
      return { comb, path: rest.join("/"), at: at >= 0 ? spec.slice(at + 1) : undefined };
    }
    return null;
  }

  private isDir(t: Target): boolean {
    if (t.path === "") return true;
    if (this.emptyDirs.has(`${t.comb}/${t.path}`)) return true;
    const files = t.at ? this.dc.listAllAt(t.at) : this.dc.listAll(t.comb);
    const prefix = t.path + "/";
    return files.some(([p]) => p.startsWith(prefix));
  }
  private fileSize(t: Target): number | null {
    try {
      if (t.at) return this.dc.readFileAt(t.at, t.path).length;
      return this.dc.stat(t.comb, t.path).kind === "file" ? this.dc.stat(t.comb, t.path).size : null;
    } catch {
      return null;
    }
  }

  // ----- the RPC -----

  handle(mount: number, method: string, args: unknown): Reply {
    const a = (Array.isArray(args) ? args : [args]) as any[];
    try {
      if (mount === MOUNT_MACHINE) return this.handleMachine(method, a);
      switch (method) {
        case "stat": {
          const t = this.resolve(mount, a[0]);
          if (!t || "nocomb" in t) return err("ENOENT");
          if ("root" in t) return ok(this.meta("directory", 0));
          const size = this.fileSize(t);
          if (size != null) return ok(this.meta("file", size));
          if (this.isDir(t)) return ok(this.meta("directory", 0));
          return err("ENOENT", `${a[0]}: not found`);
        }
        case "readDir": {
          const t = this.resolve(mount, a[0]);
          if (!t || "nocomb" in t) return err("ENOENT");
          if ("root" in t) return ok(this.dc.listCombs().map((c) => ({ name: c, ...this.meta("directory", 0) })));
          if (this.fileSize(t) != null) return err("ENOTDIR");
          if (!this.isDir(t)) return err("ENOENT");
          let entries: { name: string; kind: "file" | "dir"; size: number }[] = [];
          try {
            entries = t.at ? this.listDirAt(t) : this.dc.listDir(t.comb, t.path);
          } catch {
            // a directory gfs doesn't have yet (only in emptyDirs): listed below
          }
          const names = new Set(entries.map((e) => e.name));
          const out = entries.map((e) => ({ name: e.name, ...this.meta(e.kind === "dir" ? "directory" : "file", e.kind === "dir" ? 0 : e.size) }));
          // empty directories known only to us
          const prefix = t.path ? `${t.comb}/${t.path}/` : `${t.comb}/`;
          for (const d of this.emptyDirs) {
            if (!d.startsWith(prefix)) continue;
            const rest = d.slice(prefix.length);
            const first = rest.split("/")[0];
            if (first && !names.has(first)) {
              names.add(first);
              out.push({ name: first, ...this.meta("directory", 0) });
            }
          }
          return ok(out);
        }
        case "open": {
          const [p, read, write, create, createNew, truncate, append] = a as [string, boolean, boolean, boolean, boolean, boolean, boolean];
          const t = this.resolve(mount, p);
          if (!t) return err("ENOENT");
          if ("nocomb" in t) return create ? err("EACCES", `/datacombs holds combs; there is no comb "${t.nocomb}". Write inside one, e.g. workspace/${t.nocomb}`) : err("ENOENT");
          if ("root" in t) return err("EISDIR");
          if (t.path === "") return err("EISDIR");
          const exists = this.fileSize(t) != null;
          if (!exists && this.isDir(t)) return err("EISDIR");
          if (t.at && (write || create)) return err("EACCES", `${p} is a read-only view of the past`);
          if (!exists && !create) return err("ENOENT", `${p}: not found`);
          if (exists && createNew) return err("EEXIST");
          let buf = exists ? (t.at ? this.dc.readFileAt(t.at, t.path) : this.dc.readFile(t.comb, t.path)) : new Uint8Array();
          if (truncate) buf = new Uint8Array();
          const id = this.nextId++;
          const h: Handle = { comb: t.comb, path: t.path, at: t.at, write: !!(write || append), buf, dirty: !exists || truncate };
          this.handles.set(id, h);
          if (h.dirty && h.write) this.store(h); // creation is visible immediately
          void read;
          return ok(id);
        }
        case "fileStat": {
          const h = this.handles.get(a[0]);
          if (!h) return err("EBADF");
          return ok(this.meta("file", h.buf.length));
        }
        case "read": {
          const h = this.handles.get(a[0]);
          if (!h) return err("EBADF");
          const off = Number(a[1]);
          const len = Number(a[2]);
          if (off >= h.buf.length) return ok(new Uint8Array());
          return ok(h.buf.slice(off, off + len));
        }
        case "write": {
          const h = this.handles.get(a[0]);
          if (!h) return err("EBADF");
          if (!h.write) return err("EACCES");
          const off = Number(a[1]);
          const bytes = a[2] instanceof Uint8Array ? a[2] : new Uint8Array(a[2]);
          if (off + bytes.length > h.buf.length) {
            const n = new Uint8Array(off + bytes.length);
            n.set(h.buf);
            h.buf = n;
          }
          h.buf.set(bytes, off);
          h.dirty = true;
          return ok(bytes.length);
        }
        case "setLen": {
          const h = this.handles.get(a[0]);
          if (!h) return err("EBADF");
          const len = Number(a[1]);
          if (len < h.buf.length) h.buf = h.buf.slice(0, len);
          else if (len > h.buf.length) {
            const n = new Uint8Array(len);
            n.set(h.buf);
            h.buf = n;
          }
          h.dirty = true;
          this.store(h);
          return ok(null);
        }
        case "flush": {
          const h = this.handles.get(a[0]);
          if (!h) return err("EBADF");
          this.store(h);
          return ok(null);
        }
        case "close": {
          const h = this.handles.get(a[0]);
          if (h) {
            this.store(h);
            this.handles.delete(a[0]);
          }
          return ok(null);
        }
        case "mkdir": {
          const t = this.resolve(mount, a[0]);
          if (!t) return err("ENOENT");
          if ("nocomb" in t) return err("EACCES", `/datacombs holds combs; mkdir inside one, e.g. workspace/${t.nocomb}`);
          if ("root" in t) return err("EEXIST");
          if (t.at) return err("EACCES");
          if (this.fileSize(t) != null) return err("EEXIST");
          if (this.isDir(t)) return err("EEXIST");
          this.emptyDirs.add(`${t.comb}/${t.path}`);
          return ok(null);
        }
        case "remove": {
          const t = this.resolve(mount, a[0]);
          if (!t || "nocomb" in t) return err("ENOENT");
          if ("root" in t) return err("EACCES");
          if (t.at) return err("EACCES");
          if (t.path === "") return err("EACCES", "a comb cannot be removed from inside the sandbox");
          const key = `${t.comb}/${t.path}`;
          if (this.emptyDirs.has(key)) {
            this.emptyDirs.delete(key);
            this.keepParent(t.comb, t.path);
            return ok(null);
          }
          if (this.fileSize(t) != null) {
            this.dc.remove(t.comb, t.path);
            this.touched.add(t.comb);
            this.keepParent(t.comb, t.path);
            return ok(null);
          }
          if (this.isDir(t)) return err("ENOTEMPTY");
          return err("ENOENT");
        }
        case "rename": {
          const f = this.resolve(mount, a[0]);
          const to = this.resolve(mount, a[1]);
          if (!f || !to || "nocomb" in f || "root" in f) return err("ENOENT");
          if ("nocomb" in to) return err("EACCES", `/datacombs holds combs; move inside one`);
          if ("root" in to) return err("EACCES");
          if (f.at || to.at) return err("EACCES");
          if (f.comb !== to.comb) return err("ENOTSUP", "rename across combs is not supported; copy instead");
          const fkey = `${f.comb}/${f.path}`;
          if (this.emptyDirs.has(fkey)) {
            this.emptyDirs.delete(fkey);
            this.emptyDirs.add(`${to.comb}/${to.path}`);
            return ok(null);
          }
          this.dc.rename(f.comb, f.path, to.path);
          this.touched.add(f.comb);
          return ok(null);
        }
        case "sync":
        case "setTimes":
        case "setFileTimes":
          return ok(null);
        default:
          return err("ENOTSUP", `host fs: ${method}`);
      }
    } catch (e: any) {
      const m = String(e?.message ?? e);
      if (/not found/i.test(m)) return err("ENOENT", m);
      if (/is a directory/i.test(m)) return err("EISDIR", m);
      if (/not a directory/i.test(m)) return err("ENOTDIR", m);
      return err("EIO", m);
    }
  }

  private listDirAt(t: Target) {
    return this.dc.listDirAt(t.at!, t.path);
  }

  /** gfs has no empty directories; after removing a directory's last entry, keep its parent until it is removed too (so `rm -r` works). */
  private keepParent(comb: string, path: string) {
    const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    if (!parent) return;
    const t = { comb, path: parent };
    if (!this.isDir(t)) this.emptyDirs.add(`${comb}/${parent}`);
  }

  private store(h: Handle) {
    if (!h.dirty || !h.write || h.at) return;
    this.dc.writeFile(h.comb, h.path, h.buf);
    this.touched.add(h.comb);
    h.dirty = false;
    // a file inside a formerly-empty dir makes the dir real
    const dir = h.path.includes("/") ? h.path.slice(0, h.path.lastIndexOf("/")) : "";
    if (dir) this.emptyDirs.delete(`${h.comb}/${dir}`);
  }

  // ----- /machine: generated, read-only -----
  // The bridge is synchronous, so /machine is served from a snapshot that is
  // refreshed in the background on every access (at most one access stale).

  private refreshing = false;
  refreshMachine() {
    if (this.refreshing) return;
    this.refreshing = true;
    void this.machine()
      .then((c) => (this.machineCache = c))
      .catch(() => {})
      .finally(() => (this.refreshing = false));
  }

  private handleMachine(method: string, a: any[]): Reply {
    const name = (p: string) => p.replace(/^\/+/, "").replace(/\/+$/, "");
    const snapshot = () => {
      this.refreshMachine();
      return this.machineCache ?? { README: "/machine is still being generated; read again.\n" };
    };
    switch (method) {
      case "stat": {
        const n = name(a[0]);
        if (n === "") return ok(this.meta("directory", 0));
        const s = snapshot();
        if (!(n in s)) return err("ENOENT");
        return ok(this.meta("file", new TextEncoder().encode(s[n]).length));
      }
      case "readDir": {
        if (name(a[0]) !== "") return err("ENOTDIR");
        const s = snapshot();
        return ok(Object.entries(s).map(([k, v]) => ({ name: k, ...this.meta("file", new TextEncoder().encode(v).length) })));
      }
      case "open": {
        const n = name(a[0]);
        const [, , write, create] = a;
        if (write || create) return err("EACCES", "/machine is read-only");
        const s = snapshot();
        if (!(n in s)) return err("ENOENT");
        const id = this.nextId++;
        this.handles.set(id, { comb: "", path: n, machine: n, write: false, buf: new TextEncoder().encode(s[n]), dirty: false });
        return ok(id);
      }
      case "fileStat":
      case "read":
      case "close":
      case "flush":
        return this.handle(MOUNT_DATACOMBS, method, a); // handle-based ops are mount-agnostic
      case "sync":
      case "setTimes":
        return ok(null);
      default:
        return err("EACCES", "/machine is read-only");
    }
  }
}

/** Install the parent-side bridge: the runtime calls this for every message a pool worker posts. */
export function installHostFs(fs: GfsHostFs, respond: (request: any, result: Reply) => void, isRequest: (m: unknown) => boolean, log?: (s: string) => void) {
  const trace = (mount: number, method: string, args: unknown, result: Reply) => {
    if ((globalThis as any).__hostfsTrace || (log && "error" in result))
      (log ?? console.log)(`hostfs ${mount}:${method}(${JSON.stringify(args, (k, v) => (v instanceof Uint8Array ? `<${v.length}b>` : v)).slice(0, 100)}) → ${"error" in result ? result.error.code : "ok"}`);
  };
  // Calls from pool workers arrive as messages; the runtime hands them to this hook.
  (globalThis as any).__wasmerHandleFileSystemRpc = (message: any) => {
    if (!isRequest(message)) return false;
    const result = fs.handle(message.mount, message.method, message.args);
    trace(message.mount, message.method, message.args, result);
    respond(message, result);
    return true;
  };
  // Calls from the runtime's own context (WASI setup checks the cwd here) are direct and synchronous.
  (globalThis as any).__wasmerHostFileSystem = (mount: number, method: string, args: unknown) => {
    const result = fs.handle(mount, method, args);
    trace(mount, method, args, result);
    if ("error" in result) throw Object.assign(new Error(result.error.message), { code: result.error.code });
    return result.value;
  };
}

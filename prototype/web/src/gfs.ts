// PROTOTYPE. The datacombs engine (Rust → wasm) plus persistence in OPFS.
//
// The wasm module keeps objects in memory and logs what it wrote; after every
// mutation we drain that log into OPFS (one file per object, one per ref), and
// on startup we feed every stored object back in. Objects are immutable and
// content-addressed, so this is safe to do naively.

import init, { Gfs } from "./gfs-wasm/gfs_core.js";
import wasmUrl from "./gfs-wasm/gfs_core_bg.wasm?url";
import type { Author, FileDiff, HistoryEntry, VerifyReport } from "./protocol";

const ROOT_DIR = "pi-on-gfs";
const enc = new TextEncoder();
const dec = new TextDecoder();

export type EntryKind =
  | { kind: "tool_call"; tool_call_id: string; turn_id: string; tool_name: string; args_hash: string | null }
  | { kind: "turn"; turn_id: string }
  | { kind: "external" }
  | { kind: "switch"; at_entry: string; previous: string | null; system: string };

export class Datacombs {
  private gfs!: Gfs;
  private objectsDir: FileSystemDirectoryHandle | null = null;
  private refsDir: FileSystemDirectoryHandle | null = null;
  persistence: "opfs" | "memory" = "memory";
  private flushing: Promise<void> = Promise.resolve();

  async open(node: string): Promise<void> {
    await init({ module_or_path: wasmUrl });
    this.gfs = new Gfs(node);
    await this.openStorage();
    await this.loadAll();
  }

  private async openStorage() {
    try {
      if (!("storage" in navigator) || !navigator.storage.getDirectory) return;
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle(ROOT_DIR, { create: true });
      this.objectsDir = await dir.getDirectoryHandle("objects", { create: true });
      this.refsDir = await dir.getDirectoryHandle("refs", { create: true });
      this.persistence = "opfs";
    } catch (e) {
      console.warn("OPFS unavailable, staying in memory:", e);
    }
  }

  private async loadAll() {
    if (!this.objectsDir || !this.refsDir) return;
    const t0 = performance.now();
    let n = 0;
    for await (const [name, handle] of (this.objectsDir as any).entries() as AsyncIterable<[string, FileSystemHandle]>) {
      if (handle.kind !== "file") continue;
      const file = await (handle as FileSystemFileHandle).getFile();
      const bytes = new Uint8Array(await file.arrayBuffer());
      this.gfs.importObject(name, bytes);
      n++;
    }
    for await (const [name, handle] of (this.refsDir as any).entries() as AsyncIterable<[string, FileSystemHandle]>) {
      if (handle.kind !== "file") continue;
      const file = await (handle as FileSystemFileHandle).getFile();
      this.gfs.importRef(decodeURIComponent(name), (await file.text()).trim());
    }
    this.gfs.checkoutAll();
    console.log(`gfs: loaded ${n} objects from OPFS in ${Math.round(performance.now() - t0)}ms`);
  }

  /** Persist whatever the engine wrote since the last flush. Serialized. */
  flush(): Promise<void> {
    const objects = this.gfs.drainNewObjects() as { hash: string; bytes: Uint8Array }[];
    const refs = this.gfs.drainNewRefs() as { name: string; hash: string }[];
    if (!this.objectsDir || !this.refsDir || (objects.length === 0 && refs.length === 0)) return this.flushing;
    const objectsDir = this.objectsDir;
    const refsDir = this.refsDir;
    this.flushing = this.flushing.then(async () => {
      for (const o of objects) await writeFile(objectsDir, o.hash, o.bytes);
      for (const r of refs) await writeFile(refsDir, encodeURIComponent(r.name), enc.encode(r.hash));
    });
    return this.flushing;
  }

  async wipe() {
    if (this.objectsDir && this.refsDir) {
      const root = await navigator.storage.getDirectory();
      await root.removeEntry(ROOT_DIR, { recursive: true });
    }
  }

  // ----- combs -----
  listCombs(): string[] {
    return this.gfs.listCombs() as string[];
  }
  hasComb(comb: string) {
    return this.gfs.hasComb(comb);
  }
  async createComb(comb: string, author: Author) {
    const id = this.gfs.createComb(comb, author, Date.now());
    await this.flush();
    return id;
  }
  head(comb: string) {
    return this.gfs.head(comb);
  }
  objectCount() {
    return this.gfs.objectCount();
  }

  // ----- working tree -----
  readFile(comb: string, path: string): Uint8Array {
    return this.gfs.readFile(comb, path);
  }
  readText(comb: string, path: string): string {
    return dec.decode(this.readFile(comb, path));
  }
  writeFile(comb: string, path: string, bytes: Uint8Array | string) {
    this.gfs.writeFile(comb, path, typeof bytes === "string" ? enc.encode(bytes) : bytes);
  }
  remove(comb: string, path: string) {
    return this.gfs.remove(comb, path);
  }
  exists(comb: string, path: string) {
    return this.gfs.exists(comb, path);
  }
  stat(comb: string, path: string) {
    return this.gfs.stat(comb, path) as { name: string; kind: "file" | "dir"; size: number; hash: string };
  }
  listDir(comb: string, path: string) {
    return this.gfs.listDir(comb, path) as { name: string; kind: "file" | "dir"; size: number; hash: string }[];
  }
  listAll(comb: string) {
    return this.gfs.listAll(comb) as [string, string, number][];
  }
  status(comb: string) {
    return this.gfs.status(comb) as FileDiff[];
  }
  resetWorking(comb: string) {
    this.gfs.resetWorking(comb);
  }

  // ----- history -----
  putBlob(bytes: Uint8Array | string) {
    return this.gfs.putBlob(typeof bytes === "string" ? enc.encode(bytes) : bytes);
  }
  async commit(comb: string, kind: EntryKind, author: Author): Promise<string | null> {
    const id = this.gfs.commit(comb, kind, author, Date.now()) ?? null;
    await this.flush();
    return id;
  }
  log(comb: string): HistoryEntry[] {
    return this.gfs.log(comb) as HistoryEntry[];
  }
  entry(id: string): HistoryEntry {
    return { id, ...(this.gfs.entry(id) as Omit<HistoryEntry, "id">) };
  }
  diffEntry(id: string): FileDiff[] {
    return this.gfs.diffEntry(id) as FileDiff[];
  }
  unifiedDiff(path: string, oldHash: string | null, newHash: string | null): string {
    return this.gfs.unifiedDiff(path, oldHash ?? undefined, newHash ?? undefined);
  }
  readFileAt(entryId: string, path: string): Uint8Array {
    return this.gfs.readFileAt(entryId, path);
  }
  listDirAt(entryId: string, path: string) {
    return this.gfs.listDirAt(entryId, path) as { name: string; kind: "file" | "dir"; size: number; hash: string }[];
  }
  listAllAt(entryId: string) {
    return this.gfs.listAllAt(entryId) as [string, string, number][];
  }
  blob(hash: string): Uint8Array {
    return this.gfs.blob(hash);
  }
  async rollback(comb: string, toEntry: string, author: Author): Promise<string> {
    const id = this.gfs.rollback(comb, toEntry, author, Date.now());
    await this.flush();
    return id;
  }
  verify(comb: string): VerifyReport {
    return this.gfs.verify(comb) as VerifyReport;
  }
}

async function writeFile(dir: FileSystemDirectoryHandle, name: string, bytes: Uint8Array) {
  const handle = await dir.getFileHandle(name, { create: true });
  // Sync access handles are worker-only and fast; fall back to a writable stream elsewhere.
  const anyHandle = handle as any;
  if (typeof anyHandle.createSyncAccessHandle === "function") {
    const access = await anyHandle.createSyncAccessHandle();
    try {
      access.truncate(0);
      access.write(bytes, { at: 0 });
      access.flush();
    } finally {
      access.close();
    }
  } else {
    const w = await anyHandle.createWritable();
    await w.write(bytes);
    await w.close();
  }
}

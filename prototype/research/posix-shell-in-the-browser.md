# Research: a real bash in the browser, in a Web Worker, on our own JS filesystem, hosted on GitHub Pages

Date: 2026-10-23. Sources: npm registry metadata and tarballs (inspected locally), docs.wasmer.io, GitHub READMEs/raw files, Wasmer registry GraphQL. Nothing installed; tarballs were only unpacked for reading `.d.ts`/README files.

---

## 1. Wasmer JS SDK (`@wasmer/sdk`)

### 1.1 Versions and the API split (important)

- **Latest: `@wasmer/sdk` 0.19.1, published 2026-10-07** (npm `dist-tags.latest`). Repo moved: `package.json` now points to `github.com/wasmerio/wasmer-sdk` (dir `js/`), not `wasmerio/wasmer-js`.
- Release cadence from npm `time`: 0.9.0 (2024-10-31) → 0.10.0 (2025-12-01) → **0.11.0 (2026-09-01, full rewrite)** → 0.13…0.19.0 (Sept 2026) → 0.19.1 (2026-10-07).
- **Two incompatible APIs exist under the same package name:**
  - **Old API (≤ 0.10.0):** `init()`, `Wasmer.fromRegistry()`, `Command.run()`, `runWasix()`, `Directory`, `initializeLogger`, `setRegistry`, `setWorkerUrl`, `setSDKUrl`. This is what docs.wasmer.io/javascript-sdk and the xterm.js tutorial still describe (the docs are behind the npm package).
  - **New API (≥ 0.11.0, "package-first sandbox SDK"):** `new Wasmer()`, `wasmer.packages.load/create`, `wasmer.sandboxes.create({packages, files, env, network, shell})`, `sandbox.command(name, args).run()/spawn()`, `sandbox.fs.*`. **`init`, `Directory`, `runWasix`, `fromRegistry` are gone** (confirmed by grepping `dist/index.d.ts` in 0.19.1 — zero hits). The README in 0.19.1 is the only accurate doc for it.
- Dependency: only `@mercuryworkshop/wisp-js ^0.4.1`. Entry points: `.`/`./browser` → `dist/index.js`; `./node`; `./service-worker`; `./service-worker-host`. Shipped wasm: `pkg/wasmer_sdk_js_bg.wasm` = **4.83 MB** (0.9.0 was 5.7 MB).

### 1.2 Running bash from the registry

Package names on the registry (verified via `https://registry.wasmer.io/graphql`):

| package | latest | date | commands | deps | .webc size |
|---|---|---|---|---|---|
| `wasmer/bash` | 1.0.25 | 2026-02-17 | `bash`, `sh` | `wasmer/coreutils ^1.0.19` | 1.87 MB |
| `sharrattj/bash` | 1.0.18 | 2025-03-28 | `bash`, `sh` | `wasmer/coreutils ^1.0.19` | — |
| `wasmer/coreutils` | 1.0.27 | 2026-09-26 | 83 cmds (`ls cat cp mv rm mkdir sort head tail tr wc tee …`) | none | 12.7 MB |
| `sharrattj/coreutils` | 1.0.16 | 2023-05-25 | similar | none | — |

Manifest of `wasmer/bash` (`wasmer.toml`): module `bash.wasm`, `abi = "wasi"`, `wasmer-extra-flags = "--enable-threads --enable-bulk-memory"`, runner `wasi@unstable_`, license "GNU". It's GNU bash 5.1 built against wasix-libc (source: `github.com/wasix-org/bash`, last commit 2023-03-03, GPL-3.0; its `build-wasi.sh` targets `--target=wasm32-wasi -mthread-model posix -pthread` with `SYSROOT=/prog/wasix-libc/sysroot32`). `sharrattj/*` are the original author's packages; `wasmer/*` are the newer maintained copies. The new docs/README only reference `wasmer/bash`; the old xterm tutorial uses `sharrattj/bash`. Prefer **`wasmer/bash`**.

New-API code (from the 0.19.1 README; the terminal object is left to you — pair with xterm.js):

```js
import { Wasmer } from "@wasmer/sdk/browser";
const wasmer = new Wasmer();                       // sync ctor; optionally { parallelism, wasm, cache }
const sandbox = await wasmer.sandboxes.create({
  packages: ["wasmer/bash"],                       // registry names, or Uint8Array webc bytes, or Package
  files: { "main.py": "..." },                     // relative keys land in /workspace
  env: { TERM: "xterm-256color" },
  onPackageProgress: p => {/* resolving|downloading|loading|ready */},
});
const proc = await sandbox.command("bash", ["-i"]).spawn({
  stdin: "pipe", stdout: "pipe", stderr: "pipe",
  terminal: { columns: 100, rows: 30 },            // PTY; children inherit it
});
for await (const chunk of proc.stdout) term.write(chunk);   // ReadableBytes (async iterable, .lines())
await proc.stdin.write("ls\n");                              // WritableBytes
proc.resizeTerminal(cols, rows);
const out = await proc.wait({ check: false });               // Output { exitCode, reason, stdout, stderr, text() }
await sandbox.close(); await wasmer.close();
```

- `run()` (one-shot) takes `{ stdin: string|Uint8Array, timeoutMs, outputBytes, check }`; throws `ProcessExitError` on non-zero unless `check:false`.
- **env**: `SandboxOptions.env` (sandbox-wide) and `CommandOptions.env` per command. **cwd**: only on `CommandOptions` (`sandbox.command("bash", [], { cwd: "/workspace" })`). Default workdir is `/workspace`.
- `sandbox.shell(script)` / `` sandbox.sh`…` `` run a script through the configured `shell` command.

Old-API shape (0.9/0.10, for reference since the docs still show it):
```js
import { init, Wasmer, Directory, runWasix, initializeLogger } from "@wasmer/sdk";
await init({ module?, memory?, workerUrl?, sdkUrl?, log?, registryUrl?, token? });
const pkg = await Wasmer.fromRegistry("sharrattj/bash");   // also fromFile(bytes), fromWasm(bytes)
const inst = await pkg.entrypoint.run({ args, env, stdin, cwd, mount: { "/app": dir }, uses: [...] });
inst.stdin /* WritableStream|undefined */; inst.stdout, inst.stderr /* ReadableStream */;
const { ok, code, stdout, stderr, stdoutBytes, stderrBytes } = await inst.wait();
runWasix(wasmModuleOrBytes, { program, runtime, args, env, stdin, cwd, mount });
```

### 1.3 Web Worker / SharedArrayBuffer / COOP+COEP

- The SDK itself spawns a **threadpool of module Web Workers** (`dist/browser-worker.js`, located via `new URL("./browser-worker.js", import.meta.url)`); each worker `import()`s the SDK glue (`pkg/wasmer_sdk_js.js`) and instantiates the same wasm module against a **shared `WebAssembly.Memory({initial:25, maximum:65536, shared:true})`**. Browser default `parallelism` is 2.
- **SharedArrayBuffer is mandatory, even for single-threaded guests.** README 0.19.1: "Worker-backed WASIX execution requires a cross-origin-isolated page". Troubleshooting doc: the error is `SharedArrayBuffer transfer requires self.crossOriginIsolated`. The wasm binary contains the string "You can only run packages from "Cross-Origin Isolated" websites". So **COOP: same-origin + COEP: require-corp are required.**
- **Running the SDK *inside* your own Worker (not the main thread):** not documented either way. Evidence from reading `dist/index.js` 0.19.1: the core sandbox/process/fs paths only need `self`, `Worker`, `SharedArrayBuffer`, `Atomics`, `caches` — all available in a DedicatedWorker. Only the HTTP-preview paths (`sandbox.ports.expose`, `createIframe`, WISP `requestUrl`) touch `window`/`document`, and those are guarded. The glue has `instanceof WorkerGlobalScope`/`Window` checks and a `typeof self` accessor, so it is written to run in both. **Practical requirement: nested workers** (`new Worker` from inside a dedicated worker) — per MDN browser-compat-data 8.1.7 (`api.Worker.worker_support`): Chrome 69+, Firefox 34+, **Safari/iOS 16.4+** (not in Shared Workers). SharedArrayBuffer itself: Chrome 68+, Firefox 79+, Safari/iOS 15.2+. Treat "SDK inside a worker" as *likely to work, unverified by Wasmer docs* — worth a 1-hour spike before committing.
- Old API docs explicitly warned the workers must not import DOM-touching code (xterm) → "document is not defined"; fix was dynamic `import("@wasmer/sdk")` so the bundler splits it into its own chunk.

### 1.4 How packages are fetched; can we pre-bundle?

- Registry endpoint hard-coded in the wasm: **`https://registry.wasmer.io/graphql`** (GraphQL `getPackageRelease`/`getPackageVersion` → `piritaDownloadUrl`). Actual bytes come from **`https://cdn.wasmer.io/webcimages/<sha256>.webc`**. Both answer with `access-control-allow-origin: *` (checked with `curl -I`), and the CDN also exposes `Content-Length/Accept-Ranges`, so a static page on github.io can fetch them cross-origin. Under COEP `require-corp` the CDN would also need `Cross-Origin-Resource-Policy` — not present in the headers I saw, but `access-control-allow-origin: *` + CORS-mode `fetch` satisfies COEP, which is how the SDK fetches. (If you use coi-serviceworker in `credentialless` mode this is moot.)
- No `registryUrl` option survives in the new API (0.9/0.10 had `init({registryUrl, token})` and `setRegistry`). The 0.19.1 `WasmerOptions` is only `{ outputBytes, parallelism, wasm, cache }`.
- **Pre-bundling IS supported:** `PackageSource = string | Uint8Array | Package`. `wasmer.packages.load(bytes)` accepts a **`.webc` archive or a raw WASI/WASIX `.wasm`** (raw module → single command `main`). `wasmer.packages.create({ modules: {bash: bytes}, commands: {bash: {module:"bash"}, sh: {...}}, entrypoint, files })` builds an in-memory package with named commands. So: **download `wasmer/bash`'s `.webc` (1.87 MB) and `wasmer/coreutils` (12.7 MB) at build time, commit/ship them as static assets, `fetch()` them from your own origin and pass the bytes → no live registry calls.** Caveat: a `.webc` with a `use` dependency (bash → coreutils) — when loaded from bytes, dependency resolution presumably still goes to the registry unless you also `installPackage` coreutils bytes into the sandbox; untested. The safe approach is to load both webc files yourself.
- The old API equivalent was `Wasmer.fromFile(webcBytes)` / `Wasmer.fromWasm(bytes)`.
- Browser caching: `cache: "memory" | { namespace, readOnly }` — package data is persisted via the **Cache Storage API** (`caches.open/match/put` in the glue), origin-scoped. The `wasm` option (`Parameters<typeof init>[0]`) lets you pass a precompiled `WebAssembly.Module` or custom URL for `wasmer_sdk_js_bg.wasm` (default: `new URL('wasmer_sdk_js_bg.wasm', import.meta.url)` in `pkg/wasmer_sdk_js.js`).

### 1.5 Filesystem: `Directory` (old) vs `sandbox.fs` (new) vs custom JS filesystem

**Old `Directory` (≤0.10):** `new Directory(init?: Record<path, string|Uint8Array>)`; methods `readDir(path) → DirEntry[]{name,type}`, `writeFile`, `readFile → Uint8Array`, `readTextFile`, `createDir`, `removeDir` (empty only), `removeFile`. Mount with `mount: { "/app": dir }` (docs warn: don't mount at `/`). **Yes, files written by the guest are readable from JS afterwards** (docs' kitchen-sink example writes `/out/version.txt` and reads it back). It is a Rust `mem_fs` living inside the wasm; `Directory` is a handle. **No custom JS-implemented backend** — `mount` values are `DirectoryInit | Directory` only.

**New `sandbox.fs` (≥0.11):** `SandboxFileSystem { writeFile, writeText, readFile → Uint8Array, readText, mkdir({recursive}), readDir → {name, kind, size}[], stat → {kind,size}, remove({recursive}), rename }`, async, path-based, no handles/streams, no symlink or mode API. `files:` seeds paths (absolute guest paths, or relative → `/workspace`); bundled files "use private writable overlays". Everything lives in the in-wasm `mem_fs`/`OverlayFileSystem`/`WebcVolumeFileSystem` (strings in the binary). **Persistence: in-memory only; `/workspace` is "persistent" only for the sandbox's lifetime** (wasmer.sh keeps one long-lived sandbox; package bytes are cached, workspace contents are not persisted across reloads per README).

**Custom host filesystem — the headline finding:** 0.19.1 ships an **experimental host-filesystem RPC bridge**:
- `dist/host-filesystem.{js,d.ts}` — "Experimental worker-to-native filesystem protocol used by the iOS prototype." Exports `HOST_FS_MESSAGE = "wasmer-filesystem-rpc"`, `installHostFileSystemWorkerBridge(route?)` (auto-installed in every `browser-worker.js`), `respondToHostFileSystem(request, result)`, `isHostFileSystemRequest`.
- Transport: the worker calls sync `globalThis.__wasmerHostFileSystem(mountId, method, args)`, which `postMessage`s `{type, mount, method, args, response: SharedArrayBuffer, binary:true}` to its parent and blocks on `Atomics.wait`; the host writes the reply into the SAB (header Int32[status,len]; **512 KiB max payload**, **30 s timeout → ETIMEDOUT**) and `Atomics.notify`s.
- Rust side (`js/bindgen/src/host_filesystem.rs`) implements the `FileSystem`/`File` traits with these RPC methods: **`stat(path)`, `readDir(path)`, `open(path, read, write, create, create_new, truncate, append) → id`, `mkdir(path)`, `remove(path)` (non-recursive), `rename(from,to)`, `sync()`, `setTimes(path, atime?, mtime?)`; per handle: `fileStat(id)`, `setFileTimes`, `read(id, offset, len ≤ 64 KiB)`, `write(id, offset, bytes ≤ 64 KiB)`, `setLen(id, len)`, `flush(id)`, `close(id)`.** Metadata = `{kind:"directory"|"file", size, accessed, modified, created}` as ns-strings. **No symlinks** (rejected), no mode bits, no caching (every op is a sync round-trip).
- Wiring: the wasm-bindgen core exposes `SandboxBuilderCore.mountHost(path, mount_id, read_only)` ("Experimental worker-only native directory mount") and `storageHost(mount_id)` ("Use an embedder filesystem as /workspace, including the SDK file API"). **These are NOT surfaced in the public TS `SandboxOptions`** in 0.19.1 (`dist/index.js` never calls them), and the main-thread side that answers `wasmer-filesystem-rpc` messages is not in the npm package (it lives in the Swift/iOS embedder). So using it means: (a) importing `../pkg/wasmer_sdk_js.js` directly / patching `Sandbox` creation to call `builder.mountHost("/mnt/gfs", 1, false)` before `start()`, and (b) attaching an `onmessage` to each SDK worker (or using the `route` callback inside the worker, which is cleaner: implement our JS fs *inside the SDK worker* and answer synchronously, no cross-thread hop). The SDK spawns the workers itself, so getting at them requires either monkey-patching `Worker` or running the whole SDK inside *our* worker and routing in that worker's `onmessage`.
- Verdict: a sanctioned-but-unstable hook exists and its method set maps almost 1:1 onto a content-addressed store (open/read/write/readDir/stat/rename/remove/setLen). It is **experimental, undocumented in the README, absent from the TS API, could change in any 0.x release**, and **symlink-less**. Budget for pinning the SDK version and reading `host_filesystem.rs` when upgrading.

Fallback without the hook: treat the in-wasm `/workspace` as a scratch mirror — hydrate it from our store with `files:`/`sandbox.fs.writeFile` before the command, run, then `readDir`/`readFile` back the changed paths (diff by mtime isn't available — `stat` has no mtime in the public API — so either re-walk and content-hash, or scope writes to a known output directory). Both old (`Directory`) and new (`sandbox.fs`) APIs support this round-trip.

### 1.6 Known issues / gotchas

- **Bundlers/Vite** (from wasmer-sh's `vite.config.ts` in the sdk repo — the canonical static build): `optimizeDeps.exclude: ["@wasmer/sdk"]` (keeps `new URL(..., import.meta.url)` intact), `worker.format: "es"`, `build.target: "es2022"`, `build.modulePreload.polyfill: false`, plus a custom plugin that copies `browser-worker.js`, `pkg/wasmer_sdk_js.js`, the `.wasm` and `pkg/snippets/**` into a content-hashed `assets/wasmer-runtime-<hash>/` dir. Changelog 0.16.0: "fix worker imports in production builds" — stay ≥0.16.
- Dynamic-import the SDK so nothing DOM-dependent (xterm) ends up in the worker chunk ("document is not defined").
- Old API: calling anything before `await init()` → `__wbindgen_add_to_stack_pointer` undefined. Old `initializeLogger("debug")` to see why a registry package silently fails (blank cursor). New API has no `initializeLogger`; errors come as `WasmerError{code}` (`PACKAGE_LOAD_FAILED`, `WORKER_FAILED`, …).
- Safari: wasmer-sdk's own suite runs on "Safari 27+" (README); no documented Safari-specific bugs. Older `wasmer-js` issues around Safari + SAB are pre-rewrite.
- Nested subprocesses (`bash → coreutils`) work via WASIX `proc_spawn` + worker sharing fixed in 0.12.0.
- Node.js is served by `@wasmer/sdk/node`; the browser build throws "Unable to determine the hardware concurrency" under Node.
- Size: SDK wasm 4.8 MB + bash 1.9 MB + coreutils 12.7 MB ≈ **19.5 MB** first load (cached in Cache Storage afterwards). Well under GitHub Pages' 1 GB site / 100 GB-per-month soft limits, but a real first-paint cost.

---

## 2. Alternatives and prior art

| Option | What it is | Custom-FS backing | Static GH Pages | Needs SAB/COOP | Verdict |
|---|---|---|---|---|---|
| `just-bash` 3.6.0 (2026-10-01, Apache-2.0) | TS bash *interpreter* + ~100 TS coreutils | **Yes — public `IFileSystem` interface** | Yes, plain JS | **No** | Best "second path"; not real bash |
| `@wasmer/sdk` 0.19.1 | real GNU bash 5.1 (WASIX) | experimental RPC hook; else mirror | Yes w/ coi-sw | **Yes** | Primary path |
| `@bjorn3/browser_wasi_shim` 0.4.2 (2025-06-22, MIT/Apache) | pure-JS WASI p1 | **Yes — subclass `Fd`/`Inode`** | Yes | No (unless threads) | Needs a WASI-p1 bash/busybox binary, which we'd have to build; no fork/pipes |
| `@runno/wasi` 0.10.0 (2025-05-18, MIT) | WASI p1 in browser | No — flat snapshot object | Yes | Worker mode: yes (stdin) | No bash runtime shipped |
| WebContainers `@webcontainer/api` 1.6.4 (2026-04-14) | StackBlitz Node OS | `fs` API only, not pluggable | Needs COOP/COEP; boots from `*.webcontainer.io`/`*.staticblitz.com` | Yes | Commercial license for production; shell is `jsh`, not bash |
| v86 (BSD-2) | x86 PC emulator, JIT→wasm | **Yes — `handle9p` raw 9p server hook** | Yes | No (optional) | Full Linux; heavy; 9p server = implement protocol |
| container2wasm / qemu-wasm | x86_64 container → wasm (Bochs/TinyEMU/QEMU) | virtio-9p via WASI preopens | Yes (demo on github.io) | QEMU path: yes | Very heavy, experimental |
| trynix (MIT, 2026-09) | qemu-wasm + Nix closures from cache.nixos.org over 9p | in-memory store over 9p | **Yes — purely static** | (qemu-wasm threads → yes) | Proves static-hosted real Linux shells; 1.5 GiB closure cap |
| jswasi (Antmicro) | WASI runtime + own `wash` shell | ? | Yes | ? | Not bash |
| Browsix (MIT, 2016–17) | Unix-in-browser, BrowserFS, emscripten/asm.js | BrowserFS backends | Yes | No | Unmaintained (Node 4 era) |
| linux-wasm (joelseverin) | Linux kernel + BusyBox in wasm, no MMU | ? | demo on github.io | no | "not stable nor secure", console freezes |
| `@cloudflare/workers-wasi` 0.0.5 (2022-02-07, BSD-3) | WASI p1 for CF Workers, littlefs | littlefs only, no links | n/a | n/a | WIP, not for browsers |
| `bash-wasm` on npm | — | — | — | — | **Does not exist** on npm (404) |
| brush (Rust bash clone, MIT) | bash-compatible shell in Rust, ~1400–1700 compat tests | uses std::fs; no wasm target documented | — | — | Would need our own WASI port; no demo |

### just-bash (vercel-labs/just-bash) — closest to "custom fs by design"
- npm `just-bash` 3.6.0 (2026-10-01), Apache-2.0, "beta", engines node ≥20.19 but has a **`./browser` export** (`dist/bundle/browser.js`, 1.26 MB + 2.1 MB of lazy chunks). Browser excludes `OverlayFs`, `ReadWriteFs`, `Sandbox`, `python3`, `sqlite3`, `js-exec`; `gzip/gunzip/zcat` fail at runtime (node:zlib). Everything else works.
- **Custom FS: `new Bash({ fs })` takes any `IFileSystem`** (`dist/fs/interface.d.ts`; comment says it exists for "Custom implementations (e.g., remote storage, browser IndexedDB)"). Required methods (all async, path-based): `readFile(path, enc?)`, `readFileBuffer`, `writeFile`, `appendFile`, `exists`, `stat → {isFile,isDirectory,isSymbolicLink,mode,size,mtime,dev?,ino?,identity?}`, `mkdir({recursive})`, `readdir → string[]`, `rm({recursive,force})`, `cp({recursive})`, `mv`, `resolvePath(base,path)` (sync), `getAllPaths()` (sync), `chmod`, `symlink`, `link`, `readlink`, `lstat`, `realpath`, `utimes`. Optional: `readFileBytes`, `createExclusive`, `readdirWithFileTypes`. Also `MountableFs({ base, mounts:[{mountPoint, filesystem}] })` to compose, and `InMemoryFs` with lazy `{lazy: () => Promise<content>}` entries.
- Commands (~100): cat cp file ln ls mkdir mktemp mv readlink rm rmdir split stat touch tree; awk base64 column comm cut diff expand fold grep/egrep/fgrep head join md5sum nl od paste printf rev rg sed sha1sum sha256sum sort strings tac tail tr unexpand uniq wc xargs; jq yq xan; tar gzip; basename cd dirname du echo env export find hostname printenv pwd tee; alias bash chmod clear date expr false help history seq sh sleep time timeout true unalias which whoami yes; curl/html-to-markdown (network allow-list). `defineCommand` adds JS commands.
- Shell features documented: pipes, redirections (`> >> 2> 2>&1 <`), `&& || ;`, `$VAR ${VAR:-d}`, positional params, globs, if/elif, functions, `local`, for/while/until, symlinks/hardlinks. The `dist/interpreter/` directory additionally contains `subshell-group`, `process-substitution`, `arithmetic`, `fd-table`, `numeric-fd-redirects`, `alias-expansion`, heredocs — so coverage is broader than the README list. Caveats: it is an *interpreter*, each `exec()` is a fresh shell state (fs persists), no real processes/signals/job control, no `select`, and all "binaries" are TS reimplementations (sed/awk fidelity unknown).
- Fit: **custom filesystem — excellent (first-class)**; **static hosting — trivial, no COOP/COEP, no SAB**; runs fine inside a Web Worker (pure JS). Not a real bash.

### browser_wasi_shim (`@bjorn3/browser_wasi_shim` 0.4.2)
- Pure JS `wasi_snapshot_preview1` subset. `new WASI(args, env, fds)`; `fds[]` are `Fd` objects: `OpenFile(new File(bytes))`, `ConsoleStdout.lineBuffered(cb)`, `PreopenDirectory(".", [[name, File|Directory], …])`.
- **Pluggable: `Fd` and `Inode` are exported `abstract` classes** (`typings/fd.d.ts`). `Inode` requires `path_open(oflags, rights, fdflags) → {ret, fd_obj}` and `stat() → Filestat`; `Fd` has overridable `fd_read/fd_write/fd_pread/fd_pwrite/fd_seek/fd_readdir_single/path_open/path_lookup/path_create_directory/path_unlink_file/path_rename/path_readlink/path_filestat_get/…`. The in-tree `SyncOPFSFile`/`OpenSyncOPFSFile` (OPFS sync access handles) are exactly such a custom backend — a template for ours. **All methods are synchronous**, so a content-addressed store must be fully in-memory in the worker (or use OPFS sync handles / `Atomics.wait` RPC to the main thread).
- No threads/SAB needed (there is a `threads/` dir upstream but it's optional). Only WASI p1 — **no `fork`/`exec`/pipes/signals**, so real bash cannot run subprocesses on it; a BusyBox-style single binary with built-in applets (`ash` + utils in one wasm, "applet" dispatch instead of exec) is the only shape that works. No such prebuilt wasm32-wasi busybox/bash was found as a maintained artifact (see §2.3).
- Fit: custom FS — **excellent, but sync-only**; static hosting — **excellent**; shell — needs a WASI-p1 shell binary we'd build (dash/busybox-ash can be configured to avoid fork via `NOFORK`/`vfork` tricks? — unverified, risky), and pipes between commands would have to be emulated inside that single binary.

### Runno (`@runno/wasi` 0.10.0)
- `new WASI({args, env, stdin, stdout, stderr, fs})`; `fs` is a **flat snapshot `{ "/path": {path, timestamps, mode, content} }`**, all files pre-opened at `/`, permissions ignored; `WASIWorkerHost(binaryURL, opts)` runs in a worker and **needs SharedArrayBuffer for stdin**. No pluggable FS interface ("there may be … hooks into the filesystem" is a stated future idea). Only WASI unstable/preview1; explicitly **not WASIX**. Shipped runtimes: python, ruby, quickjs, sqlite, clang, clang++, php-cgi — **no bash/sh**. Fit: poor for both criteria beyond trivial snapshot in/out.

### WebContainers (`@webcontainer/api` 1.6.4, 2026-04-14)
- Requires COOP/COEP (SAB); boots code from StackBlitz-controlled origins (`*.webcontainer.io`, `*.staticblitz.com`), so not a self-contained static site. FS API: `mount(tree)`, `fs.readFile/readdir/rm/writeFile/mkdir` — not pluggable. Shell is their `jsh`, not bash. **Licensing: production use "in a commercial, for-profit setting" requires a license; prototypes/POCs don't.** Fit: custom FS — no; static — only via coi-sw and still dependent on their servers.

### v86 (BSD-2)
- x86 PC emulator with runtime x86→wasm translation. Filesystem doc: 9p over virtio; three host modes: (1) `basefs`+`baseurl` JSON/HTTP lazy-loaded in-memory JS fs, (2) **`handle9p: async (reqBuf, reply) => …` — implement a 9p server in JS**, (3) `proxy_url` WebSocket. Mode 2 means our store can back the guest root fully (`root=host9p rootfstype=9p`), at the cost of implementing 9P2000.L in JS. No SAB required. Runs real Linux (Buildroot/Alpine images with real bash), image typically tens of MB; boot seconds; CPU-heavy. Fit: custom FS — yes via 9p; static — yes (v86 demos are static). Heavy but the most "real".

### container2wasm / qemu-wasm / trynix
- container2wasm converts OCI images to wasm (Bochs/TinyEMU for WASI builds; QEMU-wasm with TCG JIT for the emscripten build); runs in browser with xterm-pty + browser_wasi_shim; host dirs via virtio-9p; demo hosted at `ktock.github.io`. trynix (Sept 2026, MIT) is the most relevant proof: **entirely static site**, qemu-wasm boots a pre-snapshotted x86_64 Linux, Nix closures are fetched straight from `cache.nixos.org` (CORS `*`) and written into an in-memory fs exposed to the guest over 9p; "warm cache gives a shell in about three seconds"; closure must fit ~1.5 GiB. Fit: proves "real Linux + static host + browser-side fs over 9p" is viable, but at VM weight.

### 2.3 Can we build the shell binary ourselves (Nix), instead of fetching from the registry?

- **WASIX toolchain:** `wasix-org/wasix-libc` (Apache-2.0/MIT, active: releases `v2026-10-02.1` with `sysroot.tar.gz` 5.95 MB, `sysroot-eh*.tar.gz`, `sysroot-ehpic*.tar.gz`). Build is `clang --target=wasm32-wasi` + `--sysroot=<wasix sysroot>` + `-pthread -mthread-model posix -matomics -mbulk-memory` (per wasix-org/bash `build-wasi.sh`); there is no separate "wasm32-wasix" LLVM triple. The convenient front-end is **`wasixcc`** (Rust crate, latest 0.4.7; `curl -fsSL https://wasix.cc | sh`), which downloads LLVM + sysroot + wasm-opt and offers Asyncify (default, "runs anywhere") vs `-sWASM_EXCEPTIONS` vs `+PIC` builds. **No `wasix-sdk` repo exists** (404) — the SDK is wasi-sdk's clang + wasix-libc sysroot. WASIX binaries **run only on Wasmer** ("Currently, Wasix is only supported by the Wasmer runtime", wasix.org).
- **Nix:** nixpkgs has `wasilibc` 32 and `pkgsCross.wasi32` (wasm32-wasip1), but **no wasix-libc / WASIX cross stdenv** in nixpkgs. A Nix build of WASIX bash would be a custom derivation: fetch `sysroot.tar.gz` from wasix-libc releases + nixpkgs `llvmPackages.clang-unwrapped`/`lld`, then build `wasix-org/bash` (the fork is from 2022–2023; `build-wasi.sh` is a stub that only compiles `alias.c` into `bash.a`, so the real recipe is in the `cross-build/` dir and Wasmer's internal CI — expect to reverse-engineer). Realistic effort: days, with fragile upstream.
- **Nix + plain WASI (`pkgsCross.wasi32`):** possible for *single-process* C programs; bash needs fork/pipes/signals → **not viable on WASI p1**. BusyBox has been built to wasm32-wasi by hobby projects (e.g. linux-wasm's musl-based userland, `@wasmos/ash` 0.0.2 on npm — 43 MB, unmaintained) but nothing maintained or packaged; `ash` still forks for pipelines.
- **Pragmatic alternative to "build it ourselves":** pin by content hash. The registry gives `piritaSha256Hash`; the CDN URL is `https://cdn.wasmer.io/webcimages/<sha256>.webc`. A Nix `fetchurl { url; sha256 }` of `wasmer/bash@1.0.25` (`0596…21e1`) and `wasmer/coreutils@1.0.27` into the static site is reproducible, offline at runtime, and needs no toolchain. The binaries are GPL (bash) — ship source links.

---

## 3. COOP/COEP on GitHub Pages

- **GitHub Pages cannot set response headers.** Confirmed by GitHub community discussion #13309 ("Allow setting COOP and COEP headers in Github Pages", opened Mar 2022): GitHub staff (Jul 2023) said they'd support custom headers with "No ETA"; latest comment 2026-08-15 still reports being blocked. Pages limits page: static files only, 1 GB site, 100 GB/month soft bandwidth, 10 builds/hour.
- **Standard workaround: `coi-serviceworker` (gzuidhof/coi-serviceworker), npm `coi-serviceworker` 0.1.7 (2023-07-09)** — recommended by Wasmer's own docs page "COOP/COEP headers" for GitHub Pages. Mechanism: a service worker that adds `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: credentialless` (default; falls back to `require-corp` if `coepDegrade`), and `Cross-Origin-Resource-Policy: cross-origin` (only in require-corp mode) to every fetched response; on the **first visit it registers the SW and reloads the page**.
- Rules: must be a **separate file served from your own origin** (not bundled, not CDN), page over HTTPS (or localhost), add `<script src="coi-serviceworker.js"></script>` before anything that needs SAB. Config via `window.coi = { shouldRegister, shouldDeregister, coepCredentialless, coepDegrade, doReload, quiet }`.
- Caveats: (1) **first-load reload** — code runs once without isolation then reloads (issue #14 "flash of non-COI code"): gate app boot on `crossOriginIsolated === true`, keep the first paint cheap; (2) **no service worker in Firefox private mode** (and any context where `navigator.serviceWorker` is undefined — the script logs and gives up); (3) Chromium-only report of "first run OK, second run fails, third on fine" (issue #31, unresolved); (4) reload loops are guarded via `sessionStorage` (`coiReloadedBySelf`), but community reports of loops exist; (5) **Safari**: no Safari-specific handling in the script; `COEP` itself is Safari 15.2+, but `COEP: credentialless` is **not supported in Safari/iOS at all** (MDN BCD 8.1.7: Chrome 96+, Firefox 119+, Safari `false`) → rely on `coepDegrade` to `require-corp` (costs one extra reload on Safari), which then requires every cross-origin resource (e.g. `cdn.wasmer.io` webc, Google Fonts) to be CORS-fetched or carry CORP — another reason to self-host the webc files; (6) the SW only intercepts same-scope fetches, so the file must sit at or above the page's path; (7) with GitHub Pages project sites (`user.github.io/repo/`), place it in the repo root of the published site.
- Alternative: deploy the same static build to Netlify/Cloudflare Pages/Vercel with a `_headers` file (people in #13309 report success) — if GitHub Pages is a hard constraint, coi-sw is the only option.

---

## 4. Recommendation

**Lowest-risk path to a *real* bash with our own fs, static-hosted:** `@wasmer/sdk` **0.19.1 pinned**, running **inside our own Web Worker** (spike nested-worker support on Safari first), with **`wasmer/bash@1.0.25` and `wasmer/coreutils@1.0.27` `.webc` files fetched at build time by content hash (Nix `fetchurl`) and served from our own origin** via `wasmer.packages.load(bytes)` — no registry calls at runtime; **`coi-serviceworker` 0.1.7** at the site root, app boot gated on `crossOriginIsolated`, Vite config copied from `wasmer-sh/vite.config.ts` (`optimizeDeps.exclude`, `worker.format:"es"`, runtime-asset copying). For the filesystem, do **not** bet the prototype on the experimental host-fs RPC: start with the **mirror strategy** (hydrate `/workspace` from our content-addressed store via `files:`/`sandbox.fs.writeFile`, run bash, read back with `sandbox.fs.readDir/readFile` and content-hash to detect changes — our store is CAS, so re-hashing is natural). In parallel, run a bounded spike on `SandboxBuilderCore.mountHost()` + `installHostFileSystemWorkerBridge({route})` answering `stat/readDir/open/read/write/…` synchronously *inside the SDK worker* from an in-memory copy of our store; if it works, it gives true live-mounted semantics with a 1:1 method map, at the cost of an unstable 0.x internal.

**Second-best fallback:** **`just-bash` 3.6.0** (`just-bash/browser`), implementing its public, documented **`IFileSystem`** over our store (~20 async methods, symlinks included), running in a Worker with **no COOP/COEP, no SharedArrayBuffer, no wasm, ~3 MB JS**. It is not GNU bash (TS interpreter, TS coreutils, no processes/signals/job control), but it covers pipes, redirections, functions, loops, subshells, process substitution, arithmetic, and ~100 utilities, has first-class custom-fs support by design, and is the only option that is trivially static. Keep v86 + `handle9p` (real Linux, our store as a JS 9p server) as the "if we ever need real everything" escape hatch, and discard browser_wasi_shim/runno for bash specifically because WASI preview1 has no fork/pipes.

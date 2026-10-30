// PROTOTYPE. Combs backed by git remotes.
//
// A comb can be connected to one branch of a git repository. gfs stays the local
// truth; every history entry is pushed as one git commit (encoded in git.rs, its
// provenance in trailers), automatically, a moment after it lands. When someone
// else moves the branch and the comb has nothing unpushed, their tree comes in as
// a `pull` entry. When both moved, the comb is *diverged*: nothing merges on its
// own. You keep yours or take theirs; either way the new tip has both histories as
// parents, so nothing is force-pushed away.
//
// Two transports: git's smart HTTP (any server; from a page only where CORS allows,
// or through the egress extension / a CORS proxy) and GitHub's REST API (CORS-open,
// so github.com works from a plain tab).

import type { Author, FileDiff, HistoryEntry } from "./protocol";
import type { Datacombs, EntryKind, GitOverlay } from "./gfs";
import { GitHttp, GitHttpError, ZERO, type FetchFn } from "./githttp";
import { GitHubApi, GitHubError, parseGitHubUrl, parseIdent, type TreeItem } from "./github";
import { refreshToken } from "./login";

export interface RemoteConfig {
  comb: string;
  transport: "git" | "github";
  /** git: https://host/owner/repo.git · github: https://github.com/owner/repo */
  url: string;
  branch: string;
  /** Basic-auth user for git (Forgejo: your login; GitHub: x-access-token). */
  username?: string;
  token?: string;
  corsProxy?: string;
  committerName?: string;
  committerEmail?: string;
  /** Push after every entry (default true). */
  auto?: boolean;
  /** Set by the sign-in flows; lets the worker refresh `token`. */
  oauth?: { flow: "github-device" | "forgejo-pkce"; clientId: string; tokenUrl: string; refreshToken?: string; expiresAt?: number };
}

export type RemoteState = "connecting" | "syncing" | "synced" | "waiting" | "diverged" | "auth" | "error";

export interface RemoteStatus {
  comb: string;
  transport: RemoteConfig["transport"];
  url: string;
  branch: string;
  label: string;
  state: RemoteState;
  /** Entries on the comb that aren't on the remote yet. */
  ahead: number;
  remoteHead: string | null;
  /** The remote tip we stopped at, when diverged. */
  diverged: string | null;
  lastSync: number | null;
  error: string | null;
  events: { time: number; text: string }[];
  /** gfs entry → git commit, for every entry known to be on the remote. */
  pushed: Record<string, string>;
  /** Web page of a commit: `${web}/commit/<sha>`. */
  web: string | null;
}

interface SyncState {
  key: string;
  commits: Record<string, string>;
  /** Newest entry known to be on the remote, and the commit standing for it. */
  last: { entry: string; commit: string } | null;
  overlay: GitOverlay;
  /** Extra parents for the next pushed tip (a resolved divergence). */
  mergeParents: string[];
  diverged: string | null;
}

interface PushPlan {
  ref: string;
  branch: string;
  base: string | null;
  baseEntry: string | null;
  baseTree: string | null;
  entries: string[];
  mergeParents: string[];
  old: string | null;
  haveTrees: string[];
  overlay: GitOverlay;
  encode(entry: string, parents: string[]): { commit: string; tree: string };
}

interface Transport {
  label: string;
  web: string | null;
  head(): Promise<string | null>;
  /** Bring a commit's tree (and blobs) into the git cache; returns the tree id. */
  fetchTree(commit: string): Promise<string>;
  push(p: PushPlan): Promise<{ commits: Record<string, string>; tip: string; notes: string[] }>;
}

export interface RemoteDeps {
  dc: Datacombs;
  fetch: FetchFn;
  node: string;
  /** Who a pull entry is attributed to. */
  author: () => Author;
  /** How an entry is committed (the worker's commitComb: /nix commits switch the system). */
  commit: (comb: string, kind: EntryKind, author: Author) => Promise<string | null>;
  /** True while pulling would pull the rug from under someone (the agent is mid-turn). */
  busy: () => boolean;
  publish: (s: RemoteStatus[]) => void;
  /** A refreshed token, for the page to keep. */
  onAuth: (comb: string, patch: Partial<RemoteConfig>) => void;
}

const short = (s?: string | null) => (s ? s.slice(0, 8) : "∅");
const keyOf = (c: RemoteConfig) => `${c.transport}|${c.url}|${c.branch}`;

function webBase(url: string): string | null {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname.replace(/\.git\/?$/, "").replace(/\/+$/, "")}`;
  } catch {
    return null;
  }
}

class SmartHttpTransport implements Transport {
  readonly label: string;
  readonly web: string | null;
  private http: GitHttp;
  constructor(private cfg: RemoteConfig, private dc: Datacombs, fetchFn: FetchFn) {
    this.http = new GitHttp({ url: cfg.url, username: cfg.username, token: cfg.token, corsProxy: cfg.corsProxy || undefined, fetch: fetchFn });
    this.label = cfg.url;
    this.web = webBase(cfg.url);
  }
  async head() {
    return (await this.http.advertise("git-upload-pack")).refs.get(`refs/heads/${this.cfg.branch}`) ?? null;
  }
  async fetchTree(commit: string) {
    if (!this.dc.gitHas(commit)) this.dc.gitIndexPack(await this.http.fetchShallow(commit));
    return this.dc.gitCommitInfo(commit).tree;
  }
  async push(p: PushPlan) {
    const commits: Record<string, string> = {};
    const order: string[] = [];
    let prev = p.base;
    p.entries.forEach((id, i) => {
      const parents = prev ? [prev] : [];
      if (i === p.entries.length - 1) parents.push(...p.mergeParents);
      const e = p.encode(id, parents);
      commits[id] = e.commit;
      order.push(e.commit);
      prev = e.commit;
    });
    let notes: string[];
    try {
      notes = await this.http.push(p.ref, p.old ?? ZERO, prev!, this.dc.gitPack(order, p.haveTrees));
    } catch (e) {
      // Our idea of what the remote already holds was wrong: send everything.
      if (!(e instanceof GitHttpError && /unpack|missing/i.test(e.message)) || !p.haveTrees.length) throw e;
      notes = await this.http.push(p.ref, p.old ?? ZERO, prev!, this.dc.gitPack(order, []));
    }
    return { commits, tip: prev!, notes: notes.slice(-2) };
  }
}

class GitHubTransport implements Transport {
  readonly label: string;
  readonly web: string;
  private api: GitHubApi;
  private empty = false;
  constructor(private cfg: RemoteConfig, private dc: Datacombs, fetchFn: FetchFn) {
    this.api = new GitHubApi(cfg.url, cfg.token, fetchFn);
    const p = parseGitHubUrl(cfg.url);
    this.label = `${p.owner}/${p.repo} via GitHub API`;
    this.web = p.web;
  }
  async head() {
    const h = await this.api.head(this.cfg.branch);
    this.empty = h.empty;
    return h.sha;
  }
  async fetchTree(commit: string) {
    const c = await this.api.commit(commit);
    if (this.dc.gitHas(c.tree)) return c.tree;
    const items = await this.api.listTree(c.tree);
    for (const it of items) {
      if (it.type !== "blob" || this.dc.gitHas(it.sha!)) continue;
      const oid = this.dc.gitPutObject("blob", await this.api.blob(it.sha!));
      if (oid !== it.sha) throw new Error(`blob ${it.path} came back as ${short(oid)}, GitHub says ${short(it.sha)}`);
    }
    const tree = this.dc.gitPutListing(items.map((it) => [it.path, it.mode, it.sha!]));
    if (tree !== c.tree) throw new Error(`rebuilt tree ${short(tree)} differs from GitHub's ${short(c.tree)}`);
    return tree;
  }
  async push(p: PushPlan) {
    const notes: string[] = [];
    let exists = p.old !== null;
    let force = false;
    if (this.empty) {
      const b = await this.api.bootstrap(this.cfg.comb);
      notes.push(`the repository was empty; made bootstrap commit ${short(b.sha)} on ${b.branch} through the contents API`);
      if (b.branch === this.cfg.branch) {
        exists = true;
        force = true; // replace our own bootstrap commit, nothing else
      }
      this.empty = false;
    }
    const commits: Record<string, string> = {};
    let prevCommit = p.base;
    let prevEntry = p.baseEntry;
    let prevTree = p.baseTree;
    let same = 0;
    for (const [i, id] of p.entries.entries()) {
      const parents = prevCommit ? [prevCommit] : [];
      if (i === p.entries.length - 1) parents.push(...p.mergeParents);
      const local = p.encode(id, parents);
      const changes: FileDiff[] = prevEntry
        ? this.dc.diffEntries(prevEntry, id)
        : this.dc.listAllAt(id).map(([path, hash]) => ({ path, status: "added", old_hash: null, new_hash: hash }));
      let tree = prevTree;
      if (changes.length || !tree) {
        const items: TreeItem[] = [];
        for (const c of changes) {
          if (c.status === "removed") items.push({ path: c.path, mode: "100644", type: "blob", sha: null });
          else items.push({ path: c.path, mode: modeOf(p.overlay, c.path), type: "blob", sha: await this.api.createBlob(this.dc.blob(c.new_hash!)) });
        }
        tree = await this.api.createTree(prevTree, items);
      }
      const info = this.dc.gitCommitInfo(local.commit);
      const sha = await this.api.createCommit({ message: info.message, tree: tree!, parents, author: parseIdent(info.author), committer: parseIdent(info.committer) });
      if (sha === local.commit) same++;
      commits[id] = sha;
      prevCommit = sha;
      prevEntry = id;
      prevTree = tree;
    }
    await this.api.setRef(this.cfg.branch, prevCommit!, exists, force);
    notes.push(same === p.entries.length ? "GitHub's commit ids match the local encoding" : `${p.entries.length - same} of ${p.entries.length} commit ids differ from the local encoding`);
    return { commits, tip: prevCommit!, notes };
  }
}

function modeOf(overlay: GitOverlay, path: string) {
  const m = overlay[path];
  return m === "100755" || m === "120000" ? m : "100644";
}

export class Remotes {
  private configs = new Map<string, RemoteConfig>();
  private states = new Map<string, SyncState>();
  private statuses = new Map<string, RemoteStatus>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private running = new Map<string, Promise<void>>();
  private rerun = new Set<string>();
  private failures = new Map<string, number>();

  constructor(private d: RemoteDeps) {
    d.dc.onCommit((comb) => this.changed(comb));
  }

  list(): RemoteStatus[] {
    return [...this.statuses.values()];
  }

  /** Replace the set of connected combs (the page owns the config, tokens included). */
  async configure(list: RemoteConfig[]): Promise<RemoteStatus[]> {
    const next = new Map(list.map((c) => [c.comb, { ...c }]));
    for (const comb of [...this.configs.keys()]) {
      if (next.has(comb)) continue;
      clearTimeout(this.timers.get(comb));
      this.configs.delete(comb);
      this.statuses.delete(comb);
      this.states.delete(comb);
    }
    for (const [comb, cfg] of next) {
      const prev = this.configs.get(comb);
      this.configs.set(comb, cfg);
      if (!prev || keyOf(prev) !== keyOf(cfg)) {
        this.statuses.set(comb, this.blank(cfg));
        this.event(comb, `connected to ${cfg.url} (${cfg.branch}, ${cfg.transport === "github" ? "GitHub API" : "git smart HTTP"})`);
      }
      if (!prev || keyOf(prev) !== keyOf(cfg) || prev.token !== cfg.token || prev.corsProxy !== cfg.corsProxy || prev.username !== cfg.username) {
        this.failures.delete(comb);
        this.schedule(comb, 0);
      }
    }
    this.publish();
    return this.list();
  }

  /** A new history entry landed on `comb`. */
  changed(comb: string) {
    const cfg = this.configs.get(comb);
    if (!cfg) return;
    const st = this.states.get(comb);
    if (st) this.patch(comb, { ahead: this.pending(this.d.dc.log(comb), st).length });
    if (cfg.auto !== false) this.schedule(comb, 1200);
    this.publish();
  }

  /** Sync now (also what the timer runs). Concurrent calls coalesce into one rerun. */
  sync(comb: string): Promise<void> {
    const running = this.running.get(comb);
    if (running) {
      this.rerun.add(comb);
      return running;
    }
    clearTimeout(this.timers.get(comb));
    const p = this.syncOnce(comb)
      .then(
        () => void this.failures.delete(comb),
        (e) => this.failed(comb, e),
      )
      .finally(() => {
        this.running.delete(comb);
        this.publish();
        if (this.rerun.delete(comb)) this.schedule(comb, 0);
      });
    this.running.set(comb, p);
    return p;
  }

  /** Settle a divergence: keep ours (merge with their tip as a parent) or take theirs (a pull entry, merged). */
  async resolve(comb: string, choice: "mine" | "theirs"): Promise<void> {
    const cfg = this.need(comb);
    const st = await this.state(comb, cfg);
    const remote = st.diverged;
    if (!remote) throw new Error(`${comb} is not diverged`);
    if (choice === "theirs" && (this.d.busy() || this.d.dc.status(comb).length)) throw new Error("wait for the agent to finish before taking theirs");
    if (choice === "theirs") await this.pull(comb, this.transport(cfg), st, remote, true);
    st.mergeParents = [remote];
    await this.save(comb, st);
    this.event(
      comb,
      choice === "mine"
        ? `keeping ours: the next push is a merge with ${short(remote)} whose tree is ours (theirs stays in git history)`
        : `took theirs (${short(remote)}) as a pull entry; the next push merges our unpushed entries under it`,
    );
    await this.sync(comb);
  }

  // ---------- internals ----------

  private need(comb: string) {
    const cfg = this.configs.get(comb);
    if (!cfg) throw new Error(`${comb} has no git remote`);
    return cfg;
  }

  private transport(cfg: RemoteConfig): Transport {
    return cfg.transport === "github" ? new GitHubTransport(cfg, this.d.dc, this.d.fetch) : new SmartHttpTransport(cfg, this.d.dc, this.d.fetch);
  }

  private schedule(comb: string, delay: number) {
    clearTimeout(this.timers.get(comb));
    this.timers.set(
      comb,
      setTimeout(() => {
        this.timers.delete(comb);
        void this.sync(comb);
      }, delay),
    );
  }

  /** Entries not on the remote yet, oldest first. A remote that has nothing starts at the first entry with files. */
  private pending(log: HistoryEntry[], st: SyncState): HistoryEntry[] {
    const idx = st.last ? log.findIndex((e) => e.id === st.last!.entry) : -1;
    let list = (idx >= 0 ? log.slice(0, idx) : log).slice().reverse();
    if (idx < 0) {
      const empty = log[log.length - 1]?.tree; // genesis has the empty tree
      const first = list.findIndex((e) => e.tree !== empty);
      list = first < 0 ? [] : list.slice(first);
    }
    return list;
  }

  private async syncOnce(comb: string) {
    const cfg = this.configs.get(comb);
    if (!cfg) return;
    if (!this.d.dc.hasComb(comb)) throw new Error(`there is no comb ${comb}`);
    await this.ensureToken(comb, cfg);
    const t = this.transport(cfg);
    const st = await this.state(comb, cfg);
    this.patch(comb, { state: "syncing", error: null, label: t.label, web: t.web });
    this.publish();
    const remote = await t.head();
    let pending = this.pending(this.d.dc.log(comb), st);
    const known = st.last?.commit ?? null;
    if (st.mergeParents.length && st.mergeParents[0] !== remote) st.mergeParents = []; // they moved again

    if (remote === known || (remote !== null && st.mergeParents[0] === remote)) {
      if (pending.length) await this.push(comb, cfg, t, st, pending, remote);
    } else if (remote === null) {
      this.event(comb, `${cfg.branch} is not on the remote any more; publishing the comb's history again`);
      st.last = null;
      pending = this.pending(this.d.dc.log(comb), st);
      if (pending.length) await this.push(comb, cfg, t, st, pending, null);
    } else if (pending.length === 0) {
      if (!(await this.pull(comb, t, st, remote, false))) return;
    } else {
      st.diverged = remote;
      await this.save(comb, st);
      this.patch(comb, {
        state: "diverged",
        diverged: remote,
        remoteHead: remote,
        ahead: pending.length,
        error: `${cfg.branch} moved to ${short(remote)} on the remote while this comb has ${pending.length} entr${pending.length === 1 ? "y" : "ies"} it doesn't. Nothing merges on its own: keep yours or take theirs.`,
      });
      this.event(comb, `diverged: remote at ${short(remote)}, ${pending.length} local entr${pending.length === 1 ? "y" : "ies"} unpushed`);
      return;
    }
    st.diverged = null;
    await this.save(comb, st);
    this.patch(comb, {
      state: "synced",
      diverged: null,
      error: null,
      lastSync: Date.now(),
      remoteHead: st.last?.commit ?? remote,
      ahead: this.pending(this.d.dc.log(comb), st).length,
      pushed: { ...st.commits },
    });
  }

  private async push(comb: string, cfg: RemoteConfig, t: Transport, st: SyncState, pending: HistoryEntry[], old: string | null) {
    const committer = { name: cfg.committerName || this.d.node, email: cfg.committerEmail || `${this.d.node}@gfs.invalid` };
    const baseTree = st.last ? this.d.dc.gitEntryTree(st.last.entry, st.overlay) : null;
    const haveTrees = baseTree ? [baseTree] : [];
    for (const m of st.mergeParents) if (this.d.dc.gitHas(m)) haveTrees.push(this.d.dc.gitCommitInfo(m).tree);
    const r = await t.push({
      ref: `refs/heads/${cfg.branch}`,
      branch: cfg.branch,
      base: st.last?.commit ?? null,
      baseEntry: st.last?.entry ?? null,
      baseTree,
      entries: pending.map((e) => e.id),
      mergeParents: st.mergeParents,
      old,
      haveTrees,
      overlay: st.overlay,
      encode: (id, parents) => this.d.dc.gitEncodeEntry(id, parents, committer, st.overlay),
    });
    Object.assign(st.commits, r.commits);
    const merged = st.mergeParents.length ? ` (merging ${short(st.mergeParents[0])})` : "";
    st.last = { entry: pending[pending.length - 1].id, commit: r.tip };
    st.mergeParents = [];
    await this.save(comb, st);
    this.event(comb, `pushed ${pending.length} entr${pending.length === 1 ? "y" : "ies"} → ${short(r.tip)}${merged}${r.notes.length ? ` · ${r.notes.join(" · ")}` : ""}`);
  }

  /** Take the remote's tree as a `pull` entry. False when it has to wait (comb busy). */
  private async pull(comb: string, t: Transport, st: SyncState, remote: string, merge: boolean): Promise<boolean> {
    if (!merge && (this.d.busy() || this.d.dc.status(comb).length)) {
      this.patch(comb, { state: "waiting", remoteHead: remote, error: null });
      this.event(comb, `remote moved to ${short(remote)}; pulling once the comb is idle`);
      this.schedule(comb, 3000);
      return false;
    }
    const tree = await t.fetchTree(remote);
    const overlay = this.d.dc.gitCheckout(comb, tree, true);
    let id: string | null;
    try {
      id = await this.d.commit(comb, { kind: "pull", remote: t.label, commit: remote }, this.d.author());
    } catch (e) {
      this.d.dc.resetWorking(comb);
      throw e;
    }
    st.overlay = overlay;
    const entry = id ?? this.d.dc.head(comb);
    if (!merge) {
      st.last = { entry, commit: remote };
      st.commits[entry] = remote;
    }
    await this.save(comb, st);
    this.event(comb, id ? `pulled ${short(remote)} as entry ${short(id)}` : `the remote's ${short(remote)} has this comb's tree; nothing to pull`);
    return true;
  }

  private async ensureToken(comb: string, cfg: RemoteConfig) {
    const o = cfg.oauth;
    if (!o?.refreshToken || !o.expiresAt || Date.now() < o.expiresAt - 60_000) return;
    const t = await refreshToken(this.d.fetch, o.tokenUrl, o.clientId, o.refreshToken);
    const patch: Partial<RemoteConfig> = {
      token: t.access_token,
      oauth: { ...o, refreshToken: t.refresh_token ?? o.refreshToken, expiresAt: t.expires_in ? Date.now() + t.expires_in * 1000 : undefined },
    };
    Object.assign(cfg, patch);
    this.d.onAuth(comb, patch);
    this.event(comb, "access token refreshed");
  }

  private failed(comb: string, e: any) {
    const n = (this.failures.get(comb) ?? 0) + 1;
    this.failures.set(comb, n);
    const auth = (e instanceof GitHttpError || e instanceof GitHubError) && e.auth;
    const retry = auth ? null : Math.min(5000 * 2 ** (n - 1), 300_000);
    const msg = String(e?.message ?? e);
    this.patch(comb, { state: auth ? "auth" : "error", error: msg + (retry ? ` (retrying in ${Math.round(retry / 1000)} s)` : "") });
    this.event(comb, `${auth ? "sign-in needed" : "error"}: ${msg}`);
    if (retry && this.configs.has(comb)) this.schedule(comb, retry);
  }

  private async state(comb: string, cfg: RemoteConfig): Promise<SyncState> {
    const key = keyOf(cfg);
    const cached = this.states.get(comb);
    if (cached && cached.key === key) return cached;
    let st: SyncState | null = null;
    try {
      const raw = await this.d.dc.readMeta(`git/${comb}`);
      st = raw ? JSON.parse(raw) : null;
    } catch {}
    const fresh: SyncState = { key, commits: {}, last: null, overlay: {}, mergeParents: [], diverged: null };
    if (!st || st.key !== key) st = fresh;
    if (st.last) {
      try {
        this.d.dc.entry(st.last.entry);
      } catch {
        st = fresh; // the comb was wiped since
      }
    }
    this.states.set(comb, st);
    this.patch(comb, { pushed: { ...st.commits } });
    return st;
  }

  private async save(comb: string, st: SyncState) {
    await this.d.dc.writeMeta(`git/${comb}`, JSON.stringify(st));
  }

  private blank(cfg: RemoteConfig): RemoteStatus {
    return { comb: cfg.comb, transport: cfg.transport, url: cfg.url, branch: cfg.branch, label: cfg.url, state: "connecting", ahead: 0, remoteHead: null, diverged: null, lastSync: null, error: null, events: [], pushed: {}, web: webBase(cfg.url) };
  }

  private patch(comb: string, p: Partial<RemoteStatus>) {
    const cfg = this.configs.get(comb);
    if (!cfg) return;
    const s = this.statuses.get(comb) ?? this.blank(cfg);
    this.statuses.set(comb, { ...s, ...p });
  }

  private event(comb: string, text: string) {
    const s = this.statuses.get(comb);
    if (!s) return;
    s.events = [...s.events.slice(-29), { time: Date.now(), text }];
    console.log(`git[${comb}]: ${text}`);
  }

  private publish() {
    this.d.publish(this.list());
  }
}

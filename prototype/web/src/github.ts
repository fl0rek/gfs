// PROTOTYPE. GitHub's REST API as a git transport: the Git Data endpoints
// (blobs, trees, commits, refs). api.github.com answers CORS, so unlike
// github.com's smart HTTP this works from a plain tab with a token.
// Also GitHub Enterprise (`https://host/api/v3`), and the fake in test/fake-github.mjs.

import type { FetchFn } from "./githttp";

export class GitHubError extends Error {
  constructor(message: string, readonly status: number, readonly auth = false) {
    super(message);
  }
}

export interface TreeItem {
  path: string;
  mode: string;
  type: "blob" | "tree" | "commit";
  sha: string | null;
}

export interface Ident {
  name: string;
  email: string;
  date: string; // ISO 8601
}

export function parseGitHubUrl(url: string): { owner: string; repo: string; api: string; web: string } {
  const u = new URL(url);
  const [owner, repo] = u.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "").split("/");
  if (!owner || !repo) throw new Error(`${url}: expected https://github.com/<owner>/<repo>`);
  const api = u.host === "github.com" ? "https://api.github.com" : `${u.origin}/api/v3`;
  return { owner, repo, api, web: `${u.origin}/${owner}/${repo}` };
}

export class GitHubApi {
  readonly owner: string;
  readonly repo: string;
  readonly api: string;
  constructor(url: string, private token: string | undefined, private fetchFn: FetchFn) {
    ({ owner: this.owner, repo: this.repo, api: this.api } = parseGitHubUrl(url));
  }

  private async req<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    let res: Response;
    try {
      res = await this.fetchFn(`${this.api}/repos/${this.owner}/${this.repo}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch (e: any) {
      throw new GitHubError(`${this.api}: request failed (${e?.message ?? e})`, 0);
    }
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {}
    if (!res.ok) {
      const msg = json?.message ?? text.slice(0, 200);
      const auth = res.status === 401 || (res.status === 403 && !/rate limit/i.test(msg)) || (res.status === 404 && !this.token);
      throw new GitHubError(`GitHub ${method} ${path}: ${res.status} ${msg}${auth ? (this.token ? " (token refused or lacks Contents: write)" : " (sign in: this needs a token)") : ""}`, res.status, auth);
    }
    return json as T;
  }

  /** Tip of a branch; `empty` when the repository has no commits at all. */
  async head(branch: string): Promise<{ sha: string | null; empty: boolean }> {
    try {
      const r = await this.req("GET", `/git/ref/heads/${encodeURIComponent(branch)}`);
      return { sha: r.object.sha, empty: false };
    } catch (e: any) {
      if (e instanceof GitHubError && e.status === 409) return { sha: null, empty: true }; // "Git Repository is empty."
      if (e instanceof GitHubError && e.status === 404 && !e.auth) return { sha: null, empty: false };
      throw e;
    }
  }

  async commit(sha: string): Promise<{ tree: string; parents: string[] }> {
    const c = await this.req("GET", `/git/commits/${sha}`);
    return { tree: c.tree.sha, parents: c.parents.map((p: any) => p.sha) };
  }

  /** Every blob and gitlink under a tree. Throws if GitHub truncated the listing. */
  async listTree(sha: string): Promise<TreeItem[]> {
    const t = await this.req("GET", `/git/trees/${sha}?recursive=1`);
    if (t.truncated) throw new GitHubError(`tree ${sha.slice(0, 8)} is too large for the REST API listing; use the git transport`, 0);
    return (t.tree as TreeItem[]).filter((e) => e.type !== "tree");
  }

  async blob(sha: string): Promise<Uint8Array> {
    const b = await this.req("GET", `/git/blobs/${sha}`);
    const bin = atob(String(b.content).replace(/\n/g, ""));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  async createBlob(bytes: Uint8Array): Promise<string> {
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x8000)));
    return (await this.req("POST", `/git/blobs`, { content: btoa(bin), encoding: "base64" })).sha;
  }

  async createTree(baseTree: string | null, items: TreeItem[]): Promise<string> {
    return (await this.req("POST", `/git/trees`, baseTree ? { base_tree: baseTree, tree: items } : { tree: items })).sha;
  }

  async createCommit(c: { message: string; tree: string; parents: string[]; author: Ident; committer: Ident }): Promise<string> {
    return (await this.req("POST", `/git/commits`, c)).sha;
  }

  /** Point a branch at `sha`; fast-forward only unless `force`. Creates the branch when `exists` is false. */
  async setRef(branch: string, sha: string, exists: boolean, force = false): Promise<void> {
    if (exists) await this.req("PATCH", `/git/refs/heads/${encodeURIComponent(branch)}`, { sha, force });
    else await this.req("POST", `/git/refs`, { ref: `refs/heads/${branch}`, sha });
  }

  /**
   * The Git Data API refuses to write into a repository with no commits, so
   * make one through the contents API. Returns its commit id; the first push
   * replaces it (force) when it lands on the same branch.
   */
  async bootstrap(comb: string): Promise<{ sha: string; branch: string }> {
    const r = await this.req("PUT", `/contents/.gfs-bootstrap`, { message: `gfs: bootstrap an empty repository for comb ${comb} (replaced by the first push)`, content: btoa(`${comb}\n`) });
    const repo = await this.req("GET", "");
    return { sha: r.commit.sha, branch: repo.default_branch };
  }
}

/** "Name <email> 1700000000 +0000" → {name, email, date}. */
export function parseIdent(line: string): Ident {
  const m = /^(.*) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(line.trim());
  if (!m) throw new Error(`bad git identity: ${line}`);
  return { name: m[1], email: m[2], date: new Date(Number(m[3]) * 1000).toISOString().replace(/\.000Z$/, "Z") };
}

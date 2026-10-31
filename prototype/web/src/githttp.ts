// PROTOTYPE. Git's smart HTTP protocol (v0, stateless), just enough to push a pack
// and to fetch one commit shallowly. Objects and packs are built in Rust (git.rs);
// this file only speaks pkt-lines over fetch().
//
// From a page, CORS decides whether this works at all: Forgejo/Gitea send CORS on
// these routes when `[repository] ACCESS_CONTROL_ALLOW_ORIGIN` is set; github.com
// never does, so there it needs the egress extension or a CORS proxy.

export type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface GitHttpOptions {
  url: string; // https://host/owner/repo.git
  username?: string;
  token?: string;
  /** isomorphic-git style: `${proxy}/${url without scheme}`. The proxy sees the token. */
  corsProxy?: string;
  fetch: FetchFn;
}

export interface Advertisement {
  refs: Map<string, string>;
  caps: Set<string>;
  symrefs: Map<string, string>;
}

export class GitHttpError extends Error {
  constructor(message: string, readonly status = 0, readonly auth = false) {
    super(message);
  }
}

export const ZERO = "0".repeat(40);
const enc = new TextEncoder();
const dec = new TextDecoder();
const AGENT = "agent=gfs-prototype/0";

function pkt(data: string | Uint8Array): Uint8Array {
  const body = typeof data === "string" ? enc.encode(data) : data;
  const out = new Uint8Array(body.length + 4);
  out.set(enc.encode((body.length + 4).toString(16).padStart(4, "0")));
  out.set(body, 4);
  return out;
}
const FLUSH = enc.encode("0000");

function concat(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** pkt-lines from `buf`; `data` is null for a flush (and delim/response-end). */
function* pktLines(buf: Uint8Array): Generator<{ data: Uint8Array | null; end: number }> {
  let i = 0;
  while (i + 4 <= buf.length) {
    const n = parseInt(dec.decode(buf.subarray(i, i + 4)), 16);
    if (Number.isNaN(n)) throw new GitHttpError(`bad pkt-line at ${i}: ${JSON.stringify(dec.decode(buf.subarray(i, i + 20)))}`);
    if (n < 4) {
      i += 4;
      yield { data: null, end: i };
      continue;
    }
    const data = buf.subarray(i + 4, i + n);
    i += n;
    yield { data, end: i };
  }
}

function b64utf8(s: string) {
  const b = enc.encode(s);
  let bin = "";
  for (const c of b) bin += String.fromCharCode(c);
  return btoa(bin);
}

export class GitHttp {
  constructor(private o: GitHttpOptions) {}

  private endpoint(path: string) {
    const u = this.o.url.replace(/\/+$/, "") + path;
    if (!this.o.corsProxy) return u;
    return `${this.o.corsProxy.replace(/\/+$/, "")}/${u.replace(/^https?:\/\//, "")}`;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = { ...extra };
    if (this.o.token) h.Authorization = `Basic ${b64utf8(`${this.o.username || "gfs"}:${this.o.token}`)}`;
    return h;
  }

  private async request(path: string, init: RequestInit, expectType: string): Promise<Uint8Array> {
    let res: Response;
    try {
      res = await this.o.fetch(this.endpoint(path), init);
    } catch (e: any) {
      throw new GitHttpError(
        `${this.o.url}: request refused (${e?.message ?? e}). A page can only reach a git server that sends CORS headers: on Forgejo set [repository] ACCESS_CONTROL_ALLOW_ORIGIN; for github.com install the egress extension or set a CORS proxy.`,
      );
    }
    if (res.status === 401 || res.status === 403) {
      const text = (await res.text().catch(() => "")).slice(0, 200);
      throw new GitHttpError(`${this.o.url}: ${res.status} ${res.statusText}${this.o.token ? " (token refused or lacks write access)" : " (sign in: this needs a token)"}${text ? `: ${text}` : ""}`, res.status, true);
    }
    if (res.status === 404) throw new GitHttpError(`${this.o.url}: repository not found (or not visible with this token)`, 404, !this.o.token);
    if (!res.ok) throw new GitHttpError(`${this.o.url}: ${res.status} ${res.statusText}: ${(await res.text().catch(() => "")).slice(0, 300)}`, res.status);
    const type = res.headers.get("content-type") ?? "";
    if (!type.startsWith(expectType)) throw new GitHttpError(`${this.o.url}: not a smart git HTTP server (content-type ${type || "none"}, wanted ${expectType})`, res.status);
    return new Uint8Array(await res.arrayBuffer());
  }

  async advertise(service: "git-upload-pack" | "git-receive-pack"): Promise<Advertisement> {
    const body = await this.request(`/info/refs?service=${service}`, { method: "GET", headers: this.headers() }, `application/x-${service}-advertisement`);
    const adv: Advertisement = { refs: new Map(), caps: new Set(), symrefs: new Map() };
    let first = true;
    for (const { data } of pktLines(body)) {
      if (!data) continue;
      let line = dec.decode(data).replace(/\n$/, "");
      if (line.startsWith("# service=")) continue;
      if (first) {
        const nul = line.indexOf("\0");
        if (nul >= 0) {
          for (const c of line.slice(nul + 1).split(" ")) {
            if (!c) continue;
            adv.caps.add(c.split("=")[0]);
            if (c.startsWith("symref=")) {
              const [from, to] = c.slice(7).split(":");
              adv.symrefs.set(from, to);
            }
          }
          line = line.slice(0, nul);
        }
        first = false;
      }
      const [oid, ref] = line.split(" ");
      if (ref && ref !== "capabilities^{}") adv.refs.set(ref, oid);
    }
    return adv;
  }

  /** Update one ref with a pack. Throws on any rejection, with the server's reason. */
  async push(ref: string, oldOid: string, newOid: string, pack: Uint8Array): Promise<string[]> {
    const adv = await this.advertise("git-receive-pack");
    const caps = ["report-status", ...(adv.caps.has("side-band-64k") ? ["side-band-64k"] : []), AGENT];
    const body = concat([pkt(`${oldOid} ${newOid} ${ref}\0${caps.join(" ")}\n`), FLUSH, pack]);
    const res = await this.request(
      "/git-receive-pack",
      { method: "POST", headers: this.headers({ "Content-Type": "application/x-git-receive-pack-request", Accept: "application/x-git-receive-pack-result" }), body },
      "application/x-git-receive-pack-result",
    );
    const progress: string[] = [];
    let report = res;
    if (caps.includes("side-band-64k")) {
      const parts: Uint8Array[] = [];
      for (const { data } of pktLines(res)) {
        if (!data) continue;
        if (data[0] === 1) parts.push(data.subarray(1));
        else if (data[0] === 2) progress.push(dec.decode(data.subarray(1)).trim());
        else if (data[0] === 3) throw new GitHttpError(`push refused: ${dec.decode(data.subarray(1)).trim()}`);
      }
      report = concat(parts);
    }
    for (const { data } of pktLines(report)) {
      if (!data) continue;
      const line = dec.decode(data).trim();
      if (line.startsWith("unpack ") && line !== "unpack ok") throw new GitHttpError(`push refused: ${line}`);
      if (line.startsWith("ng ")) throw new GitHttpError(`push refused: ${line.slice(3)}`);
    }
    return progress.filter(Boolean);
  }

  /** A pack holding `want` and its tree, without history (deepen 1 when the server can). */
  async fetchShallow(want: string): Promise<Uint8Array> {
    const adv = await this.advertise("git-upload-pack");
    const sideband = adv.caps.has("side-band-64k") ? "side-band-64k" : adv.caps.has("side-band") ? "side-band" : null;
    const caps = [sideband, adv.caps.has("ofs-delta") ? "ofs-delta" : null, adv.caps.has("no-progress") ? "no-progress" : null, adv.caps.has("shallow") ? "shallow" : null, AGENT].filter(Boolean);
    const parts = [pkt(`want ${want} ${caps.join(" ")}\n`)];
    if (adv.caps.has("shallow")) parts.push(pkt("deepen 1\n"));
    parts.push(FLUSH, pkt("done\n"));
    const res = await this.request(
      "/git-upload-pack",
      { method: "POST", headers: this.headers({ "Content-Type": "application/x-git-upload-pack-request", Accept: "application/x-git-upload-pack-result" }), body: concat(parts) },
      "application/x-git-upload-pack-result",
    );
    const pack: Uint8Array[] = [];
    let inPack = false;
    for (const { data, end } of pktLines(res)) {
      if (!data) {
        if (inPack) break;
        continue;
      }
      if (!inPack) {
        const text = dec.decode(data.subarray(0, Math.min(data.length, 64)));
        if (text.startsWith("shallow ") || text.startsWith("unshallow ")) continue;
        if (text.startsWith("ERR ")) throw new GitHttpError(`fetch refused: ${text.slice(4).trim()}`);
        if (text.startsWith("NAK") || text.startsWith("ACK")) {
          inPack = true;
          if (!sideband) return res.subarray(end); // the rest is the raw pack
          continue;
        }
        if (!sideband || data[0] > 3) throw new GitHttpError(`fetch: unexpected ${JSON.stringify(text)}`);
        inPack = true;
      }
      if (data[0] === 1) pack.push(data.subarray(1));
      else if (data[0] === 3) throw new GitHttpError(`fetch refused: ${dec.decode(data.subarray(1)).trim()}`);
    }
    return concat(pack);
  }
}

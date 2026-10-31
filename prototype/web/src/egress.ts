// PROTOTYPE. Network egress from the worker.
//
// A page can only fetch what CORS allows. The extension in prototype/extension/
// relays fetches with host permissions; the page forwards our requests to it over
// window.postMessage and streams the response back here. `smartFetch` tries a
// direct fetch first and falls back to the bridge when that is refused.

export type BridgeEvent =
  | { event: "headers"; status: number; statusText: string; headers: Record<string, string>; url: string }
  | { event: "chunk"; data: string }
  | { event: "end" }
  | { event: "error"; message: string };

export interface BridgeRequest {
  url: string;
  init: { method: string; headers: Record<string, string>; body?: string; bodyBase64?: string };
}

let bridgeAvailable = false;
let nextId = 1;
const inflight = new Map<number, (e: BridgeEvent) => void>();
let send: (id: number, req: BridgeRequest | null) => void = () => {};

/** The worker's host (worker.ts) wires these to its postMessage channel. */
export function installBridge(opts: { send: typeof send }) {
  send = opts.send;
}
export function setBridgeAvailable(v: boolean) {
  bridgeAvailable = v;
}
export function isBridgeAvailable() {
  return bridgeAvailable;
}
export function onBridgeEvent(id: number, e: BridgeEvent) {
  inflight.get(id)?.(e);
}

function fromBase64(b64: string) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
function toBase64(bytes: Uint8Array) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x8000)));
  return btoa(s);
}

export async function bridgeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  if (!bridgeAvailable) throw new TypeError("egress bridge not available");
  const req = input instanceof Request ? input : new Request(input, init);
  const headers: Record<string, string> = {};
  req.headers.forEach((v, k) => (headers[k] = v));
  const bodyBytes = req.method !== "GET" && req.method !== "HEAD" ? new Uint8Array(await req.clone().arrayBuffer()) : null;
  const id = nextId++;
  const signal = init?.signal ?? req.signal;

  return new Promise<Response>((resolve, reject) => {
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    let settled = false;
    const stream = new ReadableStream<Uint8Array>({
      start: (c) => (controller = c),
      cancel: () => send(id, null),
    });
    const fail = (msg: string) => {
      inflight.delete(id);
      if (!settled) {
        settled = true;
        reject(new TypeError(`bridge: ${msg}`));
      } else {
        try {
          controller?.error(new Error(msg));
        } catch {}
      }
    };
    signal?.addEventListener("abort", () => {
      send(id, null);
      fail("aborted");
    });
    inflight.set(id, (e) => {
      switch (e.event) {
        case "headers": {
          settled = true;
          const h = new Headers(e.headers);
          // The fetch spec forbids setting these on a synthetic Response; drop them.
          h.delete("content-encoding");
          h.delete("content-length");
          resolve(new Response(stream, { status: e.status, statusText: e.statusText, headers: h }));
          break;
        }
        case "chunk":
          controller?.enqueue(fromBase64(e.data));
          break;
        case "end":
          inflight.delete(id);
          try {
            controller?.close();
          } catch {}
          break;
        case "error":
          fail(e.message);
          break;
      }
    });
    send(id, { url: req.url, init: { method: req.method, headers, bodyBase64: bodyBytes ? toBase64(bodyBytes) : undefined } });
  });
}

/** Direct when allowed, bridged when CORS says no. */
export async function smartFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const req = input instanceof Request ? input.clone() : null;
  try {
    return await fetch(input, init);
  } catch (e) {
    // Network-level failure (CORS, DNS, blocked): TypeError. Anything else is real.
    if (!(e instanceof TypeError) || !bridgeAvailable) throw e;
    return bridgeFetch(req ?? input, init);
  }
}

export function egressMode(): "direct+extension" | "direct" {
  return bridgeAvailable ? "direct+extension" : "direct";
}

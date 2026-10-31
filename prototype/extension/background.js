// PROTOTYPE. Background: performs the fetch with the extension's host permissions and streams it back.
const api = typeof browser !== "undefined" ? browser : chrome;

function toBase64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function fromBase64(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

api.runtime.onConnect.addListener((port) => {
  if (port.name !== "gfs-fetch") return;
  const controller = new AbortController();
  port.onDisconnect.addListener(() => controller.abort());
  port.onMessage.addListener(async ({ url, init }) => {
    try {
      const headers = new Headers(init?.headers ?? {});
      // The page cannot set these itself; the extension can.
      headers.delete("origin");
      const body = init?.bodyBase64 != null ? fromBase64(init.bodyBase64) : init?.body;
      const res = await fetch(url, { method: init?.method ?? "GET", headers, body, redirect: "follow", signal: controller.signal });
      const resHeaders = {};
      res.headers.forEach((v, k) => (resHeaders[k] = v));
      port.postMessage({ event: "headers", status: res.status, statusText: res.statusText, headers: resHeaders, url: res.url });
      const reader = res.body?.getReader();
      if (reader) {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          port.postMessage({ event: "chunk", data: toBase64(value) });
        }
      }
      port.postMessage({ event: "end" });
    } catch (e) {
      try {
        port.postMessage({ event: "error", message: String(e?.message ?? e) });
      } catch {}
    }
  });
});

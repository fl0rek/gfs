// PROTOTYPE. Content script: relays fetch requests between the page and the background script.
// Page → window.postMessage({ source: "gfs-bridge", type: "fetch", id, url, init })
// Page ← window.postMessage({ source: "gfs-bridge-ext", id, event: "headers"|"chunk"|"end"|"error", ... })
(() => {
  const api = typeof browser !== "undefined" ? browser : chrome;
  const ports = new Map();

  const announce = () => window.postMessage({ source: "gfs-bridge-ext", event: "hello", version: api.runtime.getManifest().version }, "*");
  announce();

  window.addEventListener("message", (ev) => {
    if (ev.source !== window || !ev.data || ev.data.source !== "gfs-bridge") return;
    const msg = ev.data;
    if (msg.type === "ping") return announce();
    if (msg.type === "abort") {
      ports.get(msg.id)?.disconnect();
      ports.delete(msg.id);
      return;
    }
    if (msg.type !== "fetch") return;
    const port = api.runtime.connect({ name: "gfs-fetch" });
    ports.set(msg.id, port);
    port.onMessage.addListener((m) => {
      window.postMessage({ source: "gfs-bridge-ext", id: msg.id, ...m }, "*");
      if (m.event === "end" || m.event === "error") {
        ports.delete(msg.id);
        port.disconnect();
      }
    });
    port.onDisconnect.addListener(() => {
      if (ports.has(msg.id)) {
        ports.delete(msg.id);
        window.postMessage({ source: "gfs-bridge-ext", id: msg.id, event: "error", message: "bridge disconnected" }, "*");
      }
    });
    port.postMessage({ url: msg.url, init: msg.init });
  });
})();

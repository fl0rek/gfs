# Egress bridge extension (prototype)

A page can only `fetch` what CORS allows. This WebExtension lets the pi-on-gfs page fetch any URL: a content script on the page's origin relays requests to a background script that has host permissions, and streams the response back.

Load it unpacked: Chrome → `chrome://extensions` → Developer mode → "Load unpacked" → this folder. Firefox → `about:debugging#/runtime/this-firefox` → "Load Temporary Add-on" → `manifest.json`. The page header then shows `egress: extension`, and both pi's `fetch` tool and its LLM calls fall back to the extension whenever a direct fetch is refused.

What it cannot do: TCP. There is no socket API for extensions, so bash's `curl` still has no network; that needs a relay (ruled out for now) or native.

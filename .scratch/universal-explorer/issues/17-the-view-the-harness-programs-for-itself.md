# The view the harness programs for itself

Type: prototype
Status: resolved
Blocked by: 05

## Question

Beside the harness's chat there is a second surface you switch to. Its contents are entirely programmed by the harness, from a comb (the user named `/datacombs/nix`), so the harness can iterate on its own view and every change lands as a history entry. The first thing it shows is an introspection dashboard: what `/machine` was built from, what `/proc` reports, the process tree.

What should that view be, and how should it behave? Build rough versions to react to. Sub-questions the prototype has to take a stance on:

- **Medium.** What the comb produces and the host renders: HTML in a browser tab or native webview, a TUI in a terminal pane, or a wasm program with a framebuffer. Must pass the "works in the browser too" check natively and in the browser.
- **Loop.** How a change in the comb becomes the live view: rebuild on each history entry, hot reload, the harness pointing at a `<comb>@<hash>`. Related: [What a data comb's flake exposes](14-what-a-data-combs-flake-exposes.md), if the view is a flake output; this prototype informs that ticket rather than waiting on it (standing preference: interfaces emerge from use).
- **What `/proc` is.** We own syscalls ([Guest architecture and platform matrix](05-guest-architecture-and-platform-matrix.md)), so `/proc` is whatever the runtime synthesizes. Does the view read introspection through gfs paths, or through a dedicated runtime API? Which facts are worth exposing first (processes, open files, comb grants, cache usage)?
- **Control.** Who switches views: only the user, or can the harness bring its view to the front? Does the view get input back (buttons that send a message to the harness), or is it display-only at first?
- **Boundary.** Whether the view runs inside the harness's wasm world or on the host side, and what that means for [Where the sandbox boundary sits](12-where-the-sandbox-boundary-sits.md).

## Prototype

Three variants, switchable with the floating bar: [harness-view-prototype.html on `prototype/harness-view`](https://github.com/fl0rek/gfs/blob/prototype/harness-view/.scratch/universal-explorer/prototypes/harness-view-prototype.html) (published copy: https://claude.ai/artifact/CZeWGihfm1zceZkgvQzrj2).

- **A, Panels**: a Chat/View surface switch, stat tiles, process tree, `/machine` and `/proc` panels, and an input that sends a change request to the harness.
- **B, Document and source**: the view as one monospace document with its source (the file in the comb that produced it) shown beside it.
- **C, History rail**: the `nix` comb's history entries as the primary axis; pick an entry to preview the view as it was, roll back by appending.

## Decided so far (2026-10-26)

- **Medium**: HTML, rendered by the host (browser tab natively a webview). Works in both hosts.
- **Loop**: the host renders the build output of the `nix` comb's checkout and re-renders on every history entry to that comb. Commit rules apply unchanged, so each self-edit of the view is auditable and can be rolled back.

## Answer

Variant **A (Panels)** wins. B is out: the view is not pretending to be a terminal.

- **Medium**: HTML, rendered by the host (browser tab natively a webview). No TUI.
- **Where it is programmed**: the `nix` comb (`/datacombs/nix`). The view is a build output of that comb's checkout.
- **Loop**: every history entry on the `nix` comb re-renders the view. Commit rules are unchanged, so each self-edit is a history entry with author, harness, model and principal, and can be rolled back like any other.
- **Control**: the user switches surfaces (Chat and View). The harness only controls what is displayed inside the view; it cannot bring the view to the front. The view can send input back to the harness as a chat message (the input in A).
- **First content**: an introspection dashboard: `/machine` provenance, what `/proc` reports, the process tree, cache usage, mounts and grants.
- **Built into the live prototype** (2026-10-26): the `prototype/pi-on-gfs` branch, deployed at https://fl0rek.github.io/gfs/. The header has a console | view switch; the view is `/nix/view/index.html`, rendered in a sandboxed iframe with `window.ue` (a `/machine` snapshot, `prompt(text)`, `onUpdate`) and re-rendered on every `/nix` history entry. Seeded with the introspection dashboard. The three-variant mock on `prototype/harness-view` was the design reference for it.
- **Open, ticketed**: what the runtime exposes for introspection and through which channel, see [What the runtime exposes to the view](18-what-the-runtime-exposes-to-the-view.md). Where the view's build runs relative to the sandbox stays with [Where the sandbox boundary sits](12-where-the-sandbox-boundary-sits.md).

# The view the harness programs for itself

Type: prototype
Status: claimed
Blocked by: 05

## Question

Beside the harness's chat there is a second surface you switch to. Its contents are entirely programmed by the harness, from a comb (the user named `/datacombs/nix`), so the harness can iterate on its own view and every change lands as a history entry. The first thing it shows is an introspection dashboard: what `/machine` was built from, what `/proc` reports, the process tree.

What should that view be, and how should it behave? Build rough versions to react to. Sub-questions the prototype has to take a stance on:

- **Medium.** What the comb produces and the host renders: HTML in a browser tab or native webview, a TUI in a terminal pane, or a wasm program with a framebuffer. Must pass the "works in the browser too" check natively and in the browser.
- **Loop.** How a change in the comb becomes the live view: rebuild on each history entry, hot reload, the harness pointing at a `<comb>@<hash>`. Related: [What a data comb's flake exposes](14-what-a-data-combs-flake-exposes.md), if the view is a flake output; this prototype informs that ticket rather than waiting on it (standing preference: interfaces emerge from use).
- **What `/proc` is.** We own syscalls ([Guest architecture and platform matrix](05-guest-architecture-and-platform-matrix.md)), so `/proc` is whatever the runtime synthesizes. Does the view read introspection through gfs paths, or through a dedicated runtime API? Which facts are worth exposing first (processes, open files, comb grants, cache usage)?
- **Control.** Who switches views: only the user, or can the harness bring its view to the front? Does the view get input back (buttons that send a message to the harness), or is it display-only at first?
- **Boundary.** Whether the view runs inside the harness's wasm world or on the host side, and what that means for [Where the sandbox boundary sits](12-where-the-sandbox-boundary-sits.md).

# A WayQuest view of every project in datacombs

Type: prototype
Status: claimed
Blocked by: 17

## Question

Every comb is a project in its own right ([What one datacomb is](06-what-one-datacomb-is.md): a top-level directory with its own history, and a full flake). Some of those projects are planned with wayfinder, so their map and tickets live inside the comb under `.scratch/<effort>/`. [WayQuest](https://github.com/fl0rek/wayquest) renders one wayfinder effort as a fantasy overworld. The user asked (2026-10-31) for a new view beside the introspection one: WayQuest, tracking every project in datacombs.

Build a rough version to react to. The prototype has to take a stance on:

- **More than one view.** [The view the harness programs for itself](17-the-view-the-harness-programs-for-itself.md) settled on one surface built from the `nix` comb. How do several views sit side by side, and who adds one?
- **What a view may read.** This one needs comb contents and history, not just `/machine`. Through gfs paths answered by the host, or a snapshot pushed in? This informs [What the runtime exposes to the view](18-what-the-runtime-exposes-to-the-view.md) rather than waiting on it.
- **What a project is.** Every comb, or only combs that carry a wayfinder map? What shows for the rest?
- **What "tracks" means.** Per project, at a glance: the frontier, what is under way, what needs you, and the fog. Plus what changed recently, attributed to the session that changed it (history entries already carry that).
- **Where WayQuest's logic runs.** Reuse WayQuest's own tracker reading, sensing, layout and roads, or redo them in the page.

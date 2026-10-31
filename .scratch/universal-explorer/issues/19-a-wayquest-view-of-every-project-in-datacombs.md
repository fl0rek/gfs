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

## Prototype

Built 2026-10-31 on top of the live prototype, on branch `wayquest-gfs` (`main` with `prototype/pi-on-gfs` merged in). It deploys nothing; run it with `nix run github:fl0rek/gfs/wayquest-gfs` (see `prototype/README.md`). In the app it is the **wayquest** tab beside console and view.

- Standalone copy to react to on a phone: https://claude.ai/artifact/Sg4HN6bA2iQ91rLNqDRUEp. It is the same page over a snapshot of a node whose datacombs hold this repo and fl0rek/wayquest, with one history entry per commit that touched their maps (session and model from the commit trailers).
- The page: `prototype/web/src/views/wayquest/index.html`, seeded once into `/nix/view/wayquest/`. WayQuest's side: `crates/wasm` in fl0rek/wayquest.

Stances it takes:

- **More than one view.** Every `/nix/view/<name>/index.html` is a view with its own tab in the header. The user switches; the harness adds a view by writing one. The first view still re-renders on every `/nix` entry; the others re-render when an entry touches their own directory.
- **What a view may read.** Read-only gfs paths, answered by the host: `ue.combs`, `ue.list(dir)`, `ue.read(path)`, `ue.bytes(path)`, `ue.log(comb)`. Same addressing as the harness, so `/datacombs/<comb>@<entry>/…` is the past. `ue.onHistory(fn)` fires on any comb's new entry, and `ue.state` survives re-renders. Views see every comb on the node; there are no grants yet, so a view sees more than a session granted only some combs would.
- **What a project is.** Every comb. A comb with `.scratch/<effort>/map.md` is charted (one comb can hold several maps); the rest are listed as uncharted. Writing into `/datacombs/<new>/…` now creates a comb. [What one datacomb is](06-what-one-datacomb-is.md) decided sessions can create combs, but the prototype had only `workspace`, `session` and `nix`.
- **What "tracks" means.** The atlas has totals, a "Needs you" list of WayQuest's beacons across every project, and one card per map: cleared out of total, needs you, under way, frontier, fog, and the comb's newest entry. Below that is a feed of recent changes across datacombs. Each history entry that touched a map is replayed through WayQuest's change diff ("#16 now held by florek", "#17 resolved") and credited to its session, harness and model. A card opens its overworld, and a ticket opens its text. The view never writes; "ask pi" on a ticket goes through `ue.prompt`.
- **Where WayQuest's logic runs.** WayQuest's own world crate, compiled to wasm (350 KB), sits beside the page in `/nix`. It does the tracker parsing, sensing, layout, roads, terrain and change diffs. The page only reads and draws, using a 2D-canvas port of the Bevy canvas's sprite rules (same Kenney cells, ground quarters, road masks, bridges, trees). The Bevy canvas itself isn't used: it is several MB, mouse-only, and not something the harness can edit.
- The player (whose claims read "your move") defaults to `florek`, WayQuest's interim designated human, and can be changed at the bottom of the atlas.

To react to:

1. An atlas of separate overworlds, one per map, as WayQuest keeps a multi-effort world out of scope. Right, or do you want one world?
2. Uncharted combs: show them, hide the system ones (`nix`, `session`), or leave them out?
3. Should a view see every comb on the node, or only what the session is granted?
4. Is "ask pi" enough as the act from a ticket, or should the view get WayQuest's own acts (claim, comment, resolve)?
5. One header tab per view, or a view picker once there are more?

## Reactions (2026-10-31)

1. **One world.** Every project is a biome in one world, not a separate overworld per map. WayQuest's own map keeps a multi-effort world out of scope; this view takes the other side.
2. **All combs, `nix` included.** Uncharted combs are land in the world too. (Asked what `session` does: it holds pi's transcript, `transcript.json`, committed once per turn as a `turn` entry and read back on reload.)
3. **Views see all combs.**
4. Open. The user asked what acts exist now: only "ask pi", which sends a message through `ue.prompt`; the view itself never writes.
5. **One tab per view**, so three for now: console | view | wayquest.

## Prototype, round 2 (2026-10-31)

Rebuilt on the reactions. Same link for the standalone copy.

- **One world.** Every comb is a region with its own biome (meadow, autumn, desert, snow, bloom, marsh). Regions sit side by side, meet along wandering borders, and the land ends in sea. A biome recolours the green pixels of the same Kenney sheets, and the desert and the snow grow their own plants. Biomes are fixed for the node's own combs (`nix` snow, `session` bloom, `workspace` autumn); other combs get one picked from their name, different from their neighbours' while biomes last.
- **All combs.** A comb with a map is that map's overworld, laid out by WayQuest as before. A comb without one is land (WayQuest's terrain for an empty map, seeded by the comb's name) with a building: a keep for `nix`, houses for `session` and `workspace`. Tapping it shows what the comb is for, its size and its recent entries.
- The atlas is gone. The panel beside the world holds what it had: what needs you across every map, every comb with its progress and newest entry, and the recent changes. Tapping a region, ticket, fog cloud or destination opens it there; breadcrumbs lead back.
- Known limit: places come from the order of comb names, so a new comb can shift the regions after it.

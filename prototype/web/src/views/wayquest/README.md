# /nix/view/wayquest — WayQuest as a view

Every comb in datacombs as one world. Each comb is a region with its own biome (meadow, autumn, desert,
snow, bloom, marsh); the regions meet along wandering borders and the land ends in sea. A comb that
carries a [wayfinder](https://github.com/mattpocock/skills/tree/main/skills/engineering/wayfinder) map
(`.scratch/<effort>/map.md` with tickets in `issues/NN-<slug>.md`) is charted: its region is that map's
[WayQuest](https://github.com/fl0rek/wayquest) overworld, with cleared territory, the frontier, explorers
at work on claimed tickets, monsters (beacons) on tickets that need you, and fog for what is not yet
specified. A comb without a map is land with a building on it (`nix` a keep in the snow, `session` a
house in bloom, `workspace` a house in autumn).

- `index.html`: the view. It reads combs through `window.ue` (read-only, by gfs path) and draws.
- `world.js`, `world_bg.wasm`: WayQuest's world crate (`crates/wasm` in fl0rek/wayquest, built by
  `scripts/build-world-wasm.sh`): tracker parsing, sensing, layout, roads, terrain and change diffs.
  The view does none of that itself; it only places the regions side by side and draws them.
- `sheets/`: Kenney's Roguelike/RPG pack, Tiny Town and Tiny Dungeon (CC0), cut the way WayQuest's
  canvas cuts them. A biome recolours the green pixels (grass, shores, leaves); the desert grows cacti
  and the snow pines from the same sheet.

The panel beside the world: what needs you across every map, every comb with its progress and newest
entry, and recent changes (each history entry that touched a map, replayed through WayQuest's change
diff and credited to the session that made it). Tap a region, a ticket, a fog cloud or a destination.

The player (whose claims read "your move") defaults to `florek`; change it at the bottom of the panel.

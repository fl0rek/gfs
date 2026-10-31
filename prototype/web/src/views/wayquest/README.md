# /nix/view/wayquest — WayQuest as a view

Every project in datacombs, at a glance. A project is a comb; a comb that carries a
[wayfinder](https://github.com/mattpocock/skills/tree/main/skills/engineering/wayfinder) map
(`.scratch/<effort>/map.md` with tickets in `issues/NN-<slug>.md`) is charted, and each map opens as a
[WayQuest](https://github.com/fl0rek/wayquest) overworld: cleared territory, the frontier, explorers at
work on claimed tickets, monsters (beacons) on tickets that need you, and fog for what is not yet specified.
Combs without a map are listed as uncharted.

- `index.html`: the view. It reads combs through `window.ue` (read-only, by gfs path) and draws.
- `world.js`, `world_bg.wasm`: WayQuest's world crate (`crates/wasm` in fl0rek/wayquest, built by
  `scripts/build-world-wasm.sh`): tracker parsing, sensing, layout, roads, terrain and change diffs.
  The view does none of that itself, so its overworlds are WayQuest's.
- `sheets/`: Kenney's Roguelike/RPG pack, Tiny Town and Tiny Dungeon (CC0), cut the way WayQuest's
  canvas cuts them.

What it tracks per project: cleared out of total, what needs you, what is under way and by whom, the
frontier, the fog, and recent changes. Changes come from the comb's history: each entry that touched the
map is replayed through WayQuest's change diff and attributed to the session that made it.

The player (whose claims read "your move") defaults to `florek`; change it at the bottom of the atlas.

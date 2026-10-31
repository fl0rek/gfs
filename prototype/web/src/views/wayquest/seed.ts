// PROTOTYPE. The WayQuest view's files, seeded once into /nix/view/wayquest/. After that they are the comb's:
// pi (or you, in Files) can change any of them, and every change is a history entry like any other.
//
//   index.html       the view: every project in datacombs, and each wayfinder map as an overworld
//   world.js         WayQuest's world crate (fl0rek/wayquest, crates/wasm), wasm-bindgen glue
//   world_bg.wasm    …and the module: tracker parsing, sensing, layout, roads, terrain, change diffs
//   sheets/*.png     Kenney's Roguelike/RPG, Tiny Town and Tiny Dungeon sheets (CC0), as WayQuest uses them
//   README.md        what this is and where it came from

import indexHtml from "./index.html?raw";
import readme from "./README.md?raw";
import worldJs from "./world.js?raw";
import worldWasm from "./world_bg.wasm?url";
import roguelike from "./sheets/roguelike.png?url";
import tinyTown from "./sheets/tiny-town.png?url";
import tinyDungeon from "./sheets/tiny-dungeon.png?url";

export const WAYQUEST_DIR = "view/wayquest";

export async function wayquestSeed(): Promise<[string, Uint8Array | string][]> {
  const bytes = async (url: string) => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  };
  return [
    [`${WAYQUEST_DIR}/README.md`, readme],
    [`${WAYQUEST_DIR}/world.js`, worldJs],
    [`${WAYQUEST_DIR}/world_bg.wasm`, await bytes(worldWasm)],
    [`${WAYQUEST_DIR}/sheets/roguelike.png`, await bytes(roguelike)],
    [`${WAYQUEST_DIR}/sheets/tiny-town.png`, await bytes(tinyTown)],
    [`${WAYQUEST_DIR}/sheets/tiny-dungeon.png`, await bytes(tinyDungeon)],
    [`${WAYQUEST_DIR}/index.html`, indexHtml],
  ];
}

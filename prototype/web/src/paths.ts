// PROTOTYPE. How the harness's paths map onto gfs.
//
// The harness's cwd is `/datacombs/<comb>`. A comb's past is reachable read-only
// at `/datacombs/<comb>@<entry-id>` (see "What one datacomb is").

export const DATACOMBS = "/datacombs";
export const WORKSPACE = "workspace";
export const CWD = `${DATACOMBS}/${WORKSPACE}`;

export interface Resolved {
  comb: string;
  /** Entry id when the path addresses a read-only view of the past. */
  at?: string;
  /** Path inside the comb, no leading slash; "" is the comb root. */
  path: string;
}

export function resolvePath(p: string, cwd = CWD): Resolved {
  const abs = p.startsWith("/") ? p : `${cwd}/${p}`;
  const parts: string[] = [];
  for (const seg of abs.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      parts.pop();
      continue;
    }
    parts.push(seg);
  }
  if (parts[0] !== "datacombs" || parts.length < 2) {
    throw new Error(`${p}: outside gfs (only ${DATACOMBS}/<comb>/... is reachable here)`);
  }
  const combSpec = parts[1];
  const path = parts.slice(2).join("/");
  const atIdx = combSpec.indexOf("@");
  if (atIdx >= 0) {
    return { comb: combSpec.slice(0, atIdx), at: combSpec.slice(atIdx + 1), path };
  }
  return { comb: combSpec, path };
}

export function displayPath(r: Resolved): string {
  const comb = r.at ? `${r.comb}@${r.at.slice(0, 8)}` : r.comb;
  return r.path ? `${DATACOMBS}/${comb}/${r.path}` : `${DATACOMBS}/${comb}`;
}

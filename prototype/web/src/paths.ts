// PROTOTYPE. How the harness's paths map onto gfs.
//
// The root the harness sees:
//   /datacombs/<comb>            a comb's checkout (read-write)
//   /datacombs/<comb>@<entry>    that comb as it was at one history entry (read-only)
//   /nix                         the comb holding the running system's flake; commit = switch
// The harness's cwd is `/datacombs/workspace`.

export const DATACOMBS = "/datacombs";
export const WORKSPACE = "workspace";
export const NIX_COMB = "nix";
export const CWD = `${DATACOMBS}/${WORKSPACE}`;

export interface Resolved {
  kind: "comb";
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
  if (parts[0] === "nix") {
    const [spec, ...rest] = [NIX_COMB, ...parts.slice(1)];
    return { kind: "comb", comb: spec, path: rest.join("/") };
  }
  if (parts[0] !== "datacombs" || parts.length < 2) {
    throw new Error(`${p}: outside gfs (reachable: ${DATACOMBS}/<comb>/... and /nix/...)`);
  }
  const combSpec = parts[1];
  const path = parts.slice(2).join("/");
  const atIdx = combSpec.indexOf("@");
  if (atIdx >= 0) {
    return { kind: "comb", comb: combSpec.slice(0, atIdx), at: combSpec.slice(atIdx + 1), path };
  }
  return { kind: "comb", comb: combSpec, path };
}

export function displayPath(r: Resolved): string {
  if (r.comb === NIX_COMB && !r.at) return r.path ? `/nix/${r.path}` : "/nix";
  const comb = r.at ? `${r.comb}@${r.at.slice(0, 8)}` : r.comb;
  return r.path ? `${DATACOMBS}/${comb}/${r.path}` : `${DATACOMBS}/${comb}`;
}

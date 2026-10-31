// PROTOTYPE. Messages between the page and the agent worker.

export interface Author {
  session: string;
  harness: string;
  model: string;
  principal: string;
}

export interface FileDiff {
  path: string;
  status: "added" | "modified" | "removed";
  old_hash: string | null;
  new_hash: string | null;
}

export interface HistoryEntry {
  id: string;
  comb: string;
  parent: string | null;
  tree: string;
  kind: "genesis" | "tool_call" | "turn" | "external" | "rollback" | "switch" | "pull";
  remote?: string;
  commit?: string;
  at_entry?: string;
  previous?: string | null;
  system?: string;
  tool_call_id?: string;
  turn_id?: string;
  tool_name?: string;
  args_hash?: string | null;
  to_entry?: string;
  author: Author;
  committer: string;
  time: number;
  message: string;
  summary: { added: string[]; modified: string[]; removed: string[] };
}

export interface VerifyReport {
  ok: boolean;
  entries: number;
  objects_checked: number;
  problems: string[];
}

export interface ModelConfig {
  provider: "mock" | "free" | "deepseek" | "opencode" | "openai-compatible";
  model: string;
  apiKey: string;
  baseUrl?: string;
  /** Keys for the free-tier router, per provider (openrouter, google, groq, cerebras, mistral). */
  freeKeys?: Record<string, string>;
}

// Page → worker requests (RPC; every request gets a reply with the same id).
export type Request =
  | { id: number; method: "init"; shell?: string; trace?: boolean }
  | { id: number; method: "configure"; config: ModelConfig }
  | { id: number; method: "prompt"; text: string }
  | { id: number; method: "abort" }
  | { id: number; method: "log"; comb: string }
  | { id: number; method: "entry"; entryId: string }
  | { id: number; method: "fileAt"; entryId: string; path: string }
  | { id: number; method: "treeAt"; entryId: string }
  | { id: number; method: "tree"; comb: string }
  | { id: number; method: "file"; comb: string; path: string }
  | { id: number; method: "args"; hash: string }
  | { id: number; method: "verify"; comb: string }
  | { id: number; method: "rollback"; comb: string; entryId: string }
  | { id: number; method: "transcript" }
  | { id: number; method: "shellWarmup" }
  | { id: number; method: "boot" } // start the system (after init returned)
  | { id: number; method: "shellRun"; command: string; timeoutMs?: number }
  | { id: number; method: "wipe" }
  | { id: number; method: "bridgeAvailable"; available: boolean }
  | { id: number; method: "debugFetch"; url: string }
  | { id: number; method: "debugTool"; name: string; params: unknown }
  | { id: number; method: "saveFile"; comb: string; path: string; content: string } // you, editing outside pi → external entry
  | { id: number; method: "freeStatus" } // the free-tier router's view of its models
  | { id: number; method: "machine" } // snapshot of /machine for the view, plus where the view comes from
  | { id: number; method: "viewRead"; op: ViewReadOp; arg: string } // what a view may read: gfs paths, read-only
  | { id: number; method: "remotesConfigure"; remotes: import("./remotes").RemoteConfig[] } // the page owns remote configs (tokens included)
  | { id: number; method: "remoteSync"; comb: string }
  | { id: number; method: "remoteResolve"; comb: string; choice: "mine" | "theirs" }
  | { id: number; method: "loginDeviceStart"; host: string; clientId: string; scope: string }
  | { id: number; method: "loginDevicePoll"; host: string; clientId: string; deviceCode: string }
  | { id: number; method: "loginToken"; tokenUrl: string; form: Record<string, string> };

/** Page → worker, outside the RPC: a response event from the egress bridge. */
export interface BridgeInbound {
  bridge: true;
  id: number;
  event: import("./egress").BridgeEvent;
}

/**
 * Reads a view may make, all read-only, all by gfs path (`/datacombs/<comb>[@<entry>]/…`, `/nix/…`, `/machine/…`):
 * `combs` (arg ignored) every comb with its head and newest entry; `log` (arg: a comb) its history, newest first;
 * `list` every file under a directory, as `[path relative to it, size]`; `read` a file as text; `bytes` as bytes.
 */
export type ViewReadOp = "combs" | "log" | "list" | "read" | "bytes";

/** One comb, as a view sees it in `ue.combs`. */
export interface CombSummary {
  name: string;
  head: string;
  entries: number;
  files: number;
  bytes: number;
  created: number | null;
  last: Pick<HistoryEntry, "id" | "time" | "kind" | "message" | "tool_name" | "author" | "summary"> | null;
  remote: { label: string; url: string; branch: string; state: string; ahead: number; lastSync: number | null } | null;
}

export interface MachineView {
  machine: Record<string, string>;
  view: { entry: string | null; path: string };
  combs: CombSummary[];
}

export interface EntryDetail {
  entry: HistoryEntry;
  files: FileDiff[];
  diffs: Record<string, string>; // path → unified diff (text files only)
  args: unknown | null; // decoded tool-call arguments, if any
}

export interface InitInfo {
  node: string;
  sessionId: string;
  combs: string[];
  persistence: "opfs" | "memory";
  objectCount: number;
  config: ModelConfig;
  system: { entry: string; name: string } | null;
}

// Worker → page.
export type Notification =
  | { type: "agent"; event: unknown } // slimmed pi-agent-core AgentEvent
  | { type: "history"; comb: string; objectCount: number } // the comb's history changed
  | { type: "status"; text: string; busy?: boolean }
  | { type: "error"; message: string }
  | { type: "bridge"; reqId: number; req: import("./egress").BridgeRequest | null } // null = abort
  | { type: "system"; entry: string; name: string; reason: string } // the running system switched
  | { type: "remotes"; status: import("./remotes").RemoteStatus[] } // git sync state changed
  | { type: "remoteAuth"; comb: string; patch: Partial<import("./remotes").RemoteConfig> }; // a refreshed token to keep

export type Reply = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string };

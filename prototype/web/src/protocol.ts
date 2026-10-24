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
  kind: "genesis" | "tool_call" | "turn" | "external" | "rollback";
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
  provider: "mock" | "deepseek" | "opencode" | "openai-compatible";
  model: string;
  apiKey: string;
  baseUrl?: string;
}

// Page → worker requests (RPC; every request gets a reply with the same id).
export type Request =
  | { id: number; method: "init"; shell?: string }
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
  | { id: number; method: "shellRun"; command: string; timeoutMs?: number }
  | { id: number; method: "wipe" }
  | { id: number; method: "bridgeAvailable"; available: boolean }
  | { id: number; method: "debugFetch"; url: string }
  | { id: number; method: "debugTool"; name: string; params: unknown };

/** Page → worker, outside the RPC: a response event from the egress bridge. */
export interface BridgeInbound {
  bridge: true;
  id: number;
  event: import("./egress").BridgeEvent;
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
  | { type: "system"; entry: string; name: string; reason: string }; // the running system switched

export type Reply = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string };

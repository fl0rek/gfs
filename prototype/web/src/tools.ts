// PROTOTYPE. pi's four built-in tools (read, write, edit, bash) reimplemented
// over gfs. Schemas and descriptions follow @earendil-works/pi-coding-agent 1.4.0
// so the model sees the tools it was trained with. Each call that changes a comb
// ends as exactly one history entry attributed to that tool call.

import { Type } from "@earendil-works/pi-ai";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Datacombs } from "./gfs";
import { resolvePath, displayPath, CWD, WORKSPACE } from "./paths";
import type { Author } from "./protocol";
import type { Shell } from "./shell";

const DEFAULT_MAX_LINES = 2000;
const DEFAULT_MAX_BYTES = 50 * 1024;

export interface ToolContext {
  dc: Datacombs;
  /** The current shell (it changes on a system switch); resolves once any boot in progress is over. */
  shell: () => Promise<Shell>;
  fetch: typeof fetch;
  author: () => Author;
  turnId: () => string;
  /** Called after a tool call produced a history entry. */
  onEntry: (comb: string, entryId: string) => void | Promise<void>;
}

const text = (t: string): AgentToolResult<undefined> => ({ content: [{ type: "text", text: t }], details: undefined });

/** Wrap a tool so that whatever it changed in a comb becomes one history entry. */
function recorded<T extends AgentTool<any, any>>(ctx: ToolContext, tool: T): T {
  const execute = tool.execute;
  return {
    ...tool,
    async execute(toolCallId: string, params: any, signal?: AbortSignal, onUpdate?: any) {
      let result: AgentToolResult<any>;
      try {
        result = await execute(toolCallId, params, signal, onUpdate);
      } catch (e) {
        await commitAll(ctx, toolCallId, tool.name, params);
        throw e;
      }
      await commitAll(ctx, toolCallId, tool.name, params);
      return result;
    },
  } as T;
}

async function commitAll(ctx: ToolContext, toolCallId: string, toolName: string, params: unknown) {
  // One entry per comb the call changed, sharing the tool-call id.
  const argsHash = ctx.dc.putBlob(JSON.stringify(params ?? null));
  for (const comb of ctx.dc.listCombs()) {
    if (comb === "session") continue; // the transcript comb is committed per turn
    const id = await ctx.dc.commit(
      comb,
      { kind: "tool_call", tool_call_id: toolCallId, turn_id: ctx.turnId(), tool_name: toolName, args_hash: argsHash },
      ctx.author(),
    );
    if (id) await ctx.onEntry(comb, id);
  }
}

function readBytes(ctx: ToolContext, p: string): { bytes: Uint8Array; where: string } {
  const r = resolvePath(p);
  const bytes = r.at ? ctx.dc.readFileAt(r.at, r.path) : ctx.dc.readFile(r.comb, r.path);
  return { bytes, where: displayPath(r) };
}

function writable(p: string) {
  const r = resolvePath(p);
  if (r.at) throw new Error(`${displayPath(r)} is a read-only view of the past`);
  return r;
}

const dec = new TextDecoder();

export function makeTools(ctx: ToolContext): AgentTool<any, any>[] {
  const { dc } = ctx;

  const read: AgentTool<any, undefined> = {
    name: "read",
    label: "read",
    description:
      "Read the contents of a file. Supports text files and images (jpg, png, gif, webp, bmp). Images are sent as attachments. For text files, output is truncated to 2000 lines or 50KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.",
    parameters: Type.Object({
      path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
      offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
      limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
    }),
    constrainedSampling: { type: "json_schema", strict: "prefer" },
    async execute(_id, params: any) {
      const { path, offset, limit } = params;
      const { bytes } = readBytes(ctx, path);
      const content = dec.decode(bytes);
      const all = content.split("\n");
      const total = all.length;
      let start = 0;
      if (offset !== undefined) {
        start = Math.max(0, offset - 1);
        if (start >= total) throw new Error(`Offset ${offset} is beyond end of file (${total} lines total)`);
      }
      let lines = all.slice(start);
      let limitedByUser = false;
      if (limit !== undefined && lines.length > limit) {
        lines = lines.slice(0, limit);
        limitedByUser = true;
      }
      // head truncation
      let out: string[] = [];
      let bytesSoFar = 0;
      let truncated = false;
      for (const line of lines) {
        const b = line.length + 1;
        if (out.length >= DEFAULT_MAX_LINES || bytesSoFar + b > DEFAULT_MAX_BYTES) {
          truncated = true;
          break;
        }
        out.push(line);
        bytesSoFar += b;
      }
      let t = out.join("\n");
      const shownEnd = start + out.length;
      if (truncated) {
        t += `\n\n[Showing lines ${start + 1}-${shownEnd} of ${total}. Use offset=${shownEnd + 1} to continue.]`;
      } else if (limitedByUser) {
        t += `\n\n[${total - shownEnd} more lines in file. Use offset=${shownEnd + 1} to continue.]`;
      }
      return text(t);
    },
  };

  const write: AgentTool<any, undefined> = {
    name: "write",
    label: "write",
    description:
      "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
    parameters: Type.Object({
      path: Type.String({ description: "Path to the file to write (relative or absolute)" }),
      content: Type.String({ description: "Content to write to the file" }),
    }),
    constrainedSampling: { type: "json_schema", strict: "prefer" },
    async execute(_id, params: any) {
      const { path, content } = params;
      const r = writable(path);
      dc.writeFile(r.comb, r.path, content);
      return text(`Successfully wrote to ${path}`);
    },
  };

  const edit: AgentTool<any, any> = {
    name: "edit",
    label: "edit",
    description:
      "Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include large unchanged regions just to connect distant changes.",
    parameters: Type.Object({
      path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
      edits: Type.Array(
        Type.Object({
          oldText: Type.String({
            description:
              "Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call.",
          }),
          newText: Type.String({ description: "Replacement text for this targeted edit." }),
        }),
        {
          description:
            "One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead.",
        },
      ),
    }),
    constrainedSampling: { type: "json_schema", strict: "prefer" },
    prepareArguments(args: any) {
      // Accept the legacy single-edit shape and a JSON string for edits.
      if (args && typeof args === "object") {
        if (typeof args.edits === "string") {
          try {
            args = { ...args, edits: JSON.parse(args.edits) };
          } catch {}
        }
        if (!Array.isArray(args.edits) && args.edits && typeof args.edits === "object") args = { ...args, edits: [args.edits] };
        if (!args.edits && typeof args.oldText === "string") {
          args = { path: args.path, edits: [{ oldText: args.oldText, newText: args.newText ?? "" }] };
        }
      }
      return args;
    },
    async execute(_id, params: any) {
      const { path, edits } = params;
      const r = writable(path);
      const original = dc.readText(r.comb, r.path).replace(/^\uFEFF/, "");
      const crlf = original.includes("\r\n");
      const base = crlf ? original.replace(/\r\n/g, "\n") : original;
      const spans: { start: number; end: number; newText: string }[] = [];
      for (const e of edits as { oldText: string; newText: string }[]) {
        if (!e.oldText) throw new Error("oldText must not be empty");
        const old = e.oldText.replace(/\r\n/g, "\n");
        let idx = base.indexOf(old);
        let len = old.length;
        if (idx < 0) {
          // fuzzy: normalize whitespace at line ends and smart punctuation
          const nb = normalizeFuzzy(base);
          const no = normalizeFuzzy(old);
          const i2 = nb.text.indexOf(no.text);
          if (i2 < 0) {
            throw new Error(
              `Could not find the exact text in ${path}. The old text must match exactly including all whitespace and newlines.`,
            );
          }
          if (nb.text.indexOf(no.text, i2 + 1) >= 0) throw new Error(`Found multiple occurrences of the text in ${path}. The text must be unique.`);
          idx = nb.map[i2];
          len = nb.map[i2 + no.text.length - 1] + 1 - idx;
        } else if (base.indexOf(old, idx + 1) >= 0) {
          let n = 0;
          for (let i = base.indexOf(old); i >= 0; i = base.indexOf(old, i + 1)) n++;
          throw new Error(
            `Found ${n} occurrences of the text in ${path}. The text must be unique. Include more surrounding context to make it unique.`,
          );
        }
        spans.push({ start: idx, end: idx + len, newText: e.newText.replace(/\r\n/g, "\n") });
      }
      spans.sort((a, b) => a.start - b.start);
      for (let i = 1; i < spans.length; i++) {
        if (spans[i].start < spans[i - 1].end) throw new Error(`Overlapping edits in ${path}. Merge nearby changes into one edit.`);
      }
      let out = "";
      let cursor = 0;
      for (const s of spans) {
        out += base.slice(cursor, s.start) + s.newText;
        cursor = s.end;
      }
      out += base.slice(cursor);
      if (out === base) throw new Error(`No changes made to ${path}. The replacement produced identical content.`);
      dc.writeFile(r.comb, r.path, crlf ? out.replace(/\n/g, "\r\n") : out);
      return { content: [{ type: "text", text: `Successfully replaced ${spans.length} block(s) in ${path}.` }], details: { edits: spans.length } };
    },
  };

  const bash: AgentTool<any, any> = {
    name: "bash",
    label: "bash",
    description:
      "Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last 2000 lines or 50KB (whichever is hit first). Optionally provide a timeout in seconds.",
    parameters: Type.Object({
      command: Type.String({ description: "Shell command to execute" }),
      timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
    }),
    outputSchema: Type.Object({
      output: Type.String({ description: "Combined stdout and stderr, possibly truncated" }),
      truncated: Type.Boolean(),
      exit_code: Type.Number(),
      wall_time_seconds: Type.Number(),
    }),
    constrainedSampling: { type: "json_schema", strict: "prefer" },
    async execute(_id, params: any, signal, onUpdate) {
      const { command, timeout } = params;
      const t0 = performance.now();
      const sh = await ctx.shell();
      const res = await sh.run(command, {
        timeoutMs: timeout ? timeout * 1000 : undefined,
        signal,
        onData: (chunk) => onUpdate?.({ content: [{ type: "text", text: chunk }], details: undefined }),
        cwd: CWD,
      });
      const wall = (performance.now() - t0) / 1000;
      const { text: out, truncated } = truncateTail(res.output);
      const structuredContent = { output: out, truncated, exit_code: res.exitCode, wall_time_seconds: wall };
      if (res.exitCode !== 0) {
        return {
          content: [{ type: "text", text: `${out}\n\nCommand exited with code ${res.exitCode}` }],
          details: undefined,
          isError: true,
          structuredContent,
        };
      }
      return { content: [{ type: "text", text: out }], details: undefined, structuredContent };
    },
  };

  const fetchTool: AgentTool<any, any> = {
    name: "fetch",
    label: "fetch",
    description:
      "Fetch a URL over HTTP(S) and return the response body as text (HTML is reduced to its text). Output is truncated to 2000 lines or 50KB. The browser's CORS rules apply unless the egress extension is installed; a blocked request says so.",
    parameters: Type.Object({
      url: Type.String({ description: "Absolute http(s) URL" }),
      method: Type.Optional(Type.String({ description: "HTTP method (default GET)" })),
      headers: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Extra request headers" })),
      body: Type.Optional(Type.String({ description: "Request body for POST/PUT" })),
    }),
    constrainedSampling: { type: "json_schema", strict: "prefer" },
    async execute(_id, params: any, signal) {
      const { url, method, headers, body } = params;
      if (!/^https?:\/\//.test(url)) throw new Error("only http(s) URLs");
      let res: Response;
      try {
        res = await ctx.fetch(url, { method: method ?? "GET", headers, body, signal });
      } catch (e: any) {
        throw new Error(`${url}: ${e.message}. From a browser this usually means the site sends no CORS headers; install the egress extension (prototype/extension) to fetch anything.`);
      }
      const ctype = res.headers.get("content-type") ?? "";
      let t = await res.text();
      if (/text\/html/.test(ctype)) t = htmlToText(t);
      const { text: out, truncated } = truncateHead(t);
      const head = `HTTP ${res.status}${ctype ? ` · ${ctype.split(";")[0]}` : ""}\n\n`;
      return { content: [{ type: "text", text: head + out }], details: { status: res.status, truncated }, isError: res.status >= 400 };
    },
  };

  return [...[read, write, edit, bash].map((t) => recorded(ctx, t)), fetchTool];
}

function normalizeFuzzy(s: string): { text: string; map: number[] } {
  // Build normalized text with a map from normalized index → original index.
  let text = "";
  const map: number[] = [];
  const lines = s.split("\n");
  let pos = 0;
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    const trimmed = line.replace(/\s+$/, "");
    for (let i = 0; i < trimmed.length; i++) {
      let c = trimmed[i];
      if ("‘’‚".includes(c)) c = "'";
      else if ("“”„".includes(c)) c = '"';
      else if ("‐‑‒–—−".includes(c)) c = "-";
      else if ("   ".includes(c)) c = " ";
      text += c;
      map.push(pos + i);
    }
    pos += line.length;
    if (li < lines.length - 1) {
      text += "\n";
      map.push(pos);
      pos += 1;
    }
  }
  return { text, map };
}

function truncateHead(s: string): { text: string; truncated: boolean } {
  const lines = s.split("\n");
  let out: string[] = [];
  let bytes = 0;
  let truncated = false;
  for (const l of lines) {
    if (out.length >= DEFAULT_MAX_LINES || bytes + l.length + 1 > DEFAULT_MAX_BYTES) {
      truncated = true;
      break;
    }
    out.push(l);
    bytes += l.length + 1;
  }
  let text = out.join("\n");
  if (truncated) text += `\n\n[truncated: showing ${out.length} of ${lines.length} lines]`;
  return { text, truncated };
}

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<\/(p|div|br|li|h[1-6]|tr|section|article|header|footer|blockquote|pre)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function truncateTail(s: string): { text: string; truncated: boolean } {
  const lines = s.split("\n");
  let kept = lines;
  let truncated = false;
  if (kept.length > DEFAULT_MAX_LINES) {
    kept = kept.slice(-DEFAULT_MAX_LINES);
    truncated = true;
  }
  let text = kept.join("\n");
  if (text.length > DEFAULT_MAX_BYTES) {
    text = text.slice(-DEFAULT_MAX_BYTES);
    truncated = true;
  }
  if (truncated) text = `[output truncated; showing the last ${kept.length} lines]\n` + text;
  return { text, truncated };
}

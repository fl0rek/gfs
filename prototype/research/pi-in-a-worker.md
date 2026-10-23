# Embedding pi (pi-agent-core / pi-ai) in a browser Web Worker with custom tools

Researched 2026-10-23. Sources: npm registry manifests, the published tarballs of
`@earendil-works/pi-agent-core@1.4.0`, `@earendil-works/pi-ai@1.4.0`,
`@earendil-works/pi-coding-agent@1.4.0`, `@earendil-works/pi-web-ui@0.75.3`
(downloaded from registry.npmjs.org and read; nothing installed), a shallow clone of
`github.com/earendil-works/pi` (HEAD 8a2ebd3, 2026-10-23), the package READMEs, and
pi.dev. unpkg/jsdelivr are blocked by this workspace's proxy, so sources were read from
the tarballs instead. Extracted copies live under
`(workspace scratch, not kept)` and
`.../scratchpad/gh/pi/`.

## 0. Naming / versions (important)

- Since 2026-05-07 pi lives at **github.com/earendil-works/pi** (badlogic/pi-mono
  redirects) and publishes under **`@earendil-works/*`**. `@mariozechner/*` is deprecated
  at **0.73.1** (npm `deprecated` field: "please use @earendil-works/... instead").
  pi.dev changelog: "0.73.1 is the final release on the old scope."
- Current versions (npm `latest`, published 2026-10-21):
  - `@earendil-works/pi-ai` **1.4.0**
  - `@earendil-works/pi-agent-core` **1.4.0**
  - `@earendil-works/pi-coding-agent` **1.4.0**
  - `@earendil-works/chord` 1.4.0, `@earendil-works/pi-durable` 1.4.0 (experimental),
    `@earendil-works/pi-telemetry` 1.4.0
  - `@earendil-works/pi-web-ui` **0.75.3** (2026-05-18) and it is **not in the monorepo
    anymore**: the repo's `packages/` dir has `agent ai chord codemode coding-agent durable
    env evals mcp telemetry tui` and the coding-agent CHANGELOG for 0.75.4 says "Removed web
    UI workspace references from the CLI package". pi-web-ui depends on `pi-ai ^0.75.3`,
    i.e. a pre-1.0 pi-ai API; it does not track 1.x.
- All 1.4.0 packages declare `"engines": { "node": ">=22.19.0" }` and ESM-only `exports`
  (`"import"` only, no `browser` field, no CJS). The engines field is advisory; see below
  for what actually touches Node.
- Schemas are **TypeBox** (`typebox` 1.3.27, the new un-scoped package name, not
  `@sinclair/typebox`). `Type` is re-exported from `@earendil-works/pi-ai`.

## 1. `@earendil-works/pi-agent-core` 1.4.0

### Package facts
- `dependencies`: `typebox 1.3.27`, `@earendil-works/pi-ai 1.4.0`. Nothing else.
- Files: `dist/{agent,agent-loop,proxy,stream-fn,types,index}.js`. 26 files, 271 KB
  unpacked (incl. maps).
- **No Node APIs at all.** `grep` over dist for `process.`, `require(`, `node:`, `Buffer`
  returns nothing. The only I/O is `fetch()` inside `streamProxy()`. It is pure TS over
  `@earendil-works/pi-ai` types + `typebox`. The `engines` field is inherited policy, not a
  real constraint. Works in a Worker as-is.

### Public API (`dist/index.d.ts`)
```ts
export * from "./agent"        // Agent, AgentOptions, AgentInitialState
export * from "./agent-loop"   // agentLoop, agentLoopContinue, runAgentLoop, runAgentLoopContinue, runToolCall, DEFAULT_AGENT_IDENTITY
export * from "./proxy"        // streamProxy, ProxyStreamOptions, ProxyAssistantMessageEvent
export { setDefaultStreamFn } from "./stream-fn"
export * from "./types"        // AgentTool, AgentToolResult, AgentEvent, AgentMessage, AgentState, StreamFn, ...
```

### Constructing an agent
```ts
import { Agent } from "@earendil-works/pi-agent-core";

const agent = new Agent({
  initialState: { systemPrompt, model, thinkingLevel?: "off"|"minimal"|"low"|"medium"|"high"|"xhigh"|"max", tools?: AgentTool[], messages?: AgentMessage[] },
  streamFn: models.streamSimple.bind(models),   // StreamFn (required unless setDefaultStreamFn was called)
  getApiKey?: (provider: string) => string | undefined | Promise<...>,  // resolved per LLM call, wins over config.apiKey
  convertToLlm?: (msgs: AgentMessage[]) => Message[] | Promise<Message[]>,  // default keeps system/user/assistant/toolResult
  transformContext?: (msgs, signal) => Promise<AgentMessage[]>,
  toolExecution?: "parallel" (default) | "sequential",
  beforeToolCall?, afterToolCall?, finishTurn?, prepareRequest?, prepareNextTurn?,
  steeringMode?, followUpMode?: "one-at-a-time" | "all",
  sessionId?, thinkingBudgets?, transport?, maxRetryDelayMs?, identity?,
  onPayload?, onResponse?, onProviderStreamEvent?,
});
```
`StreamFn = (model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>`.
Contract: must not throw; failures are encoded as an `error` event + final
`AssistantMessage` with `stopReason: "error" | "aborted"`.

Methods: `prompt(text, images?)` / `prompt(AgentMessage | AgentMessage[])`,
`continue()`, `subscribe(listener) => unsubscribe`, `steer(msg)`, `followUp(msg)`,
`abort()`, `waitForIdle()`, `reset()`, `clearSteeringQueue()`, `clearFollowUpQueue()`,
`clearAllQueues()`, `hasQueuedMessages()`, `peekQueuedMessages()`, getter `state`,
getter `signal`. Listeners are `(event: AgentEvent, signal: AbortSignal) => void | Promise<void>`
and are awaited in subscription order (they act as barriers; `agent_end` listeners count
toward `waitForIdle()`).

Low-level (no class): `agentLoop(prompts, context, config, signal, streamFn)` and
`agentLoopContinue(context, config, signal, streamFn)` return
`EventStream<AgentEvent, AgentMessage[]>` (async-iterable; `.result()` gives the new
messages). `runToolCall(toolCall, { tools, assistantMessage, context, signal, onUpdate, beforeToolCall, afterToolCall })`
runs one tool call through validation + hooks without emitting events.

### Tool definition shape (`AgentTool`, `dist/types.d.ts`)
```ts
interface AgentTool<TParameters extends TSchema = TSchema, TDetails = any> extends Tool<TParameters> {
  name: string;                 // from pi-ai Tool
  description: string;          // from pi-ai Tool
  parameters: TParameters;      // TypeBox schema (TSchema). Serialized to JSON Schema for providers.
  constrainedSampling?: false | { type: "json_schema"; strict: "prefer" | "require" } | { type: "grammar"; ... };
  label: string;                // UI label (required)
  prepareArguments?: (args: unknown) => Static<TParameters>;   // shim raw args before schema validation
  outputSchema?: TSchema;       // JSON schema of structuredContent
  replay?: "never" | "safe";
  executionMode?: "sequential" | "parallel";
  execute: (toolCallId: string, params: Static<TParameters>, signal?: AbortSignal,
            onUpdate?: (partial: AgentToolResult<TDetails>) => void) => Promise<AgentToolResult<TDetails>>;
}
interface AgentToolResult<T = JsonValue | undefined> {
  content: (TextContent | ImageContent)[];   // {type:"text",text} | {type:"image",data:base64,mimeType}
  details: T;                                // free-form, for UI/logs; stored on the toolResult message
  structuredContent?: JsonValue;             // matches outputSchema; not sent to the model
  usage?: Usage;
  isError?: boolean;                         // report failure without throwing
  terminate?: boolean;                       // skip follow-up LLM call if every result in batch sets it
}
```
- Parameters are validated with TypeBox before `execute` (pi-ai `validateToolCall`).
  Invalid args, unknown tool, blocked call, thrown error all become `isError: true`
  tool results (never reject the loop).
- Streaming/partial results: call `onUpdate(partial)`; the agent emits
  `tool_execution_update { partialResult }`. Calls after the promise settles are ignored.
- Errors: throw, or return `{ isError: true, content }` to keep `details`.

### Events (`AgentEvent`)
`agent_start` · `agent_end {messages}` · `turn_start` · `turn_end {message, toolResults}` ·
`message_start {message}` · `message_update {message, assistantMessageEvent}` (assistant
only; inner `assistantMessageEvent.type` is pi-ai's `start | text_start | text_delta |
text_end | thinking_start | thinking_delta | thinking_end | toolcall_start |
toolcall_delta | toolcall_end | done | error`, each with `contentIndex` and `partial`) ·
`message_end {message}` · `tool_execution_start {toolCallId, toolName, args}` ·
`tool_execution_update {toolCallId, toolName, args, partialResult}` ·
`tool_execution_end {toolCallId, toolName, result, isError, durationMs?}`.
Text deltas: `event.type === "message_update" && event.assistantMessageEvent.type === "text_delta"` then `.delta`.

### State and serialization
`agent.state`: `systemPrompt` (read-only, replayed from transcript), `model`,
`thinkingLevel`, `tools` (setter copies array), `messages` (setter copies array),
read-only `isStreaming`, `streamingMessage`, `pendingToolCalls`, `errorMessage`.

The transcript is a plain `AgentMessage[]` = pi-ai `Message` union
(`SystemMessage | UserMessage | AssistantMessage | ToolResultMessage`) plus any custom
roles you add via declaration merging on `CustomAgentMessages`. In 1.x the **system prompt
and tool declarations live in the transcript** as the leading `SystemMessage`
(`{ role:"system", content, sections?, toolsAdded?: Tool[], toolsRemoved?, timestamp }`);
later system messages patch it. The loop diffs `state.tools` against the declared tools
before each request and appends a system message announcing changes.

Persistence: pi-agent-core itself has **no** serializer; the data is plain JSON
(`JSON.stringify(agent.state.messages)`; pi-ai README: "The `Context` object can be easily
serialized ... using standard JSON methods"). Restore with
`new Agent({ initialState: { messages: saved, model, tools }, ... })` (the leading system
message in `messages` takes precedence over `systemPrompt`), or `agent.state.messages = saved`.
Caveat: `toolsAdded` in the stored system message contains the TypeBox schema objects as
JSON Schema, which round-trips fine. Model objects are plain data too.
`continue()` requires the last message to be `user` or `toolResult`.

## 2. `@earendil-works/pi-ai` 1.4.0

### Package facts
- `dependencies`: `openai 7.19.0`, `@anthropic-ai/sdk 0.129.0`, `@google/genai 2.21.0`,
  `typebox 1.3.27`, `partial-json 0.1.7`, `@earendil-works/pi-telemetry 1.4.0`, and Node-ish:
  `http-proxy-agent`, `https-proxy-agent`, `@smithy/node-http-handler`,
  `@aws-sdk/client-bedrock-runtime`. The last four are only reached from the Bedrock and
  Codex adapters.
- `sideEffects`: `["./dist/compat.js", "./dist/images.js", "./dist/providers/images/register-builtins.js"]`
  so everything else tree-shakes.
- Subpath exports: `.`, `./models` (runtime without TypeBox/catalogs), `./providers/*`,
  `./api/*` (incl. `./api/<id>.lazy`), `./utils/*`, `./compat`, `./oauth`, `./bun-oauth`,
  `./bedrock-provider`.
- README "Browser Usage": "The core entrypoint and provider factories are side-effect free
  and bundle cleanly." Bedrock is Node-only; OAuth login is Node-only but behind
  bundler-opaque dynamic imports.

### Node usage audit (dist)
- `node:` static imports only in `dist/cli.js` (not exported) and lazy/guarded code:
  `auth/context.js` uses `import(variable)` for `node:fs/promises`/`node:os` with the comment
  "Variable specifier so browser bundlers do not try to resolve node builtins"; `fileExists`
  returns false when the import fails. `utils/provider-env.js` reads `process.env` guarded by
  `typeof process !== "undefined"` and a `require("node:fs")` guarded by `process.versions.bun`.
  `utils/identity.js` guards `process` too. OAuth files (`auth/oauth/*`) import `node:http`,
  `node:crypto` but are only loaded on login. `api/openai-codex-responses.js` imports
  `node:zlib` and `utils/node-http-proxy.js` (don't use the `openai-codex` provider in a
  browser). `api/bedrock-converse-stream.js` likewise.
- HTTP: the `openai-completions`/`openai-responses` adapters use the `openai` SDK with
  `new OpenAI({ apiKey, baseURL: model.baseUrl, dangerouslyAllowBrowser: true, fetch, defaultHeaders })`;
  the Anthropic adapter uses `@anthropic-ai/sdk` with `dangerouslyAllowBrowser: true`.
  Both SDKs are fetch-based and browser/Worker-safe. `ProviderRequestOptions.fetch?: typeof globalThis.fetch`
  lets you inject a custom fetch. No `eventsource` polyfill, no `WebSocket` for the plain
  HTTP transport (`transport: "websocket"` exists only for Codex).
- CORS is the provider's concern: DeepSeek's and OpenCode Zen's CORS policies decide whether
  a Worker can call them directly; the library adds nothing. pi-web-ui ships a
  `createStreamFn`/proxy helper because of this.

### Constructing a model / provider
```ts
import { createModels, createProvider, Type } from "@earendil-works/pi-ai";         // or "@earendil-works/pi-ai/models" (no TypeBox)
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { opencodeProvider } from "@earendil-works/pi-ai/providers/opencode";

const models = createModels();              // MutableModels; options: { credentials?: CredentialStore, modelsStore?, authContext?, identity? }
models.setProvider(deepseekProvider());
models.setProvider(opencodeProvider());
const model = models.getModel("deepseek", "deepseek-v4-pro")!;   // sync, Model<Api> | undefined
```
- `KnownProvider` ids (types.d.ts): `amazon-bedrock, ant-ling, anthropic, google,
  google-vertex, openai, azure, openai-codex, radius, typesafe, nvidia, deepseek,
  github-copilot, xai, groq, cerebras, openrouter, vercel-ai-gateway, zai, zai-coding-cn,
  mistral, minimax, minimax-cn, moonshotai, moonshotai-cn, huggingface, fireworks, together,
  baseten, opencode, opencode-go, kimi-coding, meta, cloudflare-workers-ai,
  cloudflare-ai-gateway, qwen-token-plan(-cn|-individual), xiaomi(-token-plan-cn|-ams|-sgp)`.
  Each has a factory at `providers/<id>` (`deepseekProvider()`, `opencodeProvider()`,
  `openaiProvider()`, `anthropicProvider()`, `openrouterProvider()`...). `providers/all`
  gives `builtinModels()` with every provider (big bundle).
- **deepseek** (`providers/deepseek.js`): `id "deepseek"`, `baseUrl https://api.deepseek.com`,
  api `openai-completions`, auth `envApiKeyAuth("DeepSeek API key", ["DEEPSEEK_API_KEY"])`.
  Catalog (`providers/data/deepseek.json`): `deepseek-flash`, `deepseek-v4-pro`, both
  reasoning, 1M context, compat `{ supportsDeveloperRole:false, maxTokensField:"max_tokens",
  thinkingFormat:"deepseek", requiresReasoningContentOnAssistantMessages:true, ... }`.
- **opencode** (OpenCode Zen, `providers/opencode.js`): `id "opencode"`, env
  `OPENCODE_API_KEY`, mixed-API provider: `anthropic-messages` models at
  `https://opencode.ai/inference` (claude-* ids), `openai-completions`/`openai-responses`/
  `google-generative-ai` at `https://opencode.ai/inference/v1` (e.g. `deepseek-v4-pro`,
  `glm-5.x`, `gpt-5.x`, `gemini-3.x`, `kimi-*`...). Adds an `x-opencode-session` header
  from `options.sessionId`. There is also `opencode-go`.
- **Custom OpenAI-compatible base URL**: build a `Model<"openai-completions">` object
  (`{ id, name, api:"openai-completions", provider, baseUrl, reasoning, input:["text"],
  cost:{input,output,cacheRead,cacheWrite}, contextWindow, maxTokens, compat? }`) and
  `createProvider({ id, name?, baseUrl?, headers?, auth, models:[...], api: openAICompletionsApi() })`
  with `openAICompletionsApi` from `@earendil-works/pi-ai/api/openai-completions.lazy`
  (lazy = SDK loaded on first call; `api/openai-completions` loads eagerly). `compat` is
  auto-detected from `baseUrl` for known hosts (DeepSeek, OpenCode, Cerebras, xAI, ...);
  override fields for unknown proxies (`supportsStore`, `supportsDeveloperRole`,
  `maxTokensField`, `thinkingFormat`, ...). Keyless: `auth: { apiKey: { name, resolve: async () => ({ auth: {} }) } }`.
- **API key**: simplest in a Worker is per-request `options.apiKey` (or Agent `getApiKey`).
  `Models.applyAuth` → `resolveProviderAuth` short-circuits when `overrides.apiKey` is set
  (`auth/resolve.js:17`), so no env/CredentialStore is consulted. Alternative: pass a
  `CredentialStore` (`read/list/modify/delete`, one `{type:"api_key", key}` per provider)
  to `createModels({ credentials })`. Env vars are read only via `globalThis.process`,
  absent in a Worker. The README warns about exposing keys in frontend code.

### Request functions (`Models` interface, `models.d.ts`)
- `models.stream(model, context, options?)` → `AssistantMessageEventStream` (provider-specific options)
- `models.complete(model, context, options?)` → `Promise<AssistantMessage>`
- `models.streamSimple(model, context, options?: SimpleStreamOptions)` → stream; unified `reasoning` level
- `models.completeSimple(...)` → `Promise<AssistantMessage>`
- `models.getAuth(providerIdOrModel)`, `models.getProviders()`, `models.getModels(provider?)`, `models.refresh()`
- `Context = { systemPrompt?: string; messages: Message[]; tools?: Tool[] }` is what you pass;
  it is normalized to a branded `TranscriptContext { messages }` before reaching providers.
- `SimpleStreamOptions` (extends `StreamOptions` ⊃ `ProviderRequestOptions`): `apiKey`,
  `fetch`, `signal`, `headers`, `env`, `identity`, `timeoutMs`, `maxRetries`,
  `maxRetryDelayMs`, `onPayload`, `onResponse`, `onProviderStreamEvent`, `temperature`,
  `samplingParams`, `maxTokens`, `transport`, `cacheRetention`, `sessionId`, `metadata`,
  `toolChoice`, `reasoning`, `deferred`, `thinkingBudgets`.
- Consuming a stream: `for await (const ev of stream) {...}` then `await stream.result()`;
  `EventStream` has `push/end/result()` and is async-iterable. `createAssistantMessageEventStream()`
  exists for building custom stream functions.

### Message types (`types.d.ts`)
```ts
type Message = SystemMessage | UserMessage | AssistantMessage | ToolResultMessage;
SystemMessage    { role:"system"; content: string | TextContent[]; sections?: Record<string,string|null>; toolsAdded?: Tool[]; toolsRemoved?: {name}[]; timestamp:number }
UserMessage      { role:"user"; content: string | (TextContent|ImageContent)[]; timestamp:number }
AssistantMessage { role:"assistant"; content:(TextContent|ThinkingContent|ToolCall)[]; api; provider; model; responseModel?; responseId?;
                   providerThinkingLevel?; thinkingLevel?; diagnostics?; usage: Usage; stopReason: StopReason; errorMessage?; rawStopReason?; endTurn?; timestamp; durationMs? }
ToolResultMessage{ role:"toolResult"; toolCallId; toolName; content:(TextContent|ImageContent)[]; details?; usage?; nestedCalls?; isError:boolean; timestamp; durationMs? }
TextContent      { type:"text"; text; textSignature? }
ThinkingContent  { type:"thinking"; thinking; thinkingSignature?; redacted? }
ImageContent     { type:"image"; data: base64; mimeType }
ToolCall         { type:"toolCall"; id; name; arguments: JsonObject; thoughtSignature?; namespace?; argumentsError? }
Usage            { input; output; cacheRead; cacheWrite; cacheWrite1h?; reasoning?; totalTokens; cost:{input,output,cacheRead,cacheWrite,total} }
StopReason       "pending"|"stop"|"length"|"toolUse"|"error"|"aborted"|"deferred"
Tool             { name; description; parameters: TSchema; constrainedSampling? }
```
`AssistantMessageEvent` union is listed under section 1 (events). Helpers exported from
root: `validateToolCall`, `validateToolArguments`, `getSystemMessageText`,
`getCurrentSystemMessage/Tools` (utils/transcript), `calculateCost`, `hasApi`,
`getSupportedThinkingLevels`, `uuidv7`, `Type` (TypeBox), `StringEnum` etc.

## 3. `@earendil-works/pi-coding-agent` 1.4.0

### Built-in tools (exact schemas, from `dist/core/tools/*.js`)
Default tool set in the system prompt: `["read", "bash", "edit", "write"]`. All four set
`constrainedSampling: { type: "json_schema", strict: "prefer" }`. Truncation constants
`DEFAULT_MAX_LINES = 2000`, `DEFAULT_MAX_BYTES = 50 * 1024`.

**read** — `name "read"`, `label "read"`
```
description: "Read the contents of a file. Supports text files and images (jpg, png, gif, webp, bmp). Images are sent as attachments. For text files, output is truncated to 2000 lines or 50KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete."
parameters: Type.Object({
  path:   Type.String({ description: "Path to the file to read (relative or absolute)" }),
  offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
  limit:  Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
})
outputSchema: Type.Union([Type.String(), Type.Object({ type: Type.Literal("image"), data, mimeType, note })])
promptSnippet "Read file contents"; guideline "Use read to examine files instead of cat or sed."
```
Behavior: resolve path against cwd; `access`; if image → `[text "Read image file [mime]...", image]`;
else split on `\n`, apply `offset` (1-indexed; beyond EOF → throw "Offset N is beyond end of
file (M lines total)"), `limit`, then `truncateHead` to 2000 lines / 50KB. Notices appended:
`\n\n[Showing lines A-B of N. Use offset=X to continue.]` (or `(50.0KB limit)` variant),
`\n\n[R more lines in file. Use offset=X to continue.]` when the user `limit` stopped early.
Result `{ content:[{type:"text",text}], details: { truncation? } }`.
Pluggable `ReadOperations { readFile(abs): Promise<Buffer>; access(abs); detectImageMimeType?(abs) }`.

**write** — `name "write"`, `label "write"`
```
description: "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories."
parameters: Type.Object({
  path:    Type.String({ description: "Path to the file to write (relative or absolute)" }),
  content: Type.String({ description: "Content to write to the file" }),
})
promptSnippet "Create or overwrite files"; guideline "Use write only for new files or complete rewrites."
```
Behavior: `mkdir -p dirname`, write; returns `{ content:[{type:"text", text:"Successfully wrote to <path>"}], details: undefined }`.
`WriteOperations { writeFile(abs, content); mkdir(dir) }`.

**edit** — `name "edit"`, `label "edit"`
```
description: "Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include large unchanged regions just to connect distant changes."
parameters: Type.Object({
  path:  Type.String({ description: "Path to the file to edit (relative or absolute)" }),
  edits: Type.Array(Type.Object({
    oldText: Type.String({ description: "Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call." }),
    newText: Type.String({ description: "Replacement text for this targeted edit." }),
  }), { description: "One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead." }),
})
promptSnippet "Make precise file edits with exact text replacement, including multiple disjoint edits in one call"
guidelines: ["Use edit for precise changes (edits[].oldText must match exactly)",
  "When changing multiple separate locations in one file, use one edit call with multiple entries in edits[] instead of multiple edit calls",
  "Each edits[].oldText is matched against the original file, not after earlier edits are applied. Do not emit overlapping or nested edits. Merge nearby changes into one edit.",
  "Keep edits[].oldText as small as possible while still being unique in the file. Do not pad with large unchanged regions."]
```
Behavior: `prepareArguments` accepts legacy `{oldText,newText}` top-level, a JSON string for
`edits`, or a single object. Strips BOM, detects CRLF, normalizes to LF, exact match first then
fuzzy (`normalizeForFuzzyMatch`: NFKC, trimEnd each line, smart quotes → ASCII, Unicode
dashes → `-`, special spaces → space). Errors: "Could not find the exact text in <path>. The
old text must match exactly including all whitespace and newlines." / "Found N occurrences of
the text in <path>. The text must be unique. ..." / "oldText must not be empty" / no-change
error. Result `{ content:[{type:"text", text:"Successfully replaced N block(s) in <path>."}], details:{ diff, patch, firstChangedLine? } }`.
`EditOperations { readFile(abs): Promise<Buffer>; writeFile(abs, content); access(abs) }`.

**bash** — `name "bash"`, `label "bash"` (built via `createShellToolDefinition` with `shellName "bash"`)
```
description: "Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last 2000 lines or 50KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds."
parameters: Type.Object({
  command: Type.String({ description: "Shell command to execute" }),
  timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
})
outputSchema: Type.Object({ output: Type.String({description:"Combined stdout and stderr, possibly truncated"}), truncated: Type.Boolean(), full_output_path: Type.Optional(Type.String()), exit_code: Type.Number(), wall_time_seconds: Type.Number() })
promptSnippet "Execute bash commands (ls, grep, find, etc.)"; guideline "You can inspect PI_* environment variables for current model and session details."
```
Behavior: streams combined output via `onUpdate`; tail-truncates; non-zero exit →
`{ content:[text + "\n\nCommand exited with code N"], isError: true, structuredContent }`;
abort → throws "Command aborted"; timeout → throws "Command timed out after N seconds".
`BashOperations { exec(command, cwd, { onData(Buffer), signal, timeout, env }) => Promise<{ exitCode: number | null }> }`.

Other built-ins: `grep`, `find`, `ls`, `powershell` (same `createXToolDefinition` pattern).

### Importability without Node — NO
`dist/core/tools/{read,write,edit,bash}.js` statically import `fs`, `fs/promises`, `path`,
`child_process`, `node:os`; `path-utils.js`, `file-mutation-queue.js`, `edit-diff.js`
import `node:fs`/`node:path` too. The `*Operations` injection points only replace the I/O
calls, not the module-level imports, and `Buffer` is used. `createAgentSession()` pulls in
settings files, session JSONL, `jiti`, `undici`, `cross-spawn`, `quickjs-wasi`, etc.
So: do **not** import pi-coding-agent in a Worker; **reimplement the four tools** against
your own FS using the schemas/descriptions above (they are small). `buildSystemPrompt`
(`core/system-prompt.js`) imports `../config.js` (Node paths) for the `docs` section; copy
its structure instead (below).

### System prompt structure (`buildSystemPromptSections`)
Ordered sections; `preamble` untagged, others wrapped as `<name>\n...\n</name>` and stored
as `SystemMessage.sections` so they can be patched individually:
1. `preamble`: "You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files." (or `customPrompt`)
2. `tools`: `- read: Read file contents` ... one line per selected tool from `promptSnippet`, then
   "In addition to the tools above, you may have access to other custom tools depending on the project."
3. `rules`: bullets — "Use bash for file operations like ls, rg, find" (when bash present and no grep/find/ls),
   each tool's `promptGuidelines`, extra `promptGuidelines`, then "Be concise in your responses",
   "Show file paths clearly when working with files".
4. `docs`: pi docs paths (Node-specific; drop it).
5. `addendum` (appendSystemPrompt), `project_context` (`<project_instructions path="...">` blocks),
   `skills`, `cwd` (forward slashes), then custom `sections`.
`forceSystemPrompt` replaces everything with opaque `content`.

### ExtensionAPI / custom tools
`ExtensionAPI.registerTool(ToolDefinition)` is the custom-tool path; `ToolDefinition` =
`AgentTool` fields + `promptSnippet?`, `promptGuidelines?`, `renderShell?`, `exposure?`
(`direct|model-only|codemode|deferred|hidden`), `namespace?`, `annotations?`,
`reachesTools?`, `defaultActive?`, `prepareLoadout?`, `renderCall?`/`renderResult?` (TUI),
and `execute(toolCallId, params, signal, onUpdate, ctx: ExtensionToolContext)`.
`wrapToolDefinition()` turns it into an `AgentTool`. `createAgentSession({ tools, customTools, ... })`
can replace the fs tools, but the session itself is Node-only, so this path is not usable in
a Worker. The useful takeaway is the `ToolDefinition` shape, which is a strict superset of
`AgentTool`: you can author tools once as `AgentTool` and they work in both.

### Alternative: `@earendil-works/pi-durable` (experimental)
Has a portable `FileSystem`/`ExecutionEnv` abstraction (`@earendil-works/pi-durable/env`,
Result-returning methods: `readTextFile`, `writeFile`, `listDir`, `exec`, ...), reimplements
`read/write/edit/bash` on top of it (`@earendil-works/pi-durable/tools`, same schemas and
descriptions as coding-agent), and ships `IndexedDbStorage` (`storage/indexeddb`, marked
browser-only). It is built on chord + pi-ai, not pi-agent-core, has a different
Harness/Submission API, and the README says "The API changes without notice between
releases." Worth watching, but not the minimal path today. No browser/Worker example in the repo.

## 4. `@earendil-works/pi-web-ui` 0.75.3
- Lit 3 web components (`peerDependencies: lit ^3.3.1, @mariozechner/mini-lit ^0.2.0`),
  Tailwind-based `app.css`. Exports `ChatPanel`, `AgentInterface` (`<agent-interface>`),
  `MessageList`, `StreamingMessageContainer`, `ToolMessage`, `ThinkingBlock`,
  `registerToolRenderer`/`renderTool`, `BashRenderer`, `DefaultRenderer`, dialogs
  (`SettingsDialog`, `ApiKeyPromptDialog`, `ModelSelector`, `SessionListDialog`,
  `CustomProviderDialog`), IndexedDB-backed `AppStorage` with `SettingsStore`,
  `ProviderKeysStore`, `SessionsStore`, `CustomProvidersStore`, sandboxed-iframe artifacts +
  JS REPL tools, `createStreamFn`/CORS-proxy helpers, i18n.
- Binding: `chat.session = agent` where `agent` is a **pi-agent-core `Agent` instance on the
  same thread**. `AgentInterface` calls `this.session.subscribe(...)`, reads
  `this.session.state.messages` / `pendingToolCalls` directly, and mutates
  `session.streamFn` and `session.getApiKey`. There is no message-port/serialized-event
  adapter; driving it from a Worker would require a main-thread shim object that mimics
  `Agent` (`subscribe`, `state`, `prompt`, `abort`, `streamFn`...). Not documented or supported.
- Heavy deps (`pdfjs-dist`, `xlsx`, `docx-preview`, `jszip`, `@lmstudio/sdk`, `ollama`,
  `pi-tui`), pinned to `pi-ai ^0.75.3` (pre-1.0 `Context`/auth API; 1.x moved the system
  prompt into the transcript and changed provider construction). README "Known Issues":
  "PersistentStorageDialog: Currently broken". Removed from the monorepo after 0.75.x; last
  publish 2026-05-21 (0.74.2 backport).
- Verdict: **not worth using**. Version-skewed vs pi-ai 1.4, same-thread coupling, large
  bundle. A small hand-rolled UI over the `AgentEvent` stream is less work than adapting it.

## 5. Prior art of pi in a browser / Worker
- Official: pi-ai README "Browser Usage" section + pi-agent-core `streamProxy()` (for apps
  proxying LLM calls via a backend `POST {proxyUrl}/api/stream`, receives `partial`-stripped
  events) + pi-web-ui's example app (Vite, "Direct Mode" calling providers from the page,
  keys in localStorage). All run the Agent on the **main thread**; no Web Worker example found
  anywhere in the repo, READMEs, changelogs, or examples (`packages/agent/examples` only has
  `mcp-codemode`).
- pi-durable ships `IndexedDbStorage` ("Browser-only storage"), implying browser hosts are
  anticipated, but no example.
- Third-party "pi web ui" packages on pi.dev (`@kkkiio/pi-web-ui`, `pi-web-ui`,
  `@patriceckhart/pi-chrome-operator`, `coctostan/pi-agent-browser`, `@onkernel/browser-loop`)
  are all **extensions running inside the Node pi process** (HTTP/WebSocket servers to a
  browser frontend, or tools that drive a browser). None run pi-agent-core inside a browser
  or Worker. No Worker-based prior art was found.

## Recommendation

**Packages** (exactly two runtime deps plus TypeBox):
- `@earendil-works/pi-agent-core@1.4.0` (pure; `Agent`, `AgentTool`, events)
- `@earendil-works/pi-ai@1.4.0` — import only `./models` or root, plus
  `./providers/deepseek`, `./providers/opencode`, and/or `createProvider` +
  `./api/openai-completions.lazy` for arbitrary OpenAI-compatible URLs. Do not import
  `providers/all`, `compat`, `oauth`, `bedrock-provider`, `providers/openai-codex`.
- `typebox@1.3.27` (comes transitively; import `Type` from `@earendil-works/pi-ai` or `typebox`).
- Skip `pi-coding-agent` (Node-bound) and `pi-web-ui` (stale, same-thread). Reimplement
  read/write/edit/bash as `AgentTool`s against your FS using the schemas in section 3.

**Bundling**: ESM-only packages, so bundle the Worker (Vite `worker.format = "es"` or
esbuild `--platform=browser --format=esm`). Lazy `.lazy` adapters become dynamic-import
chunks; fine in a module Worker. Mark Node builtins external/empty if the bundler complains
about the guarded dynamic imports (`node:fs/promises`, `node:os` are imported via a variable
specifier so most bundlers ignore them). Nothing needs polyfilling for the DeepSeek/
OpenCode/OpenAI-compatible paths: `fetch`, `AbortController`, `TextDecoder`, `crypto` are
native in Workers; `process` is only read behind `typeof process` guards; `Buffer` is not
used by pi-ai/pi-agent-core (only by pi-coding-agent). The `openai` and `@anthropic-ai/sdk`
clients are constructed with `dangerouslyAllowBrowser: true`. If a chosen provider lacks CORS
for browser origins, either use pi-agent-core `streamProxy` against your own backend or a
custom `streamFn`/`fetch` option. Keys: pass `apiKey` (or Agent `getApiKey`) explicitly;
there is no env in a Worker.

**Call order in the Worker**
```ts
import { createModels, createProvider, Type } from "@earendil-works/pi-ai";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { opencodeProvider } from "@earendil-works/pi-ai/providers/opencode";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { Agent, type AgentTool, type AgentEvent } from "@earendil-works/pi-agent-core";

// 1. model runtime + providers
const models = createModels();
models.setProvider(deepseekProvider());
models.setProvider(opencodeProvider());
// optional: any OpenAI-compatible endpoint
models.setProvider(createProvider({
  id: "myproxy", auth: { apiKey: { name: "My proxy", resolve: async () => ({ auth: {} }) } },
  models: [{ id: "x", name: "x", api: "openai-completions", provider: "myproxy", baseUrl: "https://host/v1",
             reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
             contextWindow: 128000, maxTokens: 32000, compat: { supportsDeveloperRole: false } }],
  api: openAICompletionsApi(),
}));
const model = models.getModel("deepseek", "deepseek-v4-pro")!;   // or ("opencode", "claude-sonnet-4-6")

// 2. tools (TypeBox params, execute against your own FS)
const read: AgentTool = { name: "read", label: "read", description: "...", parameters: Type.Object({ path: Type.String({ description: "..." }), offset: Type.Optional(Type.Number()), limit: Type.Optional(Type.Number()) }),
  execute: async (id, { path, offset, limit }, signal, onUpdate) => ({ content: [{ type: "text", text: await myFs.read(path) }], details: undefined }) };
// write / edit / bash likewise; throw Error on failure

// 3. agent
const agent = new Agent({
  initialState: { systemPrompt, model, tools: [read, write, edit, bash], messages: restoredMessages ?? [] },
  streamFn: models.streamSimple.bind(models),
  getApiKey: (provider) => keys[provider],       // or options.apiKey via a wrapping streamFn
  toolExecution: "sequential",                   // simpler for a single-threaded FS
});

// 4. events -> postMessage (AgentEvent payloads are JSON-serializable; strip `partial`/`message` if large)
agent.subscribe((ev: AgentEvent) => { self.postMessage(ev); });

// 5. run a turn
await agent.prompt(userText);          // or agent.prompt({ role: "user", content, timestamp: Date.now() })
// steer/followUp/abort via messages from the main thread: agent.steer(msg), agent.followUp(msg), agent.abort()

// 6. persist / restore
const snapshot = JSON.stringify({ model: agent.state.model, messages: agent.state.messages });
// restore: new Agent({ initialState: { model, tools, messages: JSON.parse(snapshot).messages }, streamFn })
```
Notes: keep `tools` on the Worker side (functions don't cross `postMessage`); the main
thread only needs the event stream and a small command protocol (`prompt`, `steer`,
`followUp`, `abort`, `setModel`). `message_update` events carry the full partial message on
every delta; forward just `{type, assistantMessageEvent:{type, contentIndex, delta}}` plus
`message_end` to keep message traffic small. `agent_end` carries the new messages for
persistence. `thinkingLevel` is set via `agent.state.thinkingLevel`; DeepSeek v4 and the
OpenCode Claude models are `reasoning: true`.

## Open questions / not answerable from sources
- Whether DeepSeek's or OpenCode Zen's API endpoints send CORS headers for arbitrary
  browser origins (not documented in pi; must be tested).
- Whether `openai@7.19.0` / `@anthropic-ai/sdk@0.129.0` have any Worker-specific issues in
  the bundler of choice (both advertise browser support; not verified here).
- pi-durable's suitability as a Worker harness (experimental, no example).

// PROTOTYPE. A "free" provider: ride whatever free tier is up today.
//
// Adapted from ANUS (https://github.com/anus-dev/ANUS, MIT, © the ANUS
// authors): the same ranked list (anus.dev/free-models.json), the same rest
// rules (lib/route.mjs) and the same fall-through routing, as a pi-ai
// Provider living in our worker. Keys are still needed; it finds free tiers,
// not keyless access.

import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Model,
  type MutableModels,
  type Provider,
  type SimpleStreamOptions,
  type TranscriptContext,
} from "@earendil-works/pi-ai";

export interface FreeEntry {
  provider: string;
  id: string;
  iq?: number;
  ping?: "ok" | "flaky" | "down";
}
export interface FreeList {
  updated: string;
  about?: string;
  models: FreeEntry[];
}

export const FREE_PROVIDERS = [
  { id: "openrouter", name: "OpenRouter", keyUrl: "https://openrouter.ai/keys", note: "one key, a dozen free models; 50 requests a day, 1000 after a one-time $10 top-up" },
  { id: "google", name: "Google Gemini", keyUrl: "https://aistudio.google.com/apikey", note: "free tier while billing is off on the project" },
  { id: "groq", name: "Groq", keyUrl: "https://console.groq.com/keys", note: "free plan, fast; 8K tokens a minute" },
  { id: "cerebras", name: "Cerebras", keyUrl: "https://cloud.cerebras.ai", note: "a $5 trial for 30 days, card required" },
  { id: "mistral", name: "Mistral", keyUrl: "https://console.mistral.ai/api-keys", note: "free plan: $10 a month in credits, no card" },
] as const;
export type FreeProviderId = (typeof FREE_PROVIDERS)[number]["id"];

export const LIST_URL = "https://anus.dev/free-models.json";
const MAX_TRIES = 6;
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

// ----- the rules (ANUS lib/route.mjs) -----

const keyOf = (m: FreeEntry) => `${m.provider}/${m.id}`;
const PING_RANK: Record<string, number> = { ok: 0, flaky: 1, down: 3 };

/** Keep the list's order, but let models that failed today's ping sink. */
export function orderModels(models: FreeEntry[]): FreeEntry[] {
  return models
    .map((m, i) => ({ m, i }))
    .sort((a, b) => (PING_RANK[a.m.ping ?? "ok"] ?? 0) - (PING_RANK[b.m.ping ?? "ok"] ?? 0) || a.i - b.i)
    .map(({ m }) => m);
}

export function untilUtcMidnight(now: number) {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - now;
}

/** How long a model (or its whole provider) rests after a failed request. */
export function restFor(errorMessage: unknown, now: number): { ms: number; scope: "provider" | "model" } {
  const e = String(errorMessage ?? "");
  if (/\b401\b|unauthori[sz]ed|invalid.{0,20}(api.?)?key|api.?key.{0,20}(invalid|not valid|missing)/i.test(e)) return { ms: 6 * 3_600_000, scope: "provider" };
  if (/per.?day|daily|free-models-per-day|quota|exhausted|insufficient|credits|billing|\b403\b|forbidden|only available/i.test(e)) return { ms: untilUtcMidnight(now), scope: "model" };
  if (/context.{0,30}(length|window|limit)|too long|maximum.{0,30}tokens|context_length_exceeded/i.test(e)) return { ms: 0, scope: "model" };
  if (/rate.?limit|too many requests|\b429\b/i.test(e)) return { ms: 60_000, scope: "model" };
  return { ms: 5 * 60_000, scope: "model" };
}

const ENGINE_NO_RETRY = /GoUsageLimitError|FreeUsageLimitError|Monthly usage limit reached|available balance|insufficient_quota|out of budget|quota exceeded|billing/gi;
export function midStreamError(errorMessage: unknown, name: string) {
  const cause = String(errorMessage ?? "unknown error").replace(ENGINE_NO_RETRY, "(limit)").slice(0, 300);
  return `${name} broke off mid-answer (provider returned error: ${cause}); retrying on the next free model`;
}

export function estimateTokens(messages: readonly unknown[]) {
  let chars = 0;
  for (const m of messages ?? []) chars += JSON.stringify((m as any)?.content ?? "").length;
  return Math.ceil(chars / 4);
}

export function plan<M>(args: { models: FreeEntry[]; usable: (e: FreeEntry) => (M & { contextWindow?: number }) | null; rest: Map<string, number>; now: number; tokens?: number }) {
  const awake: { entry: FreeEntry; model: M; until?: number }[] = [];
  const resting: { entry: FreeEntry; model: M; until: number }[] = [];
  for (const entry of orderModels(args.models)) {
    const model = args.usable(entry);
    if (!model) continue;
    if (model.contextWindow && model.contextWindow < (args.tokens ?? 0) * 1.15 + 4096) continue;
    const until = Math.max(args.rest.get(keyOf(entry)) ?? 0, args.rest.get(entry.provider) ?? 0);
    if (until <= args.now) awake.push({ entry, model });
    else resting.push({ entry, model, until });
  }
  resting.sort((a, b) => a.until - b.until);
  return [...awake, ...resting];
}

// ----- the provider -----

export interface FreeStatus {
  updated: string;
  routed: string | null;
  models: { key: string; provider: string; id: string; ping?: string; state: "awake" | "resting" | "no key" | "unknown"; until?: number }[];
}

export class FreeRouter {
  list: FreeList = { updated: "", models: [] };
  rest = new Map<string, number>();
  routed: string | null = null;
  constructor(
    private models: MutableModels,
    private keys: () => Partial<Record<string, string>>,
    private log: (s: string) => void = () => {},
  ) {}

  /** The provider to register with pi-ai: one model, "free", routed per request. */
  provider(): Provider {
    const model: Model<any> = {
      id: "free",
      name: "free tier router (ANUS list)",
      api: "free-router",
      provider: "free",
      baseUrl: "https://anus.dev",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 262144,
      maxTokens: 32768,
    };
    return {
      id: "free",
      name: "Free tiers",
      baseUrl: "https://anus.dev",
      auth: { apiKey: { name: "free", resolve: async () => ({ auth: { apiKey: "free" } }) } } as any,
      getModels: () => [model],
      stream: (_m: Model<any>, context: TranscriptContext, options?: SimpleStreamOptions) => this.route(context, options),
      streamSimple: (_m: Model<any>, context: TranscriptContext, options?: SimpleStreamOptions) => this.route(context, options),
    } as unknown as Provider;
  }

  private find(entry: FreeEntry): Model<any> | null {
    const key = this.keys()[entry.provider];
    if (!key) return null;
    const m = this.models.getModel(entry.provider, entry.id);
    if (m) return m;
    // Not in pi-ai's catalog: shape it after a sibling on the same provider.
    const siblings = this.models.getModels(entry.provider);
    const sibling = siblings.find((m) => m.api === "openai-completions") ?? siblings[0];
    if (!sibling) return null;
    return { ...sibling, id: entry.id, name: entry.id, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  }

  private usable = (needImages: boolean) => (entry: FreeEntry) => {
    const m = this.find(entry);
    if (!m) return null;
    if (needImages && !m.input?.includes("image")) return null;
    return m;
  };

  private resting(key: string, ms: number) {
    if (ms > 0) this.rest.set(key, Date.now() + ms);
  }

  status(): FreeStatus {
    const now = Date.now();
    return {
      updated: this.list.updated,
      routed: this.routed,
      models: orderModels(this.list.models).map((e) => {
        const key = keyOf(e);
        const until = Math.max(this.rest.get(key) ?? 0, this.rest.get(e.provider) ?? 0);
        const state = !this.keys()[e.provider] ? "no key" : until > now ? "resting" : "awake";
        return { key, provider: e.provider, id: e.id, ping: e.ping, state, until: until > now ? until : undefined };
      }),
    };
  }

  route(context: TranscriptContext, options: SimpleStreamOptions = {}) {
    const out = createAssistantMessageEventStream();
    const now = Date.now();
    const messages = (context as any).messages ?? [];
    const needImages = messages.some((m: any) => Array.isArray(m?.content) && m.content.some((c: any) => c?.type === "image"));
    const tries = plan({ models: this.list.models, usable: this.usable(needImages), rest: this.rest, now, tokens: estimateTokens(messages) }).slice(0, MAX_TRIES);
    this.log(`free: plan ${tries.map((t) => keyOf(t.entry)).join(" ") || "(nothing usable)"}`);
    const { apiKey: _k, headers: _h, maxTokens: _m, ...passOn } = options as any;
    const shortName = (e: FreeEntry) => `${e.id.replace(/:free$/, "").split("/").pop()} · ${e.provider}`;

    (async () => {
      let lastError: string | null = null;
      const refusedKeys = new Set<string>();
      for (const { entry, model } of tries) {
        if (options.signal?.aborted) break;
        if (refusedKeys.has(entry.provider)) continue;
        let inner;
        try {
          inner = this.models.streamSimple(model, context, { ...passOn, apiKey: this.keys()[entry.provider] });
        } catch (err: any) {
          lastError = err?.message ?? String(err);
          this.resting(entry.provider, restFor(lastError, Date.now()).ms);
          continue;
        }
        let held: AssistantMessageEvent | null = null;
        let spoke = false;
        let failed: AssistantMessageEvent | null = null;
        for await (const event of inner) {
          if (event.type === "start") {
            held = event;
            continue;
          }
          if (event.type === "error" && !spoke && event.reason !== "aborted" && !options.signal?.aborted) {
            failed = event;
            break;
          }
          if (!spoke) {
            spoke = true;
            this.routed = keyOf(entry);
            if (held) out.push(held);
          }
          if (event.type === "error" && event.reason !== "aborted" && !options.signal?.aborted) {
            const cause = event.error?.errorMessage;
            const { ms, scope } = restFor(cause, Date.now());
            if (ms > 0 && event.error) {
              this.resting(scope === "provider" ? entry.provider : keyOf(entry), ms);
              event.error.errorMessage = midStreamError(cause, shortName(entry));
            }
          }
          if (event.type === "done" || event.type === "error") {
            const message = event.type === "done" ? event.message : event.error;
            if (message?.usage) message.usage.cost = { ...ZERO_COST };
          }
          out.push(event);
        }
        if (!failed) {
          out.end();
          return;
        }
        lastError = failed.error?.errorMessage ?? "unknown error";
        const { ms, scope } = restFor(lastError, Date.now());
        this.log(`free: ${keyOf(entry)} refused (rest ${Math.round(ms / 1000)}s, ${scope}): ${lastError.slice(0, 200)}`);
        if (scope === "provider") refusedKeys.add(entry.provider);
        if (ms > 0) this.resting(scope === "provider" ? entry.provider : keyOf(entry), ms);
      }
      out.push({ type: "error", reason: options.signal?.aborted ? "aborted" : "error", error: this.failure(lastError, tries.length) });
      out.end();
    })().catch((err) => {
      out.push({ type: "error", reason: "error", error: this.failure(err?.message ?? String(err), tries.length) });
      out.end();
    });
    return out;
  }

  private failure(lastError: string | null, tried: number): AssistantMessage {
    const text = !tried
      ? "No free model to use: paste a key for OpenRouter, Google, Groq, Cerebras or Mistral in the model settings (or the conversation is too long for every free model)."
      : restFor(lastError, Date.now()).scope === "provider"
        ? `A free key was refused (${String(lastError).slice(0, 120)}). Check it in the model settings.`
        : `All ${tried} free models refused this request. Last answer: ${lastError}`;
    return {
      role: "assistant",
      content: [],
      api: "free-router",
      provider: "free",
      model: "free",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { ...ZERO_COST } },
      stopReason: "error",
      errorMessage: text,
      timestamp: Date.now(),
    } as AssistantMessage;
  }
}

/** The ranked list: anus.dev when reachable (through our egress), else the snapshot shipped with the build. */
export async function loadFreeList(fetchFn: typeof fetch, snapshotUrl: URL): Promise<FreeList> {
  const valid = (l: any): l is FreeList => Array.isArray(l?.models) && l.models.every((m: any) => m?.provider && m?.id);
  let snapshot: FreeList | null = null;
  try {
    const s = await (await fetch(snapshotUrl)).json();
    if (valid(s)) snapshot = s;
  } catch {}
  try {
    const res = await fetchFn(LIST_URL, { signal: AbortSignal.timeout(4000) });
    if (res.ok) {
      const live = await res.json();
      if (valid(live) && (!snapshot || String(live.updated) >= String(snapshot.updated))) return live;
    }
  } catch {}
  return snapshot ?? { updated: "", models: [] };
}

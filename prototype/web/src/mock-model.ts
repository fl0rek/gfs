// PROTOTYPE. A scripted stand-in for an LLM so the whole loop runs offline.
// It plays a small coding-agent routine on every prompt: write a file, look
// around with bash, edit the file, then answer.

import { fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";

export const MOCK_PROVIDER_ID = "mock";
export const MOCK_MODEL_ID = "scripted-agent";

export function createMockProvider() {
  const faux = fauxProvider({
    provider: MOCK_PROVIDER_ID,
    models: [{ id: MOCK_MODEL_ID, name: "Scripted mock agent", contextWindow: 1_000_000, maxTokens: 8192 }],
    tokensPerSecond: 400,
  });
  // One factory, consulted on every call; it never runs out.
  const factory = (context: TranscriptContext) => {
    faux.appendResponses([factory]);
    return script(context);
  };
  faux.setResponses([factory]);
  return faux;
}

function script(context: TranscriptContext) {
  const msgs = context.messages;
  let lastUser = -1;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === "user") {
      lastUser = i;
      break;
    }
  }
  const userText = lastUser >= 0 ? contentToText(msgs[lastUser]) : "";
  const since = msgs.slice(lastUser + 1);
  const step = since.filter((m) => m.role === "assistant").length;
  const lastResult = [...since].reverse().find((m) => m.role === "toolResult") as any;
  const slug = userText.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "note";
  const file = `${slug}.md`;
  const n = msgs.filter((m) => m.role === "user").length;

  switch (step) {
    case 0:
      return fauxAssistantMessage([
        fauxText(`I'll start by writing that down.`),
        fauxToolCall("write", { path: `workspace/${file}`, content: `# ${userText || "note"}\n\nPrompt ${n}, written by the scripted mock agent.\n` }),
      ]);
    case 1:
      return fauxAssistantMessage([fauxToolCall("bash", { command: `cd workspace && ls -la && wc -c ${file} && echo "touched at $(date)" >> log.txt` })]);
    case 2: {
      const bashFailed = lastResult?.isError;
      return fauxAssistantMessage([
        fauxText(bashFailed ? "bash isn't available here, so I'll edit directly." : "Now a precise edit."),
        fauxToolCall("edit", {
          path: `workspace/${file}`,
          edits: [{ oldText: "written by the scripted mock agent.", newText: "written by the scripted mock agent, then edited in place." }],
        }),
      ]);
    }
    case 3:
      return fauxAssistantMessage([
        fauxText("Let me also check something on the web."),
        fauxToolCall("fetch", { url: "https://api.github.com/repos/fl0rek/gfs" }),
      ]);
    default:
      return fauxAssistantMessage(
        `Done. I wrote \`${file}\`, listed the workspace with bash, edited the file, and fetched the repo's metadata${lastResult?.isError ? " (the fetch was blocked)" : ` (${/"stargazers_count":\s*(\d+)/.exec(contentToText(lastResult) ?? "")?.[1] ?? "?"} stars)`}. Each tool call that changed a file is one entry in the comb's history; the fetch changed nothing, so it left no entry.`,
      );
  }
}

function contentToText(m: any): string {
  if (typeof m.content === "string") return m.content;
  return (m.content ?? [])
    .filter((c: any) => c.type === "text")
    .map((c: any) => c.text)
    .join("\n");
}

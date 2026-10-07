# Universal Explorer

The project is **Universal Explorer** and the repo is `fl0rek/gfs`. "Wayfinder" is the planning skill we use, not the project's name.

Universal Explorer is a runtime for agent harnesses (first: Hermes Agent), native and in-browser (wasm) as equals. Root holds three directories:
- **machine**: read-only, from Nix
- **datacombs**: persistent, versioned, auditable
- **cache**: discardable

Vocabulary: `GLOSSARY.md`. Use its terms and avoid the `_Avoid_` ones.

## How every session works: the wayfinder flow

The effort is planned with Matt Pocock's `/wayfinder` skill, vendored in `.claude/skills/wayfinder/` along with `grilling`, `domain-modeling`, `research` and `prototype` (mattpocock/skills @ dd400c3, MIT). We are **past charting**; every session is **"Work through the map"**.

1. Read `.scratch/universal-explorer/map.md` (Destination, Notes, Decisions so far, fog). Don't read every ticket.
2. Find the frontier by scanning `.scratch/universal-explorer/issues/`.
   - Frontier means `Status: open`, and every ticket in `Blocked by:` is `resolved`.
   - If the user named a ticket, take it. Otherwise take the first frontier ticket by number.
3. **Claim it** (`Status: claimed`), then commit and push **before any work**, so other sessions skip it.
4. Resolve it by type:
   - **grilling** (HITL): load the `grilling` and `domain-modeling` skills. Ask in numbered rounds, each with your recommended answer. The user decides; never answer for them.
   - **prototype** (HITL): load `prototype`; link the artifact from the ticket.
   - **research** (AFK): run a subagent that follows `research`, writes `docs/research/<name>.md` on a `research/<name>` branch, and pushes that branch.
   - **task**: do it, or hand the user a checklist.
5. Record the resolution:
   - Append `## Answer` to the ticket and set `Status: resolved`.
   - Add one line to the map's **Decisions so far**: the ticket name as a link, plus a gist.
6. Update the map:
   - Create newly sharp tickets, then wire their `Blocked by:` edges.
   - Graduate fog out of **Not yet specified**.
   - Move anything beyond the destination to **Out of scope**, closing its ticket.
7. Update `GLOSSARY.md` the moment a term settles, and write an ADR in `docs/adr/` only for hard-to-reverse, surprising trade-offs.
8. Commit and push to `origin main`.

Tracker mechanics: `docs/agents/issue-tracker.md` (local markdown).

## Rules

- **Plan, don't do.** Tickets produce decisions, not code or architecture docs. Don't scaffold implementation until the map says the way is clear.
- **One ticket per session.** Research tickets are the only exception, and pacing still applies.
- **Pace slowly; no sudden ramp-ups.** Never fire more than two subagents at once.
- **Refer to tickets by name**, not by number, in anything the user reads.
- **The user's preferences are standing decisions.** They live in the map's Notes. Read them, don't re-ask.
- **Commits** are authored as `Claude <noreply@anthropic.com>` so GitHub shows them as Verified. End each message with the `Co-Authored-By` and `Claude-Session` trailers.

## Corrections log

Mistakes made in earlier sessions. Don't repeat them.

- `/wayfinder` was meant as the skill, but it was mistaken for the project name and a whole repo was scaffolded with code. Read a slash-word as a possible skill first.
- An architecture doc was written before any decision existed. That broke "plan, don't do".
- The tier names drifted from the user's names. They are **machine / datacombs / cache**, not system, ledger or persist.

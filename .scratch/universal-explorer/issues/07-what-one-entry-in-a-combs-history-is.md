# What one entry in a comb's history is

Type: grilling
Status: resolved
Blocked by: 01, 06

## Question

What is the unit of history in a comb, and who is its author?
- unit: every write, every close, every Hermes tool call, every session, a time window
- author: the session, the tool call, the model, you
- what metadata an entry carries so "who changed what and when" answers itself

## Answer

**The unit is the history entry: one per tool call that changed the comb.** Writes inside a tool call are coalesced into its entry. Writes outside any tool call (Hermes's `state.db` and log churn) are coalesced into one entry per agent turn, or per quiescence period when no harness hook is present. A session is a grouping of entries, not an entry.

**Who.** The author is the session acting on your behalf. It records the harness and its revision, the model, and you as the principal. The committer is the node.

**Fields.** Each history entry carries:
- the parent hash, the comb, and the resulting tree hash
- the author and the committer
- the tool call's start and end times
- the tool-call ID and the turn ID
- the tool name
- the hash of the arguments, with the arguments themselves stored as a content-addressed object in the comb (verifiable, deduplicated, prunable without breaking the chain)
- the message

Nothing history doesn't need, such as token counts or cost.

**Message.** Generated deterministically from the tool name and arguments. The model may add a note, but no entry ever waits on a model call.

**One tool call, two combs.** One entry per comb, sharing the tool-call ID. There is no cross-comb atomicity.

**Outside edits** are not expected. If the checkout was changed outside a session, the agent is notified on its next write attempt. It commits those changes as their own entry, authored *external*, and may pause first to wait for outside confirmation. The changes are never dropped. The agent's own write follows as a separate entry.

Glossary: history entry.

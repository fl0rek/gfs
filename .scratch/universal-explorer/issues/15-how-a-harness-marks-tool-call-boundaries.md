# How a harness marks tool-call boundaries

Type: grilling
Status: open
Blocked by: 07, 13

## Question

A history entry is one tool call (see "What one entry in a comb's history is"). How does Hermes tell gfs where a tool call starts and ends?
- the mechanism: a syscall, a special path under gfs, an env-provided socket, or a patch to Hermes
- what it passes along: the tool-call ID, the turn ID, the tool name and arguments, the model, an optional note
- what gfs does when the hook is missing or a call never ends

# What a data comb's flake exposes

Type: grilling
Status: open
Blocked by: 06

## Question

Every comb is a full Nix flake, data combs included. A data comb is something like Hermes's `memories`, or the comb that holds `state.db`. What does a data comb's `flake.nix` contain?
- the minimal boilerplate, and who writes it: the harness, datacombs on comb creation, or the user
- its outputs: the raw tree, typed packages, or something a harness or another comb can consume
- how a live, churning file such as `state.db` lives inside a flake without breaking evaluation

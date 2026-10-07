# What Hermes needs from its environment

Type: research
Status: open
Blocked by:

## Question

What does the Hermes Agent harness (Nous Research) need from the machine it runs on?
- language and runtime
- install method and Nix packaging status
- where it keeps state, memory and config
- how it runs tools and shells, including existing sandbox or "terminal backend" options
- network needs
- which directories churn heavily, which hold durable state, and which are reproducible

Findings: branch `research/hermes-environment`, `docs/research/hermes-environment.md`.

This feeds where its paths land across machine, datacombs and cache, and what one change in its history should mean.

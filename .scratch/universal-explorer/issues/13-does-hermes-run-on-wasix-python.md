# Does Hermes run on WASIX Python?

Type: task
Status: claimed
Blocked by:

## Question

Can Hermes Agent's core loop run on Wasmer's WASIX CPython 3.12+, first natively under Wasmer and then in the browser via the Wasmer JS SDK? Check each of these:
- Hermes's Python dependencies: pure Python, or with native extensions that need WASIX builds
- `state.db` as SQLite with FTS5 and WAL
- asyncio and an HTTPS call to an LLM API
- the `local` terminal backend spawning bash, git and rg from WASIX packages

Record what works, what breaks, and the workarounds. If it fails badly, the fallback in "Guest architecture and platform matrix" applies.

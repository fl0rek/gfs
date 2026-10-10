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

## Comments

### 2026-10-10: static audit; runtime checks handed off

The cloud workspace can't run this: its network policy blocks `registry.wasmer.io` and `cdn.wasmer.io`. The runtime checks go to the user's Asahi box via [the checklist](../assets/does-hermes-run-on-wasix-python/checklist.md) and [smoke.py](../assets/does-hermes-run-on-wasix-python/smoke.py). Status stays `claimed` until those results are in.

Established without running anything (Hermes at `5a487bca`, 2026-10-10):

- **Python version is the first gate.** Hermes pins every core dependency to `python_version >= '3.14'` and says it only supports 3.14. WASIX CPython's public branch is `3.13.0-wasix` and Wasmer's docs show `python/python@=3.13.18`. The WASIX wheel index does publish `cp314` wheels (e.g. cryptography), so a 3.14 interpreter may exist; unconfirmed.
- **Dependencies:** the core closure in `uv.lock` is 76 packages, 54 pure Python. Of the 22 compiled ones, 6 are Windows-only and 1 (`nemo-relay`) is gated to Linux/macOS/Windows markers, so they drop out on WASIX. The WASIX wheel index (`python-registry.wasix.org`) has builds for pydantic-core, jiter, cryptography, cffi, pillow, psutil, websockets, httptools, watchfiles, markupsafe and charset-normalizer. **No WASIX build seen** for `resvg-py`, `firecrawl-anydoc` or `pillow-heif`; they serve image/doc tools, not the core loop. Exact pinned versions aren't verified against the index.
- **state.db:** Hermes already has a `database.journal_mode: delete` setting for filesystems without WAL, which is the ready-made workaround if WAL fails on WASIX.
- **local backend:** spawns via `subprocess.Popen` and kills by process group (`setsid`, `killpg`), so WASIX needs both `fork/exec` and process groups, not just spawn. The smoke test covers that.

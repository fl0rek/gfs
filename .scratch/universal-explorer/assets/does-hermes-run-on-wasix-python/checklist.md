# Checklist: Does Hermes run on WASIX Python?

Run on the Asahi box (aarch64). The cloud workspace could not: its network policy blocks `registry.wasmer.io` and `cdn.wasmer.io`, where WASIX Python lives. Paste each step's output back into a session; it records the answer.

## Quick path: one command

Steps 1–4 are packaged as a flake ([flake.nix](flake.nix), [run.sh](run.sh)). Hermes is pinned to the audited commit.

```sh
export OPENROUTER_API_KEY=...   # optional: enables the real Hermes turn in step 4
nix run 'github:fl0rek/gfs?dir=.scratch/universal-explorer/assets/does-hermes-run-on-wasix-python'
```

It writes everything to `~/.cache/ue-wasix-smoke/report.txt`; paste that back. Knobs: `UE_PY=3.13` to force a version, `UE_SKIP_HOST=1` to skip the host baseline, `UE_HERMES_ARGS="--provider openrouter -m <model>"` to pick a model. The browser leg (step 5) is still manual.

The manual steps below are what the flake does, for when it breaks.

Wasmer CLI flags and package names below are from docs and memory, not tested here. If one is wrong, note what worked instead; that is a finding too.

## 0. Setup

```sh
curl https://get.wasmer.io -sSfL | sh          # or: cargo install wasmer-cli
wasmer --version
git clone --depth 1 https://github.com/NousResearch/hermes-agent ~/ue/hermes
cp smoke.py ~/ue/                                # from this folder
```

## 1. Which WASIX Python versions exist? (the gating question)

Hermes pins every core dependency to `python_version >= '3.14'`. The `wasix-org/cpython` repo only has a `3.13.0-wasix` branch; Wasmer's docs show `python/python@=3.13.18`; but the WASIX wheel index ships `cp314` builds.

```sh
wasmer run python/python@=3.14 -- -c 'import sys; print(sys.version)'
wasmer run python/python       -- -c 'import sys; print(sys.version)'
```

Record the newest version that runs. If it is 3.13, every later step is "Hermes on 3.13 with its pins forced", which is itself a finding (see step 2).

## 2. Stage Hermes's dependencies as WASIX wheels

Download the core closure for the WASIX target, from PyPI plus `python-registry.wasix.org`. Use the Python minor from step 1 (`313` or `314`).

```sh
cd ~/ue/hermes
uv export --frozen --no-dev --no-hashes --no-emit-project > /tmp/req.txt   # core only, no extras
PY=3.14   # or 3.13
python3 -m pip download -r /tmp/req.txt -d ~/ue/wheels \
  --only-binary=:all: --platform wasix_wasm32 --platform any \
  --python-version $PY --implementation cp --abi cp${PY/./} --abi abi3 --abi none \
  --extra-index-url https://python-registry.wasix.org/simple/ 2>&1 | tee ~/ue/download.log
mkdir -p ~/ue/site && for w in ~/ue/wheels/*.whl; do unzip -oq "$w" -d ~/ue/site; done
```

If `PY=3.13`, the markers drop every pin: strip `; python_version >= '3.14'` from `/tmp/req.txt` first.

Record every package `pip download` could not satisfy (the end of `download.log`). Expected misses from the static audit: `resvg-py`, `firecrawl-anydoc`, `pillow-heif`, possibly the exact pinned versions of `pydantic-core`, `jiter`, `cryptography`, `psutil` (git-pinned upstream).

## 3. Smoke test natively under Wasmer

Baseline first on the host Python, so a FAIL under WASIX means WASIX:

```sh
SMOKE_HERMES=~/ue/hermes python3 ~/ue/smoke.py
```

Then WASIX. `--net` enables sockets; `--use` puts bash, git and rg on the guest PATH (check names with `wasmer search bash`, `wasmer search git`, `wasmer search ripgrep`):

```sh
wasmer run python/python@=$PY --net \
  --use wasmer/bash --use wasmer/git --use wasmer/ripgrep \
  --volume ~/ue:/ue --volume /tmp/smoke:/tmp/smoke \
  --env SMOKE_SITE=/ue/site --env SMOKE_HERMES=/ue/hermes \
  -- /ue/smoke.py 2>&1 | tee ~/ue/smoke-wasix.log
```

The script covers the ticket's four checks: compiled imports, `state.db` (FTS5 + WAL with two connections), asyncio + HTTPS (httpx and Hermes's truststore path), and the `local` backend's spawn + process-group kill.

## 4. One real Hermes turn natively under Wasmer

Only if step 3 passes imports. Uses a throwaway `HERMES_HOME`.

```sh
wasmer run python/python@=$PY --net --use wasmer/bash --use wasmer/git --use wasmer/ripgrep \
  --volume ~/ue:/ue --env PYTHONPATH=/ue/site:/ue/hermes --env HERMES_HOME=/ue/home \
  --env OPENROUTER_API_KEY=$OPENROUTER_API_KEY \
  -- -m hermes_cli.main chat -q "Run 'git --version' in the terminal and tell me the output" --oneshot \
  2>&1 | tee ~/ue/turn-wasix.log
```

If WAL failed in step 3, retry with `database.journal_mode: delete` in `~/ue/home/config.yaml`; Hermes already supports that for filesystems without WAL.

## 5. Browser via the Wasmer JS SDK

Smallest page: `@wasmer/sdk`, `Wasmer.fromRegistry("python/python@=$PY")`, mount `site/`, `hermes/` and `smoke.py` into an in-memory `Directory`, run `smoke.py`, print stdout. Serve with `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` (SharedArrayBuffer). Chromium and Firefox.

Expect the network checks to fail: a browser has no raw sockets, and earlier research found browser networking unsolved. Record how they fail, and whether the SDK offers a relay or fetch bridge.

## What to paste back

- Step 1: versions that run.
- Step 2: the unsatisfied packages.
- Steps 3–5: the `SUMMARY` block plus every `[FAIL]` line, for host, Wasmer native, and browser.
- Wall time of step 4 vs. the same turn on host Python (rough performance signal).

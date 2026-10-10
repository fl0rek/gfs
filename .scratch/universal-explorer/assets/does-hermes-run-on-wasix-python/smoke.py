"""Smoke test for 'Does Hermes run on WASIX Python?'.

Run the same file natively on the host Python first (baseline), then under
WASIX Python. Each check prints PASS/FAIL/SKIP with detail; the script never
stops at the first failure. Paste the full output back into the session.

Env:
  SMOKE_SITE    extra sys.path entry holding the wasix wheels (optional)
  SMOKE_HERMES  path to the hermes-agent checkout (optional, enables check 6)
  SMOKE_TMP     writable scratch dir (default /tmp/smoke)
  SMOKE_URL     HTTPS URL to hit (default https://api.openai.com/v1/models,
                401 is a PASS: TLS and HTTP worked)
"""
import os, sys, time, traceback

for k in ("SMOKE_SITE", "SMOKE_HERMES"):
    if os.environ.get(k):
        sys.path.insert(0, os.environ[k])
TMP = os.environ.get("SMOKE_TMP", "/tmp/smoke")
os.makedirs(TMP, exist_ok=True)
results = []


def check(name):
    def deco(fn):
        t = time.perf_counter()
        try:
            detail = fn()
            status = "SKIP" if isinstance(detail, str) and detail.startswith("SKIP") else "PASS"
        except Exception as e:
            status, detail = "FAIL", f"{type(e).__name__}: {e}"
            traceback.print_exc(limit=3)
        ms = (time.perf_counter() - t) * 1000
        results.append((status, name))
        print(f"[{status}] {name} ({ms:.0f} ms): {detail}", flush=True)
        return fn
    return deco


@check("0 interpreter")
def _():
    import platform
    return f"{sys.version.split()[0]} {sys.platform} {platform.machine()} {sys.implementation.name}"


# 1. compiled dependencies in Hermes's core closure (uv.lock, 2026-10-10)
COMPILED = ["pydantic_core", "jiter", "cryptography.hazmat.bindings._rust", "_cffi_backend",
            "PIL._imaging", "pillow_heif", "psutil", "websockets", "httptools", "watchfiles",
            "markupsafe._speedups", "charset_normalizer", "resvg_py", "firecrawl_anydoc"]
for mod in COMPILED:
    @check(f"1 import {mod}")
    def _(mod=mod):
        m = __import__(mod)
        return getattr(m, "__version__", "ok")


@check("1 import pure core (openai, httpx, pydantic, rich, prompt_toolkit, ruamel.yaml, jinja2)")
def _():
    import openai, httpx, pydantic, rich, prompt_toolkit, ruamel.yaml, jinja2  # noqa
    return f"openai {openai.__version__}, pydantic {pydantic.__version__}"


# 2. state.db: SQLite with FTS5 and WAL
@check("2 sqlite3 version + FTS5")
def _():
    import sqlite3
    c = sqlite3.connect(":memory:")
    c.execute("create virtual table t using fts5(body)")
    c.execute("insert into t values ('wayfinder charts the map')")
    hit = c.execute("select count(*) from t where t match 'chart*'").fetchone()[0]
    assert hit == 1, hit
    return sqlite3.sqlite_version


@check("2 sqlite3 WAL on disk, two connections")
def _():
    import sqlite3
    p = os.path.join(TMP, "state.db")
    for s in ("", "-wal", "-shm"):
        if os.path.exists(p + s):
            os.remove(p + s)
    w = sqlite3.connect(p)
    mode = w.execute("pragma journal_mode=wal").fetchone()[0]
    assert mode == "wal", f"journal_mode={mode}"
    w.execute("create table m(x)")
    w.execute("insert into m values (1)")
    w.commit()
    r = sqlite3.connect(p)  # reader sees committed data while writer holds the db open
    w.execute("insert into m values (2)")  # uncommitted
    n = r.execute("select count(*) from m").fetchone()[0]
    w.commit()
    assert n == 1, n
    return f"wal ok, -shm exists={os.path.exists(p + '-shm')}"


# 3. asyncio + HTTPS
URL = os.environ.get("SMOKE_URL", "https://api.openai.com/v1/models")


@check("3 asyncio + httpx HTTPS (certifi trust)")
def _():
    import asyncio, httpx

    async def go():
        async with httpx.AsyncClient(timeout=20) as c:
            return (await c.get(URL)).status_code
    code = asyncio.run(go())
    assert code in (200, 401, 403), code
    return f"HTTP {code}"


@check("3 truststore (OS trust store, Hermes's ssl_verify path)")
def _():
    import ssl, truststore
    ctx = truststore.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    import urllib.request
    try:
        urllib.request.urlopen(URL, context=ctx, timeout=20)
    except urllib.error.HTTPError as e:
        return f"HTTP {e.code}"
    return "HTTP 200"


# 4. local terminal backend: spawn bash, git, rg with a process group
@check("4 subprocess bash/git/rg")
def _():
    import subprocess
    out = []
    for cmd in (["bash", "-c", "echo $((6*7))"], ["git", "--version"], ["rg", "--version"]):
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        out.append(f"{cmd[0]}={r.returncode}:{r.stdout.split(chr(10))[0]}")
    return " | ".join(out)


@check("4 process group: start_new_session + killpg (local backend kill path)")
def _():
    import signal, subprocess
    p = subprocess.Popen(["bash", "-c", "sleep 30 & sleep 30"], start_new_session=True)
    time.sleep(0.5)
    os.killpg(p.pid, signal.SIGTERM)
    rc = p.wait(timeout=10)
    return f"rc={rc}"


# 5. Hermes itself
@check("5 hermes imports (run_agent, hermes_state, tools.environments.local)")
def _():
    if not os.environ.get("SMOKE_HERMES"):
        return "SKIP: SMOKE_HERMES unset"
    os.environ.setdefault("HERMES_HOME", os.path.join(TMP, "hermes_home"))
    import run_agent, hermes_state, tools.environments.local  # noqa
    return "ok"


print("\nSUMMARY", {s: sum(1 for x, _ in results if x == s) for s in ("PASS", "FAIL", "SKIP")})
for s, n in results:
    if s == "FAIL":
        print("  FAIL", n)

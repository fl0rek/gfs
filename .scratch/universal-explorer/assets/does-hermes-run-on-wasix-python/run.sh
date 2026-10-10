# Runs checklist steps 1-4 for "Does Hermes run on WASIX Python?".
# Wrapped by flake.nix, which sets HERMES_SRC, SMOKE_PY, FILTER_PY, HOST_PY.
# Never stops at the first failure: every step logs and the run continues.
#
# Env knobs:
#   UE_SMOKE_DIR   work dir (default ~/.cache/ue-wasix-smoke)
#   UE_PY          WASIX Python to use, e.g. 3.13 (default: newest of 3.14, 3.13 that runs)
#   UE_SKIP_HOST   1 to skip the host-Python baseline
#   OPENROUTER_API_KEY / ANTHROPIC_API_KEY / OPENAI_API_KEY  enables the real Hermes turn (step 4)
#   UE_HERMES_ARGS extra args for the Hermes turn, e.g. "--provider openrouter -m some/model"

WORK=${UE_SMOKE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/ue-wasix-smoke}
mkdir -p "$WORK"
REPORT=$WORK/report.txt
: >"$REPORT"
exec > >(tee -a "$REPORT") 2>&1

step() { printf '\n===== %s =====\n' "$*"; }
step "env"
echo "date: $(date -Is)"
echo "host: $(uname -srm)"
wasmer --version || true
echo "hermes: $HERMES_SRC"
echo "work: $WORK"

# ---- 1. which WASIX Python runs -------------------------------------------
step "1 WASIX Python versions"
PY=${UE_PY:-}
for v in 3.14 3.13; do
  out=$(timeout 600 wasmer run "python/python@=$v" -- -c 'import sys;print(sys.version)' 2>&1) && ok=1 || ok=0
  echo "python@=$v -> $([ "$ok" = 1 ] && echo OK || echo FAIL): $(echo "$out" | tail -1)"
  if [ "$ok" = 1 ] && [ -z "$PY" ]; then PY=$v; fi
done
if [ -z "$PY" ]; then
  echo "No WASIX Python ran. Stopping: nothing below can run."
  echo "REPORT: $REPORT"
  exit 1
fi
echo "using WASIX Python $PY"
CP=cp${PY/./}

# ---- 2. stage Hermes's dependencies as WASIX wheels ------------------------
step "2 stage WASIX wheels ($CP)"
rm -rf "$WORK/hermes" "$WORK/wheels" "$WORK/site"
cp -r "$HERMES_SRC" "$WORK/hermes"
chmod -R u+w "$WORK/hermes"
cp "$SMOKE_PY" "$WORK/smoke.py"
export UV_CACHE_DIR=$WORK/uv-cache
(cd "$WORK/hermes" && uv export --frozen --no-dev --no-hashes --no-emit-project >"$WORK/req-all.txt")
force=""
[ "$PY" != 3.14 ] && force="--force-pins" && echo "target is $PY: forcing Hermes's 3.14-only pins"
# shellcheck disable=SC2086
"$HOST_PY" "$FILTER_PY" "$WORK/req-all.txt" "$PY" $force >"$WORK/req.txt"
echo "requirements for WASIX: $(wc -l <"$WORK/req.txt")"

mkdir -p "$WORK/wheels"
PIPDL=(-m pip download --no-deps --disable-pip-version-check -q -d "$WORK/wheels"
  --only-binary=:all: --platform wasix_wasm32 --platform any
  --python-version "$PY" --implementation cp --abi "$CP" --abi abi3 --abi none
  --extra-index-url https://python-registry.wasix.org/simple/)
: >"$WORK/misses.txt"
while read -r req; do
  if "$HOST_PY" "${PIPDL[@]}" "$req" >/dev/null 2>&1; then continue; fi
  name=${req%%[=<>!~]*}
  if [ "$name" != "$req" ] && "$HOST_PY" "${PIPDL[@]}" "$name" >/dev/null 2>&1; then
    got=$(find "$WORK/wheels" -iname "${name//-/_}-*" -printf '%f\n' | head -1)
    echo "PIN MISS  $req  (used $got)" | tee -a "$WORK/misses.txt"
  else
    echo "NO WHEEL  $req" | tee -a "$WORK/misses.txt"
  fi
done <"$WORK/req.txt"
echo "downloaded: $(find "$WORK/wheels" -name '*.whl' | wc -l) wheels; wasix builds: $(find "$WORK/wheels" -name '*wasix*' | wc -l)"
mkdir -p "$WORK/site"
for w in "$WORK"/wheels/*.whl; do unzip -oq "$w" -d "$WORK/site"; done

# ---- 3. smoke test: host baseline, then WASIX under Wasmer ----------------
if [ "${UE_SKIP_HOST:-0}" != 1 ]; then
  step "3a smoke on host Python 3.14 (baseline)"
  if (cd "$WORK/hermes" && uv sync --frozen --no-dev --python "$HOST_PY" -q); then
    SMOKE_HERMES=$WORK/hermes SMOKE_TMP=$WORK/tmp-host \
      "$WORK/hermes/.venv/bin/python" "$WORK/smoke.py" || true
  else
    echo "host venv failed; baseline skipped"
  fi
fi

step "3b smoke on WASIX Python $PY under Wasmer"
USE=()
for pair in bash:wasmer/bash bash:sharrattj/bash git:wasmer/git rg:wasmer/ripgrep rg:burntsushi/ripgrep; do
  tool=${pair%%:*}; pkg=${pair#*:}
  case " ${USE[*]-} " in *" $tool="*) continue ;; esac
  if timeout 300 wasmer run "$pkg" -- --version >/dev/null 2>&1; then
    echo "guest $tool from $pkg"; USE+=("$tool=$pkg")
  else
    echo "no $tool from $pkg"
  fi
done
USEFLAGS=()
for u in "${USE[@]}"; do USEFLAGS+=(--use "${u#*=}"); done
mkdir -p "$WORK/tmp-wasix"
WASMER_COMMON=(--net "${USEFLAGS[@]}" --volume "$WORK:/ue" --volume "$WORK/tmp-wasix:/tmp/smoke"
  --env PYTHONDONTWRITEBYTECODE=1)
start=$(date +%s)
wasmer run "${WASMER_COMMON[@]}" --env SMOKE_SITE=/ue/site --env SMOKE_HERMES=/ue/hermes \
  "python/python@=$PY" -- /ue/smoke.py || echo "wasmer exited non-zero: $?"
echo "wall: $(($(date +%s) - start)) s"

# ---- 4. one real Hermes turn ----------------------------------------------
step "4 real Hermes turn"
KEYS=()
for k in OPENROUTER_API_KEY ANTHROPIC_API_KEY OPENAI_API_KEY; do
  if [ -n "${!k:-}" ]; then KEYS+=(--env "$k=${!k}"); fi
done
if [ ${#KEYS[@]} = 0 ]; then
  echo "SKIP: no API key in env (OPENROUTER_API_KEY, ANTHROPIC_API_KEY or OPENAI_API_KEY)"
else
  PROMPT="Run 'git --version' in the terminal and reply with only its output."
  read -r -a EXTRA <<<"${UE_HERMES_ARGS:-}"
  if [ -x "$WORK/hermes/.venv/bin/python" ]; then
    echo "-- host"
    start=$(date +%s)
    (cd "$WORK" && HERMES_HOME=$WORK/home-host "$WORK/hermes/.venv/bin/python" -m hermes_cli.main \
      "${EXTRA[@]}" -z "$PROMPT") || echo "host turn exited non-zero: $?"
    echo "wall: $(($(date +%s) - start)) s"
  fi
  echo "-- WASIX $PY"
  start=$(date +%s)
  wasmer run "${WASMER_COMMON[@]}" "${KEYS[@]}" \
    --env PYTHONPATH=/ue/site:/ue/hermes --env HERMES_HOME=/ue/home-wasix \
    "python/python@=$PY" -- -m hermes_cli.main "${EXTRA[@]}" -z "$PROMPT" \
    || echo "wasix turn exited non-zero: $?"
  echo "wall: $(($(date +%s) - start)) s"
  echo "(if this failed on WAL, rerun with database.journal_mode: delete in $WORK/home-wasix/config.yaml)"
fi

step "done"
echo "Paste this file back into the session: $REPORT"

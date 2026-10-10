"""Turn `uv export` output into the requirements WASIX Python needs.

pip evaluates environment markers against the host, not the target, so we
evaluate them ourselves for a WASIX interpreter. Hermes gates its pins on
python_version >= '3.14'; with --force-pins a 3.13 target still gets them.

usage: filter_reqs.py REQ_TXT TARGET_PY [--force-pins] > filtered.txt
Each output line is `name==version` or `name` (for git/url pins).
"""
import re, sys
from packaging.requirements import Requirement

path, target = sys.argv[1], sys.argv[2]
force = "--force-pins" in sys.argv
env = {
    "python_version": "3.14" if force else target,
    "python_full_version": ("3.14" if force else target) + ".0",
    "sys_platform": "wasi",
    "platform_system": "WASI",
    "platform_machine": "wasm32",
    "platform_release": "",
    "os_name": "posix",
    "implementation_name": "cpython",
    "platform_python_implementation": "CPython",
    "extra": "",
}

text = re.sub(r"\\\n\s*", " ", open(path).read())
for line in text.splitlines():
    line = line.strip()
    if not line or line.startswith(("#", "-")):
        continue
    req = Requirement(line)
    if req.marker and not req.marker.evaluate(env):
        continue
    print(f"{req.name}{req.specifier}" if not req.url else req.name)

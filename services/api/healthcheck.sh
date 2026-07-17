#!/bin/sh
# Container-level health probe. Runs inside the api container.
# Hits /health via the stdlib so we don't need curl in the slim image.
set -e
python - <<'PY'
import urllib.request, sys
try:
    with urllib.request.urlopen("http://127.0.0.1:8000/health", timeout=2) as r:
        sys.exit(0 if r.status == 200 else 1)
except Exception:
    sys.exit(1)
PY

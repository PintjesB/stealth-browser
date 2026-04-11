#!/usr/bin/env bash
# run_local_gate.sh - mirrors the fast verification path used by CI.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [[ -d /dev/shm && -w /dev/shm ]]; then
  export TMPDIR=/dev/shm
fi

step() { echo; echo "[gate] $*"; }
ok()   { echo "  ok: $*"; }

step "secret scan (tree + history)"
python3 scripts/scan_secrets.py --tree --history
ok "no secrets detected"

step "server syntax check"
node --check stealth-server.js
ok "syntax valid"

step "runtime dependency audit"
npm audit --package-lock-only --omit=dev --audit-level=high
ok "no high/critical runtime advisories"

echo
echo "[gate] all checks passed"

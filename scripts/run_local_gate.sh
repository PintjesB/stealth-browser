#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [[ -d /dev/shm && -w /dev/shm ]]; then
  export TMPDIR=/dev/shm
fi

echo "[gate] secret scan"
python3 scripts/scan_secrets.py --tree --history

echo "[gate] syntax check"
node --check stealth-server.js

echo "[gate] npm audit"
npm audit --package-lock-only --omit=dev --audit-level=high

echo "[gate] ok"

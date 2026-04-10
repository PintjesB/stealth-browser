#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

chmod +x .githooks/pre-commit .githooks/pre-push scripts/run_local_gate.sh
git config core.hooksPath .githooks

echo "Git hooks installed for $(basename "$ROOT_DIR")."
echo "core.hooksPath=$(git config --get core.hooksPath)"

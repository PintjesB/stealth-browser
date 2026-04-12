#!/usr/bin/env bash
# .github/scripts/install_git_hooks.sh
# Run once after cloning to wire up the project's git hooks.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

chmod +x \
  .githooks/pre-commit \
  .githooks/pre-push \
  .github/scripts/run_local_gate.sh \
  .github/scripts/scan_secrets.py

git config core.hooksPath .githooks

echo "Git hooks installed for $(basename "$ROOT_DIR")."
echo "  core.hooksPath = $(git config --get core.hooksPath)"
echo
echo "  pre-commit : secret scan (fast)"
echo "  pre-push   : local gate (secret scan / syntax / npm audit)"
echo
echo "  Bypass (emergency only): git push --no-verify"

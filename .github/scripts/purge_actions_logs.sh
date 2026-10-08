#!/usr/bin/env bash
# One-time pre-publication cleanup. Permanently deletes historical Actions logs.
# Needs GitHub CLI authenticated with repo access and Actions:write permission.
set -euo pipefail

repo="PintjesB/stealth-browser"
mode="${1:---dry-run}"

if [[ "$mode" != "--dry-run" && "$mode" != "--delete" ]]; then
  printf 'Usage: %s [--dry-run|--delete]\n' "$0" >&2
  exit 2
fi

command -v gh >/dev/null || { echo "GitHub CLI (gh) is required" >&2; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "Authenticate using gh auth login first" >&2; exit 1; }

# Capture API responses before processing, so failures cannot silently produce
# a partial list via a process substitution.
runs="$(gh api --paginate --jq '.workflow_runs[] | select(.status == "completed") | .id' "repos/$repo/actions/runs?per_page=100")"
artifacts="$(gh api --paginate --jq '.artifacts[] | select(.expired != true) | .id' "repos/$repo/actions/artifacts?per_page=100")"

if [[ -n "$artifacts" ]]; then
  count="$(printf '%s\n' "$artifacts" | wc -l | tr -d ' ')"
  echo "WARNING: $count unexpired Actions artifact(s) still exist. Review/remove them before publication." >&2
fi

if [[ -z "$runs" ]]; then
  echo "No completed workflow runs found."
  exit 0
fi

count="$(printf '%s\n' "$runs" | wc -l | tr -d ' ')"
echo "Repository: $repo"
echo "Completed workflow runs: $count"

if [[ "$mode" == "--dry-run" ]]; then
  echo "DRY RUN: no logs deleted. Run with --delete to delete all completed-run logs permanently."
  exit 0
fi

deleted=0
failed=0
while IFS= read -r run_id; do
  [[ -n "$run_id" ]] || continue
  # Do not print response bodies or log content.
  if gh api --method DELETE "repos/$repo/actions/runs/$run_id/logs" >/dev/null 2>/dev/null; then
    ((deleted+=1))
  else
    ((failed+=1))
    printf 'Unable to confirm log deletion for run %s\n' "$run_id" >&2
  fi
done <<< "$runs"

echo "Confirmed deletions: $deleted / $count. Unconfirmed: $failed."
if (( failed != 0 )); then
  echo "Do not make the repository public until every remaining run is verified safe or its logs are removed." >&2
  exit 1
fi
if [[ -n "$artifacts" ]]; then
  echo "Logs removed. Outstanding artifacts still require separate review." >&2
  exit 1
fi
echo "Log cleanup complete. Review other repository disclosures before making it public."

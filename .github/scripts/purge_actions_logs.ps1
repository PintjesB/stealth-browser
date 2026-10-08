# One-time pre-publication cleanup for Windows PowerShell.
# Requires GitHub CLI authenticated with Actions write permission.
# Default mode is a safe dry run. -Delete permanently removes old run logs.
[CmdletBinding()]
param(
    [switch]$Delete
)

$ErrorActionPreference = 'Stop'
$repo = 'PintjesB/stealth-browser'
$uri = "repos/$repo/actions/runs?per_page=100"

if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
    throw 'GitHub CLI (gh) is required. Install it and reopen PowerShell.'
}

& gh auth status *> $null
if ($LASTEXITCODE -ne 0) {
    throw 'GitHub CLI is not authenticated. Run gh auth login.'
}

# Capture and verify complete paginated responses before performing deletion.
$runRows = @(& gh api --paginate --jq '.workflow_runs[] | [.id, .status] | @tsv' $uri)
if ($LASTEXITCODE -ne 0) {
    throw 'Failed to enumerate workflow runs.'
}

$completed = [System.Collections.Generic.List[string]]::new()
$active = [System.Collections.Generic.List[string]]::new()
foreach ($row in $runRows) {
    if ($row -notmatch '^(\d+)\t([a-z_]+)$') {
        throw 'Unexpected workflow run response. Aborting.'
    }
    if ($Matches[2] -eq 'completed') {
        $completed.Add($Matches[1])
    }
    else {
        $active.Add($Matches[1])
    }
}

$artifacts = @(& gh api --paginate --jq '.artifacts[] | select(.expired != true) | .id' "repos/$repo/actions/artifacts?per_page=100")
if ($LASTEXITCODE -ne 0) {
    throw 'Failed to enumerate Actions artifacts.'
}

Write-Host "Repository: $repo"
Write-Host "Completed workflow runs: $($completed.Count)"
Write-Host "Active workflow runs: $($active.Count)"
Write-Host "Unexpired artifacts: $($artifacts.Count)"

if (-not $Delete) {
    Write-Host 'DRY RUN: nothing deleted. Run again with -Delete to remove completed-run logs.'
    return
}
if ($active.Count -gt 0) {
    throw 'Active workflow runs can create new logs. Stop or complete them before cleanup.'
}
if ($artifacts.Count -gt 0) {
    throw 'Unexpired artifacts require review or removal before publication.'
}

$deleted = 0
$failed = 0
foreach ($runId in $completed) {
    # Do not echo API response bodies or log content.
    & gh api --method DELETE "repos/$repo/actions/runs/$runId/logs" *> $null
    if ($LASTEXITCODE -eq 0) {
        $deleted++
    }
    else {
        $failed++
        Write-Warning "Unable to confirm log deletion for run $runId"
    }
}

Write-Host "Confirmed log deletions: $deleted / $($completed.Count). Failed: $failed"
if ($failed -gt 0) {
    throw 'Some logs could not be deleted. Keep the repository private.'
}
Write-Host 'Historical completed-run logs have been deleted. Recheck visibility risks before publishing.'

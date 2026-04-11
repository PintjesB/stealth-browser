#!/usr/bin/env python3
"""Scan the git working tree and/or full reachable history for secret-like material.

Usage
-----
  python3 scripts/scan_secrets.py              # both tree + history (default)
  python3 scripts/scan_secrets.py --tree       # tracked files only
  python3 scripts/scan_secrets.py --history    # git history only
"""

from __future__ import annotations

import argparse
import pathlib
import re
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]

ALLOWLIST_SUBSTRINGS: frozenset[str] = frozenset({
    "https://discord.com/api/webhooks/1/test",
    "replace-me",
    "changeme",
    "<your-token-here>",
})

PATTERNS: dict[str, re.Pattern[str]] = {
    "discord_webhook": re.compile(
        r"https://(?:discord|discordapp)\.com/api/webhooks/\d+/[A-Za-z0-9._-]+"
    ),
    "github_pat": re.compile(r"github_pat_[A-Za-z0-9_]{20,}"),
    "github_token": re.compile(r"\bgh[pousr]_[A-Za-z0-9]{20,}\b"),
    "aws_access_key": re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    "google_api_key": re.compile(r"\bAIza[0-9A-Za-z_-]{20,}\b"),
    "openai_style_secret": re.compile(r"\bsk-[A-Za-z0-9]{20,}\b"),
    "slack_token": re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{10,}\b"),
    "private_key_header": re.compile(r"-----BEGIN [A-Z ]+PRIVATE KEY-----"),
    "generic_secret_assignment": re.compile(
        r"(?i)\b(?:password|passwd|pwd|secret|api[_-]?key|client[_-]?secret|"
        r"(?:access|refresh|admin|auth|bearer|github|client)[_-]?token)\b"
        r"\s*[:=]\s*['\"]?"
        r"(?!replace-me\b|changeme\b|example\b|sample\b|dummy\b|test\b|your-|<)"
        r"[A-Za-z0-9._~+/\-=]{12,}"
        r"['\"]?"
    ),
}


def _run(*args: str) -> str:
    proc = subprocess.run(args, cwd=ROOT, check=False, capture_output=True, text=True)
    if proc.returncode not in (0, 1):
        raise RuntimeError(proc.stderr.strip() or f"command failed: {' '.join(args)}")
    return proc.stdout


def _is_allowed(match: str) -> bool:
    return any(fragment in match for fragment in ALLOWLIST_SUBSTRINGS)


def scan_tree() -> list[str]:
    findings: list[str] = []
    tracked = [path for path in _run("git", "ls-files").splitlines() if path]
    for rel_path in tracked:
        path = ROOT / rel_path
        if not path.exists():
            continue
        try:
            content = path.read_text(encoding="utf-8", errors="strict")
        except (UnicodeDecodeError, OSError):
            continue
        for name, pattern in PATTERNS.items():
            for match in pattern.finditer(content):
                token = match.group(0)
                if _is_allowed(token):
                    continue
                line_no = content.count("\n", 0, match.start()) + 1
                findings.append(f"tree  {rel_path}:{line_no}  [{name}]  {token[:80]}")
    return findings


def scan_history() -> list[str]:
    findings: list[str] = []
    revs = [rev for rev in _run("git", "rev-list", "--all").splitlines() if rev]
    if not revs:
        return findings
    for name, pattern in PATTERNS.items():
        proc = subprocess.run(
            ["git", "grep", "-nIP", "-e", pattern.pattern, *revs],
            cwd=ROOT,
            check=False,
            capture_output=True,
            text=True,
        )
        if proc.returncode not in (0, 1):
            raise RuntimeError(proc.stderr.strip() or f"git grep failed for pattern '{name}'")
        for line in proc.stdout.splitlines():
            if _is_allowed(line):
                continue
            findings.append(f"history  [{name}]  {line[:120]}")
    return findings


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--tree", action="store_true", help="Scan tracked files in the working tree.")
    parser.add_argument("--history", action="store_true", help="Scan full reachable git history.")
    args = parser.parse_args()

    do_tree = args.tree or not (args.tree or args.history)
    do_history = args.history or not (args.tree or args.history)

    findings: list[str] = []
    if do_tree:
        findings.extend(scan_tree())
    if do_history:
        findings.extend(scan_history())

    if findings:
        print("Secret scan FAILED. Findings:", file=sys.stderr)
        for finding in findings:
            print(f"  {finding}", file=sys.stderr)
        print(
            "\nIf a finding is a false positive, add the exact substring to "
            "ALLOWLIST_SUBSTRINGS in scripts/scan_secrets.py.",
            file=sys.stderr,
        )
        return 1

    print("Secret scan passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

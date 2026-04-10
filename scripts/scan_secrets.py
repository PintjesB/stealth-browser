#!/usr/bin/env python3
import argparse
import pathlib
import re
import subprocess
import sys

PATTERNS = {
    "discord_webhook": re.compile(r"https://discord(?:app)?\.com/api/webhooks/\d+/[A-Za-z0-9._-]+"),
    "github_pat": re.compile(r"github_pat_[A-Za-z0-9_]{20,}"),
    "github_classic": re.compile(r"\bgh[pousr]_[A-Za-z0-9]{20,}\b"),
    "aws_access_key": re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    "google_api_key": re.compile(r"\bAIza[0-9A-Za-z\-_]{35}\b"),
    "openai_key": re.compile(r"\bsk-[A-Za-z0-9]{20,}\b"),
    "slack_token": re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{10,}\b"),
    "private_key": re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----"),
}

ALLOWLIST = {
    "https://discord.com/api/webhooks/1/test",
}


def run(cmd):
    return subprocess.run(cmd, check=True, capture_output=True, text=True)


def tracked_files():
    output = run(["git", "ls-files"]).stdout.splitlines()
    return [pathlib.Path(path) for path in output if path]


def scan_tree():
    findings = []
    for file_path in tracked_files():
        try:
            content = file_path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        for name, pattern in PATTERNS.items():
            for match in pattern.finditer(content):
                if match.group(0) in ALLOWLIST:
                    continue
                line = content.count("\n", 0, match.start()) + 1
                findings.append(f"tree:{file_path}:{line}:{name}")
    return findings


def scan_history():
    findings = []
    revisions = run(["git", "rev-list", "--all"]).stdout.splitlines()
    if not revisions:
        return findings
    for name, pattern in PATTERNS.items():
        grep = subprocess.run(
            ["git", "grep", "-nIP", "-e", pattern.pattern, *revisions],
            capture_output=True,
            text=True,
            check=False,
        )
        for line in grep.stdout.splitlines():
            if any(allowed in line for allowed in ALLOWLIST):
                continue
            findings.append(f"history:{name}:{line}")
    return findings


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--tree", action="store_true")
    parser.add_argument("--history", action="store_true")
    args = parser.parse_args()

    if not args.tree and not args.history:
        parser.error("select at least one scan mode")

    findings = []
    if args.tree:
        findings.extend(scan_tree())
    if args.history:
        findings.extend(scan_history())

    if findings:
        print("\n".join(findings))
        return 1
    print("secret scan passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())

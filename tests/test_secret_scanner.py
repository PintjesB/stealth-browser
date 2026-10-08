"""Regression tests for redaction in source and Git history scans."""

import importlib.util
import pathlib
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch


ROOT = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location(
    "secret_scanner", ROOT / ".github" / "scripts" / "scan_secrets.py"
)
scanner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scanner)


class SecretScannerRedactionTests(unittest.TestCase):
    def test_tree_never_includes_matched_secret(self):
        candidate = "ghp_" + ("z" * 40)
        with tempfile.TemporaryDirectory() as directory:
            pathlib.Path(directory, "fixture.txt").write_text(
                "token=" + candidate + "\n", encoding="utf-8"
            )
            with patch.object(scanner, "ROOT", pathlib.Path(directory)):
                with patch.object(scanner, "_run", return_value="fixture.txt\n"):
                    findings = scanner.scan_tree()

        self.assertEqual(len(findings), 1)
        self.assertIn("tree  fixture.txt:1  [github_token]", findings)
        self.assertNotIn(candidate, repr(findings))
        self.assertNotIn(candidate[:16], repr(findings))

    def test_history_redacts_source_and_checks_allowlist_per_match(self):
        candidate = "ghp_" + ("z" * 40)
        revision = "a" * 40
        # The safe allowlist marker must not hide another match on the same line.
        source = "replace-me; token=" + candidate
        git_grep = f"{revision}:fixture.txt:7:{source}\n"

        def fake_run(argv, **_kwargs):
            if argv[:2] == ["git", "grep"] and argv[-1] == revision:
                if "gh[pousr]_" in argv[3]:
                    return SimpleNamespace(returncode=0, stdout=git_grep, stderr="")
            return SimpleNamespace(returncode=1, stdout="", stderr="")

        with patch.object(scanner, "_run", return_value=revision + "\n"):
            with patch.object(scanner.subprocess, "run", side_effect=fake_run):
                findings = scanner.scan_history()

        self.assertEqual(len(findings), 1)
        self.assertEqual(findings[0], f"history  {revision[:12]}:fixture.txt:7  [github_token]")
        self.assertNotIn(candidate, repr(findings))
        self.assertNotIn(source, repr(findings))

    def test_history_never_echoes_unparseable_match_line(self):
        candidate = "ghp_" + ("z" * 40)
        with patch.object(scanner, "_run", return_value="a" * 40 + "\n"):
            with patch.object(
                scanner.subprocess,
                "run",
                return_value=SimpleNamespace(
                    returncode=0, stdout=candidate + "\n", stderr=""
                ),
            ):
                findings = scanner.scan_history()
        self.assertTrue(findings)
        self.assertNotIn(candidate, repr(findings))


if __name__ == "__main__":
    unittest.main()

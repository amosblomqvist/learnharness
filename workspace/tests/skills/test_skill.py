"""The skill remains a portable folder, not an integration with the app."""

from __future__ import annotations

import ast
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True
REPO = Path(__file__).resolve().parents[2]
SKILL = REPO / "skills" / "learnharness"
GOLDEN = REPO / "tests" / "fixtures" / "golden-data"


def snapshot(root):
    return {
        path.relative_to(root).as_posix(): (path.read_bytes(), path.stat().st_mtime_ns) if path.is_file() else None
        for path in root.rglob("*")
    }


class SkillFolderTest(unittest.TestCase):
    def test_portable_frontmatter_and_local_reference(self):
        text = (SKILL / "SKILL.md").read_text(encoding="utf-8")
        frontmatter = text.split("---", 2)[1]
        fields = dict(line.split(": ", 1) for line in frontmatter.strip().splitlines())
        self.assertEqual(fields["name"], SKILL.name)
        self.assertTrue(0 < len(fields["description"]) <= 1024)
        self.assertTrue(0 < len(fields["compatibility"]) <= 500)
        self.assertEqual(fields["license"], "AGPL-3.0-only")
        self.assertLess(len(text.splitlines()), 500)
        self.assertIn("references/data-format.md", text)
        self.assertTrue((SKILL / "references" / "data-format.md").is_file())
        self.assertIn("Never modify LearnHarness's data", text)
        self.assertIn("archival view", text)
        self.assertNotIn("/Users/amos/", text)

    def test_license_is_bundled_for_a_standalone_copy(self):
        self.assertEqual((SKILL / "LICENSE").read_bytes(), (REPO / "LICENSE").read_bytes())
        self.assertIn("GNU AFFERO GENERAL PUBLIC LICENSE", (SKILL / "LICENSE").read_text(encoding="utf-8"))

    def test_python_syntax_supports_declared_minimum(self):
        for script in (SKILL / "scripts").glob("*.py"):
            with self.subTest(script=script.name):
                ast.parse(script.read_text(encoding="utf-8"), filename=str(script), feature_version=(3, 10))

    def test_copied_skill_runs_outside_repository_and_creates_no_cache_or_data(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            skill = base / "standalone" / "learnharness"
            data = base / "learning-data"
            elsewhere = base / "unrelated-working-directory"
            elsewhere.mkdir()
            shutil.copytree(SKILL, skill)
            shutil.copytree(GOLDEN, data)
            before_skill = snapshot(skill)
            before_data = snapshot(data)
            env = dict(os.environ)
            env.pop("PYTHONDONTWRITEBYTECODE", None)
            env.pop("PYTHONPATH", None)
            commands = [
                ("sessions.py", ["list"]),
                ("sessions.py", ["read", "chat_mv27rrra_feff23b6"]),
                ("sessions.py", ["read", "chat_mv293wv5_10656952"]),
                ("sessions.py", ["read", "chat_mv293wv5_10656952", "--include-agent-thinking", "--include-operations"]),
                ("graph.py", ["sessions"]),
                ("graph.py", ["propositions"]),
                ("graph.py", ["find", "*"]),
                ("graph.py", ["chains"]),
                ("graph.py", ["chains", "--node", "n_nonexistent"]),
            ]
            for filename, arguments in commands:
                for output_format in ("markdown", "json"):
                    with self.subTest(script=filename, arguments=arguments, format=output_format):
                        # Deliberately omit -B here: the entrypoints must disable
                        # bytecode before importing their helper on their own.
                        completed = subprocess.run(
                            [sys.executable, str(skill / "scripts" / filename), "--data-dir", str(data), "--format", output_format, *arguments],
                            cwd=elsewhere, env=env, capture_output=True, text=True, encoding="utf-8", timeout=30,
                        )
                        self.assertEqual(completed.returncode, 0, completed.stderr)
                        self.assertTrue(completed.stdout.strip())
                        if output_format == "json":
                            result = json.loads(completed.stdout)
                            self.assertEqual(result["data_dir"], str(data.resolve()))
                        else:
                            self.assertIn(str(data.resolve()), completed.stdout)
            self.assertEqual(snapshot(skill), before_skill)
            self.assertEqual(snapshot(data), before_data)
            self.assertEqual(list(elsewhere.iterdir()), [])


if __name__ == "__main__":
    unittest.main()

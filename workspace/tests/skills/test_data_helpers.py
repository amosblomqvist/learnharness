"""Filesystem boundary and portability tests for the standalone skill."""

from __future__ import annotations

import argparse
import contextlib
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
SCRIPTS = Path(__file__).resolve().parents[2] / "skills" / "learnharness" / "scripts"
sys.path.insert(0, str(SCRIPTS))
import _data


class DataHelpersTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name)
        self.root = self.base / "data"
        self.root.mkdir()

    def tearDown(self):
        self.temp.cleanup()

    def record(self, **changes):
        value = {
            "id": "chat_one", "title": "A lesson", "createdAt": "2026-10-01T00:00:00Z",
            "updatedAt": "2026-10-02T00:00:00Z", "messages": [],
        }
        value.update(changes)
        return value

    def save_chat(self, **changes):
        (self.root / "chats").mkdir(exist_ok=True)
        (self.root / "chats" / "chat_one.json").write_text(json.dumps(self.record(**changes)), encoding="utf-8")

    def test_explicit_existing_root(self):
        self.assertEqual(_data.data_root(str(self.root)), self.root.resolve())

    def test_missing_root_is_not_created(self):
        target = self.base / "not-created"
        with self.assertRaisesRegex(_data.DataError, "nothing was created"):
            _data.data_root(str(target))
        self.assertFalse(target.exists())

    def test_mac_standard_root(self):
        expected = self.base / "Library" / "Application Support" / "LearnHarness" / "data"
        expected.mkdir(parents=True)
        with patch.object(_data.sys, "platform", "darwin"), patch.object(Path, "home", return_value=self.base):
            self.assertEqual(_data.data_root(), expected.resolve())

    def test_windows_standard_root(self):
        expected = self.base / "roaming" / "LearnHarness" / "data"
        expected.mkdir(parents=True)
        with patch.object(_data.sys, "platform", "win32"), patch.dict(os.environ, {"APPDATA": str(self.base / "roaming")}):
            self.assertEqual(_data.data_root(), expected.resolve())

    def test_windows_missing_appdata_requires_explicit_root(self):
        with patch.object(_data.sys, "platform", "win32"), patch.dict(os.environ, {}, clear=True):
            with self.assertRaisesRegex(_data.DataError, "--data-dir"):
                _data.data_root()

    def test_linux_xdg_and_fallback(self):
        xdg = self.base / "config"
        expected = xdg / "LearnHarness" / "data"
        expected.mkdir(parents=True)
        with patch.object(_data.sys, "platform", "linux"), patch.dict(os.environ, {"XDG_CONFIG_HOME": str(xdg)}):
            self.assertEqual(_data.data_root(), expected.resolve())
        fallback = self.base / ".config" / "LearnHarness" / "data"
        fallback.mkdir(parents=True)
        with patch.object(_data.sys, "platform", "linux"), patch.object(Path, "home", return_value=self.base), patch.dict(os.environ, {}, clear=True):
            self.assertEqual(_data.data_root(), fallback.resolve())

    def test_relative_xdg_is_explicit_error(self):
        with patch.object(_data.sys, "platform", "linux"), patch.dict(os.environ, {"XDG_CONFIG_HOME": "relative"}):
            with self.assertRaisesRegex(_data.DataError, "relative"):
                _data.data_root()

    def test_explicit_root_works_on_unknown_os(self):
        with patch.object(_data.sys, "platform", "unknown"):
            self.assertEqual(_data.data_root(str(self.root)), self.root.resolve())
            with self.assertRaisesRegex(_data.DataError, "--data-dir"):
                _data.data_root()

    def test_safe_path_rejects_traversal_and_absolute_paths(self):
        self.assertEqual(_data.safe_path(self.root, "chats/chat_one.json"), self.root.resolve() / "chats" / "chat_one.json")
        for relative in ("../auth.json", self.base / "outside.json"):
            with self.subTest(path=relative), self.assertRaises(_data.DataError):
                _data.safe_path(self.root, relative)

    def test_safe_path_rejects_escaping_symlink(self):
        outside = self.base / "private.json"
        outside.write_text('{"unrelated": true}', encoding="utf-8")
        try:
            (self.root / "link.json").symlink_to(outside)
        except (OSError, NotImplementedError):
            self.skipTest("Symlinks unavailable for this user")
        with self.assertRaisesRegex(_data.DataError, "outside"):
            _data.read_json(self.root, "link.json")

    def test_json_read_missing_and_malformed_without_writes(self):
        self.assertEqual(_data.read_json(self.root, "optional.json", missing=[]), [])
        target = self.root / "bad.json"
        target.write_text("{", encoding="utf-8")
        with self.assertRaisesRegex(_data.DataError, "Cannot read"):
            _data.read_json(self.root, "bad.json")
        self.assertEqual(target.read_text(encoding="utf-8"), "{")
        self.assertEqual([p.name for p in self.root.iterdir()], ["bad.json"])

    def test_non_json_constants_are_not_accepted(self):
        (self.root / "bad.json").write_text('{"value": NaN}', encoding="utf-8")
        with self.assertRaises(_data.DataError):
            _data.read_json(self.root, "bad.json")

    def test_unstamped_native_chat_is_read_without_stamping(self):
        self.save_chat()
        target = self.root / "chats" / "chat_one.json"
        before = target.read_bytes()
        self.assertEqual(_data.read_chat(self.root, "chat_one"), self.record())
        self.assertEqual(target.read_bytes(), before)
        self.assertEqual(sorted(p.relative_to(self.root).as_posix() for p in self.root.rglob("*")), ["chats", "chats/chat_one.json"])

    def test_future_chat_version_is_refused(self):
        self.save_chat(version=2)
        with self.assertRaisesRegex(_data.DataError, "Update the skill"):
            _data.read_chat(self.root, "chat_one")
        self.save_chat(version=True)
        with self.assertRaisesRegex(_data.DataError, "invalid version"):
            _data.read_chat(self.root, "chat_one")

    def test_pre_native_parts_dialect_is_not_silently_empty(self):
        self.save_chat(messages=[{"role": "user", "parts": [{"type": "text", "text": "old shape"}]}])
        with self.assertRaisesRegex(_data.DataError, "older UIMessage"):
            _data.read_chat(self.root, "chat_one")

    def test_read_chat_rejects_missing_and_mismatched_records(self):
        with self.assertRaisesRegex(_data.DataError, "not found"):
            _data.read_chat(self.root, "chat_one")
        self.save_chat(id="chat_other")
        with self.assertRaisesRegex(_data.DataError, "mismatch"):
            _data.read_chat(self.root, "chat_one")

    def test_read_chat_rejects_path_in_place_of_id(self):
        for value in ("../auth", "..", "", "chats/chat_one", "chats\\chat_one"):
            with self.subTest(value=value), self.assertRaises(_data.DataError):
                _data.read_chat(self.root, value)

    def test_common_flags_and_unicode_json(self):
        parser = argparse.ArgumentParser()
        _data.add_common_arguments(parser)
        args = parser.parse_args(["--data-dir", str(self.root), "--format", "json"])
        self.assertEqual(args.data_dir, str(self.root))
        self.assertEqual(args.format, "json")
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            _data.print_json({"statement": "∇ and café"})
        self.assertIn("∇", out.getvalue())
        self.assertEqual(json.loads(out.getvalue()), {"statement": "∇ and café"})


if __name__ == "__main__":
    unittest.main()

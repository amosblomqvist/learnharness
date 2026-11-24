"""Portable, read-only graph CLI tests; no application-store imports."""

import contextlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True
SCRIPTS = Path(__file__).resolve().parents[2] / "skills" / "learnharness" / "scripts"
sys.path.insert(0, str(SCRIPTS))
import graph

GOLDEN = Path(__file__).resolve().parents[1] / "fixtures" / "golden-data"


def snapshot(root):
    """Notice both changed bytes/mtimes and newly created files/directories."""
    return {
        str(path.relative_to(root)): (path.read_bytes(), path.stat().st_mtime_ns) if path.is_file() else None
        for path in root.rglob("*")
    }


def point(chat, message=""):
    return {"chatId": chat, "messageId": message}


def node(identifier, session=None, **updates):
    value = {
        "id": identifier, "name": f"Name {identifier}",
        "statement": f"Full statement {identifier}", "aliases": [],
        "createdAt": "2026-01-01T00:00:00Z",
        "provenance": [] if session is None else [point(session)],
    }
    value.update(updates)
    return value


def chain(identifier, premises, conclusion, session, **updates):
    value = {
        "id": identifier, "premises": premises, "conclusion": conclusion,
        "createdAt": "2026-01-02T00:00:00Z", "provenance": [point(session)],
    }
    value.update(updates)
    return value


class GraphTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def write_json(self, relative, value):
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")

    def write_ledger(self, name, records):
        path = self.root / "graph" / f"{name}.jsonl"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("".join(json.dumps(record, ensure_ascii=False) + "\n" for record in records), encoding="utf-8")

    def invoke(self, *arguments, format="json", root=None):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            status = graph.main(["--data-dir", str(root or self.root), "--format", format, *arguments])
        return status, out.getvalue(), err.getvalue()

    def result(self, *arguments, root=None):
        status, output, diagnostics = self.invoke(*arguments, root=root)
        self.assertEqual(status, 0, diagnostics)
        self.assertEqual(diagnostics, "")
        payload = json.loads(output)
        self.assertEqual(payload["data_dir"], str((root or self.root).resolve()))
        return payload["records"]

    def fixture(self):
        self.write_ledger("nodes", [
            node("n_b", "chat_old", name="Identity stands", statement="First precise statement", aliases=["Original wording"], provenance=[point("chat_old", "m1")], extra="preserved"),
            node("n_a", "src_notes", name="Café", statement="A separate proposition.", aliases=["Literal [brackets]?", "two\nlines"]),
            node("n_b", "chat_new", name="Name must not replace", statement="Later restatement", aliases=["Original wording", "Another phrasing", ""], createdAt="2099-01-01", provenance=[point("chat_old", "m1"), point("chat_new", "m2"), point("chat_new", "m2")]),
            node("n_empty"),
            node("n_surviving", "chat_new"),
            node("n_unknown", "missing_record"),
        ])
        self.write_ledger("chains", [
            chain("arg_first", ["n_b", "n_a"], "n_surviving", "chat_old", extra="preserved"),
            chain("arg_other_id", ["n_a", "n_b"], "n_surviving", "chat_new", createdAt="2099-01-01"),
            chain("arg_single", ["n_surviving"], "n_a", "src_notes"),
            chain("arg_dangling", ["n_missing"], "n_a", "chat_old"),
        ])
        for identifier, title, updated in [
            ("chat_old", "Old conversation", "2026-02-01T00:00:00Z"),
            ("chat_new", "Recent conversation", "2026-03-01T00:00:00Z"),
            ("chat_without_nodes", "Not a birth session", "2099-01-01"),
        ]:
            self.write_json(f"chats/{identifier}.json", {
                "id": identifier, "title": title, "createdAt": "2026-01-01T00:00:00Z",
                "updatedAt": updated, "messages": [],
            })
        self.write_json("graph/sources.json", {
            "src_notes": {"id": "src_notes", "filePath": "/never/open/these notes.md", "importedAt": "2026-02-15T00:00:00Z"},
        })

    def test_merge_nodes_first_identity_and_union(self):
        self.fixture()
        before = snapshot(self.root)
        merged = self.result("propositions")
        self.assertEqual([item["id"] for item in merged], ["n_a", "n_b", "n_empty", "n_surviving", "n_unknown"])
        value = next(item for item in merged if item["id"] == "n_b")
        self.assertEqual(value["name"], "Identity stands")
        self.assertEqual(value["statement"], "First precise statement")
        self.assertEqual(value["createdAt"], "2026-01-01T00:00:00Z")
        self.assertEqual(value["aliases"], ["Original wording", "Later restatement", "Another phrasing"])
        self.assertEqual(value["provenance"], [point("chat_old", "m1"), point("chat_new", "m2")])
        self.assertEqual(value["extra"], "preserved")
        self.assertEqual(snapshot(self.root), before)

    def test_chain_key_identity_provenance_and_endpoint_filter(self):
        self.fixture()
        merged = self.result("chains")
        self.assertEqual([item["id"] for item in merged], ["arg_first", "arg_single", "arg_dangling"])
        self.assertEqual(merged[0]["premises"], ["n_b", "n_a"])
        self.assertEqual(merged[0]["createdAt"], "2026-01-02T00:00:00Z")
        self.assertEqual(merged[0]["extra"], "preserved")
        self.assertEqual(merged[0]["provenance"], [point("chat_old"), point("chat_new")])
        self.assertEqual(self.result("chains", "--node", "n_b"), merged[:1])
        self.assertEqual(len(self.result("chains", "--node", "n_a")), 3)
        self.assertEqual(self.result("chains", "--node", "no-such-node"), [])

    def test_birth_index_metadata_and_filter(self):
        self.fixture()
        sessions = self.result("sessions")
        self.assertEqual([item["id"] for item in sessions], ["chat_new", "src_notes", "chat_old", "missing_record"])
        self.assertEqual([item["propositions"] for item in sessions], [1, 1, 1, 1])
        self.assertEqual(sessions[0]["kind"], "chat")
        self.assertEqual(sessions[0]["name"], "Recent conversation")
        self.assertEqual(sessions[1]["name"], "/never/open/these notes.md")
        self.assertEqual(sessions[-1], {"id": "missing_record", "name": "missing_record", "kind": "file", "createdAt": None, "updatedAt": None, "propositions": 1})
        self.assertEqual([item["id"] for item in self.result("propositions", "--session", "chat_new")], ["n_surviving"])
        self.assertEqual([item["id"] for item in self.result("propositions", "--session", "chat_old")], ["n_b"])
        self.assertEqual(self.result("propositions", "--session", "nonexistent"), [])

    def test_bad_chat_metadata_is_isolated_and_diagnosed(self):
        self.fixture()
        corrupted = self.root / "chats" / "chat_old.json"
        corrupted.write_text("{torn", encoding="utf-8")
        self.write_json("chats/chat_future.json", {
            "id": "chat_future", "title": "Future metadata", "createdAt": "2026-01-01",
            "updatedAt": "2026-01-01", "version": 2, "messages": [],
        })
        self.write_json("chats/src_notes.json", {
            "id": "src_notes", "title": "Older parts metadata", "createdAt": "2026-01-01",
            "updatedAt": "2026-01-01", "messages": [{"role": "assistant", "parts": []}],
        })
        self.write_json("chats/chat_mismatch.json", {
            "id": "another_id", "title": "Wrong filename", "createdAt": "2026-01-01",
            "updatedAt": "2026-01-01", "messages": [],
        })
        before = snapshot(self.root)
        for arguments, format in [(("sessions",), "json"), (("propositions",), "markdown")]:
            with self.subTest(arguments=arguments):
                status, output, diagnostics = self.invoke(*arguments, format=format)
                self.assertEqual(status, 0, diagnostics)
                for name in ("chat_old.json", "chat_future.json", "src_notes.json", "chat_mismatch.json"):
                    self.assertIn(name, diagnostics)
                for reason in ("format 2", "older UIMessage/parts", "filename/ID mismatch", "skipped"):
                    self.assertIn(reason, diagnostics)
                if format == "json":
                    sessions = {item["id"]: item for item in json.loads(output)["records"]}
                    self.assertEqual(sessions["chat_old"]["name"], "chat_old")
                    self.assertIsNone(sessions["chat_old"]["createdAt"])
                    self.assertEqual(sessions["chat_new"]["name"], "Recent conversation")
                    self.assertEqual(sessions["src_notes"]["name"], "/never/open/these notes.md")
                else:
                    self.assertIn("First precise statement", output)
                    self.assertIn("Recent conversation", output)
                    self.assertIn("/never/open/these notes.md", output)
        self.assertEqual(snapshot(self.root), before)

    def test_explicit_empty_query_and_ids_rejected_but_whitespace_accepted(self):
        for arguments in (("find", ""), ("propositions", "--session", ""), ("chains", "--node", "")):
            with self.subTest(arguments=arguments):
                out, err = io.StringIO(), io.StringIO()
                with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                    with self.assertRaises(SystemExit) as raised:
                        graph.main(["--data-dir", str(self.root), *arguments])
                self.assertEqual(raised.exception.code, 2)
                self.assertEqual(out.getvalue(), "")
                self.assertIn("must not be empty", err.getvalue())
        for arguments in (("find", " "), ("propositions", "--session", " "), ("chains", "--node", " ")):
            self.assertEqual(self.result(*arguments), [])
        self.assertEqual(list(self.root.iterdir()), [])

    def test_empty_first_provenance_acquires_birth_from_surviving_link(self):
        self.write_ledger("nodes", [node("n_x"), node("n_x", "survivor")])
        self.assertEqual([item["id"] for item in self.result("propositions", "--session", "survivor")], ["n_x"])
        self.assertEqual(self.result("sessions")[0]["id"], "survivor")

    def test_session_order_timestamp_ties_then_stable_id(self):
        self.write_ledger("nodes", [node("n_b", "b"), node("n_a", "a"), node("n_c", "c")])
        self.assertEqual([item["id"] for item in self.result("sessions")], ["a", "b", "c"])

    def test_find_matches_names_statements_aliases_and_literal_punctuation(self):
        self.fixture()
        for query in ("IDENTITY", "precise", "later RESTATEMENT", "another phrasing"):
            self.assertEqual([item["id"] for item in self.result("find", query)], ["n_b"])
        self.assertEqual([item["id"] for item in self.result("find", "[brackets]?")], ["n_a"])
        self.assertEqual([item["id"] for item in self.result("find", "Café")], ["n_a"])
        self.assertEqual(self.result("find", "n_b"), [])  # IDs are not searchable fields.
        self.assertEqual(self.result("find", "Name must not replace"), [])
        self.assertEqual(self.result("find", " no such text "), [])

    def test_find_case_matching_agrees_with_app_js_regex(self):
        self.write_ledger("nodes", [node("n_case", name="Exact label", statement="Exact statement", aliases=["K", "ſ", "ı", "İ", "ς", "𐐨", "Café"])])
        for query in ("k", "s", "i", "𐐀"):
            # Explicit stars avoid unrelated substring matches in the name.
            self.assertEqual(self.result("find", query + "*"), [], query)
        for query in ("K*", "ſ*", "ı*", "İ*", "σ*", "𐐨*", "CAFÉ*"):
            self.assertEqual([item["id"] for item in self.result("find", query)], ["n_case"], query)

    def test_find_star_glob_newlines_and_ledger_order(self):
        self.fixture()
        self.assertEqual([item["id"] for item in self.result("find", "*statement*")], ["n_b", "n_empty", "n_surviving", "n_unknown"])
        self.assertEqual([item["id"] for item in self.result("find", "two*lines")], ["n_a"])
        self.assertEqual(self.result("find", "precise*"), [])
        self.assertEqual(len(self.result("find", "*")), 5)

    def test_missing_ledgers_empty_graph_and_no_directory_creation(self):
        for command in ("sessions", "propositions", "chains"):
            self.assertEqual(self.result(command), [])
        self.assertEqual(self.result("find", "anything"), [])
        self.assertEqual(list(self.root.iterdir()), [])
        status, output, diagnostics = self.invoke("propositions", format="markdown")
        self.assertEqual(status, 0, diagnostics)
        self.assertIn("No matching records", output)
        self.assertEqual(list(self.root.iterdir()), [])

    def test_malformed_and_wrong_shape_lines_warn_instead_of_silent_loss(self):
        self.write_ledger("nodes", [node("n_ok", "source")])
        path = self.root / "graph" / "nodes.jsonl"
        with path.open("a", encoding="utf-8") as handle:
            handle.write('\n{"torn":\n{"id":"bad"}\nnull\n')
        self.write_ledger("chains", [chain("arg_bad", [], "n_ok", "source")])
        before = snapshot(self.root)
        status, output, diagnostics = self.invoke("propositions")
        self.assertEqual(status, 0)
        self.assertEqual([item["id"] for item in json.loads(output)["records"]], ["n_ok"])
        self.assertIn("nodes.jsonl:3: malformed JSON", diagnostics)
        self.assertIn("nodes.jsonl:4: invalid record shape", diagnostics)
        self.assertIn("nodes.jsonl:5: invalid record shape", diagnostics)
        self.assertIn("chains.jsonl:1: invalid record shape", diagnostics)
        self.assertIn("incomplete", diagnostics)
        self.assertEqual(snapshot(self.root), before)

    def test_future_format_refuses_without_partial_output_or_writes(self):
        self.fixture()
        self.write_json("graph/format.json", {"version": 2})
        before = snapshot(self.root)
        for command in ("sessions", "propositions", "chains"):
            status, output, diagnostics = self.invoke(command)
            self.assertNotEqual(status, 0)
            self.assertEqual(output, "")
            self.assertIn("newer", diagnostics)
        self.assertEqual(snapshot(self.root), before)

    def test_current_format_works_and_malformed_json_refuses(self):
        self.write_json("graph/format.json", {"version": 1})
        self.assertEqual(self.result("propositions"), [])
        (self.root / "graph" / "format.json").write_text("{torn", encoding="utf-8")
        status, output, diagnostics = self.invoke("propositions")
        self.assertNotEqual(status, 0)
        self.assertEqual(output, "")
        self.assertIn("format.json", diagnostics)

    def test_source_paths_are_only_references_and_markdown_is_full_text(self):
        self.fixture()
        before = snapshot(self.root)
        status, output, diagnostics = self.invoke("propositions", format="markdown")
        self.assertEqual(status, 0, diagnostics)
        for text in ("First precise statement", "Original wording", "Later restatement", "Another phrasing", "chat_old", "m1", "Recent conversation", "Café", "/never/open/these notes.md"):
            self.assertIn(text, output)
        self.assertIn(f"Data directory: {self.root.resolve()}", output)
        self.assertIn("not mastery or guaranteed truth", output)
        status, output, diagnostics = self.invoke("chains", "--node", "n_a", format="markdown")
        self.assertEqual(status, 0, diagnostics)
        self.assertIn("First precise statement", output)
        self.assertIn("missing proposition", output)
        self.assertEqual(snapshot(self.root), before)

    @unittest.skipUnless(hasattr(os, "symlink"), "symlinks unavailable")
    def test_ledger_symlink_escape_is_rejected(self):
        with tempfile.TemporaryDirectory() as external:
            path = Path(external) / "nodes.jsonl"
            path.write_text(json.dumps(node("n_external")), encoding="utf-8")
            (self.root / "graph").mkdir()
            try:
                (self.root / "graph" / "nodes.jsonl").symlink_to(path)
            except OSError as exc:
                self.skipTest(f"symlink permission unavailable: {exc}")
            status, output, diagnostics = self.invoke("propositions")
            self.assertNotEqual(status, 0)
            self.assertEqual(output, "")
            self.assertTrue(diagnostics)
            self.assertEqual(path.read_text(encoding="utf-8"), json.dumps(node("n_external")))

    def test_cli_root_options_order_missing_root_and_no_bytecode(self):
        env = {**os.environ, "LH_DATA_DIR": str(GOLDEN)}
        env.pop("PYTHONDONTWRITEBYTECODE", None)
        before = snapshot(self.root)
        caches_before = set(SCRIPTS.rglob("*.pyc"))
        command = [sys.executable, str(SCRIPTS / "graph.py")]
        completed = subprocess.run([*command, "--data-dir", str(self.root), "--format", "json", "sessions"], env=env, capture_output=True, text=True, check=False)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(json.loads(completed.stdout), {"data_dir": str(self.root.resolve()), "records": []})  # Never falls back to repo/LH_DATA_DIR.
        bad = subprocess.run([*command, "sessions", "--data-dir", str(self.root)], env=env, capture_output=True, text=True, check=False)
        self.assertNotEqual(bad.returncode, 0)
        absent = subprocess.run([*command, "--data-dir", str(self.root / "missing"), "sessions"], env=env, capture_output=True, text=True, check=False)
        self.assertNotEqual(absent.returncode, 0)
        self.assertEqual(absent.stdout, "")
        self.assertEqual(snapshot(self.root), before)
        self.assertEqual(set(SCRIPTS.rglob("*.pyc")), caches_before)

    def test_golden_data_read_only_broad_graph(self):
        before = snapshot(GOLDEN)
        nodes = self.result("propositions", root=GOLDEN)
        chains = self.result("chains", root=GOLDEN)
        sessions = self.result("sessions", root=GOLDEN)
        self.assertGreaterEqual(len(nodes), 250)
        self.assertGreaterEqual(len(chains), 150)
        self.assertEqual(len({item["id"] for item in nodes}), len(nodes))
        self.assertEqual(sum(item["propositions"] for item in sessions), sum(bool(item["provenance"]) for item in nodes))
        for session in sessions:
            born = self.result("propositions", "--session", session["id"], root=GOLDEN)
            self.assertEqual(len(born), session["propositions"])
            self.assertTrue(all(item["provenance"][0]["chatId"] == session["id"] for item in born))
        self.assertTrue(any(item["kind"] == "file" for item in sessions))
        # Golden chat files are not the original graph birth sessions; their
        # missing historical metadata must remain honestly undated.
        self.assertTrue(any(item["createdAt"] is None for item in sessions))
        self.assertEqual(snapshot(GOLDEN), before)


if __name__ == "__main__":
    unittest.main()

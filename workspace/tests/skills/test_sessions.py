"""Read-only evidence-preservation tests for the native session readers."""
from __future__ import annotations

import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / "skills" / "learnharness" / "scripts"
GOLDEN = ROOT / "tests" / "fixtures" / "golden-data"
sys.path.insert(0, str(SCRIPTS))
spec = importlib.util.spec_from_file_location("lh_sessions_reader", SCRIPTS / "sessions.py")
sessions = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sessions)


def record(messages=None, session_id="sample", **extra):
    return {
        "id": session_id, "title": "Evidence session", "createdAt": "2026-10-10T10:00:00Z",
        "updatedAt": "2026-10-10T11:00:00Z", "messages": messages or [], **extra,
    }


def assistant(*blocks, message_id="teacher", **extra):
    return {"id": message_id, "role": "assistant", "content": list(blocks), **extra}


def call(name, arguments, call_id="call-one"):
    return {"type": "toolCall", "id": call_id, "name": name, "arguments": arguments}


def result(name, details=None, call_id="call-one", content=None, **extra):
    value = {"id": "answer-result", "role": "toolResult", "toolName": name,
             "toolCallId": call_id, "isError": False,
             "content": content if content is not None else [{"type": "text", "text": '{"kind":"quiz"}'}], **extra}
    if details is not None:
        value["details"] = details
    return value


def marker(kind, content, details, marker_id="marker"):
    return {"id": marker_id, "role": "custom", "customType": kind,
            "content": content, "details": details, "display": True}


def snapshot(folder):
    return {str(p.relative_to(folder)): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in folder.rglob("*") if p.is_file()}


class SessionsTest(unittest.TestCase):
    def cli(self, root, *args):
        return subprocess.run([sys.executable, "-B", str(SCRIPTS / "sessions.py"),
                               "--data-dir", str(root), *args], capture_output=True,
                              text=True, env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"}, check=False)

    def save(self, root, value, filename=None):
        folder = root / "chats"
        folder.mkdir(exist_ok=True)
        path = folder / (filename or f"{value['id']}.json")
        path.write_text(json.dumps(value), encoding="utf-8")
        return path

    def render(self, value, **flags):
        return sessions.render_markdown(sessions.selected_record(value, **flags))

    def test_golden_default_preserves_learning_and_omits_noise(self):
        before = snapshot(GOLDEN)
        listing = self.cli(GOLDEN, "--format", "json", "list")
        self.assertEqual(listing.returncode, 0, listing.stderr)
        index = json.loads(listing.stdout)
        self.assertEqual(len(index["sessions"]), 2)
        self.assertEqual(index["skipped_count"], 0)
        self.assertEqual(index["data_dir"], str(GOLDEN.resolve()))
        self.assertEqual({s["kind"] for s in index["sessions"]}, {"teach", "practice"})
        for summary in index["sessions"]:
            response = self.cli(GOLDEN, "read", summary["id"])
            self.assertEqual(response.returncode, 0, response.stderr)
            raw = json.loads((GOLDEN / "chats" / f"{summary['id']}.json").read_text())
            text = response.stdout
            for message in raw["messages"]:
                self.assertIn(message["id"], text)
                if message["role"] == "user":
                    self.assertIn(sessions._text(message["content"]), text)
                if message["role"] == "custom":
                    self.assertIn(message["customType"], text)
                if message["role"] == "toolResult" and message.get("toolName") in sessions.QUESTION_TOOLS:
                    self.assertIn(message["toolCallId"], text)
                    details = message.get("details", {})
                    for key in ("thinking", "note", "readingThinking", "committed", "text", "explanation", "other"):
                        if key in details:
                            self.assertIn(sessions._text(details[key]), text)
                if message["role"] == "assistant":
                    for block in message["content"]:
                        if block["type"] == "text":
                            self.assertIn(sessions._text(block["text"]), text)
            self.assertIn("Explicit omissions", text)
            self.assertIn(f"Data directory: {GOLDEN.resolve()}", text)
            self.assertNotIn('"thinkingSignature"', text)
        self.assertEqual(before, snapshot(GOLDEN))

    def test_answer_details_are_full_truth_and_indexes_are_not_joined(self):
        answer = {
            "kind": "quiz", "questionText": "Q snapshot", "options": [
                {"index": 1, "label": "Displayed B"}, {"index": 2, "label": "Displayed A"}],
            "answers": [{"index": 1, "label": "Displayed B", "value": "b"}],
            "correctIndices": [2], "correct": False, "confidence": 0, "dontKnow": False,
            "thinking": "Thinking exactly", "note": "Legacy note separately",
            "readingThinking": "Reading exactly", "explanation": "Teacher resolution",
        }
        source = record([assistant(call("quiz", {"question": "Raw Q", "options": [
            {"label": "Authored A", "value": "a"}, {"label": "Authored B", "value": "b"}],
            "correctAnswer": "a", "explanation": "Call explanation"})),
            result("quiz", answer, content=[{"type": "text", "text": json.dumps({
                "kind": "quiz", "confidence": 0, "thinking": "Thinking exactly",
                "thinkingWhileReading": "Reading exactly",
                "answers": [{"index": 1, "label": "Displayed B"}],
            })}])])
        before = copy.deepcopy(source)
        selected = sessions.selected_record(source)
        self.assertEqual(selected["record"]["messages"][1]["details"], answer)
        self.assertNotIn("content", selected["record"]["messages"][1])
        text = sessions.render_markdown(selected)
        for phrase in ("Displayed B", "Authored A", "Thinking exactly", "Legacy note separately", "Reading exactly", "Teacher resolution", "confidence (raw 0–100)**: 0", "Teacher-authored", "Reveal status", "snapshot display indexes"):
            self.assertIn(phrase, text)
        self.assertNotIn("99", text)
        self.assertEqual(source, before)

    def test_extra_or_conflicting_answer_content_is_not_silently_discarded(self):
        cases = [
            ({}, {"kind": "explain", "text": "only surviving learner answer"}),
            ({"kind": "quiz", "confidence": 0}, {"kind": "quiz", "confidence": 99}),
            ({"kind": "quiz"}, {"kind": "quiz", "thinking": "extra learner reasoning"}),
        ]
        for details, compact in cases:
            with self.subTest(details=details, compact=compact):
                message = result("quiz", details, content=[{"type": "text", "text": json.dumps(compact)}])
                selected = sessions.selected_record(record([message]))
                self.assertEqual(selected["record"]["messages"][0]["content"], message["content"])
                text = sessions.render_markdown(selected)
                self.assertIn("may differ from the primary details snapshot", text)
                self.assertIn(sessions._text(json.dumps(compact)), text)
        message = result("quiz", {"kind": "quiz", "note": "Legacy thought", "readingThinking": "Reading thought"},
                         content=[{"type": "text", "text": '{"kind":"quiz","thinking":"Legacy thought","thinkingWhileReading":"Reading thought"}'}])
        selected = sessions.selected_record(record([message]))
        self.assertNotIn("content", selected["record"]["messages"][0])
        self.assertIn("verified redundant", selected["omissions"][0]["reason"])
        diagnostic = sessions.selected_record(record([message]), include_operations=True)
        self.assertEqual(diagnostic["record"]["messages"][0]["content"], message["content"])
        non_json = result("explain", content=[{"type": "text", "text": '{"text": NaN}'}])
        self.assertIn("unparsed; full snapshot unavailable", self.render(record([non_json])))

    def test_only_exact_learning_acknowledgments_are_noise(self):
        for tool, ack in sessions.ACK_TEXT.items():
            with self.subTest(tool=tool):
                message = result(tool, content=[{"type": "text", "text": ack}])
                default = sessions.selected_record(record([message]))
                self.assertNotIn("content", default["record"]["messages"][0])
                full = sessions.selected_record(record([message]), include_operations=True)
                self.assertEqual(full["record"]["messages"][0]["content"], message["content"])
                message["content"] = [{"type": "text", "text": "Historical teaching/assessment, not an acknowledgment"}]
                self.assertIn("Historical teaching/assessment", self.render(record([message])))
        dispatched = result("research", "Dispatched (job example).", content=[{"type": "text", "text": "Full historical research brief"}])
        self.assertIn("Full historical research brief", self.render(record([dispatched])))

    def test_all_answer_modes_and_zero_false_empty_values(self):
        payloads = [
            ("probe", {"kind": "quiz", "dontKnow": True, "answers": [], "thinking": "don't know reasoning"}),
            ("ask_user_question", {"kind": "ask", "other": "Other exact text", "answers": [], "text": "typed answer"}),
            ("explain", {"kind": "explain", "text": "free recall answer", "committed": "full committed solution", "readingThinking": "reading channel"}),
            ("recall", {"kind": "explain", "text": "recalled verbatim", "committed": "recall key"}),
            ("quiz", {"kind": "quiz", "dismissed": True, "answers": [], "dontKnow": False}),
        ]
        text = self.render(record([result(name, payload) for name, payload in payloads]))
        for _, payload in payloads:
            for value in payload.values():
                if isinstance(value, str):
                    self.assertIn(sessions._text(value), text)
        self.assertIn("Learner don't know**: true", text)
        self.assertIn("Skipped/dismissed**: true", text)
        self.assertIn("Learner answers (stored display labels/indexes)**: []", text)

    def test_json_content_fallback_when_details_absent_or_null(self):
        payload = {"kind": "explain", "text": "fallback answer", "note": "old note", "thinkingWhileReading": "fallback reading", "confidence": 0}
        for details in ({}, {"details": None}):
            with self.subTest(details=details):
                message = result("recall", content=[{"type": "text", "text": json.dumps(payload)}])
                message.update(details)
                text = self.render(record([message]))
                self.assertIn("JSON fallback", text)
                self.assertIn("fallback answer", text)
                self.assertIn("old note", text)
                self.assertIn("fallback reading", text)
                self.assertIn("confidence (raw 0–100)**: 0", text)
        text = self.render(record([result("probe", content=[{"type": "text", "text": "not JSON"}])]))
        self.assertIn("unparsed; full snapshot unavailable", text)
        self.assertIn("not JSON", text)
        # Parsing one text block must not hide sibling images/extra fields or
        # misattribute a later block to content[0].text.
        richer = result("recall", content=[
            {"type": "image", "mimeType": "image/png", "data": "BINARY-NOT-PRINTED"},
            {"type": "text", "text": json.dumps(payload)},
        ])
        text = self.render(record([richer]))
        self.assertIn("image/png", text)
        self.assertIn("fallback answer", text)
        self.assertNotIn("BINARY-NOT-PRINTED", text)
        self.assertNotIn("content[0].text (JSON fallback", text)
        richer["content"] = [{"type": "text", "text": json.dumps(payload), "futureField": "retain block metadata"}]
        self.assertIn("retain block metadata", self.render(record([richer])))

    def test_pending_failed_and_legacy_duplicate_call_ids(self):
        messages = [
            assistant(call("quiz", {"question": "First", "correctAnswer": "first key"}), message_id="first"),
            result("quiz", {"kind": "quiz", "text": "first answer"}),
            assistant(call("quiz", {"question": "Failed", "correctAnswer": "failed key"}), message_id="second"),
            result("quiz", {"problems": ["validation failure"]}, isError=True,
                   content=[{"type": "text", "text": "failure text"}]),
            assistant(call("problem", {"statement": "Pending", "modelSolution": "pending full model solution"}), message_id="third"),
        ]
        statuses = sessions._call_statuses(messages)
        self.assertIn("result recorded", statuses[(0, 0)])
        self.assertIn("FAILED", statuses[(2, 0)])
        self.assertIn("PENDING", statuses[(4, 0)])
        text = self.render(record(messages))
        for word in ("first key", "failed key", "pending full model solution", "validation failure", "failure text", "not successful", "PENDING", "even pending"):
            self.assertIn(word, text)
        orphan = result("quiz", {"kind": "quiz", "text": "orphan answer"}, call_id="later")
        statuses = sessions._call_statuses([orphan, assistant(call("quiz", {}, call_id="later"))])
        self.assertIn("PENDING", statuses[(1, 0)])

    def test_flags_are_separate_and_do_not_hide_learner_thinking(self):
        source = record([
            assistant({"type": "thinking", "thinking": "PRIVATE AGENT THOUGHT", "thinkingSignature": "SIGNATURE"},
                      {"type": "text", "text": "Teacher text"}, call("read", {"path": "NO FILE OPEN"}),
                      usage={"tokens": 123}, provider="vendor", responseId="provider-response"),
            result("read", "routine read result", content=[{"type": "text", "text": "routine read result"}]),
            result("quiz", {"thinking": "LEARNER THOUGHT", "readingThinking": "LEARNER READING"}),
            marker("practice-thinking", "practice content", {"text": "PRACTICE THOUGHT"}),
        ], turns=[{"usage": 42}], extractions=[{"cost": 23}])
        default = self.render(source)
        for flag, value in (("agent thinking", "PRIVATE AGENT THOUGHT"), ("metadata", "provider-response"), ("routine", "routine read result")):
            self.assertNotIn(value, default, flag)
        for flags in ({}, {"include_agent_thinking": True}, {"include_operations": True},
                      {"include_operations": True, "include_agent_thinking": True}):
            text = self.render(source, **flags)
            for learner in ("LEARNER THOUGHT", "LEARNER READING", "PRACTICE THOUGHT"):
                self.assertIn(learner, text)
            self.assertEqual("PRIVATE AGENT THOUGHT" in text, flags.get("include_agent_thinking", False))
            self.assertEqual("routine read result" in text, flags.get("include_operations", False))
            self.assertEqual("SIGNATURE" in text, flags.get("include_agent_thinking", False) and flags.get("include_operations", False))

    def test_full_artifacts_refs_and_no_payload_embedding(self):
        brief = "FULL BRIEF START\n" + "long evidence paragraph.\n" * 800 + "FULL BRIEF END"
        messages = [
            marker("subagent-steer", "Delivered research", {"jobId": "job-research", "kind": "research", "toolCallId": "research-call", "result": {"brief": brief, "sources": [{"title": "Source", "url": "https://example.invalid/source"}]}}),
            marker("subagent-steer", "PDF delivery", {"jobId": "job-pdf", "kind": "pdf", "toolCallId": "pdf-call", "result": {"brief": brief, "path": "/never/open.pdf", "pagesRead": [1, 4], "pagesConsulted": [2]}}),
            marker("subagent-steer", "Demo reference", {"kind": "demo", "result": {"title": "Demo title", "html": "<script>PAYLOAD-HTML</script>", "tested": True, "notes": "Demo notes"}}),
            marker("subagent-steer", "Visual reference", {"kind": "visual", "result": {"svg": "<svg>PAYLOAD-SVG</svg>", "notes": "Visual notes"}}),
            {"id": "image-user", "role": "user", "content": [{"type": "image", "mimeType": "image/png", "data": "PAYLOAD-BASE64"}, {"type": "text", "text": "Describe this image"}]},
        ]
        for flags in ({}, {"include_operations": True, "include_agent_thinking": True}):
            selected = sessions.selected_record(record(messages), **flags)
            text = sessions.render_markdown(selected)
            output = json.dumps(selected)
            self.assertIn(brief, text)
            for phrase in ("job-research", "research-call", "job-pdf", "pdf-call", "/never/open.pdf", "pagesRead", "pagesConsulted", "Demo title", "Demo notes", "Visual notes", "image/png"):
                self.assertIn(phrase, text)
            for payload in ("PAYLOAD-HTML", "PAYLOAD-SVG", "PAYLOAD-BASE64"):
                self.assertNotIn(payload, text)
                self.assertNotIn(payload, output)
            self.assertEqual(selected["omitted_field_count"], 3)
        # A persisted full artifact result is not a routine dispatch acknowledgment.
        direct = self.render(record([result("research", {"brief": brief}), result("pdf", {"brief": brief, "pagesRead": [7]})]))
        self.assertEqual(direct.count(brief), 2)
        self.assertIn("pagesRead", direct)

    def test_graph_context_compact_default_and_full_operations(self):
        context = marker("graph-context", "VERBOSE INJECTED GRAPH PREAMBLE", {
            "propositions": [{"id": "node-a", "name": "Node A", "statement": "VERBOSE GRAPH STATEMENT"},
                             {"id": "node-b", "name": "Node B", "statement": "SECOND GRAPH STATEMENT"}],
            "chains": ["chain-a", "chain-b"], "futureContext": "unknown preserved context",
        }, marker_id="context-id")
        source = record([context,
                         {"id": "learner", "role": "user", "content": "VERBOSE GRAPH STATEMENT"},
                         assistant({"type": "text", "text": "Teacher speech preserved"}),
                         marker("practice-thinking", "Learner practice speech", {"text": "Learner trace"}),
                         marker("subagent-steer", "Artifact delivery", {"kind": "research", "result": {"brief": "Full artifact speech"}})])
        original = copy.deepcopy(source)
        compact = sessions.selected_record(source)
        selected_context = compact["record"]["messages"][0]
        self.assertNotIn("content", selected_context)
        self.assertNotIn("statement", selected_context["details"]["propositions"][0])
        self.assertEqual(selected_context["details"]["chains"], ["chain-a", "chain-b"])
        self.assertEqual({o["source"] for o in compact["omissions"]}, {
            "messages[0].content", "messages[0].details.propositions[0].statement",
            "messages[0].details.propositions[1].statement"})
        text = sessions.render_markdown(compact)
        for phrase in ("context-id", "node-a", "Node A", "node-b", "Node B", "chain-a", "chain-b", "unknown preserved context",
                       "VERBOSE GRAPH STATEMENT", "Teacher speech preserved", "Learner practice speech", "Learner trace", "Full artifact speech"):
            self.assertIn(phrase, text)
        self.assertNotIn("VERBOSE INJECTED GRAPH PREAMBLE", text)
        self.assertNotIn("SECOND GRAPH STATEMENT", text)
        self.assertNotIn("Unsupported/unrendered native content shape", text)
        full = sessions.selected_record(source, include_operations=True)
        self.assertEqual(full["record"]["messages"][0], context)
        self.assertIn("VERBOSE INJECTED GRAPH PREAMBLE", sessions.render_markdown(full))
        self.assertIn("SECOND GRAPH STATEMENT", sessions.render_markdown(full))
        self.assertEqual(source, original)
        # Unknown context shapes cannot safely be compacted into references.
        unknown = marker("graph-context", "only stored context", {"future": "shape"})
        self.assertIn("only stored context", self.render(record([unknown])))

    def test_unknown_shapes_markers_and_content_are_explicit(self):
        source = record([
            marker("new-marker", "unknown content", {"futureField": "opaque payload"}),
            assistant({"type": "future-block", "opaque": "block evidence"}, call("new-tool", {"note": "future tool"})),
            {"id": "new-role", "role": "alien", "content": {"unknown": "role evidence"}},
            result("new-tool", {"future": "result evidence"}),
        ])
        text = self.render(source)
        self.assertGreaterEqual(text.lower().count("unsupported/unrendered"), 5)
        self.assertIn("Stored role: alien (unsupported semantics; fields preserved).", text)
        for value in ("unknown content", "opaque payload", "block evidence", "future tool", "role evidence", "result evidence"):
            self.assertIn(value, text)
        # HTML in ordinary learner text stays verbatim in selected JSON, but is inert markdown.
        source = record([{"role": "user", "id": "u", "content": '<script>alert("untrusted")</script>'}])
        self.assertEqual(sessions.selected_record(source)["record"]["messages"][0]["content"], source["messages"][0]["content"])
        self.assertNotIn("<script>", self.render(source))
        self.assertIn("&lt;script&gt;", self.render(source))

    def test_cli_errors_isolated_list_and_missing_defaults(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.save(root, record())
            self.save(root, record(session_id="future", version=2))
            self.save(root, record(session_id="old", messages=[{"role": "assistant", "parts": []}]))
            (root / "chats" / "broken.json").write_text("{bad", encoding="utf-8")
            before = snapshot(root)
            output = self.cli(root, "--format", "json", "list")
            self.assertEqual(output.returncode, 0, output.stderr)
            value = json.loads(output.stdout)
            self.assertEqual(value["sessions"][0]["kind"], "teach")
            self.assertEqual(value["skipped_count"], 3)
            self.assertEqual({s["id"] for s in value["skipped"]}, {"future", "old", "broken"})
            self.assertEqual(output.stderr.count("Warning: skipped session"), 3)
            plain = self.cli(root, "list")
            self.assertIn("Skipped/unreadable sessions: 3", plain.stdout)
            for session_id, phrase in (("future", "Update the skill"), ("old", "UIMessage"), ("broken", "Cannot read"), ("missing", "Session not found"), ("../escape", "session ID")):
                result_ = self.cli(root, "read", session_id)
                self.assertNotEqual(result_.returncode, 0)
                self.assertIn(phrase, result_.stderr)
                self.assertNotIn("Traceback", result_.stderr)
                self.assertEqual(result_.stdout, "")
            good = self.cli(root, "--format", "json", "read", "sample", "--include-agent-thinking", "--include-operations")
            self.assertEqual(good.returncode, 0, good.stderr)
            selected = json.loads(good.stdout)
            self.assertIn("record", selected)
            self.assertEqual(selected["data_dir"], str(root.resolve()))
            self.assertTrue(selected["reading_notes"])
            self.assertNotEqual(self.cli(root, "read", "sample", "--format", "json").returncode, 0)
            self.assertEqual(before, snapshot(root))
            absent = root / "not-created"
            missing = self.cli(absent, "list")
            self.assertNotEqual(missing.returncode, 0)
            self.assertFalse(absent.exists())

    def test_symlink_escape_refused_without_opening_external_record(self):
        with tempfile.TemporaryDirectory() as directory, tempfile.TemporaryDirectory() as outside:
            root = Path(directory)
            target = self.save(Path(outside), record(session_id="escape"))
            (root / "chats").mkdir()
            try:
                (root / "chats" / "escape.json").symlink_to(target)
            except OSError as exc:
                self.skipTest(str(exc))
            result_ = self.cli(root, "read", "escape")
            self.assertNotEqual(result_.returncode, 0)
            self.assertIn("outside", result_.stderr)
            listing = self.cli(root, "--format", "json", "list")
            self.assertEqual(json.loads(listing.stdout)["skipped_count"], 1)


if __name__ == "__main__":
    unittest.main()

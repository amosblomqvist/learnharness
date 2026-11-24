import assert from "node:assert/strict";
import { it } from "node:test";
import { acceptedPoseKeys, occurrenceKey, parsePoseResponse } from "../src/poses.ts";
const call = (id = "p", name = "problem") => ({ role: "assistant", id: `m-${id}`, content: [{ type: "toolCall", id, name, arguments: { modelSolution: "Never read this" } }] });
const ack = (id = "p", name = "problem", extra = {}) => ({ role: "toolResult", toolCallId: id, toolName: name, ...extra });
it("uses exact occurrence identity for acknowledged native poses", () => {
  assert.deepEqual(acceptedPoseKeys([call(), ack()]), [occurrenceKey({ messageId: "m-p", contentIndex: 0, toolCallId: "p", toolName: "problem" })]);
});
it("ignores errored, dangling, mismatched, and pre-call acknowledgments", () => {
  for (const history of [[call()], [call(), ack("p", "problem", { isError: true })], [call(), ack("x")], [ack(), call()], [call(), ack("p", "other")]])
    assert.deepEqual(acceptedPoseKeys(history), []);
});
it("recognizes custom poses only through host acknowledgment metadata", () => {
  const details = { pluginProblem: { protocolVersion: 1, problemId: "p", pluginId: "custom", typeId: "code" } };
  assert.equal(acceptedPoseKeys([call("p", "code_problem"), ack("p", "code_problem", { details })]).length, 1);
  assert.deepEqual(acceptedPoseKeys([call("p", "code_problem"), ack("p", "code_problem")]), []);
});
it("conclusion, dismissal and model prose do not erase accepted-pose identity", () => {
  const original = [call(), ack()];
  const later = [...original, call("c", "conclude"), ack("c", "conclude"), { role: "custom", customType: "problem-dismissed" },
    { role: "assistant", id: "later", content: [{ type: "text", text: "New problem!" }] }];
  assert.deepEqual(acceptedPoseKeys(later), acceptedPoseKeys(original));
});
it("orders multiple accepted native/custom poses by their source occurrences", () => {
  assert.equal(acceptedPoseKeys([call("a"), ack("a"), call("b"), ack("b")]).length, 2);
});
it("does not inspect model solutions, custom input, or tool text", () => {
  const args = Object.defineProperty({}, "modelSolution", { get() { assert.fail("read committed solution"); } });
  const message = call(); message.content[0]!.arguments = args as { modelSolution: string };
  assert.equal(acceptedPoseKeys([message, ack()]).length, 1);
});
it("validates lifecycle operation responses against the original session", () => {
  assert.deepEqual(parsePoseResponse({ sessionId: "a", poses: ["x"] }, "a"), ["x"]);
  for (const value of [null, {}, { sessionId: "b", poses: [] }, { sessionId: "a", poses: [0] }]) assert.throws(() => parsePoseResponse(value, "a"));
});

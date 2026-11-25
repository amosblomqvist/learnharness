import assert from "node:assert/strict";
import { test } from "node:test";
import { isSubagentSteer, newestLearnerTurnFrom } from "../components/transcript-rows.ts";
import { newGraphContextMessage, newUserMessage, type LhMarkerMessage } from "../src/core/native-messages.ts";
import { projectView, type LhViewMessage } from "../src/core/view.ts";

const learner = newUserMessage("Explain this step.");
const answer: LhViewMessage = { id: "answer", role: "assistant", parts: [{ type: "text", text: "Here is the next step." }] };
const context = newGraphContextMessage([], []);

for (const customType of ["subagent-steer", "subagent-abort"] as const) {
	test(`projected ${customType} does not end the newest learner turn`, () => {
		const marker: LhMarkerMessage = {
			id: customType, role: "custom", customType, display: true, content: "Background update for the teacher.",
			details: { kind: "research", ...(customType === "subagent-abort" ? { aborted: true } : {}) }, timestamp: 0,
		};
		const [projected] = projectView([marker]);
		assert.ok(projected);
		assert.equal(projected.role, "user");
		assert.ok(projected.parts.some((part) => part.type === "text"));
		assert.ok(isSubagentSteer(projected));
		const historical = projectView([newUserMessage("Earlier question."), learner]);
		assert.equal(historical[1]?.id, learner.id);
		assert.equal(newestLearnerTurnFrom([...historical, answer, projected]), 1);
		assert.equal(newestLearnerTurnFrom([projected]), -1);
	});
}

test("learner text and image-only rows start turns; projected data-only rows do not", () => {
	const photo = newUserMessage("", [{ type: "image", mimeType: "image/png", data: "AA==" }]);
	const rows = projectView([learner, photo, context]);
	assert.equal(rows[0]?.id, learner.id);
	assert.equal(rows[1]?.id, photo.id);
	assert.deepEqual(rows[1]?.parts.map((part) => part.type), ["image"]);
	assert.deepEqual(rows[2]?.parts.map((part) => part.type), ["data-graph-context"]);
	assert.equal(newestLearnerTurnFrom(rows.slice(0, 1)), 0);
	assert.equal(newestLearnerTurnFrom(rows), 1);
	assert.equal(newestLearnerTurnFrom([answer, ...projectView([context])]), -1);
});

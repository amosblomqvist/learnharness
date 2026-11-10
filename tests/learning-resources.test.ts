import assert from "node:assert/strict";
import { test } from "node:test";
import { createLearningResourceSearch } from "../src/server/learning-resources.ts";
import { learningResourceTools } from "../src/agent/tools/learning-resources.ts";
import { createProberTools, createTeacherTools } from "../src/agent/tools.ts";
import { practiceTools } from "../src/agent/tools/practice.ts";
import type { LearningResourceResult } from "../src/core/learning-resources.ts";

const SOURCE = "https://openstax.org/books/university-physics-volume-1/pages/10-6-torque";

test("curated torque lookup returns an original section and a concrete learning task", async () => {
	const search = createLearningResourceSearch();
	for (const query of ["torque", "What is torque?", "moment arm", "RADIAL FORCE"]) {
		const result = await search({ query });
		assert.equal(result.references.length, 1);
		const resource = result.references[0]!;
		assert.equal(resource.url, SOURCE);
		assert.match(resource.section, /10.6/);
		assert.match(resource.activity, /radial.*perpendicular/);
		assert.match(resource.activity, /moment arm/);
		assert.match(resource.followUp, /different.*earlier/);
		assert.match(resource.followUp, /without the source/);
		assert.match(resource.followUp, /before showing an answer/);
		assert.match(resource.accessNote, /current access.*checked/);
		assert.equal(result.contentDownloaded, false);
		assert.equal(result.masteryUpdated, false);
	}
});

test("uncovered topics return no invented source or generic success", async () => {
	const result = await createLearningResourceSearch()({ query: "photosynthesis" });
	assert.deepEqual(result.references, []);
	assert.match(result.warnings[0]!, /torque only/);
	assert.equal(result.masteryUpdated, false);
});

test("empty and oversized topic input is refused", async () => {
	const search = createLearningResourceSearch();
	for (const query of ["", "  ", "x".repeat(301)]) await assert.rejects(search({ query }));
});

test("a caller cannot mutate later catalog referrals", async () => {
	const search = createLearningResourceSearch();
	const first = await search({ query: "torque" });
	first.references[0]!.url = "https://untrusted.example/";
	first.references[0]!.followUp = "Mark mastery without an answer";
	const second = await search({ query: "torque" });
	assert.equal(second.references[0]!.url, SOURCE);
	assert.match(second.references[0]!.followUp, /before showing an answer/);
});

test("native tool execution delivers the actual adapter result", async () => {
	const tool = learningResourceTools(createLearningResourceSearch()).learning_resources!;
	const result = await tool.execute("referral", { query: "torque" });
	const record = result.details as LearningResourceResult;
	assert.equal(record.references[0]!.url, SOURCE);
	assert.equal(record.masteryUpdated, false);
});

test("an adapter failure does not leak its error or invent a source", async () => {
	const tool = learningResourceTools(async () => { throw new Error("PRIVATE_PROVIDER_DETAIL"); }).learning_resources!;
	const result = await tool.execute("referral-failure", { query: "torque" });
	assert.ok(!JSON.stringify(result).includes("PRIVATE_PROVIDER_DETAIL"));
	assert.match(JSON.stringify(result), /do not invent links/);
});

test("all three phases receive the optional port while existing assessment tools remain", () => {
	const common = { chatId: "fixture", chatStore: { getChat: () => ({ messages: [] }) }, jobStore: {}, spawn: () => {}, deliver: () => {} };
	assert.deepEqual(learningResourceTools(), {});
	assert.equal(createProberTools(common as never).learning_resources, undefined);
	assert.equal(createTeacherTools(common as never).learning_resources, undefined);
	assert.equal(practiceTools(common as never).learning_resources, undefined);
	const context = { ...common, learningResources: createLearningResourceSearch() };
	assert.ok(createProberTools(context as never).learning_resources);
	assert.ok(createTeacherTools(context as never).learning_resources);
	const practice = practiceTools(context as never);
	assert.ok(practice.learning_resources && practice.problem && practice.conclude);
});

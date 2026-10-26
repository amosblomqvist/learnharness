/**
 * The teacher reads the Tutor lesson set through `curriculum`.
 * Learner filesystem tools cannot see it (they root at $HOME).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { curriculumTool } from "../src/agent/tools/curriculum.ts";
import { composeInstructions } from "../src/agent/teacher-agent.ts";

async function textOf(args: { id?: string; offset?: number; limit?: number }): Promise<string> {
	const result = await curriculumTool.execute!("test", args);
	assert.equal(result.isError, undefined);
	const part = result.content[0];
	assert.ok(part);
	assert.equal(part.type, "text");
	return (part as { type: "text"; text: string }).text;
}

describe("curriculum tool", () => {
	it("lists the SWE path without lesson bodies", async () => {
		const text = await textOf({});
		assert.match(text, /^Tutor curriculum/);
		const linux = text.split("\n").find((line) => line.startsWith("linux |"));
		const distributed = text.split("\n").find((line) => line.startsWith("distributed |"));
		assert.ok(linux, "linux is on the path");
		assert.ok(distributed, "distributed is on the path");
		assert.ok(text.indexOf("linux |") < text.indexOf("distributed |"), "path order is preserved");
		assert.match(text, /also:\narchitecture \|/);
		assert.equal(text.includes("## Talking to the shell"), false);
		assert.equal(text.includes("def play"), false);
	});

	it("outlines one module's lessons", async () => {
		const text = await textOf({ id: "distributed" });
		assert.match(text, /^module distributed — /);
		assert.match(text, /^pg-plans \| Read the plan, then add the index \| stage pg \| needs sql\/indexes \| 55m \| Use EXPLAIN/m);
		assert.equal(text.includes("## Read the plan"), false);
	});

	it("returns one lesson and stops at the next heading", async () => {
		const text = await textOf({ id: "linux/shell" });
		assert.match(text, /^lesson linux\/shell — Talking to the shell/);
		assert.match(text, /The check key is for you/);
		assert.match(text, /You type one line/);
		const heads = text.split("\n").filter((line) => line.startsWith("## "));
		assert.deepEqual(heads, ["## Talking to the shell"]);
	});

	it("resolves a unique lesson id and keeps the quest lesson intact", async () => {
		const byId = await textOf({ id: "pg-plans" });
		assert.match(byId, /^lesson distributed\/pg-plans — Read the plan, then add the index/);
		const quest = await textOf({ id: "quest/p-engine" });
		assert.match(quest, /Sam starts in the `"hall"`/);
		const questOutline = await textOf({ id: "quest" });
		assert.match(questOutline, /^p-engine \|/m);
		assert.match(questOutline, /^g1-tuple-record \|/m);
		assert.match(questOutline, /^g1-flood \|/m);
		const heads = quest.split("\n").filter((line) => line.startsWith("## "));
		assert.deepEqual(heads, ["## Quest: the adventure engine"]);
	});

	it("continues a lesson with offset and limit", async () => {
		const text = await textOf({ id: "linux/shell", limit: 4 });
		assert.match(text, /more lines in lesson\. Use offset=5 to continue\./);
		const rest = await textOf({ id: "linux/shell", offset: 5, limit: 2 });
		assert.match(rest, /more lines in lesson\. Use offset=7 to continue\./);
	});

	it("rejects an id that is not a curriculum key", async () => {
		await assert.rejects(() => textOf({ id: "../package.json" }), /not a module id/);
		await assert.rejects(() => textOf({ id: "linux/../../package.json" }), /not a module id/);
		await assert.rejects(() => textOf({ id: "no-such-module" }), /No curriculum entry/);
	});
});

describe("curriculum prompt", () => {
	it("composes into the teacher and stays out of the prober", () => {
		const teacher = composeInstructions("teacher");
		const prober = composeInstructions("prober");
		assert.match(teacher, /Use `curriculum`/);
		assert.match(teacher, /that lesson is the field/);
		assert.equal(prober.includes("Use `curriculum`"), false);
		assert.equal(prober.includes("that lesson is the field"), false);
	});
});

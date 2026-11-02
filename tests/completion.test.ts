import assert from "node:assert/strict";
import { test } from "node:test";
import { completedWithin } from "./completion.ts";

test("fixture completion wait returns its result and preserves its actual error", async () => {
	assert.equal(await completedWithin(Promise.resolve("saved"), "fixture save"), "saved");
	const failure = new Error("fixture persistence failed");
	await assert.rejects(completedWithin(Promise.reject(failure), "fixture save"), (error) => error === failure);
});

test("fixture completion wait fails clearly if completion never arrives", async () => {
	await assert.rejects(
		completedWithin(new Promise<never>(() => {}), "verified fixture sign-in", 0),
		/Timed out after 0ms waiting for verified fixture sign-in/,
	);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { withRecordLock } from "../src/server/record-lock.ts";

test("a canceled waiter does not let a later writer bypass an active writer", async () => {
	const active = new AbortController();
	const waiting = new AbortController();
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const order: string[] = [];
	const first = withRecordLock("plugin:record", active.signal, async () => {
		entered.resolve();
		await release.promise;
		order.push("first finished");
	});
	await entered.promise;
	let third: Promise<void> | undefined;
	try {
		const second = withRecordLock("plugin:record", waiting.signal, async () => { order.push("canceled writer ran"); });
		waiting.abort();
		await assert.rejects(second, { name: "AbortError" });
		active.abort(); // A running hook still holds the slot until it settles.
		third = withRecordLock("plugin:record", new AbortController().signal, async () => { order.push("third ran"); });
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.deepEqual(order, []);
	} finally {
		release.resolve();
		await first;
		await third;
	}
	assert.deepEqual(order, ["first finished", "third ran"]);
});

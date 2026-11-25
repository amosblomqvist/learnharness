import assert from "node:assert/strict";
import { createServer } from "node:net";
import { it } from "node:test";
import { listenForGoogleCallback } from "../src/server/cloud-loopback.ts";

it("uses a loopback-only callback, rejects invalid requests, and closes after success", async () => {
	const reservation = createServer();
	await new Promise<void>(resolve => reservation.listen(0, "127.0.0.1", resolve));
	const address = reservation.address(); assert(address && typeof address !== "string");
	await new Promise<void>(resolve => reservation.close(() => resolve()));
	const previous = process.env.LH_CLOUD_CALLBACK_PORT;
	process.env.LH_CLOUD_CALLBACK_PORT = String(address.port);
	let calls = 0;
	const listener = await listenForGoogleCallback(async url => {
		calls++;
		if (url.searchParams.get("attempt") !== "one-use") throw new Error("Invalid attempt.");
	});
	try {
		assert.equal(new URL(listener.origin).hostname, "127.0.0.1");
		assert.equal((await fetch(`${listener.origin}/wrong`)).status, 404); assert.equal(calls, 0);
		assert.equal((await fetch(`${listener.origin}/labs/google/callback?attempt=wrong`)).status, 400);
		const response = await fetch(`${listener.origin}/labs/google/callback?attempt=one-use&convexAuthCode=private-code`);
		assert.equal(response.status, 200); assert(!(await response.text()).includes("private-code"));
		assert.equal(response.headers.get("referrer-policy"), "no-referrer");
	} finally {
		listener.close();
		if (previous === undefined) delete process.env.LH_CLOUD_CALLBACK_PORT; else process.env.LH_CLOUD_CALLBACK_PORT = previous;
	}
});

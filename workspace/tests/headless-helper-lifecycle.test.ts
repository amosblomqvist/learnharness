import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { setImmediate } from "node:timers/promises";
import { it, mock } from "node:test";
import puppeteer, { type Browser } from "puppeteer-core";
import { realHeadless } from "../src/agent/subagents/headless.ts";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>(done => { resolve = done; });
	return { promise, resolve };
}

/** Production entry point, with only process/CDP transport mocked. No process,
 * browser, DNS lookup or socket is actually opened by this fixture. */
function lifecycleFixture() {
	const killed: number[] = [];
	const spawned = deferred(), heldLoad = deferred(), releaseLoad = deferred();
	let pauseHandshake = false, connections = 0;
	const helpers: ReturnType<typeof makeHelper>[] = [];
	function makeHelper(id: number) {
		let liveDocument = false, guarded = false;
		const owner = { alive: true, failRetirement: false, holdNextLoad: false };
		const proc = Object.assign(new EventEmitter(), {
			exitCode: null as number | null,
			stdout: new EventEmitter(), stderr: new EventEmitter(),
			kill: () => { killed.push(id); owner.alive = false; proc.exitCode = 0; return true; },
		});
		const page = Object.assign(new EventEmitter(), {
			target: () => ({ type: () => "page" }), url: () => "about:blank",
			setRequestInterception: async (enabled: boolean) => { guarded = enabled; },
			setContent: async () => {
				assert.equal(owner.alive, true);
				assert.equal(guarded, true);
				liveDocument = true;
				if (owner.holdNextLoad) { owner.holdNextLoad = false; heldLoad.resolve(); await releaseLoad.promise; }
			},
			goto: async () => {
				if (!owner.alive) throw new Error(`dead helper ${id}: goto`);
				if (liveDocument && owner.failRetirement) throw new Error(`owned retirement failure ${id}`);
				liveDocument = false;
			},
		});
		const browser = { pages: async () => {
			if (!owner.alive) throw new Error(`dead helper ${id}: pages`);
			return [page];
		} } as unknown as Browser;
		const handshake = () => proc.stdout.emit("data", Buffer.from(`BROWSER_SERVICE_CDP ${46000 + id}\n`));
		return { id, owner, proc, page, browser, handshake, guarded: () => guarded };
	}
	mock.method(childProcess, "spawn", (() => {
		const helper = makeHelper(helpers.length + 1);
		helpers.push(helper);
		spawned.resolve();
		if (!pauseHandshake) queueMicrotask(helper.handshake);
		return helper.proc;
	}) as unknown as typeof childProcess.spawn);
	syncBuiltinESMExports();
	mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0]) => {
		const id = Number(new URL(String(input)).port) - 46000;
		return new Response(JSON.stringify({ webSocketDebuggerUrl: `ws://owned.invalid/${id}` }));
	});
	mock.method(puppeteer, "connect", async (options: Parameters<typeof puppeteer.connect>[0]) => {
		connections++;
		const id = Number(new URL(options.browserWSEndpoint!).pathname.slice(1));
		return helpers[id - 1]!.browser;
	});
	return {
		helpers, killed, spawned, heldLoad, releaseLoad, connections: () => connections,
		pauseHandshake() { pauseHandshake = true; },
		releaseHandshakes() { pauseHandshake = false; for (const helper of helpers) helper.handshake(); },
		dispose() {
			// Mark mocks dead before restoring spawn: the next test must not reuse
			// this fixture's module-global helper, or start a real process.
			for (const helper of helpers) { helper.owner.alive = false; helper.proc.exitCode = 0; }
			mock.restoreAll(); syncBuiltinESMExports();
		},
	};
}

it("a queued production demo acquires a fresh helper after the active helper cannot retire", { timeout: 5_000 }, async () => {
	const fixture = lifecycleFixture();
	try {
		assert.equal((await realHeadless.runDemo("<p>warm</p>", { settleMs: 0 })).ok, true);
		const original = fixture.helpers[0]!;
		original.owner.failRetirement = true;
		original.owner.holdNextLoad = true;
		const first = realHeadless.runDemo("<p>failed retirement</p>", { settleMs: 0 });
		await fixture.heldLoad.promise;
		const second = realHeadless.runDemo("<p>queued success</p>", { settleMs: 0 });
		// Drain cached-import microtasks while the first document is explicitly
		// held; the queue must not acquire/capture another Browser yet.
		await setImmediate();
		const acquiredWhileHeld = fixture.connections();
		fixture.releaseLoad.resolve();
		const [failed, next] = await Promise.allSettled([first, second]);
		assert.equal(failed.status, "rejected");
		assert.match((failed as PromiseRejectedResult).reason.message, /Could not retire/);
		assert.equal(next.status, "fulfilled", "queued work must not retain the killed Browser");
		assert.equal((next as PromiseFulfilledResult<{ ok: boolean }>).value.ok, true);
		assert.equal(acquiredWhileHeld, 2, "only warm and active jobs have connected");
		assert.deepEqual(fixture.killed, [1]);
		assert.equal(original.owner.alive, false, "the unretired original helper is discarded");
		assert.equal(original.guarded(), true);
		assert.equal(original.page.listenerCount("request"), 1, "guard remains until the failed helper is killed");
		assert.equal(fixture.helpers.length, 2);
		assert.equal(fixture.helpers[1]!.owner.alive, true);
		assert.equal(fixture.helpers[1]!.guarded(), false);
		assert.equal(fixture.helpers[1]!.page.listenerCount("request"), 0);
	} finally { fixture.dispose(); }
});

it("concurrent cold-start production demos cannot replace the helper whose retirement fails", { timeout: 5_000 }, async () => {
	const fixture = lifecycleFixture();
	fixture.pauseHandshake();
	try {
		const first = realHeadless.runDemo("<p>cold failing helper</p>", { settleMs: 0 });
		await fixture.spawned.promise;
		const original = fixture.helpers[0]!;
		original.owner.failRetirement = true;
		const second = realHeadless.runDemo("<p>cold queued success</p>", { settleMs: 0 });
		await setImmediate();
		const spawnedBeforeHandshake = fixture.helpers.length;
		fixture.releaseHandshakes();
		const [failed, next] = await Promise.allSettled([first, second]);
		assert.equal(failed.status, "rejected");
		assert.match((failed as PromiseRejectedResult).reason.message, /Could not retire/);
		assert.equal(next.status, "fulfilled", "the queued job must start on its own fresh helper");
		assert.equal((next as PromiseFulfilledResult<{ ok: boolean }>).value.ok, true);
		assert.equal(spawnedBeforeHandshake, 1, "cold acquisition itself must be inside the page queue");
		assert.deepEqual(fixture.killed, [1], "never kill a later helper instead of the failed document's owner");
		assert.equal(original.owner.alive, false, "no original unretired helper remains alive");
		assert.equal(original.guarded(), true);
		assert.equal(original.page.listenerCount("request"), 1);
		assert.equal(fixture.helpers.length, 2);
		assert.equal(fixture.helpers[1]!.owner.alive, true);
		assert.equal(fixture.helpers[1]!.guarded(), false);
		assert.equal(fixture.helpers[1]!.page.listenerCount("request"), 0);
	} finally { fixture.dispose(); }
});

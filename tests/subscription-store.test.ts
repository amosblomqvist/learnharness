/**
 * Subscription credential store (issue #8, implementation plan 2026-10-19)
 * — durable, owner-only, cross-process fenced OAuth persistence.
 *
 * Every test owns a fresh real temporary directory. The store API is the
 * seam: no test imports internal helpers or reads a real user credential.
 * Child processes run the same public API through
 * tests/fixtures/subscription-store-child.ts to prove that the lock,
 * journal and generation fences survive a separate OS process.
 */

import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
	createSubscriptionStore,
	SUBSCRIPTION_JOURNAL_FILE,
	SUBSCRIPTION_LOCK_DIR,
	SUBSCRIPTION_STATE_FILE,
	SubscriptionStorageError,
	type OAuthCredential,
	type SubscriptionEnvelope,
} from "../src/store/subscription-credentials.ts";

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "lh-subscription-store-"));

after(() => {
	fs.rmSync(TMP_ROOT, { recursive: true, force: true });
});

const CREDENTIAL: OAuthCredential = {
	type: "oauth",
	access: "access-token-1",
	refresh: "refresh-token-1",
	expires: 1_800_000_000,
	accountId: "account-1",
};


const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const CHILD_SCRIPT = path.join(REPO_ROOT, "tests", "fixtures", "subscription-store-child.ts");
const TSX_IMPORT = fileURLToPath(import.meta.resolve("tsx"));

interface LineReader {
	next(timeoutMs?: number): Promise<string>;
}

interface ChildHarness {
	readonly child: ChildProcessWithoutNullStreams;
	readonly lines: LineReader;
	send(line: string): void;
	waitExit(): Promise<number | null>;
	stderr(): string;
	stop(): void;
}

function lineReader(stream: NodeJS.ReadableStream): LineReader {
	const rl = readline.createInterface({ input: stream });
	const queued: string[] = [];
	const waiters: Array<(line: string) => void> = [];
	rl.on("line", (line) => {
		const waiter = waiters.shift();
		if (waiter) waiter(line);
		else queued.push(line);
	});
	return {
		next(timeoutMs = 15_000) {
			const line = queued.shift();
			if (line !== undefined) return Promise.resolve(line);
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => {
					const index = waiters.indexOf(onLine);
					if (index >= 0) waiters.splice(index, 1);
					reject(new Error("timed out waiting for the subscription store child process"));
				}, timeoutMs);
				const onLine = (value: string) => {
					clearTimeout(timer);
					resolve(value);
				};
				waiters.push(onLine);
			});
		},
	};
}

function spawnChild(mode: string, directory: string, ...args: string[]): ChildHarness {
	const child = spawn(
		process.execPath,
		["--import", TSX_IMPORT, CHILD_SCRIPT, mode, directory, ...args],
		{
			cwd: REPO_ROOT,
			stdio: ["pipe", "pipe", "pipe"],
		},
	);
	let errorOutput = "";
	child.stderr.on("data", (chunk: Buffer | string) => {
		errorOutput += chunk.toString();
	});
	const exit = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
	return {
		child,
		lines: lineReader(child.stdout),
		send(line: string) {
			child.stdin.write(line);
		},
		waitExit() {
			return exit;
		},
		stderr() {
			return errorOutput;
		},
		stop() {
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		},
	};
}

async function ready(harness: ChildHarness): Promise<string> {
	const line = await harness.lines.next();
	assert.match(line, /^READY/, harness.stderr());
	return line;
}

function freshStore() {
	const root = fs.mkdtempSync(path.join(TMP_ROOT, "store-"));
	return {
		root,
		directory: path.join(root, "subscription"),
		store: createSubscriptionStore(path.join(root, "subscription")),
	};
}

function statePath(directory: string): string {
	return path.join(directory, SUBSCRIPTION_STATE_FILE);
}

function journalPath(directory: string): string {
	return path.join(directory, SUBSCRIPTION_JOURNAL_FILE);
}

function guardPath(directory: string): string {
	return `${path.join(directory, SUBSCRIPTION_LOCK_DIR)}.acquire`;
}

async function connect(
	store: ReturnType<typeof createSubscriptionStore>,
	credential: OAuthCredential = CREDENTIAL,
): Promise<SubscriptionEnvelope> {
	return store.transaction(async (tx) => {
		const next: SubscriptionEnvelope = {
			version: 1,
			generation: tx.state.generation,
			credential,
		};
		await tx.save(next);
		return tx.state;
	});
}

describe("subscription store — durable envelope", () => {
	it("creates an owner-only directory and a versioned envelope on first snapshot", async () => {
		const { directory, store } = freshStore();
		const snapshot = await store.snapshot();

		assert.equal(store.directory, fs.realpathSync(directory));
		assert.equal(snapshot.state.version, 1);
		assert.equal(typeof snapshot.state.generation, "string");
		assert.ok(snapshot.state.generation.length > 0);
		assert.equal(snapshot.state.credential, undefined);
		assert.equal(snapshot.journal, undefined);

		if (process.platform !== "win32") {
			assert.equal(fs.statSync(store.directory).mode & 0o777, 0o700);
			assert.equal(fs.statSync(statePath(store.directory)).mode & 0o777, 0o600);
		}
	});

	it("round-trips a strict Codex OAuth credential and attempt through separate snapshots", async () => {
		const { store } = freshStore();
		const connected = await connect(store);
		assert.deepEqual(connected.credential, CREDENTIAL);

		const attemptState = await store.transaction(async (tx) => {
			const next: SubscriptionEnvelope = {
				...tx.state,
				attempt: {
					id: "attempt-1",
					generation: tx.state.generation,
					owner: store.owner,
					expiresAt: 1_800_000_900,
					method: "browser",
				},
			};
			await tx.save(next);
			return tx.state;
		});

		assert.deepEqual(attemptState.attempt?.owner, store.owner);
		assert.equal(attemptState.attempt?.method, "browser");
		const reopened = createSubscriptionStore(store.directory);
		const snapshot = await reopened.snapshot();
		assert.deepEqual(snapshot.state, attemptState);
	});

	it("persists a tombstone with a new generation and no credential", async () => {
		const { store } = freshStore();
		const before = await connect(store);
		const after = await store.transaction(async (tx) => {
			const next: SubscriptionEnvelope = { version: 1, generation: "generation-tombstone" };
			await tx.save(next);
			return tx.state;
		});

		assert.equal(after.credential, undefined);
		assert.notEqual(after.generation, before.generation);
		const reopened = await createSubscriptionStore(store.directory).snapshot();
		assert.equal(reopened.state.credential, undefined);
		assert.equal(reopened.state.generation, "generation-tombstone");
	});

	it("rejects an unknown version and unknown fields instead of treating them as empty", async () => {
		const { store } = freshStore();
		await store.snapshot();

		fs.writeFileSync(
			statePath(store.directory),
			JSON.stringify({ version: 2, generation: "future", credential: CREDENTIAL }),
			{ mode: 0o600 },
		);
		await assert.rejects(
			store.snapshot(),
			(error: unknown) => error instanceof SubscriptionStorageError,
		);

		fs.writeFileSync(
			statePath(store.directory),
			JSON.stringify({
				version: 1,
				generation: "g",
				credential: { ...CREDENTIAL, provider: "openai-codex" },
			}),
			{ mode: 0o600 },
		);
		await assert.rejects(
			store.snapshot(),
			(error: unknown) => error instanceof SubscriptionStorageError,
		);
	});

	it("rejects a symlinked state file without reading its target", async () => {
		const { root, directory, store } = freshStore();
		await store.snapshot();
		const target = path.join(root, "outside.json");
		fs.writeFileSync(target, JSON.stringify({ version: 1, generation: "outside" }), { mode: 0o600 });
		fs.rmSync(statePath(store.directory));
		fs.symlinkSync(target, statePath(store.directory));

		await assert.rejects(
			store.snapshot(),
			(error: unknown) => error instanceof SubscriptionStorageError,
		);
		assert.equal(JSON.parse(fs.readFileSync(target, "utf8")).generation, "outside");
	});

	it("repairs a relaxed directory/file mode before exposing credentials", async () => {
		if (process.platform === "win32") return;
		const { directory, store } = freshStore();
		await connect(store);
		fs.chmodSync(directory, 0o755);
		fs.chmodSync(statePath(store.directory), 0o644);

		const snapshot = await store.snapshot();
		assert.deepEqual(snapshot.state.credential, CREDENTIAL);
		assert.equal(fs.statSync(store.directory).mode & 0o777, 0o700);
		assert.equal(fs.statSync(statePath(store.directory)).mode & 0o777, 0o600);
	});

	it("preserves the exact callback error object and always releases the lock", async () => {
		const { store } = freshStore();
		class Boom extends Error {}
		const boom = new Boom("boom");
		await assert.rejects(
			store.transaction(async () => {
				throw boom;
			}),
			(error: unknown) => error === boom,
		);

		const snapshot = await store.snapshot();
		assert.equal(snapshot.state.version, 1);
	});
});

describe("subscription store — journal and refresh fence", () => {
	it("writes a nonsecret, independent journal before a refresh and refuses a second refresh", async () => {
		const { store } = freshStore();
		await connect(store);
		const journal = await store.transaction((tx) => tx.beginRefresh());

		assert.equal(journal.version, 1);
		assert.equal(journal.generation, (await store.snapshot()).state.generation);
		const raw = fs.readFileSync(journalPath(store.directory), "utf8");
		assert.equal(raw.includes(CREDENTIAL.access), false);
		assert.equal(raw.includes(CREDENTIAL.refresh), false);
		assert.equal(raw.includes(CREDENTIAL.accountId), false);
		if (process.platform !== "win32") {
			assert.equal(fs.statSync(journalPath(store.directory)).mode & 0o777, 0o600);
		}

		const snapshot = await store.snapshot();
		assert.deepEqual(snapshot.journal, journal);
		await assert.rejects(
			store.transaction((tx) => tx.beginRefresh()),
			(error: unknown) => error instanceof SubscriptionStorageError,
		);
	});

	it("commits a rotated credential only with the matching journal and clears the journal last", async () => {
		const { store } = freshStore();
		await connect(store);
		const journal = await store.transaction((tx) => tx.beginRefresh());
		const rotated: OAuthCredential = { ...CREDENTIAL, access: "access-token-2", refresh: "refresh-token-2" };

		await assert.rejects(
			store.transaction((tx) => tx.commitRefresh(rotated, { ...journal, operationId: "wrong" })),
			(error: unknown) => error instanceof SubscriptionStorageError,
		);
		assert.ok(fs.existsSync(journalPath(store.directory)), "mismatch leaves the journal");

		await store.transaction((tx) => tx.commitRefresh(rotated, journal));
		const snapshot = await store.snapshot();
		assert.deepEqual(snapshot.state.credential, rotated);
		assert.equal(snapshot.journal, undefined);
		assert.equal(fs.existsSync(journalPath(store.directory)), false);
	});

	it("clears a journal left by an invalidated generation only on a real tombstone", async () => {
		const { store } = freshStore();
		await connect(store);
		await store.transaction((tx) => tx.beginRefresh());

		await assert.rejects(
			store.transaction((tx) => tx.clearJournalAfterDisconnect()),
			(error: unknown) => error instanceof SubscriptionStorageError,
		);

		await store.transaction((tx) =>
			tx.save({ version: 1, generation: tx.state.generation, credential: undefined }),
		);
		await assert.rejects(
			store.transaction((tx) => tx.clearJournalAfterDisconnect()),
			(error: unknown) => error instanceof SubscriptionStorageError,
			"same generation is not a disconnect fence",
		);

		await store.transaction(async (tx) => {
			await tx.save({ version: 1, generation: "generation-after-disconnect" });
			await tx.clearJournalAfterDisconnect();
		});
		const snapshot = await store.snapshot();
		assert.equal(snapshot.journal, undefined);
		assert.equal(snapshot.state.credential, undefined);
	});
});

describe("subscription store — real subprocesses", () => {
	it("proves self, foreign and dead process liveness", async () => {
		const { store } = freshStore();
		assert.equal(store.isOwnerAlive(store.owner), true);
		assert.equal(store.isOwnerAlive({ ...store.owner, host: "elsewhere.invalid" }), "unknown");

		const harness = spawnChild("owner", store.directory);
		try {
			const owner = JSON.parse(await harness.lines.next());
			assert.equal(await harness.waitExit(), 0, harness.stderr());
			assert.equal(store.isOwnerAlive(owner), false);
		} finally {
			harness.stop();
		}
	});

	it("reclaims a lock only after the recorded owner process has exited", async () => {
		const { store } = freshStore();
		const harness = spawnChild("crash-lock", store.directory);
		try {
			await ready(harness);
			assert.equal(await harness.waitExit(), 0, harness.stderr());
			const snapshot = await store.snapshot();
			assert.equal(snapshot.state.version, 1);
			assert.equal(fs.existsSync(path.join(store.directory, SUBSCRIPTION_LOCK_DIR)), false);
			assert.equal(fs.existsSync(guardPath(store.directory)), false);
		} finally {
			harness.stop();
		}
	});

	it("fails closed while another live process holds the lock, then proceeds after release", async () => {
		const { store } = freshStore();
		const harness = spawnChild("hold", store.directory);
		try {
			await ready(harness);
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), 200);
			await assert.rejects(
				store.transaction(async () => undefined, controller.signal),
				(error: unknown) =>
					error instanceof DOMException && error.name === "AbortError",
			);
			clearTimeout(timer);

			harness.send("release\n");
			assert.equal(await harness.lines.next(), "RELEASED");
			assert.equal(await harness.waitExit(), 0, harness.stderr());
			await store.snapshot();
		} finally {
			harness.stop();
		}
	});

	it("rejects a stale owner write after the lock nonce changes", async () => {
		const { store } = freshStore();
		await connect(store);
		const harness = spawnChild("paused-write", store.directory);
		try {
			await ready(harness);
			const ownerPath = path.join(store.directory, SUBSCRIPTION_LOCK_DIR, "owner.json");
			const recorded = JSON.parse(fs.readFileSync(ownerPath, "utf8"));
			fs.writeFileSync(ownerPath, JSON.stringify({ ...recorded, nonce: "taken-over" }), {
				mode: 0o600,
			});

			harness.send("write\n");
			assert.equal(await harness.lines.next(), "ERROR SubscriptionStorageError");
			assert.match(await harness.lines.next(), /^FATAL SubscriptionStorageError$/);
			await harness.waitExit();

			const snapshot = await store.snapshot();
			assert.deepEqual(snapshot.state.credential, CREDENTIAL);
		} finally {
			harness.stop();
		}
	});

	it("keeps a refresh journal written by a crashed process across lock recovery", async () => {
		const { store } = freshStore();
		await connect(store);
		const harness = spawnChild("journal-crash", store.directory);
		try {
			await ready(harness);
			assert.equal(await harness.waitExit(), 0, harness.stderr());

			const snapshot = await store.snapshot();
			assert.ok(snapshot.journal);
			assert.deepEqual(snapshot.state.credential, CREDENTIAL);
			await assert.rejects(
				store.transaction((tx) => tx.beginRefresh()),
				(error: unknown) =>
					error instanceof SubscriptionStorageError && error.code === "journal_exists",
			);

			await store.transaction(async (tx) => {
				await tx.save({ version: 1, generation: "generation-after-crash-disconnect" });
				await tx.clearJournalAfterDisconnect();
			});
			assert.equal((await store.snapshot()).journal, undefined);
		} finally {
			harness.stop();
		}
	});

	it("does not reclaim or delete a lock whose owner is unknown", async () => {
		const { store } = freshStore();
		await store.snapshot();
		const lockDir = path.join(store.directory, SUBSCRIPTION_LOCK_DIR);
		fs.mkdirSync(lockDir, { mode: 0o700 });
		const ownerPath = path.join(lockDir, "owner.json");
		fs.writeFileSync(
			ownerPath,
			JSON.stringify({
				host: "elsewhere.invalid",
				pid: process.pid,
				nonce: "foreign-owner",
				processBirth: "foreign-birth",
			}),
			{ mode: 0o600 },
		);

		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 200);
		try {
			await assert.rejects(
				store.transaction(async () => undefined, controller.signal),
				(error: unknown) =>
					error instanceof DOMException && error.name === "AbortError",
			);
			assert.ok(fs.existsSync(lockDir), "unknown owner lock is never deleted");
			assert.equal(JSON.parse(fs.readFileSync(ownerPath, "utf8")).nonce, "foreign-owner");
		} finally {
			clearTimeout(timer);
			fs.rmSync(lockDir, { recursive: true, force: true });
		}
	});

	it("fails closed on an orphan acquisition guard and never enters the critical section", async () => {
		const { store } = freshStore();
		await store.snapshot();
		const lockDir = path.join(store.directory, SUBSCRIPTION_LOCK_DIR);
		fs.mkdirSync(lockDir, { mode: 0o700 });
		fs.writeFileSync(
			path.join(lockDir, "owner.json"),
			JSON.stringify({
				host: os.hostname(),
				pid: 999_999,
				nonce: "dead-main-owner",
				processBirth: "dead-main-birth",
			}),
			{ mode: 0o600 },
		);
		const guardDir = guardPath(store.directory);
		fs.mkdirSync(guardDir, { mode: 0o700 });
		const guardOwnerPath = path.join(guardDir, "owner.json");
		fs.writeFileSync(
			guardOwnerPath,
			JSON.stringify({
				host: os.hostname(),
				pid: 999_999,
				nonce: "dead-guard-owner",
				processBirth: "dead-guard-birth",
			}),
			{ mode: 0o600 },
		);

		const children = [spawnChild("abort-transaction", store.directory, "350")];
		children.push(spawnChild("abort-transaction", store.directory, "350"));
		try {
			for (const child of children) {
				assert.equal(await child.lines.next(), "ABORTED AbortError", child.stderr());
				assert.equal(await child.waitExit(), 0, child.stderr());
			}
			assert.ok(fs.existsSync(guardDir), "an orphan guard is never auto-reclaimed");
			assert.equal(
				JSON.parse(fs.readFileSync(guardOwnerPath, "utf8")).nonce,
				"dead-guard-owner",
			);
			assert.equal(
				JSON.parse(fs.readFileSync(path.join(lockDir, "owner.json"), "utf8")).nonce,
				"dead-main-owner",
				"the guard must prevent a dead-main reclaim",
			);
		} finally {
			for (const child of children) child.stop();
			fs.rmSync(guardDir, { recursive: true, force: true });
			fs.rmSync(lockDir, { recursive: true, force: true });
		}
	});

	it("serializes a multi-process acquisition critical section after a dead owner", async () => {
		const { store } = freshStore();
		const crash = spawnChild("crash-lock", store.directory);
		try {
			await ready(crash);
			assert.equal(await crash.waitExit(), 0, crash.stderr());
		} finally {
			crash.stop();
		}

		const children = Array.from({ length: 4 }, () =>
			spawnChild("contend", store.directory, "120"),
		);
		try {
			const results = await Promise.all(
				children.map(async (child) => {
					const lines: string[] = [];
					for (let index = 0; index < 3; index += 1) {
						const line = await child.lines.next(15_000);
						lines.push(line);
						if (line === "DONE" || line === "OVERLAP" || line.startsWith("FATAL")) break;
					}
					return { lines, code: await child.waitExit(), stderr: child.stderr() };
				}),
			);
			for (const result of results) {
				assert.deepEqual(result.lines, ["ENTER", "EXIT", "DONE"], result.stderr);
				assert.equal(result.code, 0, result.stderr);
			}
			assert.equal(fs.existsSync(path.join(store.directory, SUBSCRIPTION_LOCK_DIR)), false);
			assert.equal(fs.existsSync(guardPath(store.directory)), false);
			assert.equal(
				fs.existsSync(path.join(store.directory, "critical-section.marker")),
				false,
			);
		} finally {
			for (const child of children) child.stop();
			fs.rmSync(path.join(store.directory, "critical-section.marker"), { force: true });
		}
	});

});

describe("subscription store — contract edges", () => {
	it("honours an already-aborted signal before creating a lock", async () => {
		const { store } = freshStore();
		const controller = new AbortController();
		controller.abort();
		await assert.rejects(
			store.transaction(async () => undefined, controller.signal),
			(error: unknown) => error instanceof DOMException && error.name === "AbortError",
		);
		assert.equal(fs.existsSync(path.join(store.directory, SUBSCRIPTION_LOCK_DIR)), false);
	});

	it("requires a credential to begin a refresh and a journal to commit one", async () => {
		const { store } = freshStore();
		await assert.rejects(
			store.transaction((tx) => tx.beginRefresh()),
			(error: unknown) =>
				error instanceof SubscriptionStorageError && error.code === "no_credential",
		);
		await connect(store);
		await assert.rejects(
			store.transaction((tx) =>
				tx.commitRefresh(CREDENTIAL, {
					version: 1,
					generation: "journal-without-begin",
					operationId: "operation-without-begin",
				}),
			),
			(error: unknown) =>
				error instanceof SubscriptionStorageError && error.code === "journal_required",
		);
	});

	it("refuses a symlinked journal and leaves both the link and its target intact", async () => {
		if (process.platform === "win32") return;
		const { root, store } = freshStore();
		await connect(store);
		const target = path.join(root, "outside-journal.json");
		fs.writeFileSync(
			target,
			JSON.stringify({ version: 1, generation: "outside", operationId: "outside" }),
			{ mode: 0o600 },
		);
		fs.symlinkSync(target, journalPath(store.directory));

		await assert.rejects(
			store.snapshot(),
			(error: unknown) => error instanceof SubscriptionStorageError,
		);
		assert.ok(fs.lstatSync(journalPath(store.directory)).isSymbolicLink());
		assert.equal(JSON.parse(fs.readFileSync(target, "utf8")).operationId, "outside");
	});
});

describe("subscription store — snapshot separation", () => {
	it("reads the envelope even when an uncertain journal is unreadable, without clearing it", async () => {
		const { store } = freshStore();
		const connected = await connect(store);
		fs.writeFileSync(journalPath(store.directory), "{not-json", { mode: 0o600 });

		const envelope = await store.getSnapshot();
		assert.deepEqual(envelope, connected);
		await assert.rejects(
			store.snapshot(),
			(error: unknown) => error instanceof SubscriptionStorageError,
		);
		assert.equal(fs.readFileSync(journalPath(store.directory), "utf8"), "{not-json");
	});
});

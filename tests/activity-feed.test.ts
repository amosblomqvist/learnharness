/**
 * Activity-feed tests — the dock's composition (server/observability.ts).
 *
 * Real stores with fixture chats/jobs, cleaned up in a top-level test.
 * Verifies the cross-chat gathering, running-only filtering, title joins,
 * stable oldest-first ordering, and busy-chat reporting.
 */
import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";

import { chatStore } from "../src/store/chats.ts";
import { jobStore } from "../src/store/jobs.ts";
import { PATHS } from "../config.ts";
import { activityFeed } from "../src/server/observability.ts";

test("activityFeed: running jobs across ALL chats, running-only, title-joined, oldest first", () => {
	const chatA = chatStore.createChat("feed chat A");
	const chatB = chatStore.createChat("feed chat B");
	// job ids tracked as created — the finally cleanup stays scoped to them even
	// if the test throws mid-way (test files run as concurrent processes over
	// the shared data/ scratch; wiping the whole jobs dir would delete other
	// processes' live fixtures — the wave-4 flake lesson)
	const createdJobs: string[] = [];
	try {
		const jobA = jobStore.createJob({ kind: "research", chatId: chatA.id, toolCallId: "tc_a" });
		const jobB = jobStore.createJob({ kind: "demo", chatId: chatB.id, toolCallId: "tc_b" });
		const jobDone = jobStore.createJob({ kind: "research", chatId: chatA.id, toolCallId: "tc_done" });
		createdJobs.push(jobA.id, jobB.id, jobDone.id);
		jobStore.updateJob(jobDone.id, { status: "done" });
		const jobB2 = jobStore.createJob({ kind: "research", chatId: chatB.id, toolCallId: "tc_b2" });
		createdJobs.push(jobB2.id);
		// make jobB2 the MOST recently active → should still sort AFTER jobA/jobB (oldest-first).
		// Explicit later timestamp: the real bump can land in the same ms as creation.
		jobStore.updateJob(jobB2.id, { activity: "second step", updatedAt: new Date(Date.now() + 10).toISOString() });

		const feed = activityFeed();
		const feedJobs = feed.jobs.filter((j) => [jobA.id, jobB.id, jobB2.id].includes(j.id));
		assert.equal(feedJobs.length, 3); // done job filtered out
		for (const j of feedJobs) {
			assert.ok(j.title.length > 0, "title joined onto every job");
			assert.equal(typeof j.chatId, "string");
		}
		// title join is the chat's title
		assert.equal(feedJobs.find((j) => j.id === jobA.id)?.title, "feed chat A");
		// oldest-first on updatedAt: jobA/jobB created before jobB2's bump
		const order = feedJobs.map((j) => j.id);
		assert.equal(order.indexOf(jobB2.id), order.length - 1);

		// extraction runs are absent when the pipeline is idle (registry empty)
		assert.deepEqual(feed.extractions, []);
	} finally {
		fs.unlinkSync(`${PATHS.chats}/${chatA.id}.json`);
		fs.unlinkSync(`${PATHS.chats}/${chatB.id}.json`);
		const jobsDir = path.join(PATHS.data, "jobs");
		for (const id of createdJobs) {
			fs.unlinkSync(path.join(jobsDir, `${id}.json`));
		}
	}
});

test("activityFeed: contextLimit is the server's live-catalog join (owner amendment, 2026-09-23)", () => {
	// keyed-provider federation — the same env-key pattern as the
	// model-catalog tests; file-local (each test file is its own process)
	process.env.OPENROUTER_API_KEY ??= "test-key-openrouter-catalog";
	const chat = chatStore.createChat("limit join chat");
	const createdJobs: string[] = [];
	const usageFor = (model: string) => ({
		model,
		inputTokens: 1_000,
		outputTokens: 100,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		reasoningTokens: 0,
		steps: 1,
	});
	try {
		const known = jobStore.createJob({ kind: "research", chatId: chat.id, toolCallId: "tc_known" });
		const unknown = jobStore.createJob({ kind: "research", chatId: chat.id, toolCallId: "tc_unknown" });
		const bare = jobStore.createJob({ kind: "research", chatId: chat.id, toolCallId: "tc_bare" });
		createdJobs.push(known.id, unknown.id, bare.id);
		jobStore.updateJob(known.id, { usage: usageFor("openrouter:z-ai/glm-5.3-flash") });
		jobStore.updateJob(unknown.id, { usage: usageFor("nope/unknown") });

		const feed = activityFeed();
		const knownJob = feed.jobs.find((j) => j.id === known.id)!;
		// pi 1.0.2's catalog: glm-5.3-flash contextWindow 1_048_575 (was
		// 1_048_576 at 0.87.1 — upstream models.dev refresh).
		assert.equal(knownJob.contextLimit, 1_048_575, "pi's catalog, joined server-side onto the feed");
		assert.ok(knownJob.costUsd !== null && Math.abs(knownJob.costUsd - 0.0002) < 1e-12, "Pi's price is projected on the server");
		const unknownJob = feed.jobs.find((j) => j.id === unknown.id)!;
		assert.equal(unknownJob.contextLimit, null, "missing from the live catalog → null, never a guessed window");
		assert.equal(unknownJob.costUsd, null);
		const bareJob = feed.jobs.find((j) => j.id === bare.id)!;
		assert.equal(bareJob.contextLimit, null, "no usage yet → no context line");
		assert.equal(bareJob.costUsd, null);
	} finally {
		fs.unlinkSync(`${PATHS.chats}/${chat.id}.json`);
		const jobsDir = path.join(PATHS.data, "jobs");
		for (const id of createdJobs) {
			fs.unlinkSync(path.join(jobsDir, `${id}.json`));
		}
	}
});

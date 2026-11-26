import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-job-store-cache-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { jobStore } = await import("../src/store/jobs.ts");

after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

describe("jobStore stat-validated cache", () => {
	it("reflects local updates, deletes, external edits, and isolates caller mutations", () => {
		const job = jobStore.createJob({ kind: "research", chatId: "c1", toolCallId: "tc1" });
		const first = jobStore.listJobs("c1");
		assert.equal(first.length, 1);
		assert.equal(first[0]?.activity, "starting");

		// Caller mutation must not corrupt cached entry.
		if (first[0]) first[0].activity = "mutated";
		assert.equal(jobStore.getJob(job.id)?.activity, "starting");

		jobStore.updateJob(job.id, { activity: "fetching", status: "running" });
		assert.equal(jobStore.listJobs("c1")[0]?.activity, "fetching");

		// External file modification invalidates cache.
		const file = path.join(TMP_DATA, "jobs", `${job.id}.json`);
		const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { activity: string };
		raw.activity = "updated externally on disk";
		fs.writeFileSync(file, JSON.stringify(raw, null, "\t"));
		assert.equal(jobStore.listJobs("c1")[0]?.activity, "updated externally on disk");

		assert.equal(jobStore.deleteJobsForChat("c1"), 1);
		assert.equal(jobStore.listJobs("c1").length, 0);
	});
});

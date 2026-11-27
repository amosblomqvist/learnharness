/**
 * The local transcription key is bound to the base URL it was saved for:
 * it reaches that URL, a URL change clears it before the new URL is stored,
 * and the key list reports it cleared. Exercised through the real routes.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-local-stt-key-"));
process.env.LH_DATA_DIR = dir;
process.env.LH_AUTH_FILE = path.join(dir, "auth.json");
const AUTH_FILE = process.env.LH_AUTH_FILE;
const savedEnvKey = process.env.LOCAL_STT_API_KEY;
delete process.env.LOCAL_STT_API_KEY;

type Endpoint = { server: Server; base: string; seen: IncomingHttpHeaders[] };
async function endpoint(): Promise<Endpoint> {
	const seen: IncomingHttpHeaders[] = [];
	const server = createServer((req, res) => {
		req.resume();
		req.on("end", () => {
			seen.push(req.headers);
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ text: "ok" }));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, seen };
}

let first: Endpoint;
let second: Endpoint;
let keysRoute: typeof import("../app/api/keys/route.ts");
let keyRoute: typeof import("../app/api/keys/[id]/route.ts");
let settingsRoute: typeof import("../app/api/settings/[section]/route.ts");
let sttRoute: typeof import("../app/api/stt/transcribe/route.ts");
let encodeWav: typeof import("../src/core/dictation.ts").encodeWav;
let localSttKeyFor: typeof import("../src/server/local-stt-auth.ts").localSttKeyFor;

before(async () => {
	[first, second] = await Promise.all([endpoint(), endpoint()]);
	keysRoute = await import("../app/api/keys/route.ts");
	keyRoute = await import("../app/api/keys/[id]/route.ts");
	settingsRoute = await import("../app/api/settings/[section]/route.ts");
	sttRoute = await import("../app/api/stt/transcribe/route.ts");
	({ encodeWav } = await import("../src/core/dictation.ts"));
	({ localSttKeyFor } = await import("../src/server/local-stt-auth.ts"));
});
after(async () => {
	await Promise.all([first, second].map((e) => new Promise<void>((resolve) => e.server.close(() => resolve()))));
	fs.rmSync(dir, { recursive: true, force: true });
	delete process.env.LH_DATA_DIR;
	delete process.env.LH_AUTH_FILE;
	if (savedEnvKey !== undefined) process.env.LOCAL_STT_API_KEY = savedEnvKey;
});

const json = (method: string, url: string, body: unknown) => new Request(url, {
	method, headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});
const putDictation = async (dictation: Record<string, unknown>) => {
	const res = await settingsRoute.PUT(json("PUT", "http://127.0.0.1/api/settings/dictation", dictation), { params: Promise.resolve({ section: "dictation" }) });
	assert.equal(res.status, 200);
	return (await res.json()) as { localSttKeyCleared?: boolean };
};
const saveKey = async (value: string) => {
	const res = await keyRoute.PUT(json("PUT", "http://127.0.0.1/api/keys/LOCAL_STT_API_KEY", { value }), { params: Promise.resolve({ id: "LOCAL_STT_API_KEY" }) });
	assert.equal(res.status, 200);
};
const keyRow = async () => {
	const body = (await (await keysRoute.GET()).json()) as { keys: { id: string; present: boolean; masked: string | null; source: string }[] };
	return body.keys.find((k) => k.id === "LOCAL_STT_API_KEY")!;
};
const transcribe = async () => {
	const res = await sttRoute.POST(new Request("http://127.0.0.1:3999/api/stt/transcribe?language=en", {
		method: "POST", headers: { host: "127.0.0.1:3999", "content-type": "audio/wav" }, body: encodeWav([new Int16Array(160)], 16000),
	}));
	assert.equal(res.status, 200, await res.clone().text());
};
const authRecord = () => JSON.parse(fs.readFileSync(AUTH_FILE, "utf8")) as Record<string, string>;

describe("local transcription key binding", () => {
	it("sends the key to the URL it was saved for", async () => {
		await putDictation({ provider: "local", localBaseUrl: first.base });
		await saveKey("secret-for-first");
		assert.deepEqual(JSON.parse(authRecord().__learnharness_local_stt_binding!), { version: 1, baseUrl: first.base });
		assert.equal(authRecord().LOCAL_STT_API_KEY, "secret-for-first");
		assert.equal(process.env.LOCAL_STT_API_KEY, undefined, "the bound key is never reflected into the environment");
		const row = await keyRow();
		assert.equal(row.present, true);
		assert.equal(row.masked, "••••");
		assert.equal(row.source, "file");
		await transcribe();
		assert.equal(first.seen.at(-1)?.authorization, "Bearer secret-for-first");
	});

	it("unrelated dictation edits keep the key", async () => {
		const result = await putDictation({ provider: "local", localBaseUrl: first.base, language: "pl" });
		assert.equal(result.localSttKeyCleared, undefined);
		assert.equal((await keyRow()).present, true);
	});

	it("after a URL change the key is cleared and not sent to the new URL", async () => {
		const result = await putDictation({ provider: "local", localBaseUrl: second.base, language: "pl" });
		assert.equal(result.localSttKeyCleared, true);
		assert.equal(authRecord().LOCAL_STT_API_KEY, undefined);
		assert.equal(authRecord().__learnharness_local_stt_binding, undefined);
		const row = await keyRow();
		assert.equal(row.present, false);
		assert.equal(row.masked, null);
		await transcribe();
		assert.equal(second.seen.at(-1)?.authorization, undefined);
	});

	it("switching back does not resurrect the old key", async () => {
		await putDictation({ provider: "local", localBaseUrl: first.base });
		await transcribe();
		assert.equal(first.seen.at(-1)?.authorization, undefined);
	});

	it("a binding for another URL (a hand-edited record) is never sent", async () => {
		await saveKey("secret-again");
		fs.writeFileSync(AUTH_FILE, JSON.stringify({ ...authRecord(), __learnharness_local_stt_binding: JSON.stringify({ version: 1, baseUrl: second.base }) }));
		assert.equal(localSttKeyFor(first.base), undefined);
		assert.equal((await keyRow()).present, false);
		await transcribe();
		assert.equal(first.seen.at(-1)?.authorization, undefined);
	});

	it("an environment value is never sent (it cannot carry a binding)", async () => {
		fs.writeFileSync(AUTH_FILE, "{}");
		process.env.LOCAL_STT_API_KEY = "from-env";
		try {
			await transcribe();
			assert.equal(first.seen.at(-1)?.authorization, undefined);
		} finally {
			delete process.env.LOCAL_STT_API_KEY;
		}
	});

	it("deleting the key removes the key and its binding together", async () => {
		await saveKey("secret-3");
		const res = await keyRoute.DELETE(new Request("http://127.0.0.1/api/keys/LOCAL_STT_API_KEY", { method: "DELETE" }), { params: Promise.resolve({ id: "LOCAL_STT_API_KEY" }) });
		assert.equal(res.status, 200);
		assert.equal(authRecord().LOCAL_STT_API_KEY, undefined);
		assert.equal(authRecord().__learnharness_local_stt_binding, undefined);
	});
});

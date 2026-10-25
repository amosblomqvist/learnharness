/** Offline packaged-server ACP exercise across real HTTP routes. Requires a
 * curated standalone build. Uses only the fixture adapter and disposable data.
 * node scripts/smoke-acp-reuse.mjs [--electron] */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import net from "node:net";
import { setTimeout as wait } from "node:timers/promises";
import { probeEnv } from "./smoke-demo-runtime.mjs";

const root = path.resolve(import.meta.dirname, "..");
const standalone = path.join(root, ".next", "standalone");
const electron = process.argv.includes("--electron");
const runtime = electron ? createRequire(import.meta.url)("electron") : process.execPath;
assert.ok(fs.existsSync(path.join(standalone, "server.js")), "Build and curate the standalone app first");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "lh-acp-http-smoke-"));
const trace = path.join(home, "calls.jsonl");
const host = path.join(home, "acp-host.json");
fs.writeFileSync(path.join(home, "auth.json"), "{}\n");
fs.writeFileSync(host, JSON.stringify({ codex: { command: process.execPath, args: [path.join(root, "tests", "fixtures", "acp-agent.mjs"), "reuse-question", trace] } }));
const port = await new Promise((resolve, reject) => {
	const server = net.createServer();
	server.once("error", reject);
	server.listen(0, "127.0.0.1", () => { const port = server.address().port; server.close(() => resolve(port)); });
});
const base = `http://127.0.0.1:${port}`;
const child = spawn(runtime, [path.join(standalone, "server.js")], {
	cwd: standalone, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
	env: { ...probeEnv(process.env, home), ...(electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}), HOSTNAME: "127.0.0.1", PORT: String(port), LH_LOCAL_APP: "1", LH_ACP_HOST_CONFIG: host },
});
let tail = "";
let exited = false;
child.once("exit", () => { exited = true; });
const keep = (buffer) => { tail = (tail + buffer.toString()).slice(-8000); };
child.stdout.on("data", keep);
child.stderr.on("data", keep);

async function json(route, method = "GET", body) {
	const response = await fetch(base + route, { method, headers: { origin: base, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
	const data = await response.json();
	assert.ok(response.ok, `${method} ${route}: ${response.status} ${JSON.stringify(data)}`);
	return data;
}
async function settled(id) {
	const end = Date.now() + 20_000;
	while (Date.now() < end) {
		const record = await json(`/api/chats/${id}`);
		if (!record.turnInFlight) return record;
		await wait(50);
	}
	throw new Error("Packaged ACP turn did not settle");
}
const text = (message) => message.content.filter((part) => part.type === "text").map((part) => part.text).join("");
async function pose() {
	const chat = await json("/api/chats", "POST", { title: "Disposable ACP reuse exercise" });
	await json(`/api/chats/${chat.id}/settings`, "PUT", { model: { provider: "acp-codex", id: "default" } });
	await json("/api/chat", "POST", { chatId: chat.id, input: { type: "text", text: "Teach me about planets." } });
	const record = await settled(chat.id);
	const assistant = record.messages.find((message) => message.role === "assistant");
	assert.ok(assistant, "Native fixture must produce a teaching question");
	const call = assistant.content.find((part) => part.type === "toolCall");
	assert.equal(call?.name, "ask_user_question");
	const native = JSON.parse(text(assistant));
	assert.ok(fs.existsSync(native.cwd), "Paused question should retain its native workspace");
	return { id: chat.id, call, native };
}
function gone(native) {
	assert.equal(fs.existsSync(native.cwd), false, "Native workspace must be disposed");
	assert.throws(() => process.kill(native.pid, 0), "Native adapter must exit");
}

try {
	const end = Date.now() + 20_000;
	let ready = false;
	while (Date.now() < end && !exited) {
		try { if ((await fetch(base + "/api/acp", { signal: AbortSignal.timeout(1000) })).ok) { ready = true; break; } } catch { /* Boot still pending. */ }
		await wait(100);
	}
	assert.ok(ready, "Packaged server must start");
	await json("/api/acp/codex", "POST", {});
	const first = await pose();
	await json("/api/chat", "POST", { chatId: first.id, input: { type: "answer", toolCallId: first.call.id, answer: { kind: "ask", questionText: first.call.arguments.question, dontKnow: false, answers: [], text: "Beginner" } } });
	const answered = await settled(first.id);
	const last = answered.messages.filter((message) => message.role === "assistant").at(-1);
	const reply = JSON.parse(text(last));
	assert.equal(reply.pid, first.native.pid, "A new HTTP turn must reuse the question's native process");
	assert.equal(reply.replayed, false);
	assert.match(JSON.stringify(reply.results), /Beginner/);
	assert.equal(fs.readFileSync(trace, "utf8").trim().split("\n").filter((line) => JSON.parse(line).event === "prompt").length, 1);
	gone(first.native);
	const deleted = await pose();
	await json(`/api/chats/${deleted.id}?mode=preserve-graph`, "DELETE");
	gone(deleted.native);
	const disconnected = await pose();
	await json("/api/acp/codex", "DELETE");
	gone(disconnected.native);
	console.log(`[smoke-acp-reuse] ${electron ? "Electron" : "host Node"}: question/answer reused one session and prompt; chat deletion and disconnect disposed native state across HTTP routes`);
} catch (error) {
	console.error(tail);
	throw error;
} finally {
	if (!exited) {
		await json("/api/acp/codex", "DELETE").catch(() => {});
		if (!exited) {
			const done = once(child, "exit");
			child.kill();
			await done;
		}
	}
	if (path.dirname(home) === path.resolve(os.tmpdir()) && path.basename(home).startsWith("lh-acp-http-smoke-")) fs.rmSync(home, { recursive: true, force: true });
}

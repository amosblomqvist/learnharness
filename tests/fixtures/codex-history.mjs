// Offline stand-in for Codex app-server: ordinary threads persist, ephemeral
// threads don't. Never opens the user's Codex home, credentials or network.
import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";
import path from "node:path";

createInterface({ input: process.stdin }).on("line", (line) => {
	const rpc = JSON.parse(line);
	if (rpc.method !== "thread/start") return;
	const ephemeral = rpc.params?.ephemeral === true && process.env.LH_TEST_IGNORE_EPHEMERAL !== "1";
	if (!ephemeral) writeFileSync(path.join(process.env.LH_TEST_HISTORY_DIR, "persisted-thread.json"), JSON.stringify(rpc.params));
	process.stdout.write(`${JSON.stringify({ id: rpc.id, result: { thread: { id: "fixture", ephemeral, path: ephemeral ? null : "persisted-thread.json" } } })}\n`);
});

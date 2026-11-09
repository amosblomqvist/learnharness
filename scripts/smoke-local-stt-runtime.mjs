/**
 * OFFLINE on-device dictation gate: load transcribe-cpp's native library and the bundled
 * Silero VAD from INSIDE the standalone payload, with the packaged runtime.
 *
 * Importing the package from the payload is not enough: .next/standalone sits inside the
 * repo, so a package the tracer missed would still resolve from the checkout's
 * node_modules and the gate would pass here and fail on a user's machine. The native
 * library path is therefore asserted to lie inside the payload.
 *
 * node scripts/smoke-local-stt-runtime.mjs [--standalone <dir>] [--runtime <Node/Electron>]
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { probeEnv } from "./smoke-demo-runtime.mjs";

export function verifyLocalSttRuntime(standalone, runtime = process.execPath) {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "lh-local-stt-runtime-"));
	try {
		const result = spawnSync(runtime, [fileURLToPath(import.meta.url), "--probe", path.resolve(standalone)], {
			cwd: home,
			env: { ...probeEnv(process.env, home), ELECTRON_RUN_AS_NODE: "1" },
			encoding: "utf8", timeout: 60_000, maxBuffer: 128 * 1024,
		});
		if (result.status !== 0 || result.error) {
			throw new Error(`local STT runtime probe failed (${result.error?.message ?? result.status}):\n${result.stdout ?? ""}${result.stderr ?? ""}`);
		}
		assert.match(result.stdout, /local STT runtime passed/, "probe exited without success marker");
		process.stdout.write(result.stdout);
	} finally { fs.rmSync(home, { recursive: true, force: true }); }
}

async function probe(standalone) {
	const root = fs.realpathSync(standalone);
	const inside = (file, what) => {
		const relative = path.relative(root, fs.realpathSync(file));
		assert.ok(relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative),
			`${what} escaped the standalone payload: ${file}`);
	};
	const entry = path.join(root, "node_modules", "transcribe-cpp", "dist", "index.js");
	const engine = await import(pathToFileURL(entry).href);
	inside(engine.libraryPath(), "the native transcribe library");
	const backends = await engine.getAvailableBackendsAsync();
	assert.ok(backends.length > 0, "transcribe.cpp reports no compute device");
	const silero = path.join(root, "src", "server", "local-stt", "silero-vad-v6.2-F32.gguf");
	const model = await engine.TranscribeModel.load(silero);
	try {
		const session = model.createVadSession();
		const { probs } = await session.run(new Float32Array(16000));
		session.dispose();
		assert.equal(probs.length, 32);
		assert.ok(Math.max(...probs) < 0.1, "Silero scored silence as speech");
	} finally { model.dispose(); }
	console.log(`[smoke-local-stt-runtime] local STT runtime passed: native library ${path.relative(root, engine.libraryPath())}, ${backends.length} compute device(s), Silero scored silence low`);
}

const args = process.argv.slice(2);
if (args[0] === "--probe") {
	probe(args[1]).catch((error) => { console.error(error); process.exit(1); });
} else if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const flag = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
	try {
		verifyLocalSttRuntime(flag("--standalone", path.resolve(import.meta.dirname, "..", ".next", "standalone")), flag("--runtime", process.execPath));
	} catch (error) { console.error(error.message); process.exit(1); }
}

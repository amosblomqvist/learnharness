/** Repair Next's generated standalone traces without changing source data. */
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const portable = (file) => file.replace(/\\/g, "/");
const contained = (directory, file) => {
	const relative = path.relative(directory, file);
	return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
const stat = (file) => {
	try {
		return fs.lstatSync(file);
	} catch (error) {
		if (error.code === "ENOENT") return null;
		throw error;
	}
};

function traceFiles(directory) {
	if (!fs.existsSync(directory)) return [];
	return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const file = path.join(directory, entry.name);
		if (entry.isDirectory()) return traceFiles(file);
		return entry.isFile() && entry.name.endsWith(".nft.json") ? [file] : [];
	});
}

function privateFile(relative) {
	const file = process.platform === "win32" ? portable(relative).toLowerCase() : portable(relative);
	return file === "data" || file.startsWith("data/") || file === "auth.json"
		|| (!file.includes("/") && file.startsWith(".env"));
}

export async function repairStandaloneTraces(root) {
	const build = path.join(root, ".next");
	const standalone = path.join(build, "standalone");
	const realRoot = fs.realpathSync(root);
	const realStandalone = path.join(realRoot, ".next", "standalone");
	if (fs.realpathSync(standalone) !== realStandalone) {
		throw new Error("REFUSING: standalone must be a generated directory inside the build, not a symlink.");
	}

	// Check both lexical containment and existing ancestors before any mutation.
	// A junction/symlink in the payload must never redirect cleanup to source data.
	const checkedTarget = (relative) => {
		const target = path.resolve(standalone, relative);
		if (target === standalone || !contained(standalone, target)) {
			throw new Error("REFUSING: trace target escapes the standalone payload.");
		}
		let ancestor = target;
		while (!stat(ancestor)) ancestor = path.dirname(ancestor);
		if (!contained(realStandalone, fs.realpathSync(ancestor))) {
			throw new Error("REFUSING: trace target redirects outside the standalone payload.");
		}
		return target;
	};

	const traces = [
		...fs.readdirSync(build).filter((name) => name.endsWith(".nft.json")).map((name) => path.join(build, name)),
		...traceFiles(path.join(build, "server")),
	].map((file) => ({ file, value: JSON.parse(fs.readFileSync(file, "utf8")), changed: false }));
	const copies = new Set();
	let excluded = 0;
	for (const trace of traces) {
		trace.value.files = trace.value.files.filter((file) => {
			// Next 16 joins exclusion globs with Windows backslashes before
			// picomatch, which treats them as escapes. Normalize trace paths
			// ourselves and match only project-root private locations.
			const absolute = path.resolve(path.dirname(trace.file), portable(file));
			const relative = path.relative(root, absolute);
			if (!contained(root, absolute) || !privateFile(relative)) return true;
			copies.add(checkedTarget(relative));
			trace.changed = true;
			excluded++;
			return false;
		});
	}

	// Only unlink files explicitly owned by a trace. Unknown leaked files stay
	// in place and make build-server's existing fail-closed checks reject them.
	for (const target of copies) {
		const info = stat(target);
		if (!info) continue;
		if (!info.isFile()) throw new Error("REFUSING: traced private payload entry is not a regular file.");
		fs.unlinkSync(target);
		let parent = path.dirname(target);
		while (parent !== standalone && fs.readdirSync(parent).length === 0) {
			fs.rmdirSync(parent);
			parent = path.dirname(parent);
		}
	}

	// Next's server trace omits this bootstrap import on Windows. Trace its
	// complete dependency closure with Next's own NFT, rather than copying a
	// single module and leaving its relative imports broken in the installer.
	const server = traces.find((trace) => trace.file === path.join(build, "next-server.js.nft.json"));
	const metadata = path.join(root, "node_modules", "next", "dist", "lib", "metadata", "get-metadata-route.js");
	let restored = 0;
	if (server && fs.existsSync(metadata)) {
		const { nodeFileTrace } = require("next/dist/compiled/@vercel/nft");
		const { fileList } = await nodeFileTrace([metadata], { base: root, processCwd: root, mixedModules: true });
		const files = new Set(server.value.files.map(portable));
		for (const file of fileList) {
			const source = path.resolve(root, portable(file));
			if (!contained(path.join(realRoot, "node_modules"), fs.realpathSync(source))) {
				throw new Error("REFUSING: Next bootstrap dependency escapes node_modules.");
			}
			const target = checkedTarget(path.relative(root, source));
			if (!stat(target)) {
				fs.mkdirSync(path.dirname(target), { recursive: true });
				fs.copyFileSync(source, target);
				restored++;
			}
			files.add(portable(path.relative(path.dirname(server.file), source)));
		}
		const nextFiles = [...files];
		if (JSON.stringify(nextFiles) !== JSON.stringify(server.value.files)) {
			server.value.files = nextFiles;
			server.changed = true;
		}
	}
	for (const trace of traces) {
		if (trace.changed) fs.writeFileSync(trace.file, JSON.stringify(trace.value));
	}
	return { excluded, restored };
}

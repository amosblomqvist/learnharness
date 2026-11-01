import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const generated = path.join(root, "android/.generated");
const cache = process.env.LH_ANDROID_CACHE ?? path.join(os.homedir(), ".cache/learnharness-android");
const runtime = JSON.parse(await fs.readFile(path.join(root, "android/runtime.json"), "utf8"));
const lock = JSON.parse(await fs.readFile(path.join(root, "package-lock.json"), "utf8"));
await fs.mkdir(cache, { recursive: true });

async function download(url, file, integrity) {
	const [algorithm, expected] = integrity.split(/-(.*)/s);
	const check = async () => {
		try { return crypto.createHash(algorithm).update(await fs.readFile(file)).digest(algorithm === "sha256" ? "hex" : "base64") === expected; } catch { return false; }
	};
	if (await check()) return;
	execFileSync("curl", ["-fLsS", "--retry", "3", "--connect-timeout", "20", "--max-time", "600", url, "-o", file], { stdio: "inherit" });
	if (!await check()) { await fs.rm(file); throw new Error(`Checksum failed: ${path.basename(file)}`); }
}

execFileSync(process.execPath, [path.join(root, "scripts/build-server.mjs")], { cwd: root, stdio: "inherit" });
await fs.rm(generated, { recursive: true, force: true });
await fs.mkdir(generated, { recursive: true });
const server = path.join(generated, "server");
await fs.cp(path.join(root, ".next/standalone"), server, { recursive: true, dereference: true });

// Fail before packaging if a dev secret or learning-data directory leaked.
for (const name of await fs.readdir(server)) {
	if (name === "data" || name === "auth.json" || name.startsWith(".env") || /credentials\.json/.test(name)) throw new Error(`Refusing private payload: ${name}`);
}
async function curate(directory) {
	for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
		const file = path.join(directory, entry.name);
		if (entry.isDirectory()) await curate(file);
		else if (entry.name.endsWith(".node")) await fs.rm(file); // Replace host binaries below.
	}
}
await curate(server);
// Exact build-only paths: never remove arbitrary dependency dist directories.
for (const name of ["android", ".superpowers", "node_modules/@img", "node_modules/@next/swc-linux-x64-gnu", "node_modules/@next/swc-linux-x64-musl"]) await fs.rm(path.join(server, name), { recursive: true, force: true });

for (const name of ["@napi-rs/canvas-android-arm64", "@resvg/resvg-js-android-arm64"]) {
	const pkg = lock.packages[`node_modules/${name}`];
	if (!pkg?.integrity || !pkg.resolved?.startsWith("https://registry.npmjs.org/")) throw new Error(`Missing locked Android dependency: ${name}`);
	const archive = path.join(cache, `${name.replaceAll("/", "-")}-${pkg.version}.tgz`);
	await download(pkg.resolved, archive, pkg.integrity);
	const target = path.join(server, "node_modules", name);
	await fs.mkdir(target, { recursive: true });
	execFileSync("tar", ["-xzf", archive, "--strip-components=1", "-C", target]);
}
await fs.copyFile(path.join(root, "android/runtime/bootstrap.cjs"), path.join(server, "bootstrap.cjs"));
await fs.copyFile(path.join(root, "LICENSE"), path.join(server, "LICENSE"));

const runtimeArchive = path.join(cache, "nodejs-mobile-24.22.1.zip");
await download(runtime.url, runtimeArchive, `sha256-${runtime.sha256}`);
const extracted = path.join(generated, "runtime");
execFileSync("unzip", ["-q", runtimeArchive, "-d", extracted]);
await fs.rename(path.join(extracted, "include"), path.join(generated, "include"));
for (const abi of ["arm64-v8a", "x86_64"]) {
	const target = path.join(generated, "jniLibs", abi);
	await fs.mkdir(target, { recursive: true });
	await fs.copyFile(path.join(extracted, "bin", abi, "libnode.so"), path.join(target, "libnode.so"));
}
await fs.rm(extracted, { recursive: true });

const assets = path.join(generated, "assets");
await fs.mkdir(assets, { recursive: true });
execFileSync("python3", ["-c", `import zipfile,pathlib,sys
root=pathlib.Path(sys.argv[1])
with zipfile.ZipFile(sys.argv[2],'w',zipfile.ZIP_DEFLATED,compresslevel=6) as archive:
 for file in sorted(root.rglob('*')):
  if file.is_file(): archive.write(file,file.relative_to(root))
`, server, path.join(assets, "server.zip")]);
const sha256 = crypto.createHash("sha256").update(await fs.readFile(path.join(assets, "server.zip"))).digest("hex");
await fs.writeFile(path.join(assets, "bundle.json"), JSON.stringify({ sha256, runtime: runtime.version }));
await fs.copyFile(path.join(root, "android/THIRD_PARTY_NOTICES.md"), path.join(assets, "THIRD_PARTY_NOTICES.md"));
for (const name of ["NODE_LICENSE", "RESVG_LICENSE"]) await fs.copyFile(path.join(root, "android", name), path.join(assets, name));
console.log(`Android payload ready; SHA-256 ${sha256}`);

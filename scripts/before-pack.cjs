// Native macOS packaging only: a cross-architecture Electron shell cannot
// repair the native modules already traced into the standalone server.
// Also callable before a local build: node scripts/before-pack.cjs x64
const { execFileSync } = require("node:child_process");

function assertNativeMac(targetArch) {
	if (process.platform !== "darwin" || !["x64", "arm64"].includes(targetArch)) {
		throw new Error(`Native macOS packaging requires a macOS host and an x64 or arm64 target (got ${process.platform}/${targetArch}).`);
	}
	// Unlike process.arch, this identifies Apple Silicon even under Rosetta.
	// Intel macOS may omit this optional key; -i permits that absence.
	const hostArch = execFileSync("/usr/sbin/sysctl", ["-in", "hw.optional.arm64"], { encoding: "utf8" }).trim() === "1" ? "arm64" : "x64";
	if (process.arch !== targetArch || hostArch !== targetArch) {
		throw new Error(`Refusing cross-architecture macOS packaging: target=${targetArch}, Node=${process.arch}, host=${hostArch}. Install dependencies and rebuild the standalone server natively on the target architecture.`);
	}
}

module.exports = function beforePack(context) {
	if (context.electronPlatformName !== "darwin") return;
	assertNativeMac(require("builder-util").Arch[context.arch]);
};

if (require.main === module) {
	assertNativeMac(process.argv[2]);
}

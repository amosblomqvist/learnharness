import { ANTIGRAVITY_MANAGED_VERSION } from "./constants.ts";

export interface AntigravityReleaseAsset {
	name: string;
	bytes: number;
}

export interface AntigravityReleaseManifestEntry {
	platformArch: string;
	version: string;
	releaseId: string;
	url: string;
	sha256: string;
	archiveBytes: number;
	executable: AntigravityReleaseAsset;
	harness: AntigravityReleaseAsset;
}

const RAW_MANIFEST = {
	"linux-x64": {
		url: "https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-1.4.5-linux-x86_64.zip",
		sha256: "923923a0d7dc8073f66cc6f78647a3107e3a7ee2b7e1a24df8b3927b5188013b",
		archiveBytes: 321783181,
		executable: { name: "agy_acp_server.par", bytes: 826226766 },
		harness: { name: "localharness_external", bytes: 133926136 },
	},
	"linux-arm64": {
		url: "https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-1.4.5-linux-arm64.zip",
		sha256: "7d64246633ae094f67e3bbcd2d679e89048f91346d5339313336e7483f40f056",
		archiveBytes: 307829008,
		executable: { name: "agy_acp_server.par", bytes: 831194025 },
		harness: { name: "localharness_external", bytes: 127512832 },
	},
	"darwin-arm64": {
		url: "https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-1.4.5-darwin-arm64.zip",
		sha256: "886fff7767d08994ca39eb02c3d01a7532c7325a94aa33aaf52d52068733284f",
		archiveBytes: 97923855,
		executable: { name: "agy_acp_server.par", bytes: 178915920 },
		harness: { name: "localharness_external", bytes: 122957936 },
	},
	"darwin-x64": {
		url: "https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-1.4.5-darwin-x86_64.zip",
		sha256: "b39f3573c03b9acb9df028853f647527f1f3133f32bd77e78b796e48a205114a",
		archiveBytes: 103577295,
		executable: { name: "agy_acp_server.par", bytes: 183127600 },
		harness: { name: "localharness_external", bytes: 127612208 },
	},
	"win32-x64": {
		url: "https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-1.4.5-windows-x86_64.zip",
		sha256: "d24f4c73c9f96d4f44384e281c855a56c72d8eaa9c5b0fad7ccb1635c6b63f50",
		archiveBytes: 100423655,
		executable: { name: "agy_acp_server.exe", bytes: 55839864 },
		harness: { name: "localharness_external.exe", bytes: 147843736 },
	},
	"win32-arm64": {
		url: "https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-1.4.5-windows-arm64.zip",
		sha256: "ab0a9aac8349e08ef289be6d16da8f89e3abe60eba5158032ef78c4a1220261c",
		archiveBytes: 102703121,
		executable: { name: "agy_acp_server.exe", bytes: 62293488 },
		harness: { name: "localharness_external.exe", bytes: 139322008 },
	},
} as const;

export type AntigravityPlatformKey = keyof typeof RAW_MANIFEST;

export function getAntigravityRelease(
	platform: NodeJS.Platform = process.platform,
	arch: string = process.arch,
): AntigravityReleaseManifestEntry | null {
	const key = `${platform}-${arch}` as AntigravityPlatformKey;
	const entry = RAW_MANIFEST[key];
	if (!entry) return null;
	return {
		platformArch: key,
		version: ANTIGRAVITY_MANAGED_VERSION,
		releaseId: entry.sha256,
		url: entry.url,
		sha256: entry.sha256,
		archiveBytes: entry.archiveBytes,
		executable: { ...entry.executable },
		harness: { ...entry.harness },
	};
}

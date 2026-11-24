import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { writeFileAtomicSync } from "./atomic-write.ts";

export function accountKey(deployment: string, userId: string): string {
	return createHash("sha256").update(`${deployment}\n${userId}`).digest("hex");
}
export function threadProfileRoot(dataRoot: string): string {
	try {
		const profile = path.join(/* turbopackIgnore: true */ dataRoot, "cloud-profile.json");
		const key: unknown = JSON.parse(fs.readFileSync(/* turbopackIgnore: true */ profile, "utf8"));
		if (key === null) return dataRoot;
		if (typeof key !== "string" || !/^[a-f0-9]{64}$/.test(key)) throw new Error("Invalid account cache.");
		return path.join(/* turbopackIgnore: true */ dataRoot, "cloud-accounts", key);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return dataRoot;
		throw error; // Never expose another profile on malformed metadata.
	}
}
export function selectThreadProfile(dataRoot: string, key: string | null): void {
	if (key !== null && !/^[a-f0-9]{64}$/.test(key)) throw new Error("Invalid account cache.");
	fs.mkdirSync(dataRoot, { recursive: true });
	writeFileAtomicSync(path.join(/* turbopackIgnore: true */ dataRoot, "cloud-profile.json"), JSON.stringify(key), { mode: 0o600 });
}

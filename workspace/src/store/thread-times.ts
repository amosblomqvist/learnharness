import fs from "node:fs";
import path from "node:path";
import { writeFileAtomicSync } from "./atomic-write.ts";

function filename(root: string, id: string): string {
	if (!/^[A-Za-z0-9_-]{1,200}$/.test(id)) throw new Error("Invalid thread id.");
	return path.join(/* turbopackIgnore: true */ root, "sync-times", `${id}.json`);
}
export function threadModifiedAt(root: string, id: string): number {
	try {
		const value: unknown = JSON.parse(fs.readFileSync(/* turbopackIgnore: true */ filename(root, id), "utf8"));
		if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error("Invalid thread sync timestamp.");
		return value;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		try { return fs.statSync(/* turbopackIgnore: true */ path.join(/* turbopackIgnore: true */ root, "chats", `${id}.json`)).mtimeMs; }
		catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0; throw error; }
	}
}
export function markThreadModified(root: string, id: string, importedAt?: number): void {
	const timestamp = importedAt ?? Math.max(Date.now(), threadModifiedAt(root, id) + 1);
	const directory = path.join(/* turbopackIgnore: true */ root, "sync-times");
	fs.mkdirSync(/* turbopackIgnore: true */ directory, { recursive: true });
	writeFileAtomicSync(filename(root, id), JSON.stringify(timestamp), { mode: 0o600 });
}

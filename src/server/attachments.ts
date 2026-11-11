/** Uploaded chat attachments (web build, 2026-11-11): a browser `File` has no
 *  local path, so the composer's attach button copies the bytes into the app's
 *  data dir and hands the agent that absolute path — the same chip flow the
 *  desktop bridge produces, without pretending a browser file has a path.
 *
 *  Everything here is app-owned: the folder is added to the file-access policy
 *  automatically (src/server/file-access.ts), never inferred from client input. */
import fs from "node:fs";
import path from "node:path";
import { PATHS } from "../../config.ts";

/** `<data>/attachments` — under data/, not under a learner folder. */
export const ATTACHMENTS_DIR = path.join(PATHS.data, "attachments");

/** Keep the browser's relative path (folder uploads) but never let it escape:
 *  strip traversal, control characters and Windows-hostile characters. Empty
 *  segments collapse; the result always has at least one segment. */
export function safeRelativePath(input: string | undefined, fallback = "file"): string {
	const raw = (input ?? "").replace(/\\/g, "/").split("/");
	const cleaned = raw
		.filter((segment) => segment && segment !== "." && segment !== "..")
		.map((segment) => segment.replace(/[\u0000-\u001f<>:"|?*]/g, "_").trim())
		.filter(Boolean);
	return cleaned.join("/") || fallback;
}

/** Write one upload under `dir`; returns the absolute path the agent may read.
 *  Refuses any resolved target that left `dir` (defense in depth on top of
 *  `safeRelativePath`). */
export function writeUpload(dir: string, relative: string, bytes: Uint8Array): string {
	const base = path.resolve(dir);
	const target = path.resolve(base, relative);
	if (target !== base && !target.startsWith(base + path.sep)) throw new Error("unsafe upload path");
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.writeFileSync(target, bytes);
	return target;
}

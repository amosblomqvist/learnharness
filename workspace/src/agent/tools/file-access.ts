import * as fs from "node:fs";
import * as path from "node:path";

/** Learner-source policy seam, based on lickbot's #157. The server supplies
 * current preferences per operation; agents never import the settings store.
 * Mandatory sensitive/credential denials remain in fs-shared, independently
 * of this OPTIONAL boundary. Empty is closed only when restricted is true. */
export interface FileAccessPolicy {
	restricted: boolean;
	folders: readonly string[];
	error?: string;
}
export interface ResolvedFileAccessPolicy {
	restricted: boolean;
	folders: readonly string[];
	unavailable: readonly string[];
}

const OPEN_POLICY: FileAccessPolicy = { restricted: false, folders: [] };
let currentPolicy: () => FileAccessPolicy = () => OPEN_POLICY;

export function setFileAccessPolicy(provider: () => FileAccessPolicy): void { currentPolicy = provider; }

export function fileAccessPolicy(): FileAccessPolicy {
	let policy: FileAccessPolicy;
	try { policy = currentPolicy(); }
	catch { throw new Error("File-access configuration error: preferences cannot be read. Repair File access in Settings → Agent → Tools."); }
	if (policy?.error) throw new Error(policy.error);
	if (!policy || typeof policy.restricted !== "boolean" || !Array.isArray(policy.folders) || policy.folders.some((folder) => typeof folder !== "string" || !path.isAbsolute(folder) || folder.includes("\0"))) {
		throw new Error("File-access configuration error: invalid policy. Repair File access in Settings → Agent → Tools.");
	}
	return policy;
}

/** Comparison only: preserve the accepted #421 Windows namespace/ADS
 * semantics. The returned spelling is never used for opening a file. */
export function comparisonPath(absolute: string): string {
	let normalized = path.resolve(absolute);
	if (process.platform === "win32") {
		if (normalized.startsWith("\\\\?\\UNC\\")) normalized = `\\\\${normalized.slice(8)}`;
		else if (normalized.startsWith("\\\\?\\")) normalized = normalized.slice(4);
		const base = path.basename(normalized);
		const stream = base.indexOf(":");
		if (stream !== -1) normalized = path.join(path.dirname(normalized), base.slice(0, stream));
	}
	return normalized;
}

/** Segment-aware containment; ignoreCase is ONLY for the existing home
 * denylist. Do not globally casefold configured allowed folders. */
export function isWithin(absolute: string, root: string, ignoreCase = false): boolean {
	let child = comparisonPath(absolute);
	let parent = comparisonPath(root);
	if (ignoreCase) { child = child.toLowerCase(); parent = parent.toLowerCase(); }
	const rel = path.relative(parent, child);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/** The accepted strict canonical resolver, including missing descendants.
 * Loops/permissions must not turn a source into an unchecked lexical path. */
export function realSourcePath(absolute: string): string {
	try { return fs.realpathSync.native(/* turbopackIgnore: true */ absolute); }
	catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
		const parent = path.dirname(absolute);
		return parent === absolute ? absolute : path.join(/* turbopackIgnore: true */ realSourcePath(parent), path.basename(absolute));
	}
}

/** One snapshot per tool call, shared by every root in a multi-root search.
 * Unmounted/unreadable roots never become a default-home fallback. */
export function resolvePolicy(policy: FileAccessPolicy = fileAccessPolicy()): ResolvedFileAccessPolicy {
	if (policy.error) throw new Error(policy.error);
	if (!policy.restricted) return { restricted: false, folders: [], unavailable: [] };
	const folders: string[] = [];
	const unavailable: string[] = [];
	for (const folder of policy.folders) {
		try {
			const real = fs.realpathSync.native(/* turbopackIgnore: true */ folder);
			if (!fs.statSync(/* turbopackIgnore: true */ real).isDirectory()) throw new Error("not a directory");
			fs.accessSync(/* turbopackIgnore: true */ real, fs.constants.R_OK | fs.constants.X_OK);
			if (folders.some((root) => isWithin(real, root))) continue;
			for (let i = folders.length - 1; i >= 0; i--) if (isWithin(folders[i]!, real)) folders.splice(i, 1);
			folders.push(real);
		} catch { unavailable.push(`Unavailable allowed folder: ${folder}`); }
	}
	return { restricted: true, folders, unavailable };
}

/** Accept only canonical source locations contained by the snapshot. Source
 * symlinks resolve before containment; a link cannot escape the chosen roots.
 * fs-shared runs its mandatory named AND canonical denials before this gate. */
export function guardSourcePath(absolute: string, policy: ResolvedFileAccessPolicy = resolvePolicy()): string {
	const real = realSourcePath(absolute);
	if (policy.restricted && !policy.folders.some((folder) => isWithin(real, folder))) {
		throw new Error(
			`Access denied: ${absolute} is outside the allowed folders, or no allowed folders are available. ` +
			"Use ls without a path to list allowed folders, or ask the learner to adjust File access in Settings → Agent → Tools.",
		);
	}
	return real;
}

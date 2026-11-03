import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AUTH_FILE } from "../../../config.ts";

/**
 * Shared plumbing for the learner-filesystem tools (ls / find / grep) —
 * sources v1 (2026-09-19): the agent locates and reads the learner's files
 * itself, so paths need no UI affordance (user decision: no attachments —
 * the learner references files in messages; the agent finds them).
 *
 * Safety posture (user-locked): READ-ONLY by construction — no shell-out,
 * no user-controlled process args, no mutation APIs anywhere here. The one
 * deliberate scope widening vs pi: relative paths and default roots resolve
 * against the LEARNER'S HOME, not a project cwd — the harness has no
 * meaningful working directory, and "find my notes" should just work.
 * The carve-out: sensitive home locations, dotenv files, and the app's
 * configured credential stores are refused by the resolver and skipped by
 * walks — whatever a tool reads is sent to the model provider. This is
 * path-based defense in depth, not a sandbox or content-redaction system.
 *
 * Ported behaviors (mirroring pi's dist/core/tools/{ls,find,grep}.js): the
 * schemas, descriptions, output formats, and truncation notices are copied
 * verbatim except where semantics differ (home default, no .gitignore —
 * replaced by hard noise exclusions).
 */

/** 50KB — pi's DEFAULT_MAX_BYTES, the output ceiling for every fs tool. */
export const MAX_OUTPUT_BYTES = 50 * 1024;
/** pi's grep line-truncation length (GREP_MAX_LINE_LENGTH). */
export const GREP_MAX_LINE_LENGTH = 500;
/** Wall-clock budget for tree walks (find/grep over a whole home dir). */
export const WALK_TIMEOUT_MS = 10_000;

/**
 * Directory names never entered during walks. node_modules/.git mirror pi's
 * fd/rg defaults; Library/.Trash are the home-root noise the user approved
 * (2026-09-19) — caches, app support, and the trash live under them.
 * Explicit paths (ls/read of ~/Library/…) are NOT filtered — only walks.
 */
const EXCLUDED_DIR_NAMES = new Set(["node_modules", ".git", "Library", ".Trash"]);

/**
 * Home-relative locations the tools never read or walk into: credential
 * stores, keys, other agents' session transcripts and settings, browser
 * profiles. Unlike EXCLUDED_DIR_NAMES these are refused for explicit paths
 * too (resolveSourcePath), not only skipped by walks. Matched
 * case-insensitively, including on case-sensitive filesystems.
 */
const SENSITIVE_HOME_PATHS = [
	".claude",
	".codex",
	".cursor",
	".gemini",
	".ssh",
	".gnupg",
	".aws",
	".azure",
	".config/gcloud",
	".kube",
	".docker",
	".netrc",
	".npmrc",
	".pypirc",
	".git-credentials",
	"Library/Keychains",
	"Library/Cookies",
	"Library/Safari",
	"Library/Application Support/Google/Chrome",
	"Library/Application Support/BraveSoftware",
	"Library/Application Support/Microsoft Edge",
	"Library/Application Support/Firefox",
	".mozilla",
	".config/google-chrome",
	".config/chromium",
	".config/BraveSoftware",
	".config/microsoft-edge",
	"AppData/Local/Google/Chrome",
	"AppData/Local/BraveSoftware",
	"AppData/Local/Microsoft/Edge",
	"AppData/Roaming/Mozilla",
];

/** Templates are deliberately included: their names do not guarantee safe contents. */
const ENV_FILE = /^\.env(\..*)?$/i;
const SUBSCRIPTION_FILES = ["chatgpt-credentials.json", "github-copilot-credentials.json", "xai-credentials.json"];
// Match the actual writers in store/auth.ts and electron/{chatgpt,subscription-store}.cjs.
const CREDENTIAL_TEMP = /^(?:\.auth\.json\.tmp-\d+|(?:chatgpt|github-copilot|xai)-credentials\.json\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp)$/i;
const ATOMIC_TEMP_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Windows namespace aliases and alternate data streams must not change policy.
 *  The returned spelling is for comparison only, never for opening a file. */
function comparisonPath(absolute: string): string {
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

/** Segment-aware containment; home denials retain the donor's case-insensitive policy. */
function isWithin(absolute: string, root: string, ignoreCase = false): boolean {
	let child = comparisonPath(absolute);
	let parent = comparisonPath(root);
	if (ignoreCase) { child = child.toLowerCase(); parent = parent.toLowerCase(); }
	const rel = path.relative(parent, child);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

function credentialFiles(authFile: string): string[] {
	return [authFile, ...SUBSCRIPTION_FILES.map((name) => path.join(/* turbopackIgnore: true */ path.dirname(authFile), name))];
}

function isCredentialTemp(absolute: string, directory: string, authBasename: string): boolean {
	const file = comparisonPath(absolute);
	if (path.relative(comparisonPath(directory), path.dirname(file)) !== "") return false;
	const name = path.basename(file);
	const prefix = `${authBasename}.tmp-`;
	return CREDENTIAL_TEMP.test(name) ||
		(name.toLowerCase().startsWith(prefix.toLowerCase()) && ATOMIC_TEMP_UUID.test(name.slice(prefix.length)));
}

/** String-only check, also usable with synthetic home/credential locations.
 *  The runtime guard below additionally resolves both sources and protected roots.
 *  Only credentials are app-private denials: learning data remains readable. */
export function isSensitivePath(absolute: string, home: string = os.homedir(), authFile: string = AUTH_FILE): boolean {
	const file = comparisonPath(absolute);
	return ENV_FILE.test(path.basename(file)) ||
		SENSITIVE_HOME_PATHS.some((p) => isWithin(file, path.join(home, p), true)) ||
		credentialFiles(authFile).some((p) => isWithin(file, p)) ||
		isCredentialTemp(file, path.dirname(authFile), path.basename(comparisonPath(authFile)));
}

/** Resolve existing ancestors too, so absent descendants of symlinked roots
 *  receive the same policy. Missing paths keep their normal tool IO errors;
 *  permission failures/loops must not silently turn into an unchecked path. */
function realOrMissing(absolute: string): string {
	try {
		// Runtime learner/credential paths are not assets to trace into a build.
		return fsSync.realpathSync.native(/* turbopackIgnore: true */ absolute);
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code !== "ENOENT" && code !== "ENOTDIR") throw err;
		const parent = path.dirname(absolute);
		return parent === absolute ? absolute : path.join(/* turbopackIgnore: true */ realOrMissing(parent), path.basename(absolute));
	}
}

/** An unrelated inaccessible/broken protected root must not break ordinary
 *  notes. Its named location remains denied; a source's OWN realpath errors
 *  still fail closed in checkedSourcePath, never opening its unchecked alias. */
function protectedRealPath(absolute: string): string {
	try { return realOrMissing(absolute); } catch { return absolute; }
}

/** Expand actual spellings of each protected home location, segment by
 *  segment. On a case-sensitive filesystem .ssh and .SSH can BOTH exist
 *  and lead to different targets; named and canonical denials must agree.
 *  Only list the fixed locations' parent directories, never file contents.
 *  The directory-reader argument lets tests model case-sensitive listings
 *  on any host, without mounting a volume or touching real private paths. */
export function sensitiveHomeLocations(
	home: string,
	readDirectory: (directory: string) => readonly string[] = (directory) => fsSync.readdirSync(/* turbopackIgnore: true */ directory),
): string[] {
	const listings = new Map<string, readonly string[]>();
	const entries = (directory: string): readonly string[] => {
		if (!listings.has(directory)) {
			try { listings.set(directory, readDirectory(directory)); }
			catch { listings.set(directory, []); }
		}
		return listings.get(directory)!;
	};
	return SENSITIVE_HOME_PATHS.flatMap((location) => {
		let candidates = [home];
		for (const segment of location.split("/")) {
			candidates = candidates.flatMap((parent) => {
				const variants = entries(parent).filter((entry) => entry.toLowerCase() === segment.toLowerCase());
				return (variants.length ? variants : [segment]).map((name) => path.join(/* turbopackIgnore: true */ parent, name));
			});
		}
		return candidates;
	});
}

/** One snapshot per resolution/walk, not per visited entry. Resolve protected
 *  roots too: a sensitive directory or AUTH_FILE can itself be a symlink to
 *  a location outside home. Never read credential contents or app records. */
function sourcePathCheck(home = os.homedir()): (absolute: string) => boolean {
	const homeRoots = sensitiveHomeLocations(home).map(protectedRealPath);
	const files = credentialFiles(AUTH_FILE).map(protectedRealPath);
	const credentialDir = protectedRealPath(path.dirname(AUTH_FILE));
	return (absolute) => isSensitivePath(absolute, home) ||
		homeRoots.some((p) => isWithin(absolute, p, true)) ||
		files.some((p) => isWithin(absolute, p)) || isCredentialTemp(absolute, credentialDir, path.basename(comparisonPath(AUTH_FILE)));
}

function checkedSourcePath(absolute: string, denied: (absolute: string) => boolean): string {
	const refuse = () => {
		throw new Error(
			`Access denied: ${absolute} is a protected location. Learner file tools cannot open it. ` +
			"Do not paste credentials or private transcripts into chat. Use another source or a manually reviewed, non-sensitive excerpt.",
		);
	};
	if (denied(absolute)) refuse();
	const real = realOrMissing(absolute);
	if (denied(real)) refuse();
	return real;
}

/** Relative/absent → home; leading ~ expands, ~user stays literal. Return
 *  the CHECKED canonical location for IO, not an unchecked symlink alias.
 *  These path checks are not protection against a hostile concurrent OS user. */
export function resolveSourcePath(p?: string): string {
	const home = os.homedir();
	const resolved = !p ? home : p === "~" || p.startsWith("~/") || p.startsWith(`~${path.sep}`)
		? path.join(home, p.slice(1))
		: path.resolve(home, p);
	return checkedSourcePath(resolved, sourcePathCheck(home));
}

/** pi's formatSize idiom (50KB prints as "50.0KB"). */
export function formatSize(bytes: number): string {
	return bytes >= 1024 ? `${(bytes / 1024).toFixed(1)}KB` : `${bytes}B`;
}

/** Cap output to MAX_OUTPUT_BYTES on whole lines, pi's truncateHead idiom. */
export function capOutput(lines: string[]): { content: string; truncated: boolean } {
	const out: string[] = [];
	for (const line of lines) {
		const candidate = [...out, line].join("\n");
		if (Buffer.byteLength(candidate, "utf-8") > MAX_OUTPUT_BYTES) {
			return { content: out.join("\n"), truncated: true };
		}
		out.push(line);
	}
	return { content: out.join("\n"), truncated: false };
}

/** Expand top-level brace alternatives: '*.{ts,tsx}' → ['*.ts', '*.tsx'].
 *  Nested braces are out of scope (pi's fd handles them; models rarely
 *  emit them — a non-expanding literal match is the graceful fallback). */
export function expandBraces(pattern: string): string[] {
	const open = pattern.indexOf("{");
	if (open === -1) return [pattern];
	const close = pattern.indexOf("}", open);
	if (close === -1) return [pattern];
	const before = pattern.slice(0, open);
	const after = pattern.slice(close + 1);
	const alts: string[] = [];
	for (const alt of pattern.slice(open + 1, close).split(",")) {
		alts.push(...expandBraces(before + alt + after));
	}
	return alts;
}

/** Glob → anchored RegExp. '*' stays within a segment, '**' crosses '/',
 *  '?' is one char, everything else literal. */
export function globToRegex(glob: string): RegExp {
	let re = "";
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i]!;
		if (c === "*") {
			if (glob[i + 1] === "*") {
				re += "[\\s\\S]*";
				i++;
				if (glob[i + 1] === "/") i++; // '**/' also eats the slash
			} else {
				re += "[^/]*";
			}
		} else if (c === "?") {
			re += "[^/]";
		} else {
			re += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		}
	}
	return new RegExp(`^${re}$`);
}

/**
 * pi/fd's matching rule: a pattern with no slash matches against the
 * BASENAME at any depth; one with a slash matches the relative path, with
 * an implied leading "**-slash" prefix unless it is itself anchored (see
 * the code below — the literal sequence cannot appear in this comment
 * because it terminates block comments).
 */
export function matchGlob(relativePath: string, pattern: string): boolean {
	const posix = relativePath.split(path.sep).join("/");
	const basename = posix.split("/").pop() ?? posix;
	for (const alt of expandBraces(pattern)) {
		if (!alt.includes("/")) {
			if (globToRegex(alt).test(basename)) return true;
		} else {
			let effective = alt;
			if (!effective.startsWith("/") && !effective.startsWith("**/") && effective !== "**") {
				effective = `**/${effective}`;
			}
			if (effective.startsWith("/")) effective = effective.slice(1);
			if (globToRegex(effective).test(posix)) return true;
		}
	}
	return false;
}

/**
 * Depth-first walk under `root`, never entering EXCLUDED_DIR_NAMES or
 * sensitive locations (isSensitivePath).
 * `visit` receives absolute file paths; returning true STOPS the walk
 * (find's result limit). The deadline bounds a home-dir walk to
 * WALK_TIMEOUT_MS — partial results are the graceful degradation.
 */
export async function walkFiles(
	root: string,
	visit: (filePath: string) => boolean | Promise<boolean>,
	signal?: AbortSignal,
): Promise<{ timedOut: boolean; aborted: boolean }> {
	const deadline = Date.now() + WALK_TIMEOUT_MS;
	let timedOut = false;
	let aborted = false;
	if (signal?.aborted) return { timedOut: false, aborted: true };
	const denied = sourcePathCheck();
	// A caller may supply an alias of home as its root. Start from the real
	// root and compare descendants against the same canonical protected roots.
	const realRoot = checkedSourcePath(path.resolve(root), denied);

	const walkDir = async (dir: string): Promise<boolean> => {
		if (Date.now() > deadline) {
			timedOut = true;
			return true; // stop
		}
		if (signal?.aborted) {
			aborted = true;
			return true; // stop — abort yields partial results, not a throw
		}
		let entries: import("node:fs").Dirent[];
		try {
			entries = await fs.readdir(dir, { withFileTypes: true });
		} catch {
			return false; // unreadable dir (permissions): skip, keep walking
		}
		for (const entry of entries) {
			if (Date.now() > deadline) {
				timedOut = true;
				return true;
			}
			if (signal?.aborted) {
				aborted = true;
				return true;
			}
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				if (EXCLUDED_DIR_NAMES.has(entry.name) || denied(full)) continue;
				if (await walkDir(full)) return true;
			} else if (entry.isFile()) {
				if (denied(full)) continue;
				if (await visit(full)) return true;
			}
			// symlinks/other: not followed (pi's fd doesn't follow either)
		}
		return false;
	};

	await walkDir(realRoot);
	return { timedOut, aborted };
}

/** True if the first 8KB chunk contains a NUL byte — pi/rg's binary skip. */
export async function isBinaryFile(filePath: string): Promise<boolean> {
	const handle = await fs.open(filePath, "r");
	try {
		const buf = Buffer.alloc(8192);
		const { bytesRead } = await handle.read(buf, 0, 8192, 0);
		return buf.subarray(0, bytesRead).includes(0);
	} finally {
		await handle.close();
	}
}

/** pi's GREP_MAX_LINE_LENGTH line truncation (no mid-word care, hard cap). */
export function truncateGrepLine(line: string): { text: string; wasTruncated: boolean } {
	if (line.length <= GREP_MAX_LINE_LENGTH) return { text: line, wasTruncated: false };
	return { text: `${line.slice(0, GREP_MAX_LINE_LENGTH)}… [truncated]`, wasTruncated: true };
}

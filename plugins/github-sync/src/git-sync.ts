import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import path from "node:path";

/** Entries GitHub Sync keeps in the learning-data .gitignore. */
export const GITIGNORE_ENTRIES = [".tmp-*", "*.tmp-*", ".DS_Store", "plugins/*/node_modules/", "plugins/*/.sdk/"] as const;

/** Append-only graph ledgers: when two machines both appended, keep both
 *  sides' lines instead of reporting a conflict. Node ids are random, link
 *  lines always follow the line that created their node, and chain
 *  assertions merge by (premises, conclusion), so line order across
 *  machines does not change what the graph means. */
export const GITATTRIBUTES_ENTRIES = ["graph/*.jsonl merge=union"] as const;

/** Data format versions (the host's ctx.host.dataFormats). */
export interface DataFormats { chat: number; graph: number; settings: number }
const FORMAT_KEYS = ["chat", "graph", "settings"] as const;

export interface RepoStatus {
	repository: boolean;
	directory: string;
	branch?: string;
	remote?: string;
	/** Commits not on origin, as of the last fetch. */
	ahead?: number;
	/** Origin commits not yet pulled, as of the last fetch. */
	behind?: number;
	/** Uncommitted changed paths. */
	changes?: number;
	lastCommit?: string;
}

export type SyncResult =
	| { status: "done"; message: string; changed: boolean }
	/** Push refused because origin has commits this machine has not pulled. */
	| { status: "behind"; message: string; changed: false }
	/** The rebase was aborted; `remote` is the origin commit that conflicted. */
	| { status: "conflict"; message: string; changed: false; branch: string; remote: string }
	/** GitHub's data needs a newer LearnHarness; nothing was pulled. */
	| { status: "newer-data"; message: string; changed: false };

export type ConflictChoice = "keep-local" | "take-remote";

export type InitResult =
	| { status: "done"; message: string; changed: boolean }
	/** Nothing was changed locally; ask the learner how to combine. */
	| { status: "remote-has-data"; message: string; branch: string; changed: false }
	| Extract<SyncResult, { status: "conflict" | "newer-data" }>;

export type InitChoice = "use-remote" | "merge";

export class GitError extends Error {
	constructor(message: string, readonly stderr = "") { super(message); }
}

export interface GitSyncOptions {
	/** The learning-data directory; it must be the root of its own repository. */
	directory: string;
	host?: string;
	now?: () => Date;
	/** Executable to run; tests may point at a specific git. */
	git?: string;
	/** This app's data format versions. Pulls refuse data stamped newer
	 *  (data-format.json). Absent: no check (older app without the stamp). */
	dataFormats?: DataFormats;
	/** Extra .gitignore entries (e.g. this plugin's per-machine state file). */
	ignore?: readonly string[];
}

/** Per-operation options. */
export interface RunOptions {
	/** Kills the running git command; cleanup (rebase --abort) still runs. */
	signal?: AbortSignal;
}

const pad = (n: number) => String(n).padStart(2, "0");
function stamp(date: Date, separator: string): string {
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}${separator}${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
function refStamp(date: Date): string {
	return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}
function refSafe(text: string): string {
	return text.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "host";
}

export function validateRemoteUrl(value: unknown): string {
	if (typeof value !== "string") throw new GitError("Remote URL must be text.");
	const url = value.trim();
	if (!url) throw new GitError("Enter the GitHub repository URL, for example git@github.com:you/learning-data.git.");
	if (url.startsWith("-") || /\s/.test(url) || url.length > 2048) throw new GitError("That remote URL is not valid.");
	return url;
}

export function createGitSync(options: GitSyncOptions) {
	const directory = path.resolve(options.directory);
	const host = options.host ?? os.hostname().split(".")[0] ?? "host";
	const now = options.now ?? (() => new Date());
	const gitBin = options.git ?? "git";
	const ignoreEntries = [...GITIGNORE_ENTRIES, ...(options.ignore ?? [])];
	let running = false;
	/** The running operation's signal; cleanup commands pass `cleanup`. */
	let signal: AbortSignal | undefined;

	function git(args: string[], cwd = directory, mode: "normal" | "cleanup" = "normal"): Promise<{ stdout: string; stderr: string }> {
		return new Promise((resolve, reject) => {
			if (mode === "normal" && signal?.aborted) { reject(new GitError("GitHub Sync was cancelled.")); return; }
			execFile(gitBin, args, {
				cwd, maxBuffer: 64 * 1024 * 1024,
				...(mode === "normal" && signal ? { signal } : {}),
				// Never wait on an interactive credential prompt inside the app server.
				env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
			}, (error, stdout, stderr) => {
				if (error && mode === "normal" && signal?.aborted) { reject(new GitError("GitHub Sync was cancelled.", stderr)); return; }
				if (error) {
					const detail = (stderr || stdout || error.message).trim();
					reject(new GitError(`git ${args[0]} failed: ${detail}`, stderr));
				} else resolve({ stdout, stderr });
			});
		});
	}
	const ok = (args: string[]) => git(args).then(() => true, () => false);
	const out = async (args: string[]) => (await git(args)).stdout.trim();

	/** One operation at a time; a second click fails instead of racing. */
	async function exclusive<T>(work: () => Promise<T>, run?: RunOptions): Promise<T> {
		if (running) throw new GitError("Another GitHub Sync operation is still running.");
		running = true;
		signal = run?.signal;
		try { return await work(); } finally { running = false; signal = undefined; }
	}

	async function isOwnRepository(): Promise<boolean> {
		if (!fs.existsSync(path.join(directory, ".git"))) return false;
		try {
			const top = await out(["rev-parse", "--show-toplevel"]);
			return fs.realpathSync(top) === fs.realpathSync(directory);
		} catch (error) {
			if (signal?.aborted) throw error; // cancelled, not "not a repository"
			return false;
		}
	}
	async function rebaseInProgress(): Promise<boolean> {
		const gitDir = path.resolve(directory, await out(["rev-parse", "--git-dir"]));
		return fs.existsSync(path.join(gitDir, "rebase-merge")) || fs.existsSync(path.join(gitDir, "rebase-apply"));
	}

	/** Repository, branch and origin checks shared by every sync operation. */
	async function prepare(): Promise<string> {
		if (!(await isOwnRepository())) throw new GitError(`The learning-data folder is not set up for GitHub Sync yet. Open this plugin's settings and initialize it. (${directory})`);
		if (await rebaseInProgress()) throw new GitError(`A git rebase is already in progress in ${directory}. Finish or abort it there first.`);
		let branch: string;
		try { branch = await out(["symbolic-ref", "--short", "HEAD"]); }
		catch { throw new GitError("The learning-data repository is not on a branch (detached HEAD)."); }
		if (!(await ok(["remote", "get-url", "origin"]))) throw new GitError("The learning-data repository has no 'origin' remote.");
		return branch;
	}

	async function head(): Promise<string | undefined> {
		try { return await out(["rev-parse", "--verify", "-q", "HEAD"]); } catch { return undefined; }
	}
	async function remoteHead(branch: string): Promise<string | undefined> {
		try { return await out(["rev-parse", "--verify", "-q", `refs/remotes/origin/${branch}`]); } catch { return undefined; }
	}

	/** Stage everything and commit if anything changed. Returns whether it committed. */
	async function commitLocal(message = `sync: ${host} ${stamp(now(), " ")}`): Promise<boolean> {
		await git(["add", "-A"]);
		if (await ok(["diff", "--cached", "--quiet"])) return false;
		await git(["commit", "-q", "-m", message]);
		return true;
	}

	/** Rebase onto origin/<branch>. Aborts and reports a conflict instead of leaving a half-done rebase. */
	async function rebaseOnto(branch: string): Promise<{ changed: boolean } | Extract<SyncResult, { status: "conflict" }>> {
		const remote = await remoteHead(branch);
		if (!remote) return { changed: false };
		const before = await head();
		if (!before) {
			await git(["reset", "-q", "--hard", remote]);
			return { changed: true };
		}
		try {
			await git(["rebase", "-q", remote]);
		} catch (error) {
			const conflict = await rebaseInProgress().catch(() => false);
			await git(["rebase", "--abort"], directory, "cleanup").catch(() => undefined);
			if (!conflict) throw error;
			return {
				status: "conflict", changed: false, branch, remote,
				message: "Your local learning data and GitHub both changed the same files. Nothing was pushed.",
			};
		}
		const after = await head();
		return { changed: !!after && !(await ok(["diff", "--quiet", before, after])) };
	}

	async function fetch(): Promise<void> { await git(["fetch", "-q", "origin"]); }

	async function pushHead(branch: string): Promise<"pushed" | "rejected"> {
		try {
			await git(["push", "-q", "-u", "origin", `HEAD:refs/heads/${branch}`]);
			return "pushed";
		} catch (error) {
			const text = error instanceof GitError ? error.stderr : "";
			if (/\[rejected\]|fetch first|non-fast-forward/.test(text)) return "rejected";
			throw error;
		}
	}

	/** Refuse incoming data stamped with a newer format than this app reads. */
	async function newerRemoteData(ref: string): Promise<Extract<SyncResult, { status: "newer-data" }> | null> {
		if (!options.dataFormats) return null;
		let text: string;
		try { text = await out(["show", `${ref}:data-format.json`]); }
		catch { return null; } // no stamp yet: written by an app without the check
		let stamp: unknown;
		try { stamp = JSON.parse(text); } catch { return null; }
		if (!stamp || typeof stamp !== "object") return null;
		const newer = FORMAT_KEYS.filter(key => {
			const value = (stamp as Record<string, unknown>)[key];
			return typeof value === "number" && value > options.dataFormats![key];
		});
		if (!newer.length) return null;
		const detail = newer.map(key => `${key} format ${(stamp as Record<string, number>)[key]}; this app reads ${options.dataFormats![key]}`).join(", ");
		return { status: "newer-data", changed: false, message: `GitHub's data needs a newer LearnHarness (${detail}). Update the app, then sync. Nothing was pulled.` };
	}

	async function pullInternal(branch: string): Promise<{ changed: boolean; status?: never } | Extract<SyncResult, { status: "conflict" | "newer-data" }>> {
		await ensureAttributes();
		await commitLocal();
		await fetch();
		if (await remoteHead(branch)) {
			const refused = await newerRemoteData(`refs/remotes/origin/${branch}`);
			if (refused) return refused;
		}
		return rebaseOnto(branch);
	}

	async function syncInternal(branch: string): Promise<SyncResult> {
		const pulled = await pullInternal(branch);
		if (pulled.status) return pulled;
		let changed = pulled.changed;
		if ((await pushHead(branch)) === "rejected") {
			// Origin moved while we were working: pull once more and retry.
			const again = await pullInternal(branch);
			if (again.status) return again;
			changed ||= again.changed;
			if ((await pushHead(branch)) === "rejected") throw new GitError("GitHub rejected the push twice. Try Sync now again.");
		}
		return { status: "done", changed, message: changed ? "Synced: pulled changes from GitHub and pushed yours." : "Synced with GitHub." };
	}

	function backupBranch(side: "local" | "remote"): string {
		return `lh-backup/${refSafe(host)}-${refStamp(now())}-${side}`;
	}

	function ensureLines(file: string, entries: readonly string[]): void {
		const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
		const lines = new Set(existing.split(/\r?\n/).map(line => line.trim()));
		const missing = entries.filter(entry => !lines.has(entry));
		if (!missing.length) return;
		fs.mkdirSync(path.dirname(file), { recursive: true });
		const prefix = existing && !existing.endsWith("\n") ? "\n" : "";
		fs.writeFileSync(file, `${existing}${prefix}${missing.join("\n")}\n`);
	}
	async function ensureGitignore(): Promise<void> {
		ensureLines(path.join(directory, ".gitignore"), ignoreEntries);
	}
	/** .gitattributes (committed, for every machine) and .git/info/attributes
	 *  (local, in effect even while a rebase replays the commit that adds
	 *  .gitattributes). Also keeps .gitignore current for folders set up by
	 *  an earlier version. */
	async function ensureAttributes(): Promise<void> {
		await ensureGitignore();
		ensureLines(path.join(directory, ".gitattributes"), GITATTRIBUTES_ENTRIES);
		const gitDir = path.resolve(directory, await out(["rev-parse", "--git-dir"]));
		ensureLines(path.join(gitDir, "info", "attributes"), GITATTRIBUTES_ENTRIES);
	}

	async function remoteBranches(url: string): Promise<{ heads: string[]; defaultBranch?: string }> {
		const { stdout } = await git(["ls-remote", "--symref", url, "HEAD", "refs/heads/*"], os.tmpdir());
		const heads: string[] = [];
		let defaultBranch: string | undefined;
		for (const line of stdout.split("\n")) {
			const symref = /^ref: refs\/heads\/(\S+)\s+HEAD$/.exec(line);
			if (symref) { defaultBranch = symref[1]; continue; }
			const ref = /^[0-9a-f]+\s+refs\/heads\/(\S+)$/.exec(line);
			if (ref) heads.push(ref[1]!);
		}
		return { heads, defaultBranch };
	}

	function backupFolder(): string {
		const target = `${directory}.github-sync-backup-${refStamp(now())}`;
		if (fs.existsSync(target)) throw new GitError(`Backup folder already exists: ${target}`);
		// The folder had no repository of its own; skip the one setup just created.
		const ownGit = path.join(directory, ".git");
		fs.cpSync(directory, target, { recursive: true, verbatimSymlinks: true, errorOnExist: true, filter: source => path.resolve(source) !== ownGit });
		return target;
	}

	async function initRepository(url: string, branch: string): Promise<void> {
		await git(["init", "-q", "-b", branch]);
		await git(["remote", "add", "origin", url]);
	}

	/** Set up and in sync with origin, for the automatic triggers. */
	async function autoReady(): Promise<string | null> {
		if (!(await isOwnRepository())) return null;
		return prepare();
	}

	return {
		directory,

		async status(): Promise<RepoStatus> {
			if (!(await isOwnRepository())) return { repository: false, directory };
			const result: RepoStatus = { repository: true, directory };
			result.branch = await out(["symbolic-ref", "--short", "HEAD"]).catch(() => undefined);
			result.remote = await out(["remote", "get-url", "origin"]).catch(() => undefined);
			result.changes = (await out(["status", "--porcelain"])).split("\n").filter(Boolean).length;
			if (await head()) result.lastCommit = await out(["log", "-1", "--format=%s (%cr)"]);
			if (result.branch && (await remoteHead(result.branch)) && (await head())) {
				const [ahead, behind] = (await out(["rev-list", "--left-right", "--count", `HEAD...refs/remotes/origin/${result.branch}`])).split(/\s+/).map(Number);
				result.ahead = ahead; result.behind = behind;
			}
			return result;
		},

		pull: (run?: RunOptions) => exclusive(async (): Promise<SyncResult> => {
			const branch = await prepare();
			const pulled = await pullInternal(branch);
			if (pulled.status) return pulled;
			return { status: "done", changed: pulled.changed, message: pulled.changed ? "Pulled new learning data from GitHub." : "Already up to date with GitHub." };
		}, run),

		push: (run?: RunOptions) => exclusive(async (): Promise<SyncResult> => {
			const branch = await prepare();
			await ensureAttributes();
			await commitLocal();
			if ((await pushHead(branch)) === "rejected") {
				return { status: "behind", changed: false, message: "GitHub has changes you have not pulled yet. Use “GitHub: Sync now” to pull and push together." };
			}
			return { status: "done", changed: false, message: "Pushed your learning data to GitHub." };
		}, run),

		sync: (run?: RunOptions) => exclusive(async () => syncInternal(await prepare()), run),

		/** Startup (beforeLoad): commit, fetch, check formats, rebase. Null when
		 *  the folder is not set up for GitHub Sync. */
		autoPull: (run?: RunOptions) => exclusive(async (): Promise<SyncResult | null> => {
			const branch = await autoReady();
			if (!branch) return null;
			const pulled = await pullInternal(branch);
			if (pulled.status) return pulled;
			return { status: "done", changed: pulled.changed, message: pulled.changed ? "Pulled new learning data from GitHub." : "Already up to date with GitHub." };
		}, run),

		/** Quit (beforeQuit): pull and push. Null when not set up. */
		autoSync: (run?: RunOptions) => exclusive(async (): Promise<SyncResult | null> => {
			const branch = await autoReady();
			return branch ? syncInternal(branch) : null;
		}, run),

		/** After work ends: commit only (the caller holds the app meanwhile). */
		autoCommit: (run?: RunOptions) => exclusive(async (): Promise<{ branch: string; committed: boolean } | null> => {
			const branch = await autoReady();
			if (!branch) return null;
			await ensureAttributes();
			return { branch, committed: await commitLocal() };
		}, run),

		/** After work ends: push committed work without pulling. A remote that
		 *  moved on is left for the next startup/quit sync. */
		autoPush: (run?: RunOptions) => exclusive(async (): Promise<"pushed" | "behind" | "nothing" | null> => {
			const branch = await autoReady();
			if (!branch) return null;
			await fetch();
			const remote = await remoteHead(branch);
			const local = await head();
			if (!local || (remote && local === remote)) return "nothing";
			if (remote && !(await ok(["merge-base", "--is-ancestor", remote, local]))) return "behind";
			return (await pushHead(branch)) === "rejected" ? "behind" : "pushed";
		}, run),

		/** Resolve a conflict reported earlier. `remote` is the commit the learner saw. */
		resolve: (choice: ConflictChoice, remote: string, run?: RunOptions) => exclusive(async (): Promise<SyncResult> => {
			if (choice !== "keep-local" && choice !== "take-remote") throw new GitError("Unknown conflict choice.");
			if (typeof remote !== "string" || !/^[0-9a-f]{40,64}$/.test(remote)) throw new GitError("Invalid remote commit.");
			const branch = await prepare();
			await commitLocal();
			if (choice === "keep-local") {
				const backup = backupBranch("remote");
				await git(["branch", backup, remote]);
				try {
					await git(["push", "-q", "-u", `--force-with-lease=refs/heads/${branch}:${remote}`, "origin", `HEAD:refs/heads/${branch}`]);
				} catch (error) {
					throw new GitError(`GitHub changed again since the conflict was shown, so nothing was overwritten. Run Sync now again. (${error instanceof Error ? error.message : String(error)})`);
				}
				return { status: "done", changed: false, message: `Kept your local data and replaced GitHub's version. GitHub's previous version is saved in local branch ${backup}.` };
			}
			const backup = backupBranch("local");
			await git(["branch", backup, "HEAD"]);
			await git(["reset", "-q", "--hard", remote]);
			return { status: "done", changed: true, message: `Replaced your local data with GitHub's version. Your previous local version is saved in branch ${backup}.` };
		}, run),

		/** Set up the learning-data folder. Touches nothing locally when origin already has data. */
		initialize: (rawUrl: unknown, run?: RunOptions) => exclusive(async (): Promise<InitResult> => {
			const url = validateRemoteUrl(rawUrl);
			if (await isOwnRepository()) throw new GitError("The learning-data folder is already a git repository.");
			const { heads, defaultBranch } = await remoteBranches(url);
			if (heads.length) {
				const branch = defaultBranch && heads.includes(defaultBranch) ? defaultBranch : heads.includes("main") ? "main" : heads[0]!;
				return { status: "remote-has-data", changed: false, branch, message: `The GitHub repository already contains learning data (branch ${branch}).` };
			}
			await initRepository(url, "main");
			await ensureAttributes();
			await commitLocal(`initial: ${host} ${stamp(now(), " ")}`);
			if ((await pushHead("main")) === "rejected") throw new GitError("GitHub rejected the first push; the repository may have received data meanwhile.");
			return { status: "done", changed: false, message: "GitHub Sync is set up and your learning data was pushed." };
		}, run),

		/** Continue initialization when origin already has data. */
		initializeFromRemote: (rawUrl: unknown, choice: InitChoice, branch: unknown, run?: RunOptions) => exclusive(async (): Promise<InitResult> => {
			const url = validateRemoteUrl(rawUrl);
			if (choice !== "use-remote" && choice !== "merge") throw new GitError("Unknown setup choice.");
			if (typeof branch !== "string" || !/^[A-Za-z0-9._\/-]{1,200}$/.test(branch) || branch.startsWith("-")) throw new GitError("Invalid branch name.");
			if (await isOwnRepository()) throw new GitError("The learning-data folder is already a git repository.");
			if (choice === "use-remote") {
				// Check formats in a throwaway fetch before touching the folder.
				await initRepository(url, branch);
				await fetch();
				const remote = await remoteHead(branch);
				if (!remote) { fs.rmSync(path.join(directory, ".git"), { recursive: true, force: true }); throw new GitError(`GitHub has no branch ${branch}.`); }
				const refused = await newerRemoteData(remote);
				if (refused) { fs.rmSync(path.join(directory, ".git"), { recursive: true, force: true }); return refused; }
				const backup = backupFolder();
				// Overwrites files GitHub also has; local-only files stay and will sync later.
				await git(["checkout", "-q", "-f", "-B", branch, remote]);
				await git(["branch", "-q", `--set-upstream-to=origin/${branch}`]);
				return { status: "done", changed: true, message: `Now using GitHub's learning data. Your previous folder was copied to ${backup}.` };
			}
			await initRepository(url, branch);
			await ensureAttributes();
			await commitLocal(`initial: ${host} ${stamp(now(), " ")}`);
			const result = await syncInternal(branch);
			return result.status === "behind" ? { status: "done", changed: false, message: result.message } : result;
		}, run),
	};
}

export type GitSync = ReturnType<typeof createGitSync>;

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import path from "node:path";

/** Entries GitHub Sync keeps in the learning-data .gitignore. */
export const GITIGNORE_ENTRIES = [".tmp-*", "*.tmp-*", ".DS_Store", "plugins/*/node_modules/", "plugins/*/.sdk/"] as const;

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
	| { status: "conflict"; message: string; changed: false; branch: string; remote: string };

export type ConflictChoice = "keep-local" | "take-remote";

export type InitResult =
	| { status: "done"; message: string; changed: boolean }
	/** Nothing was changed locally; ask the learner how to combine. */
	| { status: "remote-has-data"; message: string; branch: string; changed: false }
	| Extract<SyncResult, { status: "conflict" }>;

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
	let running = false;

	function git(args: string[], cwd = directory): Promise<{ stdout: string; stderr: string }> {
		return new Promise((resolve, reject) => {
			execFile(gitBin, args, {
				cwd, maxBuffer: 64 * 1024 * 1024,
				// Never wait on an interactive credential prompt inside the app server.
				env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
			}, (error, stdout, stderr) => {
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
	async function exclusive<T>(work: () => Promise<T>): Promise<T> {
		if (running) throw new GitError("Another GitHub Sync operation is still running.");
		running = true;
		try { return await work(); } finally { running = false; }
	}

	async function isOwnRepository(): Promise<boolean> {
		if (!fs.existsSync(path.join(directory, ".git"))) return false;
		try {
			const top = await out(["rev-parse", "--show-toplevel"]);
			return fs.realpathSync(top) === fs.realpathSync(directory);
		} catch { return false; }
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
			await git(["rebase", "--abort"]).catch(() => undefined);
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

	async function pullInternal(branch: string) {
		await commitLocal();
		await fetch();
		return rebaseOnto(branch);
	}

	async function syncInternal(branch: string): Promise<SyncResult> {
		const pulled = await pullInternal(branch);
		if ("status" in pulled) return pulled;
		let changed = pulled.changed;
		if ((await pushHead(branch)) === "rejected") {
			// Origin moved while we were working: pull once more and retry.
			const again = await pullInternal(branch);
			if ("status" in again) return again;
			changed ||= again.changed;
			if ((await pushHead(branch)) === "rejected") throw new GitError("GitHub rejected the push twice. Try Sync now again.");
		}
		return { status: "done", changed, message: changed ? "Synced: pulled changes from GitHub and pushed yours." : "Synced with GitHub." };
	}

	function backupBranch(side: "local" | "remote"): string {
		return `lh-backup/${refSafe(host)}-${refStamp(now())}-${side}`;
	}

	async function ensureGitignore(): Promise<void> {
		const file = path.join(directory, ".gitignore");
		const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
		const lines = new Set(existing.split(/\r?\n/).map(line => line.trim()));
		const missing = GITIGNORE_ENTRIES.filter(entry => !lines.has(entry));
		if (!missing.length) return;
		const prefix = existing && !existing.endsWith("\n") ? "\n" : "";
		fs.writeFileSync(file, `${existing}${prefix}${missing.join("\n")}\n`);
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
		fs.cpSync(directory, target, { recursive: true, verbatimSymlinks: true, errorOnExist: true });
		return target;
	}

	async function initRepository(url: string, branch: string): Promise<void> {
		await git(["init", "-q", "-b", branch]);
		await git(["remote", "add", "origin", url]);
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

		pull: () => exclusive(async (): Promise<SyncResult> => {
			const branch = await prepare();
			const pulled = await pullInternal(branch);
			if ("status" in pulled) return pulled;
			return { status: "done", changed: pulled.changed, message: pulled.changed ? "Pulled new learning data from GitHub." : "Already up to date with GitHub." };
		}),

		push: () => exclusive(async (): Promise<SyncResult> => {
			const branch = await prepare();
			await commitLocal();
			if ((await pushHead(branch)) === "rejected") {
				return { status: "behind", changed: false, message: "GitHub has changes you have not pulled yet. Use “GitHub: Sync now” to pull and push together." };
			}
			return { status: "done", changed: false, message: "Pushed your learning data to GitHub." };
		}),

		sync: () => exclusive(async () => syncInternal(await prepare())),

		/** Resolve a conflict reported earlier. `remote` is the commit the learner saw. */
		resolve: (choice: ConflictChoice, remote: string) => exclusive(async (): Promise<SyncResult> => {
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
		}),

		/** Set up the learning-data folder. Touches nothing locally when origin already has data. */
		initialize: (rawUrl: unknown) => exclusive(async (): Promise<InitResult> => {
			const url = validateRemoteUrl(rawUrl);
			if (await isOwnRepository()) throw new GitError("The learning-data folder is already a git repository.");
			const { heads, defaultBranch } = await remoteBranches(url);
			if (heads.length) {
				const branch = defaultBranch && heads.includes(defaultBranch) ? defaultBranch : heads.includes("main") ? "main" : heads[0]!;
				return { status: "remote-has-data", changed: false, branch, message: `The GitHub repository already contains learning data (branch ${branch}).` };
			}
			await initRepository(url, "main");
			await ensureGitignore();
			await commitLocal(`initial: ${host} ${stamp(now(), " ")}`);
			if ((await pushHead("main")) === "rejected") throw new GitError("GitHub rejected the first push; the repository may have received data meanwhile.");
			return { status: "done", changed: false, message: "GitHub Sync is set up and your learning data was pushed." };
		}),

		/** Continue initialization when origin already has data. */
		initializeFromRemote: (rawUrl: unknown, choice: InitChoice, branch: unknown) => exclusive(async (): Promise<InitResult> => {
			const url = validateRemoteUrl(rawUrl);
			if (choice !== "use-remote" && choice !== "merge") throw new GitError("Unknown setup choice.");
			if (typeof branch !== "string" || !/^[A-Za-z0-9._\/-]{1,200}$/.test(branch) || branch.startsWith("-")) throw new GitError("Invalid branch name.");
			if (await isOwnRepository()) throw new GitError("The learning-data folder is already a git repository.");
			if (choice === "use-remote") {
				const backup = backupFolder();
				await initRepository(url, branch);
				await fetch();
				const remote = await remoteHead(branch);
				if (!remote) throw new GitError(`GitHub has no branch ${branch}.`);
				// Overwrites files GitHub also has; local-only files stay and will sync later.
				await git(["checkout", "-q", "-f", "-B", branch, remote]);
				await git(["branch", "-q", `--set-upstream-to=origin/${branch}`]);
				return { status: "done", changed: true, message: `Now using GitHub's learning data. Your previous folder was copied to ${backup}.` };
			}
			await initRepository(url, branch);
			await ensureGitignore();
			await commitLocal(`initial: ${host} ${stamp(now(), " ")}`);
			const result = await syncInternal(branch);
			return result.status === "behind" ? { status: "done", changed: false, message: result.message } : result;
		}),
	};
}

export type GitSync = ReturnType<typeof createGitSync>;

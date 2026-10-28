/**
 * How the user's Claude Code install is started (Local Claude route): the
 * query options every SDK call shares — the executable, the scrubbed
 * environment, the app-owned cwd — and the custom spawner that lets an
 * npm `cli.js` install run through the app's OWN runtime (the packaged
 * app is Electron-as-Node; a Dock-launched app has no `node` on PATH).
 * Native binaries spawn directly; the SDK's own abort sequence (stdin
 * close → SIGTERM after 2 s → SIGKILL after 5 s) applies unchanged.
 */
import { spawn } from "node:child_process";
import type { ClaudeLocalLaunch } from "./bridge.ts";
import { claudeChildEnv } from "./env.ts";
import type { ClaudeQueryOptions } from "./sdk.ts";

/** The command line for an install: the native binary as is, or cli.js
 *  through the app's runtime (ELECTRON_RUN_AS_NODE makes Electron plain
 *  Node; it is harmless under real Node). */
export function claudeCommand(binary: { path: string; viaNode: boolean }, execPath = process.execPath): { command: string; args: string[]; extraEnv: Record<string, string> } {
	if (!binary.viaNode) return { command: binary.path, args: [], extraEnv: {} };
	return { command: execPath, args: [binary.path], extraEnv: { ELECTRON_RUN_AS_NODE: "1" } };
}

/** The isolation every query against the user's install carries: no
 *  Claude Code built-in tools, none of the user's settings (CLAUDE.md,
 *  hooks, MCP config), only the MCP servers the call passes, and no
 *  session files under ~/.claude/projects. */
export function claudeIsolationOptions(): Required<Pick<ClaudeQueryOptions, "tools" | "settingSources" | "strictMcpConfig" | "persistSession">> {
	return { tools: [], settingSources: [], strictMcpConfig: true, persistSession: false };
}

/** The shared option slice for every query against this install —
 *  isolated by construction (claudeIsolationOptions), so no call site can
 *  omit the isolation flags. */
export function claudeLaunchOptions(launch: ClaudeLocalLaunch, base: NodeJS.ProcessEnv = process.env): Pick<ClaudeQueryOptions, "pathToClaudeCodeExecutable" | "executable" | "cwd" | "env" | "spawnClaudeCodeProcess" | "tools" | "settingSources" | "strictMcpConfig" | "persistSession"> {
	const { command, extraEnv } = claudeCommand(launch);
	return {
		...claudeIsolationOptions(),
		pathToClaudeCodeExecutable: launch.path,
		...(launch.viaNode ? { executable: "node" as const } : {}),
		cwd: launch.cwd,
		env: claudeChildEnv(base, extraEnv),
		// The SDK names "node" for a .js entry; run it on OUR runtime instead.
		// A ChildProcess satisfies the SDK's SpawnedProcess contract.
		spawnClaudeCodeProcess: (options) => {
			const child = spawn(launch.viaNode && options.command === "node" ? command : options.command, options.args, {
				cwd: options.cwd,
				env: options.env as NodeJS.ProcessEnv,
				// stderr is never a pipe: the app never reads it (it may carry
				// anything Claude Code prints about its login), and an unread pipe
				// stalls a child that writes more than the pipe holds.
				stdio: ["pipe", "pipe", "ignore"],
				signal: options.signal,
				windowsHide: true,
			});
			// Debug aid (LH_CLAUDE_LOCAL_DEBUG=1, the LH_PROVIDER_EVENTS idiom): the
			// exact command line on the server log. Never the child's stderr: it
			// may carry anything Claude Code prints about its login.
			if (base.LH_CLAUDE_LOCAL_DEBUG === "1") console.error(`[claude-local] spawn ${child.spawnfile} ${options.args.join(" ")}`);
			return child;
		},
	};
}

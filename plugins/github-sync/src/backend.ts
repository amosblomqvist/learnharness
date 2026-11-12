import type { PluginBackendContext } from "learnharness-plugin-api";
import { createGitSync, type ConflictChoice, type InitChoice } from "./git-sync.ts";

function record(input: unknown): Record<string, unknown> {
	return input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
}

export function activate(ctx: PluginBackendContext): void {
	// The whole learning-data folder is the synced repository.
	const sync = createGitSync({ directory: ctx.learning.directory });
	const live = <T>(work: () => Promise<T>) => async () => {
		ctx.signal.throwIfAborted();
		return work();
	};
	ctx.handle("status", live(() => sync.status()));
	ctx.handle("pull", live(() => sync.pull()));
	ctx.handle("push", live(() => sync.push()));
	ctx.handle("sync", live(() => sync.sync()));
	ctx.handle("resolve", input => {
		const { choice, remote } = record(input);
		return live(() => sync.resolve(choice as ConflictChoice, remote as string))();
	});
	ctx.handle("initialize", input => live(() => sync.initialize(record(input).url))());
	ctx.handle("initialize-from-remote", input => {
		const { url, choice, branch } = record(input);
		return live(() => sync.initializeFromRemote(url, choice as InitChoice, branch))();
	});
}

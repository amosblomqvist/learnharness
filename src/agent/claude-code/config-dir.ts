const CONFIG_DIR_KEY = Symbol.for("lh.claude-code.config-dir.v1");

export type ClaudeConfigDirGetter = () => string | undefined;

const shared = globalThis as typeof globalThis & {
	[CONFIG_DIR_KEY]?: ClaudeConfigDirGetter;
};

/** Inject configured CLAUDE_CONFIG_DIR from the server composition root without violating import boundaries. */
export function configureClaudeConfigDir(getConfigDir: ClaudeConfigDirGetter): void {
	shared[CONFIG_DIR_KEY] = getConfigDir;
}

export function getConfiguredClaudeConfigDir(): string | undefined {
	const value = shared[CONFIG_DIR_KEY]?.();
	return value ? value : undefined;
}

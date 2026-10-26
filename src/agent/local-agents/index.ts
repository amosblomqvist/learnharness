/**
 * Local agent connections (docs/architecture.md §8.2): Claude through the
 * learner's own Claude Code CLI and Antigravity through Google's official
 * ACP server — both installed and signed in by the learner, driven by the
 * app over their documented local protocols with the app's tools bridged
 * over a loopback MCP server.
 */
export {
	cancelLocalAgentSignIn,
	configureLocalAgentPreferences,
	isLocalAgentProvider,
	localAgentAdmissionCurrent,
	localAgentBackgroundAllowed,
	localAgentConnected,
	localAgentModel,
	localAgentModels,
	localAgentStatus,
	localAgentStatuses,
	onLocalAgentChange,
	refreshLocalAgents,
	setLocalAgentPreferences,
	signInLocalAgent,
} from "./state.ts";
export { localAgentError, localAgentStream } from "./stream.ts";
export { configureAppHeldEnvVars } from "./binaries.ts";

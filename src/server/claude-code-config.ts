import { EXTERNAL_CLI_PROVIDERS } from "../core/contracts/external-cli.ts";
import { externalCliAvailable, externalCliEnabled } from "./external-cli-config.ts";

/** Fresh admission state, not a process-wide cache. Existing runs retain
 * their engines; only new chat/job/extraction/compaction admissions consult it. */
export function claudeCodeEnabled(): boolean {
	return externalCliEnabled(EXTERNAL_CLI_PROVIDERS.claudeCode);
}

/** Installation/opt-in availability only, never authenticated readiness. */
export function claudeCodeAvailable(): boolean {
	return externalCliAvailable(EXTERNAL_CLI_PROVIDERS.claudeCode);
}

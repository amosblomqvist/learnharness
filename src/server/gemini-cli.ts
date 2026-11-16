import { inspectCliInstallation, readCliVersionWith, type CliInstallationStatus, type ReadCliVersion } from "../agent/claude-code/installation.ts";
import { findNodeBinary, GEMINI_NO_RELAUNCH_ENV, geminiBinaryOf, GeminiInstallKind, getGeminiInstall, isGeminiBundleScript, type GeminiInstall } from "../agent/gemini-cli/binary.ts";
import { geminiVersionSpec } from "../agent/gemini-cli/stream.ts";
import { EXTERNAL_CLI_LABELS, EXTERNAL_CLI_PROVIDERS, EXTERNAL_CLI_STATUS_STATES, GEMINI_NODE_MISSING_MESSAGE, type ExternalCliStatus } from "../core/contracts/external-cli.ts";
import { externalCliEnabled } from "./external-cli-config.ts";
import { externalCliInstallationResponse } from "./external-cli-status.ts";
import { initAuthEnv } from "./keys.ts";

const readGeminiVersion: ReadCliVersion = (binary) => {
	if (!isGeminiBundleScript(binary)) return readCliVersionWith(binary, [], GEMINI_NO_RELAUNCH_ENV);
	const node = findNodeBinary();
	if (!node) return Promise.reject(new Error(GEMINI_NODE_MISSING_MESSAGE));
	return readCliVersionWith(node, [binary], GEMINI_NO_RELAUNCH_ENV);
};

/** The Settings status seam: initialize provenance before any child env is copied.
 * Installation/version only; never reads auth status or makes a model request.
 * A bundle without `node` is reported as `node-missing` and its version is not read. */
export async function geminiCliInstallationStatus(
	findInstall: () => GeminiInstall = getGeminiInstall,
	readVersion: ReadCliVersion = readGeminiVersion,
): Promise<CliInstallationStatus | ExternalCliStatus> {
	initAuthEnv();
	const install = findInstall();
	if (install.kind === GeminiInstallKind.NODE_MISSING) {
		return { state: EXTERNAL_CLI_STATUS_STATES.nodeMissing, version: null, minimumVersion: geminiVersionSpec.minimumVersion };
	}
	return inspectCliInstallation(geminiVersionSpec, () => geminiBinaryOf(install), readVersion);
}

export async function geminiCliInstallationResponse(
	request: Request,
	inspect: () => Promise<unknown> = geminiCliInstallationStatus,
	enabled: () => boolean = () => externalCliEnabled(EXTERNAL_CLI_PROVIDERS.geminiCli),
): Promise<Response> {
	return externalCliInstallationResponse(request, {
		label: EXTERNAL_CLI_LABELS[EXTERNAL_CLI_PROVIDERS.geminiCli],
		inspect,
		enabled,
	});
}

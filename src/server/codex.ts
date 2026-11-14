import { codexBinarySpec, codexVersionSpec } from "../agent/codex/stream.ts";
import { getCliBinary } from "../agent/claude-code/binary.ts";
import { inspectCliInstallation } from "../agent/claude-code/installation.ts";
import { EXTERNAL_CLI_PROVIDERS } from "../core/contracts/external-cli.ts";
import { externalCliEnabled } from "./external-cli-config.ts";
import { externalCliInstallationResponse } from "./external-cli-status.ts";
import { initAuthEnv } from "./keys.ts";

/** The Settings status seam: initialize provenance before any child env is copied.
 * Installation/version only; never reads auth status or makes a model request. */
export async function codexInstallationStatus(findBinary: () => string | null = () => getCliBinary(codexBinarySpec)) {
	initAuthEnv();
	return inspectCliInstallation(codexVersionSpec, findBinary);
}

export async function codexInstallationResponse(
	request: Request,
	inspect: () => Promise<unknown> = codexInstallationStatus,
	enabled: () => boolean = () => externalCliEnabled(EXTERNAL_CLI_PROVIDERS.codex),
): Promise<Response> {
	return externalCliInstallationResponse(request, { label: "Codex", inspect, enabled });
}

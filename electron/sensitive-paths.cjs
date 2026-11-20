"use strict";

const path = require("node:path");

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

/** Comparison only: preserve the accepted #421 Windows namespace/ADS
 * semantics. The returned spelling is never used for opening a file. */
function comparisonPath(absolute) {
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

/** Segment-aware containment; ignoreCase is ONLY for the existing home
 * denylist. Do not globally casefold configured allowed folders. */
function isWithin(absolute, root, ignoreCase = false) {
	let child = comparisonPath(absolute);
	let parent = comparisonPath(root);
	if (ignoreCase) { child = child.toLowerCase(); parent = parent.toLowerCase(); }
	const rel = path.relative(parent, child);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/** Templates are deliberately included: their names do not guarantee safe contents. */
const ENV_FILE = /^\.env(\..*)?$/i;
const SUBSCRIPTION_FILES = ["chatgpt-credentials.json", "github-copilot-credentials.json", "xai-credentials.json"];
// Match the actual writers in store/auth.ts and electron/{chatgpt,subscription-store}.cjs.
const CREDENTIAL_TEMP = /^(?:\.auth\.json\.tmp-\d+|(?:chatgpt|github-copilot|xai)-credentials\.json\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp)$/i;
const ATOMIC_TEMP_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function credentialFiles(authFile) {
	return [authFile, ...SUBSCRIPTION_FILES.map((name) => path.join(path.dirname(authFile), name))];
}

function isCredentialTemp(absolute, directory, authBasename) {
	const file = comparisonPath(absolute);
	if (path.relative(comparisonPath(directory), path.dirname(file)) !== "") return false;
	const name = path.basename(file);
	const prefix = `${authBasename}.tmp-`;
	return CREDENTIAL_TEMP.test(name) ||
		(name.toLowerCase().startsWith(prefix.toLowerCase()) && ATOMIC_TEMP_UUID.test(name.slice(prefix.length)));
}

/** String-only check, also usable with synthetic home/credential locations.
 *  Only credentials are app-private denials: learning data remains readable. */
function isSensitivePath(absolute, home, authFile) {
	const file = comparisonPath(absolute);
	return ENV_FILE.test(path.basename(file)) ||
		SENSITIVE_HOME_PATHS.some((p) => isWithin(file, path.join(home, p), true)) ||
		(Boolean(authFile) && (credentialFiles(authFile).some((p) => isWithin(file, p)) ||
			isCredentialTemp(file, path.dirname(authFile), path.basename(comparisonPath(authFile)))));
}

module.exports = { SENSITIVE_HOME_PATHS, comparisonPath, isWithin, credentialFiles, isCredentialTemp, isSensitivePath };

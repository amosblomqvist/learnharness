export {
	ANTIGRAVITY_PROVIDER,
	ANTIGRAVITY_PROFILE_DIRNAME,
	ANTIGRAVITY_MINIMUM_CLI_VERSION,
	ANTIGRAVITY_MANAGED_VERSION,
} from "../../core/contracts/antigravity.ts";

export const ANTIGRAVITY_API = "antigravity-acp";

export const ANTIGRAVITY_VERSION_TIMEOUT_MS = 5_000;
export const ANTIGRAVITY_INIT_PROBE_TIMEOUT_MS = 15_000;
export const ANTIGRAVITY_AUTH_URL_WAIT_MS = 10_000;
export const ANTIGRAVITY_OAUTH_TIMEOUT_MS = 300_000;
export const ANTIGRAVITY_LOGOUT_TIMEOUT_MS = 15_000;
export const ANTIGRAVITY_SESSION_NEW_TIMEOUT_MS = 30_000;
export const ANTIGRAVITY_MODEL_PROBE_TIMEOUT_MS = 4_000;
export const ANTIGRAVITY_SET_CONFIG_TIMEOUT_MS = 10_000;
export const ANTIGRAVITY_CANCEL_GRACE_MS = 2_000;
export const ANTIGRAVITY_PARK_IDLE_TIMEOUT_MS = 10 * 60_000;
export const ANTIGRAVITY_MCP_TOOL_TIMEOUT_MS = 30 * 60_000;

export const ANTIGRAVITY_AUTH_URL_MARKER = "__LH_ANTIGRAVITY_AUTH_URL__";
export const ANTIGRAVITY_STDERR_AUTH_PROMPT = "Open the following link to authenticate the ACP server:";

/** Ambient Google / Gemini / Vertex / GCloud and internal ACP keys stripped
 *  from Antigravity child environments so BYOK API keys never silently bill
 *  instead of the user's Antigravity subscription. */
export const ANTIGRAVITY_ENV_STRIP_KEYS = [
	"GEMINI_API_KEY",
	"GOOGLE_API_KEY",
	"GOOGLE_APPLICATION_CREDENTIALS",
	"GOOGLE_CLOUD_PROJECT",
	"GOOGLE_CLOUD_LOCATION",
	"GOOGLE_CLOUD_QUOTA_PROJECT",
	"GOOGLE_GENAI_USE_VERTEXAI",
	"GCLOUD_PROJECT",
	"CLOUDSDK_CORE_PROJECT",
	"AGY_ACP_CCPA_PROJECT",
	"AGY_ACP_ENABLE_OAUTH",
	"GEMINI_HOME",
	"AGY_ACP_FORCE_FILE_STORAGE",
	"ANTIGRAVITY_HARNESS_PATH",
	"BROWSER",
	"PYTHONUNBUFFERED",
	"ELECTRON_RUN_AS_NODE",
	"CHROME_CRASHPAD_PIPE_NAME",
	"SSH_CONNECTION",
	"SSH_CLIENT",
	"SSH_TTY",
] as const;

export const LINUX_CA_BUNDLE_PATHS = [
	"/etc/ssl/certs/ca-bundle.crt",
	"/etc/ssl/certs/ca-certificates.crt",
	"/etc/pki/tls/certs/ca-bundle.crt",
	"/etc/ssl/cert.pem",
] as const;

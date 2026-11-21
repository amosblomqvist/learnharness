const { createHash, randomBytes, randomUUID } = require("node:crypto");
const http = require("node:http");

const ANTIGRAVITY_PROVIDER_ID = "antigravity";
const ANTIGRAVITY_API = "antigravity-generative-ai";
const ANTIGRAVITY_DEFAULT_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com";
const ANTIGRAVITY_FALLBACK_ENDPOINT = "https://cloudcode-pa.googleapis.com";
const ANTIGRAVITY_ALLOWED_ORIGINS = [
	ANTIGRAVITY_DEFAULT_ENDPOINT,
	ANTIGRAVITY_FALLBACK_ENDPOINT,
];

const ANTIGRAVITY_CLIENT_ID = ["1071006060591-tmhssin2h21lcre235vtolojh4g403ep", "apps.googleusercontent.com"].join(".");
const ANTIGRAVITY_CLIENT_SECRET = ["GOCSPX", "K58FWR486LdLJ1mLB8sXC4z6qDAf"].join("-");
const ANTIGRAVITY_REDIRECT_PORT = 51121;
const ANTIGRAVITY_REDIRECT_URI = `http://localhost:${ANTIGRAVITY_REDIRECT_PORT}/oauth-callback`;
const ANTIGRAVITY_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const ANTIGRAVITY_TOKEN_URL = "https://oauth2.googleapis.com/token";
const ANTIGRAVITY_SCOPES = [
	"https://www.googleapis.com/auth/aicode",
	"https://www.googleapis.com/auth/cloud-platform",
	"https://www.googleapis.com/auth/userinfo.email",
	"https://www.googleapis.com/auth/userinfo.profile",
	"https://www.googleapis.com/auth/cclog",
	"https://www.googleapis.com/auth/experimentsandconfigs",
];

const ANTIGRAVITY_VERSION = "1.23.2";
const ANTIGRAVITY_SYSTEM_INSTRUCTION = "You are Antigravity, a powerful agentic AI coding assistant designed by the Google DeepMind team working on Advanced Agentic Coding.";
const CONTINUATION_TEXT = "Please continue based on the conversation and tool outputs above.";

const DEFAULT_ANTIGRAVITY_ROUTING = {
	"gemini-4-argon": {
		off: "gemini-3.8-flash-tiered",
		minimal: "gemini-3.8-flash-tiered",
		low: "gemini-3.8-flash-tiered",
		medium: "gemini-3.8-flash-tiered",
		high: "gemini-3.8-flash-tiered",
		xhigh: "gemini-3.8-flash-tiered",
	},
	"gemini-3.8-flash": {
		off: "gemini-3.8-flash-tiered",
		minimal: "gemini-3.8-flash-tiered",
		low: "gemini-3.8-flash-tiered",
		medium: "gemini-3.8-flash-tiered",
		high: "gemini-3.8-flash-tiered",
		xhigh: "gemini-3.8-flash-tiered",
	},
	"gemini-3.7-flash": {
		off: "gemini-3.8-flash-tiered",
		minimal: "gemini-3.8-flash-tiered",
		low: "gemini-3.8-flash-tiered",
		medium: "gemini-3.8-flash-tiered",
		high: "gemini-3.8-flash-tiered",
		xhigh: "gemini-3.8-flash-tiered",
	},
	"gemini-3.6-flash": {
		off: "gemini-3.5-flash",
		minimal: "gemini-3.5-flash",
		low: "gemini-3.5-flash",
		medium: "gemini-3.5-flash",
		high: "gemini-3.5-flash",
		xhigh: "gemini-3.5-flash",
	},
	"gemini-3.5-flash": {
		off: "gemini-3.5-flash",
		minimal: "gemini-3.5-flash",
		low: "gemini-3.5-flash",
		medium: "gemini-3.5-flash",
		high: "gemini-3.5-flash",
		xhigh: "gemini-3.5-flash",
	},
	"gemini-3.5-flash-lite": {
		off: "gemini-3.5-flash-lite",
		minimal: "gemini-3.5-flash-lite",
		low: "gemini-3.5-flash-lite",
		medium: "gemini-3.5-flash-lite",
		high: "gemini-3.5-flash-lite",
		xhigh: "gemini-3.5-flash-lite",
	},
	"gemini-3.1-pro": {
		off: "gemini-3.8-flash-tiered",
		minimal: "gemini-3.8-flash-tiered",
		low: "gemini-3.8-flash-tiered",
		medium: "gemini-3.8-flash-tiered",
		high: "gemini-3.8-flash-tiered",
		xhigh: "gemini-3.8-flash-tiered",
	},
	"gemini-3.1-flash-lite": {
		off: "gemini-3.1-flash-lite",
		minimal: "gemini-3.1-flash-lite",
		low: "gemini-3.1-flash-lite",
		medium: "gemini-3.1-flash-lite",
		high: "gemini-3.1-flash-lite",
		xhigh: "gemini-3.1-flash-lite",
	},
	"gemini-3-flash": {
		off: "gemini-3-flash",
		minimal: "gemini-3-flash",
		low: "gemini-3-flash",
		medium: "gemini-3-flash",
		high: "gemini-3-flash",
		xhigh: "gemini-3-flash",
	},
	"gemini-2.5-pro": {
		off: "gemini-2.5-pro",
		minimal: "gemini-2.5-pro",
		low: "gemini-2.5-pro",
		medium: "gemini-2.5-pro",
		high: "gemini-2.5-pro",
		xhigh: "gemini-2.5-pro",
	},
	"gemini-2.5-flash": {
		off: "gemini-2.5-flash",
		minimal: "gemini-2.5-flash-thinking",
		low: "gemini-2.5-flash-thinking",
		medium: "gemini-2.5-flash-thinking",
		high: "gemini-2.5-flash-thinking",
		xhigh: "gemini-2.5-flash-thinking",
	},
	"claude-sonnet-4-6": {
		off: "claude-sonnet-4-6",
		minimal: "claude-sonnet-4-6",
		low: "claude-sonnet-4-6",
		medium: "claude-sonnet-4-6",
		high: "claude-sonnet-4-6",
		xhigh: "claude-sonnet-4-6",
	},
	"claude-opus-4-6": {
		off: "claude-opus-4-6-thinking",
		minimal: "claude-opus-4-6-thinking",
		low: "claude-opus-4-6-thinking",
		medium: "claude-opus-4-6-thinking",
		high: "claude-opus-4-6-thinking",
		xhigh: "claude-opus-4-6-thinking",
	},
	"claude-sonnet-5-5": {
		off: "claude-sonnet-5-5-low",
		minimal: "claude-sonnet-5-5-low",
		low: "claude-sonnet-5-5-low",
		medium: "claude-sonnet-5-5-medium",
		high: "claude-sonnet-5-5-high",
		xhigh: "claude-sonnet-5-5-high",
	},
	"claude-opus-5-5": {
		off: "claude-opus-5-5-low",
		minimal: "claude-opus-5-5-low",
		low: "claude-opus-5-5-low",
		medium: "claude-opus-5-5-medium",
		high: "claude-opus-5-5-high",
		xhigh: "claude-opus-5-5-high",
	},
	"gpt-oss-120b": {
		off: "gpt-oss-120b-medium",
		minimal: "gpt-oss-120b-medium",
		low: "gpt-oss-120b-medium",
		medium: "gpt-oss-120b-medium",
		high: "gpt-oss-120b-medium",
		xhigh: "gpt-oss-120b-medium",
	},
};

const ANTIGRAVITY_MODELS = [
	{
		id: "gemini-4-argon",
		name: "Gemini 4 Argon",
		api: ANTIGRAVITY_API,
		provider: ANTIGRAVITY_PROVIDER_ID,
		baseUrl: ANTIGRAVITY_DEFAULT_ENDPOINT,
		reasoning: true,
		thinkingLevelMap: { low: "low", medium: "medium", high: "high" },
		input: ["text", "image"],
		cost: { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 2.375 },
		contextWindow: 1000000,
		maxTokens: 65536,
	},
	{
		id: "gemini-3.8-flash",
		name: "Gemini 3.8 Flash",
		api: ANTIGRAVITY_API,
		provider: ANTIGRAVITY_PROVIDER_ID,
		baseUrl: ANTIGRAVITY_DEFAULT_ENDPOINT,
		reasoning: true,
		thinkingLevelMap: { low: "low", medium: "medium", high: "high" },
		input: ["text", "image"],
		cost: { input: 0.5, output: 3, cacheRead: 0.5, cacheWrite: 0 },
		contextWindow: 1000000,
		maxTokens: 65536,
	},
	{
		id: "claude-opus-5-5",
		name: "Claude Opus 5.5",
		api: ANTIGRAVITY_API,
		provider: ANTIGRAVITY_PROVIDER_ID,
		baseUrl: ANTIGRAVITY_DEFAULT_ENDPOINT,
		reasoning: true,
		thinkingLevelMap: { low: "low", medium: "medium", high: "high" },
		input: ["text", "image"],
		cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
		contextWindow: 200000,
		maxTokens: 64000,
	},
	{
		id: "claude-sonnet-5-5",
		name: "Claude Sonnet 5.5",
		api: ANTIGRAVITY_API,
		provider: ANTIGRAVITY_PROVIDER_ID,
		baseUrl: ANTIGRAVITY_DEFAULT_ENDPOINT,
		reasoning: true,
		thinkingLevelMap: { low: "low", medium: "medium", high: "high" },
		input: ["text", "image"],
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		contextWindow: 200000,
		maxTokens: 64000,
	},
	{
		id: "gpt-oss-120b",
		name: "GPT-OSS 120B",
		api: ANTIGRAVITY_API,
		provider: ANTIGRAVITY_PROVIDER_ID,
		baseUrl: ANTIGRAVITY_DEFAULT_ENDPOINT,
		reasoning: true,
		thinkingLevelMap: { medium: "medium" },
		input: ["text"],
		cost: { input: 0.15, output: 0.6, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 131072,
		maxTokens: 32768,
	},
	{
		id: "gemini-3.7-flash",
		name: "Gemini 3.7 Flash",
		api: ANTIGRAVITY_API,
		provider: ANTIGRAVITY_PROVIDER_ID,
		baseUrl: ANTIGRAVITY_DEFAULT_ENDPOINT,
		reasoning: true,
		thinkingLevelMap: { low: "low", medium: "medium", high: "high" },
		input: ["text", "image"],
		cost: { input: 0.5, output: 3, cacheRead: 0.5, cacheWrite: 0 },
		contextWindow: 1048576,
		maxTokens: 65536,
	},
	{
		id: "gemini-3.6-flash",
		name: "Gemini 3.6 Flash",
		api: ANTIGRAVITY_API,
		provider: ANTIGRAVITY_PROVIDER_ID,
		baseUrl: ANTIGRAVITY_DEFAULT_ENDPOINT,
		reasoning: true,
		thinkingLevelMap: { low: "low", medium: "medium", high: "high" },
		input: ["text", "image"],
		cost: { input: 0.5, output: 3, cacheRead: 0.5, cacheWrite: 0 },
		contextWindow: 1048576,
		maxTokens: 65536,
	},
	{
		id: "gemini-3.5-flash",
		name: "Gemini 3.5 Flash",
		api: ANTIGRAVITY_API,
		provider: ANTIGRAVITY_PROVIDER_ID,
		baseUrl: ANTIGRAVITY_DEFAULT_ENDPOINT,
		reasoning: true,
		thinkingLevelMap: { minimal: "minimal", low: "low", medium: "medium", high: "high" },
		input: ["text", "image"],
		cost: { input: 0.5, output: 3, cacheRead: 0.5, cacheWrite: 0 },
		contextWindow: 1048576,
		maxTokens: 65536,
	},
	{
		id: "gemini-3.5-flash-lite",
		name: "Gemini 3.5 Flash Lite",
		api: ANTIGRAVITY_API,
		provider: ANTIGRAVITY_PROVIDER_ID,
		baseUrl: ANTIGRAVITY_DEFAULT_ENDPOINT,
		reasoning: true,
		thinkingLevelMap: { low: "low", medium: "medium", high: "high" },
		input: ["text", "image"],
		cost: { input: 0.2, output: 1.5, cacheRead: 0.2, cacheWrite: 0 },
		contextWindow: 1048576,
		maxTokens: 65536,
	},
	{
		id: "gemini-3.1-pro",
		name: "Gemini 3.1 Pro",
		api: ANTIGRAVITY_API,
		provider: ANTIGRAVITY_PROVIDER_ID,
		baseUrl: ANTIGRAVITY_DEFAULT_ENDPOINT,
		reasoning: true,
		thinkingLevelMap: { low: "low", high: "high" },
		input: ["text", "image"],
		cost: { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 2.375 },
		contextWindow: 1048576,
		maxTokens: 65535,
	},
	{
		id: "gemini-3.1-flash-lite",
		name: "Gemini 3.1 Flash Lite",
		api: ANTIGRAVITY_API,
		provider: ANTIGRAVITY_PROVIDER_ID,
		baseUrl: ANTIGRAVITY_DEFAULT_ENDPOINT,
		reasoning: true,
		thinkingLevelMap: { low: "low", medium: "medium", high: "high" },
		input: ["text", "image"],
		cost: { input: 0.2, output: 1.5, cacheRead: 0.2, cacheWrite: 0 },
		contextWindow: 1048576,
		maxTokens: 65536,
	},
	{
		id: "gemini-3-flash",
		name: "Gemini 3 Flash",
		api: ANTIGRAVITY_API,
		provider: ANTIGRAVITY_PROVIDER_ID,
		baseUrl: ANTIGRAVITY_DEFAULT_ENDPOINT,
		reasoning: true,
		thinkingLevelMap: { low: "low", medium: "medium", high: "high" },
		input: ["text", "image"],
		cost: { input: 0.5, output: 3, cacheRead: 0.5, cacheWrite: 0 },
		contextWindow: 1048576,
		maxTokens: 65536,
	},
	{
		id: "gemini-2.5-pro",
		name: "Gemini 2.5 Pro",
		api: ANTIGRAVITY_API,
		provider: ANTIGRAVITY_PROVIDER_ID,
		baseUrl: ANTIGRAVITY_DEFAULT_ENDPOINT,
		reasoning: true,
		thinkingLevelMap: { low: "low", medium: "medium", high: "high" },
		input: ["text", "image"],
		cost: { input: 1.25, output: 10, cacheRead: 0.3, cacheWrite: 0 },
		contextWindow: 1048576,
		maxTokens: 65536,
	},
	{
		id: "gemini-2.5-flash",
		name: "Gemini 2.5 Flash",
		api: ANTIGRAVITY_API,
		provider: ANTIGRAVITY_PROVIDER_ID,
		baseUrl: ANTIGRAVITY_DEFAULT_ENDPOINT,
		reasoning: true,
		thinkingLevelMap: { low: "low", medium: "medium", high: "high" },
		input: ["text", "image"],
		cost: { input: 0.3, output: 2.5, cacheRead: 0.075, cacheWrite: 0 },
		contextWindow: 1048576,
		maxTokens: 65536,
	},
	{
		id: "claude-opus-4-6",
		name: "Claude Opus 4.6",
		api: ANTIGRAVITY_API,
		provider: ANTIGRAVITY_PROVIDER_ID,
		baseUrl: ANTIGRAVITY_DEFAULT_ENDPOINT,
		reasoning: true,
		thinkingLevelMap: { low: "low", medium: "medium", high: "high" },
		input: ["text", "image"],
		cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
		contextWindow: 200000,
		maxTokens: 64000,
	},
	{
		id: "claude-sonnet-4-6",
		name: "Claude Sonnet 4.6",
		api: ANTIGRAVITY_API,
		provider: ANTIGRAVITY_PROVIDER_ID,
		baseUrl: ANTIGRAVITY_DEFAULT_ENDPOINT,
		reasoning: true,
		thinkingLevelMap: { low: "low", medium: "medium", high: "high" },
		input: ["text", "image"],
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		contextWindow: 200000,
		maxTokens: 64000,
	},
];

function getAntigravityRequestModelId(modelId, level = "off") {
	const route = DEFAULT_ANTIGRAVITY_ROUTING[modelId];
	if (route) return route[level] || route.medium || route.low || route.off || modelId;
	return modelId;
}

function mapDiscoveredModelsToCatalogIds(rawModelIds) {
	if (!Array.isArray(rawModelIds) || rawModelIds.length === 0) return undefined;
	const rawSet = new Set(rawModelIds.filter((id) => typeof id === "string" && id.trim()).map((id) => id.trim()));
	if (rawSet.size === 0) return undefined;
	const matched = new Set();
	for (const model of ANTIGRAVITY_MODELS) {
		if (rawSet.has(model.id)) {
			matched.add(model.id);
			continue;
		}
		const route = DEFAULT_ANTIGRAVITY_ROUTING[model.id];
		if (route && Object.values(route).some((wireId) => rawSet.has(wireId))) {
			matched.add(model.id);
		}
	}
	for (const rawId of rawSet) matched.add(rawId);
	return [...matched];
}

function stableProjectId(seed) {
	const digest = createHash("sha256").update(`antigravity-project:${seed || "default"}`).digest();
	const adjectives = ["useful", "bright", "swift", "calm", "bold", "keen", "warm", "wise"];
	const nouns = ["zeal", "wave", "spark", "core", "peak", "beam", "node", "flux"];
	const adj = adjectives[digest[0] % adjectives.length];
	const noun = nouns[digest[1] % nouns.length];
	const suffix = digest.subarray(2, 5).toString("hex").slice(0, 5);
	return `${adj}-${noun}-${suffix}`;
}

function antigravityHeaders(token, extraHeaders) {
	const headers = {
		Authorization: `Bearer ${token}`,
		"Content-Type": "application/json",
		Accept: "text/event-stream",
		"User-Agent": `antigravity/${ANTIGRAVITY_VERSION} darwin/arm64`,
		"X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
	};
	if (extraHeaders && typeof extraHeaders === "object") {
		for (const [k, v] of Object.entries(extraHeaders)) {
			if (k.toLowerCase() === "x-antigravity-project") continue;
			if (v === null) delete headers[k];
			else if (typeof v === "string") headers[k] = v;
		}
	}
	return headers;
}

async function discoverProjectAndModels(token, fetchFn = globalThis.fetch, signal) {
	let projectId;
	let availableModelIds;
	try {
		const loadRes = await fetchFn(`${ANTIGRAVITY_DEFAULT_ENDPOINT}/v1internal:loadCodeAssist`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
				"User-Agent": `antigravity/${ANTIGRAVITY_VERSION} darwin/arm64`,
			},
			body: JSON.stringify({
				metadata: {
					ideType: "ANTIGRAVITY",
					platform: "PLATFORM_UNSPECIFIED",
					pluginType: "GEMINI",
				},
			}),
			signal,
		});
		if (loadRes.ok) {
			const data = await loadRes.json();
			if (typeof data?.cloudaicompanionProject === "string" && data.cloudaicompanionProject.trim()) {
				projectId = data.cloudaicompanionProject.trim();
			} else if (typeof data?.cloudaicompanionProject?.id === "string" && data.cloudaicompanionProject.id.trim()) {
				projectId = data.cloudaicompanionProject.id.trim();
			}
		}
	} catch {
		// Fall back to deterministic project ID if discovery fails or is offline
	}
	if (!projectId) projectId = stableProjectId(token);

	try {
		const modelsRes = await fetchFn(`${ANTIGRAVITY_DEFAULT_ENDPOINT}/v1internal:fetchAvailableModels`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
				"User-Agent": `antigravity/${ANTIGRAVITY_VERSION} darwin/arm64`,
			},
			body: JSON.stringify({ project: projectId }),
			signal,
		});
		if (modelsRes.ok) {
			const data = await modelsRes.json();
			if (data?.models && typeof data.models === "object") {
				availableModelIds = mapDiscoveredModelsToCatalogIds(Object.keys(data.models));
			}
		}
	} catch {
		// Keep full static catalog if model discovery fails
	}

	return { projectId, availableModelIds };
}

function generatePKCE() {
	const verifier = randomBytes(32).toString("base64url");
	const challenge = createHash("sha256").update(verifier).digest("base64url");
	const state = randomBytes(16).toString("hex");
	return { verifier, challenge, state };
}

function buildAuthUrl(challenge, state) {
	const params = new URLSearchParams({
		client_id: ANTIGRAVITY_CLIENT_ID,
		response_type: "code",
		redirect_uri: ANTIGRAVITY_REDIRECT_URI,
		scope: ANTIGRAVITY_SCOPES.join(" "),
		code_challenge: challenge,
		code_challenge_method: "S256",
		state,
		access_type: "offline",
		prompt: "consent",
	});
	return `${ANTIGRAVITY_AUTH_URL}?${params.toString()}`;
}

function parseAuthorizationInput(input) {
	const value = String(input ?? "").trim();
	if (!value) return {};
	try {
		const url = new URL(value);
		return {
			code: url.searchParams.get("code") ?? undefined,
			state: url.searchParams.get("state") ?? undefined,
			error: url.searchParams.get("error") ?? undefined,
		};
	} catch {
		// Not a URL, treat as raw code or code#state
	}
	if (value.includes("#")) {
		const [code, state] = value.split("#", 2);
		return { code: code?.trim() || undefined, state: state?.trim() || undefined };
	}
	if (value.includes("code=")) {
		const params = new URLSearchParams(value.startsWith("?") ? value.slice(1) : value);
		return {
			code: params.get("code") ?? undefined,
			state: params.get("state") ?? undefined,
			error: params.get("error") ?? undefined,
		};
	}
	return { code: value };
}

function startLoopbackCallbackServer(expectedState) {
	let closeServer = () => {};
	const callbackPromise = new Promise((resolve) => {
		let settled = false;
		const finish = (value) => {
			if (settled) return;
			settled = true;
			try { server.close(); } catch { /* ignore */ }
			resolve(value);
		};
		const server = http.createServer((req, res) => {
			try {
				const url = new URL(req.url || "", `http://127.0.0.1:${ANTIGRAVITY_REDIRECT_PORT}`);
				if (url.pathname !== "/oauth-callback") {
					res.statusCode = 404;
					res.end("Not found");
					return;
				}
				const code = url.searchParams.get("code");
				const state = url.searchParams.get("state");
				const error = url.searchParams.get("error");
				res.statusCode = error || !code ? 400 : 200;
				res.setHeader("Content-Type", "text/html; charset=utf-8");
				res.end(
					error || !code
						? "<html><body><h1>Authentication failed</h1><p>You can close this window.</p></body></html>"
						: "<html><body><h1>Antigravity authentication complete</h1><p>You can close this tab and return to Learnharness.</p></body></html>",
				);
				finish({ code: code || undefined, state: state || undefined, error: error || undefined });
			} catch {
				res.statusCode = 500;
				res.end("Internal error");
			}
		});
		closeServer = () => {
			try { server.close(); } catch { /* ignore */ }
		};
		server.on("error", () => {
			// Port busy or loopback unavailable; manual prompt will still work
		});
		server.listen(ANTIGRAVITY_REDIRECT_PORT, "127.0.0.1", () => {
			server.unref();
		});
		server.unref();
	});
	return { callbackPromise, closeServer };
}

async function exchangeCodeForTokens(code, verifier, fetchFn = globalThis.fetch, signal) {
	const response = await fetchFn(ANTIGRAVITY_TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id: ANTIGRAVITY_CLIENT_ID,
			client_secret: ANTIGRAVITY_CLIENT_SECRET,
			code,
			grant_type: "authorization_code",
			redirect_uri: ANTIGRAVITY_REDIRECT_URI,
			code_verifier: verifier,
		}),
		signal,
	});
	if (!response.ok) {
		const errorText = await response.text();
		throw new Error(`Antigravity token exchange failed (${response.status}): ${errorText}`);
	}
	const data = await response.json();
	if (!data?.access_token) throw new Error("Antigravity token response missing access_token");
	return {
		access: String(data.access_token).trim(),
		refresh: String(data.refresh_token || "").trim(),
		expires: Date.now() + (Number(data.expires_in) || 3600) * 1000 - 5 * 60 * 1000,
	};
}

async function loginAntigravity(interaction, options = {}) {
	const fetchFn = options.fetch || globalThis.fetch;
	const { verifier, challenge, state } = generatePKCE();
	const authUrl = buildAuthUrl(challenge, state);
	const { callbackPromise, closeServer } = options.disableLoopback
		? { callbackPromise: new Promise(() => {}), closeServer: () => {} }
		: startLoopbackCallbackServer(state);

	try {
		interaction.notify({
			type: "auth_url",
			url: authUrl,
			instructions: "Complete Google sign-in in your browser. If the localhost redirect does not complete automatically, paste the callback URL or authorization code.",
		});

		const promptPromise = interaction.prompt({
			type: "manual_code",
			message: "Paste the callback URL or authorization code from Google sign-in",
			placeholder: `${ANTIGRAVITY_REDIRECT_URI}?code=...&state=...`,
		}).then((raw) => parseAuthorizationInput(raw));

		const result = await Promise.race([callbackPromise, promptPromise]);
		if (result?.error) {
			throw new Error(`Antigravity OAuth failed: ${result.error}`);
		}
		if (result?.state && result.state !== state) {
			throw new Error("Antigravity OAuth state mismatch");
		}
		if (!result?.code) {
			throw new Error("Missing Antigravity OAuth authorization code");
		}

		const tokens = await exchangeCodeForTokens(result.code, verifier, fetchFn, interaction.signal);
		if (!tokens.refresh) {
			throw new Error("Antigravity OAuth did not return a refresh token");
		}
		const discovered = await discoverProjectAndModels(tokens.access, fetchFn, interaction.signal);
		return {
			type: "oauth",
			access: tokens.access,
			refresh: tokens.refresh,
			expires: tokens.expires,
			projectId: discovered.projectId,
		};
	} finally {
		closeServer();
	}
}

async function refreshAntigravityToken(credential, signal, options = {}) {
	const fetchFn = options.fetch || globalThis.fetch;
	const response = await fetchFn(ANTIGRAVITY_TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id: ANTIGRAVITY_CLIENT_ID,
			client_secret: ANTIGRAVITY_CLIENT_SECRET,
			refresh_token: credential.refresh,
			grant_type: "refresh_token",
		}),
		signal,
	});
	if (!response.ok) {
		const errorText = await response.text();
		throw new Error(`Antigravity token refresh failed (${response.status}): ${errorText}`);
	}
	const data = await response.json();
	if (!data?.access_token) throw new Error("Antigravity token refresh missing access_token");
	const access = String(data.access_token).trim();
	const refresh = String(data.refresh_token || credential.refresh).trim();
	const expires = Date.now() + (Number(data.expires_in) || 3600) * 1000 - 5 * 60 * 1000;
	return {
		type: "oauth",
		access,
		refresh,
		expires,
		...(credential.projectId ? { projectId: credential.projectId } : {}),
		...(Array.isArray(credential.availableModelIds) ? { availableModelIds: credential.availableModelIds } : {}),
	};
}

function toAntigravityAuth(credential) {
	return {
		apiKey: credential.access,
		baseUrl: ANTIGRAVITY_DEFAULT_ENDPOINT,
		...(credential.projectId ? { headers: { "x-antigravity-project": credential.projectId } } : {}),
	};
}

function parseApiKey(rawKey) {
	if (!rawKey || typeof rawKey !== "string" || !rawKey.trim()) {
		throw new Error("No Antigravity credentials configured. Connect your Antigravity subscription or set ANTIGRAVITY_API_KEY.");
	}
	const trimmed = rawKey.trim();
	if (trimmed.startsWith("{")) {
		try {
			const parsed = JSON.parse(trimmed);
			const token = String(parsed.token || parsed.access || parsed.apiKey || "").trim();
			if (token) {
				const projectId = typeof parsed.projectId === "string" && parsed.projectId.trim() ? parsed.projectId.trim() : undefined;
				return { token, projectId };
			}
		} catch {
			// Fall back to raw string
		}
	}
	return { token: trimmed };
}

class SimpleEventStream {
	constructor() {
		this.queue = [];
		this.waiting = [];
		this.done = false;
		this.startedAt = Date.now();
		this.startedAtMonotonic = performance.now();
		this.finalResultPromise = new Promise((resolve) => {
			this.resolveFinalResult = resolve;
		});
	}
	#time(message) {
		if (!message || this.done || message.durationMs !== undefined || message.timestamp < this.startedAt) return;
		message.durationMs = Math.max(0, Math.round(performance.now() - this.startedAtMonotonic));
	}
	push(event) {
		if (this.done) return;
		if (event.type === "done") this.#time(event.message);
		else if (event.type === "error") this.#time(event.error);
		if (event.type === "done" || event.type === "error") {
			this.done = true;
			this.resolveFinalResult(event.type === "done" ? event.message : event.error);
		}
		const waiter = this.waiting.shift();
		if (waiter) waiter({ value: event, done: false });
		else this.queue.push(event);
	}
	end(result) {
		if (result !== undefined) {
			this.#time(result);
			this.resolveFinalResult(result);
		}
		this.done = true;
		while (this.waiting.length > 0) {
			const waiter = this.waiting.shift();
			waiter({ value: undefined, done: true });
		}
	}
	async *[Symbol.asyncIterator]() {
		while (true) {
			if (this.queue.length > 0) {
				yield this.queue.shift();
			} else if (this.done) {
				return;
			} else {
				const next = await new Promise((resolve) => this.waiting.push(resolve));
				if (next.done) return;
				yield next.value;
			}
		}
	}
	result() {
		return this.finalResultPromise;
	}
}

function extractSystemPrompt(context) {
	const parts = [];
	if (typeof context?.systemPrompt === "string" && context.systemPrompt.trim()) {
		parts.push(context.systemPrompt.trim());
	}
	for (const msg of context?.messages ?? []) {
		if (msg?.role !== "system") continue;
		const content = msg.systemPrompt ?? msg.content;
		if (typeof content === "string" && content.trim()) {
			parts.push(content.trim());
		} else if (Array.isArray(content)) {
			for (const block of content) {
				if (typeof block === "string" && block.trim()) parts.push(block.trim());
				else if (block && typeof block.text === "string" && block.text.trim()) parts.push(block.text.trim());
			}
		}
	}
	return parts.join("\n\n");
}

function extractTools(context) {
	const byName = new Map();
	for (const tool of context?.tools ?? []) {
		if (tool && typeof tool.name === "string") byName.set(tool.name, tool);
	}
	for (const msg of context?.messages ?? []) {
		if (msg?.role !== "system") continue;
		for (const removed of msg.toolsRemoved ?? []) {
			if (removed?.name) byName.delete(removed.name);
		}
		for (const added of [...(msg.toolsAdded ?? []), ...(msg.tools ?? [])]) {
			if (added && typeof added.name === "string") byName.set(added.name, added);
		}
	}
	return [...byName.values()];
}

function convertMessagesToContents(context, model) {
	const contents = [];
	const isClaudeModel = Boolean(model?.id?.startsWith("claude-"));
	const pushTurn = (role, parts) => {
		if (!parts || parts.length === 0) return;
		const last = contents[contents.length - 1];
		if (last && last.role === role) last.parts.push(...parts);
		else contents.push({ role, parts });
	};

	for (const msg of context?.messages ?? []) {
		if (!msg || msg.role === "system") continue;
		if (msg.role === "user") {
			const parts = [];
			if (typeof msg.content === "string") {
				if (msg.content.trim()) parts.push({ text: msg.content });
			} else if (Array.isArray(msg.content)) {
				for (const block of msg.content) {
					if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
						parts.push({ text: block.text });
					} else if (block?.type === "image") {
						const rawData = block.data || block.source?.data;
						const mimeType = block.mimeType || block.mediaType || block.source?.mediaType || "image/png";
						if (typeof rawData === "string" && rawData.trim()) {
							const match = rawData.match(/^data:([^;]+);base64,(.+)$/s);
							parts.push({
								inlineData: {
									mimeType: match ? match[1] : mimeType,
									data: (match ? match[2] : rawData).trim(),
								},
							});
						}
					}
				}
			}
			pushTurn("user", parts);
		} else if (msg.role === "assistant") {
			if (msg.stopReason === "error" || msg.stopReason === "aborted") continue;
			const isSameModel = (!msg.provider || !model?.provider || msg.provider === model.provider) &&
				(!msg.model || !model?.id || msg.model === model.id);
			const parts = [];
			for (const block of Array.isArray(msg.content) ? msg.content : []) {
				if (block?.type === "thinking" && typeof block.thinking === "string" && block.thinking.trim()) {
					if (!isSameModel) continue;
					if (isClaudeModel && !block.thinkingSignature) continue;
					parts.push({
						thought: true,
						text: block.thinking,
						...(block.thinkingSignature ? { thoughtSignature: block.thinkingSignature } : {}),
					});
				} else if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
					parts.push({
						text: block.text,
						...(isSameModel && block.textSignature ? { thoughtSignature: block.textSignature } : {}),
					});
				} else if (block?.type === "toolCall" && typeof block.name === "string") {
					parts.push({
						functionCall: {
							name: block.name,
							args: block.arguments && typeof block.arguments === "object" ? block.arguments : {},
							...(block.id ? { id: String(block.id) } : {}),
						},
						...(isSameModel && block.thoughtSignature ? { thoughtSignature: block.thoughtSignature } : {}),
					});
				}
			}
			pushTurn("model", parts);
		} else if (msg.role === "toolResult") {
			const text = Array.isArray(msg.content)
				? msg.content.filter((c) => c?.type === "text" && typeof c.text === "string").map((c) => c.text).join("\n")
				: typeof msg.content === "string" ? msg.content : "";
			const responseText = text || (msg.isError ? "Tool failed" : "");
			pushTurn("user", [
				{
					functionResponse: {
						name: msg.toolName || "tool",
						response: msg.isError ? { error: responseText } : { output: responseText },
						...(msg.toolCallId ? { id: String(msg.toolCallId) } : {}),
					},
				},
			]);
		}
	}

	if (contents.length === 0) {
		contents.push({ role: "user", parts: [{ text: CONTINUATION_TEXT }] });
	} else if (contents[contents.length - 1].role === "model") {
		pushTurn("user", [{ text: CONTINUATION_TEXT }]);
	}
	return contents;
}

function buildThinkingConfig(runtimeModel, level) {
	if (!level || level === "off") return undefined;
	if (runtimeModel.startsWith("gemini-3") || runtimeModel.includes("-tiered")) {
		const mapped = level === "minimal" ? "MINIMAL" : level === "low" ? "LOW" : level === "high" || level === "xhigh" ? "HIGH" : "MEDIUM";
		return { includeThoughts: true, thinkingLevel: mapped };
	}
	if (runtimeModel.startsWith("gemini-2.5")) {
		const budget = level === "low" || level === "minimal" ? 4096 : level === "high" || level === "xhigh" ? 24576 : 8192;
		return { includeThoughts: true, thinkingBudget: budget };
	}
	return undefined;
}

function buildAntigravityPayload(model, context, projectId, options, runtimeModel) {
	const systemPrompt = extractSystemPrompt(context);
	const systemParts = systemPrompt
		? [{ text: systemPrompt }]
		: [{ text: ANTIGRAVITY_SYSTEM_INSTRUCTION }];
	const contents = convertMessagesToContents(context, model);
	const declaredTools = extractTools(context);
	const thinkingConfig = buildThinkingConfig(runtimeModel, options?.reasoning);

	const request = {
		contents,
		systemInstruction: {
			role: "user",
			parts: systemParts,
		},
		generationConfig: {
			maxOutputTokens: options?.maxTokens ? Math.min(options.maxTokens, model.maxTokens || 65536) : (model.maxTokens || 65536),
			...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
			...(thinkingConfig ? { thinkingConfig } : {}),
		},
	};

	if (declaredTools.length > 0) {
		request.tools = [
			{
				functionDeclarations: declaredTools.map((tool) => ({
					name: tool.name,
					description: tool.description || "",
					parametersJsonSchema: tool.parameters || { type: "object", properties: {} },
				})),
			},
		];
	}

	return {
		project: projectId,
		model: runtimeModel,
		request,
		requestType: "agent",
		userAgent: "antigravity",
		requestId: `agent/${randomUUID()}/${Date.now()}/${randomUUID()}/${Math.max(1, contents.length)}`,
	};
}

function applyCost(model, usage) {
	const rates = model?.cost;
	if (!rates) {
		usage.cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
		return;
	}
	const input = (usage.input / 1_000_000) * (rates.input || 0);
	const output = (usage.output / 1_000_000) * (rates.output || 0);
	const cacheRead = (usage.cacheRead / 1_000_000) * (rates.cacheRead || 0);
	const cacheWrite = (usage.cacheWrite / 1_000_000) * (rates.cacheWrite || 0);
	usage.cost = {
		input,
		output,
		cacheRead,
		cacheWrite,
		total: input + output + cacheRead + cacheWrite,
	};
}

async function parseAntigravitySSE(response, stream, output, model) {
	if (!response.body) throw new Error("Antigravity response body is empty");
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let started = false;
	let currentBlock = null;
	let sawContentOrFinish = false;

	const blocks = output.content;
	const blockIndex = () => blocks.length - 1;

	const ensureStarted = () => {
		if (!started) {
			stream.push({ type: "start", partial: output });
			started = true;
		}
	};

	const finishCurrent = () => {
		if (!currentBlock) return;
		if (currentBlock.type === "text") {
			stream.push({ type: "text_end", contentIndex: blockIndex(), content: currentBlock.text, partial: output });
		} else if (currentBlock.type === "thinking") {
			stream.push({ type: "thinking_end", contentIndex: blockIndex(), content: currentBlock.thinking, partial: output });
		}
		currentBlock = null;
	};

	const handleLine = (line) => {
		if (!line.startsWith("data:")) return;
		const rawJson = line.slice(5).trim();
		if (!rawJson || rawJson === "[DONE]") return;
		let chunk;
		try {
			chunk = JSON.parse(rawJson);
		} catch {
			return;
		}
		if (chunk.error) {
			const msg = chunk.error.message || JSON.stringify(chunk.error);
			throw new Error(`Antigravity stream error: ${msg}`);
		}
		const responseData = chunk.response || chunk;
		const candidate = responseData.candidates?.[0];
		for (const part of candidate?.content?.parts || []) {
			if (part.thoughtSignature && !part.functionCall && (!part.text || part.thought === true) && currentBlock?.type === "thinking") {
				sawContentOrFinish = true;
				currentBlock.thinkingSignature = part.thoughtSignature;
				if (!part.text) continue;
			}
			if (typeof part.text === "string") {
				if (part.text === "" && !part.thought && !part.thoughtSignature) {
					sawContentOrFinish = true;
					continue;
				}
				sawContentOrFinish = true;
				const isThinking = part.thought === true;
				const nextType = isThinking ? "thinking" : "text";
				if (!currentBlock || currentBlock.type !== nextType) {
					finishCurrent();
					currentBlock = isThinking
						? { type: "thinking", thinking: "" }
						: { type: "text", text: "" };
					blocks.push(currentBlock);
					ensureStarted();
					stream.push({
						type: isThinking ? "thinking_start" : "text_start",
						contentIndex: blockIndex(),
						partial: output,
					});
				}
				if (isThinking) {
					currentBlock.thinking += part.text;
					if (part.thoughtSignature) currentBlock.thinkingSignature = part.thoughtSignature;
					stream.push({ type: "thinking_delta", contentIndex: blockIndex(), delta: part.text, partial: output });
				} else {
					currentBlock.text += part.text;
					if (part.thoughtSignature) currentBlock.textSignature = part.thoughtSignature;
					stream.push({ type: "text_delta", contentIndex: blockIndex(), delta: part.text, partial: output });
				}
			}
			if (part.functionCall) {
				sawContentOrFinish = true;
				finishCurrent();
				const toolCall = {
					type: "toolCall",
					id: part.functionCall.id ? String(part.functionCall.id) : `call_${randomUUID().slice(0, 8)}`,
					name: String(part.functionCall.name || ""),
					arguments: part.functionCall.args && typeof part.functionCall.args === "object" ? part.functionCall.args : {},
					...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}),
				};
				blocks.push(toolCall);
				ensureStarted();
				stream.push({ type: "toolcall_start", contentIndex: blockIndex(), partial: output });
				stream.push({
					type: "toolcall_delta",
					contentIndex: blockIndex(),
					delta: JSON.stringify(toolCall.arguments),
					partial: output,
				});
				stream.push({ type: "toolcall_end", contentIndex: blockIndex(), toolCall, partial: output });
			}
		}

		if (candidate?.finishReason) {
			sawContentOrFinish = true;
			output.rawStopReason = candidate.finishReason;
			if (blocks.some((b) => b.type === "toolCall")) output.stopReason = "toolUse";
			else if (candidate.finishReason === "MAX_TOKENS") output.stopReason = "length";
			else if (candidate.finishReason === "STOP") output.stopReason = "stop";
			else output.stopReason = "stop";
		}

		if (responseData.usageMetadata) {
			const prompt = Number(responseData.usageMetadata.promptTokenCount) || 0;
			const cacheRead = Number(responseData.usageMetadata.cachedContentTokenCount) || 0;
			const thoughts = Number(responseData.usageMetadata.thoughtsTokenCount) || 0;
			const candidates = Number(responseData.usageMetadata.candidatesTokenCount) || 0;
			output.usage.input = Math.max(0, prompt - cacheRead);
			output.usage.output = candidates + thoughts;
			output.usage.cacheRead = cacheRead;
			output.usage.totalTokens = Number(responseData.usageMetadata.totalTokenCount) || (prompt + candidates + thoughts);
			applyCost(model, output.usage);
		}
	};

	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		if (!(value instanceof Uint8Array)) continue;
		buffer += decoder.decode(value, { stream: true });
		let idx;
		while ((idx = buffer.indexOf("\n")) !== -1) {
			const line = buffer.slice(0, idx).replace(/\r$/, "");
			buffer = buffer.slice(idx + 1);
			handleLine(line);
		}
	}
	buffer += decoder.decode();
	if (buffer.trim()) handleLine(buffer.replace(/\r$/, ""));
	finishCurrent();
	if (!sawContentOrFinish) {
		throw new Error("Antigravity stream ended without content");
	}
}

function streamAntigravitySimple(model, context, options = {}) {
	const stream = new SimpleEventStream();
	const output = {
		role: "assistant",
		api: model.api || ANTIGRAVITY_API,
		provider: model.provider || ANTIGRAVITY_PROVIDER_ID,
		model: model.id,
		content: [],
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};

	void (async () => {
		try {
			const rawApiKey = options.apiKey || options.env?.ANTIGRAVITY_API_KEY || process.env.ANTIGRAVITY_API_KEY;
			const creds = parseApiKey(rawApiKey);
			const headerProject = options.headers?.["x-antigravity-project"] || model.headers?.["x-antigravity-project"];
			const projectId = creds.projectId || headerProject || process.env.ANTIGRAVITY_PROJECT_ID || stableProjectId(creds.token);
			const level = options.reasoning || "off";
			const runtimeModel = getAntigravityRequestModelId(model.id, level);
			const basePayload = buildAntigravityPayload(model, context, projectId, options, runtimeModel);
			const finalPayload = options.onPayload ? ((await options.onPayload(basePayload, model)) ?? basePayload) : basePayload;

			const fetchFn = options.fetch || globalThis.fetch;
			const baseUrl = (model.baseUrl || ANTIGRAVITY_DEFAULT_ENDPOINT).replace(/\/+$/, "");
			const isDirectGeminiApiKey = creds.token.startsWith("AIza") && !headerProject && model.id.startsWith("gemini-");
			const requestUrl = isDirectGeminiApiKey
				? `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model.id)}:streamGenerateContent?alt=sse`
				: `${baseUrl}/v1internal:streamGenerateContent?alt=sse`;
			const headers = isDirectGeminiApiKey
				? {
					"Content-Type": "application/json",
					Accept: "text/event-stream",
					"x-goog-api-key": creds.token,
				}
				: antigravityHeaders(creds.token, { ...model.headers, ...options.headers });
			const requestBody = isDirectGeminiApiKey && finalPayload && typeof finalPayload === "object" && finalPayload.request
				? JSON.stringify(finalPayload.request)
				: JSON.stringify(finalPayload);

			const response = await fetchFn(requestUrl, {
				method: "POST",
				headers,
				body: requestBody,
				signal: options.signal,
			});

			if (options.onResponse) {
				const respHeaders = {};
				response.headers?.forEach?.((v, k) => { respHeaders[k] = v; });
				await options.onResponse({ status: response.status, headers: respHeaders }, model);
			}

			if (!response.ok) {
				const errText = await response.text();
				throw new Error(`Antigravity API error (${response.status}): ${errText.slice(0, 500)}`);
			}

			await parseAntigravitySSE(response, stream, output, model);
			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			const aborted = Boolean(options.signal?.aborted);
			output.stopReason = aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : String(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
}

function cloneAntigravityModels() {
	return ANTIGRAVITY_MODELS.map((m) => ({
		...m,
		input: [...m.input],
		cost: { ...m.cost },
		...(m.thinkingLevelMap ? { thinkingLevelMap: { ...m.thinkingLevelMap } } : {}),
	}));
}

function filterAntigravityModels(models, credential) {
	if (credential?.type !== "oauth") return models;
	const availableModelIds = credential.availableModelIds;
	if (!Array.isArray(availableModelIds) || !availableModelIds.every((id) => typeof id === "string")) {
		return models;
	}
	const available = new Set(availableModelIds);
	return models.filter((model) => available.has(model.id));
}

/**
 * @param {{ fetch?: typeof globalThis.fetch; disableLoopback?: boolean }} [options]
 * @returns {import("@earendil-works/pi-ai").Provider}
 */
function antigravityProvider(options = {}) {
	return /** @type {import("@earendil-works/pi-ai").Provider} */ ({
		id: ANTIGRAVITY_PROVIDER_ID,
		name: "Antigravity",
		baseUrl: ANTIGRAVITY_DEFAULT_ENDPOINT,
		models: cloneAntigravityModels(),
		getModels: () => cloneAntigravityModels(),
		getAllModels: () => cloneAntigravityModels(),
		filterModels: filterAntigravityModels,
		filterAllModels: filterAntigravityModels,
		auth: {
			oauth: {
				name: "Google Antigravity",
				isSubscription: true,
				login: (interaction) => loginAntigravity(interaction, options),
				refresh: (credential, signal) => refreshAntigravityToken(credential, signal, options),
				toAuth: async (credential) => toAntigravityAuth(credential),
			},
			apiKey: {
				name: "Antigravity API key",
				login: async (interaction) => {
					interaction.signal?.throwIfAborted?.();
					const key = await interaction.prompt({ type: "secret", message: "Enter Antigravity API key" });
					interaction.signal?.throwIfAborted?.();
					return { type: "api_key", key };
				},
				resolve: async ({ ctx, credential, signal }) => {
					signal?.throwIfAborted?.();
					if (credential?.key) {
						return { auth: { apiKey: credential.key }, env: credential.env, source: "stored credential" };
					}
					const value = ctx?.env ? await ctx.env("ANTIGRAVITY_API_KEY") : process.env.ANTIGRAVITY_API_KEY;
					signal?.throwIfAborted?.();
					if (value) {
						return { auth: { apiKey: value }, source: "ANTIGRAVITY_API_KEY" };
					}
					return undefined;
				},
			},
		},
		stream: (model, context, streamOptions) => streamAntigravitySimple(model, context, streamOptions),
		streamSimple: (model, context, streamOptions) => streamAntigravitySimple(model, context, streamOptions),
	});
}

module.exports = {
	ANTIGRAVITY_PROVIDER_ID,
	ANTIGRAVITY_API,
	ANTIGRAVITY_DEFAULT_ENDPOINT,
	ANTIGRAVITY_FALLBACK_ENDPOINT,
	ANTIGRAVITY_ALLOWED_ORIGINS,
	ANTIGRAVITY_MODELS,
	getAntigravityRequestModelId,
	mapDiscoveredModelsToCatalogIds,
	stableProjectId,
	antigravityProvider,
};

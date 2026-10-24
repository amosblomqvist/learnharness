/**
 * The global Pi setup: the user's Pi config complements the app's own
 * providers and models. Pinned:
 *  - on by default, but only with a pi CLI; the settings switch turns it off;
 *  - the directory setting accepts Pi's home (~/.pi → agent/) or the agent dir;
 *  - the app's own providers win over Pi's, for keys and logins alike;
 *  - every Pi provider is inherited — api keys, OAuth logins (including
 *    login-only builtins), and models.json custom providers;
 *  - logins are refreshed by Pi (a fake CLI here, via PI_BIN), never by the
 *    app, and Pi's files are never written;
 *  - Pi config values: literal and $VAR templates resolve, !commands don't;
 *  - edits to Pi's files apply without a restart.
 *
 * LH_DATA_DIR + LH_AUTH_FILE + PI_BIN point at fresh tmp paths BEFORE the
 * imports (module-load bound seams). Throwaway values only.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

for (const name of ["ZAI_API_KEY", "MISTRAL_API_KEY", "OPENAI_API_KEY", "LH_IGNORE_ENV_KEYS", "PI_TEST_TEMPLATE_KEY", "PI_CODING_AGENT_DIR"]) {
	delete process.env[name];
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-pi-global-"));
const PI_HOME = path.join(TMP, "pi-home");
const PI_DIR = path.join(PI_HOME, "agent");
fs.mkdirSync(PI_DIR, { recursive: true });
process.env.LH_DATA_DIR = path.join(TMP, "data");
process.env.LH_AUTH_FILE = path.join(TMP, "auth.json");
fs.writeFileSync(process.env.LH_AUTH_FILE, JSON.stringify({ MISTRAL_API_KEY: "app-file-mistral-key" }));

const writePi = (name: string, value: unknown) => {
	fs.writeFileSync(path.join(PI_DIR, name), JSON.stringify(value));
	// Bump mtime past the cache's resolution even on fast rewrites.
	const t = new Date(Date.now() + Math.random() * 100000);
	fs.utimesSync(path.join(PI_DIR, name), t, t);
};

// A fake pi CLI standing in for Pi's own refresh: on
// `auth print-bearer-token --provider openai --min-expiry 10m` it rotates
// the openai login in Pi's auth.json (as Pi would, under its lock).
const REFRESH_LOG = path.join(TMP, "refreshes.log");
const FAKE_PI = path.join(TMP, "fake-pi.mjs");
fs.writeFileSync(
	FAKE_PI,
	`import fs from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
if (args.join(" ") !== "auth print-bearer-token --provider openai --min-expiry 10m") process.exit(2);
fs.appendFileSync(${JSON.stringify(REFRESH_LOG)}, "x");
const file = path.join(process.env.PI_CODING_AGENT_DIR, "auth.json");
const auth = JSON.parse(fs.readFileSync(file, "utf-8"));
auth.openai = { ...auth.openai, access: "refreshed-by-pi", expires: Date.now() + 3600_000 };
fs.writeFileSync(file, JSON.stringify(auth));
process.stdout.write("refreshed-by-pi\\n");
`,
);
process.env.PI_BIN = FAKE_PI;

writePi("auth.json", {
	zai: { type: "api_key", key: "pi-zai-key-123456" },
	mistral: { type: "api_key", key: "pi-mistral-loses" },
	openai: { type: "oauth", access: "expired-access", refresh: "r", expires: 0 },
	"github-copilot": { type: "oauth", access: "copilot-access", refresh: "r", expires: Date.now() + 3600_000 },
	acme: { type: "api_key", key: "pi-acme-auth-key" },
});
writePi("models.json", {
	providers: {
		acme: {
			baseUrl: "https://acme.example/v1",
			api: "openai-completions",
			apiKey: "models-json-loses",
			models: [{ id: "acme-1", reasoning: true, input: ["text", "image"], contextWindow: 1000, maxTokens: 100 }],
		},
		templ: {
			baseUrl: "https://templ.example/v1",
			api: "openai-completions",
			apiKey: "$PI_TEST_TEMPLATE_KEY",
			models: [{ id: "templ-1" }],
		},
		broken: { baseUrl: "https://x", api: "no-such-api", models: [{ id: "x" }] },
	},
});

const { settingsStore } = await import("../src/store/settings.ts");
const usePi = (pi: Record<string, unknown>) => settingsStore.writeSettings({ version: 1, pi });
usePi({ dir: PI_HOME }); // Pi's home; enabled by default

const { modelCatalog } = await import("../src/server/model-catalog.ts");
const { piModels } = await import("../src/agent/models.ts");
const { piSetupStatus, providerUsable, resolvePiConfigValue } = await import("../src/server/pi-global.ts");

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

describe("pi-global setup", () => {
	it("is on by default, reading Pi's agent dir under its home", () => {
		const status = piSetupStatus();
		assert.equal(status.available, true);
		assert.equal(status.enabled, true);
		assert.equal(status.resolvedDir, PI_DIR);
		assert.equal(status.found, true);
	});

	it("lists Pi's providers read-only, marking the ones the app overrides", () => {
		const byId = new Map(piSetupStatus().providers.map((p) => [p.id, p]));
		assert.deepEqual(
			[byId.get("zai")?.kind, byId.get("openai")?.kind, byId.get("acme")?.kind],
			["api_key", "login", "models"],
		);
		assert.equal(byId.get("mistral")?.overridden, true, "the app's own key wins");
		assert.equal(byId.get("zai")?.overridden, false);
		assert.equal(byId.has("broken"), false);
	});

	it("resolves Pi config values like Pi (literal, $VAR, no !commands)", () => {
		assert.equal(resolvePiConfigValue("literal-key"), "literal-key");
		assert.equal(resolvePiConfigValue("${A}-$B", { A: "x", B: "y" }), "x-y");
		assert.equal(resolvePiConfigValue("$MISSING", {}), undefined);
		assert.equal(resolvePiConfigValue("a$$b$!c", {}), "a$b!c");
		assert.equal(resolvePiConfigValue("!echo hi"), undefined);
	});
});

describe("pi-global providers", () => {
	it("inherits api-key providers, below the app's own", async () => {
		assert.equal((await piModels().getAuth("zai"))?.auth.apiKey, "pi-zai-key-123456");
		assert.equal((await piModels().getAuth("mistral"))?.auth.apiKey, "app-file-mistral-key");
		assert.equal(providerUsable("zai"), true);
	});

	it("federates custom providers into the picker, keyed by Pi", async () => {
		const catalog = modelCatalog();
		assert.deepEqual(catalog.providers.find((p) => p.id === "acme"), { id: "acme", envVar: null, keyPresent: true });
		assert.equal(catalog.providers.find((p) => p.id === "templ")?.keyPresent, false);
		assert.equal(catalog.providers.find((p) => p.id === "broken"), undefined);
		assert.equal(catalog.models.find((m) => m.provider === "acme")?.contextWindow, 1000);
		assert.equal(catalog.models.some((m) => m.provider === "templ"), false, "unkeyed provider stays out");
		assert.equal((await piModels().getAuth("acme"))?.auth.apiKey, "pi-acme-auth-key", "auth.json wins over models.json");
	});

	it("inherits login-only providers", () => {
		assert.equal(modelCatalog().providers.find((p) => p.id === "github-copilot")?.keyPresent, true);
	});

	it("has Pi refresh an expiring login — once for concurrent requests", async () => {
		assert.equal(providerUsable("openai"), true);
		const [a, b] = await Promise.all([piModels().getAuth("openai"), piModels().getAuth("openai")]);
		assert.equal(a?.auth.apiKey, "refreshed-by-pi");
		assert.equal(b?.auth.apiKey, "refreshed-by-pi");
		assert.equal(fs.readFileSync(REFRESH_LOG, "utf-8"), "x", "one pi run for concurrent requests");
		assert.equal((await piModels().getAuth("openai"))?.auth.apiKey, "refreshed-by-pi");
		assert.equal(fs.readFileSync(REFRESH_LOG, "utf-8"), "x", "a fresh login is not refreshed again");
	});

	it("lets an app key win over a Pi login", async () => {
		process.env.OPENAI_API_KEY = "sk-env-openai-key-1234";
		try {
			assert.equal((await piModels().getAuth("openai"))?.auth.apiKey, "sk-env-openai-key-1234");
		} finally {
			delete process.env.OPENAI_API_KEY;
		}
	});

	it("tracks Pi file edits live", async () => {
		process.env.PI_TEST_TEMPLATE_KEY = "templated-key-value";
		assert.equal(providerUsable("templ"), true);
		writePi("models.json", { providers: {} });
		assert.equal(piModels().getModel("acme", "acme-1"), undefined);
		writePi("auth.json", {});
		assert.equal(providerUsable("openai"), false, "login gone → OpenAI unkeyed");
		assert.equal(await piModels().getAuth("zai"), undefined);
	});
});

describe("pi-global switch", () => {
	it("turned off, Pi contributes nothing", async () => {
		writePi("auth.json", { zai: { type: "api_key", key: "pi-zai-key-123456" } });
		usePi({ enabled: false, dir: PI_DIR });
		assert.equal(piSetupStatus().enabled, false);
		assert.equal(await piModels().getAuth("zai"), undefined);
		assert.equal(providerUsable("zai"), false);
		usePi({ dir: PI_DIR });
		assert.equal((await piModels().getAuth("zai"))?.auth.apiKey, "pi-zai-key-123456", "an agent dir works as-is");
	});
});

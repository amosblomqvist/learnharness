import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import path from "node:path";

export function localAppEnv(root, port) {
	const profile = path.resolve(process.env.LH_APP_PROFILE ?? path.join(root, "data", "local-app"));
	mkdirSync(profile, { recursive: true });
	const host = process.env.LH_ACP_HOST_CONFIG ?? path.join(profile, "acp-host.json");
	if (!existsSync(host)) writeFileSync(host, "{}\n", { flag: "wx" });
	return {
		...process.env, HOSTNAME: "127.0.0.1", PORT: String(port), LH_LOCAL_APP: "1",
		LH_DATA_DIR: process.env.LH_DATA_DIR ?? path.join(profile, "data"),
		LH_AUTH_FILE: process.env.LH_AUTH_FILE ?? path.join(profile, "auth.json"),
		LH_ACP_HOST_CONFIG: path.resolve(host),
		// Explicit keys saved in the app still work. An inherited API key
		// cannot silently turn a subscription-only setup into API billing.
		LH_IGNORE_ENV_KEYS: process.env.LH_IGNORE_ENV_KEYS ?? "1",
	};
}

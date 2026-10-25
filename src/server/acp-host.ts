import { readFileSync } from "node:fs";
import { ACP_AGENTS, parseAcpConfig, type AcpAgentId, type AcpConnectionConfig } from "../core/acp.ts";

/** Set only by a local launcher which binds the server to loopback. Public
 * web deployments cannot start subscription processes through HTTP. */
export function localAcpEnabled(): boolean {
	return process.env.LH_LOCAL_APP === "1" && ["127.0.0.1", "::1", "localhost"].includes(process.env.HOSTNAME ?? "");
}

/** Executable authority comes from a host-owned file or installed adapters on
 * PATH, never a browser request or the HTTP-writable settings record. */
export function acpLaunchConfig(id: AcpAgentId): Pick<AcpConnectionConfig, "command" | "args"> {
	const agent = ACP_AGENTS.find((agent) => agent.id === id)!;
	const file = process.env.LH_ACP_HOST_CONFIG;
	if (!file) return { command: agent.command, args: [] };
	const host: unknown = JSON.parse(readFileSync(file, "utf8"));
	if (!host || typeof host !== "object" || Array.isArray(host)) throw new Error("ACP host configuration must be an object");
	const parsed = parseAcpConfig((host as Record<string, unknown>)[id] ?? {});
	if (!parsed.ok) throw new Error(`Invalid ${agent.label} host configuration: ${parsed.error}`);
	return { command: parsed.config.command ?? agent.command, args: parsed.config.args ?? [] };
}

export function localAcpRequest(request: Request): boolean {
	const url = new URL(request.url);
	// Next canonicalizes 127.0.0.1 to localhost in Request.url. Compare the
	// browser Origin with the addressed Host while requiring a loopback
	// hostname and the server URL's port. Host is an origin check, not auth:
	// trusted local mode/binding and host-only executable authority gate it.
	let addressed: URL;
	try { addressed = new URL(`${url.protocol}//${request.headers.get("host") ?? url.host}`); }
	catch { return false; }
	return localAcpEnabled() && addressed.protocol === "http:"
		&& ["127.0.0.1", "localhost", "[::1]"].includes(addressed.hostname)
		&& addressed.port === url.port && !addressed.username && !addressed.password
		&& addressed.pathname === "/" && !addressed.search && !addressed.hash
		&& request.headers.get("origin") === addressed.origin;
}

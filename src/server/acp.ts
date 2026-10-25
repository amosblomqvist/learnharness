import { ACP_AGENTS, acpAgentForProvider, type AcpAgentId, type AcpConnectionConfig, type AcpConnectionStatus } from "../core/acp.ts";
import { acpLaunchConfig, localAcpEnabled } from "./acp-host.ts";
import { stores } from "./stores.ts";
import { AcpClient } from "../agent/acp/client.ts";
import { createAcpEngine, closeAcpSessions, retireAcpSessions } from "../agent/acp/engine.ts";
import { discoverAcpModels } from "../agent/acp/catalog.ts";
import { piEngineForSpec, type PiEngine, type ResolvedModelSpec } from "../agent/models.ts";

const { settingsStore } = stores;

export class AcpConnectionUnavailable extends Error {}

export function acpConnections(): AcpConnectionStatus[] {
	const settings = settingsStore.readSettings()?.acp;
	return ACP_AGENTS.map(({ id }) => ({ id, config: localAcpEnabled() ? {
		...settings?.[id], ...acpLaunchConfig(id),
	} : { enabled: false } }));
}

type Tail<T extends unknown[]> = T extends [unknown, ...infer R] ? R : never;

/** The server resolves process configuration; the agent layer never reads stores. */
export function engineForSpec(spec: ResolvedModelSpec, ...options: Tail<Parameters<typeof piEngineForSpec>>): PiEngine {
	const agent = acpAgentForProvider(spec.provider);
	if (!agent) return piEngineForSpec(spec, ...options);
	if (!localAcpEnabled()) throw new AcpConnectionUnavailable("ACP requires the local app launcher. Run npm run app on this computer.");
	const config = settingsStore.readSettings()?.acp?.[agent.id];
	if (!config?.enabled) throw new AcpConnectionUnavailable(`${agent.label} is disconnected. Connect it in Settings → Subscriptions.`);
	const model = config.models?.find((model) => model.id === spec.id);
	if (!model && spec.id !== "default") throw new Error(`Unknown ${agent.label} ACP model: ${spec.id}. Reconnect the subscription to refresh its models.`);
	return createAcpEngine(agent.id, { ...config, ...acpLaunchConfig(agent.id) }, model, spec.thinkingLevel);
}

function saveConnection(id: AcpAgentId, config: AcpConnectionConfig) {
	const record = settingsStore.readSettings() ?? { version: 1 };
	settingsStore.writeSettings({ ...record, acp: { ...record.acp, [id]: config } });
}

/** Check installation/protocol/auth without making an inference request or
 * launching a browser. Only successful checks enable a connection. */
export async function connectAcp(id: AcpAgentId, body: unknown, signal?: AbortSignal) {
	if (!localAcpEnabled()) return { ok: false as const, status: 403, error: "ACP requires the local app launcher. Run npm run app on this computer." };
	if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 0)
		return { ok: false as const, status: 400, error: "Connect accepts an empty object. Configure adapter executables in the local host file (LH_ACP_HOST_CONFIG)." };
	let client: AcpClient | undefined;
	try {
		const config = acpLaunchConfig(id);
		client = new AcpClient(id, config, { signal });
		const initialized = await client.initialize();
		if (!initialized.agentCapabilities?.mcpCapabilities?.http) throw new Error("Update this adapter: HTTP MCP support is required for LearnHarness tools.");
		if (!initialized.agentCapabilities?.promptCapabilities?.image) throw new Error("Update this adapter: image input is required to use all LearnHarness model slots.");
		const session = await client.newSession({ mcpServers: [], _meta: { disableBuiltInTools: true, claudeCode: { options: { tools: [], settingSources: [], persistSession: false } } } });
		const models = await discoverAcpModels(client, session);
		await retireAcpSessions(id);
		saveConnection(id, { models, enabled: true });
		return { ok: true as const, agent: initialized.agentInfo?.name, model: session.models?.currentModelId };
	} catch (error) {
		const agent = ACP_AGENTS.find((agent) => agent.id === id)!;
		return { ok: false as const, status: 503, error: `${error instanceof Error ? error.message : String(error)} Sign in with your subscription using ${agent.login}, then try again.` };
	} finally {
		await client?.close();
	}
}

export async function disconnectAcp(id: AcpAgentId) {
	const config = settingsStore.readSettings()?.acp?.[id] ?? {};
	// Disconnect removes availability, never the CLI's own login or existing records.
	saveConnection(id, { ...config, enabled: false });
	await closeAcpSessions(id);
}

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { ACP_THINKING_LEVELS, type AcpModelInfo } from "../../core/acp.ts";
import type { AcpClient, AcpConfigOption, AcpConfigValue, AcpSession } from "./client.ts";

function option(options: AcpConfigOption[] | undefined, category: string) {
	return options?.find((value) => value.type === "select" && value.category === category);
}
function values(selected: AcpConfigOption | undefined): AcpConfigValue[] {
	return selected?.options?.flatMap((entry) => "options" in entry ? entry.options : [entry]) ?? [];
}
function reasoning(options: AcpConfigOption[] | undefined): AcpModelInfo["reasoning"] {
	const result: AcpModelInfo["reasoning"] = {};
	for (const entry of values(option(options, "thought_level"))) {
		const level = entry.value === "none" ? "off" : entry.value;
		if (ACP_THINKING_LEVELS.includes(level as ThinkingLevel)) result[level as ThinkingLevel] = entry.value;
	}
	return result;
}
async function setOption(client: AcpClient, session: AcpSession, selected: AcpConfigOption, value: string) {
	const response = await client.request<{ configOptions: AcpConfigOption[] }>("session/set_config_option", {
		sessionId: session.sessionId, configId: selected.id, value,
	});
	if (!Array.isArray(response?.configOptions)) throw new Error("ACP adapter returned no configuration after changing a model or reasoning level");
	return response.configOptions;
}

/** Query each model's own reasoning choices without sending an inference prompt.
 * Discovery changes only this throwaway session, never the CLI's saved config. */
export async function discoverAcpModels(client: AcpClient, session: AcpSession): Promise<AcpModelInfo[]> {
	const result: AcpModelInfo[] = [{ id: "default", name: "Agent default", reasoning: reasoning(session.configOptions) }];
	const selected = option(session.configOptions, "model");
	const models = selected ? values(selected) : session.models?.availableModels?.map((model) => ({ value: model.modelId, name: model.name })) ?? [];
	const seen = new Set<string>();
	for (const model of models) {
		if (seen.has(model.value)) continue;
		seen.add(model.value);
		const options = selected ? await setOption(client, session, selected, model.value) : undefined;
		if (selected && option(options, "model")?.currentValue !== model.value) throw new Error("The ACP adapter did not apply a model during discovery");
		result.push({ id: `model/${model.value}`, modelId: model.value, name: model.name, reasoning: reasoning(options) });
	}
	return result;
}

/** Reapply the selected model first: its returned controls are authoritative
 * for reasoning. Never silently run another model if a cached choice expires. */
export async function selectAcpModel(client: AcpClient, session: AcpSession, model: AcpModelInfo | undefined, level?: ThinkingLevel) {
	let options = session.configOptions;
	if (model?.modelId !== undefined) {
		const selected = option(options, "model");
		if (selected) {
			if (!values(selected).some((entry) => entry.value === model.modelId)) throw new Error("The selected ACP model is no longer available. Reconnect the subscription to refresh its models.");
			options = await setOption(client, session, selected, model.modelId);
			if (option(options, "model")?.currentValue !== model.modelId) throw new Error("The ACP adapter did not apply the selected model");
		} else {
			if (!session.models?.availableModels?.some((entry) => entry.modelId === model.modelId)) throw new Error("The selected ACP model is no longer available. Reconnect the subscription to refresh its models.");
			await client.request("session/set_model", { sessionId: session.sessionId, modelId: model.modelId });
		}
	}
	if (level === undefined) return;
	const selected = option(options, "thought_level");
	// Older saved agent-default pins used off as an internal placeholder.
	if (!selected && model?.modelId === undefined && level === "off") return;
	const value = reasoning(options)[level];
	if (!selected || value === undefined) throw new Error(`This ACP model does not support ${level} reasoning. Reconnect the subscription or choose an advertised level.`);
	const updated = await setOption(client, session, selected, value);
	if (option(updated, "thought_level")?.currentValue !== value) throw new Error("The ACP adapter did not apply the selected reasoning level");
}

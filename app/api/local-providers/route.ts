import { effectiveSettings } from "@/src/server/stores.ts";
import { keyValue } from "@/src/server/keys.ts";
import { probeOllama, probeVLLM } from "@/src/server/local-models.ts";
import { createLocalProvider, setLocalProvider } from "@/src/agent/models.ts";

export async function POST(req: Request) {
	try {
		const body = (await req.json()) as {
			provider?: "ollama" | "custom";
			baseUrl?: string;
			apiKey?: string;
			defaultContextWindow?: number;
		};

		if (!body.provider || (body.provider !== "ollama" && body.provider !== "custom")) {
			return Response.json({ ok: false, error: "Invalid provider (must be 'ollama' or 'custom')", models: [] }, { status: 400 });
		}

		const localSettings = effectiveSettings().localProviders;

		if (body.provider === "ollama") {
			const baseUrl = body.baseUrl?.trim() || localSettings.ollama.baseUrl || "http://localhost:11434";
			const ctx = body.defaultContextWindow ?? localSettings.ollama.defaultContextWindow ?? 32768;
			const res = await probeOllama(baseUrl, ctx);
			if (res.ok) {
				setLocalProvider(createLocalProvider("ollama", baseUrl, undefined, res.models));
			}
			return Response.json(res);
		}

		const baseUrl = body.baseUrl?.trim() || localSettings.custom.baseUrl || "http://localhost:8000/v1";
		const apiKey = body.apiKey !== undefined ? body.apiKey.trim() : (keyValue("LOCAL_AI_API_KEY") ?? "");
		const ctx = body.defaultContextWindow ?? localSettings.custom.defaultContextWindow ?? 32768;
		const res = await probeVLLM(baseUrl, apiKey, ctx);
		if (res.ok) {
			setLocalProvider(createLocalProvider("custom", baseUrl, apiKey, res.models));
		}
		return Response.json(res);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return Response.json({ ok: false, error: message, models: [] }, { status: 500 });
	}
}

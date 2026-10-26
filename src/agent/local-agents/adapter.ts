import type { Api, Model } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { LocalAgentProviderId } from "../../core/contracts/local-agents.ts";
import type { BridgeTool, ToolBridge } from "./mcp-server.ts";
import type { LocalRun, RunSession } from "./run.ts";

/** What a runtime reports about itself — never a credential. */
export interface AdapterProbe {
	installed: boolean;
	binary?: string;
	version?: string;
	signedIn: boolean;
	account?: string;
	plan?: string;
	usesSubscription?: boolean;
	models: Model<Api>[];
	error?: string;
	/** The probe could not tell (timeout, unreadable output): keep the last known sign-in and catalog. */
	uncertain?: boolean;
}

export interface OpenRequest {
	binary: string;
	model: Model<Api>;
	level?: ThinkingLevel;
	systemPrompt: string;
	tools: BridgeTool[];
	bridge: ToolBridge;
}

/** One locally installed runtime (Claude Code, the Antigravity ACP server). */
export interface LocalAgentAdapter {
	providerId: LocalAgentProviderId;
	/** Tool calls become visible only when the MCP request arrives (ACP), not in the stream first (Claude). */
	surfaceOnArrival: boolean;
	/** Whether prompt image blocks are passed through. */
	images: boolean;
	probe(options: { discoverModels: boolean; previous: Model<Api>[] }): Promise<AdapterProbe>;
	open(run: LocalRun, request: OpenRequest): Promise<RunSession>;
	/** App-driven sign-in inside the vendor runtime (the runtime opens the browser and keeps the tokens). */
	signIn?(signal: AbortSignal): Promise<Model<Api>[]>;
}

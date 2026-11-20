import type { Agent, AgentEvent, AgentMessage, AgentTool, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";

/**
 * The structural subset of pi-agent-core's `Agent` that the turn runner
 * (server/pi/ui-stream.ts), the wake pipeline (server/jobs.ts) and the
 * chat-handler actually use. pi's `Agent` satisfies it as is; the Local
 * Claude adapter (claude-local/agent.ts) implements it over the Agent SDK
 * (owner-approved design, 2026-10-27). Code that holds a live agent types
 * it as this, never as the pi class, so the two engines are interchangeable
 * at every seam — the record, the wire and the steer registry see the same
 * AgentEvent/AgentMessage vocabulary from both.
 */
export interface LiveAgent {
	readonly state: {
		readonly systemPrompt: string;
		model: Model<any>;
		thinkingLevel: ThinkingLevel;
		tools: AgentTool<any>[];
		messages: AgentMessage[];
	};
	subscribe(listener: (event: AgentEvent, signal: AbortSignal) => Promise<void> | void): () => void;
	/** Continue from the current transcript (the last message is a user or tool-result message). */
	continue(): Promise<void>;
	abort(): void;
	/** Queue a message to inject at the next turn boundary of a running run. */
	steer(message: AgentMessage): void;
	clearSteeringQueue(): void;
	waitForIdle(): Promise<void>;
}

/** pi's class is a LiveAgent (compile-time pin; no runtime cost). */
export type PiAgentIsLive = Agent extends LiveAgent ? true : never;

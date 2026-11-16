import type { Usage } from "@earendil-works/pi-ai";

export type CliUsage = Partial<Pick<Usage, "input" | "output" | "cacheRead" | "cacheWrite">>;

export type CliBlock = { type: "text" } | { type: "thinking" } | { type: "toolUse"; id: string; name: string };

export type CliEvent =
	| { type: "messageStart"; usage: CliUsage }
	| { type: "blockStart"; index: number; block: CliBlock }
	| { type: "textDelta"; index: number; text: string }
	| { type: "thinkingDelta"; index: number; thinking: string }
	| { type: "toolInputDelta"; index: number; partialJson: string }
	| { type: "blockStop"; index: number }
	| { type: "messageDelta"; stopReason: string | null; usage: CliUsage }
	| { type: "messageStop" }
	| { type: "assistantError"; error: string; text: string }
	| { type: "resultError"; text: string }
	| { type: "toolResults"; ids: string[] };

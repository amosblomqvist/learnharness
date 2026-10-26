import { createHash, randomUUID } from "node:crypto";
import { getCurrentSystemPrompt, getCurrentTools, normalizeContext, toToolDeclaration, type Api, type Message, type Model, type SimpleStreamOptions, type StreamFunction, type TranscriptContext } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { localAgentDescriptor, type LocalAgentProviderId } from "../../core/contracts/local-agents.ts";
import { markUnadmittedUsage, type NoDispatchKind, type SubscriptionDispatchLifecycle } from "../subscription-request-cycle.ts";
import { startToolBridge, type BridgeTool } from "./mcp-server.ts";
import { createRun, findRun, StepWriter, type LocalRun } from "./run.ts";
import { localAgentAbortController, localAgentAdapter, localAgentAdmissionScope, localAgentBackgroundAllowed, localAgentBinary, localAgentScope, localAgentScopeCurrent, refreshLocalAgents, type LocalAgentScope } from "./state.ts";
import { renderTranscript } from "./transcript.ts";

/** A parked run waits this long for pi's tool result (a quiz may wait on the learner). */
const IDLE_MS = 20 * 60_000;

export function localAgentError(provider: string, message: string): string {
	const descriptor = localAgentDescriptor(provider);
	const label = descriptor?.label ?? "Local agent";
	const runtime = descriptor?.runtime ?? "the local runtime";
	const suffix = " No API-key fallback was used.";
	if (/background/i.test(message)) return `${label} background use is off in this app. Enable it in Providers to run this work.${suffix}`;
	if (/usage limit|rate.?limit|quota|429|resource.?exhausted/i.test(message)) return `${label} usage limit reached. Check your plan's limits and try again later.${suffix}`;
	if (/login|log in|sign.?in|auth|credential|401|403|expired/i.test(message)) return `${runtime} is not signed in or its sign-in expired. Sign in again, then retry.${suffix}`;
	if (/cancel|abort/i.test(message)) return `${label} request cancelled.${suffix}`;
	if (/model unavailable|catalog|changed|disabled/i.test(message)) return `The selected ${label} model or connection is unavailable. Refresh Providers and choose an available model.${suffix}`;
	if (/not (installed|found)|ENOENT|could not start|exited/i.test(message)) return `${runtime} could not run (${message.slice(0, 200)}). Check the installation in Providers.${suffix}`;
	return `${label} request failed: ${message.slice(0, 300)}${suffix}`;
}

function toBridgeTools(messages: readonly { role: string }[]): BridgeTool[] {
	return getCurrentTools(messages).map((tool) => {
		const declared = toToolDeclaration(tool);
		return { name: declared.name, description: declared.description, inputSchema: JSON.parse(JSON.stringify(declared.parameters)) as Record<string, unknown> };
	});
}

function runSignature(provider: string, model: Model<Api>, level: ThinkingLevel | undefined, systemPrompt: string, tools: BridgeTool[]): string {
	return createHash("sha256").update(JSON.stringify([provider, model.id, level ?? "off", systemPrompt, tools])).digest("hex");
}

/** The engine stream for a local agent connection: resume the parked run, or cold-start one. */
export function localAgentStream(providerId: LocalAgentProviderId, background: () => boolean, lifecycle?: SubscriptionDispatchLifecycle): StreamFunction<Api, SimpleStreamOptions> {
	return (model, rawContext, options) => {
		const out = new AssistantMessageEventStream();
		const writer = new StepWriter(out, model);
		const purpose = background();
		const { controller, release } = localAgentAbortController(providerId, purpose);
		const signal = options?.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
		const key = options?.sessionId ?? randomUUID();
		let dispatched = false;
		let scope: LocalAgentScope | undefined;
		let live: LocalRun | undefined;
		// The same reading as subscriptionDenial: the caller's abort or a lost connection is "all".
		const denialKind = (): NoDispatchKind => options?.signal?.aborted || controller.signal.reason === "all" ? "all"
			: controller.signal.reason === "background" || (purpose && !localAgentBackgroundAllowed(providerId)) ? "background" : "other";
		const deny = (kind: NoDispatchKind, message: string) => {
			markUnadmittedUsage(writer.partial.usage);
			lifecycle?.noDispatch(kind);
			// A background denial may recover in the foreground and resume; anything else releases the process.
			if (kind !== "background") findRun(key)?.close();
			writer.fail(signal.aborted ? "aborted" : "error", localAgentError(providerId, message));
		};
		void (async () => {
			try {
				await refreshLocalAgents({ providerId });
				if (model.provider !== providerId) throw new Error("model unavailable");
				scope = localAgentScope(providerId, model.id);
				lifecycle?.captured(localAgentAdmissionScope(scope));
				if (purpose && !localAgentBackgroundAllowed(providerId)) { deny("background", "background use disabled"); return; }
				const binary = localAgentBinary(providerId);
				if (!binary) throw new Error("not installed");
				const context = normalizeContext(rawContext as unknown as Parameters<typeof normalizeContext>[0]) as TranscriptContext;
				const messages = context.messages as Message[];
				const systemPrompt = getCurrentSystemPrompt(messages);
				const tools = toBridgeTools(messages);
				const level = options?.reasoning;
				const signature = runSignature(providerId, model, level, systemPrompt, tools);
				const adapter = localAgentAdapter(providerId);
				const existing = findRun(key);
				const results = existing?.resumable(messages, signature);
				if (signal.aborted || !localAgentScopeCurrent(scope)) throw new Error("cancelled or connection changed");
				lifecycle?.beforeDispatch(localAgentAdmissionScope(scope));
				dispatched = true;
				const run = live = existing && results ? existing : createRun({ key, providerId, signature, model, surfaceOnArrival: adapter.surfaceOnArrival, tools, idleMs: IDLE_MS });
				run.background = purpose;
				signal.addEventListener("abort", () => run.fail(localAgentError(providerId, "cancelled"), "aborted"), { once: true });
				if (existing && results) { existing.resume(writer, results, model, messages); return; }
				run.attach(writer, messages);
				const bridge = await startToolBridge({ tools: () => run.tools, call: (request) => run.onBridgeCall(request) });
				if (run.closed) { void bridge.close(); return; }
				run.bridge = bridge;
				const session = await adapter.open(run, { binary, model, level, systemPrompt, tools, bridge });
				if (run.closed) { session.dispose(); return; }
				run.session = session;
				session.start(renderTranscript(messages, { images: adapter.images && model.input.includes("image") }));
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (!dispatched) { deny(denialKind(), message); return; }
				live?.fail(localAgentError(providerId, message));
				writer.fail(signal.aborted ? "aborted" : "error", localAgentError(providerId, message));
			}
		})().finally(() => {
			// The abort controller lives as long as the step's stream.
			void out.result().finally(release);
		});
		return out;
	};
}

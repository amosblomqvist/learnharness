"use client";

import { useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { QUESTION_TOOLS, type ArtifactPartProps, type LhViewPart, type PluginCodeBlockProps, type PluginToolRenderProps } from "@/src/core";
import { usePlugins } from "@/components/plugins";
import { type CodeBlockRegistration, type ToolRendererRegistration, type PluginMount } from "@/components/plugin-manager";
import { artifactRenderers } from "@/components/artifacts";
import { LiveToolCard } from "@/components/artifacts/live-tool-card";
import { ToolCallCard } from "@/components/artifacts/tool-call-card";
import { DispatchCard } from "@/components/artifacts/dispatch-card";
import { JobsContext } from "@/components/jobs-context";

/** The Markdown dispatch uses this same exclusive built-in language. */
export const BUILTIN_MERMAID_LANGUAGE = "mermaid";

/** Only actual exclusive presentation claims: not every backend/internal tool.
 * A function avoids eager access across the existing artifact/chat module cycle. */
export function reservedToolRendererNames(): string[] {
	return [...new Set([...Object.keys(artifactRenderers), ...QUESTION_TOOLS, "plan_init"])];
}

function RendererMount({ registration, mount, label, fallback }: {
	registration: CodeBlockRegistration | ToolRendererRegistration;
	mount: PluginMount;
	label: string;
	fallback: ReactNode;
}) {
	const { manager } = usePlugins();
	const container = useRef<HTMLDivElement>(null);
	const [failure, setFailure] = useState<{ mount: PluginMount; error: string }>();
	const failed = failure?.mount === mount;
	useEffect(() => {
		if (!manager || !container.current) return;
		return manager.mountRenderer(registration, mount, container.current, error => setFailure({ mount, error }));
	}, [manager, registration, mount]);
	if (!manager || failed) return <>
		{failed && <p role="alert" className="text-xs text-destructive">{label}: {failure.error}</p>}
		{fallback}
	</>;
	return <div ref={container} data-plugin-renderer={label} className="min-w-0" />;
}

export function PluginCodeBlock({ language, source, meta, incomplete, fallback }: Omit<PluginCodeBlockProps, "signal"> & { fallback: ReactNode }) {
	const { snapshot } = usePlugins();
	const registration = snapshot.codeBlocks.find(entry => entry.renderer.language === language);
	const mount = useMemo<PluginMount>(() => (container, signal) => registration?.renderer.mount(container, { language, source, meta, incomplete, signal }),
		[registration, language, source, meta, incomplete]);
	if (!registration) return <>{fallback}</>;
	return <RendererMount registration={registration} mount={mount} label={`Plugin code block (${language})`} fallback={fallback} />;
}

/** Preserve native text (and an honest image attachment note) when no details
 * payload exists. Never serialize image bytes/base64 into the transcript. */
export function nativeToolResultText(result: PluginToolRenderProps["result"]): string | undefined {
	if (!result) return;
	return result.content.map(block => block.type === "text" ? block.text : `[Image attached to the model: ${block.mimeType}]`).join("\n");
}

export function toolFallbackPart(part: LhViewPart): ArtifactPartProps["part"] {
	return {
		...part, type: part.type, state: part.state ?? "input-available", toolCallId: part.toolCallId ?? "",
		output: part.output ?? part.result?.details ?? nativeToolResultText(part.result),
	};
}

/** Ordinary tools retain the expandable trace; accepted background calls use
 * the native dispatch/status card. Custom renderers replace either default body.
 * Disabled, failed, or uninstalled renderers never make native results vanish. */
export function PluginToolRenderer({ part, fallback: suppliedFallback }: { part: LhViewPart; fallback?: ReactNode }) {
	const { snapshot } = usePlugins();
	const jobs = useContext(JobsContext);
	const toolName = part.type.slice("tool-".length);
	const background = part.background as PluginToolRenderProps["background"];
	const pluginId = background?.pluginId, taskId = background?.taskId, status = background?.status;
	const registration = snapshot.toolRenderers.find(entry => entry.renderer.toolName === toolName);
	const content = part.result?.content, details = part.result?.details, isError = part.result?.isError;
	const mount = useMemo<PluginMount>(() => (container, signal) => {
		if (!registration || !isToolState(part.state)) return;
		return registration.renderer.mount(container, {
			toolName, toolCallId: part.toolCallId ?? "", input: part.input, state: part.state,
			output: part.output, errorText: part.errorText,
			...(content ? { result: { content, details, isError: isError ?? false } } : {}),
			...(pluginId !== undefined && taskId !== undefined && status !== undefined ? { background: { pluginId, taskId, status } } : {}), signal,
		});
	}, [registration, toolName, part.toolCallId, part.input, part.state, part.output, part.errorText, content, details, isError, pluginId, taskId, status]);
	// Native ACK details identify dispatch even before the jobs feed catches up.
	// A later synthetic result must not turn back into its original dispatch.
	const ack = details as { jobId?: unknown; dispatched?: unknown } | null | undefined;
	const dispatched = !background && part.state === "output-available" && !isError && (
		jobs.some(job => job.kind === "plugin" && job.toolCallId === part.toolCallId) ||
		(ack !== null && typeof ack === "object" && typeof ack.jobId === "string" && ack.dispatched === true)
	);
	if (part.pluginQuestion) return <p role="status" className="text-xs text-muted-foreground">Question unavailable</p>;
	const fallback = suppliedFallback ?? (dispatched
		? <DispatchCard kind="plugin" toolCallId={part.toolCallId ?? ""} />
		: <ToolCallCard part={toolFallbackPart(part)} />);
	if (!registration || !isToolState(part.state)) return fallback;
	return <RendererMount registration={registration} mount={mount} label={`Plugin tool (${toolName})`} fallback={fallback} />;
}

function isToolState(state: unknown): state is PluginToolRenderProps["state"] {
	return state === "input-streaming" || state === "input-available" || state === "output-available" || state === "output-error";
}

/** Called by chat's default tool branch AFTER its explicit question/dock
 * handling. Built-in cards and the hidden settled plan call remain exclusive;
 * only the generic fallback slot is extensible by plugins. */
export function ToolPartRenderer({ part }: { part: LhViewPart }) {
	// Attempts/unreadable metadata must never fall through to raw payloads or
	// validator error text, including when the renderer is missing.
	if (part.pluginQuestion) return <p role="status" className="text-xs text-muted-foreground">Question unavailable</p>;
	const toolName = part.type.slice("tool-".length);
	const Builtin = Object.hasOwn(artifactRenderers, toolName) ? artifactRenderers[toolName] : undefined;
	const reserved = Builtin || toolName === "plan_init" || (QUESTION_TOOLS as readonly string[]).includes(toolName);
	if (reserved && part.state === "input-streaming") return <LiveToolCard part={part as ArtifactPartProps["part"]} />;
	if (Builtin) return <Builtin part={part as ArtifactPartProps["part"]} />;
	if (reserved) return null;
	return <PluginToolRenderer part={part} />;
}

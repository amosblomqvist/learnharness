"use client";

import { ChevronRight } from "lucide-react";
import type { ArtifactPartProps } from "@/src/core";
import { ImageGallery, galleryItemsFromBlocks } from "@/components/image-gallery";

/**
 * The generic tool-call card (sources v1, 2026-09-19): a quiet, collapsed
 * one-liner per synchronous tool call — the tool name plus the headline
 * argument — expandable to the full input and output. The user's spec:
 * "at least the tool name; for read, the file name; everything collapsed
 * by default; not distracting — background stuff." Tools with native images also use this card as a registry fallback.
 */

interface ToolCallPart {
	type: string;
	state: string;
	toolCallId: string;
	input?: unknown;
	output?: unknown;
	errorText?: string;
}

/** The collapsed headline argument per tool: path for read/ls, pattern for
 *  find/grep — shown as given, never resolved (the absolute path lands in
 *  the expanded view when present in the output). */
function headlineArg(tool: string, input: unknown): string {
	const inp = (input ?? {}) as Record<string, unknown>;
	if (tool === "read" || tool === "ls" || tool === "pdf_view") {
		const p = typeof inp.path === "string" && inp.path.length > 0 ? inp.path : "~";
		return p;
	}
	if (typeof inp.pattern === "string") return inp.pattern;
	// list_propositions: the session id is the call's subject — the
	// collapsed line reads "list_propositions chat_…". Shown as given
	// (the id is exactly what list_sessions reported to the model).
	if (tool === "list_propositions" && typeof inp.session === "string" && inp.session.length > 0) {
		return inp.session;
	}
	return "";
}

/** The caption under a tool's pictures: the input's path (+ page / crop),
 *  else the first line of the output text. Always short plain text. */
function imageCaption(input: unknown, output: unknown): string | undefined {
	const inp = (input ?? {}) as Record<string, unknown>;
	const bits: string[] = [];
	if (typeof inp.path === "string" && inp.path) bits.push(inp.path);
	if (typeof inp.page === "number" || typeof inp.page === "string") bits.push(`p. ${inp.page}`);
	if (inp.crop != null && typeof inp.crop !== "function") {
		try {
			bits.push(`crop ${typeof inp.crop === "string" ? inp.crop : JSON.stringify(inp.crop)}`);
		} catch {
			/* unprintable crop */
		}
	}
	if (bits.length > 0) return bits.join(" · ").slice(0, 200);
	const text = typeof output === "string" ? output : (output as { text?: unknown } | null)?.text;
	return typeof text === "string" && text ? text.split("\n")[0]!.slice(0, 200) : undefined;
}

/** Plain output text and legacy attachment notes. Native result images
 *  render separately in the shared gallery, including with null details. */
function outputText(output: unknown): string | null {
	if (output == null) return null;
	if (typeof output === "string") return output;
	if (typeof output === "object" && "text" in (output as Record<string, unknown>)) {
		const o = output as { text?: unknown; images?: unknown[] };
		const text = typeof o.text === "string" ? o.text : null;
		const n = Array.isArray(o.images) ? o.images.length : 0;
		return n > 0 ? `${text ?? ""}\n[${n} image${n > 1 ? "s" : ""} attached to the model]`.trim() : text;
	}
	try {
		return JSON.stringify(output, null, 2);
	} catch {
		return String(output);
	}
}

export function ToolCallCard({ part }: ArtifactPartProps) {
	const p = part as ToolCallPart;
	const tool = p.type.replace(/^tool-/, "");
	const arg = headlineArg(tool, p.input);
	const out = outputText(p.output);
	const failed = p.state === "output-error" || typeof p.errorText === "string";
	const images = galleryItemsFromBlocks(part.images, imageCaption(p.input, p.output));
	return (
		<>
		<details
			data-testid="tool-call-card"
			data-tool={tool}
			className="group my-1 w-full max-w-2xl select-none"
		>
			<summary className="flex cursor-pointer list-none items-center gap-2 text-xs text-muted-foreground [&::-webkit-details-marker]:hidden">
				<span className={`font-medium uppercase tracking-wide ${failed ? "text-red-500" : ""}`}>
					{tool}
				</span>
				{arg && <span className="truncate">{arg}</span>}
				<ChevronRight className="size-3 shrink-0 opacity-50 transition-transform group-open:rotate-90" />
			</summary>
			<div className="mt-2 space-y-2 rounded-xl border bg-card p-3 text-xs">
				{p.input != null && (
					<div>
						<div className="mb-1 font-medium uppercase tracking-wide text-muted-foreground">
							Input
						</div>
						<pre className="max-h-32 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed">
							{JSON.stringify(p.input, null, 2)}
						</pre>
					</div>
				)}
				{typeof p.errorText === "string" ? (
					<div>
						<div className="mb-1 font-medium uppercase tracking-wide text-muted-foreground">
							Error
						</div>
						<pre className="whitespace-pre-wrap break-all font-mono text-[11px] text-red-500">
							{p.errorText}
						</pre>
					</div>
				) : out != null ? (
					<div>
						<div className="mb-1 font-medium uppercase tracking-wide text-muted-foreground">
							Output
						</div>
						<pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed">
							{out}
						</pre>
					</div>
				) : (
					p.state !== "output-available" && (
						<div className="text-muted-foreground italic">running…</div>
					)
				)}
			</div>
		</details>
		{/* The pictures a tool returned stay visible after the collapsed trace. */}
		{images.length > 0 && <ImageGallery items={images} showCaptions />}
		</>
	);
}

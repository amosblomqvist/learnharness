"use client";

import { ChevronRight } from "lucide-react";
import type { ArtifactPartProps, Translate } from "@/src/core";
import { useT } from "@/components/locale";

/**
 * The generic tool-call card (sources v1, 2026-09-19): a quiet, collapsed
 * one-liner per synchronous tool call — the tool name plus the headline
 * argument — expandable to the full input and output. The user's spec:
 * "at least the tool name; for read, the file name; everything collapsed
 * by default; not distracting — background stuff." Unregistered tools
 * still render nothing (chat.tsx's registry default); this card is only
 * for the learner-filesystem set (read/ls/find/grep) where the call IS
 * worth a trace in the transcript.
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
	if (tool === "read" || tool === "ls") {
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

/** Render a tool result body: plain strings verbatim, image-bearing read
 *  results show their text + an attachment note (the image itself is the
 *  model's — the learner sees only that it happened). */
function outputText(output: unknown, t: Translate): string | null {
	if (output == null) return null;
	if (typeof output === "string") return output;
	if (typeof output === "object" && "text" in (output as Record<string, unknown>)) {
		const o = output as { text?: unknown; images?: unknown[] };
		const text = typeof o.text === "string" ? o.text : null;
		const n = Array.isArray(o.images) ? o.images.length : 0;
		return n > 0
			? `${text ?? ""}\n${t(n > 1 ? "[{n} images attached to the model]" : "[{n} image attached to the model]", { n })}`.trim()
			: text;
	}
	try {
		return JSON.stringify(output, null, 2);
	} catch {
		return String(output);
	}
}

export function ToolCallCard({ part }: ArtifactPartProps) {
	const t = useT();
	const p = part as ToolCallPart;
	const tool = p.type.replace(/^tool-/, "");
	const arg = headlineArg(tool, p.input);
	const out = outputText(p.output, t);
	const failed = p.state === "output-error" || typeof p.errorText === "string";
	return (
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
							{t("Input")}
						</div>
						<pre className="max-h-32 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed">
							{JSON.stringify(p.input, null, 2)}
						</pre>
					</div>
				)}
				{typeof p.errorText === "string" ? (
					<div>
						<div className="mb-1 font-medium uppercase tracking-wide text-muted-foreground">
							{t("Error")}
						</div>
						<pre className="whitespace-pre-wrap break-all font-mono text-[11px] text-red-500">
							{t(p.errorText)}
						</pre>
					</div>
				) : out != null ? (
					<div>
						<div className="mb-1 font-medium uppercase tracking-wide text-muted-foreground">
							{t("Output")}
						</div>
						<pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed">
							{out}
						</pre>
					</div>
				) : (
					p.state !== "output-available" && (
						<div className="text-muted-foreground italic">{t("running…")}</div>
					)
				)}
			</div>
		</details>
	);
}

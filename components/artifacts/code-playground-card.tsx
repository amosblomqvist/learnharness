"use client";

/**
 * The code_playground card: the learner edits real code and runs it.
 *
 * Engines (src/core/code-playground.ts owns the resolution):
 *  - native (JS/TS): executed in a throwaway `sandbox="allow-scripts"` iframe —
 *    no same-origin, so no access to the app or its API
 *  - runner (C, C++, Rust, …): POST /api/code/run, which forwards to the
 *    loopback sandbox service. The browser never holds the runner token.
 *  - none: the editor still works and the attempt can still be sent; Run is
 *    disabled with the stated reason.
 *
 * Sending returns the attempt to the conversation as the learner's own turn —
 * the same channel the demo fix-loop uses.
 */

import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { ChatActionsContext } from "@/components/chat";
import { CodeEditor } from "@/components/code-editor";
import type { ArtifactPartProps } from "@/src/core";
import {
	RUNNER_LANGUAGES,
	canonicalLanguage,
	classifyRun,
	formatReport,
	isCodingLanguage,
	modeRequirements,
	runnerLanguageFor,
	predictionMatches,
	resolveEngine,
	type CodePlaygroundInput,
	type CodePlaygroundMode,
	type CodePlaygroundReport,
} from "@/src/core";

type RunResult = CodePlaygroundReport["runs"][number];

function parseInput(part: ArtifactPartProps["part"]): CodePlaygroundInput | null {
	const raw = part.input as Record<string, unknown> | undefined;
	if (!raw || typeof raw.language !== "string" || typeof raw.starter !== "string") return null;
	return {
		mode: (typeof raw.mode === "string" ? raw.mode : "implement") as CodePlaygroundMode,
		errorText: typeof raw.errorText === "string" ? raw.errorText : undefined,
		pair: typeof raw.pair === "string" ? raw.pair : undefined,
		language: raw.language,
		task: typeof raw.task === "string" ? raw.task : "Implement the task.",
		starter: raw.starter,
		checks: Array.isArray(raw.checks) ? (raw.checks as CodePlaygroundInput["checks"]) : undefined,
		nodeId: typeof raw.nodeId === "string" ? raw.nodeId : undefined,
	};
}

/** TypeScript runs as JavaScript: ask the server to transpile with esbuild
 *  (compilation only), and fall back to the conservative local strip if that
 *  route is unavailable. */
async function toRunnable(language: string, code: string): Promise<string> {
	if (!/^(typescript|ts|tsx)$/i.test(language.trim())) return code;
	try {
		const res = await fetch("/api/code/transpile", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ code }),
		});
		if (res.ok) {
			const body = (await res.json()) as { code?: string };
			if (typeof body.code === "string" && body.code.trim()) return body.code;
		}
	} catch {
		/* fall through to the local strip */
	}
	return stripTypes(code);
}

/** Conservative type-annotation strip: TypeScript is a superset, and this is
 *  for running, not for type-checking. The editor's parser still reports. */
function stripTypes(code: string): string {
	return code
		.replace(/^\s*(?:export\s+)?(?:interface|type)\s+\w+[^=]*=.*$/gm, "")
		.replace(/:\s*(?:[A-Za-z_$][\w$.]*(?:<[^>]*>)?(?:\[\])*|\{[^}]*\})(?=\s*[,)=;{])/g, "")
		.replace(/\s+as\s+[A-Za-z_$][\w$.<>[\]]*/g, "")
		.replace(/<[A-Za-z_$][\w$]*(?:,\s*[A-Za-z_$][\w$]*)*>(?=\()/g, "");
}

/** Run JS in a Worker: a separate thread, so an infinite loop is *terminable*
 *  (`worker.terminate()`) instead of freezing the tab the way an iframe does.
 *  The trade: no DOM inside. Code that needs the DOM is told so honestly. */
function runInWorker(code: string, checks: CodePlaygroundInput["checks"] = [], timeoutMs = 5000): Promise<RunResult> {
	return new Promise((resolve) => {
		const harness = `
			self.onmessage = () => {
				const out = [];
				const fmt = (v) => { try { return typeof v === "string" ? v : JSON.stringify(v); } catch { return String(v); } };
				console.log = (...a) => out.push(a.map(fmt).join(" "));
				console.error = (...a) => out.push("stderr: " + a.map(fmt).join(" "));
				let err = null, errName = null;
				try { (0, eval)(${JSON.stringify(code)}); }
				catch (e) { err = String(e && e.message ? e.message : e); errName = e && e.name ? e.name : "Error"; }
				const checks = ${JSON.stringify((checks ?? []).map((c) => ({ label: c.label ?? c.expr, expr: c.expr, expect: c.expect })))}.map((c) => {
					let pass = false;
					try { pass = String((0, eval)(c.expr)) === c.expect; } catch { /* stays false */ }
					return { label: c.label, pass };
				});
				postMessage({ out, err, errName, checks });
			};`;
		const url = URL.createObjectURL(new Blob([harness], { type: "text/javascript" }));
		const worker = new Worker(url);
		let done = false;
		const finish = (r: RunResult) => {
			if (done) return;
			done = true;
			worker.terminate();
			URL.revokeObjectURL(url);
			resolve(r);
		};
		const timer = setTimeout(() => finish({ ok: false, timedOut: true, errorKind: "timeout", stdout: "" }), timeoutMs);
		worker.onmessage = (ev: MessageEvent<{ out: string[]; err: string | null; errName?: string | null; checks?: Array<{ label: string; pass: boolean }> }>) => {
			clearTimeout(timer);
			const { out = [], err, errName, checks: cks } = ev.data ?? {};
			const dom = err && /document|window is not defined/i.test(err);
			finish({
				ok: !err && (cks ?? []).every((c) => c.pass),
				stdout: out.join("\n"),
				stderr: dom ? "DOM APIs are unavailable in the sandbox — use a demo card for DOM code" : (err ?? undefined),
				errorKind: classifyRun({ errName, checks: cks }),
				...(cks?.length ? { checks: cks } : {}),
			});
		};
		worker.onerror = (e) => { clearTimeout(timer); finish({ ok: false, stderr: e.message, errorKind: "runtime" }); };
		worker.postMessage("go");
	});
}

export function CodePlaygroundCard({ part }: ArtifactPartProps) {
	const actions = useContext(ChatActionsContext);
	const input = useMemo(() => parseInput(part), [part]);
	const [code, setCode] = useState(input?.starter ?? "");
	const [runs, setRuns] = useState<RunResult[]>([]);
	const [busy, setBusy] = useState(false);
	const [runnerOk, setRunnerOk] = useState(false);
	const [runnerChecked, setRunnerChecked] = useState(false);
	const [sent, setSent] = useState(false);
	const [prediction, setPrediction] = useState("");
	const [answer, setAnswer] = useState("");
	const [attempts, setAttempts] = useState(0);

	useEffect(() => {
		let alive = true;
		fetch("/api/code/run", { cache: "no-store" })
			.then((r) => (r.ok ? r.json() : { runnerAvailable: false }))
			.then((d: { runnerAvailable?: boolean }) => {
				if (alive) {
					setRunnerOk(Boolean(d.runnerAvailable));
					setRunnerChecked(true);
				}
			})
			.catch(() => alive && setRunnerChecked(true));
		return () => {
			alive = false;
		};
	}, []);

	// Education, not decoration: a non-coding "language" gets no card at all.
	if (!input || !isCodingLanguage(input.language)) return null;
	// Optimistic until the runner check answers: a disabled button on first paint
	// reads as "broken", and the POST reports the truth anyway.
	const needsRunner = input.language in RUNNER_LANGUAGES || Boolean(RUNNER_LANGUAGES[canonicalLanguage(input.language)]);
	const engine = resolveEngine(input.language, runnerOk || !runnerChecked);
	const last = runs[runs.length - 1];

	async function run() {
		setBusy(true);
		setAttempts((n) => n + 1);
		let result: RunResult;
		if (engine.kind === "native") {
			const runnable = await toRunnable(input!.language, code);
			result = await runInWorker(runnable, input!.checks);
		} else if (engine.kind === "runner" || engine.kind === "pyodide" || engine.kind === "pglite") {
			// pyodide/pglite have no client runtime yet; the registry routes those
			// languages to the sandbox, so this branch is the honest executor.
			try {
				const res = await fetch("/api/code/run", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						language: runnerLanguageFor(input!.language) ?? input!.language,
						code,
						checks: input!.checks?.map((ch) => ({
							expr: ch.expr,
							expect: ch.expect,
							label: ch.label ?? ch.expr,
						})),
					}),
				});
				const body = await res.json();
				result = res.ok
					? {
							ok: body.compile?.ok === true && body.run?.exit === 0,
							stdout: body.run?.stdout ?? "",
							stderr: body.run?.stderr,
							compileError: body.compile?.ok ? undefined : body.compile?.stderr,
							timedOut: body.run?.timedOut,
							...(Array.isArray(body.checks) && body.checks.length ? { checks: body.checks } : {}),
							errorKind: classifyRun({
								checks: body.checks,
								compileOk: body.compile?.ok,
								exit: body.run?.exit,
								timedOut: body.run?.timedOut,
							}),
						}
					: { ok: false, stderr: body.error ?? "runner failed", errorKind: "runtime" };
			} catch {
				result = { ok: false, stderr: "could not reach the runner", errorKind: "runtime" };
			}
		} else {
			result = { ok: false, stderr: engine.reason ?? "no engine", errorKind: "runtime" };
		}

		const withPrediction: RunResult =
			prediction.trim() && !result.timedOut && result.errorKind !== "syntax"
				? { ...result, prediction: prediction.trim(), predictionMatch: predictionMatches(prediction, result.stdout ?? "") }
				: result;
		setRuns((prev) => [...prev, withPrediction]);
		setBusy(false);
	}

	const mode = input?.mode ?? "implement";
	const canSend = actions?.canSend ?? true;
	const req = modeRequirements(mode);

	function sendReading() {
		if (!input || !canSend) return;
		actions?.sendText(
			[
				`My reading (mode: ${mode}, language: ${input.language}):`,
				"```",
				(mode === "error-read" ? input.errorText : `${input.starter}\n---vs---\n${input.pair ?? ""}`) ?? "",
				"```",
				`My answer: ${answer.trim() || "(none)"}`,
			].join("\n"),
		);
		setSent(true);
	}

	function send() {
		if (!canSend) return;
		const report: CodePlaygroundReport = {
			language: input!.language,
			engine: engine.kind,
			code,
			attempts,
			sentAt: new Date().toISOString(),
			runs,
		};
		actions?.sendText(formatReport(report));
		setSent(true);
	}

	return (
		<div className="my-4 overflow-hidden rounded-md border border-[var(--border)] bg-[var(--card)]">
			<div className="flex flex-wrap items-center gap-2 border-b border-[var(--border)] bg-[#171717] px-3 py-2">
				<span className="rounded-full border border-[#5a5a5a] px-2 py-0.5 font-mono text-[11px] text-[#cfcfcf]">
					{engine.label}
				</span>
				{!engine.runnable && (
					<span
						className="rounded-full border border-[#5c4a2f] bg-[#211d16] px-2 py-0.5 font-mono text-[11px] text-[#d9a441]"
						title={engine.reason ?? ""}
					>
						{needsRunner && !runnerChecked ? "checking…" : "not runnable here"}
					</span>
				)}
				{mode !== "implement" && (
					<span className="rounded-full border border-[#4a4a6a] bg-[#191924] px-2 py-0.5 font-mono text-[11px] text-[#9a9ad0]">
						{mode}
					</span>
				)}
				<span className="ml-auto" />
			</div>

			<div className="border-b border-[var(--border)] px-3 py-2.5 text-[14.5px] text-[#cfcfcf]">
				{input.task}
			</div>

			{req.editable ? (
				<>
				<label className="flex items-center gap-2 border-b border-[var(--border)] bg-[#151515] px-3 py-2 font-mono text-[11.5px] text-[var(--muted-foreground)]">
					<span className="shrink-0 uppercase tracking-wide">predict</span>
					<input
						value={prediction}
						onChange={(e) => setPrediction(e.target.value)}
						disabled={sent}
						placeholder="what will it print? (guess before you run)"
						className="w-full bg-transparent text-[var(--foreground)] outline-none placeholder:text-[#5a5a5a]"
					/>
				</label>
				<CodeEditor value={code} language={input.language} onChange={setCode} readOnly={false} />

				<div className="flex flex-wrap items-center gap-2 border-t border-[var(--border)] bg-[#171717] px-3 py-2">
					<button
						type="button"
						onClick={() => void run()}
						disabled={!engine.runnable || busy}
						className="rounded-md border border-[var(--foreground)] bg-[var(--foreground)] px-3 py-1 font-mono text-[12px] font-semibold text-[#111] disabled:border-[var(--border)] disabled:bg-[#2a2a2a] disabled:text-[#666]"
					>
						{busy ? "running…" : "▸ Run"}
					</button>
					<button
						type="button"
						onClick={send}
						disabled={sent}
						className="rounded-md border border-[var(--border)] px-3 py-1 font-mono text-[12px] text-[var(--foreground)] hover:bg-[var(--accent)] disabled:opacity-50"
					>
						{!canSend ? "waiting…" : sent ? "Send again" : "Send to teacher"}
					</button>
					<span className="ml-auto font-mono text-[11px] text-[var(--muted-foreground)]">
						attempts: {attempts}
						{engine.runnable ? "" : " · syntax only"}
					</span>
				</div>

				</>
			) : (
				<>
			{mode === "error-read" ? (
				<pre className="max-h-64 overflow-auto border-b border-[var(--border)] bg-[#101010] px-3 py-2.5 font-mono text-[12.5px] leading-relaxed whitespace-pre-wrap text-[#e06c75]">
					{input.errorText ?? "(no error text)"}
				</pre>
			) : (
				<div className="grid grid-cols-1 border-b border-[var(--border)] md:grid-cols-2">
					<pre className="overflow-auto bg-[#111] px-3 py-2.5 font-mono text-[12.5px] leading-relaxed whitespace-pre-wrap text-[#d4d4d4]">
						{input.starter}
					</pre>
					<pre className="overflow-auto border-t border-[var(--border)] bg-[#140f0f] px-3 py-2.5 font-mono text-[12.5px] leading-relaxed whitespace-pre-wrap text-[#e0a0a0] md:border-t-0 md:border-l">
						{input.pair ?? ""}
					</pre>
				</div>
			)}
			<textarea
				value={answer}
				onChange={(e) => setAnswer(e.target.value)}
				rows={3}
				placeholder={mode === "error-read" ? "what does the error say, which line, what is your fix?" : "what differs, and what will the second one do?"}
				className="w-full resize-none bg-[#151515] px-3 py-2 font-mono text-[12.5px] text-[var(--foreground)] outline-none placeholder:text-[#5a5a5a]"
			/>
			<div className="flex flex-wrap items-center gap-2 border-t border-[var(--border)] bg-[#171717] px-3 py-2">
				<button
					type="button"
					onClick={sendReading}
					disabled={!canSend}
					className="rounded-md border border-[var(--foreground)] bg-[var(--foreground)] px-3 py-1 font-mono text-[12px] font-semibold text-[#111] disabled:border-[var(--border)] disabled:bg-[#2a2a2a] disabled:text-[#666]"
				>
					{!canSend ? "waiting…" : sent ? "Send again" : "Send answer"}
				</button>
				<span className="ml-auto font-mono text-[11px] text-[var(--muted-foreground)]">{mode}</span>
			</div>
				</>
			)}
			{last && (
				<div className="border-t border-[var(--border)] bg-[#101010] px-3 py-2.5 font-mono text-[12.5px] leading-relaxed">
					{last.prediction !== undefined ? (
						<span className={`mb-1 block text-[11.5px] ${last.predictionMatch ? "text-[#5fbf7f]" : "text-[#d9a441]"}`}>
							{last.predictionMatch ? "✓ your prediction matched" : `✗ you predicted ${JSON.stringify(last.prediction)}`}
						</span>
					) : null}
					{last.compileError ? (
						<>
							<span className="block text-[11px] uppercase tracking-wide text-[var(--muted-foreground)]">compile error</span>
							<span className="whitespace-pre-wrap text-[#e06c75]">{last.compileError}</span>
						</>
					) : (
						<>
							<span className="block text-[11px] uppercase tracking-wide text-[var(--muted-foreground)]">stdout</span>
							<span className={`whitespace-pre-wrap ${last.ok ? "text-[#5fbf7f]" : "text-[#e06c75]"}`}>
								{last.timedOut ? "timed out — infinite loop?" : last.stdout || last.stderr || "(no output)"}
							</span>
						</>
					)}
					{input.checks?.length && !last.checks?.length ? (
						<span className="mt-2 block text-[11.5px] text-[var(--muted-foreground)]">
							this engine cannot evaluate checks — the teacher receives your code and the output
						</span>
					) : null}
					{last.checks?.length ? (
						<span className="mt-2 block">
							<span className="block text-[11px] uppercase tracking-wide text-[var(--muted-foreground)]">checks</span>
							{last.checks.map((ch) => (
								<span key={ch.label} className={`block ${ch.pass ? "text-[#5fbf7f]" : "text-[#e06c75]"}`}>
									{ch.pass ? "✓" : "✗"} {ch.label}
								</span>
							))}
						</span>
					) : null}
				</div>
			)}

			{!engine.runnable && (
				<div className="border-t border-[var(--border)] bg-[#101010] px-3 py-2 font-mono text-[11.5px] text-[var(--muted-foreground)]">
					{engine.reason}
				</div>
			)}
		</div>
	);
}

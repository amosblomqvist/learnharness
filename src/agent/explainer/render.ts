import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import type { ExplainerWorkerReply as WorkerReply, ExplainerWorkerRequest, ExplainerWorkerResponse } from "./render-worker.mjs";
import { BLOCKED_FONT_HOSTS, findExternalLoads, stripFontLoads, stripInlinedScript, toInlinedScript, withContentSecurityPolicy } from "./sanitize.ts";

export const EXPLAINER_RENDER_TIMEOUT_MS = 20_000;
export const EXPLAINER_SOURCE_FILENAME = "explainer.src.html";

export type ExplainerRenderOptions = { timeoutMs?: number };
export type ExplainerRenderResult =
	| { ok: true; html: string; warnings: string[] }
	| { ok: false; errors: string[] };

// The worker is never imported here (it would load the renderer into the bundle), so its reply
// constant is restated; the annotation keeps it equal to the declaration in render-worker.d.mts.
const ExplainerWorkerReply: typeof WorkerReply = {
	RENDERED: "explainer-rendered",
	FAILED: "explainer-failed",
};

const VE_ASK = /<ve-ask[\s>/]/i;
const VE_ASK_UNSUPPORTED = "<ve-ask> is not supported";
// A plan page's script reads the in-page reply (kit/reply.js) that is removed here, so it would break.
const VE_PLAN = /<ve-plan[\s>/]/i;
const VE_PLAN_UNSUPPORTED = "Visual plans (<ve-plan>) are not available in an Explainer. Write the page without <ve-plan>.";
const REPLY_NOT_REMOVED = "Could not remove the reply script from the rendered page";
const externalLoad = (url: string) => `External resource is not allowed: ${url}`;
const timedOut = (ms: number) => `Explainer render timed out after ${ms} ms`;
const workerExited = (code: number) => `Explainer render worker exited with code ${code}`;

// The renderer reads its CSS and JS relative to its own file, so it stays unbundled and is
// read at this cwd-relative path (the packaged server's cwd is the standalone root).
const fromCwd = (relative: string) => path.join(/* turbopackIgnore: true */ process.cwd(), relative);
const WORKER_PATH = "src/agent/explainer/render-worker.mjs";
const REPLY_SCRIPT_PATH = "src/agent/explainer-kit/kit/reply.js";

function isWorkerResponse(value: unknown): value is ExplainerWorkerResponse {
	if (value === null || typeof value !== "object" || !("type" in value)) return false;
	return value.type === ExplainerWorkerReply.RENDERED || value.type === ExplainerWorkerReply.FAILED;
}

async function runWorker(workerPath: string, request: ExplainerWorkerRequest, timeoutMs: number): Promise<ExplainerWorkerResponse> {
	const worker = new Worker(workerPath);
	let timer: NodeJS.Timeout | undefined;
	try {
		return await new Promise((resolve) => {
			let settled = false;
			const settle = (response: ExplainerWorkerResponse) => {
				if (settled) return;
				settled = true;
				resolve(response);
			};
			const fail = (message: string) => settle({ type: ExplainerWorkerReply.FAILED, errors: [message] });
			timer = setTimeout(() => fail(timedOut(timeoutMs)), timeoutMs);
			worker.on("message", (message: unknown) => {
				// Ignore Node's own worker-channel messages (for example node --watch).
				if (isWorkerResponse(message)) settle(message);
			});
			worker.once("error", (error) => fail(error.message));
			worker.once("exit", (code) => fail(workerExited(code)));
			worker.postMessage(request);
		});
	} finally {
		clearTimeout(timer);
		void worker.terminate().catch(() => undefined);
	}
}

/** Renders a page source with the bundled renderer into a self-contained HTML page, or the reasons it cannot. */
export async function renderExplainer(source: string, options?: ExplainerRenderOptions): Promise<ExplainerRenderResult> {
	if (VE_ASK.test(source)) return { ok: false, errors: [VE_ASK_UNSUPPORTED] };
	if (VE_PLAN.test(source)) return { ok: false, errors: [VE_PLAN_UNSUPPORTED] };
	const timeoutMs = options?.timeoutMs ?? EXPLAINER_RENDER_TIMEOUT_MS;
	const root = await mkdtemp(path.join(tmpdir(), "explainer-render-"));
	let response: ExplainerWorkerResponse;
	try {
		response = await runWorker(fromCwd(WORKER_PATH), { source, root, filename: EXPLAINER_SOURCE_FILENAME }, timeoutMs);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
	if (response.type === ExplainerWorkerReply.FAILED) return { ok: false, errors: response.errors };

	let html = stripFontLoads(response.html, BLOCKED_FONT_HOSTS);
	if (response.kit) {
		const stripped = stripInlinedScript(html, toInlinedScript(await readFile(fromCwd(REPLY_SCRIPT_PATH), "utf8")));
		if (stripped === null) return { ok: false, errors: [REPLY_NOT_REMOVED] };
		html = stripped;
	}
	const external = findExternalLoads(html);
	if (external.length) return { ok: false, errors: external.map(externalLoad) };
	return { ok: true, html: withContentSecurityPolicy(html), warnings: response.warnings };
}

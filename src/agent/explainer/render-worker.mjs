// Renders one page source with the bundled visual-explainer renderer, off the server's main thread.
// The renderer reads its CSS and JS relative to its own file, so it runs unbundled (see render.ts).
import { parentPort } from "node:worker_threads";
import { prepareRenderedHtml, renderPageForHost } from "../explainer-kit/kit/render.mjs";

export const ExplainerWorkerReply = { RENDERED: "explainer-rendered", FAILED: "explainer-failed" };

/** The `- ` lines after `Warnings:` in the renderer's note (empty when there is none). */
function warningsOf(note) {
	const at = typeof note === "string" ? note.indexOf("\nWarnings:\n") : -1;
	if (at < 0) return [];
	return note.slice(at + "\nWarnings:\n".length).split("\n").filter((line) => line.startsWith("- ")).map((line) => line.slice(2));
}

/** The `- ` lines of the renderer's "N error(s); nothing was written:" error, or the whole message as one. */
function errorsOf(error) {
	const message = error instanceof Error ? error.message : String(error);
	const lines = message.split("\n").slice(1).filter((line) => line.startsWith("- ")).map((line) => line.slice(2));
	return lines.length ? lines : [message];
}

function render({ source, root, filename }) {
	try {
		const result = renderPageForHost(source, { root, filename, sendBack: false, models: false });
		if (result === null) return { type: ExplainerWorkerReply.RENDERED, html: source, warnings: [], kit: false };
		return { type: ExplainerWorkerReply.RENDERED, html: prepareRenderedHtml(result.html), warnings: warningsOf(result.note), kit: true };
	} catch (error) {
		return { type: ExplainerWorkerReply.FAILED, errors: errorsOf(error) };
	}
}

parentPort?.once("message", (request) => {
	parentPort?.postMessage(render(request));
});

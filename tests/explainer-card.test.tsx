import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SubagentSteerCard } from "../components/artifacts/steer-card.tsx";
import { artifactRenderers } from "../components/artifacts/index.ts";
import { ExplainerCard } from "../components/artifacts/explainer-card.tsx";
import { PageOverlay, SessionMermaidContext, isPageEscapeMessage, withPageEscape } from "../components/session-overlay.tsx";
import { JobsContext } from "../components/jobs-context.ts";
import { ActivitySection, type ActivityFeed } from "../components/activity-dock.tsx";
import { buildSubagentSteer } from "../src/core/contracts.ts";
import type { JobRecord } from "../src/core/contracts.ts";
import { projectView } from "../src/core/view.ts";

// The explainer card (PBI-21): the delivered HTML page, shrunk into a
// sandboxed iframe; the tool-call box is the shared DispatchCard; the
// activity dock names the job.

const PAGE_HTML = "<!doctype html><html><body><h1>Pendulum</h1><script>let t=0;</script></body></html>";

function steerCard(result: { title: string; html: string; notes?: string }): string {
	const steer = buildSubagentSteer({ id: "je", kind: "explainer", toolCallId: "ce" }, result);
	return renderToStaticMarkup(<SubagentSteerCard message={projectView([steer])[0] as never} />);
}

describe("explainer steer card", () => {
	it("renders a sandboxed iframe (allow-scripts only) with the result HTML and the title", () => {
		const html = steerCard({ title: "How a pendulum swings", html: PAGE_HTML });
		assert.match(html, /<iframe/);
		assert.match(html, /sandbox="allow-scripts"/);
		assert.ok(!html.includes("allow-same-origin"), "never grant the same origin");
		assert.ok(html.includes("Pendulum"), "srcDoc carries the result HTML");
		assert.ok(html.includes("let t=0;"), "the script rides along untouched");
		assert.match(html, /scrolling="no"/);
		assert.match(html, /How a pendulum swings/);
		assert.match(html, /explainer/);
	});

	it("draws the iframe at a virtual width and shrinks it with a CSS scale", () => {
		const html = steerCard({ title: "T", html: PAGE_HTML });
		assert.match(html, /transform:\s*scale\(/);
		assert.match(html, /width:\s*1200px/);
	});

	it("shows the failure note and no iframe when the writer FAILED", () => {
		const html = steerCard({ title: "T", html: "", notes: "FAILED: kit validation never passed" });
		assert.ok(!html.includes("<iframe"), "no iframe for a failed page");
		assert.match(html, /FAILED: kit validation never passed/);
		assert.match(html, /Explainer/);
	});

	it("shows a could-not-be-displayed box when the result is not {title, html}", () => {
		const steer = buildSubagentSteer({ id: "je", kind: "explainer", toolCallId: "ce" }, { title: "T", html: "x" });
		(steer.details as { result: unknown }).result = { nope: true };
		const html = renderToStaticMarkup(<SubagentSteerCard message={projectView([steer])[0] as never} />);
		assert.match(html, /could not be displayed/);
		assert.ok(!html.includes("<iframe"));
	});

	it("does not throw on an unknown kind: it renders a could-not-be-displayed box", () => {
		const steer = buildSubagentSteer({ id: "je", kind: "explainer", toolCallId: "ce" }, { title: "T", html: "x" });
		(steer.details as { kind: string }).kind = "unknown";
		let html = "";
		assert.doesNotThrow(() => {
			html = renderToStaticMarkup(<SubagentSteerCard message={projectView([steer])[0] as never} />);
		});
		assert.match(html, /could not be displayed/);
		assert.ok(!html.includes("<iframe"));
	});
});

// PBI-22: fullscreen + download. The fullscreen button only shows under a chat
// page that provides openPage; the overlay is a sandboxed iframe too.

function steerCardWith(result: { title: string; html: string; notes?: string }, openPage?: (html: string, title: string) => void): string {
	const steer = buildSubagentSteer({ id: "je", kind: "explainer", toolCallId: "ce" }, result);
	return renderToStaticMarkup(
		<SessionMermaidContext.Provider value={{ openMermaid: () => {}, openFigure: () => {}, openPage }}>
			<SubagentSteerCard message={projectView([steer])[0] as never} />
		</SessionMermaidContext.Provider>,
	);
}

describe("explainer card buttons (PBI-22)", () => {
	it("has a download button on a successful card", () => {
		const html = steerCard({ title: "T", html: PAGE_HTML });
		assert.match(html, /data-testid="explainer-download"/);
		assert.match(html, /aria-label="Download explainer as HTML"/);
	});

	it("shows the fullscreen button only when openPage is provided", () => {
		const withOpen = steerCardWith({ title: "T", html: PAGE_HTML }, () => {});
		assert.match(withOpen, /data-testid="explainer-open"/);
		assert.match(withOpen, /aria-label="Open explainer fullscreen"/);
		const withoutProvider = steerCard({ title: "T", html: PAGE_HTML });
		assert.ok(!withoutProvider.includes("explainer-open"), "no provider: no fullscreen button");
		const withoutOpenPage = steerCardWith({ title: "T", html: PAGE_HTML });
		assert.ok(!withoutOpenPage.includes("explainer-open"), "provider without openPage: no fullscreen button");
	});

	it("shows neither button on a failed card", () => {
		const html = steerCardWith({ title: "T", html: "", notes: "FAILED: x" }, () => {});
		assert.ok(!html.includes("explainer-download"));
		assert.ok(!html.includes("explainer-open"));
	});

	it("does not put the Esc script into the card's iframe", () => {
		const html = steerCardWith({ title: "T", html: PAGE_HTML }, () => {});
		assert.ok(!html.includes("explainer-page-escape"));
	});
});

describe("PageOverlay (PBI-22)", () => {
	it("renders a sandboxed iframe (allow-scripts only) with the HTML, the title and a close button", () => {
		const markup = renderToStaticMarkup(<PageOverlay html={PAGE_HTML} title="How a pendulum swings" onClose={() => {}} />);
		assert.match(markup, /<iframe/);
		assert.match(markup, /sandbox="allow-scripts"/);
		assert.ok(!markup.includes("allow-same-origin"), "never grant the same origin");
		assert.ok(markup.includes("Pendulum"), "srcDoc carries the HTML");
		assert.match(markup, /title="How a pendulum swings"/);
		assert.match(markup, /data-testid="page-overlay-close"/);
		assert.match(markup, /data-testid="page-overlay"/);
	});

	it("puts the Esc script into the overlay's srcDoc, before </body>", () => {
		const markup = renderToStaticMarkup(<PageOverlay html={PAGE_HTML} title="T" onClose={() => {}} />);
		assert.ok(markup.includes("explainer-page-escape"), "overlay srcDoc reports Esc to the parent");
	});

	it("withPageEscape adds the script (before </body>, else at the end); the plain HTML has none", () => {
		assert.ok(!PAGE_HTML.includes("explainer-page-escape"), "the download HTML stays untouched");
		const withBody = withPageEscape(PAGE_HTML);
		assert.ok(withBody.includes("explainer-page-escape"));
		assert.ok(withBody.indexOf("explainer-page-escape") < withBody.indexOf("</body>"));
		const bodyless = withPageEscape("<p>x</p>");
		assert.ok(bodyless.startsWith("<p>x</p>"));
		assert.ok(bodyless.includes("explainer-page-escape"));
	});

	it("isPageEscapeMessage accepts only the frame's own explainer-page-escape", () => {
		const frame = {};
		const other = {};
		assert.equal(isPageEscapeMessage(frame, { type: "explainer-page-escape" }, frame), true);
		assert.equal(isPageEscapeMessage(other, { type: "explainer-page-escape" }, frame), false, "another source");
		assert.equal(isPageEscapeMessage(frame, { type: "demo-resize", height: 10 }, frame), false, "another kind");
		assert.equal(isPageEscapeMessage(frame, "explainer-page-escape", frame), false, "not an object");
		assert.equal(isPageEscapeMessage(frame, null, frame), false);
		assert.equal(isPageEscapeMessage(null, { type: "explainer-page-escape" }, null), false, "no frame yet");
		assert.equal(isPageEscapeMessage(null, { type: "explainer-page-escape" }, undefined), false);
	});
});

describe("explainer tool-call box", () => {
	const ackPart = { type: "tool-explainer", state: "output-available", toolCallId: "call-1", input: { title: "T", brief: "b" }, output: "Dispatched (job j1)." };

	it("is registered as ExplainerCard", () => {
		assert.equal(artifactRenderers.explainer, ExplainerCard);
	});

	it("renders the DispatchCard on output-available", () => {
		const html = renderToStaticMarkup(
			<JobsContext.Provider value={[]}>
				<ExplainerCard part={ackPart as never} />
			</JobsContext.Provider>,
		);
		assert.match(html, /data-testid="dispatch-card"|data-testid="dispatch-settled"/);
		assert.match(html, /Explainer agent/);
	});

	it("renders the settled one-liner once the job is done", () => {
		const job = { id: "j1", kind: "explainer", chatId: "c", toolCallId: "call-1", status: "done", activity: "delivered", createdAt: new Date(Date.now() - 5000).toISOString(), updatedAt: new Date().toISOString() } as JobRecord;
		const html = renderToStaticMarkup(
			<JobsContext.Provider value={[job]}>
				<ExplainerCard part={ackPart as never} />
			</JobsContext.Provider>,
		);
		assert.match(html, /dispatch-settled/);
		assert.match(html, /Explainer agent/);
		assert.match(html, /finished/);
	});

	it("renders nothing before the ack lands", () => {
		const html = renderToStaticMarkup(<ExplainerCard part={{ ...ackPart, state: "input-available" } as never} />);
		assert.equal(html, "");
	});
});

describe("activity dock", () => {
	it("names an explainer job 'Explainer writer'", () => {
		const now = Date.now();
		const feed: ActivityFeed = {
			jobs: [
				{
					id: "j1",
					kind: "explainer",
					chatId: "c1",
					toolCallId: "t1",
					status: "running",
					activity: "writing the page…",
					createdAt: new Date(now - 45_000).toISOString(),
					updatedAt: new Date(now - 1000).toISOString(),
					title: "Pendulum lesson",
					contextLimit: null,
					costUsd: null,
				} as ActivityFeed["jobs"][number],
			],
			extractions: [],
		};
		const html = renderToStaticMarkup(<ActivitySection feed={feed} />);
		assert.match(html, /Explainer writer/);
		assert.doesNotMatch(html, /Sub-agent/);
		assert.doesNotMatch(html, /Demo builder/);
	});
});

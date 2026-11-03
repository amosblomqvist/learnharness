import React from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { PluginWorkerResultSurface } from "../components/plugin-worker-result.tsx";
import { WorkerResultDetails } from "../components/artifacts/worker-result-presentation.tsx";
import { SubagentSteerCard } from "../components/artifacts/steer-card.tsx";
import { buildSubagentSteer, projectView } from "../src/core/index.ts";

for (const status of ["succeeded", "failed", "cancelled", "interrupted"] as const) {
	for (const presentation of ["collapsed", "card", "plain"] as const) {
		it(`${presentation} ${status} result shows only its native outcome icon and worker label, with accessible status`, () => {
			const html = renderToStaticMarkup(<PluginWorkerResultSurface label="Example worker" status={status} presentation={presentation} text="Readable result" />);
			const { document } = parseHTML(html);
			const header = document.querySelector('[data-testid="plugin-worker-header"]')!;
			assert.ok(header);
			assert.equal(header.getAttribute("title"), null, "outcomes use the application Hint, not a browser-only tooltip");
			assert.equal(header.getAttribute("data-slot"), "tooltip-trigger");
			assert.equal(header.getAttribute("tabindex"), null, "Hint does not add a focus stop");
			assert.equal(header.querySelector("button"), null);
			assert.equal(header.querySelector(".sr-only")?.textContent, ` ${status}`);
			assert.equal(header.textContent, `Example worker ${status}`);
			const visibleHeader = header.cloneNode(true) as HTMLElement;
			visibleHeader.querySelectorAll(".sr-only").forEach(node => node.remove());
			assert.equal(visibleHeader.textContent, "Example worker", "no generic prefix or written status in the visible heading");
			assert.doesNotMatch(header.textContent!, /Background result|view result|hide result/);
			const icon = header.querySelector("svg")!;
			const expected = status === "succeeded" ? "lucide-check" : status === "failed" ? "lucide-x" : "lucide-circle-x";
			assert.ok(icon.classList.contains(expected), `uses existing native ${expected} glyph`);
			assert.equal(icon.classList.contains("text-red-500"), status === "failed");
			assert.equal(icon.getAttribute("aria-hidden"), "true", "status is announced once through text, not the glyph");
			assert.match(html, /Readable result/);
			if (presentation === "collapsed") {
				const details = document.querySelector("details")!;
				assert.equal(details.hasAttribute("open"), false);
				assert.equal(header.tagName, "SUMMARY");
				assert.equal(details.firstElementChild, header, "asChild preserves summary as the first native details child");
				const chevron = header.querySelector(".lucide-chevron-right")!;
				assert.ok(chevron);
				assert.ok(chevron.classList.contains("group-open:rotate-90"));
				assert.equal(chevron.getAttribute("aria-hidden"), "true");
				assert.equal(header.querySelectorAll("svg").length, 2);
			} else {
				assert.equal(document.querySelector("details"), null);
				assert.equal(header.querySelectorAll("svg").length, 1);
				assert.equal(header.querySelector(".lucide-chevron-right"), null);
			}
		});
	}
}

it("shared native brief disclosure retains its default check and view/hide wording", () => {
	const html = renderToStaticMarkup(<WorkerResultDetails heading="Native brief">Full brief</WorkerResultDetails>);
	const { document } = parseHTML(html);
	const summary = document.querySelector("summary")!;
	assert.equal(summary.textContent, "Native briefview briefhide brief");
	assert.ok(summary.querySelector(".lucide-check"));
	assert.equal(summary.querySelector(".lucide-chevron-right"), null);
	assert.equal(summary.getAttribute("title"), null);
	assert.equal(summary.getAttribute("data-slot"), null, "native brief defaults do not opt into a Hint");
	assert.equal(document.querySelector("details")!.hasAttribute("open"), false);
});

it("native Research and PDF completion callers keep their captions and brief disclosures unchanged", () => {
	const cases = [
		{
			marker: buildSubagentSteer({ id: "research-fixture", kind: "research", toolCallId: "research-call" }, {
				brief: "Synthetic research brief.", sources: [{ title: "Fixture", url: "https://example.invalid/source" }],
			}),
			testId: "research-complete-badge", caption: "Researchcomplete· 1 sourcesview briefhide brief",
		},
		{
			marker: buildSubagentSteer({ id: "pdf-fixture", kind: "pdf", toolCallId: "pdf-call" }, {
				path: "/fixture/example.pdf", question: "Fixture question", brief: "Synthetic PDF brief.", pagesRead: [1], pagesConsulted: [1],
			}),
			testId: "pdf-complete-badge", caption: "PDFreading complete· read 1 pageview briefhide brief",
		},
	];
	for (const { marker, testId, caption } of cases) {
		const html = renderToStaticMarkup(<SubagentSteerCard message={projectView([marker])[0]!} />);
		const { document } = parseHTML(html);
		const details = document.querySelector(`[data-testid="${testId}"]`)!;
		assert.ok(details);
		assert.equal(details.hasAttribute("open"), false);
		const summary = details.querySelector("summary")!;
		assert.equal(summary.textContent, caption);
		assert.equal(summary.getAttribute("data-slot"), null, "Research/PDF keep their unwrapped, tooltip-free summaries");
		assert.equal(details.firstElementChild, summary);
		assert.ok(summary.querySelector(".lucide-check"));
		assert.equal(summary.querySelector(".lucide-chevron-right"), null);
	}
});

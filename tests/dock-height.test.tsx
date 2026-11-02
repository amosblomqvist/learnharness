import React, { act, useLayoutEffect, useRef, useState } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { QuestionDock } from "../components/question-dock.tsx";
import { PracticeDock } from "../components/practice-dock.tsx";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window, document: dom.document, HTMLElement: dom.window.HTMLElement,
	IS_REACT_ACT_ENVIRONMENT: true,
});
const observers: TestObserver[] = [];
class TestObserver {
	elements = new Set<Element>();
	disconnected = false;
	constructor(readonly callback: () => void) { observers.push(this); }
	observe(el: Element) { this.elements.add(el); }
	disconnect() { this.disconnected = true; this.elements.clear(); }
}
Object.assign(globalThis, {
	ResizeObserver: TestObserver,
	getComputedStyle: (el: HTMLElement) => ({
		borderTopWidth: el.dataset.part === "shell" ? "1px" : "0px",
		borderBottomWidth: el.dataset.part === "shell" ? "1px" : "0px",
		paddingTop: el.hasAttribute("data-dock-scroll-area") ? "12px" : "0px",
		paddingBottom: "0px",
		overflowY: el.style.overflowY || (el.classList.contains("overflow-y-auto") ? "auto" : "visible"),
	}),
});
// Import after installing window so the hook uses its browser layout effect.
const { dockHeightBudget, syncDockHeight, useDockHeight, forwardDockWheel } = await import("../components/dock-height.ts");

const normal = {
	columnHeight: 700, outsideHeight: 60, beforeShellHeight: 0,
	shellBorderHeight: 2, contentHeight: 800, questionHeight: 600,
	questionPaddingHeight: 12,
};

describe("dockHeightBudget — whole dock, not just its question", () => {
	it("subtracts answer controls, toolbar, borders and breathing gap", () => {
		assert.deepEqual(dockHeightBudget(normal), {
			viewportMaxHeight: 608, shellMaxHeight: 608, questionMaxHeight: 406, scrollWholeContent: false,
		});
	});
	it("accounts for growing answer fields and the separate reading draft", () => {
		const result = dockHeightBudget({ ...normal, beforeShellHeight: 170, contentHeight: 880 });
		assert.equal(result.questionMaxHeight, 156);
		assert.equal(result.shellMaxHeight, 438);
	});
	it("preserves a computed zero and deliberately selects whole-content scrolling", () => {
		const result = dockHeightBudget({ ...normal, columnHeight: 292 });
		assert.equal(result.questionMaxHeight, 0);
		assert.equal(result.scrollWholeContent, true);
	});
	it("switches before padding would leave a zero-sized content viewport, without an invented minimum", () => {
		assert.equal(dockHeightBudget({ ...normal, columnHeight: 306 }).scrollWholeContent, true);
		assert.equal(dockHeightBudget({ ...normal, columnHeight: 307 }).scrollWholeContent, false);
	});
	it("never creates negative caps, even if the toolbar exceeds the column", () => {
		const result = dockHeightBudget({ ...normal, columnHeight: 20 });
		assert.equal(result.viewportMaxHeight, 0);
		assert.equal(result.shellMaxHeight, 0);
		assert.equal(result.questionMaxHeight, 0);
		assert.equal(result.scrollWholeContent, true);
	});
	it("collapsed bars use their visible height, and a tall reading draft can still scroll", () => {
		assert.equal(dockHeightBudget({ ...normal, questionHeight: null, contentHeight: 42 }).scrollWholeContent, false);
		assert.equal(dockHeightBudget({ ...normal, questionHeight: null, contentHeight: 42, beforeShellHeight: 650 }).scrollWholeContent, true);
	});
});

// These mocked dimensions test the DOM/lifecycle seam, not real CSS layout.
// Live-browser checks separately exercise actual field sizing and WAAPI.
const sizes: Record<string, number> = {};
let animating = false;
dom.window.HTMLElement.prototype.getAnimations = () => animating ? [{} as Animation] : [];
const resetSizes = () => Object.assign(sizes, { column: 700, block: 862, viewport: 802, body: 802, shell: 802, content: 800, question: 600 });
const originalRect = dom.window.HTMLElement.prototype.getBoundingClientRect;
dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
	const part = this.hasAttribute("data-dock-scroll-area") ? "question" : this.dataset.part;
	if (part && part in sizes) return { height: sizes[part]!, width: 700, x: 0, y: 0, top: 0, left: 0, bottom: sizes[part]!, right: 700, toJSON() {} };
	return originalRect.call(this);
};
Object.defineProperty(dom.window.HTMLElement.prototype, "clientHeight", { configurable: true, get() { return this.dataset.part === "column" ? sizes.column : Number(this.dataset.clientHeight ?? 0); } });
Object.defineProperty(dom.window.HTMLElement.prototype, "clientWidth", { configurable: true, get() { return this.dataset.part === "column" ? 680 : 700; } });
Object.defineProperty(dom.window.HTMLElement.prototype, "offsetWidth", { configurable: true, get() { return 700; } });
Object.defineProperty(dom.window.HTMLElement.prototype, "scrollHeight", { configurable: true, get() { return Number(this.dataset.scrollHeight ?? 0); } });

const ignoreHeight = () => {};
function Fixture({ expanded = true, practice = false, enabled = true, inspected, onHeight = ignoreHeight }: {
	expanded?: boolean; practice?: boolean; enabled?: boolean; inspected?: (block: HTMLDivElement) => void;
	onHeight?: (height: number) => void;
}) {
	const scrollRef = useRef<HTMLDivElement>(null);
	const blockRef = useRef<HTMLDivElement>(null);
	const viewportRef = useRef<HTMLDivElement>(null);
	const bodyRef = useRef<HTMLDivElement>(null);
	const shellRef = useRef<HTMLDivElement>(null);
	const contentRef = useRef<HTMLDivElement>(null);
	const [inset, setInset] = useState(0);
	useDockHeight({ scrollRef, blockRef, viewportRef, bodyRef, shellRef, contentRef,
		expanded, enabled, mode: practice ? "practice:p1" : "question:q1", onScrollbarInset: setInset, onHeight });
	// Like DockOverlay's later morph/reserve layout effect: constraints must
	// already be applied in this same commit, not an after-paint correction.
	useLayoutEffect(() => { if (blockRef.current) inspected?.(blockRef.current); });
	return <><div ref={scrollRef} data-part="column" /><div ref={blockRef} data-part="block" data-inset={inset}>
		<div ref={viewportRef} data-part="viewport"><div ref={bodyRef} data-part="body">
			<div ref={shellRef} data-part="shell"><div ref={contentRef} data-part="content" key={practice ? "practice" : "question"}>
				{practice ? <PracticeDock problemCallId="p1" input={{ statement: "Long practice problem" }} expanded={expanded} onExpand={() => {}} onSubmit={() => {}} />
					: <QuestionDock toolName="probe" toolCallId="q1" input={{ question: "Long teaching question", options: [{ label: "A" }, { label: "B" }], correctAnswer: "A", explanation: "A is correct." }} expanded={expanded} dictationClaim={false} onExpand={() => {}} onSubmit={() => {}} />}
			</div></div>
		</div></div><div data-testid="toolbar" />
	</div></>;
}

async function withFixture(run: (host: HTMLElement, render: (props?: React.ComponentProps<typeof Fixture>) => Promise<void>) => Promise<void>) {
	resetSizes();
	const host = document.createElement("div"); document.body.append(host);
	const root = createRoot(host);
	const render = async (props = {}) => { await act(async () => root.render(<Fixture {...props} />)); };
	try { await run(host, render); }
	finally { await act(async () => root.unmount()); host.remove(); }
}
const part = (host: HTMLElement, name: string) => host.querySelector<HTMLElement>(`[data-part="${name}"]`)!;

describe("measured question/practice DOM and observer lifecycle", () => {
	it("applies constraints before the morph layout effect and handles classic scrollbar insets", async () => {
		await withFixture(async (host, render) => {
			await render({ inspected: block => assert.equal(block.style.getPropertyValue("--dock-max-h"), "406px") });
			assert.equal(part(host, "block").dataset.inset, "10");
			assert.equal(part(host, "viewport").style.overflowY, "visible");
			assert.ok(!part(host, "viewport").contains(host.querySelector('[data-testid="toolbar"]')));
		});
	});
	it("excludes the animated/clamped shell height rather than treating it as answer chrome", async () => {
		await withFixture(async (host, render) => {
			await render();
			Object.assign(sizes, { block: 160, viewport: 100, body: 100, shell: 100 });
			await act(async () => observers.at(-1)!.callback());
			assert.equal(part(host, "block").style.getPropertyValue("--dock-max-h"), "406px");
		});
	});
	it("ignores the still-mounted hidden teaching form and sizes it synchronously on reveal", async () => {
		await withFixture(async (host, render) => {
			Object.assign(sizes, { block: 104, viewport: 44, body: 44, shell: 44, content: 42, question: 2000 });
			await render({ expanded: false });
			assert.ok(host.querySelector('[data-dock-scroll-area]'), "teaching form remains mounted");
			assert.equal(part(host, "block").style.getPropertyValue("--dock-max-h") || "", "");
			assert.equal(part(host, "viewport").style.overflowY, "visible");
			resetSizes();
			await render({ expanded: true, inspected: block => assert.equal(block.style.getPropertyValue("--dock-max-h"), "406px") });
		});
	});
	it("reconnects to practice's newly mounted question after collapsing and revealing", async () => {
		await withFixture(async (host, render) => {
			Object.assign(sizes, { block: 104, viewport: 44, body: 44, shell: 44, content: 42 });
			await render({ practice: true, expanded: false });
			const collapsedObserver = observers.at(-1)!;
			assert.equal(host.querySelector('[data-dock-scroll-area]'), null);
			resetSizes();
			await render({ practice: true, expanded: true });
			assert.equal(collapsedObserver.disconnected, true);
			assert.ok(observers.at(-1)!.elements.has(host.querySelector('[data-dock-scroll-area]')!));
			assert.equal(part(host, "block").style.getPropertyValue("--dock-max-h"), "406px");
		});
	});
	it("intentionally uncaps the question for a short window, then restores the measured cap on growth", async () => {
		await withFixture(async (host, render) => {
			sizes.column = 292;
			await render();
			assert.equal(part(host, "block").style.getPropertyValue("--dock-max-h"), "none");
			assert.equal(part(host, "viewport").style.overflowY, "auto");
			assert.equal(part(host, "viewport").style.maxHeight, "200px");
			assert.equal(part(host, "shell").style.maxHeight, "none");
			sizes.column = 700;
			await act(async () => observers.at(-1)!.callback());
			assert.equal(part(host, "block").style.getPropertyValue("--dock-max-h"), "406px");
			assert.equal(part(host, "viewport").style.overflowY, "visible");
		});
	});
	it("removes constraints in composer mode and disconnects observers on unmount", async () => {
		let last: TestObserver;
		await withFixture(async (host, render) => {
			await render();
			await render({ enabled: false });
			assert.equal(part(host, "block").style.getPropertyValue("--dock-max-h") || "", "");
			assert.equal(part(host, "shell").style.maxHeight || "", "");
			last = observers.at(-1)!;
		});
		assert.equal(last!.disconnected, true);
	});
	it("reports child-only resize heights to the reserve, but never mid-morph values", async () => {
		await withFixture(async (_host, render) => {
			const heights: number[] = [];
			await render({ onHeight: h => heights.push(h) });
			assert.equal(heights.at(-1), 862);
			animating = true;
			try {
				sizes.block = 900;
				await act(async () => observers.at(-1)!.callback());
				assert.equal(heights.at(-1), 862, "animated block height was not reserved");
			} finally { animating = false; }
			await act(async () => observers.at(-1)!.callback());
			assert.equal(heights.at(-1), 900, "settled child resize reaches the reserve without a parent render");
		});
	});
	it("reconnects to a new keyed mode even when expansion is unchanged", async () => {
		await withFixture(async (host, render) => {
			await render();
			const previous = observers.at(-1)!;
			const oldContent = part(host, "content");
			await render({ practice: true });
			assert.equal(previous.disconnected, true);
			assert.notEqual(part(host, "content"), oldContent);
			assert.ok(observers.at(-1)!.elements.has(part(host, "content")));
		});
	});
	it("keeps the DOM synchronizer deterministic when observed again with the same dimensions", async () => {
		await withFixture(async (host, render) => {
			await render();
			const elements = { column: part(host, "column"), block: part(host, "block"), viewport: part(host, "viewport"),
				body: part(host, "body"), shell: part(host, "shell"), content: part(host, "content") };
			assert.deepEqual(syncDockHeight(elements, true), syncDockHeight(elements, true));
		});
	});
});

describe("wheel routing — question, short-window content, then transcript", () => {
	it("keeps native wheel input in the question and then the whole-content viewport", () => {
		const root = document.createElement("div");
		root.innerHTML = '<div data-viewport style="overflow-y:auto"><div data-question style="overflow-y:auto"><span>text</span></div></div>';
		const viewport = root.firstElementChild as HTMLElement;
		const question = viewport.firstElementChild as HTMLElement;
		const transcript = document.createElement("div"); transcript.scrollTop = 100;
		for (const el of [viewport, question]) { el.dataset.scrollHeight = "400"; el.dataset.clientHeight = "100"; el.scrollTop = 50; }
		const wheel = (deltaY: number, deltaMode = 0) => {
			let prevented = false;
			forwardDockWheel({ target: question.firstElementChild, deltaY, deltaMode, preventDefault() { prevented = true; } } as unknown as WheelEvent, root, transcript);
			return prevented;
		};
		assert.equal(wheel(-20), false, "question can scroll up");
		question.scrollTop = 0;
		assert.equal(wheel(-20), false, "whole content can scroll up when question is at its edge");
		viewport.scrollTop = 0;
		assert.equal(wheel(-20), true);
		assert.equal(transcript.scrollTop, 80);
		question.scrollTop = viewport.scrollTop = 300;
		assert.equal(wheel(1, 1), true);
		assert.equal(transcript.scrollTop, 96, "line-mode wheel is normalized");
		viewport.style.overflowY = "visible"; viewport.scrollTop = 50;
		assert.equal(wheel(-20), false, "question still consumes upward movement");
		question.style.overflowY = "hidden";
		assert.equal(wheel(-20), true, "hidden and visible boxes are not scroll containers");
		assert.equal(wheel(0), false);
	});
});

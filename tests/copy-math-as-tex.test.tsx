import React, { act, StrictMode } from "react";
(globalThis as { React?: typeof React }).React = React;
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createRoot } from "react-dom/client";
import katex from "katex";
import { parseHTML } from "linkedom";
import CopyMathAsTex from "../components/copy-math-as-tex.tsx";

type Handler = (event: unknown) => void;

describe("CopyMathAsTex", () => {
	it("installs one global copy handler that pastes formulas as TeX source", async () => {
		const inline = katex.renderToString("\\sigma'(z) \\le \\frac14", { throwOnError: false });
		const block = katex.renderToString("\\sum_{k=1}^{5} k", { displayMode: true, throwOnError: false });
		const dom = parseHTML(`<html><body><p id="p">Gradient by ${inline} done.</p><div id="b">${block}</div><div id="host"></div></body></html>`);
		const { document, window } = dom;
		const copyHandlers: Handler[] = [];
		const addEventListener = document.addEventListener.bind(document);
		document.addEventListener = ((type: string, fn: Handler, ...rest: unknown[]) => {
			if (type === "copy") copyHandlers.push(fn);
			return (addEventListener as (...args: unknown[]) => void)(type, fn, ...rest);
		}) as typeof document.addEventListener;

		const previous = Object.getOwnPropertyDescriptors(globalThis);
		Object.assign(globalThis, {
			window, document, Element: window.Element, Text: window.Text, HTMLElement: window.HTMLElement,
			IS_REACT_ACT_ENVIRONMENT: true,
		});
		try {
			const root = createRoot(document.getElementById("host")!);
			// StrictMode mounts effects twice; the module cache must keep it at one listener.
			await act(async () => root.render(<StrictMode><CopyMathAsTex /></StrictMode>));
			await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
			assert.equal(copyHandlers.length, 1);
			await act(async () => root.render(<StrictMode><CopyMathAsTex key="remount" /></StrictMode>));
			await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
			assert.equal(copyHandlers.length, 1, "remounting must not add a second listener");

			const copy = (id: string) => {
				const el = document.getElementById(id)!;
				// linkedom's DocumentFragment has a null textContent, so the stub range
				// hands back a <div> holder, which the handler treats the same way.
				const holder = () => {
					const div = document.createElement("div");
					for (const node of [...el.childNodes]) div.appendChild(node.cloneNode(true));
					return div;
				};
				const range = { startContainer: el.firstChild, endContainer: el.lastChild, setStartBefore() {}, setEndAfter() {}, cloneContents: holder };
				(window as unknown as { getSelection: () => unknown }).getSelection = () => ({ isCollapsed: false, getRangeAt: () => range });
				const data: Record<string, string> = {};
				let prevented = false;
				copyHandlers[0]!({ clipboardData: { setData: (k: string, v: string) => (data[k] = v) }, preventDefault: () => (prevented = true) });
				return { plain: data["text/plain"], prevented };
			};

			assert.deepEqual(copy("p"), { plain: "Gradient by $\\sigma'(z) \\le \\frac14$ done.", prevented: true });
			assert.deepEqual(copy("b"), { plain: "$$\\sum_{k=1}^{5} k$$", prevented: true });
			await act(async () => root.unmount());
		} finally {
			for (const key of Object.keys(globalThis)) if (!(key in previous)) delete (globalThis as Record<string, unknown>)[key];
			Object.defineProperties(globalThis, previous);
		}
	});
});

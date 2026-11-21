import assert from "node:assert/strict";
import { test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { MessageResponse } from "../components/ai-elements/message.tsx";
import { MathDisplay } from "../components/md-blocks.tsx";

(globalThis as { React?: typeof React }).React = React;
const { window, document } = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window, document, IS_REACT_ACT_ENVIRONMENT: true });

test("display equation Copy writes the TeX from the rendered formula, including legacy markup", async () => {
	const writes: string[] = [];
	const previous = Object.getOwnPropertyDescriptor(globalThis, "navigator")!;
	Object.defineProperty(globalThis, "navigator", {
		configurable: true,
		value: { clipboard: { writeText: async (text: string) => { writes.push(text); } } },
	});
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	const tex = String.raw`\int_0^1 x^2\,dx = \frac{1}{3}`;
	try {
		await act(async () => root.render(<MessageResponse>{`$$\n${tex}\n$$`}</MessageResponse>));
		assert.equal(host.querySelector("annotation"), null, "the current renderer does not need MathML");
		const copy = () => host.querySelector<HTMLButtonElement>('button[aria-label="Copy equation source"]')!.click();
		await act(async () => copy());
		assert.deepEqual(writes, [tex]);

		await act(async () => root.render(<MathDisplay className="katex-display">
			<span className="katex" dangerouslySetInnerHTML={{ __html: '<math><semantics><annotation encoding="application/x-tex">legacy TeX</annotation></semantics></math>' }} />
		</MathDisplay>));
		await act(async () => copy());
		assert.deepEqual(writes, [tex, "legacy TeX"]);
	} finally {
		await act(async () => root.unmount());
		host.remove();
		Object.defineProperty(globalThis, "navigator", previous);
	}
});

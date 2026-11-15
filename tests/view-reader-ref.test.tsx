/**
 * React's development server renderer seals useRef objects, so a view
 * reader built on useRef threw "Cannot add property changed, object is
 * not extensible" during SSR. useViewReaderRef must survive that render.
 */

import React, { useRef } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToString } from "react-dom/server";
import { useViewReaderRef, type ViewReaderRef } from "../components/session-view-readers.ts";

const notify = () => {};

function WithHelper() {
	const reader = useViewReaderRef<string>();
	reader.changed = notify;
	return <span>{reader.changed === notify ? "ok" : "lost"}</span>;
}

function WithUseRef() {
	const reader = useRef<(() => string) | null>(null) as ViewReaderRef<string>;
	reader.changed = notify;
	return <span>ok</span>;
}

describe("useViewReaderRef", () => {
	it("the useRef form throws under the development server renderer", () => {
		assert.throws(() => renderToString(<WithUseRef />), /not extensible/);
	});

	it("accepts `changed` during a server render", () => {
		assert.match(renderToString(<WithHelper />), /ok/);
	});
});

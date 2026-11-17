import assert from "node:assert/strict";
import { describe, it } from "node:test";
import React, { useState, useRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/** Mirrors the shape `components/chat.tsx` uses for the session view readers:
 * a ref holding a read function, plus a `changed` notifier the component
 * installs so a dock can ask plugins to re-read. */
interface Reader<T> { current: (() => T) | null; changed?(): void }
const { createViewReader } = await import("../components/session-view-readers.ts");

/** The shape before the fix: the notifier is ADDED to the ref object after
 * creation. React's development server renderer seals what `useRef` returns, so
 * a new property cannot be added during SSR. */
function ReaderThatAddsTheNotifier({ notify }: { notify: () => void }) {
	const reader = useRef<(() => string) | null>(null) as Reader<string>;
	reader.changed = notify;
	return <span data-testid="value">{reader.current?.() ?? "empty"}</span>;
}

/** The shape after the fix: a state-held plain object, not a ref object, so
 * React never seals it. */
function ReaderBornWithTheSlot({ notify }: { notify: () => void }) {
	const [reader] = useState(() => createViewReader<string>());
	reader.changed = notify;
	return <span data-testid="value">{reader.current?.() ?? "empty"}</span>;
}

describe("a session view reader survives the server render", () => {
	it("installs its notifier without adding a property", () => {
		assert.doesNotThrow(() => renderToStaticMarkup(<ReaderBornWithTheSlot notify={() => {}} />));
	});

	it("needs the slot at creation, because React seals the ref on the server", () => {
		// Characterization: if React ever stops sealing, this test fails and the
		// helper's doc comment (and the extra slot) can be revisited knowingly.
		assert.throws(() => renderToStaticMarkup(<ReaderThatAddsTheNotifier notify={() => {}} />),
			/Cannot add property changed, object is not extensible/);
	});
});

/**
 * The Custom endpoint settings section renders (static markup, no network —
 * the fetch only runs client-side after hydrate).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CustomEndpointSection } from "../components/settings/custom-endpoint-section.tsx";

describe("CustomEndpointSection", () => {
	const html = renderToStaticMarkup(<CustomEndpointSection />);

	it("renders the URL + key inputs and the Connect action", () => {
		assert.match(html, /data-testid="custom-endpoint-url"/);
		assert.match(html, /placeholder="https:\/\/llmrouter\.boyemma\.com\/v1"/);
		assert.match(html, /type="password"/);
		assert.match(html, /data-testid="custom-endpoint-connect"/);
	});

	it("says what it is for", () => {
		assert.match(html, /OpenAI-compatible/);
	});

	it("starts with Connect disabled until a URL is typed", () => {
		assert.match(html, /data-testid="custom-endpoint-connect"[^>]*disabled/);
	});
});
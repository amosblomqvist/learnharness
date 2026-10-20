import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ModelMenuList } from "../components/settings/model-menu.tsx";
import type { ModelCatalogEntry } from "../src/core/contracts.ts";

/**
 * The model menu's price is a catalog RATE (USD per 1M tokens in/out), not a
 * bill. Its tooltip must connect that rate to the estimated model cost the
 * rest of the observability surfaces show, without implying a charge.
 */
describe("ModelMenuList price tooltip", () => {
	const model: ModelCatalogEntry = {
		name: "GLM 5.3 Flash",
		provider: "openrouter",
		id: "z-ai/glm-5.3-flash",
		cost: { input: 0.15, output: 0.5, cacheRead: 0.03, cacheWrite: 0 },
		contextWindow: 1_048_576,
		maxTokens: 131_072,
		reasoning: false,
		input: ["text"],
		supportedLevels: [],
	};

	it("names the estimated model cost and keeps the rate framing", () => {
		const html = renderToStaticMarkup(
			<ModelMenuList models={[model]} effectiveId={undefined} onPick={() => {}} />,
		);
		assert.match(html, /title="Estimated model cost basis: catalog list price, USD per 1M tokens in\/out; not a bill"/);
		assert.match(html, /\$0\.15\/\$0\.5/);
	});
});

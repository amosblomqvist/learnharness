import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ACP_AGENTS, type ModelCatalogResponse } from "../src/core/index.ts";
import { setupStage } from "../components/setup-dialog.tsx";
import { strongKeyless } from "../components/setup-cta.tsx";
import { StatsBar } from "../components/stats-bar.tsx";
import { SubscriptionConnection } from "../components/settings/subscriptions-section.tsx";
import { prettyModel } from "../components/usage-format.ts";

describe("subscription-only setup and display", () => {
	it("a connected subscription advances to model slots with no API key", () => {
		assert.equal(setupStage([{ id: "acp-codex", keyPresent: false, connectionReady: true }]), "pickers");
		assert.equal(setupStage([{ id: "acp-codex", keyPresent: false, connectionReady: false }]), "keys");
		const catalog: ModelCatalogResponse = { models: [], defaults: null, slots: { strong: { model: { provider: "acp-codex", id: "default" } }, cheap: null, vision: null }, rolePins: { researcher: null, demoBuilder: null, visualMaker: null, extractor: null, auditor: null }, providers: [{ id: "acp-codex", envVar: "", keyPresent: false, connectionReady: true }] };
		assert.equal(strongKeyless(catalog), false);
		catalog.providers[0]!.connectionReady = false;
		assert.equal(strongKeyless(catalog), true);
	});
	it("shows subscription billing instead of a fictitious API token price", () => {
		const html = renderToStaticMarkup(<StatsBar turns={[{ id: "t", messageId: "m", at: "now", model: "acp-codex:default", steps: [{ inputTokens: 1000, outputTokens: 10, cacheReadTokens: undefined, cacheWriteTokens: undefined, reasoningTokens: undefined }] }]} />);
		assert.match(html, /data-testid="stats-cost">Codex</);
		assert.doesNotMatch(html, /\$0\.0000/);
	});
	it("both connection forms explain native sign-in and local adapter configuration", () => {
		for (const agent of ACP_AGENTS) {
			const html = renderToStaticMarkup(<SubscriptionConnection agent={agent} initial={{}} />);
			assert.ok(html.includes(agent.package));
			assert.ok(html.includes(agent.login));
			assert.ok(html.includes("LH_ACP_HOST_CONFIG"));
			assert.doesNotMatch(html, /<input/);
			assert.match(html, /Connect<\/button>/);
			assert.doesNotMatch(html, /Paste key|access_token/);
		}
	});
	it("selected subscription models retain the agent name", () => {
		assert.equal(prettyModel("acp-codex:default"), "Codex");
		assert.equal(prettyModel("acp-claude:default", true), "Claude Code · subscription");
	});
});

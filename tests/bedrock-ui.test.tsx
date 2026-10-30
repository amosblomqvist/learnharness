import React from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { BedrockSetupHint, classifyKeys } from "../components/settings/keys-section.tsx";
import { BEDROCK_PROVIDER } from "../src/core/bedrock.ts";
import { ModelMenuList } from "../components/settings/model-menu.tsx";
import type { ModelCatalogEntry } from "../src/core/contracts/models.ts";

it("offers Bedrock in the shared provider picker and explains AWS profile setup", () => {
	assert.deepEqual(classifyKeys([], [BEDROCK_PROVIDER]).addable, [BEDROCK_PROVIDER]);
	const html = renderToStaticMarkup(<BedrockSetupHint />);
	for (const text of ["Bedrock API key", "AWS_PROFILE", "AWS_REGION", "restart", "region and account"]) assert.ok(html.includes(text), text);
	assert.ok(html.includes('rel="noreferrer"'));
});

const direct: ModelCatalogEntry = {
	id: "openai.gpt-5.6-sol", name: "GPT-5.6 Sol", provider: BEDROCK_PROVIDER.id,
	input: ["text", "image"], reasoning: true, supportedLevels: ["xhigh"],
	cost: null, contextWindow: 1050000, maxTokens: 128000,
};
const profile: ModelCatalogEntry = { ...direct, id: "us.openai.gpt-5.6-sol", name: "GPT-5.6 Sol (US)" };

it("the shared picker places the inference profile before its direct model and explains the difference", () => {
	const html = renderToStaticMarkup(<ModelMenuList models={[direct, profile]} effectiveId={direct.id} effectiveProvider={direct.provider} onPick={() => {}} />);
	assert.ok(html.indexOf('data-testid="model-option-us_openai_gpt-5_6-sol"') < html.indexOf('data-testid="model-option-openai_gpt-5_6-sol"'));
	assert.ok(html.includes("Inference profile"));
	assert.ok(html.includes("Direct model"));
	assert.ok(html.includes("may require an inference profile"));
	assert.ok(html.includes("Choose the geographic scope"));
});

it("other providers retain their ordering and do not get Bedrock routing labels", () => {
	const html = renderToStaticMarkup(<ModelMenuList models={[{ ...profile, provider: "custom" }, { ...direct, provider: "custom" }]} effectiveId={undefined} onPick={() => {}} />);
	assert.ok(html.indexOf('data-testid="model-option-openai_gpt-5_6-sol"') < html.indexOf('data-testid="model-option-us_openai_gpt-5_6-sol"'));
	assert.ok(!html.includes("Inference profile"));
	assert.ok(!html.includes("Direct model"));
});

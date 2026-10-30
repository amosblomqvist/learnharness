import assert from "node:assert/strict";
import { after, beforeEach, it, mock } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { normalizeContext, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { piEngineForSpec } from "../src/agent/models.ts";

const directory = mkdtempSync(join(tmpdir(), "lh-bedrock-credentials-"));
const originalEnv = process.env;
writeFileSync(join(directory, "credentials"), [
	"[intended]", "aws_access_key_id=PROFILE_INTENDED", "aws_secret_access_key=fixture-secret",
	"[override]", "aws_access_key_id=PROFILE_OVERRIDE", "aws_secret_access_key=fixture-secret",
].join("\n"));
writeFileSync(join(directory, "config"), "");
let selected: string | undefined;
beforeEach(() => {
	process.env = {
		NODE_ENV: "test", HOME: directory, AWS_REGION: "us-east-1",
		AWS_SHARED_CREDENTIALS_FILE: join(directory, "credentials"),
		AWS_CONFIG_FILE: join(directory, "config"), AWS_EC2_METADATA_DISABLED: "true",
		AWS_PROFILE: "intended", AWS_ACCESS_KEY_ID: "ENV_OTHER_ACCOUNT",
		AWS_SECRET_ACCESS_KEY: "fixture-env-secret",
	};
	selected = undefined;
	mock.restoreAll();
	mock.method(BedrockRuntimeClient.prototype, "send", async function (this: BedrockRuntimeClient) {
		selected = this.config.token
			? (await this.config.token()).token
			: (await this.config.credentials()).accessKeyId;
		throw new Error("STOP_BEFORE_NETWORK");
	});
});
after(() => { mock.restoreAll(); process.env = originalEnv; rmSync(directory, { recursive: true, force: true }); });

async function invoke(options?: SimpleStreamOptions) {
	const engine = piEngineForSpec({ provider: "amazon-bedrock", id: "us.anthropic.claude-haiku-4-5-20251001-v1:0", thinkingLevel: "off" });
	return engine.streamFn(engine.model, normalizeContext({ messages: [{ role: "user", content: "Synthetic credential test", timestamp: 0 }] }), options).result();
}

it("the configured AWS profile wins over ambient access keys at actual client dispatch", async () => {
	assert.equal((await invoke()).errorMessage, "STOP_BEFORE_NETWORK");
	assert.equal(selected, "PROFILE_INTENDED");
});

it("an explicit request profile wins over the launch profile", async () => {
	assert.equal((await invoke({ env: { AWS_PROFILE: "override" } })).errorMessage, "STOP_BEFORE_NETWORK");
	assert.equal(selected, "PROFILE_OVERRIDE");
});

it("without a profile, environment access keys still work", async () => {
	delete process.env.AWS_PROFILE;
	assert.equal((await invoke()).errorMessage, "STOP_BEFORE_NETWORK");
	assert.equal(selected, "ENV_OTHER_ACCOUNT");
});

it("a missing selected profile fails rather than using another account's environment keys", async () => {
	process.env.AWS_PROFILE = "missing";
	assert.equal((await invoke()).stopReason, "error");
	assert.equal(selected, undefined);
});

it("Bedrock bearer authentication retains precedence over a profile", async () => {
	process.env.AWS_BEARER_TOKEN_BEDROCK = "fixture-env-bearer";
	assert.equal((await invoke()).errorMessage, "STOP_BEFORE_NETWORK");
	assert.equal(selected, "fixture-env-bearer");
	assert.equal((await invoke({ apiKey: "fixture-request-bearer" })).errorMessage, "STOP_BEFORE_NETWORK");
	assert.equal(selected, "fixture-request-bearer");
});

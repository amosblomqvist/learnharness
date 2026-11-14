"use client";
import { GEMINI_CLI_MINIMUM_VERSION } from "@/src/core";
import { ExternalCliInstallationStatus } from "./external-cli-status";

const headers = { "x-learnharness-external-cli": "1" };

export function GeminiCliInstallationStatus() {
	return <ExternalCliInstallationStatus name="Gemini CLI" section="geminiCli" statusUrl="/api/gemini-cli" statusHeaders={headers}
		minimumVersion={GEMINI_CLI_MINIMUM_VERSION} testId="gemini-cli-installation" checkAgainTestId="gemini-cli-check-again"
		introduction={<><strong className="font-medium">Install and sign in to Gemini CLI in your terminal, then select a Gemini CLI model here.</strong> LearnHarness starts it when needed—no background process required.</>}
		billing={<>Gemini CLI controls billing.</>} setupUrl="https://github.com/google-gemini/gemini-cli" />;
}

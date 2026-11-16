"use client";
import { CODEX_MINIMUM_VERSION } from "@/src/core";
import { ExternalCliInstallationStatus } from "./external-cli-status";
const headers = { "x-learnharness-external-cli": "1" };
export function CodexInstallationStatus() {
 return <ExternalCliInstallationStatus name="Codex" section="codex" statusUrl="/api/codex" statusHeaders={headers}
  minimumVersion={CODEX_MINIMUM_VERSION} testId="codex-installation" checkAgainTestId="codex-check-again"
  introduction={<><strong className="font-medium">Install and sign in to Codex in your terminal, then select a Codex model here.</strong> LearnHarness starts it when needed—no background process required.</>}
  billing={<>Codex controls billing. Your <code>~/.codex/AGENTS.md</code> and skills may still be loaded.</>} setupUrl="https://developers.openai.com/codex/cli" />;
}

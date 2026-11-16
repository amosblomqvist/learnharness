"use client";
import { CLAUDE_CODE_MINIMUM_VERSION } from "@/src/core";
import { ExternalCliInstallationStatus, externalCliStatusLabel } from "./external-cli-status";
export const claudeCodeStatusLabel = externalCliStatusLabel;
const headers = { "x-learnharness-claude-code": "1" };
export function ClaudeCodeInstallationStatus() {
 return <ExternalCliInstallationStatus name="Claude Code" section="claudeCode" statusUrl="/api/claude-code" statusHeaders={headers}
  minimumVersion={CLAUDE_CODE_MINIMUM_VERSION} testId="claude-code-installation" checkAgainTestId="claude-code-check-again"
  introduction={<><strong className="font-medium">Install and authenticate Claude Code in your terminal, then select a Claude Code model here.</strong> LearnHarness starts it when needed—no background process required.</>}
  billing={<>Claude Code controls billing.</>} setupUrl="https://code.claude.com/docs/en/setup" />;
}

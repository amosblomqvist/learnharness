# Antigravity CLI

LearnHarness can use an externally installed **Antigravity CLI (agy)** as a model provider.
This runs separately from direct API keys and built-in subscription connections.
The CLI manages its own authentication, quota, and model routing.

## Set up

1. Install and authenticate the Antigravity CLI outside LearnHarness on the machine running the LearnHarness server.
2. Ensure the `agy` binary is discoverable in `PATH` or standard user install paths (such as `~/.gemini/antigravity-cli/bin` or `~/.local/bin`).
On Windows, a runnable `agy.exe` is required; `.cmd` wrappers are ignored.
3. Enable **Settings -> Providers -> External CLI -> Antigravity CLI**.
This setting is off by default.
Use **Check again** to verify the CLI status.
4. Select any model discovered from `agy models` (refreshed at startup and when loading the model picker).

The minimum supported version is **1.5.0**.
The check executes `agy --version` with a 5-second timeout.
Passing the version probe confirms binary presence, but does not verify account credentials or quota runway.

## Execution and streaming

LearnHarness preserves control over its agent turn lifecycle, tools, and persistence.
It serializes the conversation transcript and streams model responses from the CLI child process via standard input and output.
Each request runs in an isolated child process using an empty working directory.
Thinking blocks and reasoning deltas from supported models map into LearnHarness reasoning tokens.
Cancellation terminates the active child process and aborts the ongoing stream cleanly.

## Maintainer entry points

- Core contracts: [`src/core/contracts/agy.ts`](../src/core/contracts/agy.ts)
- Discovery and binary resolution: [`src/agent/agy/binary.ts`](../src/agent/agy/binary.ts)
- Version probe: [`src/agent/agy/installation.ts`](../src/agent/agy/installation.ts)
- Stream adaptation: [`src/agent/agy/stream.ts`](../src/agent/agy/stream.ts)
- Settings UI: [`components/settings/agy-status.tsx`](../components/settings/agy-status.tsx)
- Server route: [`app/api/agy/route.ts`](../app/api/agy/route.ts)
- Unit tests: [`tests/agy-agent.test.ts`](../tests/agy-agent.test.ts) and [`tests/agy-server-ui.test.ts`](../tests/agy-server-ui.test.ts)

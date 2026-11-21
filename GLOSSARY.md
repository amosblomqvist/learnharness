# LearnHarness (reeschan fork)

Terms for the parts this fork adds on top of upstream LearnHarness: model access through external CLIs, explainer pages, sending propositions to shared memory, and fork releases.

## Model access

**Subscription connection**:
A sign-in made inside LearnHarness that lets it call a provider's models on the learner's plan (ChatGPT, GitHub Copilot, Grok). LearnHarness holds the credential.
_Avoid_: OAuth provider, native subscription (in prose)

**External CLI provider**:
A model provider backed by a coding-agent CLI installed outside LearnHarness (Claude Code, Codex, Gemini CLI). The CLI holds the credential and decides billing; LearnHarness only launches it.
_Avoid_: CLI subscription, subscription connection

**CLI opt-in**:
The app-wide switch, off by default, that allows LearnHarness to launch one external CLI provider.
_Avoid_: enable flag, CLI login

**Built-in tool**:
A tool that ships inside an external CLI (shell, file edit, web search). LearnHarness turns them off; only LearnHarness tools may run.
_Avoid_: native tool, CLI tool

**LearnHarness tool**:
A tool the teaching agents declare (plan, probe, demo, explainer, ...) and LearnHarness executes, whichever model runs the turn.
_Avoid_: bridge tool, MCP tool

## Lesson artifacts

**Visual**:
A single SVG figure a sub-agent draws for the current teaching step.
_Avoid_: diagram card

**Demo**:
An interactive HTML demonstration a sub-agent builds for the learner to manipulate.
_Avoid_: simulation, widget

**Explainer**:
A figure-led, self-contained HTML page a sub-agent writes with the visual-explainer kit, shown in the lesson and downloadable.
_Avoid_: visual explainer page, report, recap page

## Shared memory

**Shared memory**:
A memory store outside LearnHarness that several coding agents share. The learner chooses which propositions from the knowledge graph to send there.
_Avoid_: external memory, memory sync

**Sent record**:
The note of which proposition was sent to shared memory, with what content, and which memory it became. It shows whether a proposition is unsent, changed since sending, or gone from the graph.
_Avoid_: ledger, sync state

## Distribution

**Fork release**:
A Windows installer built from this fork and published on the fork's GitHub Releases; fork builds update only from these.
_Avoid_: upstream release, nightly

**Fork version**:
The version a fork release carries: the upstream version it is based on, with the patch number set to upstream patch × 100 + the fork's build count.
_Avoid_: fork tag, build number

# Prompt composition

The runtime composes prompts for **prober**, **teacher** and **practice** agents. The source of truth is [`listSourceSegments` / `effectivePromptSegments`](../prompt-segments.ts); [`composeInstructions`](../teacher-agent.ts) selects effective text, trims each segment, drops empty segments and joins them with `\n\n---\n\n`. Non-fragment documentation such as this README never enters the prompt.

## Composition order

| Agent | Segments, in order |
|---|---|
| Prober | [`system-prompt.md`](../system-prompt.md) → sorted `prober/` fragments → sorted `shared/` fragments |
| Teacher | `system-prompt.md` → sorted `teacher/` fragments → sorted `shared/` fragments |
| Practice | sorted `practice/` fragments → the curated shared appendix below; **no teaching base** |

Directory discovery accepts only filenames matching `^\d+-[\w.-]+\.md$` and sorts them lexicographically by filename. Keep numeric prefixes consistently padded when order matters. The teaching base supplies the agent's purpose/philosophy; voice, accuracy, mental-model, question, confidence, file and formatting guidance are separate shared fragments. The teacher's method and planning/teaching doctrine live in its own directory; probing doctrine lives in `prober/`.

Practice has its own base and doctrine. Its shared appendix is explicitly allowlisted in the loader: `10-voice.md`, `15-accuracy.md`, `16-mental-model.md` and `40-formatting.md`, in sorted order. Other shared fragments do **not** automatically enter practice. Adding a new shared fragment includes it in prober/teacher composition, but not practice unless the allowlist changes.

## Overrides and defaults

Source files are the default instructions. User override files mirror segment keys under [`PROMPTS_OVERRIDE_DIR`](../../../config.ts), normally `data/prompts/` (relocated by `LH_DATA_DIR`):

```text
system-prompt.md
prober/<fragment>.md
teacher/<fragment>.md
practice/<fragment>.md
shared/<fragment>.md
```

An override is effective only when **both** its `settings.json` → `agent.prompts[segmentPath]` switch is `true` **and** its file can be read. Absent/off switches and missing/unreadable files use source text. File presence alone does not enable anything. An enabled empty override contributes no text after trimming; it does not fall back to source.

The normal turn handler passes the resolved switch map, so composition reads source/override text fresh for each newly constructed agent. Calls that omit `promptSwitches` use the source-only compositions cached at module initialization. Editing a file does not rewrite an already-running agent's instructions. There are no factory-enabled overrides.

The available segment list always comes from current source discovery. An override for a removed source segment stops composing but is not automatically deleted from disk. Shared segments use the same key across all agents that include them. Path grammar is defined in [`src/core/prompt-segments.ts`](../../core/prompt-segments.ts); override CRUD lives in [`src/store/prompt-overrides.ts`](../../store/prompt-overrides.ts), exposed by the settings prompt routes/UI. The agent-side reader is separate so agents do not import store adapters.

## Phases and tool contracts

- Teaching sessions start with the prober. A successful `probe_done` call **and matching result** select the teacher on later turns; a bare/refused call does not. The teacher plans and teaches with its own tool registry. The displayed plan → teach boundary is the first tagged `quiz`/`explain` call, not simply `plan_init`.
- Practice sessions use the practice prompt from turn one. `problem` commits a solution before posing; `conclude` reveals it. The doctrine requires a pause after conclusion until the learner explicitly moves on. This is a conversational agent, not the retired problem-set generation/grading pipeline.
- Prompt instructions are not a substitute for structural validation. For example, `plan_init` can rewrite the map, and the conclude pause is doctrine rather than a terminating execute result. Read the actual registry and schemas before describing a behavior as enforced.

See [architecture](../../../docs/architecture.md#3-teaching-lifecycle-and-tools) for runtime phases, registry differences and pause mechanics; [teaching methodology](../../../docs/teaching-methodology.md) for the method. Background workers and extraction have their own instructions in their implementation modules; this loader is not a catalog of every prompt in the application.

## Editing fragments

- Put agent-specific doctrine in that agent's directory. Use `shared/` only for guidance appropriate to every agent that composes it; check practice's explicit allowlist.
- Match tool names and input fields to the actual schemas in `src/agent/tools.ts` and `src/agent/tools/`. Agents share history, not identical toolsets: prober `probe`/`recall` and teacher `quiz`/`explain` deliberately differ. Do not imply a tool is available merely because another phase uses it.
- Keep always-in-context text concise. Avoid duplicating the base, other fragments, tool schemas or runtime reference documentation.
- Verify composition/override behavior against `tests/prompt-overrides.test.ts` and the agent-flow tests when changing loader behavior. Prompt assets must remain included in standalone packaging (`scripts/build-server.mjs`).

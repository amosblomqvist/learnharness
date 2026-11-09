# Prompt source files

The prompt defaults use six source files to produce five Settings editors. The two teaching files under `shared/` form one Prober/Teacher editor.

| File | Group membership |
|---|---|
| `prober.md` | Prober-only assessment doctrine. |
| `teacher.md` | Teacher-only methodology, planning, teaching, question cycles, research, demos, and images. |
| `practice.md` | Practice base, tool mechanics, and practice doctrine. |
| `shared/teaching-base.md` | Learning-harness role and philosophy shared by Prober and Teacher. |
| `shared/teaching-mechanics.md` | Question-tool, confidence, and learner-file guidance shared by Prober and Teacher. |
| `common.md` | Voice, accuracy, mental-model, and formatting guidance for all three learner-facing roles. |

`src/agent/prompt-defaults.ts` reads the source files. `src/core/prompt-editor.ts` composes the selected role text, shared teaching text when used, and Common last. Settings stores user edits and history under `<data root>/prompts/editor.json`.

## Phases and tool contracts

- Teaching sessions start with the prober. A successful `probe_done` call **and matching result** select the teacher on later turns; a bare/refused call does not. The teacher plans and teaches with its own tool registry. The displayed plan → teach boundary is the first tagged `quiz`/`explain` call, not simply `plan_init`.
- Practice sessions use the practice prompt from turn one. `problem` commits a solution before posing; `conclude` reveals it. The doctrine requires a pause after conclusion until the learner explicitly moves on. This is a conversational agent, not the retired problem-set generation/grading pipeline.
- Prompt instructions are not a substitute for structural validation. For example, `plan_init` can rewrite the map, and the conclude pause is doctrine rather than a terminating execute result. Read the actual registry and schemas before describing a behavior as enforced.

See [architecture](../../../docs/architecture.md#teaching-and-practice) for runtime phases, registry differences and pause mechanics; [teaching methodology](../../../docs/teaching-methodology.md) for the method. Background workers and extraction have their own instructions in their implementation modules.

## Editing prompts

- Settings provides five editors: Common, Prober, Teacher, Practice, and Prober/Teacher shared. Common applies to every role; shared teaching text applies only to Prober and Teacher.
- The app composes each role prompt from its role text, applicable shared text, and Common. Common comes last. Background-worker prompts and tool descriptions stay separate.
- Edits save after a short pause. Each distinct custom text is added to local prompt history. Shipped defaults are not saved as history.
- Compare a saved version with the current editor text. Restore a version, delete selected versions, delete a month, or clear all history. Reset to shipped default changes the active prompt but does not delete history.
- `legacy-v1.json` archives the former source fragments for one-time migration. Migration preserves changed legacy edits and leaves the old data files in place.

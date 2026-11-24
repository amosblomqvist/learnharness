# Workspace

Run application, build, and test commands from `workspace/`. Before writing code, follow `workspace/AGENTS.md` and read the relevant installed Next.js guide under `workspace/node_modules/next/dist/docs/`.

# Never touch the user's real data

Never create, leave behind or delete sessions (threads), jobs, graph entries, settings or credentials in the user's real profile (`workspace/data/`, `workspace/auth.json` and the credential files next to it). Every test, smoke script or separate dev server you start must run against a scratch `LH_DATA_DIR` and `LH_AUTH_FILE`. You may open the real app (for example with `Launch LearnHarness.cmd`) to check how it behaves, but only to look: never start a session in it, because that changes the user's learning progress. After any run, check that `workspace/data/chats` and `workspace/data/jobs` gained no files. If they did, report it instead of leaving stray threads in the user's sidebar.

# No guessing

All design authority belongs to the human. **Never guess a design or implementation decision.** If anything is ambiguous — naming, behavior, data shapes, UX, defaults, scope boundaries, prompt wording — STOP and ask with the ask-user-question tool before proceeding. If you are "a little unsure," you are unsure: ask. A wrong guess is far more expensive than a question. Ask early, ask specific, one question per call.

Concretely: first investigate and plan rigorously (asking the user design questions along the way), get the plan approved by the user, and only then implement. Implementation should be mechanical execution of an approved plan — not interpretation.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# No guessing

All design authority belongs to the human. **Never guess a design or implementation decision.** If anything is ambiguous — naming, behavior, data shapes, UX, defaults, scope boundaries, prompt wording — STOP and ask with the ask-user-question tool before proceeding. If you are "a little unsure," you are unsure: ask. A wrong guess is far more expensive than a question. Ask early, ask specific, one question per call.

Concretely: first investigate and plan rigorously (asking the user design questions along the way), get the plan approved by the user, and only then implement. Implementation should be mechanical execution of an approved plan — not interpretation.

# Git work and handoff

Workspace files use English, including identifiers, comments, and development documentation. Chinese is allowed in localization resources, localization test fixtures, and runtime-generated learning data. Issues, PRs, and conversations may use Chinese.

Before repository changes, branch or PR operations, resuming a task, or handing work over, read [the Git workflow](docs/agents/git-workflow.md) and [the issue tracker instructions](docs/agents/issue-tracker.md). This includes changes to documentation and research notes.

- Bind repository changes to an Issue and an independent task branch. Preserve existing changes; obtain approval before creating a worktree.
- Commit meaningful stages with what changed and why. Push before delivery or handoff and report the branch, commits, PR, and actual check results.
- Keep merge, release, issue-closure, and upstream-PR decisions with the human. Use the workflow's explicit initialization exception while the version branches do not yet exist.

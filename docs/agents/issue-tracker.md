# Issue tracker: GitHub

Issues and specs live in GitHub Issues for `gzy31007/learnharness`.

Use the registered deck tools when available, following their workspace checks and reporting requirements. Otherwise use the `gh` CLI from this clone. Read [the Git workflow](git-workflow.md) before changing repository files or opening an implementation PR.

## Conventions

- Create: `gh issue create --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- Read: `gh issue view <number> --comments`; fetch labels too.
- List: `gh issue list --state open --json number,title,body,labels,comments` with the relevant state and label filters.
- Comment: `gh issue comment <number> --body "..."`.
- Label: `gh issue edit <number> --add-label "..."` or `--remove-label "..."`.
- Close: only after explicit human approval, `gh issue close <number> --comment "..."`.

Infer the repository from `git remote -v`.

## PRs as requests and deliveries

**PRs as a request surface: no.** This controls triage of unsolicited requests; it does not prohibit PRs that deliver an approved task.

If the request-surface flag changes to `yes`, use `gh pr` equivalents for external PRs from `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, or `NONE`; exclude `OWNER`, `MEMBER`, and `COLLABORATOR`. Issues and PRs share a number space; resolve ambiguous numbers with `gh pr view` and fall back to `gh issue view`. Read both comments and the diff.

Agents may create delivery PRs in this fork after the applicable checks. Use `Refs #<number>` or another non-closing reference until the human approves closure. Creating an upstream PR requires separate approval. Merge, release, and issue closure remain human decisions, including for research and organization tasks.

## Skill requests

When a skill says to publish to the issue tracker, create a GitHub issue. When it says to fetch a ticket, read the issue and its comments. A skill's completion step does not override the approval requirement for closing an issue. Research completion alone does not mean a vulnerability is fixed or its risk is accepted.

## Wayfinding operations

- Map: one issue labelled `wayfinder:map`, with the body sections required by `/wayfinder`.
- Child ticket: link it as a GitHub sub-issue. If unavailable, use a task list in the map and `Part of #<map>` in the child body.
- Ticket types: `wayfinder:research`, `wayfinder:prototype`, `wayfinder:grilling`, `wayfinder:task`.
- Blocking: prefer native issue dependencies. With `gh`, POST to `repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by` using `issue_id=<blocker-database-id>`, not the issue number or node ID. If unavailable, use `Blocked by: #<n>` in the child body.
- Frontier: choose the first open child in map order with no open blockers and no assignee.
- Claim: assign the ticket to the driving developer before starting work.
- Handoff: comment with the answer, work references, checks, and remaining scope; append a gist and link to the map's Decisions-so-far when applicable. Leave the ticket open pending human acceptance; close it only after explicit approval. Use the deck reporting operation when starting, switching, and completing a ticket as required by that tool.

Apply labels according to the skill being used. This configuration adds no blanket label requirement.

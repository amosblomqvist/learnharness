# Workspace inventory and organization plan

Snapshot: 2026-10-23, `/root/learnharness`, baseline
`c9b033e6b1379c6424220102a34b15fdeaf6685e`.
Tracking: [organization task #26](https://github.com/gzy31007/learnharness/issues/26).

## Batch status

The first batch described below merged into `main` as PR #29. A second batch
continues from the merge commit `9f6a61757eae4772d42094aa40740be367668c52`. It
archives six research reports under `docs/research/archive/2026-10/` and updates
this inventory. Statements marked "at inventory time" describe the first-batch
snapshot at `c9b033e`; they are not current state. Neither batch moves, deletes,
installs, or tests product behavior.

## Approved scope

This first batch adds an index, ignore rules, and a reviewable organization plan.
The human approved `docs/workspace-cleanup` from the existing `main` as an
initialization exception. Git policy is a separate
[task #27](https://github.com/gzy31007/learnharness/issues/27).
No historical files, caches, branches, or worktrees are deleted or moved by this
batch. Main-branch migration, CI, branch protection, global agent instructions,
and deployment changes require separate approval.

The second batch adds the archive directory below and edits this file. Its new
tracked files are the six archive copies under `docs/research/archive/2026-10/`,
their README, the local evidence register, and the archive manifest. Moving or
deleting the local originals, worktrees, dependencies, caches, and installers
stays in a later batch with its own approval. Structural documentation for
`GLOSSARY.md`, `docs/agents/domain.md`, and the triage role labels also waits for
a separate scope.

## File categories

| Location | Purpose and observed state | Treatment |
| --- | --- | --- |
| `app/`, `src/`, `components/`, `tests/`, `scripts/`, `electron/` | Application, tests, and development tools | Preserve; this is not a source-refactoring task. |
| `build/`, `public/` | Repository assets, including desktop packaging inputs | Preserve; a directory named `build` is not automatically disposable. |
| `docs/` | Tracked development and acceptance records, plus local additions | Keep tracked history; review local additions individually. |
| `docs/agents/` | Local tracker, triage, domain instructions, and plugin configuration | Review agent documentation under #27; do not bulk-stage plugin state. |
| `GLOSSARY.md` | Local domain vocabulary | Preserve pending an explicit, scoped documentation commit. |
| `docs/research/` | Seven local research notes; six now have archive copies under `docs/research/archive/2026-10/` | Six are archived with provenance notes and routed links; the seventh waits for a separate scope. The local originals stay until the move batch. |
| `.drafts/` | Four local design and upstream-PR proposals | Keep local and ignored; compare complete documents before classifying duplicates. |
| `.scratch/` | Experiments, evidence, source copies, registered worktrees, and caches | Ignore from ordinary staging, not from retention review. Never clear wholesale. |
| `node_modules/`, `.next/` | Current root installation and generated build | Leave intact in this batch; their usability was not revalidated. |
| `data/`, credential stores, local environment files | Runtime data and sensitive configuration | Outside cleanup scope; do not inspect contents or commit. |

Ignored material is not backed up by Git. Ignore rules reduce accidental staging;
they do not authorize deletion, and tracked files remain tracked.

## Existing changes to preserve

At inventory time, root `.gitignore`, `AGENTS.md`, and `next-env.d.ts` were modified.
`.drafts/`, `.scratch/`, `GLOSSARY.md`, `docs/agents/`, and `docs/research/` were
untracked. The existing `.gitignore` working copy also had an uncommitted
`AGENTS.md` rule; that does not untrack the already tracked file.

This branch starts from the committed baseline rather than adopting all those
changes. Its ignore additions are only root `.scratch/` and `.drafts/`.
The `next-env.d.ts` difference selects development versus production generated
type paths; it is recorded, not reverted or included in an organization commit.

Inventory all dirty and untracked files again before later work. Do not use a
blanket `git add -A`, discard existing changes, or automatically stash them.

## Local research and draft review queue

The queue below records the first-batch review state at `c9b033e`. At that time
the file contents had been inspected to different depths, and most notes were
read only at their headers and relevant references. The second batch has since
read all six security and upstream notes in full and archived them; the next
subsection records that outcome. The seventh research note and the four drafts
keep their first-batch state.

| Local file | Observed association | Next review |
| --- | --- | --- |
| `docs/research/dompurify-advisories.md` | Issue #12 | Keep the historical research boundary and evidence links. |
| `docs/research/undici-advisories.md` | Issue #13 | Preserve audit evidence and the cross-task network guard reference. |
| `docs/research/source-map-js-advisory.md` | Issue #14 | Preserve advisory provenance and triage references. |
| `docs/research/linkify-it-advisories.md` | No Issue number established in this file | Match to the existing tracker before archival; do not create a duplicate by assumption. |
| `docs/research/katex-official-parent-upgrade-options.md` | References prior KaTeX research and issue 17 evidence | Confirm its owning task and retain the distinction between research and accepted integration. |
| `docs/research/upstream-032-desktop-impact.md` | Upstream 0.3.2 impact analysis | Associate with the upstream-sync task and fixed baseline. |
| `docs/research/strong-cheap-vision-models.md` | No Issue number established in this file | Associate with its research task; read dated statements as historical observations. |
| `.drafts/2026-10-19-instance-codex-implementation-plan.md` | Issue #8; shares a header with the archived tracked plan | Compare full contents; matching headers alone do not prove duplication. |
| `.drafts/pr-upstream-codex-subscription-body.md` | Upstream PR proposal | Keep local pending explicit upstream-PR authorization. |
| `.drafts/pr-upstream-codex-subscription-review.md` | Review of that local proposal | Preserve its stated base, head, and known limitations. |
| `.drafts/2026-10-19-agent-write-and-run-tools.md` | Unfiled design discussion | Preserve and establish an Issue before turning it into repository work. |

### Second batch: six reports archived

All six reports were read in full and copied to
`docs/research/archive/2026-10/`. Each copy keeps its title and body, gains an
archive note below the title, and routes absolute local links to
[local-evidence.md](research/archive/2026-10/local-evidence.md). The
[archive guide](research/archive/2026-10/README.md) lists dates, inputs, and the
later state of each ticket.

| Report | Owning record | State at this batch |
| --- | --- | --- |
| `dompurify-advisories.md` | [#12](https://github.com/gzy31007/learnharness/issues/12) | Research closed; 3.4.16 selected; not implemented; no risk accepted. |
| `undici-advisories.md` | [#13](https://github.com/gzy31007/learnharness/issues/13) | 7.30.1 implemented locally with isolated validation; embedded Node and Electron networking untouched. |
| `source-map-js-advisory.md` | [#14](https://github.com/gzy31007/learnharness/issues/14) | 1.2.2 patch applied and verified locally after the research. |
| `linkify-it-advisories.md` | [#11](https://github.com/gzy31007/learnharness/issues/11) | Removal chosen later; the report's parent-scoped override is not current intent. |
| `katex-official-parent-upgrade-options.md` | [#17](https://github.com/gzy31007/learnharness/issues/17) | Patch paused pending an official compatible combination; KaTeX risk carried only for existing local personal use; new external distribution paused. |
| `upstream-032-desktop-impact.md` | [PR #25](https://github.com/gzy31007/learnharness/pull/25) | Static pre-integration assessment; 0.3.2 merged afterwards; Windows not re-verified here. |

The four drafts stay local and ignored. The plan draft and
`docs/subscription-implementation-plan.md` differ by the 8-line archived planning
checkpoint plus one reference line, so they are not byte duplicates and neither
is deleted. `docs/research/strong-cheap-vision-models.md` has no ticket and stays
local until a separate scope covers it.

## Registered worktrees

These are eight registered worktrees including the root, not eight disposable
copies. Paths below are relative to the repository root. Branch ancestry is
relative to the fixed inventory baseline, without a new remote fetch.

| Path | HEAD or branch | Observed state |
| --- | --- | --- |
| `.` | `main`, `c9b033e` | Existing modified and untracked files listed above. |
| `.scratch/issue17-katex-0182-20261021/source` | Detached `ef38592` | Modified agent/ignore/generated-type files and package manifest/lock. |
| `.scratch/issue17-layout-baseline-20261021/source` | Detached `ef38592` | Modified agent/ignore/generated-type files and lock. |
| `.scratch/issue8-contribution-20261020/worktree` | `contrib/instance-codex-subscription` | Clean tracked state; branch not an ancestor of the inventory baseline. |
| `.scratch/upstream-sync-20261022/source` | `integration/upstream-032-20261022` | Clean tracked state; branch contained in the inventory baseline. |
| `.scratch/wayfinder-katex-20261020` | `research/katex-security-20261020` | Untracked scratch and research files; branch not contained in the baseline. |
| `.scratch/wayfinder-pi-auth-20261019` | `research/pi-subscription-auth-20261019` | Untracked research scratch and desktop-feasibility note; branch not contained in the baseline. |
| `.scratch/wayfinder-search-20261019` | `research/search-candidates-20261019` | Two untracked research notes; branch not contained in the baseline. |

A clean status or merged branch does not establish that evidence is expendable.
A non-ancestor branch is not by itself proof of unique unmerged content. Preserve
refs and uncommitted files until the owning task and content are checked. New
worktrees still require individual human approval.

The table records the first-batch observation at `c9b033e`. The second batch did
not re-check worktree status, so no row here is a current claim.

## Disk-use candidates, not a deletion list

`du` reported approximately 18 GiB for the root and 16 GiB under `.scratch/`.
A separate sum of selected dependency, generated-build, and cache directories
was 12.136 GiB. These measurements do not establish reclaimable space: active
use, rerun needs, retention, and shared-storage behavior have not been checked.

The selected directories were:

- `source/node_modules/` and `source/.next/` under each of
  `.scratch/upstream-sync-20261022/`, `.scratch/issue13-undici-20261020/`,
  `.scratch/issue11-remove-20261021/`, `.scratch/issue14-sourcemap-20261021/`,
  `.scratch/issue17-katex-0182-20261021/`, and
  `.scratch/issue17-layout-baseline-20261021/`.
- `npm-cache/` under the issue 13, issue 11, and issue 14 experiment directories.
- `.scratch/issue17-katex-0182-20261021/cache/`.
- `.scratch/npm-cache/` and
  `.scratch/upstream-sync-20261022/evidence/npm-cache/`.

Windows installers, delivery archives, extracted inspection copies, fixture
homes, and screenshots may coexist nearby. Classify them independently rather
than treating an entire experiment directory as cache.

The figures above come from the first batch and were not measured again. The
archive batch added no dependency, build output, or cache.

## Evidence dependencies

The tracked [subscription implementation record](subscription-implementation.md)
references gate logs under `.scratch/issue8-closed-gates-QMplS5/` and the screenshot
`.scratch/issue8-ui-3rh3PJ/after-loopback-fix.png`.
The tracked [implementation plan](subscription-implementation-plan.md) references
research source under `.scratch/wayfinder-pi-auth-20261019/.research-scratch/`.

Local research notes also reference the issue 8 advisory triage and network
guard, issue 12 registry/audit records, issue 13 validation evidence, and KaTeX
research/closeout files. Preserve these dependencies until a deliberate archive
migration updates the relevant documents and replay scripts. Keep final
installers with their source commit, hashes, and provenance; an Issue being
closed does not make its evidence disposable.

The archive ledger records these local dependencies by path, original line
fragment, hash measured during archival, and availability in
[local-evidence.md](research/archive/2026-10/local-evidence.md). A current hash is
not a research-time snapshot, and the ledger publishes no raw evidence. Public
copies that are linked at the archive baseline omit the old line anchors.

## Subsequent batches and acceptance

1. Capture an explicit manifest of retained files, source baselines, hashes,
   unfinished work, and reference dependencies. Save unique uncommitted content
   before retiring any worktree or source copy. The archive manifest now covers
   the six reports; worktrees, installers, and other source copies still need
   one.
2. Review final documentation separately from drafts. Associate each retained
   report with its task and baseline. Compare suspected duplicates in full. Done
   for the six archived reports; the drafts and the seventh note remain.
3. Choose a durable evidence location and check for sensitive content before
   publishing evidence. Update references and replay scripts before any move.
4. Propose exact absolute cleanup paths. Verify real paths, symlinks, process
   use, reproducibility, retained evidence, and the approved allowlist before
   deleting anything. Use Git-aware worktree operations only after content is
   safe; never force-remove a dirty worktree.
5. Recheck links, worktree status, the untouched root files, and disk usage.
   Report what was retained, archived, or removed, and which work remains.
   Leave #26 open for human acceptance.

Product tests and builds are not required for these documentation batches, and
neither batch ran one. Link checks, file hashes, and metadata reads are not
product test results. This statement is not a deployment claim and grants no
permission to skip checks for future product changes.

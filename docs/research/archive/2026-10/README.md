# Security research archive, October 2026

This directory holds repository copies of six research notes written between
2026-10-20 and 2026-10-22. Five concern production dependency advisories in the
follow-up tickets split out of #8. The sixth reviews the desktop impact of
upstream 0.3.2. The notes were untracked files under `docs/research/` before this
batch.

An archived report is not a fix, a risk acceptance, or a release. Where a note
recommends a version, the owning ticket decided the outcome separately. The state
column below records those decisions as they stood on 2026-10-23. A closed
research ticket means the research question was answered, not that its finding
was implemented.

Two mechanical changes apply to each original body. An archive note sits directly
below the title, and every absolute local link now points at an entry in
[local-evidence.md](local-evidence.md). The note records the report's inputs and
the later ticket decision. The ledger keeps the original path and line fragment,
and adds a committed copy at the fixed archive baseline where one exists. Those
public copies carry no old line anchors, so they help navigation and do not claim
identical bytes. No finding, version range, recommendation, or evidence statement
was rewritten. Read every version claim as of the research date printed in its own
note.

## Contents

| File | Owning ticket | Research date | State after the report |
| --- | --- | --- | --- |
| [dompurify-advisories.md](dompurify-advisories.md) | [#12](https://github.com/gzy31007/learnharness/issues/12) | 2026-10-20 | The ticket closed as research on 2026-10-21 and selected DOMPurify 3.4.16 as the narrowest patch. Nothing was implemented and no risk was accepted. The report's 3.4.16 and 3.4.17 comparison is a historical option list; 3.4.16 is the selection. |
| [undici-advisories.md](undici-advisories.md) | [#13](https://github.com/gzy31007/learnharness/issues/13) | 2026-10-20 | The ticket implemented 7.30.1 locally with isolated validation. Updating the npm package does not replace the fetch and WebSocket code built into Node or Electron. |
| [source-map-js-advisory.md](source-map-js-advisory.md) | [#14](https://github.com/gzy31007/learnharness/issues/14) | 2026-10-21 | The ticket applied the 1.2.2 patch locally and verified it after this research. |
| [linkify-it-advisories.md](linkify-it-advisories.md) | [#11](https://github.com/gzy31007/learnharness/issues/11) | 2026-10-21 | The ticket later chose to remove the dependency instead of the parent-scoped override this report recommends. The recommendation stays a researched option, not current intent. |
| [katex-official-parent-upgrade-options.md](katex-official-parent-upgrade-options.md) | [#17](https://github.com/gzy31007/learnharness/issues/17) | 2026-10-21 | The ticket paused the patch and waits for an official compatible combination. Existing local personal use carries the KaTeX risk for now, new external distribution is paused, and other risks including DOMPurify are not accepted. The 0.18.2 plus override route validated earlier is historical and no longer the integration decision. |
| [upstream-032-desktop-impact.md](upstream-032-desktop-impact.md) | [PR #25](https://github.com/gzy31007/learnharness/pull/25) | 2026-10-22 | A static assessment written before integration. PR #25 merged the 0.3.2 integration afterwards. Nothing here re-ran Windows acceptance. |

## Baselines

The six reports do not share one baseline, and `ef38592` is not a universal
archive input. Each note states its own:

- `dompurify-advisories.md`: the immutable baseline
  `6c2b0b57f7d3177a777acab081411db539362416`, with `ef38592` as the observed HEAD.
- `undici-advisories.md`: observed HEAD `ef38592` plus the working-tree patch and
  isolated snapshot that the report records separately.
- `source-map-js-advisory.md`: the supplied Next 16.3.8 and PostCSS baseline. The
  report states that it does not establish a complete immutable snapshot.
- `linkify-it-advisories.md`: the observed `ansi-to-react` 6.2.6 and `linkify-it`
  3.0.3 working-tree graph. No complete source commit is recorded.
- `katex-official-parent-upgrade-options.md`: the declared local dependency graph
  and the 2026-10-21 registry window.
- `upstream-032-desktop-impact.md`: local `ef38592` against upstream snapshot
  `1c5024c8c280be127c0c316b3f57a3783fce471d`, common ancestor
  `32febaaae7fea9fdf8ea59fe62d345d37298d399`.

[archive-manifest.json](archive-manifest.json) repeats these inputs per file
instead of supplying one replacement commit.

The archive batch itself starts from `main` at
[`9f6a617`](https://github.com/gzy31007/learnharness/blob/9f6a61757eae4772d42094aa40740be367668c52/docs/workspace-inventory.md),
the merge of PR #29.

At that baseline the locked versions were undici 7.30.1, source-map-js 1.2.2,
DOMPurify 3.4.14, and KaTeX 0.16.47. Neither `ansi-to-react` nor `linkify-it`
appears in the manifest or the lockfile any more.

## Evidence that stays local

Several references in these notes point at material that never entered Git:
experiment logs, audit JSON, installers, fixtures, and local source copies under
`.scratch/`, plus line ranges inside working-tree files. Those references cannot
become repository links without publishing evidence that was only ever local.

[local-evidence.md](local-evidence.md) records the path, the original line
fragment, the hash measured for this batch, and whether the file is still
available, for 120 references across the six notes. That hash is a current
measurement, not a research-time snapshot, and the record does not stand in for a
public attachment.

## Files

- [local-evidence.md](local-evidence.md): per-reference record for untracked
  evidence.
- [archive-manifest.json](archive-manifest.json): file list, hashes, and
  baselines for this archive.
- [Workspace inventory and organization plan](../../../workspace-inventory.md):
  batch scope, what remains local, and the later steps.

## What this archive does not authorize

The six originals stay where they are. This batch moves and deletes nothing and
installs nothing. It reads repository history, including a fetch, and GitHub
ticket and PR metadata, and it checks its own links and file hashes. It does not
re-check external advisory or registry pages, and it runs no application test,
product build, or Windows acceptance. The drafts, personal selections, and the
seventh research note stay local until a separate, explicit scope covers them.
Removal of caches, worktrees, installers, and source copies needs its own approval
with verified absolute paths.

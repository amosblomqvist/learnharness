# Flashcards

A Core LearnHarness plugin: generate fact-recall cues from your graph or uploaded PDF/text files, organize them in flat decks, and review them with FSRS-6. **No Anki integration.** No runtime npm dependencies, private app imports, core graph writes or provider credentials in the package.

## Core plugin and source reference

Enable Flashcards in **Settings → Core plugins**. The app supplies and updates its code;
its writable records live under `<learning data>/core-plugin-data/flashcards/`.
This source project is reference material, not an installable Community copy:
`flashcards` is a reserved Core ID even when the Core plugin is disabled or missing.
A Community fork needs its own manifest/folder ID and a review of contribution, tool
and fence names that could conflict. Do not copy this build into a Community
`plugins/flashcards/` folder.

Requires a matching host exposing `mountKnowledgePicker`, `mountMarkdown`, `mountTree`,
page-body `openSurface`, public `mountButton` icons (`icon` / `iconOnly`) and custom
colors (`variant: 'custom'` / `colors`), the surface `data-plugin-initial-focus`
contract, and `ctx.workers`. A version string alone does not establish capabilities.
File generation additionally requires `ctx.documents.toMarkdown`; without it, only
Generate from file is disabled, while graph generation and existing reviews remain available.

## Build

This JavaScript project needs no `.sdk/` or SDK generation. Set up the project's
development dependencies separately; no npm setup is performed by LearnHarness.
With dependencies already available, from this folder:

```sh
npm run build
```

The build writes directly to this project's **`dist/`**, bundling the frontend and
CommonJS backend and copying the manifest, styles and licenses. Cleanup replaces
only `dist/`, refuses symlinked `dist/` or misplaced `dist/data/`, and preserves sibling
`data/`. Building does not install, enable or update a Core plugin.

## Use

Open Flashcards from its stacked-card icon in the sidebar. Select propositions in the real host knowledge picker, run preflight, then confirm generation. It uses the current cheap model slot unless you set a plugin-specific override; calls can incur cost. Graph selection is manual; there are no automatic generation triggers. Each successful chunk adds useful missing cues without replacing existing cards or resetting schedules. Navigation does not cancel work. Failed/interrupted targets require an explicit new generation attempt.

First-generation cards join a deck named after their original source. Initial names use public chat titles or notes-file basenames; host imported-source rename overrides are not yet exposed by the learning reader. Rename collections locally, create custom decks and change memberships without changing core sources. One proposition can occur in multiple decks while keeping one collection, schedule and history. Keep at least one membership when changing memberships. Deletion is a separate, explicit operation that removes Flashcards content, never learning-graph nodes.

### Write cards by hand

The **+** immediately left of a deck's gear opens **Create card**: enter a Name followed by Question and Answer using the same Markdown fields as Edit cue. Saving creates a new Flashcards-only target and its first cue together in that deck. There is no separate target-creation step or existing-target dropdown. Each deliberate new save creates a new target rather than matching existing names; retrying a lost response does not create duplicates.

The **+** on an active target row opens **Add cue**, with only Question and Answer. The new cue shares that target's existing schedule and memberships without resetting its history, learning cue or daily introduction count. All fields must be nonblank; Cancel creates nothing. Manual creation needs no configured model, makes no model calls and never writes to the graph. Handwritten targets remain active independently of graph contents, including after restart. Cue rows and the Archive have no creation controls.

### Library and review

The library uses the native Deck → Proposition → Cue tree, with search and Create deck grouped inside its bordered panel. Click a deck name to rename it inline (Enter/blur saves; Escape cancels); its adjacent outlined Review button starts deck review. Stacked-card glyphs mark decks and the Archive branch. Muted gear menus retain deck settings, memberships, editing/deletion and ordering. Click a cue for a rich question/answer preview, with the proposition name as its single dialog heading and the same centered question/divider/answer styling as review. The preview's red Delete button opens the shared content-deletion confirmation. Search disables ordering until cleared.

Branch selection includes descendants, mixed checkboxes show partial selection, and shared cues stay selected across decks. The action row is always visible: Review all / Practice all switch to Review selected / Practice selected when anything is selected, with natural button widths and a consistent gap as the labels expand. The selection count and Clear sit together on the right; Clear is disabled without a selection. A selection without active cues disables selected review/practice rather than falling back to the whole library; empty containers can still be selected for deletion. Selected review uses exactly the selected active cues, not all cues of their propositions. If a learning/relearning proposition's pinned cue is excluded, that proposition waits for a review scope containing that cue.

Review opens on the host's dimmed, blurred main-pane surface, leaving the sidebar and top bar available. The centered card contains only the question and revealed answer; the controls and dimmed shortcut hints sit outside it. Review, practice and preview cards have a landscape 16:9 minimum height based on their width, with short content centered vertically. A short revealed answer stays within that minimum-sized box; longer content expands it naturally rather than overflowing a fixed aspect ratio. No generic heading appears on the question side; the proposition name appears only after reveal. Close using the host X or Escape. The host focuses the visible card region through the public initial-focus marker. Space only reveals: after reveal it never submits a scheduled-review rating, including on focused rating buttons. Use 1–4 when focus is not in a control, click a rating, or press Enter on a focused rating button. Rating buttons use red/amber/green/blue tints for Again/Hard/Good/Easy through the shared custom-color API. Reveal is a quieter outlined button with a short “Space” hint. The ready count hugs the card's bottom edge, aligned right above the controls. Think, reveal, then self-rate Again/Hard/Good/Easy. Review is local and makes no model calls. The “N ready” count includes the current proposition, due propositions and new propositions admissible under the daily limits; future learning steps are not counted until ready. It counts shared propositions, not every cue.

Ready learning/relearning comes first, then due reviews, then new propositions. New allowance defaults to 20 per deck/day; due reviews are uncapped. A first rating counts in every containing deck; only the admitting/studied deck controls admission. Whole-library review finds an eligible deck without creating a separate global allowance.

### Delete Flashcards content

Selecting anything reveals an accessible icon-only trash button immediately right of Review selected / Practice selected. Cue preview/menu Delete and Deck settings → Delete deck… use the same single confirmation, with a muted rendered body explanation and **Delete empty decks too** checked by default. No replacement-deck picker is needed.

Selected cues are physically deleted everywhere they are shared. Removing a target's last cue removes that Flashcards target and its active schedule; surviving targets retain their other cues, schedules and memberships. Past review ratings/timestamps remain available for statistics, but review records no longer retain question/answer snapshots. With empty-deck cleanup checked, only affected decks that become empty (or explicitly selected empty decks) are deleted; unrelated empty decks survive. Unchecking keeps emptied containers. Deck deletion selects the deck's contents, including targets shared with other decks. Learning-graph nodes and native sources are never deleted.

Deletion waits until generation finishes or is cancelled, both in the UI and at the backend, so late results cannot recreate deleted content. Confirmation freezes the selection and library revision; a changed library requires a new confirmation. Lost-response retries reuse a text-free durable receipt and do not apply another deletion. Deleted questions are not retained as tombstones or fed to subsequent generations, and are not a generation blacklist.

### Generate from a file

Choose **Generate from file…** and select one PDF or UTF-8 text file. The shared host converter uses the same PDF-to-Markdown engine as notes import and the PDF-reader tools; there is no second converter in this package. PDFs are identified by their header or `.pdf` filename, so a corrupt PDF is not silently treated as ordinary text. Other filenames are allowed when their content is valid UTF-8 text, rather than restricting uploads to a short extension list. Unsupported binary/invalid text, empty documents, and PDFs without extractable text are refused. There is no OCR; mixed PDFs may omit image-only pages and present notices before generation.

The confirmation shows the filename followed by the approximate input-token count in parentheses, together in one muted body paragraph. Graph generation uses the same format with the proposition count instead of a filename. File-conversion notices appear below the summary; neither dialog adds a separate cost-warning sentence. No model calls start until you confirm. Each confirmed new file creates one deck named with its filename, including extension, which you can rename normally. The agent creates atomic facts and recall cues **only inside Flashcards**: nothing is imported into the graph. Cues for one fact share its schedule, just like graph-backed cards; file facts remain active independently of graph contents. Review, practice, daily limits, memberships, editing and statistics work the same way for both origins.

Uploading the same filename and exact converted content reopens the existing file deck without another generation run; changed content creates a new deck without modifying existing cards or progress. Generation is chunked to the configured source-text budget and uses the current cheap slot or plugin override. Accepted work continues after navigation and uses the existing cancellation/recovery mechanisms. Explicit retries process failed/cancelled/interrupted chunks, never successful ones. A confirmed file keeps its deck even if generation fails or returns no cards, with a visible result/retry state.

Conversion limits are 25 MiB per file, 26 MiB actual multipart body, 1,000 PDF pages and 2 MiB final UTF-8 Markdown including page markers; excess is refused, never silently truncated. The host allows one conversion at a time and reports busy instead of queuing. Cancellation is best-effort: input/page/output limits are **not** a hard CPU timeout or peak-memory bound, and an aborted conversion may hold the slot until the underlying parser stops. Before generation confirmation, leaving the view aborts conversion or ignores late preparation results.

Only the converted Markdown is retained under plugin data for retry and repeat-file identification, not the original upload. This text and the duplicate-detection record belong to the file deck: keeping an empty deck keeps both, and identical uploads reopen it without regeneration; deleting that deck removes both, so a later upload can offer fresh generation. Moving its targets to other decks does not transfer ownership of the saved source text; those local targets remain usable after the original file deck is deleted. Normal background-task records also retain their generation inputs. Uploads do not create graph sources or trigger the graph extraction pipeline.

### Spaced-repetition overview

Below the deck panel, the library-wide dashboard shows new/learning/review/relearning proposition counts, current due dates (overdue, today and the next seven study days), and fourteen study days of scheduled-review activity. Shared propositions count once; archived propositions and groups without active cues are excluded from the current-state and due charts. The due chart shows existing next due dates, not a prediction of future repetitions. Activity counts recorded ratings, including historical reviews of cards later archived or deleted, rather than unique propositions. Search and selection do not filter the overview. The overview shares the rating palette: New blue, Learning amber, Review green, Relearning red. Due bars use red for overdue, amber for today and blue for future days; activity bars are green. Only the due chart's second-line dates are dimmed, leaving weekdays and activity dates unchanged.

### Extra practice

Choose **Practice selected / Practice all** in the selection row; practice is not duplicated in deck gear menus. Practice snapshots active cues in saved deck/proposition/cue order, deduplicating shared cues and excluding archived/deleted cards. It includes new and non-due cards without a daily limit. Reveal each answer, then select Next; Space reveals or advances. There are no ratings, schedule changes, introduction charges or history writes. Each cue appears once in that practice session. The practice counter counts other cues still in the snapshot, excluding the displayed cue. The counter hugs the card's bottom edge above the controls. “Practice mode does not change your review schedule.” sits centered near the bottom of the pane, flowing below long content instead of covering it. Reveal and Next are quiet outlined buttons with short “Space” hints. Close with the host X or Escape.

Settings control desired retention (initially 90%), learning steps (1m 10m), relearning steps (10m), local study-day start (04:00), source chunk budget (approximately 4,000 tokens of source text, excluding instructions and additional context), and generation model/thinking overrides. The model section has its own Follow cheap slot toggle: on follows both model and thinking and hides the override rows; off pins the current cheap model/thinking when available, or opens an unsaved model-selection draft if no cheap model is available. The Model setting uses the native sans label and standard “Follow cheap slot” description underneath it, with the toggle on the right. When off, only the model and thinking pickers appear side by side below, aligned right, without extra labels or a separate default-thinking/reset button. This uses the existing settings API without custom fonts, private widget styling, or extra API fields. Turning the toggle back on clears both overrides; no extra setting or schedule change is introduced. FSRS-6 uses published parameters and deterministic intervals (no fuzz or optimizer). Learning repetitions use the same cue; normal review weights cue selection by its latest self-rating. The schedule is proposition-level, intentionally not identical to card-level Anki scheduling.

Questions/answers use the host's real Markdown rendering, including code, tables, math and Mermaid. Edit cards without resetting progress. Deleting a cue physically removes it from plugin card storage; generation sees only current active cards, never a deleted-card backlog. If its graph proposition disappears, its collection is archived and excluded from review; the same ID returning makes it active again. Source deletion does not reorganize surviving cards.

## Generation prompts

All generation prompt wording lives in **`src/generation-prompts.cjs`**:

- **`cardWriting`** — the shared retrieval-task framework: target selection versus cue design; coherent atomic facts; distinct access routes; focused, precise, consistent, tractable and effortful questions; fair self-assessment; false-positive/false-negative checks; and selective, nonredundant cue sets. Examples use request throughput and database transactions. Edit this to change both generation entry points together.
- **`inputSafety`** — quoted-source handling and grounding requirements.
- **`outputProtocol`** — concise Markdown capabilities, LaTeX delimiters, literal dollar signs (escaped prose/currency versus code tokens), Mermaid labels, JSON/backslash/newline escaping, and the shared `submit_result` completion/repair procedure. There is no callout or emphasis guidance.
- **`graphSourceInstructions` / `fileSourceInstructions`** — source-specific tasks, context rules, cardinality and result-shape instructions.
- **`graphPromptFor` / `filePromptFor`** — the per-chunk user messages and JSON payload wrappers.

Both workers use composed instructions from that module. Like core extraction, the **chunk budget covers source material only**, estimated as characters divided by four (rounded up): graph generation sums each selected target's name plus newline plus statement, and file generation counts the Markdown being chunked. Instructions, output schemas, IDs/JSON wrappers, neighboring propositions/chains and existing active cards do not consume that source budget. Graph targets remain indivisible; a target exceeding the source budget gets its own chunk. File chunks retain the existing lossless paragraph/newline preferences and Unicode-safe splitting, including exact retry spans.

The **full-request estimate is separate**: it still counts the composed instructions, actual output schema and complete user message using UTF-8 bytes divided by three (rounded up), plus the existing 256-token overhead allowance. Confirmation dialogs report this full input estimate for cost awareness, and model-context checks reserve output space against the full request, not just the source. Changes to the writing framework do not change source-chunk grouping. Result schemas, validators and chunking remain in `src/backend.cjs` and `src/file-generation.cjs`; those mechanics differ between graph targets and extracted file facts. Source-specific instructions still determine whether to use supplied targets or extract new facts, while safety and output mechanics remain separate from the writing framework.

## Data and lifecycle

Plugin-owned state is `data/flashcards.json`: a versioned JSON snapshot, atomically replaced after local mutations. It contains decks, cues, schedules, review records, generation progress and lightweight file-source metadata. Handwritten targets use a local origin; cue creation receipts make manual-save retries idempotent even after restart, subsequent editing or deletion. Converted file text is stored separately under `data/sources/`, keeping large documents out of the snapshot rewritten on each review. Existing graph-backed records remain compatible and retain their schedules and history. Host-owned task records remain under `data/tasks/`; the plugin does not overwrite them. Disable/update preserves live cards and progress. Store migration atomically purges legacy deleted-cue tombstones and old question/answer review snapshots, moves manual retry receipts out of cues, and forgets orphan upload records whose decks were deleted by older versions. Saved-source removal uses a durable cleanup queue, so a filesystem failure is reported and can be retried or completed on the next activation without restoring a deck. A corrupt/unsupported store is an error, never silently reset.

Review content mounts own only their DOM, widgets and timers. Host presentation cleanup/remount (including development StrictMode replay) does not close the logical review session; actual close, reopen and owner abort still tear down its content scopes. Accepted review ratings and worker chunks are applied once. Cancel closes the batch's application gate before cancelling outstanding tasks; previously applied chunks remain. Restart reconciles durable worker outcomes without replaying unfinished model work. A failed save is visibly separate from successful model generation; retry saving does not make another model call. All content deletion waits until generation finishes or is cancelled to avoid stale results and destinations.

The store is deliberately small and simple: one backend process owns writes. Simultaneously running independent app-server processes against the same plugin data directory is not supported. If dataset size makes rewriting the snapshot expensive, measure that concrete case before introducing more storage machinery.

## Tests and boundaries

With test dependencies available:

```sh
npm test
```

The plugin tests cover storage/migrations, deletion and retry receipts, deck-bound
source cleanup, manual creation, mocked generation/cancellation/recovery, cue-filtered
review, memberships, scheduling and DST statistics, the dashboard, read-only practice,
tree selection and frontend lifetimes. Document conversion and host widgets are mocked;
these checks do not call a model or establish actual-host document conversion or cue quality.

The DOM tests also require **`linkedom`**, which is supplied by the LearnHarness checkout
but is not declared in this project's package manifest. A copied project needs that
test prerequisite supplied separately; its build only needs the declared `esbuild`.

`npm run test:native` is a checkout-oriented maintainer harness, not a standalone-kit
check. It requires `puppeteer-core`, local Chrome, an Electron Node runtime (checkout
path by default, or `LH_NODE_RUNTIME`), an already built matching host in
`LH_STANDALONE` and its `LH_APPROVED_HOST_DIGEST`, plus the built plugin. It copies
host/package bytes into disposable storage and exercises native widgets against
synthetic records with loopback catalog traffic. The harness assumes a
Community-loaded `flashcards` fixture; that admission assumption is not compatible
with the reserved Core ID on a Core-packaged host. Do not treat it as an instruction
to install a Community duplicate or as a portable Core smoke test. Browser fixtures
are not physical Electron-window, real-provider or human UX acceptance.

## Source reading route

- [`src/main.js`](src/main.js): public view/actions/settings, knowledge selection,
  document conversion and frontend/backend calls.
- [`src/library-tree.js`](src/library-tree.js), [`src/review.js`](src/review.js),
  [`src/practice-queue.js`](src/practice-queue.js) and [`src/dashboard.js`](src/dashboard.js):
  controlled tree state, surface lifetimes, read-only practice and statistics UI.
- [`src/backend.cjs`](src/backend.cjs), [`src/file-generation.cjs`](src/file-generation.cjs)
  and [`src/generation-prompts.cjs`](src/generation-prompts.cjs): worker definitions,
  chunking, validation, explicit confirmation and durable outcome application.
- [`src/store.cjs`](src/store.cjs), [`src/scheduler.cjs`](src/scheduler.cjs) and
  [`src/statistics.cjs`](src/statistics.cjs): plugin-owned records and domain algorithms,
  not host API requirements.
- [`scripts/build.mjs`](scripts/build.mjs) and [`tests/`](tests/): packaging guards and fixtures.

See the [example map](../../docs/plugin-examples.md),
[authoring guide](../../docs/plugin-authoring.md) and
[API reference](../../docs/plugin-api/README.md).

## License

AGPL-3.0-only, matching LearnHarness. The dependency-free FSRS subset is selectively adapted from MIT-licensed `ts-fsrs@5.2.3`; see `FSRS-LICENSE.txt`.

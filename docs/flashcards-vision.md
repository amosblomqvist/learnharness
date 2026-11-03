# Flashcards: product vision

**Status:** Native-first implementation authorized by the human. Keep v1 simple: one self-contained plugin package/local store, generation, library, and spaced review. No Anki integration. The plugin is also a reference consumer for improving the still-evolving host API: report awkward, hacky or disproportionate integration work rather than building a workaround.

## Why this belongs in LearnHarness

LearnHarness aims to maximize real, usable understanding per unit of mental effort. The point is not to remove the learner's struggle with the material, but to remove the logistics around it.

Teaching and recall solve different problems. A learner can follow a lesson, understand its reasoning, and still fail to bring the relevant fact to mind later. That does not make the understanding fake. Understanding a proposition and having it available in the situations where it is useful are different achievements.

Recall operates on cues: features of a situation that bring something to mind. Teaching initially gives a proposition a narrow set of cues, closely tied to the lesson. Practice broadens and strengthens that set.

Flashcards provide a deliberately small part of that solidifying process: native, spaced fact recall drawn from the propositions already represented in LearnHarness. They do not replace teaching, reasoning practice, or the existing adaptive practice sessions. Nor does remembering an answer demonstrate that the learner understands the reasoning beneath it.

The native experience is the product. Anki export/import is deferred entirely; none belongs in version one.

## The central model: proposition, cue, card

The hierarchy is:

> Deck (source-based by default) → Proposition → Cue/card

The proposition is the knowledge target. Each cue is a different situation or demand that should bring that proposition to mind. Each cue corresponds to its own flashcard, containing just two content fields: **question** and **answer**.

Both fields support the app's standard built-in rich rendering: Markdown, mathematical notation, syntax-highlighted code blocks, tables, callouts, Mermaid diagrams, images, and normal typography. Two fields does not mean plain-text-only fields. Reuse the host rendering stack through its supported static Markdown mount rather than copying private components, bundling another native renderer, or disguising flashcards as worker-result widgets.

The approved shared renderer displays static content without auxiliary copy/download/retry/expand/zoom/disclosure controls and without registered plugin code-block widgets. Ordinary links retain their normal behavior. The host implementation is verified and exposes a general static Markdown mount with standard update/disposal and per-mount cancellation. Question and answer rendering use that public contract.

This is not one card whose question randomly changes shape. Different cues are separate cards so their review outcomes can be distinguished. They share a proposition, not an identity.

The generation principle is:

> Search for different reasons the proposition would need to come to mind—not merely different ways to ask for it.

Paraphrasing a question does not by itself create a useful new cue. Conversely, an answer need not repeat the proposition verbatim: it should answer the particular question accurately while exercising that proposition.

There is no fixed quota of cards per proposition and no mandatory cue taxonomy. Some propositions warrant several useful cues; some warrant fewer. When existing cards already cover the useful cues, generating zero additional cards is a valid result.

## First-version boundary: fact recall

Version one exercises **one proposition at a time** through concise question-and-answer cards.

It does not introduce reasoning-chain cards, multi-step derivation exercises, sequence-construction cards, or agent-graded problems. Those possibilities are not rejected forever; they are outside this first version.

Reasoning chains still matter. The generator may see the reasoning context around a proposition so it can understand its meaning, assumptions, and uses. A chain's premises are jointly sufficient: context must not turn “A and B imply C” into the false claim “A alone implies C.”

The distinction is intentional: reasoning informs which fact-recall cards are sensible without turning the review interaction into a reasoning lesson.

## A library organized around the existing knowledge

The library should feel like the reasoning-chains view: a compact, expandable, folder-like hierarchy rather than a flat pile of unrelated cards. Version one uses **flat decks, without subdecks**. Each deck expands to propositions, and each proposition expands to its cues/cards.

Default decks correspond to teaching sources: teaching sessions or imported notes. A proposition's initial deck is determined by its birth source, the first surviving provenance source used by the graph's region grouping. Multiple generations from the same source accumulate in that source's deck rather than creating generation-specific decks.

Decks are **collections of references, not exclusive owners**. A proposition may belong to multiple decks, but it still has exactly one cue collection, FSRS state, and review history. Reviewing or editing it through one deck affects the same record visible through every other deck. The graph proposition's identity remains the anchor; membership never creates a copy.

The learner can create custom decks and add or remove proposition memberships, allowing a large notes source to be split into useful study collections or several small sources to be combined. Each proposition must retain at least one deck membership. Removing its last membership, including through deck deletion, requires choosing another deck; deleting a collection does not delete its cards, schedule, or history. There is no automatic Unfiled deck in version one. These actions do not rewrite teaching-source provenance or reorganize the core graph. The deck/library tree belongs to the plugin; a general-purpose host tree API is not part of the selected scope.

This source-based, shared-membership design supersedes the earlier generation-created decks, exclusive ownership, automatic moves, and nested-deck plan. Standard Anki has single-deck card ownership, so shared membership is an intentional native extension, not a claim of identical Anki deck semantics.

The learner can edit and delete generated cards in the library. Generation does not require a separate draft-approval stage: successful additions are available for review immediately.

The plugin is named **Flashcards**, with plugin ID `flashcards`.

Being an official plugin does not make its dependencies application-wide. Third-party feature dependencies belong in the plugin's own package manifest and lockfile and are bundled with its distribution, not added to LearnHarness's root dependencies or installed into the app at runtime. Host runtime capabilities and supported public APIs remain the boundary.

## Generation is explicit, contextual, and additive

The learner decides what enters the flashcard system. Version one has no automatic generation when a teaching session finishes or graph content appears.

Proposition/reasoning-chain selection reuses the **actual host chains view**, rather than a new picker implementation inside Flashcards. The interaction should mirror the new-practice selection bubble: open the full-view selector, select knowledge, then close it while retaining the selection in the plugin's workflow. It need not be embedded among other plugin controls or inherit the graph canvas's current selection.

The existing source renaming, folder creation, and drag behavior in that host view are wanted and may remain available. They are intentional host source-management actions, distinct from plugin-owned deck moves. The shared selection experience is accessed through a supported host UI capability; Flashcards must not import or copy private host components.

Generation receives the selected propositions, their immediate reasoning-chain neighborhood, and existing cards for those targets. Include every chain directly involving a target and preserve all of each chain's premises and conclusion. Do not recursively expand the graph or include full teaching transcripts in version one. Existing cards are important context: the task is to find useful missing cues, not regenerate a proposition's collection from scratch.

First generation assigns a proposition to its birth-source deck. Repeated generation adds useful missing cues in place; it does not create a new deck, move the proposition, or change its existing memberships.

Repeated generation preserves manual edits, existing cards, review history, and the proposition's schedule. It adds useful missing cards rather than replacing what is already there. The exact creation timing of initially needed source decks, including zero-card results and failed chunks, remains an implementation-plan decision.

Generation follows LearnHarness's current **cheap model slot** unless the learner has explicitly configured a plugin-specific model/thinking override. Clearing the override returns to following the slot. The slot is resolved when generation starts, not copied permanently into plugin settings. An unavailable or unconfigured model produces an explicit error, not a silent fallback.

The worker must be able to repair an invalid submission in the same conversation. A failed output validation is feedback for correction, not a reason to discard the context and start over. Runs are bounded, and failure to produce an accepted result must not be presented as successful generation.

Large selections are split into configurable chunks, initially targeting **4,000 estimated input tokens**. The budget concerns the assembled generation context, including reasoning and existing cards, not just the proposition statements. Each proposition has one owning chunk; its work is not split across competing workers. Independent chunks can execute in parallel through host-managed worker execution and shared request admission.

If one proposition's complete required context cannot fit the configured budget, preflight reports that explicitly before generation starts. The learner can increase the budget or reduce the selection. Do not silently drop premises, omit targets, or truncate existing cards to make the request fit.

Version one allows **one active generation batch at a time**, with independent chunks within that batch running in parallel. Another generation request is explicitly blocked while the batch is active, rather than creating overlapping work.

Successful chunks are accepted independently and their cards become available without waiting for the whole batch. A failure in another chunk does not discard accepted work. Cancellation stops further additions without removing cards already accepted, and a batch with failures is visibly partial rather than reported as successful.

Exact packing, limits, and retry behavior still require an implementation plan. The vision does not imply unlimited parallelism, a competing plugin-local admission system, or automatic replay of interrupted work.

## Review: one cue, one proposition-level schedule

A review presents **one cue/card for a proposition**, not all its cues in succession.

The interaction is intentionally familiar and simple:

1. Read the question and attempt recall.
2. Reveal the answer.
3. Self-rate with **Again**, **Hard**, **Good**, or **Easy**.

There is no thinking field, typed answer requirement, or agent evaluation in this first version. This is a deliberate narrower interaction than LearnHarness's teaching and adaptive practice sessions.

New introductions are paced by an adjustable **per-deck** daily limit, initially **20 previously unreviewed propositions per deck per day**. This supersedes the earlier plugin-wide introduction limit. Due reviews are uncapped, including learning/relearning repetitions. The introduction count is per proposition, not per cue or presentation; it does not limit card generation, library browsing, or learning elsewhere in LearnHarness. A shared proposition is introduced only once globally, and that first introduction counts against **every deck containing it**, regardless of which deck was used for the review. It does not become new again when encountered through another deck. Only the deck being studied controls admission of a new proposition. A full or zero allowance in another containing deck does not block that introduction, but the introduction still counts there; a deck's count may therefore exceed its limit because of reviews through other decks.

Normal review handles existing obligations before new introductions: ready learning/relearning steps first, then due reviews, then new propositions up to the applicable deck limit. A large overdue backlog therefore takes priority over new material.

The learner can review the whole library or narrow scheduled review to selected decks or propositions. Filtering does not create separate scheduling states or turn review into an early/cram mode.

There are no subdecks or parent-deck limits in version one. Adding nested organization later need not duplicate propositions or reset their schedules; its limit behavior would need its own design.

Scheduling uses **FSRS**, with one scheduling state per **proposition**, not per cue. The rating updates that proposition's schedule. This avoids treating each new cue as an entirely separate fact with its own independent review obligation.

The chosen algorithm reference is **FSRS-6**, pinned to the published `ts-fsrs@5.2.3` implementation. The scheduler will be implemented without a runtime scheduler dependency, retaining the reference's MIT attribution. Version one uses published default parameters; personalized parameter optimization is deferred. Review history is retained independently of that decision.

Desired retention is one plugin-wide setting, initially **90%**, rather than a separate target or preset for each topic. Higher targets trade more frequent reviews for higher expected retention.

Short-term review uses Anki-style learning and relearning steps, initially **1 minute, then 10 minutes** for new propositions and **10 minutes** after a lapse. These steps are editable in the plugin's settings; version one does not rely on FSRS's experimental empty-steps mode for all short-term intervals.

This is an adaptation of Anki-style scheduling, not a claim of identical Anki behavior. Standard Anki schedules cards independently. Here, a proposition is scheduled while the cue used to test it can vary. A success on one cue is therefore not proof that every cue for that proposition is equally strong, and the standard scheduler's retention predictions are not a guarantee for this adapted setup.

## Cue choice is a separate problem from scheduling

When a proposition is due, the plugin chooses which of its cues to present.

Selection mixes untried and reviewed cues. Untried cues need opportunities to be exercised; weaker reviewed cues should be favored; stronger cues must remain eligible. Favoring weaker cues means **weighted choice**, not always selecting the single weakest cue.

Cue-level outcomes are retained to inform this choice, even though the proposition owns the FSRS state. The separation is fundamental:

- The proposition is the knowledge target and scheduling unit.
- The cue/card supplies a retrieval route and has its own observed outcomes.
- Review history records what was actually shown and how it was rated.

Version one's selection rule uses each reviewed cue's most recent rating, with relative weights **Again 4, Hard 3, Good 2, Easy 1**, and **3 for an untried cue**. A cue can therefore recover from an older failure rather than being permanently penalized by it. Full review history is still retained. These are explicit, simple selection heuristics, not FSRS parameters or a claim of optimal weighting.

Learning and relearning repetitions keep the same cue until the proposition returns to normal review. A new weighted choice is made for the next normal review. This keeps an immediate repair focused on the retrieval route that needed work rather than switching away from it.

## Keep knowledge and learner evidence separate

LearnHarness's graph is an objective representation of propositions and their reasoning relationships. Presence in that graph is not evidence that the learner can recall a proposition, or that they have mastered it.

The plugin reads that knowledge and owns its cards, scheduling state, and review history separately. It does not write mastery values, learner difficulty, or review results into the core graph. Creating a card does not create evidence of learning.

The relationship is also non-destructive. If a card's proposition ID can no longer be found in the graph, its cards move to an **Archive** section outside normal review. The plugin retains its own content, proposition snapshots, and history. Deleting graph data never silently deletes plugin-owned data.

Deleting a reasoning chain alone does not archive cards when the proposition itself still exists. If an original source is deleted but the proposition survives through other provenance, preserve its existing deck memberships and retain the old source deck with its stored label. Do not automatically follow the graph's re-attributed birth source or reorganize custom collections. The live proposition remains eligible for review. Archive presentation and restoration details remain to be settled.

## Deferred Anki integration

The human removed all Anki integration from v1. There is no export/import UI, packaging library, SQLite WASM asset, converter or Anki-specific verification requirement. Revisit integration only if requested after the native plugin is useful.

## What this first version should make possible

The learner can select knowledge they care about, generate genuinely different fact-retrieval cues without managing prompts, and maintain those cues in a familiar hierarchy. They can return for a straightforward spaced-review session without a model call at every answer. Their work remains native to LearnHarness, without an integration dependency on another application.

The success criterion is useful availability of known facts—not card count, duplicated paraphrases, or a mastery label inferred from the graph. The plugin should spend the learner's effort on attempted recall and keep everything around that interaction as bare-bones as possible.

## Implementation notes

The human authorized beginning implementation rather than further exhaustive planning. Use a simple native implementation; bring consequential new ambiguities or genuine infrastructure friction back to the human as they arise. The earlier detailed draft is not blanket approval for its proposed machinery. The following historical checklist is context, not a prerequisite to more planning:

- **Scheduling policy:** retention/step-setting bounds and change behavior; interval randomization and day-boundary behavior; ordering within due/new queues; membership changes after an introduction and whole-library/multi-deck review.
- **Generation contract:** exact prompt and result schema; token estimation and packing; output/repair budgets and task limits.
- **Batch lifecycle:** retries, interrupted work, detailed progress/cancellation interactions, and the creation timing of initially needed source decks. Shared request admission is provided by the host, not a separate plugin concurrency setting.
- **Product UI:** concrete plugin-owned deck/library/review layouts and controls; custom-deck naming/deletion and membership-editing controls; card editing/deletion; archive restoration; and progress/error presentation. Use the verified shared Markdown renderer for card content.
- **Delivery:** plugin source/build/distribution location and the coherent implementation and verification plan.

Resolving these must preserve the distinctions that motivate the plugin: understanding versus availability, propositions versus cues, scheduling versus cue choice, objective knowledge versus learner evidence, and product functionality versus unnecessary integration machinery.

## Conceptual foundations

This vision applies the teaching/practice/world-model distinction articulated in the human's *How I Learn Difficult Things With AI* and *The learning harness — canonical articulation* (2026-10-05), together with the subsequent direct product decisions for Flashcards. It is intentionally narrower than the broader assessment-and-adaptive-practice direction described there.

# Image Paste in the Chat Composer: Spec and Implementation Plan

Date: 2026-10-24
Status: Draft for approval. Documentation only, not ready for implementation.

This document follows the /to-spec template. The user requested a local Markdown file, so no issue is published. Product choices that the conversation has not resolved remain explicit approval gates.

## Implementation Status (2026-10-24)

Owner instruction ("create a new branch and make the changes") resolved the gates below to the MINIMUM scope. What ships on `feat/composer-image-paste`:

- **Surface:** the composer of an EXISTING session (teach and practice). New-session drafts and active-turn steering are NOT included. A pasted image in the draft composer is ignored, and a draft holding an image cannot steer a running turn: the send is a no-op until the turn settles (Enter never aborts the turn).
- **Storage:** bounded inline base64 inside the native user message (no attachment store).
- **Limits:** PNG, JPEG, WebP or GIF; 4 images; 5 MB per image; 10 MB per message. The client refuses early and the server re-validates and answers 400 before the write-ahead appends anything.
- **Draft UX:** thumbnails above the input, a cross at the thumbnail's TOP-RIGHT removes one, and CLICKING a thumbnail (or a sent image) opens it full size in a session-scoped lightbox (Esc or backdrop closes). One-line inline refusal for a bad paste. A caption is optional.
- **Tests:** the browser suite `tests/e2e/image-paste.e2e.mjs` (`npm run test:e2e`, real Next server + Chrome) is the acceptance gate for the composer UX. The protocol and storage seams keep focused coverage in `tests/image-paste.test.ts` and the handler cases in `tests/chat-flow.test.ts`.
- **Known limits:** the compaction estimator counts no tokens for images (summaries name them, never inline them); the markdown export renders no images; a text-only model surfaces the provider's own error.

# Part 1: Specification

## Problem Statement

Learners cannot paste an image into the chat composer. This prevents them from bringing screenshots, diagrams, and visual problems directly into a teaching or practice conversation.

Adding a clipboard event alone will not solve the problem. The current input contract, message constructors, draft flow, and transcript projection are text-oriented.

## Solution

Let the learner paste clipboard image content into the composer and send it to an image-capable conversation model through the existing session pipeline.

Recommended behavior, subject to approval:
- Show a removable preview before sending.
- Support a caption with an image, and allow an image without a caption.
- Keep ordinary text paste and existing keyboard behavior unchanged.
- Show the sent image in the transcript and retain it when the chat is reopened.
- Keep the draft recoverable when the server refuses the submission.
- Report unsupported content or model capability without silently discarding an image.

New-session creation and active-turn steering are unresolved scope choices. They must not be silently included or excluded.

## User Stories

The following stories describe the proposed acceptance surface, not additional confirmed requirements.

1. As a learner, I want to paste a screenshot, so that I can discuss what it shows.
2. As a learner, I want to paste a diagram, so that I can ask about visual relationships.
3. As a learner, I want to include a caption, so that the teacher knows my question.
4. As a learner, I want to send an image without text, so that I do not need a filler caption.
5. As a learner, I want to preview an image before sending, so that I can check what I selected.
6. As a learner, I want to remove an image from the draft, so that I can correct a mistake.
7. As a learner, I want ordinary text paste to remain unchanged, so that existing input habits still work.
8. As a learner, I want the teacher to receive the image itself, so that its answer can use visual information.
9. As a learner, I want sent images to remain visible after reopening a chat, so that I retain the context.
10. As a learner, I want a rejected send to preserve my draft, so that I can correct the problem.
11. As a learner, I want a clear error for an unsupported format or oversized image, so that I know what to change.
12. As a learner, I want clear feedback when the selected model cannot read images, so that an image is not silently ignored.
13. As a keyboard user, I want accessible remove controls and status feedback, so that image handling does not require a mouse.
14. As a desktop user, I want system screenshot paste to work in Electron, so that I can use the same workflow as in the browser.
15. If new sessions are included, as a learner I want an image in my first message, so that I can start with a visual problem.
16. If active-turn steering is included, as a learner I want the image to accompany the queued message, so that it reaches the teacher at the next response boundary.
17. As a maintainer, I want the existing session, store, and provider contracts reused, so that this feature does not create a second chat pipeline.

## Implementation Decisions

### Established constraints

- Preserve the pure domain core, adapter boundaries, public barrels, and single-writer chat store.
- Send one explicit input event, not a client-authored transcript.
- Keep server-owned canonical history and existing write-ahead persistence.
- Use native user message image blocks rather than a parallel attachment history.
- Keep clipboard access and file reading in the browser adapter, not the pure core.
- Keep routes thin and place orchestration at existing server entry points.
- Extend the current controlled composer rather than replacing it with a new editor.
- Use installed dependencies and platform APIs. No new dependency is justified by the current request.
- Preserve existing text-only callers and stored text messages.
- Do not change question or practice-answer contracts merely to add composer paste.

### Recommended approach, not yet approved

Extend the current text input event with optional native image content. Use the same validated content for the optimistic message and the server append.

The native message type already supports image blocks. Preserve string content for existing text-only messages; use native mixed content for image-bearing messages. Do not store transient browser object URLs as durable image content.

For a small first version, bounded inline image data in native chat records is the simplest candidate. It reuses the existing store and provider pipeline, but increases JSON sizes, memory use, and request sizes. This choice is not approved and requires explicit limits.

Validate at the server boundary as well as in the UI. Check the allowed media types, encoding, actual content, image count, decoded byte sizes, and total request budget. Refuse invalid input before appending history or starting a turn. Do not log image bytes.

Check the selected conversation model's image capability. Also define the behavior when a later model change encounters image-bearing history.

### Alternatives considered

1. **Extend native messages with bounded inline image data.** Least new infrastructure and closest to the current history model. Tradeoff: larger record reads, writes, and browser state.
2. **Store image files separately and reference them.** Keeps chat JSON smaller. Requires an attachment store, authorization/ownership checks, serving, deletion, backup, and provider hydration.
3. **Add only a paste preview.** Not sufficient: the model and reloaded transcript would still lose the image.

Recommendation: option 1 if the approved size budget fits the current local-first store. Otherwise select option 2 and revise this plan before implementation.

### Approval gates

Resolve these before writing production code:

- **Surface scope:** existing chats only, or also new-session drafts? Include or exclude active-turn steering explicitly. The previous clarification was not answered.
- **Payload policy:** approved formats, image count, per-image decoded byte limit, total message limit, and maximum request size.
- **Image processing:** reject oversized content or resize it? No compression or resizing policy has been approved.
- **Clipboard semantics:** decide how to handle mixed text/image clipboard entries and multiple images without duplicate content.
- **Storage:** inline native content or separate files, with explicit approval of the size and privacy tradeoffs.
- **Draft UX:** approve preview placement, removal behavior, feedback wording, and image-only send behavior.
- **New-session handoff, if included:** approve a non-URL handoff, title fallback for image-only messages, and retry behavior.
- **Capability policy:** decide what users see when a text-only model is selected or image history is reopened with one.

## Testing Decisions

Prefer existing externally observable seams over new internal abstractions:

- Primary integration seam: the injectable session model plus chat request handler. Assert submitted content, persisted native messages, provider context, and replay.
- Core tests: input parsing and native message projection, including invalid content and legacy text compatibility.
- Rendering tests: extend the existing static React render tests for composer controls and user transcript images.
- Provider regression: extend the existing ChatGPT image request test; add equivalent coverage for enabled non-ChatGPT providers where needed.
- Manual browser/Electron checks: actual clipboard events, screenshot paste, caret behavior, focus, preview removal, and object URL cleanup. Static rendering cannot prove clipboard behavior.

Tests must assert user-visible or protocol-visible results, not private React state or exact helper structure.

The existing test suite uses node:test, node:assert/strict, tsx, injectable fetch, and React static rendering. Keep those patterns. Do not introduce a separate browser-test framework for this change without approval.

The proposed seams are documented for review; they have not yet been approved by the user.

## Out of Scope

Unless separately approved:
- File picker and drag-and-drop attachment entry points.
- PDF, audio, video, or arbitrary file attachments.
- OCR services, image editing, crop tools, or a new vision agent.
- Cloud storage, a generic upload platform, or attachment management screens.
- Images in structured quiz answers, practice-thinking fields, or dictation.
- A redesign of the composer, dock, or transcript.
- A new state library, provider protocol, or parallel persistence system.

## Further Notes

- Pasted screenshots may contain sensitive content. Sending an image sends its content to the selected model provider and stores it with the chat under the approved persistence policy.
- The ChatGPT adapter already has an image request regression test. That is evidence of one adapter path, not end-to-end paste support or universal model support.
- The current transcript projection discards non-text user blocks. It must change even though the native type supports images.
- The new-session flow currently transfers the first prompt through a URL query parameter. Never put image bytes in that parameter.
- The current composer uses a separate steer route while a turn runs. Supporting idle sends alone does not establish steering support.
- The installed Next.js guide directory was absent during inspection. Before changing framework code, restore dependencies and read the relevant installed guides as required by AGENTS.md.
- No issue tracker or triage vocabulary was supplied. For future tracker publication via /to-spec, run /setup-matt-pocock-skills first. This local draft must not be labeled ready-for-agent while approval gates remain open.

# Part 2: Implementation Plan

> For agentic workers: after approval, use superpowers:executing-plans or superpowers:subagent-driven-development to execute the checklist. Do not interpret unresolved gates as permission to choose defaults.

**Goal:** Add image paste through the existing composer, session pipeline, native history, and transcript.

**Architecture:** Browser adapters capture clipboard images. The pure core validates the approved input contract and constructs native messages. Existing server services persist and dispatch those messages; the view projection renders them.

**Tech stack:** React 19, Next.js 16, TypeScript, native browser clipboard events, pi native messages, node:test, and tsx.

**Spec:** Part 1 of this document.

## Global Constraints

- No production implementation before scope and payload-policy approval.
- Preserve current import restrictions and public barrels.
- Preserve text-only callers, keyboard behavior, dictation, pending-question gates, practice gates, and compaction gates.
- Reuse native messages and the existing chat store.
- No image bytes in URLs, logs, or transient-only persistence.
- No new dependencies without approval.
- If separate-file storage is selected, replace the inline-data tasks with an approved attachment-store design first.

## Review Focus

1. A refused submission must not lose images or overwrite newer draft edits.
2. A paste followed immediately by Send must not race unfinished file reading.
3. Retrying a request must not append a second copy of the image message.
4. Text-only models and later model changes must not silently drop images.
5. Large image history must not leak base64 into summaries, exports, logs, or extraction prompts.

## File and Responsibility Map

Confirmed current integration points:
- `components/composer.tsx`: controlled textarea, send/stop/next controls, clipboard event and preview surface.
- `components/chat.tsx`: draft ownership, send gating, dictation, refusal recovery, transcript rendering.
- `components/session-core.ts`: optimistic message, request submission, retry, replay, and steering state machine.
- `components/session.ts`: thin React adapter around the session model.
- `src/core/input-events.ts`: input contract, parsing, and server append mapping.
- `src/core/native-messages.ts`: native user/steer constructors and model-facing conversion.
- `src/core/view.ts`: native user content to transcript parts.
- `src/core/index.ts`: browser-safe public exports.
- `src/server/chat-handler.ts`: server admission, model resolution, write-ahead persistence, turn orchestration.
- `app/api/chat/route.ts`: existing thin transport; no new upload route for the inline approach.
- `src/store/chats.ts`: existing sole chat writer; inspect preservation and read limits before changing it.

Conditional integration points:
- `components/new-session.tsx`, `app/chat/[id]/page.tsx`, and chat creation service/route: only if first-message images are approved.
- `app/api/chats/[id]/steer/route.ts` and its server delegation: only if image steering is approved.
- A small browser draft helper beside the composer: only if shared asynchronous file reading and cleanup would otherwise be duplicated.

## Task 0: Lock the implementation contract

- [ ] Review and approve the gates in Part 1, including the testing seams.
- [ ] Record exact limits, allowed formats, chosen storage, surface coverage, and UX decisions in this document.
- [ ] Replace conditional tasks with the selected scope and record exact interface signatures before execution.
- [ ] Restore dependencies and read the relevant installed Next.js guides before framework edits.

Deliverable: an approved, executable contract. Until then, the remaining tasks describe sequencing, not permission to invent interfaces.

## Task 1: Extend validated input and native messages

Files: `src/core/input-events.ts`, `src/core/native-messages.ts`, `src/core/index.ts`.
Tests: extend relevant input/native-message coverage; add `tests/image-input.test.ts` only if no existing focused home is suitable.

- [ ] Write failing tests for text-only compatibility, text-plus-image, image-only input, and rejected empty input.
- [ ] Add boundary tests using the exact approved count, byte, format, encoding, and request limits. Include mismatched media type/content.
- [ ] Run `NODE_ENV=test npx tsx --test tests/image-input.test.ts` if that file is created; otherwise run the selected existing test files explicitly.
- [ ] Extend the existing event and constructors with the approved image representation. Keep validation pure; put byte decoding that needs Node in the server adapter.
- [ ] Confirm malformed requests append nothing and start no turn.
- [ ] Run focused tests, then `npm run typecheck`.

Deliverable: one validated image-bearing input maps to one native user message, without changing old text messages.

## Task 2: Carry image content through submission and replay

Files: `components/session-core.ts`, `components/session.ts`, `src/server/chat-handler.ts`; inspect `src/store/chats.ts`.
Tests: `tests/session-core.test.ts`, `tests/chat-flow.test.ts`, `tests/chatgpt-stream.test.ts`.

- [ ] Write failing integration tests asserting the same image in the request, canonical record, reopened history, and model context.
- [ ] Cover server refusal, raced-turn retry, malformed payloads, and no duplicate append.
- [ ] Extend the optimistic append and server append using Task 1's same native constructors.
- [ ] Add capability admission at the existing model-resolution boundary, including the approved image-history policy.
- [ ] Preserve the existing write-ahead and background-turn lifecycle.
- [ ] Run `NODE_ENV=test npx tsx --test tests/session-core.test.ts tests/chat-flow.test.ts tests/chatgpt-stream.test.ts`.

Deliverable: images reach the conversation model and survive replay through the existing transport and store.

## Task 3: Capture clipboard images and manage the draft

Files: `components/composer.tsx`, `components/chat.tsx`; a local helper only if needed.
Tests: `tests/render-composer.test.tsx`; browser-adapter tests in `tests/composer-images.test.ts` if a helper is extracted.

- [ ] Write failing tests for preview/removal, image-only send eligibility, invalid-paste feedback, and unchanged text-only rendering.
- [ ] Test immediate-send during file reading, read failures, removal during reads, consecutive pastes, mixed clipboard content, and unmount cleanup.
- [ ] Add textarea-local paste handling using the event's clipboard data. Do not request global clipboard access.
- [ ] Implement the approved preview and accessible remove/status controls with existing UI tokens.
- [ ] Keep draft ownership with the existing parent, not a second hidden composer store.
- [ ] Extend send gating and refusal recovery to the whole draft. Preserve dictation finish-first behavior and do not overwrite newer edits.
- [ ] Release temporary preview resources when removed, replaced, sent successfully, or unmounted.
- [ ] Run focused tests and manually check native text paste, caret placement, Enter, Shift+Enter, stop, and practice Next.

Deliverable: a learner can paste, inspect, remove, and submit an image without losing existing input behavior.

## Task 4: Project and render sent images

Files: `src/core/view.ts`, `components/chat.tsx`.
Tests: extend existing projection coverage; add `tests/image-transcript.test.tsx` for the new rendering behavior.

- [ ] Write failing tests for image-only and mixed-content user messages, content order, legacy text messages, and reload equivalence.
- [ ] Preserve user image blocks in the existing view projection rather than filtering them out.
- [ ] Render images in user messages using approved sizing, accessible descriptions, and existing layout tokens.
- [ ] Ensure malformed historical image content cannot cause arbitrary URL loading or unsafe rendering.
- [ ] Run focused tests and check narrow-window transcript layout.

Deliverable: optimistic and reopened transcripts show the same image-bearing user message.

## Task 5: Complete approved conditional surfaces

### New-session images, only if approved

Files: `components/new-session.tsx`, `app/chat/[id]/page.tsx`, and the existing chat creation route/service.
Tests: `tests/render-new-session.test.tsx` and the creation/session integration coverage.

- [ ] Test image-only creation, the approved title fallback, successful handoff, refused send, and navigation/reload during handoff.
- [ ] Replace the text-only URL handoff for image-bearing first messages with the approved durable non-URL protocol.
- [ ] Preserve the rule that creating a draft does not create a session.
- [ ] Prove the initial image message is submitted exactly once.
- [ ] Keep graph picks, teach/practice kind, model setup, and plain-text creation behavior unchanged.

### Image steering, only if approved

Files: existing steer input parser, native steer constructor, session model, hook, chat caller, and steer route/service.
Tests: `tests/session-core.test.ts` and `tests/render-queued-steers.test.tsx`, plus server steer integration coverage.

- [ ] Test image-bearing queue submission, drain identity, a raced settle fallback, refusal, and stranded queue recovery.
- [ ] Extend the existing steer event and queue, not a parallel follow-up pipeline.
- [ ] Verify image content survives queue-to-history delivery exactly once.

If either surface is excluded, document and test the approved behavior there. Never silently discard pasted content.

## Task 6: Verify downstream behavior and acceptance

Tests: `tests/compaction.test.ts`, `tests/compaction-service.test.ts`, `tests/session-markdown.test.ts`, plus extraction/context coverage identified by tracing native user content consumers.

- [ ] Trace every changed constructor caller and every consumer of user content before finalizing the diff.
- [ ] Test that compaction, token accounting, exports, and extraction handle image blocks deliberately without treating base64 as prose.
- [ ] Preserve stored evidence through compaction and prevent unintended image duplication in background work.
- [ ] Check inline-image record size and request handling at the approved maximum.
- [ ] Run `npm test`, `npm run typecheck`, `npm run lint`, and `npm run build`.
- [ ] Manually verify screenshot paste in a browser and Electron, unsupported-image errors, draft recovery, reload, and each approved surface.
- [ ] Review the diff for import-law compliance, unnecessary abstractions, missing callers, and sensitive payload logging.
- [ ] Record actual command results and manual checks before claiming completion.

## Completion Criteria

The feature is complete only when the approved user stories pass through paste, validation, send, model delivery, persistence, and transcript replay. Tests passing without clipboard checks or without the approved new-session/steering paths is not sufficient.

## Inspection Limits

This draft is grounded in source inspection. No application code was changed. Dependencies, runtime clipboard behavior, provider capability across the full model catalog, and performance at proposed payload sizes were not verified.

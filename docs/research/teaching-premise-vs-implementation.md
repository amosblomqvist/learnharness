# Teaching premise vs. implementation

*Research note, 2026-10-27, against `main` at `3dc8847` ("chore: prepare 0.3.8"). Read-only audit: the code is the source of truth, and the docs are the claims being tested. Citations are `path:line` at that commit. `node_modules` is not installed in this checkout, so the one library behaviour this note depends on (pi-agent-core 1.4.0 turn termination and argument validation) was checked against the published package source on unpkg.*

## Summary

The teaching premise is coherent, and the docs say plainly that the system prompts are "a compression of it" (`docs/teaching-methodology.md:3`). That is also where most of it lives: **nearly all of the pedagogy is prompt text, and the code enforces only a few structural guarantees around it.**

What the code does guarantee:
- the probe → plan → teach sequence
- one *pending* question at a time, and the turn ends when a question is posed
- deterministic grading of multiple-choice answers
- a model answer committed before the learner sees the question
- schema-valid plan maps, with position derived from tagged questions
- practice problems gated by a pose/conclude pair

None of the following is enforced or measured:
- "one reasoning step at a time"
- "a check after every step"
- "never build on an unchecked step"
- "confirm the plan before teaching"
- "the goal feels obviously true"

No test or eval checks them either. The test suite is deliberately "deterministic, no LLM" (`README.md:67`).

The largest **misconception** is about persistent learner modelling:
- The README promises "a detailed picture of what you understand… updated as you learn" (`README.md:18`).
- The prober is told the graph shows "what he already holds… a strand held solid needs no re-probing" (`src/agent/prompts/prober/10-probe-doctrine.md:9`).
- In fact the graph is extracted from **teacher prose only**: no learner messages, no answers, no thinking (`src/agent/subagents/extraction.ts:127-129`). It deliberately stores "no quiz outcomes, no understanding assessments" (`src/core/contracts/graph.ts:10`).

So across sessions, "taught" is silently treated as "held". Within a session, the learner model exists only as LLM context plus a compaction summary.

## 1. The premise as stated

The canonical theory is `docs/teaching-methodology.md`. The README and the prompts restate it.

| # | Premise | Source |
|---|---|---|
| P1 | A session is bounded by two states: current understanding ("held" = accepted as obviously true) and a goal. The probe defines both precisely. | `docs/teaching-methodology.md:5-12` |
| P2 | The terminal condition is that the goal **feels obviously true**. Self-evidence is the measure of understanding. | `docs/teaching-methodology.md:14-18`; `README.md:28` |
| P3 | Teaching asserts facts in order, **one reasoning step at a time**. Each step attaches to what is held by a single step. | `docs/teaching-methodology.md:30-39`; `src/agent/prompts/teacher/20-teaching.md:3-7` |
| P4 | Errors surface instantly. Repair them before continuing; never build on anything not yet held. | `docs/teaching-methodology.md:39`; `README.md:28` |
| P5 | Foundations are unconditional truths (Principle i). Derivations are motivated ("how could I have discovered this?", Principle ii). | `docs/teaching-methodology.md:41-47`; `src/agent/prompts/teacher/05-method.md:13-44` |
| P6 | The system owns all logistics (research, planning, ordering, fact-checking). | `docs/teaching-methodology.md:51-58, 97` |
| P7 | Planning searches the **minimal tree**: nothing held is re-taught, nothing off-path is taught. The plan is a coarse map; plan nodes ≠ reasoning steps. | `docs/teaching-methodology.md:60-68, 93-95` |
| P8 | **Every reasoning step ends with a graded check** (step → check → repair-or-continue). | `docs/teaching-methodology.md:82-86, 94` |
| P9 | The cycle is predict → teach → check, with one question per turn. | `README.md:28`; `src/agent/prompts/teacher/28-predictions.md:3, 20-22` |
| P10 | The agent adapts on the learner's answers, confidence and thinking. "Your model of him updates on every submission." | `README.md:20, 26, 31`; `src/agent/prompts/shared/16-mental-model.md:5`; `src/agent/prompts/shared/25-confidence.md` |
| P11 | The plan adapts when understanding turns out different. | `README.md:27`; `src/agent/prompts/teacher/10-planning.md:27-31` |
| P12 | The learner confirms the plan before teaching starts. | `src/agent/prompts/teacher/10-planning.md:44` |
| P13 | A persistent picture of what you understand carries across sessions. Future sessions read the graph instead of starting from scratch. | `README.md:18, 20, 37-39`; `docs/development.md:5, 7` |
| P14 | Practice poses varied problems needing unprompted retrieval, with hints that adapt to reasoning. Its material is drawn from the graph. | `README.md:29, 39`; `src/agent/prompts/practice/10-doctrine.md` |
| P15 | Accuracy: verify doubtful facts before teaching them. | `src/agent/prompts/shared/15-accuracy.md:3`; `src/agent/prompts/teacher/40-jobs.md:3` |

## 2. Claim-by-claim

Status key: **Impl** = enforced or owned by code. **Prompt-only** = exists only as model instruction, with no code check (a form of partial implementation). **Partial**, **Not impl**, **Contradicted**.

| Claim | Doc source | Status | Code evidence |
|---|---|---|---|
| Separate probe and teach agents, with probe → plan → teach phases | `docs/probe-teach-split.md:9-36, 97-114` | **Impl** | The agent is chosen from the transcript seam (`src/agent/teacher-agent.ts:274-293`). The phase fold is strictly sequential (`src/core/phases.ts:73-97, 163-195`). Tests: `tests/phases.test.ts`, `tests/probe-done.test.ts`. |
| P1: the probe "brackets" every strand (floor + ceiling) | `docs/teaching-methodology.md:12, 92`; `prober/10-probe-doctrine.md:19-35` | **Prompt-only** | `probe_done` refuses only while a question is open or after an earlier conclusion (`src/agent/tools/probe.ts:68-78`). The assessment schema is a list of free-text strands (`src/core/contracts/probe.ts:145-170`). Zero probe questions is accepted, and floor and ceiling are not structured fields. |
| P2: the session ends when the goal feels obviously true | `docs/teaching-methodology.md:14-18` | **Not impl** | No end-of-session condition, signal or check exists. A session has no "done" state. Plan nodes are "never marked finished" (`src/agent/prompts/teacher/10-planning.md:33`; `docs/probe-teach-split.md:69-81`). |
| P3: one reasoning step at a time | `docs/teaching-methodology.md:34`; `teacher/20-teaching.md:3-7` | **Prompt-only** | Nothing in the code represents a "reasoning step". Plan nodes deliberately do not map to steps (`teacher/10-planning.md:19`). |
| P8: a check after every step | `docs/teaching-methodology.md:82-86` ("locked decision") | **Prompt-only** | A teacher turn may end with prose and no question. No code requires a quiz per turn or per step. The only structural rule is that a posed question ends the turn (`src/agent/teacher-agent.ts:155-175`). |
| P4: never build on an unchecked or failed step | `docs/teaching-methodology.md:39, 94` | **Prompt-only** (and structurally permitted) | "Failed checks move nothing. Results no longer feed derivation at all" (`docs/probe-teach-split.md:81`). The teacher can tag the next node after a miss and the map follows (`src/core/phases.ts`; `teacher/10-planning.md:33`). This was an explicit design choice, not an oversight. |
| P9: predict → teach → check | `teacher/28-predictions.md` | **Partial** | `type: predict\|check` is required by the schema (`src/core/question-core.ts:242-257`) and controls UI arrival: predictions open, checks collapsed (`question-core.ts:233-235`; `tests/reveal-arrival.test.ts`). Nothing checks that a predict really comes before its teaching, or that a check has prose above it. The label is the model's own claim. |
| P9: one question per turn | `shared/20-question-tools.md:26-28`; tool descriptions | **Partial / Contradicted** | The turn does end once a question is posed. That was verified against pi-agent-core 1.4.0: `finishTurn` returning `{action:"end"}` ends the loop, and a batch terminates when every result has `terminate: true` ([unpkg agent-loop.js](https://unpkg.com/@earendil-works/pi-agent-core@1.4.0/dist/agent-loop.js)). However, **several questions in one message are accepted** and answered in order, as a test explicitly pins (`tests/chat-flow.test.ts:777-825`). The model sees both answers only after both are given, so "his answer determines the next" fails for batched questions. |
| MC grading is deterministic; the answer is committed before posing | `docs/development.md:169`; `shared/20-question-tools.md:9-12` | **Impl** | `quizInputProblems` rejects ungradeable quizzes at the call boundary (`src/core/question-core.ts:110-140`). The client grades with `isCorrect` (`question-core.ts:679-684, 734-744`). Tests: `tests/question-core.test.ts`, `tests/chat-flow.test.ts:654-776`. |
| Free-recall grading is "strict against the commitment" | `src/agent/tools.ts:181-195` | **Partial** | The commitment is stored before posing and shown to the learner when they submit (`question-core.ts:295-313, 745-749`). That is a real structural guard against sycophancy. The *verdict*, though, is the model's prose in its next turn: no `correct` field is stored for `explain` answers (`question-core.ts:745-749`). |
| P10: adapts on answers, confidence and thinking | `README.md:26, 31`; `shared/16-mental-model.md`; `shared/25-confidence.md` | **Partial** | All three channels do reach the model (`compactAnswerForModel`, `src/core/question-core.ts:778-802`). What it does with them is prompt-only. See misconception M4 on confidence. |
| P11: the plan adapts | `README.md:27`; `teacher/10-planning.md:27-31` | **Impl (mechanism)**, **Prompt-only (trigger)** | `plan_init` can be re-called and replaces the tree after DAG validation (`src/agent/tools/plan.ts:54-100`; `src/core/plan-tree.ts`). *When* to rewrite is entirely the model's judgment. |
| P12: the learner confirms the plan before teaching | `teacher/10-planning.md:44` | **Prompt-only, and contradicted in practice** | The verdict gate was removed (`docs/probe-teach-split.md:104-113`). `plan_init` does not end the turn. The code handles the plan and the first teaching quiz arriving *in the same assistant message*: "the plan PRESENTATION often lives in the same assistant message" (`src/core/phases.ts:99-136`). |
| P7: minimal tree, coarse map, nodes ≠ steps | `docs/teaching-methodology.md:62-68` | **Contradicted (tool vs prompt)** | The prompt says "No size ceiling" and "a single node may take one step or five" (`teacher/10-planning.md:19-22`). The `plan_init` tool description the model also sees says "**5–15 nodes**… **one reasoning step per node**, compress" (`src/agent/tools/plan.ts:71`). Nothing in the parser enforces either. "Minimal" is not checked against the probe in any way. |
| Plan position is derived, never declared | `docs/probe-teach-split.md:61-93` | **Impl** | `nodeId` is required and validated against the live tree (`src/agent/tools.ts:354-391`). Statuses are derived from tagged calls. Tests: `tests/plan-tree.test.ts`, `tests/plan-window.test.tsx`. |
| P5: unconditional truths and motivated derivation | `teacher/05-method.md` | **Prompt-only** | Not represented in code. The plan map has no "foundation" marker. |
| P6, P15: the system owns logistics; research before teaching | `docs/teaching-methodology.md:97`; `teacher/40-jobs.md` | **Impl (capability)**, **Prompt-only (use)** | `research`, `pdf`, `demo` and `visual` are async jobs (`src/agent/tools/jobs.ts`; `src/agent/tools.ts:296-336, 461`). Whether the model dispatches research when it should is up to the model. |
| P13: a persistent picture of what you understand | `README.md:18`; `docs/development.md:5` ("knowledge graph of what the learner knows") | **Contradicted** | The extractor sees "ONLY learner-facing teacher prose… no learner messages, thinking… or quiz blocks" (`src/agent/subagents/extraction.ts:127-129`). The graph has "no quiz outcomes, no understanding assessments" (`src/core/contracts/graph.ts:10, 207-209`). `README.md:39` itself says the graph stores "not ratings of your ability", which contradicts `README.md:18`. |
| P13: future sessions read the graph | `README.md:39`; `docs/development.md:7` | **Partial** | Only the **prober** and **practice** agents get `list_sessions`/`list_propositions` (`src/agent/tools.ts:339-341`; `src/agent/tools/practice.ts:247`). The **teacher**, which plans, does not (`src/agent/tools.ts:447-462`). The tools return names only, with no statements (`src/agent/tools/graph.ts:62-76`). `docs/probe-teach-split.md:116-122` still says sessions read no graph at all. |
| P14: practice with retrieval, interleaving and a hint ladder | `practice/10-doctrine.md` | **Partial** | Structural: one active problem at a time, a model solution committed at pose, conclude records outcome/rung/missClass/retest, targets validated against the graph (`src/agent/tools/practice.ts:72-219`). Material from graph picks is implemented (`app/api/chats/route.ts:43-69`; `src/core/native-messages.ts:258-288`). Interleaving, mode order, "close with retests" and the hint rungs are prompt-only. Conclude data is only rendered (`components/practice-cards.tsx:168-283`) and never used across sessions. |
| Practice draws from the graph via problem sets with partitioner, generator and grader | `docs/architecture.md:383-401`; `docs/development.md:177` | **Not impl (stale doc)** | Neither `src/core/practice.ts`, `src/store/practice.ts` nor a `/practice` route exists. Practice is now a conversational agent (`src/agent/teacher-agent.ts:325-337`). |
| Thinking fields are the primary data | `README.md:31`; `shared/16-mental-model.md:3` | **Impl (capture)** | `thinking` and `thinkingWhileReading` are kept as separate channels (`src/core/question-core.ts:794-800`). They are optional, and they are excluded from the graph (see P13). |
| The in-session learner model survives long sessions | `shared/16-mental-model.md:5` | **Partial** | The compaction summarizer is told to put "The learner's understanding" and how it evolved first (`src/core/compaction.ts:383-401`). It is LLM-written and lossy, but it is the only place an explicit learner model is ever written down. |

## 3. Gaps

1. **No end condition or mastery signal.** P2 defines success as the goal feeling obviously true. Nothing asks for, records or acts on that. There is no closing check of the goal, and the probe's strands are never re-assessed.
2. **No per-step verification.** P3, P4 and P8 are the core of the method ("where the session's quality lives", `teacher/20-teaching.md:12`). There is no code-level idea of a step. Nothing ties a check to a step. A failed check doesn't block moving to the next node.
3. **No persistent learner state.** Answers, confidence and thinking are kept in the chat transcript but go nowhere else. The planned state model was removed ("transitional five-class derivation… removed", `docs/vision.md:83`; the events ledger was deleted, `src/core/contracts/graph.ts:207-209`). Practice outcomes (`rung`, `missClass`, `retest`) are written and never read.
4. **The teacher can't see the graph.** The agent that writes the "minimal tree" (P7: "nothing the learner already holds is re-taught") has no graph tools. It depends on the prober's free-text assessment.
5. **No evaluation of pedagogical behaviour.** The tests cover the structure: phases, refusals, grading, reveal law, plan DAG, and prompt composition order (`tests/prompt-overrides.test.ts:278-317`). None runs a model or scores a transcript for step size, check cadence, repair, or probe precision. Doc "gates" were manual browser checks (`docs/plan.md:203, 213, 222`).
6. **Stale docs describe removed mechanisms:**
   - `docs/vision.md:50-54, 120` (event ledger, understanding levels, hotspots)
   - `docs/architecture.md:383-401` and `docs/development.md:177` (problem-set practice)
   - `docs/probe-teach-split.md:20, 116-122` (same-name quiz tool; no graph in sessions)
   - `docs/vision.md:5` (links to a `vision-extensibility.md` that does not exist in the repo)

## 4. Misconceptions

Each item below is a place where the docs' model of the system doesn't match what the mechanism can guarantee.

- **M1. Covered is treated as held.** The prober is told `list_propositions` shows "what he already holds… a strand held solid needs no re-probing" (`prober/10-probe-doctrine.md:9`). The tool itself says "what was covered there" (`src/agent/tools/graph.ts:66`), returns names only, and its header comment still mentions "levels" that no longer exist (`graph.ts:13`). The data comes from teacher prose only (`extraction.ts:127-129`). Imported notes go into the same graph (`docs/vision.md:56-79`). Consequences:
  - A session where the learner failed every check still adds its propositions.
  - Notes the learner never understood still count.
  - The prober is invited to skip probing exactly there.

  This conflicts with P1, which defines "held" as *accepted as obviously true by the learner*.
- **M2. Enforced is confused with instructed.** The theory frames step-by-step checking as a property of the system ("What this demands of the implementation", `docs/teaching-methodology.md:88-97`). The README describes it as what happens ("Confusions are repaired before anything is built on them", `README.md:28`). Both are model instructions only. The prompts are also user-overridable per segment (`src/agent/prompt-segments.ts:23-27`; `README.md:60`). An override can delete the whole method and the code won't notice (`tests/prompt-overrides.test.ts:278-282` shows "CUSTOM TEACHING LOOP" replacing "Teach — one step at a time").
- **M3. "One question per turn; his answer determines the next."** Turn-ending is enforced, but batched questions are accepted on purpose (`tests/chat-flow.test.ts:777-825`). The adaptive premise (each answer shapes the next question) holds only if the model chooses not to batch.
- **M4. Confidence is treated as always deliberate.** The slider rests at 50 and always sends a value. The code says "untouched and deliberate 50 are the same number" (`components/question-dock.tsx:336-340`; `src/core/question-core.ts:495-501`). The prompt reads 50 as "a genuine coin flip". It also says confidence "at or below chance… means he believes his pick is wrong" (`shared/25-confidence.md:5-6`). On a two-option question, an untouched slider (50 = chance) will be read as the learner distrusting their pick. Unanswered confidence and real confidence can't be told apart.
- **M5. The plan-map rule contradicts itself.** The theory and prompt say nodes ≠ steps and size is unbounded. The tool description says 5–15 nodes and one step per node (`src/agent/tools/plan.ts:71`). The model sees both in the same request.
- **M6. Tool names in the prompts are wrong.** The prober prompt names `quiz`/`explain` (`prober/10-probe-doctrine.md:3`), but the prober's tools are `probe`/`recall` (`src/agent/tools.ts:205-261`). The teacher prompt says "every step, with `quiz`" (`teacher/20-teaching.md:10`) even when free recall is armed and the tool is `explain`. `shared/25-confidence.md:3` says "every quiz answer carries confidence", but `explain` answers never carry it (`question-core.ts:738-744`).
- **M7. Plan confirmation.** The prompt says "Never teach in the presenting turn" (`teacher/10-planning.md:44`). The code acknowledges this is commonly violated and adjusts the divider placement instead (`src/core/phases.ts:99-111`).
- **M8 (learning science, secondary).**
  - *Self-evidence as the measure.* P2 uses the felt sense of obviousness as the measure of learning. Research on judgments of learning finds that subjective fluency is an unreliable guide to actual learning ([Bjork, Dunlosky & Kornell 2013, *Annu. Rev. Psychol.* 64:417–444](https://pubmed.ncbi.nlm.nih.gov/23020639/)). Without an independent check at the end of a session (gap 1), the terminal condition can't be told apart from a fluency illusion. The theory's own checks (P8) are the right remedy, but they're not tied to the goal.
  - *The 85% rule.* The practice doctrine cites "near 85% success per retrieval event" (`practice/10-doctrine.md:39`). The source result is about stochastic-gradient-descent learners on binary classification ([Wilson et al. 2019, *Nat. Commun.* 10:4646](https://pmc.ncbi.nlm.nih.gov/articles/PMC6831579/)). Applying it per retrieval event in human practice is an extrapolation.
  - *Uncited mechanism.* "The brain won't fully commit to a fact it isn't sure is safe to lock in" (`teacher/05-method.md:11`; `docs/teaching-methodology.md:18`) is presented as mechanism, with no cited support.
  - *Where the doctrine agrees with research.* Retrieval from an inactive state, interleaving, and committing a prediction before instruction match well-studied effects (desirable difficulties, testing and interleaving, per the same Bjork et al. review).

## 5. What is solidly implemented

- **Phase architecture.** Separate prober and teacher prompts and toolsets, an explicit `probe_done` seam with refusal rules and auto-handoff (`src/agent/tools/probe.ts`), and a strict phase fold (`src/core/phases.ts`), all tested.
- **Question integrity:**
  - ungradeable MC is rejected at the call boundary, and the model retries
  - grading is deterministic and done on the client
  - the explanation is written before `correctAnswer`
  - options carry no hint text (`question-core.ts:33-47`)
  - free-recall answers are committed before posing and revealed to the learner
  - "I don't know" is a distinct outcome
- **Pacing.** A posed question ends the turn (library behaviour verified). Checks collapse until the learner opens them, and predictions arrive open (`questionNeedsReveal`; `tests/reveal-arrival.test.ts`).
- **Plan map.** Schema-validated DAG authoring and rewriting, required and validated `nodeId`, and position derived from the transcript instead of declared.
- **Learner evidence capture.** Two separate thinking channels, confidence, and dictation all reach the model unchanged. Compaction keeps a learner-understanding section first.
- **Practice mechanics.** Single active problem, commit-before-pose, structured conclude record, target validation, the pause-until-go-ahead gate, and graph picks as session context.
- **Logistics.** Async research, PDF, demo (headlessly tested) and visual jobs with a wake pipeline.

## 6. Suggested next steps

Ordered by how much each one closes the gap between premise and implementation.

1. **Fix M1 first (a correctness issue, not a feature).** Either rename the claim, so the prober prompt and README say "covered", not "held". Or feed learner evidence (quiz verdicts, thinking) into whatever is offered as "what he holds". Also correct `docs/development.md:5` and `README.md:18`.
2. **Make the step/check contract observable, even if not enforced.** For example, a cheap deterministic metric per session: teacher turns without a question, prose length per check, and nodes advanced after a missed check. Or log `type` and correctness per node. That turns P3, P4 and P8 from belief into data.
3. **Add a goal check at session end.** For example, a teacher-side `goal_check` question tied to the probe's stated goal, so P2 has an independent measure besides the feeling of obviousness.
4. **Remove internal contradictions the model sees.** Change "5–15 nodes, one step per node" in `src/agent/tools/plan.ts:71`, fix the prompt tool names (M6), and decide whether batched questions are allowed (M3), then make the prompt and code agree.
5. **Make confidence opt-in, or mark it untouched.** For example, send `confidence` only after the slider is touched, so 50 means a real coin flip (M4).
6. **Give the teacher read access to the graph** (or include the prober's map reads in the handoff) if "nothing held is re-taught" is to use cross-session data.
7. **Add an LLM-in-the-loop eval harness** outside `npm test`: scripted learners (one with a planted misconception, one who misses a check) and transcript assertions for repair-before-advance, probe bracketing and check cadence.
8. **Update the stale docs** listed in gap 6, or mark them superseded.

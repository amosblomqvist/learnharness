# LearnHarness (fork)

A single-learner desktop app where AI agents probe what you understand, plan a path to a goal, teach it step by step, and track what you have shown you understand across sessions.

## Language

### Understanding

**Encountered**:
A proposition that is in the knowledge graph from any source, session or imported notes. Implies nothing about teaching or understanding.
_Avoid_: Known, seen, learned

**Covered**:
An encountered proposition the teacher taught in a session. Says nothing about whether the learner understood it.
_Avoid_: Held, known, learned (when only teaching happened)

**Held**:
A proposition whose most recent production evidence showed it present and not contradicted. Later production evidence that misses or contradicts it means it is no longer held. It can be held without ever being covered, for example when a probe shows prior knowledge.
_Avoid_: Accepted, obviously true, mastered

**Feels obvious**:
The learner's own report that a proposition seems self-evidently true. A signal, never proof that it is held.
_Avoid_: Understood, held

**Production answer**:
An answer the learner writes themselves (explaining, recalling, or applying an idea). Only production answers can make a proposition held.
_Avoid_: Free text, open answer

**Recognition answer**:
An answer chosen from given options. It is recorded as evidence, and a wrong one counts against held, but it can never make a proposition held.
_Avoid_: Quiz answer (when used to mean all answers)

**Prediction**:
An answer the learner commits to before the idea is taught. It shows what they believed beforehand, so it can never make a proposition held.
_Avoid_: Guess, pre-check

**Commitment**:
What the teacher states before asking a question: the full answer plus its key points. Production answers are judged against it.
_Avoid_: Answer key, rubric

**Key point**:
One proposition a correct answer must contain (or may contain, when optional), either a fact or a reason. Each key point is the unit that evidence attaches to a proposition through.
_Avoid_: Criterion, idea unit, rubric item

**Verdict**:
The grader's judgment of one production answer against its commitment: whether each key point is present, absent or contradicted, plus any false claims the key didn't anticipate. Pass or fail is derived from it, never stated by the grader.
_Avoid_: Score, grade, correctness level

**Pass**:
An answer in which every required key point is present and nothing is contradicted or false.
_Avoid_: Correct (as a grader output), partial credit

**Misconception**:
A proposition the learner's latest evidence contradicted, as opposed to one they merely missed.
_Avoid_: Wrong node, myth (the graph stores only the true correction)

**Uncertain verdict**:
A verdict the grader could not make cleanly. It is recorded but counts neither for nor against held until reviewed.
_Avoid_: Low-confidence grade

**Goal check**:
A check at the end of a session, tied to the session's goal, that the learner must pass by producing an answer.
_Avoid_: Final quiz, mastery check

### Records

**Knowledge graph**:
The objective map of propositions the learner has encountered and how they derive from or support each other. Holds no learner-specific state.
_Avoid_: Learner model, what the learner knows

**Evidence ledger**:
The record of the learner's answers, verdicts, confidence and thinking, each attached to a knowledge-graph proposition. Held status is inferred from it. Entries are never rewritten or removed when the graph changes.
_Avoid_: Event log, learner graph, understanding levels

**Orphaned evidence**:
Evidence whose proposition was deleted from the graph. It is kept but no longer counts toward any held status.
_Avoid_: Deleted evidence, stale evidence

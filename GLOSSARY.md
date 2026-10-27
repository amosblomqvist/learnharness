# LearnHarness (fork)

A single-learner desktop app where AI agents probe what you understand, plan a path to a goal, teach it step by step, and track what you have shown you understand across sessions.

## Language

### Understanding

**Covered**:
A proposition the teacher taught in a session. Says nothing about whether the learner understood it.
_Avoid_: Held, known, learned (when only teaching happened)

**Held**:
A proposition the learner has shown they understand by producing it in a check (re-deriving, applying, or explaining it), not by recognizing it.
_Avoid_: Accepted, obviously true, mastered

**Feels obvious**:
The learner's own report that a proposition seems self-evidently true. A signal, never proof that it is held.
_Avoid_: Understood, held

**Goal check**:
A check at the end of a session, tied to the session's goal, that the learner must pass by producing an answer.
_Avoid_: Final quiz, mastery check

### Records

**Knowledge graph**:
The objective map of propositions the learner has encountered and how they derive from or support each other. Holds no learner-specific state.
_Avoid_: Learner model, what the learner knows

**Evidence ledger**:
The record of the learner's answers, verdicts, confidence and thinking, each attached to a knowledge-graph proposition. Held status is inferred from it.
_Avoid_: Event log, learner graph, understanding levels

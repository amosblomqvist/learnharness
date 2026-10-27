# Production answers get structured verdicts from an independent grader

A free-recall answer is not graded on a correct/partial/wrong scale. Before posing an `explain` or `recall` question, the teacher commits 1–4 **key points** alongside the full answer. When the learner submits, a separate grader call, which sees only the answer and the commitment (not the conversation and not the learner's confidence), marks each key point `present` / `absent` / `contradicted` with a quoted span. It also lists any false claims the key didn't anticipate, and can flag the verdict as uncertain. Pass/fail and the display label are derived from this in code. The extractor maps each key point to a proposition, so evidence enters the ledger per key point, not per question. We chose this over a closed enum because recall research scores by idea units, LLM judges agree far better on yes/no checklists than on graded scales, a "partial" level means "fail" for every spaced-repetition scheduler we reviewed, and an enum hides which idea was missed (`docs/research/free-recall-verdicts.md`; many of its sources were read only as abstracts).

## Consequences

- `explain`/`recall` question schemas gain a required `keyPoints` list. Grading can only be as good as the key: a point the teacher left out cannot be checked.
- The learner waits for the grader before the teacher's next turn. It uses the cheaper extraction-tier model, and a failed or timed-out call records an **uncertain verdict** instead of blocking the session.
- The teacher sees the verdict and may disagree in prose, but cannot change it.
- "I don't know" is a learner-pressed button, never inferred by the grader.
- Evidence does not spread from a conclusion to its premises. A key point counts only for its own proposition.
- Ledger entries keep their verdict format forever, so changing this shape later means handling two formats.

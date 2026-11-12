## Confidence — reading the learner's self-assessment

Every quiz answer carries `confidence`: the learner's stated probability, as a percentage, that the answer he picked is correct. Read it against the verdict — it changes what the outcome means:

- 50 is a genuine coin flip. 90–100 claims certainty; 0–30 claims real doubt.
- For an n-option question, chance is 1/n. Confidence at or below chance on a picked answer means he believes his pick is wrong — a forced choice he distrusts, often trap suspicion. Treat it as honesty, not error.
- Correct + high confidence: solid knowledge — move on.
- Correct + low confidence: fragile knowledge or a lucky guess — worth one reinforcing touch, not celebration.
- Wrong + high confidence: the strongest signal you can receive — a committed misconception. Name the crack, probe it gently, and re-teach around it.
- Wrong + low confidence: a shaky near-miss or an honest gap — a small correction usually suffices.
- "I don't know" (`dontKnow: true`) carries no confidence: he declined to guess. A genuine gap, never a wrong answer.

## The calibration summary at the handoff

When the probe concludes, the server appends a deterministic `CALIBRATION — probe phase` block to the probe→plan handoff. It is computed from the durable answer records by code, never authored by a model: counts per confidence band, plus signals (high-confidence misses, fragile correct answers, explicit coin flips, at/below chance, default-50 answers).

Read it as evidence, never as a verdict or a score. At these sample sizes the counts ARE the measurement — do not turn them into percentages, rates, or labels of his ability.

- high-confidence misses → likely misconceptions; repair them before building on them.
- fragile correct answers → reinforce, or test transfer before assuming the knowledge holds.
- explicit coin flips → insufficient evidence; probe more or avoid strong assumptions.
- at/below chance → distrust or trap suspicion, not ordinary low confidence.
- correct + high confidence → can reduce time spent on that strand.
- widespread overconfidence → include calibration checks in the plan; never label the learner "overconfident."

A 50 is a committed coin flip only when he actually moved the slider (`confidenceTouched: true`). `default-50` answers and legacy `50 (unclassified)` answers are ambiguous: they are reported separately and are not evidence either way.

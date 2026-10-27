# Learner evidence lives in a ledger beside the knowledge graph

Upstream records only what was covered: the graph is extracted from teacher prose, and the prober is told to treat that as what the learner holds. We redefine **held** as *shown in a check where the learner produces the answer*, not as "feels obviously true", because the research found felt obviousness an unreliable measure of learning (`docs/research/learning-science-review.md` §3a). To make held measurable we add an **evidence ledger**, the learner's answers, verdicts, confidence and thinking attached to graph propositions. It sits beside the graph rather than putting understanding levels on graph nodes, so the graph stays an objective map of ideas (upstream's "inferred, never encoded" rule) and held status is always derived from evidence.

## Consequences

- The build order is fixed: the ledger first, then the end-of-session goal check (which writes to the ledger), then spaced retrieval (which reads from it).
- Prompts that equate covered with held (e.g. `src/agent/prompts/prober/10-probe-doctrine.md`) and the README's "picture of what you understand" claim must change to match.
- Verdicts on production answers, and how they attach to propositions, are set by ADR-0003.

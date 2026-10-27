# What a free-recall verdict should look like

*Compiled 2026-10-27. Question: when a separate LLM grader compares a learner's free-text answer with the teacher's pre-committed answer, what shape should its verdict take so that the evidence ledger can derive **held** from it (`GLOSSARY.md`; `docs/adr/0002-evidence-ledger-beside-the-graph.md`) and spaced retrieval can later read it? The naive proposal is a closed enum `correct / partial / wrong / don't know`.*

## How to read this document

**Evidence provenance.** The sandbox firewall returned HTTP 403 for nearly every paper host I tried (ACL Anthology, arXiv, NIST, DTIC, gwern, Anthropic docs, the Anki manual). So, like `learning-science-review.md`, most claims below rest on the bibliographic record and the abstract, or on search-engine descriptions of them, not on full text I read. The exceptions are the FSRS wiki pages on GitHub, which I read directly. Items whose content I reached only through a third-party summary are marked **[secondary]**. Check the primary text before quoting any number elsewhere.

**Code context.** Today the free-recall tools (`explain` / `recall`) take one prose field, `correctAnswer`: "the full correct answer in your own words, reasoning included", committed before the question is shown (`src/core/question-core.ts:295-313`; `src/agent/tools.ts:181-195`). The client does no grading for free text; it snapshots the commitment as `committed` (`src/core/question-core.ts:745-749`). Multiple-choice answers already carry a `dontKnow` flag that the learner sets (`src/core/question-core.ts:715`, `737`).

**Overall shape of the finding.** Four lines of evidence agree:
- Recall research scores an answer against a list of units, not with one holistic label.
- Short-answer grading research separates *incomplete* from *contradictory* and both from *non-attempts*.
- Rubric research and LLM-judge research both find that decomposed, criterion-by-criterion judgments are more reliable than one holistic grade, and that binary decisions are more reliable than graded ones.
- Spaced-repetition schedulers ultimately consume a binary recalled-or-forgot outcome.

So the verdict should be **a short per-point checklist with coarse (mostly binary) labels**. The answer-level class and the "counts toward held" bit should be **derived in code**, not chosen by the grader.

---

## 1. How memory research scores free recall: idea units

Free-recall experiments in the testing-effect literature score answers by dividing the source material into **idea units** and counting how many units the recall contains. Roediger & Karpicke (2006) split each of their two prose passages ("The Sun", "Sea Otters", 256 and 275 words) into 30 idea units for scoring (https://psychology.ecu.edu/wp-content/pv-uploads/sites/216/2019/03/Roediger-Karpicke-2006.pdf). Karpicke & Blunt (2011, https://pmc.ncbi.nlm.nih.gov/articles/PMC3577217), cited in `learning-science-review.md` §2, belongs to the same tradition. I could not reach the Method sections to quote the gist-versus-verbatim rule, so how leniently those papers scored paraphrase is **[unverified]**.

**Implication.** The unit of scoring in this tradition is a proposition, which matches the knowledge graph's own unit (`GLOSSARY.md`: the graph is "propositions"). A free-recall answer can then be scored the way the research scores it: which of the committed propositions did the learner produce? A single label throws away which proposition was missing, and the ledger needs exactly that to attach evidence to graph propositions (ADR 0002).

## 2. How short-answer grading research labels answers

**SemEval-2013 Task 7 (Joint Student Response Analysis).** This is the main shared benchmark for judging student answers against a reference answer (Dzikovska et al., 2013, *SEM 2013, pp. 263-274, https://aclanthology.org/S13-2045). Its 5-way label set is:
- *correct*
- *partially_correct_incomplete*: some, but not all, of the reference content
- *contradictory*: conflicts with the reference answer
- *irrelevant*: on-domain talk that does not supply the needed information
- *non_domain*: no domain content at all, such as "I don't know" or a help request

The coarser schemes fold labels together. The 3-way scheme keeps correct / contradictory / incorrect. The 2-way scheme is correct versus incorrect, with partial, irrelevant and non-domain all counted as incorrect (label definitions from search descriptions of the paper and its dataset pages: https://platform.k12-ai-infrastructure.org/datasets/11/semeval/version/11/about/, https://github.com/ashudeep/Student-Response-Analysis **[secondary]**).

Two points matter here.
- The field deliberately keeps **incomplete** separate from **contradictory**. The naive enum's single `partial` cannot say whether the missing part is absent or wrong.
- **"I don't know" is a non-domain non-attempt**, a different kind of thing from a wrong answer. The naive enum handles this one correctly.

**Facet-level assessment (Nielsen, Ward & Martin).** The reference answers behind SemEval's SciEntsBank data come from this group. They break each reference answer into fine-grained **facets** and judge each facet's relation to the student answer separately. Their reason: a yes/no entailment judgment at the facet level cannot say *how* the answer relates to the facet, for example whether it contradicted the facet or simply did not address it. So they split the labels into finer categories (Nielsen, Ward & Martin, "Classification Errors in a Domain-Independent Assessment System", https://www.cs.rochester.edu/~tetreaul/Nielsen.pdf; Nielsen, Ward & Martin, 2009, *Natural Language Engineering* 15, 479-501, https://www.cambridge.org/core/journals/natural-language-engineering/article/recognizing-entailment-in-intelligent-tutoring-systems/C4925CE6B644A53F5B3D460328126BD1).

Their annotated corpus has 15,357 answer pairs and 145,911 facet-level relations, each given one of five relationship categories. Inter-annotator agreement was 86.2% (κ = 0.728) (Nielsen, Ward, Martin & Palmer, 2008, LREC, pp. 3441-3448, https://aclanthology.org/L08-1166). I could not reach the definitions of the five categories (labels such as Expressed / Inferred / Contra-Expr / Unaddressed are commonly attributed to this work), so the exact taxonomy is **[unverified]**. The structure itself is confirmed: **per-facet labels, with contradiction kept separate from not-addressed**.

**Survey context.** Burrows, Gurevych & Stein (2015) catalogue more than 80 automatic short-answer grading (ASAG) papers and treat the field as scoring short natural-language answers to objective questions against reference material (*IJAIED* 25(1), 60-117, https://doi.org/10.1007/s40593-014-0026-8). I read only the abstract.

## 3. Rubrics: analytic versus holistic

- Jonsson & Svingby's review of 75 rubric studies is consistently reported as finding that scoring reliability improves when rubrics are **analytic** (criteria scored one at a time) and **topic-specific**, and when they come with exemplars or rater training (*Educ. Res. Rev.* 2(2), 130-144, 2007 **[secondary]**: conclusions reached only through citing summaries, e.g. https://www.koji.so/visuals/scoring-rubric-reliability-conditions).
- Brookhart (2018) reviewed higher-education rubric studies from 2005 to 2017. Most of the rubrics studied were analytic and descriptive, usually with 4-5 performance levels. She distinguishes rubrics, which describe quality at each level, from checklists and rating scales, which count elements (*Frontiers in Education* 3:22, https://doi.org/10.3389/feduc.2018.00022). Her caution is about *learning* value: element-counting tools may suit grading better than feedback. For a grader whose job is to record evidence rather than give feedback, a checklist is the right tool.

**Implication.** The teacher's commitment is already a topic-specific answer key. Turning it into a list of points to check is the analytic, topic-specific form the rubric literature associates with higher reliability.

## 4. LLM-as-judge: what is known about verdict formats

**Decomposition helps.**
- *CheckEval* replaces Likert-scale scoring with a checklist of decomposed **binary yes/no questions**. Across 12 evaluator models it raised agreement between evaluator models by 0.45, reduced score variance, and improved the average correlation with human judgments by about 0.10 (Lee et al., arXiv 2403.18771; EMNLP 2025, https://arxiv.org/abs/2403.18771).
- *FActScore* splits generated text into **atomic facts** and scores the fraction supported by a knowledge source. Its automated estimator stays within about 2% of the human-annotated score (Min et al., 2023, EMNLP, https://aclanthology.org/2023.emnlp-main.741). That is the same move as idea-unit scoring (§1), applied to an LLM judge.
- Wu et al. found a notable alignment gap between LLM and human graders on student science answers. LLMs "often resort to shortcuts, bypassing deeper logical reasoning", and high-quality analytic rubrics that encode the human grading logic narrowed the gap (arXiv 2407.18328, https://arxiv.org/abs/2407.18328; journal version reported as *Technology, Knowledge and Learning*, 2025).

**Coarse labels agree with humans better than fine ones.**
- Grading SciEntsBank answers with Qwen 2.5-72B, the judge's agreement with expert graders was strong for binary criteria and fell as rubric granularity increased. Filtering out low-confidence predictions raised accuracy on the items that remained (Deng et al., arXiv 2601.08843, https://arxiv.org/abs/2601.08843; single model, single dataset).
- In ResearchRubrics, collapsing three-level grading (met / partially met / not met) to two levels raised human-LLM agreement by about 20 points. The authors conclude that partial credit added ambiguity without improving discrimination (arXiv 2511.07685, https://arxiv.org/abs/2511.07685).

**Holistic scales are unstable.**
- LLM evaluators produce skewed score distributions, agree poorly with themselves across samples, are sensitive to prompt changes that are irrelevant to quality, and show anchoring across attributes judged together (Stureborg, Alikaniotis & Suhara, 2024, arXiv 2405.01724, https://arxiv.org/abs/2405.01724).
- LLM judges also show position, verbosity and self-enhancement biases (Zheng et al., 2023, NeurIPS Datasets & Benchmarks, https://proceedings.neurips.cc/paper_files/paper/2023/hash/91f18a1287b398d378ef22505bf41832-Abstract.html). The verbosity bias is relevant here because a long, rambling learner answer could be over-credited by a holistic judge.

**How good LLM graders are on short answers.** In the best configurations, GPT-4-class models reach roughly κ ≈ 0.70-0.75 against human graders on short-answer sets (e.g. Henkel et al., K-12, arXiv 2405.02985, https://arxiv.org/abs/2405.02985 **[figures from search summaries]**). Results vary widely by domain and are biased in both directions:
- A study of 2,288 medical-school answers found GPT-4 graded significantly *lower* than human graders, with few false positives (BMC Med. Educ. 2024, https://bmcmededuc.biomedcentral.com/articles/10.1186/s12909-024-06026-5).
- An audit of a mechanical-ventilation course found near-zero agreement for GPT-4o (arXiv 2505.04645, https://arxiv.org/abs/2505.04645).
- I found **no** direct evidence of systematic *leniency* on partially correct short answers. The repo's concern is sycophancy toward the learner, and the commitment-before-posing design already addresses it structurally (`src/core/question-core.ts:295-302`).

**Vendor guidance.** Anthropic's eval docs recommend asking the grader for a specific, empirical output ("only 'correct' or 'incorrect'", or a 1-5 scale), giving it a detailed rubric, and having it reason before it decides and then discarding that reasoning (https://docs.anthropic.com/en/docs/test-and-evaluate/develop-tests; excerpt via search, page not fetched).

**Implication.** The evidence favours (a) one judgment per committed point rather than one holistic judgment, (b) as few levels per judgment as possible, with no per-point "partial", and (c) a brief written justification before each label.

## 5. Dimensions beyond completeness

**Accuracy, meaning contradiction or misconception.** SemEval and Nielsen both keep *contradicted* apart from *not addressed* (§2). This matters for teaching:
- A misconception is a coherent wrong model that resists a single correction (Chi, 2008, cited in `learning-science-review.md` C14).
- Errors committed with high confidence are *more* likely to be corrected after feedback than low-confidence errors, the **hypercorrection effect** (Butterfield & Metcalfe, 2001, *JEP:LMC* 27(6), 1491-1494; replicated, see https://pmc.ncbi.nlm.nih.gov/articles/PMC4036076).

The ledger already records learner confidence (ADR 0002). Pairing it with an explicit *contradicted* signal is what lets the teacher spot high-confidence misconceptions. A bare `wrong` cannot tell "missing the second step" from "believes the opposite".

**Omission versus commission, and "I don't know".** When people are allowed to withhold answers, the answers they do give are substantially more accurate (Koriat & Goldsmith, 1996, *Psychol. Rev.* 103(3), 490-517, https://newiipdm.haifa.ac.il/wp-content/uploads/2015/05/Koriat-Goldsmith-1996-PsychRev.pdf). Withholding is a metacognitive act with its own meaning, so a learner's "I don't know" should be recorded as a non-attempt, not merged into "wrong". SemEval's *non_domain* class does this (§2). Where the learner can press an explicit button, as with multiple choice today (`dontKnow`), that fact should come from the client, not from the grader.

**Reasoned out versus repeated from memory.** This dimension is the hardest to grade from the text alone.
- The SOLO taxonomy classifies the *structure of the observed outcome*. A *multistructural* answer lists the right facts without relating them; a *relational* answer connects them into reasoning (Biggs & Collis, 1982, *Evaluating the Quality of Learning: The SOLO Taxonomy*; level descriptions via https://www.cuhk.edu.hk/policy/assessment/SOLO-description.pdf **[secondary]**). That is the most a grader can see in the product.
- It cannot see the *process*. A memorised derivation and a fresh one can produce the same text. I found no ASAG or LLM-judge work claiming to recover process from a short answer, so whether the learner *re-derived* the answer is not observable by this grader.

The observable proxy is: **did the answer contain the reasoning step(s) the commitment says a correct answer must contain?** Make those steps points in their own right. The learner's recorded thinking (ADR 0002) and future transfer checks are better evidence of process than the grader.

## 6. What spaced repetition needs from the ledger

- **FSRS** takes a grade G ∈ {1 again, 2 hard, 3 good, 4 easy}. Only *again* sends a card down the forgetting path; *hard*, *good* and *easy* all count as successful recall, and a lapse is a press of *again* (FSRS algorithm wiki, https://github.com/open-spaced-repetition/awesome-fsrs/wiki/The-Algorithm, read directly). Within the success path the grade adjusts difficulty and stability; for example FSRS-5's difficulty update is ΔD = −w₆·(G − 3) (same page). The optimiser's loss uses a binary recall indicator *r* ∈ {0, 1} (https://github.com/open-spaced-repetition/awesome-fsrs/wiki/The-mechanism-of-optimization, read directly).
- The Anki manual defines *Hard* as a correct answer recalled with doubt or difficulty, not a failure. Pressing *Hard* after forgetting is the one habit FSRS cannot adapt to, because it inflates intervals (manual wording quoted via https://scrapbox.io/motoso/Anki%E3%81%AE%E3%83%9C%E3%82%BF%E3%83%B3%E3%81%AF%E8%BF%B7%E3%81%A3%E3%81%9F%E3%82%89Good%2FAgain **[secondary]**; https://forums.ankiweb.net/t/add-visual-cues-to-make-it-clear-that-hard-is-not-a-failing-grade/40879 [forum]).
- **SM-2** uses quality 0-5. Any quality below 3 restarts the repetition schedule, and 3 means "correct with serious difficulty" (https://www-v1.supermemo.com/archives1990-2015/english/ol/sm2).
- MaiMemo's model, the research base FSRS grew out of, is built on one binary observation per review (Ye, Su & Cao, 2022, KDD, pp. 4381-4390, https://doi.org/10.1145/3534678.3539081; the binary framing via https://notes.andymatuschak.org/zGrLCQ873eCpFvTsZoMRCbE **[secondary]**).

**Implication.**
- The binary pass/fail bit is required and enough for scheduling.
- An answer that is partially right **must map to fail (again)**, never to *hard*. Mapping it to *hard* is the documented failure mode.
- The ledger does not need to store an FSRS rating. Spaced retrieval can derive one: fail → 1. Pass → 3 by default, with 2 or 4 only if a later feature has a real "difficulty of recall" signal such as latency or learner confidence, which the grader does not have.
- The ledger also needs a timestamp per review, which ADR 0002's ledger already implies.

---

## 7. Recommendation

### 7.1 Change the commitment: from prose to prose plus key points

The grader can only score points that exist. Have the teacher commit, before posing (so the anti-sycophancy guarantee stays intact), a short list of **key points**, each a single proposition:

```ts
correctAnswer: string            // unchanged: full answer, shown to learner on submit
keyPoints: Array<{
  id: string                     // "p1", "p2", …
  text: string                   // one proposition a correct answer must contain
  kind: "fact" | "reason"        // "reason" = a why/derivation step (SOLO relational)
  required: boolean              // false = credit-worthy but not needed to pass
  propositionId?: string         // the graph proposition this point evidences, when known
}>                               // typically 1-4; ≥1 required
```

If the commitment stays prose-only, the grader would have to break it into points itself. Without a fixed key, it could split the same commitment differently on different calls, so the decomposition itself would become a source of inconsistency (Stureborg et al., 2024). This means changing the `explain`/`recall` schemas. That is out of scope for this note and is flagged for a separate decision.

### 7.2 The verdict the grader returns

```ts
type FreeRecallVerdict = {
  attempt: "answered" | "off_target"             // "dont_know" comes from the client, not the grader
  points: Array<{
    id: string                                   // matches keyPoints[].id
    status: "present" | "absent" | "contradicted"
    evidence: string                             // quoted span of the answer, or "" if absent
  }>
  extraErrors: Array<{ claim: string }>          // false statements not tied to any key point
  uncertain: boolean                             // grader flags a judgment it could not make cleanly
  rationale: string                              // written BEFORE the labels; kept for audit
}
```

- **No per-point "partial".** Half-expressed means `absent`. Binary-ish labels are where LLM-human agreement holds up (Deng et al.; ResearchRubrics), and both FSRS and SM-2 collapse partial recall to failure anyway.
- **`contradicted` is kept separate from `absent`**, following SemEval and Nielsen, so the ledger can tell a misconception from a gap. Combined with the learner's recorded confidence, that identifies hypercorrection opportunities.
- **`extraErrors`** catches a wrong claim the key did not foresee, for example a correct answer followed by an invented false mechanism.
- **`attempt: "off_target"`** is SemEval's *irrelevant*: the learner wrote something on-domain that does not answer the question. A learner's "I don't know" should be a client-side button, as `dontKnow` is for multiple choice, and should not pass through the grader.
- **`uncertain`** lets low-confidence verdicts be withheld from the held derivation or reviewed (Deng et al. found filtering low-confidence predictions improved accuracy).
- The grader still sees **only** the answer and the commitment. It should not see the learner's confidence (anchoring; Stureborg et al.) or the teacher's conversation (sycophancy).

### 7.3 What code derives (not the grader)

```
counts toward held (pass) =
     attempt == "answered"
  && dontKnow == false
  && uncertain == false
  && every required point has status "present"
  && no point has status "contradicted"
  && extraErrors is empty
```

Held for a proposition stays as ADR 0002 defines it: the most recent *production* answer on it passed. With `propositionId` on key points, one answer can also give evidence per proposition (point present → evidence for that proposition) instead of one bit for the whole question. Whether a single point's presence is enough to count a proposition as held is a policy choice the ledger design should make explicitly. The conservative default is whole-answer pass.

Display class, derived for the UI and the teacher (replacing the enum):

| derived class | rule |
|---|---|
| `dont_know` | client `dontKnow` |
| `off_target` | `attempt == "off_target"` |
| `misconception` | any `contradicted` point or any `extraErrors` |
| `correct` | pass |
| `incomplete` | otherwise (some required point `absent`) |

Spaced-retrieval rating: fail → FSRS 1 (*again*); pass → 3 (*good*). Never map `incomplete` to 2 (*hard*) (§6).

### 7.4 Trade-offs against the plain enum

**What the structured verdict gains:**
- per-proposition evidence for the ledger (ADR 0002)
- a misconception/gap distinction the enum's `partial` / `wrong` blurs
- judgments in the decomposed, coarse form that rubric research and LLM-judge research find more reliable
- an auditable `evidence` quote per point
- a pass bit that is a deterministic, testable function in code. This fits the repo's "deterministic, no LLM" test suite (`docs/research/teaching-premise-vs-implementation.md`, Summary).

**What it costs:**
- A schema change to the commitment (`keyPoints`), and more teacher effort per question.
- The quality of the key now limits grading quality: a point missing from the key cannot be checked, and `extraErrors` only partly covers that.
- A longer grader output: more tokens and latency, and more fields that can be malformed. This needs strict schema validation, with "every key point gets exactly one status" checked in code.
- Strictness. A real but unforeseen correct phrasing may be marked `absent` if the grader matches too literally. Gist-level matching must be stated in the grader prompt.

**What the enum would have offered:** one call, one field, trivial storage. But `partial` would have needed a policy anyway, and every scheduling convention reviewed here (FSRS's Again-only lapse rule, SM-2's below-3 reset) says partial counts as fail. So the enum's extra level carries no scheduling information, and it hides *which* point was missed.

**Not recommended:**
- Numeric holistic scores (0-5, 0-100): least stable LLM output format (Stureborg et al., 2024).
- A grader-judged "reasoned vs memorised" field: not observable from the text (§5). Use `kind: "reason"` key points instead.
- Storing FSRS ratings in the ledger: derive them at read time.

---

## References

- Biggs, J. B., & Collis, K. F. (1982). *Evaluating the Quality of Learning: The SOLO Taxonomy.* Academic Press. [level descriptions via https://www.cuhk.edu.hk/policy/assessment/SOLO-description.pdf, secondary]
- Brookhart, S. M. (2018). Appropriate criteria: Key to effective rubrics. *Frontiers in Education, 3*, 22. https://doi.org/10.3389/feduc.2018.00022
- Burrows, S., Gurevych, I., & Stein, B. (2015). The eras and trends of automatic short answer grading. *IJAIED, 25*(1), 60-117. https://doi.org/10.1007/s40593-014-0026-8
- Butterfield, B., & Metcalfe, J. (2001). Errors committed with high confidence are hypercorrected. *JEP: LMC, 27*(6), 1491-1494. [via citing paper https://pmc.ncbi.nlm.nih.gov/articles/PMC4036076]
- Deng et al. (2026). Rubric-conditioned LLM grading: Alignment, uncertainty, and robustness. arXiv 2601.08843. https://arxiv.org/abs/2601.08843 [preprint]
- Dzikovska, M. O., Nielsen, R. D., Brew, C., Leacock, C., Giampiccolo, D., Bentivogli, L., Clark, P., Dagan, I., & Dang, H. T. (2013). SemEval-2013 Task 7: The Joint Student Response Analysis and 8th Recognizing Textual Entailment Challenge. *SEM 2013, 263-274. https://aclanthology.org/S13-2045 [label definitions via search descriptions]
- Henkel, O., et al. (2024). Can large language models make the grade? arXiv 2405.02985. https://arxiv.org/abs/2405.02985 [figures secondary]
- Jonsson, A., & Svingby, G. (2007). The use of scoring rubrics: Reliability, validity and educational consequences. *Educational Research Review, 2*(2), 130-144. [conclusions secondary]
- Karpicke, J. D., & Blunt, J. R. (2011). Retrieval practice produces more learning than elaborative studying with concept mapping. *Science, 331*, 772-775. https://pmc.ncbi.nlm.nih.gov/articles/PMC3577217
- Koriat, A., & Goldsmith, M. (1996). Monitoring and control processes in the strategic regulation of memory accuracy. *Psychological Review, 103*(3), 490-517. https://newiipdm.haifa.ac.il/wp-content/uploads/2015/05/Koriat-Goldsmith-1996-PsychRev.pdf
- Lee, Y., et al. (2025). CheckEval: A reliable LLM-as-a-judge framework for evaluating text generation using checklists. EMNLP 2025; arXiv 2403.18771. https://arxiv.org/abs/2403.18771
- Min, S., et al. (2023). FActScore: Fine-grained atomic evaluation of factual precision in long form text generation. EMNLP 2023. https://aclanthology.org/2023.emnlp-main.741
- Nielsen, R. D., Ward, W., & Martin, J. H. (2009). Recognizing entailment in intelligent tutoring systems. *Natural Language Engineering, 15*, 479-501. https://www.cambridge.org/core/journals/natural-language-engineering/article/recognizing-entailment-in-intelligent-tutoring-systems/C4925CE6B644A53F5B3D460328126BD1
- Nielsen, R. D., Ward, W., & Martin, J. H. Classification errors in a domain-independent assessment system. https://www.cs.rochester.edu/~tetreaul/Nielsen.pdf [abstract/intro via search]
- Nielsen, R. D., Ward, W., Martin, J. H., & Palmer, M. (2008). Annotating students' understanding of science concepts. LREC 2008, 3441-3448. https://aclanthology.org/L08-1166
- Open Spaced Repetition. The Algorithm (FSRS-6 and earlier). https://github.com/open-spaced-repetition/awesome-fsrs/wiki/The-Algorithm (read directly)
- Open Spaced Repetition. The mechanism of optimization. https://github.com/open-spaced-repetition/awesome-fsrs/wiki/The-mechanism-of-optimization (read directly)
- Roediger, H. L., & Karpicke, J. D. (2006). Test-enhanced learning. *Psychological Science, 17*(3), 249-255. https://psychology.ecu.edu/wp-content/pv-uploads/sites/216/2019/03/Roediger-Karpicke-2006.pdf
- ResearchRubrics authors (2025). ResearchRubrics: A benchmark of prompts and rubrics for evaluating deep research agents. arXiv 2511.07685. https://arxiv.org/abs/2511.07685 [authors not checked; preprint]
- Stureborg, R., Alikaniotis, D., & Suhara, Y. (2024). Large language models are inconsistent and biased evaluators. arXiv 2405.01724. https://arxiv.org/abs/2405.01724
- Wozniak, P. SM-2 algorithm description. SuperMemo archives. https://www-v1.supermemo.com/archives1990-2015/english/ol/sm2
- Wu, X., et al. (2024/2025). Unveiling scoring processes: Dissecting the differences between LLMs and human graders in automatic scoring. arXiv 2407.18328. https://arxiv.org/abs/2407.18328
- Ye, J., Su, J., & Cao, Y. (2022). A stochastic shortest path algorithm for optimizing spaced repetition scheduling. KDD 2022, 4381-4390. https://doi.org/10.1145/3534678.3539081
- Zheng, L., et al. (2023). Judging LLM-as-a-judge with MT-Bench and Chatbot Arena. NeurIPS 2023 Datasets & Benchmarks. https://proceedings.neurips.cc/paper_files/paper/2023/hash/91f18a1287b398d378ef22505bf41832-Abstract.html
- Anthropic. Develop tests (LLM-based grading guidance). https://docs.anthropic.com/en/docs/test-and-evaluate/develop-tests [excerpt via search]
- Unverified/secondary, Anki button semantics: https://scrapbox.io/motoso/Anki%E3%81%AE%E3%83%9C%E3%82%BF%E3%83%B3%E3%81%AF%E8%BF%B7%E3%81%A3%E3%81%9F%E3%82%89Good%2FAgain; https://forums.ankiweb.net/t/add-visual-cues-to-make-it-clear-that-hard-is-not-a-failing-grade/40879
- Other LLM short-answer grading studies: BMC Med. Educ. 2024, https://bmcmededuc.biomedcentral.com/articles/10.1186/s12909-024-06026-5; arXiv 2505.04645, https://arxiv.org/abs/2505.04645

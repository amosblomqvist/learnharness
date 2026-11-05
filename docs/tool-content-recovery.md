# Tool-content display recovery

This is a developer reference for display-only recovery of model-authored escaping defects, not a general TeX repair system.

## Boundary

Tool arguments are shape-decoded, schema-converted, validated, and cleaned **before** presentation. `ToolContentResponse` then applies `repairMathForDisplay` and ordinary Markdown rendering. Teaching/probing questions, asks, recalls/explanations, and practice statements/solutions share this path; ordinary assistant prose does not.

Recovery must not change persisted arguments, option identities, shuffling, grading, learner answers, or future answer snapshots. Those use source-derived, schema-parsed content.

## Supported recovery

| Content | Behavior |
| --- | --- |
| Literal code | Copy CommonMark/math-parser source ranges verbatim, including fences, indentation, quotes, and lists, except the escaped fenced code below. Do not serialize a replacement AST. |
| Escaped fenced code | A fenced block written on one line with escaped newlines becomes a real fence: delimiters and body on their own lines, language tag kept. One backslash before each newline is one JSON layer; two is a second layer. Both ends must use the same count, and a longer run stays literal. Recovery is stable on a second pass. |
| Document escapes | Decode literal `\n` only with evidence such as repeated layout escapes, an escaped fence, or accompanying extra-escaped TeX. Protect other code, recognized paths (drive and UNC), comments, and complete known n-prefixed commands/macros such as `\nu` and `\nabla`. A second-layer fence also decodes `\\n` in the surrounding prose, but math keeps its single-layer rules. |
| Display framing | Recovered `$$` framing puts the formula and closing fence on their own lines. |
| JSON-swallowed prefixes | In math, reconstruct control-character + complete alphabetic word only when it names a known KaTeX command, such as TAB + `ext` → `\text`. |
| Extra command escaping | Recover known commands using original TeX context; unknown words are not invented. Preserve genuine native row separators/comments; consistently over-escaped environments establish a factor for commands **and rows**. |
| Percentages | Recover supported doubled percent escapes in numeric expressions, including at the end of display math; preserve genuine comments/rows. No blanket percent repair. |

Inline prefix recovery includes physical LF + `u` → `\nu` and TAB + `o` → `\to`, with no word-length cutoff. Display math keeps physical LF/CRLF as formatting but can recover recognized non-newline prefixes. Correctly written commands remain commands; unrelated whitespace stays unchanged.

This policy deliberately targets typical model-authored math: whitespace followed by a variable can ambiguously spell a command. TeX parse success cannot resolve that ambiguity. A guard rejects partial command changes that introduce a parse failure, but parse success alone does not prove semantic preservation. Unbalanced/unsupported content is not generally rewritten into new mathematics; there are no language-specific decoders.

In labelled answer/Why reveals, only the first direct paragraph is inline with its label; later paragraphs keep normal layout.

## Historical answers

`answerForPresentation` joins display fields to original calls without rewriting answer facts. Labels bind through unambiguous selected values, exact/source-recovered labels, or the uniquely remaining pair in a complete bijection. Ambiguous rows keep saved snapshots. Order, indices, values, verdicts, confidence, learner text, and dismissals remain intact. No migration is performed.

## Verification

- `tests/content-recovery.test.ts`: recovery/preservation, code, rows, comments, and escaped fences (one and two layers, UNC paths, long backslash runs).
- `tests/tool-content-presentation.test.tsx`: synthetic corpus, historical joins, ambiguity.
- `tests/tool-content-interaction.test.tsx`: selection/submission/persistence/reveal and paragraphs.
- `tests/fixtures/tool-rendering/escaped-fence-two-layer.txt`: a recorded two-layer escaped question used by both recovery suites. Do not edit it.

`scripts/replay-tool-rendering-corpus.ts` can replay a separately supplied frozen corpus offline, checking hashes and source/render/answer preservation. Corpus collection and larger diagnostic runs are not prerequisites for unit tests. The Markdown, card, practice, shape, and grading suites remain relevant.

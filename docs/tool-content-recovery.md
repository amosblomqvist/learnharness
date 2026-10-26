# Tool-content presentation recovery

## Contract

Model-authored tool content is parsed against its schema before presentation. Math or document recovery must not change persisted tool arguments, option identities, learner answers, shuffling, grading, or future answer snapshots. Those use the source-derived, schema-parsed content.

`ToolContentResponse` projects text through `repairMathForDisplay`, then uses the ordinary Markdown renderer. Teaching/probing questions, asks, recalls/explanations, and practice statements/solutions share this path. Ordinary assistant prose does not receive tool-content recovery.

There are three separate responsibilities:

1. **Argument/shape parsing:** decode encoded argument shapes, then schema conversion, validation and cleaning. No LaTeX recovery here.
2. **Content projection:** distinguish literal code, prose/document structure and math; recover only supported escaping defects.
3. **Presentation:** Markdown/KaTeX rendering, including paragraph layout. In labeled Why/answer reveals, only the first direct paragraph is inline with its label; subsequent paragraphs retain their normal layout.

## Recovery rules

### Literal code

Code and inline-code source ranges come from the rendering stack's CommonMark parser with its math extensions. This covers fences, indentation, quotes and lists without maintaining separate container heuristics. The projection copies those source ranges verbatim; it does not serialize an AST back into Markdown.

### Document escapes

A literal two-character `\n` is different from a physical newline. Document-layout recovery requires evidence such as repeated document-escape candidates or a candidate alongside over-escaped known TeX commands. Complete known n-prefixed TeX words, including `\nu`, `\nabla`, `\neq` and declared n-prefixed macros, take precedence over interpreting their prefix as document layout. Code, genuine TeX comments and recognized path tokens are protected.

Recovered double-dollar display framing puts the formula and closing fence on their own lines. Decoding the opening line alone can otherwise turn closing dollars into erroneous TeX content.

### JSON-swallowed command prefixes

Inside math, a control character can be the result of JSON consuming the start of a command: TAB + `ext` instead of `\text`, for example. Recovery reconstructs a command only if the control character plus the **complete following alphabetic word** names a known KaTeX command. All supported occurrences recover in one projection.

The owner-approved typical-model-authoring policy is:

- **Inline math:** recover recognized prefixes, including physical LF + `u` to `\nu`, and TAB + `o` to `\to`. There is no word-length cutoff.
- **Display math:** keep physical LF and CRLF as source formatting; recover recognized non-newline prefixes.
- **Correctly written commands:** remain commands in both modes. `\nu` is never decoded into LF + `u`.
- **Unrecognized whitespace:** remains unchanged. `x<TAB>+<TAB>y` does not become invented `\t`/`\ty` commands.

The control-character case is inherently ambiguous: whitespace followed by a variable may happen to spell a command. This policy targets typical model-authored LaTeX, not every syntactically possible human whitespace arrangement. TeX parse success alone cannot distinguish the two meanings.

### Extra command escaping, percentages and rows

Recovery examines the original TeX context before changing backslash runs:

- Complete native environment pairs and native `\substack` arguments preserve genuine row separators.
- Consistently extra-escaped environment pairs establish an escaping factor for commands **and rows**. For example, an encoded four-backslash row becomes two backslashes, not one.
- Outside protected native row/comment contexts, extra prefixes on known commands can recover. Unknown command words are not invented.
- Doubled percent escapes in ordinary numeric expressions can recover to `\%`, including numeric percentages at the end of a display formula. Genuine following comment text or equation rows remain literal. This is not a blanket `%` addition to an even-backslash rule.
- As an additional guard, partial command recovery does not turn parseable source into a TeX parse failure. Parse success is not the primary correctness test: both a corrupted matrix and a lost percentage can parse successfully.

Unbalanced, unsupported or ambiguous content is not generally corrected into new mathematics. This is an escaping recovery projection, not a general TeX authoring repair system. There are no language-specific decoders.

## Historical answers

`answerForPresentation` joins model-authored display fields to the original tool call without changing recorded answer facts. Option labels bind only through unambiguous selected values, exact/source-recovered labels, or one uniquely remaining pair in a complete bijection. Ambiguous rows keep their saved snapshots. Saved order, indices, selected values, verdicts, confidence and learner text are retained. Dismissed answers are unchanged. No migration or record rewrite is performed.

## Verification

- `tests/content-recovery.test.ts`: recovery/preservation rules and adversarial row/comment/code examples.
- `tests/tool-content-presentation.test.tsx`: provenance-labeled synthetic corpus regressions, historical joins and ambiguity.
- `tests/tool-content-interaction.test.tsx`: select/submit/persist/reveal flow and paragraph structure.
- Existing Markdown, card, practice, tool-shape and grading suites remain applicable.

The local frozen corpus can be replayed offline with `scripts/replay-tool-rendering-corpus.ts`. Replay verifies source hashes and preserves baseline findings; it reports glyph loss, matrix rows, rendering errors, code bytes, schema regressions, answer facts and projection convergence. Corpus collection and larger diagnostic batches are separate from product recovery and are not prerequisites for running these unit tests.

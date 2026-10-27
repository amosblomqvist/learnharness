# Compaction and usage accounting

## Retention

`src/core/compaction.ts` locally ports the cutoff-selection behavior and relevant
message-size heuristic from **@earendil-works/pi-coding-agent 1.4.0**. There is no
coding-agent dependency. Upgrade this port deliberately; the native golden
fixtures are in `tests/compaction-native-parity.test.ts`.

Walk backward to the approximately 20,000-token retained-tail budget, then select
the nearest valid user/assistant boundary at or after the crossing. Never start
at a tool result. If trailing results alone exceed the budget, keep the preceding
assistant call. Preserve adjacent context-invisible metadata. LearnHarness adapts
its visible custom markers to user-like entries, excludes UI-only markers, and
uses the active compaction's retained history rather than discarded messages.

Text, visible thinking, tool-call names/arguments use characters divided by four;
images receive the native fixed 1,200-token allowance. Encrypted signatures are
not measured or stripped. Whole-message boundaries can overshoot. This does
**not** guarantee a measured 20k tail or a fixed post-compaction request size.

Only cutoff selection is ported. LearnHarness retains its educational summary
prompt, plan continuity, persistence, threshold, scheduling, and authorization
lifecycle. It does not adopt Pi's coding summary or separate split-turn summary
calls. A cut that drops no active history does not launch a summarizer.

When the active cutoff is applied, conversation requests carry the latest summary
once, followed by the retained transcript without older compaction markers. When
a subsequent compaction supplies that prior summary separately, it includes it
once, plus the newly superseded transcript without summary markers. All markers
and original messages remain stored. The existing full-history fallback for an
unresolved cutoff is unchanged, including its summary text.

A provider response stopped at its output limit (`length`) is an incomplete
summary, not a successful checkpoint. Compaction fails without changing the
existing history or prior summary; a later attempt can retry normally.

## Conversation meter

The numerator is the latest qualifying completed conversation response's native
Pi `input + output + cacheRead + cacheWrite`. Reasoning is already inside output;
`totalTokens` is not an override. Partial stream updates, errors, aborts, invalid
counts, and all-zero usage do not replace the last measurement. A successful
compaction marker invalidates earlier measurements: show `? / maximum` until a
new qualifying response completes. Summarizer usage never supplies this meter.

The denominator follows the selected model's catalog limit, independently of the
last numeric measurement. Changing models preserves that numerator. No catalog
limit means no invented denominator; no percentage display is added.

## Spending

`src/server/pricing.ts` uses Pi AI's full, key-independent catalog and public
`calculateCost` on a new usage object. The browser receives derived costs, not a
second calculator/rate table. Totals are estimates using the currently shipped
catalog, not provider invoices; catalog updates can reprice history.

Saved input is Pi-normalized **fresh input**, disjoint from cache buckets. Never
subtract cached reads from it again or migrate old logs as raw inclusive prompt
tokens. New captures preserve the one-hour subset of cache writes and individual
background-job calls. Older write-bearing records with a lost retention split,
and tier-priced multi-call jobs with only aggregate usage, remain unpriced when
the lost detail can change the answer. They are not reconstructed from totals.
Flat-rate historical jobs with sufficient counts remain priceable. Missing models
or required usage stay unpriced; ChatGPT subscriptions remain plan usage, not
API dollars. Summarizer costs continue to count toward session spending.

## Upstream attribution

The cutoff/estimator port adapts MIT-licensed code from
`@earendil-works/pi-coding-agent` 1.4.0, author Mario Zechner (published package
metadata). The inspected `dist/core/compaction/compaction.js` SHA-256 is
`f51e78ef1da66b5803fc91e185f07b968f8f989ab9326b7744958416aad3f6f6`.

MIT License

Copyright (c) Mario Zechner

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.

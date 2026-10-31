# Compaction and usage accounting

## Retention

[`src/core/compaction.ts`](../src/core/compaction.ts) locally ports the
cutoff-selection behavior and relevant message-size heuristic from
**@earendil-works/pi-coding-agent 1.4.0**. There is no coding-agent dependency.
Upgrade this port deliberately; the native golden fixtures are in
[`tests/compaction-native-parity.test.ts`](../tests/compaction-native-parity.test.ts).

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
compaction marker invalidates earlier measurements: show an unknown numerator
(`? / maximum` when a maximum is known) until a new qualifying response completes.
Summarizer usage never supplies this meter.

The denominator follows the selected model's catalog limit, independently of the
last numeric measurement. Custom models use their configured/reported/fallback
budget. **Claude Code is the exception:** its aliases have no public catalog
maximum. Only the latest response's valid CLI-reported effective budget for the
session's matching selected model supplies a denominator; it may reflect CLI
auto-compaction rather than the nominal model window. A fresh response without
metadata, or a compaction marker, invalidates the old CLI report. Changing models
preserves the numerator but never borrows another model's CLI denominator. Missing
limits mean usage-only display, not an invented maximum; no percentage is added.

This displayed measurement is distinct from the **next-request compaction
estimate**. [`src/server/compaction.ts`](../src/server/compaction.ts) anchors that
estimate on reported usage and estimates subsequent messages, falling back to the
active transcript heuristic plus system prompt when no anchor exists. Its trigger
is the smaller of the configured threshold and catalog window minus reserve; an
unknown catalog window uses the configured threshold alone. The CLI's display
metadata does not become a catalog limit or change that trigger. See the
[meter implementation](../src/core/context-usage.ts),
[CLI metadata reader](../src/core/native-messages.ts), and
[display limit selection](../components/stats-bar.tsx).

## Prompt-cache retention

Under **Settings → Agent → Models → Show advanced settings**, each Strong,
Cheap and Vision slot has a **Cache** dropdown. Initial setup stays unchanged.
Advanced controls start collapsed; hiding them does not reset saved choices.

| Choice | Request behavior |
| --- | --- |
| Pi default | Leave Pi's `cacheRetention` option unset. This preserves existing behavior, including `PI_CACHE_RETENTION=long` where Pi honors it. No setting is added until you choose one. |
| Don’t request caching | Pass Pi's native `none` preference. This is not a universal caching-off switch: providers may still cache automatically. |
| Short retention | Pass Pi's native `short` preference. |
| Long retention | Pass Pi's native `long` preference. Cache-write costs may be higher. |

These are **provider-dependent preferences, not fixed durations or cache-hit
promises**. Pi owns the mapping. For example, supported Anthropic routes map
Short/Long to five minutes/one hour; OpenAI mappings differ by model. Some
adapters ignore the preference, subscription transports may omit it, and custom
compatible endpoints may reject an unsupported parameter. LearnHarness does not
rewrite these mappings or retry with a different preference.

Chats keep their own selected models but inherit Strong's retention preference.
Background agents inherit their assigned slot's preference even with a role
model override; summarization uses the conversation preference. A saved change
applies to the next model request, including calls in an existing agent loop,
without changing an in-flight request or issuing any warm-up calls. Explicit
choices take precedence over Pi's retention environment override; selecting
Pi default removes the explicit choice again.

On Anthropic, five-minute cache writes cost 1.25× ordinary input and one-hour
writes cost 2×; reads use the model's discounted cache-read price. Longer
retention may help across learner pauses, but can cost more for a single call
or a short-lived background job. Other providers have different pricing.
See the official [Anthropic caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
and [OpenAI caching](https://developers.openai.com/api/docs/guides/prompt-caching)
guides. Actual reported cache reads/writes remain distinct from the requested
preference and do not establish whether a future request will hit a cache.

## Spending

[`src/server/pricing.ts`](../src/server/pricing.ts) uses Pi AI's full,
key-independent API catalog and public `calculateCost` on a new usage object.
The browser receives derived costs, not a second calculator/rate table. Totals
are estimates using the currently shipped catalog, not provider invoices;
catalog updates can reprice history. Saved native messages are not mutated.

| Route | Accounting meaning |
| --- | --- |
| Native API providers | Estimate dollars when the catalog model and required usage detail are available. |
| Built-in subscription connections | Explicit logical provider IDs identify plan usage, not API dollars. This includes ChatGPT and the native subscription providers, not models merely named after them. |
| [Claude Code](claude-code.md) | Retain CLI-reported tokens, but leave dollar costs unpriced. The UI labels CLI billing; the CLI owns routing/authentication and there is no subscription-only guarantee. Successful CLI result-line dollar totals are not imported. |
| [Custom/local endpoint](custom-providers.md) | Retain token usage, but leave prices unknown/unpriced, even for a locally hosted model. Internal zero-rate placeholders do not mean free inference; there is no rates editor. |

Mixed sessions sum only known API-dollar estimates and retain subscription/CLI
labels alongside them. A CLI or custom turn remains unpriced in the accounting
fold; it is not reclassified as subscription use or silently valued at $0. A
CLI-reported cost outside LearnHarness would not establish API charges, plan
entitlements, or the final bill.

Saved input is Pi-normalized **fresh input**, disjoint from cache buckets. Never
subtract cached reads from it again or migrate old logs as raw inclusive prompt
tokens. New captures preserve the one-hour subset of cache writes and individual
background-job calls. Older write-bearing records with a lost retention split,
and tier-priced multi-call jobs with only aggregate usage, remain unpriced when
the lost detail can change the answer. They are not reconstructed from totals.
Flat-rate historical jobs with sufficient counts remain priceable. Missing models
or required usage stay unpriced. Summarizer usage continues to count toward session
spending under the same provider-specific pricing rules, but never supplies the
conversation meter.

Regression references: [meter completion/invalidation](../tests/context-usage.test.ts),
[Pi pricing parity and historical precision](../tests/pricing-native-parity.test.ts),
[subscription identities and mixed totals](../tests/subscription-usage.test.tsx),
[CLI usage/UI](../tests/claude-code-usage.test.tsx), and
[custom runtime/catalog semantics](../tests/custom-provider-lifecycle.test.ts).

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

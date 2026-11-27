# Context, caching, and costs

Click the context/cost row beneath the composer to open **Session stats**. The context measurement, cache-hit rate, and dollar estimate answer different questions; none is a provider invoice or a guarantee about the next request.

## Conversation meter

The numerator is the latest qualifying completed conversation response's native Pi **input + output + cache read + cache write** tokens. Reasoning is already included in output. Partial updates, errors, aborts, invalid counts, and all-zero usage do not replace the last measurement. Summarizer usage never supplies this meter.

The denominator follows the selected model's catalog limit. Custom models use their pinned/reported/fallback budget. Claude Code instead uses a valid CLI-reported effective budget for this session's matching model, which may be lower because of CLI auto-compaction. Missing limits remain unknown, not invented.

Changing models keeps the numerator but does not borrow another model's CLI budget. Successful compaction invalidates earlier measurements: `? / maximum` remains until a new qualifying response; CLI budget metadata is invalidated too.

### Observed cache-hit rate

Expanded Session stats shows **Cache hit rate** only after positive cache reads are recorded and inputs are valid. It is a session-wide, prompt-token-weighted ratio, not an average of per-call percentages:

```text
sum(cache read) / sum(fresh input + cache read + cache write)
```

Output is excluded; one-hour writes are a subset of writes and are not counted twice. Missing cache counts mean no recorded reuse, not proven misses. This describes observed usage, not cache warmth, future hits, savings, or retention duration. See [`sessionCacheHitRate`](../src/core/prices.ts).

## Prompt-cache retention

Under **Settings → Agent → Models → Show advanced settings**, each Strong/Cheap/Vision slot has a **Cache** dropdown. Hiding advanced settings does not reset it.

| Choice | Request behavior |
| --- | --- |
| Pi default | Leave `cacheRetention` unset, preserving Pi behavior, including `PI_CACHE_RETENTION=long` where honored. |
| Don’t request caching | Pass Pi's `none` preference; providers may still cache automatically. |
| Short retention | Pass Pi's `short` preference. |
| Long retention | Pass Pi's `long` preference; cache writes may cost more. |

These are **provider-dependent preferences**, not fixed-duration or cache-hit promises. Some adapters ignore them, subscription transports may omit them, and custom endpoints may reject unsupported parameters. LearnHarness does not retry with a different preference.

Sessions inherit Strong's retention preference while keeping their own model choices. Background roles inherit their assigned slot's preference, even with a model override; summarization uses the conversation preference. Changes apply at the next model request, including an existing loop, without altering an in-flight call or issuing warm-up calls. Explicit choices override Pi's retention environment preference; Pi default removes the explicit choice.

For supported Anthropic routes, Short/Long map to five minutes/one hour, with cache writes costing 1.25×/2× ordinary input; reads use discounted cache-read pricing. Longer retention can help across pauses but cost more for a single call or short job. Other providers differ. Consult [Anthropic caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) and [OpenAI caching](https://developers.openai.com/api/docs/guides/prompt-caching) for current mappings/prices.

## Spending

The server uses Pi AI's catalog and public `calculateCost`; the browser receives derived estimates, not a separate rate table. Catalog updates can reprice history without mutating saved usage.

| Route | Meaning |
| --- | --- |
| API providers | Dollar estimates when catalog model and required usage detail are available. |
| Built-in subscription connections | Labelled plan usage through explicit logical provider IDs, not API dollars. |
| [Claude Code](claude-code.md) | CLI tokens retained; dollar costs unpriced. CLI result-line dollar totals are not imported; routing/billing belongs to the CLI. |
| [Custom/local endpoints](custom-providers.md) | Tokens retained; unknown/unpriced costs, not $0. No rate editor. |

Mixed sessions sum known API estimates and retain subscription/CLI labels. Unpriced turns remain unpriced, not free. Summarizer spending counts under the same rules but does not populate the conversation meter.

Saved input counts are Pi-normalized **fresh input**, disjoint from cache buckets; do not subtract cached reads again. Old records missing a cache-write retention split, or tier-priced multi-call jobs missing per-call detail, stay unpriced where that detail could change the result. They are not reconstructed from aggregates. Flat-rate historical jobs can remain priceable with sufficient counts.

## Compaction and maintainer references

Compaction summarizes older context for future requests; original messages remain stored. The next-request estimate is separate from the displayed last-call measurement: it anchors on reported usage, estimates later messages, and falls back to active-transcript/system-prompt heuristics. The trigger is the smaller of the configured threshold and catalog window minus reserve. Unknown catalog windows use the configured threshold alone; CLI display metadata does not change that trigger.

[`src/core/compaction.ts`](../src/core/compaction.ts) ports cutoff selection and default sizing heuristics from **@earendil-works/pi-coding-agent 1.4.0**, without a coding-agent dependency. It walks backward to an approximate **20,000-token retained tail**, selecting a valid user/assistant boundary and preserving preceding calls when trailing results require them. Text/thinking/tool names/arguments use characters ÷ 4; images get a fixed 1,200-token allowance. Whole messages can overshoot; this is not an exact size guarantee, and encrypted signatures are not measured or stripped.

LearnHarness retains its own educational summary prompt, plan continuity, scheduling, authorization, and persistence. A cut dropping no history does not summarize. Requests include the latest summary once, then the retained transcript; later summaries receive the prior summary once plus newly superseded material. Unresolved cutoffs retain the existing full-history fallback. Output-limit (`length`) summaries fail rather than checkpointing incomplete output.

### Optional reasoning-aware estimates (OpenAI Responses only)

Under **Settings → Agent → Context**, immediately below the compaction threshold,
**Include reasoning in token estimates (OpenAI Responses only)** enables a
reasoning-aware extension to the native heuristic. It defaults **off**, including
for existing settings without `compaction.includeReasoning`. Changes apply to
future compaction checks, not a compaction already in progress, and do not recut
existing summaries.

The readable-content heuristic can substantially undercount a retained tail
containing opaque reasoning, even when provider usage correctly triggers
compaction. With the option on, saved response-level output usage supplies a
**floor** on the readable-content estimate for assistant responses that:

- use `openai-responses` and match the selected model's API, provider, and model ID;
- contain at least one thinking block with a nonempty `thinkingSignature`, even
  when readable thinking is empty;
- have valid positive safe-integer output usage and are not errored or aborted.

Output usage already includes reasoning: it is charged **once per response**, not
per thinking block, and is not added to the readable estimate. The estimator
never converts ciphertext length to tokens or uses context-wide input/total
usage as a per-message size. Other models, APIs (including OpenRouter's Chat
Completions route), unsigned messages, and unusable output readings retain the
original heuristic.

The option affects retained-tail cutoff selection and next-request estimates in
both the turn-start gate and background settle check, including the fallback
immediately after compaction invalidates the previous provider-usage anchor.
Provider-reported usage anchors otherwise remain unchanged. Saved output usage
is a replay-size proxy, not an exact measurement of the next request: neither
mode guarantees a measured 20k tail. The threshold, recent-tail budget, and
assistant/tool/question boundary rules are unchanged.

This option does **not** add thinking text to the summarizer's input, strip
signatures, rewrite saved history, or change the conversation meter. Regression
coverage: [reasoning accounting](../tests/compaction-reasoning.test.ts),
[both service entrypoints and an identical-snapshot on/off comparison](../tests/compaction-service.test.ts),
[settings persistence/defaults](../tests/settings-store.test.ts), and
[Settings toggle](../tests/render-settings.test.tsx). The comparison uses a fixed
synthetic summary and saved usage; it does not measure real provider input.

### Implementation references

Implementation: [`server/compaction.ts`](../src/server/compaction.ts), [`context-usage.ts`](../src/core/context-usage.ts), [`server/pricing.ts`](../src/server/pricing.ts). Regressions: `compaction-native-parity`, `context-usage`, `pricing-native-parity`, `subscription-usage`, and `session-cache-hit-rate` under `tests/`, plus CLI/custom-provider suites.

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

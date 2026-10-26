# DeepSeek prefix caching in LearnHarness

Status: implemented 2026-10-25 (caching wave). Scope: token economics of the
teaching turn, specifically on DeepSeek's automatic context cache. No product
behavior changes except one runaway-cost guard and an optional output ceiling.

## Why this exists

DeepSeek bills a prompt as two prices: tokens that extend a prefix the provider
already cached cost the **cache-read** rate, everything else costs the full
input rate. On the shipped catalog the gap is large:

| model | input | cache read | cache read / input |
|---|---|---|---|
| `deepseek-flash` | $0.30/M | $0.006/M | 2% |
| `deepseek-v4-pro` | $1.32/M | $0.044/M | 3.3% |

A tutoring session that resends 100k tokens every step therefore costs
~$0.13/step at the input rate but ~$0.004/step on a hit. At 97% reuse — the
rate DeepSeek Harness (DSH) measures for its append-only agent loop — the
same session is roughly 30–50× cheaper. The cache is not an optimization
setting; it is the difference between a viable and an unviable session budget.

The provider reports the split per call (`prompt_cache_hit_tokens` →
pi-ai `Usage.cacheRead`; `prompt_cache_miss_tokens` folds into `input`). Those
numbers are the only ground truth used here.

## The DSH rule, ported

DSH reaches 97–99% reuse because of one invariant: **once bytes have been
sent, never change them**. A new turn appends; it does not rewrite. Everything
in this wave follows from that.

| DSH mechanism | LearnHarness equivalent |
|---|---|
| Stable rendered system prompt; a changed prompt is appended in-history | The composed prompt is read from static fragments and is byte-stable turn to turn (overrides change it only when the user flips a switch). We detect and name a change instead of hiding it. |
| Stable tool declarations; unused tools stay declared | Tool registries are built deterministically from settings; a mid-session settings change is reported as a prefix reset. |
| Runtime context appended after retained history, never at the head | Volatile context already rides the transcript tail (steer/compaction markers), never the system prompt. |
| Surface replacement = cache epoch; compaction is the only intentional rewrite | Compaction still rewrites the head once; the audit labels it a rewrite and the next turn re-warms. |
| Usage accounting carries `cacheReadTokens` | Already persisted per call (`CallUsage.cacheReadTokens`); now folded into a session-level cache summary. |

## What was added

### 1. Prefix audit (`src/core/prompt-cache.ts`, pure)

- Projects a request to the model-visible prefix: system text, tool
  declarations, and one block per message. Timestamps, usage, record ids, and
  other wire-invisible fields are dropped.
- Fingerprints each block (64-bit FNV-1a) and compares consecutive requests:
  `first` / `append` / `system` / `tools` / `rewrite`, with the first diverging
  block, estimated shared tokens, and prefix share.
- Splits provider usage into disjoint buckets and derives the hit rate.
- Derives dollars saved from the provider's own cost blocks (no second rate
  table).

Tests: `tests/prompt-cache.test.ts`, including the real
`toLlmMessages` → projection seam and the compaction head rewrite.

### 2. Turn telemetry (`src/server/prompt-cache.ts`)

`beginPromptCacheTurn(chatId, model)` is created once per turn in the chat
handler. The agent layer hands it the live message list before **every**
conversational model call (`AgentBuildOptions.promptCache` →
`prepareRequest`), so the audit sees exactly what the provider is about to
receive. It logs one line per turn:

```
[chat <id>] prompt cache: 3 calls, 148.2k/151.0k tokens reused (98%), predicted 99% · saved $0.1842
```

and warns loudly when:

- the system prompt or a tool declaration changed (`prefix reuse resets at token 0`);
- history was rewritten (compaction or an edited record);
- a stable, large prefix got <15% provider-reported hits — almost always a
  routing problem (a gateway that drops `prompt_cache_hit_tokens`, or a
  non-native OpenAI-compatible route).

Set `LH_CACHE_DEBUG=1` for a per-step line.

### 3. Session cache economics (`src/core/prices.ts` + `src/server/pricing.ts`)

`GET /api/chats/[id]` now carries `pricing.cache`:

```ts
{ promptTokens, cacheReadTokens, cacheWriteTokens, hitRate, savedUsd,
  pricedCalls, unpricedCalls }
```

Token counts and hit rate are provider-reported and survive unpriced models;
`savedUsd` uses pi-ai's `calculateCost` (same calculator as the money channel)
to price the same usage with and without the cache. The stats bar shows
`N% cached` beside the session cost and a `Prefix cache` row in the popover.

### 4. Runaway-cost guard

Prefix caching cannot discount **output** tokens, and a loop can still spend
without bound.

| variable | default | effect |
|---|---|---|
| `LH_MAX_OUTPUT_TOKENS` | off (model max) | Optional per-call `max_tokens` ceiling on native routes. **Do not set this low on reasoning models**: reasoning tokens count against the ceiling, and a 32k cap truncates a `thinkingLevel: max` call before its tool call (observed: visual-maker generating a figure). |
| `LH_MAX_TURN_USD` | `5` | Aborts the teaching turn when provider-priced spend for that turn crosses this. `0` disables. Logged as `turn spend cap hit`. |

## Cache breakers still in the system

| Breaker | Frequency | Handling |
|---|---|---|
| Compaction (`compactionCutIndex`) | once per ~150k tokens | Intentional rewrite: summary becomes block 1. Audit labels it; the next turn rebuilds. |
| Prober → teacher handoff | once per session | Different agent, different system prompt/tools — miss from token 0. Inherent. |
| Prompt-override switch or tool toggle changed mid-session | user action | Warned as `SYSTEM PROMPT CHANGED` / `TOOL DECLARATIONS CHANGED`. DSH would append an in-history prompt update; chat-completions routes cannot, so a reset is honest. |
| Model/route switch | user action | A different model is a different cache domain. State resets on model id change. |
| Aborted/errored assistant message dropped by pi-ai's transform | abort/error | The old tail is rewritten; prefix before it survives. |
| Provider cache expiry | inactivity (hours) | Nothing to do client-side; the first turn after a pause re-warms. |

## Verifying a live session

1. Select a **native** `deepseek` model (Settings → Models); a gateway that
   fronts DeepSeek is not guaranteed to forward the cache metrics.
2. Run two turns with no settings changes. The console should print
   `predicted ~100%` and a provider hit rate in the same range.
3. Open the stats bar popover: `Prefix cache` should show the same hit rate
   and a growing `saved` figure.
4. If the predicted share is high but the provider hit rate is near zero,
   the warning names the likely cause; check the route and the API key's
   provider before changing prompts.

## Files

- `src/core/prompt-cache.ts` — projection, fingerprints, diff, usage split.
- `src/server/prompt-cache.ts` — per-chat telemetry and warnings.
- `src/agent/teacher-agent.ts` — `promptCache` seam on `prepareRequest`.
- `src/server/chat-handler.ts` — per-turn observer, spend cap.
- `src/agent/models.ts` — output ceiling.
- `src/core/prices.ts`, `src/server/pricing.ts` — session cache fold.
- `components/stats-bar.tsx` — cache readout.
- `tests/prompt-cache*.test.ts`, `tests/cache-pricing.test.ts`.

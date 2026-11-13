# Listening

Source for the planned **Listening** core plugin: questions the learner answers by hearing
synthesized speech, in any language, using their own ElevenLabs API key.

This stage contains only the **speech engine**. It is not yet a plugin package (there is
no manifest or entry point), and nothing in the app uses it.

## Speech engine (`src/speech/`)

| File | Role |
| --- | --- |
| `provider.ts` | The text-to-speech provider interface, model metadata and the default model rule |
| `elevenlabs.ts` | ElevenLabs adapter: live model list (`GET /v1/models`) and synthesis |
| `service.ts` | Request parsing, cache keys, in-flight deduplication and the concurrency bound |
| `cache.ts` | Disk cache with checksums, atomic writes and least-recently-used eviction |
| `limits.ts` | Limits and readable errors |

Behavior:

- **No automatic retries.** A failed request may already have been billed.
- Provider failures map to readable messages that never include provider response text.
  Responses must be real MP3 audio within the size limit.
- Identical requests share one generation; at most 2 different generations run at once.
- Cached audio plays without an API key. Failures are never cached, and a broken disk cache
  doesn't throw away freshly generated audio.
- The cache key covers provider, model, voice, language and text, so changing any of them
  never plays the wrong audio. Language tags are reduced to their base code (`pt` for
  `pt-BR`), which is what ElevenLabs documents for `language_code`.

| Limit | Value |
| --- | --- |
| Spoken text | The model's `maximum_text_length_per_request` (for example 40,000 characters on Flash v2.5) |
| Generated audio | 2 MiB plus 1 MiB per 1,000 characters |
| Generation time | 30 s plus 20 s per 1,000 characters |
| Concurrent generations | 2 |
| Disk cache | 256 MiB, least recently used clips removed first |

## Development

```sh
npm run sdk && npm ci   # or npm run plugins:setup from the repository root
npm test
npm run typecheck
```

Tests use fake fetch functions and providers; no key or network is needed.

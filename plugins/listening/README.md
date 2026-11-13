# Listening

The LearnHarness core plugin for **listening questions**: questions the learner answers by
hearing synthesized speech, in any language the selected voice model speaks.

This stage adds the **speech setup**: the settings page, the plugin-owned API key and the
Ready state, on top of the speech engine. The agent does not receive listening questions
yet; they arrive in the next stage.

Speech comes from **ElevenLabs** with your own API key. The provider sits behind a
small interface so others can be added later.

## Core plugin and setup

Enable Listening in **Settings → Core plugins**, then open its settings page:

1. **Provider**: ElevenLabs (the only provider in this version).
2. **API key**: paste an ElevenLabs API key and press **Save key**. Only a format check
   runs on save; the key is not tested against ElevenLabs.
3. **Voice ID**: copy a Voice ID from your ElevenLabs voice library. Pick one voice that
   suits the language you are studying. No voice ships with the plugin.
4. **Model**: loaded live from your account (`GET /v1/models`), limited to models that
   can do text-to-speech without alpha access. The first choice defaults to
   `eleven_flash_v2_5` when your account lists it, otherwise the first model listed. A
   chosen model is never replaced automatically: if it later disappears from your
   account's list, it stays selected and the settings page warns you.

Listening is **Ready** once it has an API key, a Voice ID and a loaded model. The
settings page shows what is still missing. Startup reads the saved model snapshot, so it
needs no network call.

Writable plugin files live under `<learning data>/core-plugin-data/listening/`:

| File | Contents |
| --- | --- |
| `settings.json` | Provider, Voice ID, model ID and a snapshot of the selected model's name, text limit and languages |
| `credentials.json` | API keys per provider, owner-only (`0600`), written atomically |
| `cache/speech/` | Generated audio (see below) |

If `settings.json` or `credentials.json` cannot be read, Listening starts with defaults
and the settings page says so; the next save writes a fresh file.

### Why the key lives in the plugin

The plugin API gives backends no access to host credentials, so the key cannot sit in
**Settings → Providers**. Listening stores it in its own data folder and never returns
it to the browser: the settings page only learns whether a key is saved. The key is not
in `auth.json`/`LH_AUTH_FILE` and isn't covered by host credential tooling. Disabling the
plugin keeps the key; use **Remove** to delete it.

## Limits

| Limit | Value |
| --- | --- |
| Spoken text | The selected model's `maximum_text_length_per_request` (for example 40,000 characters on Flash v2.5) |
| Generated audio | 2 MiB plus 1 MiB per 1,000 characters |
| Generation time | 30 s plus 20 s per 1,000 characters |
| Concurrent generations | 2 (identical requests share one generation) |
| Disk cache | 256 MiB, least recently used clips removed first |

There are no automatic retries, because a failed request may already have been billed.

## Privacy and cost

The spoken text, voice, model and
language are sent to ElevenLabs only when that exact audio is not already cached.
Cached audio plays without a key or network connection. Generation uses your ElevenLabs
quota.

## Development

```sh
npm run sdk && npm ci   # or npm run plugins:setup from the repository root
npm test
npm run typecheck
npm run build           # writes dist/
```

Tests use fake providers; no key or network is needed.

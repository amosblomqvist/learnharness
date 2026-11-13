# Listening

A LearnHarness plugin for **listening questions**. The agent poses a question that the
learner can only answer by hearing synthesized speech. It works for any language the
selected voice model speaks. The spoken text stays hidden until the learner answers;
then it appears as a transcript with replay.

Speech comes from **ElevenLabs** with your own API key. The provider sits behind a
small interface so others can be added later.

## Core plugin and setup

Enable Listening in **Settings → Core plugins**, then open its settings page:

1. **Provider**: ElevenLabs (the only provider in this version).
2. **API key**: paste an ElevenLabs API key and press **Save key**. Only a format check
   runs on save; the key is not tested against ElevenLabs.
3. **Voice ID**: copy a Voice ID from your ElevenLabs voice library. Pick one voice that
   suits the language you are studying. One voice speaks every listening question. No
   voice ships with the plugin.
4. **Model**: loaded live from your account (`GET /v1/models`), limited to models that
   can do text-to-speech without alpha access. The first choice defaults to
   `eleven_flash_v2_5` when your account lists it, otherwise the first model listed. A
   chosen model is never replaced automatically: if it later disappears from your
   account's list, it stays selected and the settings page warns you.

Listening is **Ready** once it has an API key, a Voice ID and a loaded model. Only then
does the agent receive the listening instructions, and only then are new listening
questions accepted. Changes apply from the next turn. The question type itself stays
registered while the plugin is enabled, so a question that is already pending can always
be answered, even after Listening stops being Ready or the app restarts: cached audio
still plays, and otherwise **Continue another way** is available. While Listening is not
Ready the agent can still see the two tool names, but any call is refused with a message
telling it to assess the goal another way.

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

## Learner experience

- A listening question shows **Listen** controls above the question: **Play** (1×),
  **0.75×**, **Pause/Resume** and **Stop**. Both speeds use the same recording with
  pitch preservation. There is no seeking.
- The answer is single-answer multiple choice or free recall, chosen by the agent.
  Options are shuffled per question.
- **Submit** unlocks only after one **full playback**: one play from start to end at
  either speed. Pausing and resuming still counts; stopping or switching speed starts a
  new attempt. Replay is unlimited, and an earlier full playback still counts.
- If audio fails, use **Retry**. After two failures, **Continue another way** lets the
  learner submit without listening. The agent then assesses the goal another way and
  leaves listening **unassessed**; it is never a wrong answer. A later successful
  playback undoes this choice.
- After answering, multiple choice shows correct/incorrect, ✓/✗ marks and an optional
  **Why**. Free recall shows the learner's answer and the agent's committed answer.
  Both show the transcript and replay controls.

**Dictation:** plugins cannot see whether dictation is active, so audio does not pause
on its own. Pause the audio before you dictate.

Concealing the spoken text is ordinary interface behavior, not exam security: the tool
arguments and audio requests remain visible in browser developer tools.

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

Audio is generated only when the learner presses Play. The spoken text, voice, model and
language are sent to ElevenLabs only when that exact audio is not already cached.
Cached audio plays without a key or network connection. Generation uses your ElevenLabs
quota.

## Question contract

The plugin contributes `listening_probe` to the **prober** and `listening_question` to
the **teacher** (contract version 1, thinking shown). Practice problems are not part of
this version. Besides the host's common fields, the payload is:

```ts
{
  audio: { text: string; language: string }; // ISO 639-1, optional region (pt-BR)
  format: "choice" | "recall";
  options?: { label: string; value?: string }[]; // choice only, 2 or more
  explanation?: string;                          // choice only, shown as Why
  correctAnswer: string; // choice: the option's value (or label); recall: full answer
}
```

The language tag is saved as written and labels the transcript. ElevenLabs receives its
base code (`pt` for `pt-BR`), which also keys the cache.

Validation rejects spoken text longer than the model accepts, a language whose base code
the model does not list, mismatched options, and options/explanation on recall.

Saved answers are `{status: "answered", choice | text, playbackRates}` or
`{status: "audio_unavailable"}`. `playbackRates` lists the speeds at which playback
started. Grading returns observations: `modality: "listening"`, `correct` for choice,
`playbackRates`, `slowPlaybackUsed`, or `outcome: "audio_unavailable"` with
`assessment: "unassessed"`. Free recall is judged by the teacher.

## Development

```sh
npm run sdk && npm ci   # or npm run plugins:setup from the repository root
npm test
npm run typecheck
npm run build           # writes dist/
```

Tests use fake providers; no key or network is needed.

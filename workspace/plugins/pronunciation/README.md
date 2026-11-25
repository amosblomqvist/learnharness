# Chinese pronunciation

Click Chinese text anywhere in LearnHarness to hear it spoken. Speech is generated
locally by the [Kokoro v1.1-zh](https://huggingface.co/hexgrad/Kokoro-82M-v1.1-zh)
voice model, running on the GPU through ONNX Runtime's DirectML provider.

## Requirements

- Windows on x64 with a DirectML-capable (DirectX 12) GPU. Other systems show
  "unsupported" in settings.
- About 480 MB of downloads, fetched once from Settings.

## Setup

1. Enable **Chinese pronunciation** in Settings → Core plugins.
2. Open the plugin's settings and press **Download**. Two kinds of file are
   fetched and checked before use:
   - `kokoro-multi-lang-v1_1.tar.bz2` (365 MB) from the
     [k2-fsa/sherpa-onnx `tts-models` release](https://github.com/k2-fsa/sherpa-onnx/releases/tag/tts-models),
     checked against a pinned SHA-256.
   - `onnxruntime-node` and `onnxruntime-common` 1.31.1 (115 MB) from the npm
     registry, checked against npm's published SHA-512 integrity values.

   Windows' built-in `tar.exe` unpacks only the needed files into the plugin's
   data folder (`core-plugin-data/pronunciation/voice/`). An interrupted or failed
   download leaves nothing installed.
3. Pick a voice: `zf_001` (default), `zf_002`, `zm_009` or `zm_010`.

**Remove downloaded files** deletes the install. Windows keeps a loaded GPU
runtime DLL locked until the app exits, so a few files may be deleted on the
next start instead.

## Using it

- A short, still click or tap on Chinese text plays the whole unbroken run of
  Chinese characters around it. Punctuation, spaces, Latin letters and digits
  end the run, and a run is capped at 100 characters.
- Clicks are ignored when they move more than 5 px, last longer than 500 ms,
  leave text selected, are the second click of a double-click, use a modifier
  key, or land on a link, button, answer option, input, editor or other control.
- A run that is split by formatting (for example a bold word in the middle of a
  sentence) plays only the part in the clicked text node.
- Hovering with a mouse shows a faint dotted underline under the phrase a click
  would play.
- A new click stops the clip that is playing. Nothing is cached: each click
  generates the audio again (about 0.1–0.7 s on a mid-range GPU).
- The model loads on the first click (a few seconds, including GPU warm-up) and
  stays loaded, using about 0.5 GB of VRAM, while the plugin is enabled.
- On a phone opened through the mobile link, the PC's GPU generates the audio
  and the phone plays it.

Errors, such as the model not being downloaded or DirectML being unavailable,
appear as a small notice next to the clicked text. There is no CPU fallback.

## How text becomes speech

The phrase is segmented the way jieba does (the most probable path through the
words, weighted by frequencies from the model's `jieba.dict.utf8` and
`user.dict.utf8`), restricted to words in the model's `lexicon-zh.txt`. Each word's
phonemes, with tone changes already applied inside the word, come from that
lexicon; a word not in the lexicon is read character by character, and a
character not in it is skipped. The token sequence, padded with 0 at both ends,
runs through `model.onnx` with the voice's style vector for that token count.

## Development

```sh
npm run sdk
npm ci
npm run typecheck
npm test
npm run build
```

`npm test` uses small fixture lexicons, a local HTTP server and fake runtimes. It
needs no download or GPU. `scripts/smoke-gpu.mjs` runs the real model on the GPU
against a scratch data directory; read it before running it.

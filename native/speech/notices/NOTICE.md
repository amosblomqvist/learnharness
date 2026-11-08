# Local speech attribution and source locations

The bundled helper links Piper 1.8.0 (GPL-3.0), espeak-ng (GPL-3.0 and
its separately licensed Unicode/ucd components), Sonic (Apache-2.0), and
ONNX Runtime 1.22.0 (MIT, with third-party notices). Original notices accompany
this file. Exact source revisions and the ONNX archive hash are recorded in
`runtime.lock.json`. Build instructions and the application helper source live
in the application's `native/speech` directory and `scripts/prepare-speech-runtime.mjs`.

- Piper: https://github.com/OHF-Voice/piper1-gpl/tree/639388b6317fc4731e91d53da42aea68fd4166ff
- espeak-ng: https://github.com/espeak-ng/espeak-ng/tree/212928b394a96e8fd2096616bfd54e17845c48f6
- Sonic: https://github.com/waywardgeek/sonic/tree/fbf75c3d6d846bad3bb3d456cbc5d07d9fd8c104
- ONNX Runtime: https://github.com/microsoft/onnxruntime/tree/v1.22.0

The separately downloaded en_US-ljspeech-high voice comes from rhasspy/piper-voices,
whose repository identifies its license as MIT. Its original repository notice
is included as `piper-voices-README.md`. The voice's MODEL_CARD is downloaded and
verified alongside the model; it identifies the LJ Speech dataset as public
domain and credits the training work. No dataset or voice ownership is claimed
by LearnHarness.

Repository notice source:
https://huggingface.co/rhasspy/piper-voices/raw/b4e358ffcb232591bf73a540e70f7de528e4174a/README.md
SHA-256: 33e93643fce5180886300f9f0070eeeab8af148efb8e84361f8904def80fd9fb

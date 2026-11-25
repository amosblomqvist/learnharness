# Third-party software and data

Chinese pronunciation is AGPL-3.0-only (see LICENSE). The built plugin bundles no
third-party code. When you press **Download**, it fetches the following from their
publishers and stores them in the plugin's data folder:

- **Matcha-Baker** acoustic model (`model-steps-3.onnx`), lexicon and token table
  from the sherpa-onnx `matcha-icefall-zh-baker` release. Matcha-TTS code is MIT
  and the icefall training recipe is Apache-2.0. The model was trained on the
  Databaker Chinese Standard Mandarin Speech Corpus, whose recordings are
  licensed for non-commercial use only. The release README documenting these
  terms is kept beside the model.
  [Sherpa model release](https://github.com/k2-fsa/sherpa-onnx/releases/tag/tts-models),
  [Matcha-TTS license](https://github.com/shivammehta25/Matcha-TTS/blob/main/LICENSE),
  [icefall license](https://github.com/k2-fsa/icefall/blob/master/LICENSE),
  [Databaker datasets](https://en.data-baker.com/datasets/freeDatasets/)
- **Vocos** (`vocos-22khz-univ.onnx`) from the
  [sherpa-onnx vocoder release](https://github.com/k2-fsa/sherpa-onnx/releases/tag/vocoder-models).
  [Vocos code license](https://github.com/gemelo-ai/vocos/blob/main/LICENSE) (MIT).
- **CppJieba dictionaries** (`dict/jieba.dict.utf8`, `dict/user.dict.utf8`) from the
  same archive. MIT, yanyiwu and contributors. https://github.com/yanyiwu/cppjieba
- **ONNX Runtime 1.31.1** (`onnxruntime-node`, `onnxruntime-common`, including
  `onnxruntime.dll`, `DirectML.dll` and `dxcompiler.dll`). MIT, Microsoft
  Corporation. DirectML and the DirectX Shader Compiler are redistributed by
  Microsoft inside that package under its terms. https://github.com/microsoft/onnxruntime

The plugin's pause shortening follows
[sherpa-onnx's Apache-2.0 implementation](https://github.com/k2-fsa/sherpa-onnx/blob/v2.0.3/sherpa-onnx/csrc/offline-tts.cc).

# Parakeet local dictation: model attribution

LearnHarness can transcribe dictation on your own computer. The model is not
bundled with the app: you download it from **Settings → Keys → Dictation**
and it is stored under the app's data directory
(`models/parakeet-tdt-0.6b-v3-int8`).

## Model

**Parakeet TDT 0.6B v3** (`nvidia/parakeet-tdt-0.6b-v3`) by NVIDIA, licensed
under the [Creative Commons Attribution 4.0 International License (CC BY 4.0)](https://creativecommons.org/licenses/by/4.0/).

- Model card: <https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3>
- Changes made: the weights are the int8-quantized ONNX conversion published
  by the sherpa-onnx project
  (`sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8`), downloaded from
  <https://github.com/k2-fsa/sherpa-onnx/releases/tag/asr-models>. The app
  verifies the archive against a pinned SHA-256 before installing it.

## Runtime

Inference runs through **sherpa-onnx** (`sherpa-onnx-node`), licensed under
the Apache License 2.0: <https://github.com/k2-fsa/sherpa-onnx>.

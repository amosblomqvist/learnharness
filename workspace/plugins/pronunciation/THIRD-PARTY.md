# Third-party software and data

Chinese pronunciation is AGPL-3.0-only (see LICENSE). The built plugin bundles no
third-party code. When you press **Download**, it fetches the following from their
publishers and stores them in the plugin's data folder:

- **Kokoro-82M v1.1-zh** voice model and voices (`model.onnx`, `voices.bin`), in the
  sherpa-onnx `kokoro-multi-lang-v1_1` packaging. Apache-2.0, hexgrad; the Chinese
  training data was provided by LongMaoData. The archive's own `LICENSE` is kept
  beside the model. https://huggingface.co/hexgrad/Kokoro-82M-v1.1-zh,
  https://github.com/k2-fsa/sherpa-onnx
- **Chinese lexicon and token table** (`lexicon-zh.txt`, `tokens.txt`) from the same
  sherpa-onnx archive. Apache-2.0.
- **CppJieba dictionaries** (`dict/jieba.dict.utf8`, `dict/user.dict.utf8`) from the
  same archive. MIT, yanyiwu and contributors. https://github.com/yanyiwu/cppjieba
- **ONNX Runtime 1.31.1** (`onnxruntime-node`, `onnxruntime-common`, including
  `onnxruntime.dll`, `DirectML.dll` and `dxcompiler.dll`). MIT, Microsoft
  Corporation. DirectML and the DirectX Shader Compiler are redistributed by
  Microsoft inside that package under its terms. https://github.com/microsoft/onnxruntime

# Local speech worker

Piper source: OHF-Voice/piper1-gpl v1.8.0, commit
`639388b6317fc4731e91d53da42aea68fd4166ff`. Build its `libpiper`
subdirectory with CMake and install it first. Then configure this directory
with `-DPIPER_ROOT=/absolute/path/to/piper/install` and build/install it.
The worker requires the installed Piper and ONNX shared libraries and espeak
pronunciation data. Runtime binaries must be built on their target OS.

The executable receives exactly three trusted arguments: model path, model
configuration path, and espeak data directory. It loads once and handles
requests sequentially. Terminate the process to cancel inference.

## Protocol version 1

Each frame begins with a uint32 little-endian payload length. The payload
begins with version (uint8, 1), type (uint8), and request ID (uint32 LE).

- Request type 1: UTF-8 text, 1–16384 bytes, no embedded NUL.
- Response type 2: uint32 LE sample rate followed by signed 16-bit LE mono PCM.
- Response type 3: completion, no additional payload.
- Response type 4: UTF-8 stable error code.

Every response carries the request ID. Diagnostics go to stderr. Invalid
framing closes the process; unsupported version/type and invalid text return
structured errors. The server must bound total output and inference duration,
accept catalog IDs only, and kill the worker on cancellation or shutdown.

`node scripts/smoke-speech-runtime.mjs WORKER MODEL CONFIG ESPEAK_DATA` tests
two sequential requests with a real model. This separate packaging gate is
not part of offline model-free unit tests. Linux x64 was locally compiled and
exercised; macOS signing and Windows loading require their own runners.

## Local reference measurements

Linux x64, AMD Ryzen 5 7500F: two sequential requests using
“Welcome to your lesson. Read the question carefully.” measured cold
first audio 1086 ms, total 1785 ms for 2.763 s audio; warm first audio
558 ms, total 1260 ms for 2.775 s audio (real-time factor 0.454).
Peak worker RSS was 196220 KiB. Runtime resources occupied 40 MiB before
installer compression; voice assets add 114204494 bytes. These are local
measurements, not cross-platform packaged results.

Run `scripts/benchmark-speech-runtime.mjs` with the same arguments as the
smoke test to measure first audio, total duration, real-time factor and
Linux peak RSS. It rejects warm synthesis slower than real time.

Piper can return its final nonempty audio chunk together with PIPER_DONE;
the worker emits that final chunk before completion.

# Local lesson narration

Piper narration runs inside a persistent native helper owned by the desktop Next server. The renderer requests bounded sentence WAVs using catalog voice IDs. A per-launch Electron capability protects every speech route, including preference writes; browser-only deployments cannot launch helpers or install voices.

## Runtime and assets

Piper 1.8.0 is pinned to commit `639388b6317fc4731e91d53da42aea68fd4166ff`. Runtime libraries and espeak data ship as unpacked installer resources. `scripts/prepare-speech-runtime.mjs` prepares the bundle on supported build hosts. Unsupported targets ship an unavailable marker. Runtime dependencies are never downloaded during synthesis.

Six voices are curated, lightest first. `docs/piper-artifacts.lock.json` records the immutable Hugging Face revision, every file's byte count and SHA-256 hash, and each voice's license. Download sizes (the `.onnx` model plus its config and model card):

| Voice | Weight | Download | License |
|---|---|---|---|
| Danny · English (US) `en_US-danny-low` | Fastest (low quality) | 63.1 MB | CC BY-SA 4.0 |
| Joe · English (US) `en_US-joe-medium` | Balanced | 63.2 MB | CC0 1.0 |
| Amy · English (US) `en_US-amy-medium` | Balanced | 63.2 MB | CC BY-SA 4.0 |
| Alba · English (GB) `en_GB-alba-medium` | Balanced | 63.2 MB | CC BY 4.0 |
| Northern English Male · English (GB) `en_GB-northern_english_male-medium` | Balanced | 63.2 MB | CC BY-SA 4.0 |
| LJ Speech · English (US) `en_US-ljspeech-high` | Highest quality, heaviest | 114.2 MB | Public domain dataset |

The weight labels describe the quality tier only; measured real-time factors are not shown until the packaged benchmark runs on the reference machine. Voices with non-commercial or unverified terms (`en_US-hfc_female-medium`, `en_US-ryan-medium`, and the lessac voices) are excluded. Share-alike voices require attribution: each voice's license name and dataset link are recorded in the lock file, and its model card is downloaded and hash-verified like the model.

Each voice has a bundled preview WAV in `public/speech/samples/`, so Preview works before installation and never starts the runtime. Installation downloads into a per-voice staging directory, verifies every artifact and synthesizes a test before activation. Preferences never imply installation. Interrupted installs retain verified files for retry.

The protocol is documented in `native/speech/README.md`. The server permits one synthesis at a time. Cancellation destroys the helper; the next request starts it lazily. The worker unloads after five idle minutes. Renderer playback rate ranges from 0.75 to 2 with pitch preservation.

## Review overlap

Open upstream PR #330 adds ElevenLabs dictation and read aloud. It overlaps settings, teacher controls, questions and dictation coordination. This change provides local inference and model installation; reviewers should reconcile the shared playback surface if both are accepted. Publication and merge remain maintainer decisions.

## Verification record

Linux x86-64 reference host: AMD Ryzen 5 7500F, Linux 7.2.8, GCC 16.2.1 and Node 26.10.0. A clean source checkout built the pinned Piper/espeak/Sonic runtime and verified the ONNX Runtime archive before extraction. The model download gate fetched all three immutable voice files, checked exact sizes and SHA-256 hashes, and exercised the installed helper.

The native smoke gate covers malformed/truncated frames, structured protocol errors, and two sequential single-sentence requests. It also catches Piper's final audio chunk arriving with `PIPER_DONE`. A network-disabled Linux namespace test passed after hiding the original build installation with a temporary mount, proving synthesis uses the relocated bundled libraries and downloaded model. Resource validation rejects absolute symlinks and links escaping the bundle.

For “Welcome to your lesson. Read the question carefully.”, cold first audio was 1,086 ms and total generation was 1,785 ms for 2.763 seconds of audio. Warm first audio was 558 ms and total generation was 1,260 ms for 2.775 seconds of audio: real-time factor 0.454, satisfying the faster-than-real-time gate. Peak worker RSS was 196,220 KiB. The uncompressed runtime occupies approximately 40 MiB on disk; voice download size is 114,204,494 bytes. Compressed installer growth has not been measured.

These local checks do not establish human listening quality, clean-machine installer behavior, production macOS signing, or Windows dependency loading. macOS and Windows ship an explicit unavailable state until their runtime combinations are verified. Linux installer-level checks remain separate from the tested relocated resource bundle. `scripts/benchmark-speech-runtime.mjs` reproduces timing and memory measurements; `scripts/verify-packaged-speech.mjs` downloads the pinned test assets and runs the native smoke gate. Normal unit tests remain offline and model-free.

Bundled notices include Piper GPL-3.0, espeak GPL/Apache/BSD/Unicode notices, Sonic Apache-2.0 and attribution, ONNX Runtime MIT and third-party notices, plus the voice repository's original MIT metadata notice and dataset provenance. Exact source locations accompany the resources in `licenses/learnharness-speech/NOTICE.md`.

Equations and code are announced and skipped. Narration remains English-only in this initial feature. It uses visible prose and question projections; it does not ask a model to rewrite content.

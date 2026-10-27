# Changelog

All notable changes to LearnHarness will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Local Model Support (Ollama & vLLM / LM Studio)**:
  - Added native compatibility for local LLMs running via Ollama (`http://localhost:11434`) and vLLM / LM Studio / OpenAI-compatible servers (`http://localhost:8000/v1`).
  - Implemented automatic model discovery for Ollama (`GET /api/tags` + `POST /api/show`) with digest-keyed caching and filtering for embedding-only models.
  - Implemented vLLM / OpenAI-compatible `/v1/models` discovery with extraction of `max_model_len` / `context_length`.
  - Added optional `LOCAL_AI_API_KEY` bearer token support for password- or token-protected local servers.
  - Zero cloud cost normalization (`cost: 0`) and automatic token clamping to prevent context overflow on tight VRAM environments.
  - Strict OpenAI compatibility flags for `@earendil-works/pi-ai` (`supportsStore: false`, `supportsDeveloperRole: false`, `supportsStrictMode: false`, `maxTokensField: "max_tokens"`, `supportsReasoningEffort: false`).
- **Settings UI**:
  - Added dedicated Ollama and Custom/vLLM configuration cards under **Settings → Providers**.
  - Added live "Test & Discover" and explicit "Save" controls with instant connection status feedback and discovered model badges.
  - Auto-saving on `blur` and `Enter` to keep form inputs persistently saved across settings tabs.
- **Vision Model Enhancements**:
  - Expanded multimodal model recognition for local models (MiniCPM-V, CogVLM, GLM-4V, InternVL, Pixtral, LLaVA, Llama 3.2 Vision).
  - Added visual `👁` badge in the model selection menu for image-capable models.
  - Unblocked the Vision model slot in Settings → Models, permitting any model to be assigned so users running text-only local models are never blocked from completing model setup.

### Fixed
- Fixed an issue where local provider endpoints and API keys were not persisted when switching tabs without running discovery.
- Fixed an issue where the Vision slot dropdown was empty when only text models were active, blocking chat initialization.
- Guarded vision regex so `vl` is letter-bounded (`/(?<![a-z])vl(?![a-z])/i`) to prevent false-positive multimodal classification on models with names containing `vllm`, `eval`, or `novel`.
- Prevented transient `/api/show` timeouts or HTTP errors from being cached in `ollamaShowCache`.
- Ensured `PUT /api/settings/localProviders` synchronously triggers `refreshConnectionCatalog()` so toggling a provider ON or OFF immediately updates `piModels()`.
- Prevented race conditions between input `onBlur` and "Test & Discover" clicks by checking dirty state and testing status.
- Ensured cold-start chats await connection catalog refresh when the active model is from a local provider (`ollama` or `custom`).
- Fixed visual hydration and accidental backend deletion of `LOCAL_AI_API_KEY` on settings tab remount by explicitly tracking saved key presence, normalizing response envelopes, and refining dirty-state checks.

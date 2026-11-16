# Store Antigravity OAuth profile beside LH_AUTH_FILE rather than LH_DATA_DIR

Status: accepted

`agy_acp_server` writes Google OAuth credentials and user settings under `GEMINI_HOME`. To preserve LearnHarness's boundary between shareable learning data (`LH_DATA_DIR`) and machine-local secrets (`LH_AUTH_FILE`), `GEMINI_HOME` lives beside `LH_AUTH_FILE` as `antigravity-profile/` (`0700` permissions), while managed ACP binaries and non-secret `models.json` cache live under `LH_DATA_DIR`.

## Consequences

- `next.config.ts` (`outputFileTracingExcludes`), `.gitignore`, and `scripts/build-server.mjs` must explicitly exclude and refuse `antigravity-profile/` so dev OAuth tokens can never leak into packaged desktop builds.
- Child processes scrub ambient Google/Gemini API keys and cloud project environment variables so API keys never silently bill instead of Antigravity.

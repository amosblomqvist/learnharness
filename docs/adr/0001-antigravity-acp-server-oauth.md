# Use official agy_acp_server with local OAuth instead of direct OAuth replay

Status: accepted

To integrate Google Antigravity subscriptions into LearnHarness without risking Google account suspension or maintaining hardcoded model lists and rotating private client headers, we use Google's official `agy_acp_server` (and `agy acp` CLI when installed) over ACP stdio, rather than replaying Google OAuth PKCE requests directly against `daily-cloudcode-pa.googleapis.com`.

## Consequences

- Authentication runs through `agy_acp_server`'s `authenticate` (`oauth-personal`), capturing the OAuth URL via an executable `BROWSER` wrapper script and `stderr` fallback, with manual callback forwarding for remote/headless setups.
- Available models and per-model `thought_level` capabilities are discovered dynamically from `session/new` (`clientInfo: { name: "zed", version: "0.0.0" }` for `< 1.5.1`) and `setConfigOption`, cached to `models.json` on sign-in and manual Refresh.

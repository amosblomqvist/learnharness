# Subscription and custom-provider connections

Open Settings → Providers for native subscriptions. Custom endpoints stay under Settings → Connections.

## Native subscriptions

ChatGPT keeps upstream's app-registered OAuth connection. Claude and Grok use the pinned pi-ai SDK's provider-specific flows inside Electron's main process. They share the native account controls with ChatGPT but do not have equivalent LearnHarness client registrations.

Continue opens a disclosure before sign-in. Claude opens its browser callback flow without a method picker or pasted-code field. Grok opens its device flow; a code, when needed, appears in a native dialog. Authorization URLs and codes never enter the web renderer.

Each provider has saved local connections and an active selection. Their labels are local bookkeeping, not verified email addresses or provider identities. Manage lets you reconnect or disconnect after confirmation. The background-use choice is saved with the credential before the first lease. Turning it off later denies new background leases immediately. A request already admitted may still finish.

Claude and Grok keep separate subscription model identifiers, so selecting one cannot fall back to that provider's API key. Their model lists come from the SDK catalog, not a live entitlement check. Connect first and explicitly choose models for the configured slots. Disconnect removes that saved native connection without deleting learning records or changing model selections. Provider-side revocation is not confirmed.

### Provider restrictions

[Anthropic does not permit third-party Claude.ai login or token intermediation](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use). The Claude SDK route is unsupported under that published restriction; the native UI does not make it approved. The xAI SDK uses an existing client registration, and permission to reuse it for LearnHarness has not been established. These experimental flows do not bypass provider rejection. Neither live sign-in was exercised for this refactor.

An earlier PR build's Claude/Grok credentials are not migrated. Reconnect once under Providers. Its unused legacy records are left untouched; disconnecting a new native connection does not remove those older records. No credentials are imported from Pi or other apps. Old Codex selections resolve to upstream ChatGPT instead of retaining a duplicate sign-in. They still need a native ChatGPT connection and a model present in its catalog.

## ChatGPT Fast mode

Standard/Fast appears beside Thinking for supported ChatGPT models. Standard is the default. Slots and role overrides have the same control; changing a default does not alter existing pinned sessions.

Fast does not change the selected model or reasoning effort. [OpenAI documents](https://developers.openai.com/codex/speed) 2.5x included-limit usage and 2x purchased-credit usage. Account and model availability still apply. The setting requests Fast; it is not evidence of the delivered tier or a measured speedup.

The request uses upstream's native ChatGPT account and private credential lease. Fast sends `service_tier: "priority"`; Standard omits the field even if a caller hook adds it. There is no API-key fallback. Automated tests use synthetic credentials and responses, not live Fast inference.

## Custom endpoints

Add a provider with a unique `custom-` identifier and its base URL. Choose the protocol exposed by that server. OpenAI Chat Completions and Responses are supported, as is Anthropic Messages. Enter exact model IDs and their capabilities; no discovery request runs automatically.

For a local CLIProxyAPI-compatible server, an example is `http://127.0.0.1:8317/v1`. Enter that proxy's dedicated client key or explicitly choose keyless. This configures the client connection; it does not install a proxy or authenticate upstream accounts.

Each key is bound to its endpoint and protocol. Changing either requires a new key or explicit keyless configuration. A blank key preserves the existing binding only when the endpoint and protocol are unchanged. A failed metadata update cannot make the new key authenticate the old endpoint. Keys are write-only and never borrowed from another provider or the environment. Shell commands and arbitrary headers are not supported.

Remote endpoints require HTTPS. HTTP is accepted for canonical loopback addresses only. URL credentials and query strings are rejected, as are fragments. Literal metadata and link-local destinations are blocked, but validation does not resolve DNS and is not a complete SSRF sandbox. Add only endpoints you trust. Requests cannot leave the configured origin or follow redirects. Ambient OpenAI organization/project identifiers are removed.

## Storage and access boundary

ChatGPT retains its upstream credential file. Claude/Grok credentials live in separate files under Electron userData's `subscription-credentials/` directory. Refresh tokens stay in main, with serialized rotation persisted before a request receives a scoped access-token lease over inherited IPC. The renderer has no lease or token method. Account changes invalidate outstanding authority.

Custom keys are stored in `connections/provider-credentials.json` under `LH_DATA_DIR`. Credentials are unencrypted at rest. New native directories are created as 0700 and files as 0600 on POSIX; ownership and symlinks are checked. Windows needs appropriate filesystem ACLs. Never include credential files in public support bundles. Native records use atomic writes; custom key updates keep the shared filesystem lock. Use one active app instance per data directory and stop all writers before recovering an abandoned lock.

Native authentication is desktop-only and has no HTTP login route. Browser-only and externally launched development servers cannot use its private IPC. Custom management stays loopback-only with matching Origin and `X-LearnHarness-Connections: 1` on mutations. Those browser-only checks are not user authentication. Do not expose the server publicly.

Subscription entries are not API bills. Custom models without configured rates are Unpriced. Optional custom rates describe picker metadata and do not price historical usage. Historical aggregation does not report subscription quota or a zero-dollar subscription charge.

## Validation boundaries

Tests use fake OAuth providers and isolated stores, with synthetic streams for request checks. They cover cancellation and account changes, including refresh rotation and background-consent races. The standalone runtime gate loads the pinned Claude/Grok OAuth modules and renders their callback page helpers without making authentication requests. These checks do not establish real account eligibility or real refresh-token behavior. Question-answer refusals use the structured `provider_key_missing` envelope so reconnect setup does not depend on error wording.

# Custom and local models

LearnHarness supports **one custom OpenAI-compatible endpoint with multiple models**.
The setup and Settings UI are based on PR #62 by Daniel Buckner and Abhishek Thakur.
Pi owns inference, message conversion, tools, streaming, and reasoning-effort handling.
For the separate external CLI provider, see [Claude Code](claude-code.md).

## Configure an endpoint

1. Open **Settings → Providers → + Add a provider → Custom endpoint**. The same
   editor is available from the first-run provider picker.
2. Enter the server's complete API base URL, for example
   `http://localhost:11434/v1`. LearnHarness does **not** append `/v1`.
3. Choose **Keyless** or **API key**:
   - **Keyless** never uses a saved or environment custom-provider key for
     authentication. Pi's OpenAI client receives an internal dummy credential.
   - **API key** uses the effective `CUSTOM_OPENAI_API_KEY`. A real environment
     value wins over a file-saved value; the editor identifies environment ownership.
     Any nonempty trimmed custom key is accepted—there is no arbitrary length floor.
   - Changing the URL requires a new effective key or explicit consent to reuse
     the existing effective key. A key is never silently forwarded to a new URL.
     Clearing authentication selects Keyless.
4. Enter optional **model IDs**, separated by commas or whitespace. This supports
   servers whose chat endpoint works but whose `/models` endpoint is absent.
5. Click **Connect**, then choose models for Strong, Cheap, and Vision.

HTTP and HTTPS, including localhost/private-network servers, are supported. URLs
with embedded credentials, query strings, or fragments are rejected. URLs are
canonicalized and trailing slashes removed before binding credentials; `/v1` is
still never appended. Put a key in the authentication field, not the URL.
Discovery redirects are rejected.

Connect requests `GET <base>/models`. Discovery metadata wins over duplicate manually
entered IDs. A nonfatal failed probe can fall back to entered IDs; a successful
fallback connect at the same URL preserves its previous model snapshot and pins.
Without entered IDs, the failed connect leaves existing configuration unchanged.
A different URL starts with its own models. **401/403 always fails**, even with
entered IDs. Response-size, model-count, and redirect violations also fail
explicitly rather than silently truncating or bypassing a discovery limit.

Configuration is not a continuous health check. An endpoint may be configured while
offline, and model capability or output quality is not proven by listing its ID.
No backend/model installation, downloads, or OAuth flows are performed.

## Model budgets and reasoning support

Settings exposes offline-editable pins per model:

- **Context budget**: user pin → reported context → **8192 fallback**.
- **Maximum output**: user pin → reported output limit → **4096 fallback**.
- **Reasoning support**: user declaration → reported support.

Every positive integer token pin is accepted, including a 512-token output limit.
Blank fields remove that pin. The editor identifies reported, fallback, and user-pin
values. **These are request/compaction budgets; changing them does not resize the
backend's actual context.** Configure the server's active context separately and
enter budgets that match it. Reconnecting prunes pins only to the resulting model
IDs; pin saves do not contact the server.

Reasoning support is a **capability declaration, not an execution toggle**. The
existing Pi-backed effort picker remains available. In particular, **Off may not
disable a custom backend's default thinking**: an absent effort parameter is not a
universal disable command. There is no compatibility/thinking-map editor, Ollama
preset, or model-name inference. Backends requiring additional nonstandard headers
or compatibility configuration are outside this release's custom-endpoint UI.

## Images and Vision

All custom models can be selected for Vision; models that report image support
appear first. The endpoint owner is responsible for choosing an appropriate model.
Built-in model filtering is unchanged.

Missing discovery metadata does not silently remove images: **every custom-engine
image-bearing request attempts delivery**, including teaching `read` results,
rendered PDF pages, and visual-maker screenshots. A request-local model clone permits
Pi's native image encoding; registered/catalog metadata is not promoted to claim
that every model understands images. A text-only backend may reject the request;
that error is surfaced, with no silent text-only fallback. This does not establish
real-model image-understanding quality.

## Credentials, reloads, and concurrent editing

Nonsecret configuration is stored in the existing `settings.json.customProvider`;
file-saved credentials use the existing `auth.json` key seam. A reserved internal
string entry, `__learnharness_custom_provider_binding`, binds authorization to the
endpoint, mode, and a random nonsecret `credentialBindingId` in custom settings.
The file key and its binding are published in one existing atomic auth-map write.
The internal entry is not an environment variable or an editable/displayed key.
Neither keys nor raw upstream errors are returned by the custom-provider API.

Every startup and upstream operation requires matching binding IDs, URL, and mode
before using credentials. A crash between auth/settings writes, or a failed
settings write whose auth rollback also fails, leaves the custom provider disabled
rather than sending a new key to an old endpoint. Reload and explicitly reconnect
to repair authorization. A shadowed file key retains its own authorized URL: if an
environment key is reused for another URL and later disappears, the old file key
is not silently forwarded there. Keyless also requires its nonsecret binding, but
never resolves a stored/environment key. Disconnect leaves an internal disabled
marker so a latent environment key cannot revive an interrupted disconnect.

Use the custom endpoint editor to change custom credentials; generic
`/api/keys` PUT/DELETE cannot bypass binding. No credential-derived fingerprint is
stored in settings or a public revision. These guards cover process crashes and
restart using the existing atomic rename; they are not a power-loss/fsync
transaction system. Missing auth storage can initialize normally; unreadable or
malformed private storage fails closed without overwriting its contents.

Each upstream model operation resolves the current custom model, endpoint, effective
credential, limits, and original saved effort preference against Pi's current model
metadata. Already-started requests keep their setup. A removed model or disconnected
provider fails rather than falling back; saved model selections and history are not
rewritten.

Edits use an opaque nonsecret ETag/If-Match revision. A stale edit returns **409** with
reload/retry guidance. A connect also checks configuration and effective credentials
after discovery, and merges only the custom section into the latest settings record,
preserving intervening unrelated edits. Failed mutations never claim success.

Desktop requests use the existing desktop capability. Browser mutations must be
same-origin JSON requests. Limits are **15 seconds** for discovery, **8 MiB** for its
response, **10,000** listed models, and **64 KiB** for configuration-write bodies.
These are protections for the new endpoint, not a multiuser authentication system.

## Pricing and previous development configuration

Custom model pricing is **unknown/unpriced**, not $0—even for an endpoint that may
be locally hosted. Pi-required internal zero-rate placeholders are not presented as
free inference. There is no rate editor in this release.

The earlier, unshipped app-data `models.json` feature is retired and is **not read**.
No user file is deleted or renamed, and there is no importer, coexistence mode,
profile reset, history rewrite, or silent model remapping. Existing development
profiles need manual endpoint configuration and model reselection. Unbound early
GUI development configurations also require explicit reconnect/new-key entry or
the existing reuse-consent checkbox, even at the same URL; they are never silently
trusted or migrated. This release supports one OpenAI-compatible custom endpoint,
not multiple arbitrary protocols. See [compaction and accounting](compaction-accounting.md)
for how context measurements and unpriced usage are displayed.

## Implementation and regression references

- [Endpoint registration and discovery](../src/server/custom-provider.ts),
  [HTTP mutations/revisions](../src/server/custom-provider-http.ts), and
  [canonical URLs and budgets](../src/core/settings.ts).
- [Private authorization resolution](../src/server/custom-provider-auth.ts),
  [durable binding contract](../src/core/custom-provider-auth.ts),
  [request-boundary tests](../tests/custom-provider-boundaries.test.ts), and
  [crash/restart tests](../tests/custom-provider-restart.test.ts).
- [Per-operation engine resolution and image allowance](../src/agent/models.ts),
  [native payload/lifecycle tests](../tests/custom-provider-lifecycle.test.ts), and
  [Vision model filtering](../components/settings/model-menu.tsx). Synthetic image payload tests
  establish delivery, not real-model image-understanding quality.
- [Editor tests](../tests/custom-provider-ui.test.tsx) and
  [connect snapshot/pin tests](../tests/custom-provider-route.test.ts).

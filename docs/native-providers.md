# Native provider modules

LearnHarness can opt in to **trusted, private native Pi providers** through
`LH_NATIVE_PROVIDER_CONFIG`. This is an operator-managed server seam, separate
from the [custom endpoint editor](custom-providers.md). It is not a browser
module editor, a plugin marketplace, or a Pi extension host.

V1 uses the full native **Pi 1.4 `Provider`** contract, not a legacy registration
callback. The module owns its models, supported protocol implementation and
request-time authentication. LearnHarness owns selection, readiness admission,
settings and conversation records. No module is loaded unless explicitly listed
in the manifest.

## Private manifest

Set `LH_NATIVE_PROVIDER_CONFIG` to an **absolute path** to a private JSON file:

```json
{
  "version": 1,
  "providers": [
    {
      "id": "example-native",
      "module": "/absolute/private/native-provider/provider.mjs",
      "export": "createLearnHarnessProvider",
      "options": { "id": "example-native" }
    }
  ]
}
```

Each entry requires a unique `id`, an absolute `module` path to compiled
`.mjs`, `.js` or `.cjs`, and the name of a **named export**. `options` is an
object passed to the factory (defaults to `{}` when omitted). The convention is
`export: "createLearnHarnessProvider"`; another named factory can be selected
explicitly. IDs use lowercase letters, digits, `.`, `_` or `-`, begin with a
letter or digit, and are at most 128 characters. The manifest is limited to
128 KiB and 64 entries.

An ID cannot replace a built-in provider, the custom endpoint provider, Claude
Code, or a subscription connection (including its underlying provider ID).
Duplicate/reserved IDs or an invalid manifest reject the entire manifest.
Provider and model `provider` IDs must match the manifest entry.

The selected export has this synchronous contract:

```ts
function createLearnHarnessProvider(options: Record<string, unknown>): {
  provider: Provider;             // full native @earendil-works/pi-ai 1.4 Provider
  isReady: () => boolean;         // synchronous, local configuration only
  pricing?: "catalog" | "unknown";
}
```

`provider` includes native auth semantics, synchronous `getModels()`, `stream()`
and `streamSimple()`. Chat models include IDs/names, supported Pi API, text input,
reasoning capability, context/output budgets and finite nonnegative Pi cost
fields. Use Pi's `createProvider()` rather than implementing a partial lookalike.
The models exposed here are chat models, not a new image/classifier editor.

**No top-level await anywhere in the module's dependency graph. No async factory.**
The loader uses native Node `require()` for CommonJS and synchronous ESM (Node
22.12+ support; the SDK itself requires Node 22.19+). A source `.ts` file or an
ESM graph requiring asynchronous evaluation is not supported. Compile private
TypeScript separately before listing its output.

Factories, module evaluation, `getModels()` and `isReady()` must not perform
network operations, start sign-in, execute credential-refresh commands or
refresh credentials. Authentication is lazy, in the provider's **per-request**
auth/stream path, with cancellation and missing-credential checks. There is no
startup entitlement probe. Modules run trusted code with the server user's
permissions; this seam is not a filesystem or credential sandbox.

## Public synthetic example

This illustrates the native shape and a supported protocol factory without any
literal credentials or private endpoints. Install compatible
`@earendil-works/pi-ai` dependencies **in the private module's own package tree**.
Use the provider owner's real model metadata when adapting it; the model below
is only an example, not a discoverable service or a claim of image support.

```js
// /absolute/private/native-provider/provider.mjs
import { createProvider, lazyApi } from "@earendil-works/pi-ai";

export function createLearnHarnessProvider(options) {
  const id = options.id;
  if (typeof id !== "string" || !id) throw new Error("Missing provider ID");
  const baseUrl = process.env.EXAMPLE_NATIVE_BASE_URL?.trim() ?? "";
  const locallyConfigured = () => Boolean(
    baseUrl && process.env.EXAMPLE_NATIVE_API_KEY?.trim()
  );

  const provider = createProvider({
    id,
    name: "Example native provider",
    baseUrl,
    auth: {
      apiKey: {
        name: "Example environment credential",
        async resolve({ signal }) {
          signal.throwIfAborted();
          const apiKey = process.env.EXAMPLE_NATIVE_API_KEY?.trim();
          if (!baseUrl || !apiKey) return undefined;
          // Request-time only. Never log or return this value to the browser.
          return { auth: { apiKey }, source: "EXAMPLE_NATIVE_API_KEY" };
        }
      }
    },
    models: [{
      id: "example-model",
      name: "Example model (replace with real metadata)",
      provider: id,
      api: "openai-completions",
      baseUrl,
      reasoning: false,
      input: ["text"],
      contextWindow: 8192,
      maxTokens: 2048,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    }],
    // Pi loads this supported protocol implementation on the first request.
    api: lazyApi(() => import("@earendil-works/pi-ai/api/openai-completions"))
  });
  return { provider, isReady: locallyConfigured, pricing: "unknown" };
}
```

The exported factory is synchronous; the auth resolver and lazy protocol import
are asynchronous **at request time**, which is supported. Secrets come from the
runtime environment or the module owner's private credential mechanism, never
literal values in the sample/manifest. Readiness checks only local configuration:
a present key or local credential file does **not** prove account entitlement,
validity, model access or upstream availability.

## Catalog, pricing and saved selections

A loaded provider has a status row. Its existing `keyPresent` field means
`isReady() === true` for this seam, not necessarily a literal API key. A false or
throwing readiness check hides its models from new selections and denies use.
A failed module/factory/validation leaves its row false while other valid entries
can load. A malformed/unreadable manifest loads no native rows. Diagnostics are
sanitized; inspect private files locally rather than printing secrets to logs.

Ready models participate in the existing Strong, Cheap and Vision slots,
conversation model selection and background role pins, with the existing model
capability/thinking rules. There is no automatic model choice or fallback to
another provider. Existing saved pins and history are preserved when a provider
fails, disappears or is not ready; unrelated slot repair does not erase an
unavailable saved pin.

Pricing defaults to **`"unknown"`**, also when omitted. Pi still requires numeric
internal model cost fields, but placeholders are not displayed as free inference:
unknown pricing is unpriced (`cost: null` in the model catalog). Use `"catalog"`
only when the provider's catalog rates are meaningful; they then feed existing
current-catalog accounting. See [compaction and accounting](compaction-accounting.md).

Configuration is **read-only and snapshotted once per server process**, when the
model collection is first used. Editing a manifest, module, export or factory
options requires a full server/app restart, including after a failed load. There
is no hot-reload retry, file migration, config write endpoint or browser editor.
A live module's local `isReady()` may change its reported status; this does not
reload the manifest or initialize credentials.

Dependencies resolve from the **private module's installed location**, not by
injecting LearnHarness's `node_modules`. Match the native Pi SDK contract and the
actual runtime's Node compatibility. LearnHarness does **not** automatically
import `~/.pi/extensions`, Pi settings, or Pi auth files; adapt any private
integration explicitly without relying on extension-host hooks or shared global
registration.

## Build and launch

The first source checkout using this seam needs a **fresh build**; an older
installed app/build will not acquire a loader by setting an environment variable.
Once the seam ships in stock desktop packages, those packages can load separately
compiled external modules at runtime without patching or rebuilding the app for
each private provider.

**Build with `LH_NATIVE_PROVIDER_CONFIG` UNSET.** `next.config.ts` refuses a
production build when it is set. Remove it from build-time environment files too;
setting an empty placeholder is not a private-module packaging strategy. Keep the
manifest, compiled private tree, credentials and its dependency installation
outside the repository and all build/release artifacts. Do not put them in
`public/`, `data/`, `.next/`, an installed app bundle or a traced source directory.
Use owner-only permissions for private configuration/credential files.

POSIX shell examples, from the source checkout:

```sh
# Build/assemble with no private manifest in the build environment.
env -u LH_NATIVE_PROVIDER_CONFIG npm run build
node scripts/build-server.mjs

# Configure any module-specific environment separately; never paste secrets
# into committed commands. npm scripts bind web/dev to loopback by default.
LH_NATIVE_PROVIDER_CONFIG=/absolute/private/native-provider/manifest.json npm run dev
LH_NATIVE_PROVIDER_CONFIG=/absolute/private/native-provider/manifest.json npm start

# Or run the assembled production payload explicitly on a private listener.
HOSTNAME=127.0.0.1 PORT=3001 \
LH_NATIVE_PROVIDER_CONFIG=/absolute/private/native-provider/manifest.json \
node .next/standalone/server.js
```

For packaged Electron, the server uses **Electron's embedded Node**, not the
system `node` binary. Compatibility with system Node alone does not prove the
module will load in desktop. The shell forwards its launch environment to its
server child; a GUI/Finder launch need not inherit your terminal environment.
Quit the running app first, then launch the app executable with the manifest and
module-specific runtime environment. For example on macOS:

```sh
LH_NATIVE_PROVIDER_CONFIG=/absolute/private/native-provider/manifest.json \
/Applications/LearnHarness.app/Contents/MacOS/LearnHarness
```

Use the corresponding installed executable on other platforms. Do not edit the
installed bundle, its `server.js`, or its bundled dependencies to inject config.
Launch-time environment is configuration, not a build input. See
[desktop release](desktop-release.md) for packaging/runtime gates and
[development](development.md) for isolated data/auth roots.

## Offline runtime gate

After the fresh production build and `scripts/build-server.mjs`, with no active
dev server, run:

```sh
node scripts/smoke-native-providers.mjs
```

This separate gate is not automatically added to packaging workflows. It creates
an external temporary synchronous `.mjs` using the standalone Pi SDK, a manifest,
empty auth and disposable settings/data. It launches the **real standalone Next
server** on `127.0.0.1` and an available port, and verifies production model and
settings routes: native module loading, ready/failed rows, unknown/catalog costs,
all model slots and role pins, and preservation of unavailable saved pins. It
checks desktop capability denial before authorized requests. Server outbound
network is blocked before Next loads; catalog/settings must never invoke provider
auth or inference. No paid model, real credentials, GUI or sign-in is involved.

The same gate runs again through the local Electron binary with
`ELECTRON_RUN_AS_NODE=1`, or prints an explicit skip if Electron is unavailable.
It audits standalone bytes for the unique temporary sentinel and private paths
(not the expected built smoke-template source), checks loopback listeners using
`lsof` where available, and removes children and temporary files in `finally`.
This proves the exercised module/runtime seam, not real provider entitlements.

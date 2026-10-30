# Amazon Bedrock

LearnHarness uses Pi's native Bedrock Converse streaming adapter. The same
provider powers teaching, practice, research, graph extraction, and visual
tasks through the existing Strong, Cheap, and Vision model slots.

## AWS profile (recommended for local development)

Configure an AWS profile with permission to invoke your chosen Bedrock models.
For an SSO profile, sign in with `aws sso login --profile YOUR_PROFILE` first.
Launch LearnHarness with the profile and region:

```bash
AWS_PROFILE=YOUR_PROFILE AWS_REGION=us-east-1 npm run dev -- --hostname 127.0.0.1
```

Alternatively, put these nonsecret values in the git-ignored `.env.local`:

```dotenv
AWS_PROFILE=YOUR_PROFILE
AWS_REGION=us-east-1
```

Use `AWS_PROFILE=default` to select the default shared AWS profile. Restart
after changing launch configuration. A packaged desktop app must inherit
these variables from its launcher; a development `.env.local` does not
configure an already installed desktop app.

A selected profile takes precedence over ambient `AWS_ACCESS_KEY_ID` and
`AWS_SECRET_ACCESS_KEY` values. An explicit per-request profile takes precedence
over the launch profile. Bedrock bearer tokens still take precedence over
profile authentication.

Open **Settings → Agent → Models**, then select Amazon Bedrock models for Strong,
Cheap, and Vision. Vision tasks need an image-capable model. Use model IDs or
inference profile IDs offered in the picker that your account can invoke in
the selected region. Many Claude models require an inference profile such as
`us.anthropic.claude-haiku-4-5-20251001-v1:0` instead of a bare foundation-model ID.
The picker labels **Inference profile** and **Direct model** entries. In the
general model picker, direct IDs with a matching profile sort after profiles;
the Vision picker retains its image-capability ordering. Nothing is silently
rerouted to a different geographic scope.

If Bedrock says “on-demand throughput isn't supported,” select the corresponding
inference profile in the **current chat's model picker**, then use **Retry**.
For example, `openai.gpt-5.6-sol` becomes `us.openai.gpt-5.6-sol` when US
cross-region inference is intended and available. Changing the global Strong
slot alone does not change an existing chat's saved model.

## Bedrock API key

Choose **Amazon Bedrock** in the first-run provider picker or under
**Settings → Providers → + Add a provider**, and paste a Bedrock API key.
It is saved through the existing local key store as `AWS_BEARER_TOKEN_BEDROCK`;
the API returns only a masked value. Save and delete take effect immediately.
A launch-environment value takes precedence over a saved value.

Credential saves and deletes refuse an unreadable or malformed existing
`auth.json`, preserving its bytes and the currently active environment values.
The app reports the failure so the file can be repaired before retrying.

Set `AWS_REGION` to the key's region before launch. Pi uses `us-east-1` when
neither a region nor an AWS profile is configured. A Bedrock bearer token takes
precedence over AWS profile/access-key authentication; remove it to switch back
to profile authentication.

## Other AWS credentials

Pi also recognizes `AWS_ACCESS_KEY_ID` with `AWS_SECRET_ACCESS_KEY` (and
`AWS_SESSION_TOKEN` for temporary credentials), ECS container credential
endpoints, and web identity credentials. Credentials remain in AWS's normal
environment/profile/role chain; LearnHarness does not copy them into settings.
The GUI edits only the Bedrock bearer token, not IAM access keys.

## Readiness and troubleshooting

Provider visibility means authentication **configuration is present**, not
that a login, permission, model subscription, or regional availability has
been verified. The picker uses Pi's shipped catalog; it is not an account-
specific list. An expired SSO session or token still needs renewal.

- `AccessDeniedException`: check model access and IAM permissions, including
  `bedrock:InvokeModelWithResponseStream`. Cross-region inference requires
  access to the inference profile and its destination models.
- Model/region validation error: choose the correct regional inference profile
  and confirm that `AWS_REGION` matches your intended source region.
- Provider absent: export `AWS_PROFILE` explicitly, supply a complete access-key
  pair, or add a Bedrock API key. Restart after environment changes.
- `LH_IGNORE_ENV_KEYS=1` intentionally hides AWS credentials and profile
  selectors for fresh-user testing; remove it for normal profile usage.

Reference: [Bedrock API keys](https://docs.aws.amazon.com/bedrock/latest/userguide/api-keys.html),
[ConverseStream](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ConverseStream.html),
and [AWS SDK credential providers](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/setting-credentials-node.html).

## Verification

Validated on macOS with Node 22.23.2 against upstream `dc4c398`:

- Credential detection is checked against Pi's native resolver, including absent
  and incomplete credentials, profiles, access keys, bearer tokens, ECS and web identity.
- Regression tests cover immediate bearer save/delete, catalog and admission
  agreement, model slots, pricing/context metadata, fresh-user isolation, and
  native tool/image request serialization.
- Additional regressions verify the credentials selected by the real AWS client
  when profiles and environment keys coexist, including missing-profile refusal,
  request overrides, and bearer precedence. Storage tests verify failed writes
  preserve damaged files and active credentials, and failed deletes remain
  visible and retryable in the UI.
- Live `us-east-1` requests through LearnHarness verified Sonnet 4.6 text
  streaming and Haiku 4.5 tool calls, tool-result continuation, and image input.
  Browser setup and a real Sonnet teaching turn also completed.
- Typecheck, lint, production build, and the standalone provider-runtime smoke
  check passed. After the review fixes, the full suite passed 2,968 of 2,970 tests. The two failures also
  reproduce on untouched upstream: a local-date expectation in
  `render-sidebar.test.tsx` and import-only package resolution in
  `subscription-auth.test.ts`.

These checks do not establish access to every catalog model, region, or AWS
authentication method. Bearer, ECS, and web-identity paths were tested offline;
live validation used an AWS profile. Packaged installers were not exercised.

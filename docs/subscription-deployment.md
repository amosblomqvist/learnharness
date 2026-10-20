# Subscription authorization deployment notes

Status: implementation draft. These notes describe the intended operating
boundary for the instance Codex subscription feature. They are not a security
review, a penetration-test report, or a claim of product acceptance.

## Legacy route and supplier permission

This feature uses the legacy `openai-codex` route at
`https://chatgpt.com/backend-api/codex/responses`, not a public third-party
Responses API permission. Supplier permission for this third-party integration
has not been established. Availability and policy support are not guaranteed.
A successful authorization or model request proves neither third-party
permission nor remaining subscription quota. Review the supplier's current
terms before enabling this route; do not present it as officially approved.

## What is protected, and what is not

The application does not provide user accounts, registration, or multi-user
authorization. The subscription HTTP routes have same-origin, Host, and
custom-header checks so that an unrelated web page cannot silently drive a
local authorization attempt. That guard is **not authentication**: anyone who
can reach the HTTP service can attempt the same requests with the right
headers. Protect the entire service, not only `/api/subscription`.

Remote access must use one of:

- a VPN or other authenticated network tunnel;
- an SSH tunnel to the server's loopback listener; or
- an authenticated HTTPS reverse proxy in front of the whole application.

Do not expose an unauthenticated public listener. This includes the Next.js
pages, `/_next` assets, event streams, learning-data assets, and every API
route. A proxy that protects only the subscription endpoints leaves learning
data and other mutations exposed.

## Files and permissions

The composition layer stores subscription material under the instance data
directory, in a dedicated `subscription` directory. The relevant names are:

- `subscription-auth.json` — the versioned credential/attempt/tombstone
  envelope. OAuth access and refresh tokens are stored here.
- `subscription-refresh-journal.json` — a non-secret refresh-operation marker
  (generation and operation ID only).
- `.subscription-auth.lock/owner.json` — the cross-process transaction lock owner record.
- `.subscription-auth.lock.acquire` — the short-lived acquisition guard; its
  existence serializes acquisition and dead-owner recovery.

The application creates the directory with mode `0700` and regular files with
mode `0600` on POSIX systems, and repairs unsafe modes on access. It rejects
symlinks and non-regular files at these paths. Keep the whole data directory
private to the account that runs the server.

The records are **plaintext at rest**. Version 1 does not encrypt them. Do not
put the data directory in a world-readable location, do not attach it to
support bundles, and exclude it from diagnostics, telemetry, crash dumps, and
ordinary backups. Filesystem snapshots and provider-side retention can still
contain old tokens.

The existing `LH_AUTH_FILE` key store is separate and keeps its existing
format and semantics. This feature does not migrate or reinterpret that file.
Do not assume that tightening one store's permissions protects the other.

### POSIX

Run the server as a single unprivileged account. Confirm that the data
directory and files are owned by that account and are not group/world
accessible. A typical installation is:

```sh
install -d -m 0700 "$LH_DATA_DIR/subscription"
chmod 0700 "$LH_DATA_DIR/subscription"
```

The application also repairs modes, but external tools, archives, or a
different process may weaken them between accesses.

### Windows

On Windows, Node's `chmod` only changes the read-only attribute; it does not
establish a private ACL. The files inherit the ACL of the parent directory.
Install the data directory under the account profile (or another directory
whose ACL is already restricted to the service account), and verify the
effective ACL with `icacls` before serving remote users.

One possible hardening pattern, to be adapted to the actual service account,
is:

```bat
icacls "%LH_DATA_DIR%\subscription" /inheritance:r /grant:r "%USERNAME%:(OI)(CI)F"
```

Do not run the service under a shared account. The Windows behavior has not
been exercised by the current automated tests; treat it as a documented
boundary and verify it on the target machine.

## One server per data directory

The lock is designed for processes on one host sharing one local data
directory. Shared network filesystems and multiple hosts serving the same data
directory are not supported. The lock owner records a host identity, process
ID, process birth identity, and a random nonce. A lock is reclaimed
automatically only when the same host can prove that the recorded process is
dead. An owner that cannot be identified or proven dead is left in place and
requests fail closed.

A separate acquisition guard serializes creation and dead-owner recovery of
that transaction lock. It is never automatically reclaimed, including when its
owner crashed. A stranded guard makes acquisition fail closed rather than risk
moving a new live lock out of the way. Stop **all** processes using this data
directory before operator recovery of either lock or guard.

Do not delete a lock or guard because it is old. Age is not evidence of death.

## Recovery after a stopped or crashed service

If the service reports a storage or lock failure, first stop the service that
uses this data directory. Check that no other process is serving the same
directory. Preserve the files for diagnosis; do not edit the credential or
journal JSON by hand.

A lock whose owner is unknown, or a stranded acquisition guard, requires
operator recovery. Only after confirming **all** processes using this directory
are stopped, move the entire affected lock or guard directory aside as one
unit, then start one service and confirm normal operation. Do not remove only
`owner.json` from a live lock, and do not run two servers against the same
directory to "clear" it. Preserve any refresh journal during lock recovery.

A refresh journal is an independent, durable safety record. If a refresh has
an uncertain outcome, the journal remains and the service must not continue as
if the stored credential were known-good. Use the product's disconnect and
re-authorize path after stopping the service; do not delete the journal to
make a reconnect state disappear. The same applies after a crash during token
rotation or credential persistence.

## HTTP surface

The settings panel uses these same-origin routes:

| Request | Purpose |
| --- | --- |
| `GET /api/subscription` | Sanitized status; no provider refresh on render. |
| `DELETE /api/subscription` | Idempotent local disconnect. |
| `POST /api/subscription/attempts` | Start with `method` set to `browser` or `device_code`; returns `202`. |
| `DELETE /api/subscription/attempts/:id` | Cancel that attempt only. |
| `POST /api/subscription/attempts/:id/input` | Submit `{ "promptId": "...", "value": "..." }` for the current manual prompt. |

Mutating requests require a matching `Origin`, `Host`, and
`X-LearnHarness-Subscription: 1` header. Without proxy configuration, `Host`
and `Origin` must match the raw authority the server receives. When an
authenticated HTTPS reverse proxy fronts the service, set
`LH_SUBSCRIPTION_ORIGIN` at process start to the browser-visible origin; it is
required for remote HTTPS deployments. The browser manual value must be a
complete `http://localhost:1455/auth/callback` or
`http://127.0.0.1:1455/auth/callback` URL with exactly one `code` and one
`state`; bare codes and error callbacks are rejected. Attempt creation is
rate-limited per service data directory (shared across route entries), and all
responses are `Cache-Control: no-store`.

## Network and proxy details

For local and desktop use without a proxy, the request guard compares the raw
`Host` header with the request URL and permits only the framework's documented
loopback normalization (`localhost`, `127.0.0.1`, and `[::1]`) on the same
port. The browser `Origin`, when present, must still match the raw `Host` and
request protocol exactly. `localhost` and `127.0.0.1` are not interchangeable
browser origins.

A reverse proxy often gives the application an internal request URL such as
`http://127.0.0.1:3000` while the browser uses a public HTTPS origin. In that
deployment, set `LH_SUBSCRIPTION_ORIGIN` to the browser-visible origin before
starting the service:

```sh
export LH_SUBSCRIPTION_ORIGIN="https://learn.example.com"
```

The value must be an `http://` or `https://` origin with no path, credentials,
query, or fragment; invalid values fail closed when the subscription handlers
initialize. When it is set, the
raw `Host` header must equal that configured origin's authority, and the browser
`Origin` must equal the complete origin whenever `Origin` is sent (mutations must send it). The request
URL may describe only the internal proxy-to-server hop, so an HTTPS public
origin behind an HTTP internal hop is supported. The service does not trust
`X-Forwarded-Host`, `X-Forwarded-Proto`, or similar browser-controlled values,
and the proxy must preserve the original `Host`.

Plain HTTP does not protect credentials or learning data. Remote access over a
non-TLS connection must use a VPN or SSH tunnel. If TLS terminates at a reverse
proxy, the proxy must protect the whole application and set the exact public
HTTPS origin; do not expose a public route that bypasses the proxy. Access logs
at the proxy and application should omit authorization headers, request
bodies, callback query strings, and token values.

## Browser and desktop behavior

The browser login uses the SDK's PKCE flow and a loopback callback listener.
The adapter pins the listener to `127.0.0.1:1455` and does not read the
process-wide callback-host override. The redirect URI remains
`http://localhost:1455/auth/callback`. If the port is unavailable, the UI must
offer the complete-callback-URL or device-code alternative; do not claim that
a listener started when it did not.

The desktop app and a browser share a subscription only when they connect to
the same server and data root. Disconnecting removes the local stored
credential; it does not revoke the session at the provider. Revoke the
provider session separately if that is required.

## Operational checklist

- [ ] The service is reachable only through the intended local, VPN, SSH, or
      authenticated HTTPS boundary.
- [ ] The whole application is behind that boundary, not just subscription
      routes.
- [ ] The data directory is owned by one service account and is not readable
      by other users.
- [ ] Backups, diagnostics, and logs exclude the subscription directory and
      callback URLs.
- [ ] A reverse proxy, if present, preserves the raw `Host` header.
- [ ] A remote HTTPS deployment sets `LH_SUBSCRIPTION_ORIGIN` to the exact
      browser-visible HTTPS origin.
- [ ] Only one server process uses the data directory.
- [ ] Operators know not to delete locks or journals based on age.
- [ ] Windows ACLs have been verified on the target machine.

## Known limits

- Windows ACL hardening is documented but not automated or exercised here.
- The routes are CSRF/same-origin guarded, not an authentication system.
- Version 1 stores tokens as plaintext files.
- Shared network filesystems and multi-host access are unsupported.
- Real provider authorization and Windows acceptance remain manual checks.

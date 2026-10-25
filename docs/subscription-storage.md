# Desktop subscription credential storage

Desktop ChatGPT, GitHub Copilot and Grok subscription records use Electron
`safeStorage` in the main process. The existing private child IPC and account
lease boundaries are unchanged. This restores the encrypted-envelope approach
previously used by ChatGPT before commit `24d1dda`, shared by the three stores.
It does not introduce another authentication flow or import other apps' tokens.

The entire validated record is encrypted, including refresh/ID tokens and saved
account metadata. A small versioned JSON envelope holds the ciphertext. The
encrypted payload includes the provider identity so a record from another
subscription store cannot be accepted under the wrong provider. File names and
profile locations are unchanged.

## Existing files and recovery

On the first successful read of an existing plaintext subscription file, the
store validates the record, encrypts it, fsyncs a new restrictive temporary file
and atomically replaces the original. It returns credentials only after this
conversion succeeds. It creates no plaintext backup. A failure before replacement
preserves the original bytes and refuses the connection; corrupt records are not
rewritten. A failure after replacement may leave the encrypted file committed
while reporting a storage failure. Resolve access/backend problems and reopen
the app; do not delete credentials or sign in again as the first recovery step.

The encrypted format is not readable by older plaintext-only app versions.
Do not automatically downgrade a profile to such a version or export decrypted
tokens as a rollback mechanism. Disconnect while the protected app is working if
the user deliberately wants to forget a connection before changing versions.
Do not remove unrelated learning data or API keys.

If OS encryption is unavailable, or Linux selects `basic_text`/an undetermined
backend, subscription storage fails closed. No plaintext fallback or keyring
override is enabled. Admission checks also refuse new native-provider logins and
credential leases after observed backend loss; existing failure/epoch handling
invalidates the connection. Background consent and provider/model choice are not
changed by storage conversion.

## Scope and limits

- Server-side API keys in `auth.json` are **not** changed by this patch. This
  addresses the subscription-token part of issue #97, not the entire request.
- Encryption reduces exposure from readable/copied application files. Windows
  DPAPI does not isolate credentials from every other process running as the same
  user. This is not a remote-disclosure finding or a full endpoint-compromise fix.
- POSIX mode checks are not a claim about Windows DACLs. The encrypted envelope
  and existing restrictive atomic-file writes are complementary protections.
- The repository pins Electron44. The patch uses its existing synchronous
  safeStorage API without changing dependencies. A future Electron upgrade should
  evaluate the asynchronous API and key-rotation handling separately.
- Native keyring availability and signed macOS application continuity require
  platform/release verification. Synthetic crypto doubles test the store/lifecycle
  contract; they do not establish native OS key-store behavior or a real account
  grant, token refresh, inference or provider-side revocation.

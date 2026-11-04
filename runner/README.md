# Sandbox runner (Tier 2)

Executes compiled / long-tail languages for the `code_playground` lesson card.
**Optional service.** LearnHarness works without it — languages with no engine
degrade to edit + highlight + "send to teacher".

## Why this exists

The browser can host JS/TS (native), Python (Pyodide) and SQL (PGlite). It
cannot host a C/C++/Rust/C#/Go/Java toolchain without shipping hundreds of MB of
WASM. So those languages are compiled and run here, on the host, under a
per-execution sandbox.

## Non-negotiable properties

| Property | Why |
|---|---|
| Binds `127.0.0.1:3212` only | The only caller is the LearnHarness server on the same host. Never expose it through the reverse proxy. |
| `x-lh-runner-token` required | Prevents any other local process (or an SSRF in the app) from running code. Token lives in `/etc/learnharness-runner/token` (0600). |
| Language allowlist | Only entries in `languages.json`. No command is built from request text. |
| Code delivered via stdin heredoc with a random delimiter | A crafted payload cannot break out of the quoting into shell. |
| One throwaway systemd unit per execution | `DynamicUser`, `PrivateNetwork`, `ProtectSystem=strict`, `ProtectHome`, `PrivateTmp`, `NoNewPrivileges`, empty `CapabilityBoundingSet`, `MemoryMax=1G`, `TasksMax=128`, `CPUQuota=200%`, `RuntimeMaxSec`, `RestrictAddressFamilies=AF_UNIX AF_NETLINK`. |
| No network inside the sandbox | `PrivateNetwork=yes` removes every interface except loopback, and address families forbid INET anyway. |
| Separate compile/run timeouts | Compilers are the expensive step (`compileSec`), programs are cheap (`runSec`); both are `timeout(1)`-enforced inside the unit and the unit itself is capped. |

## Threat model — read before changing anything

The runner process runs as **root** because `systemd-run` needs it. The payload
does not: it is a `DynamicUser` unit with no capabilities and no writable paths
outside its own tmpfs. Therefore:

- A bug in **user code** is contained by the sandbox (caps, namespaces, limits).
- A bug in **this file** is root. Keep it small, keep the allowlist closed, and
  never interpolate request data into a command.
- Sandboxing shares the host kernel. That is acceptable for a single-owner
  instance where the code is the owner's own or the teacher's. If untrusted
  third parties ever execute code here, move the runner to a disposable VM
  (this host has no `/dev/kvm`, so that means a second machine).

## Install

```bash
sudo install -d -m 700 /etc/learnharness-runner
head -c 32 /dev/urandom | base64 > /etc/learnharness-runner/token
chmod 600 /etc/learnharness-runner/token
sudo cp runner/learnharness-runner.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now learnharness-runner
curl -s localhost:3212/health | jq
```

Then point the app at it: `LH_RUNNER_URL=http://127.0.0.1:3212` and
`LH_RUNNER_TOKEN_FILE=/etc/learnharness-runner/token`. With either unset, the
card falls back to the browser engines and says so.

## Adding a language

1. Add the package to the host (`apt install …` or the SDK's installer).
2. Add an entry to `languages.json` (`file`, optional `compile`, `run`, `version`, `limits`).
3. Prove it with `curl /execute` — a hello-world **and** a deliberate compile error (the
   error text must reach the learner, not a generic failure).
4. Only then is the language advertised by `/health`.

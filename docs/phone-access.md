# Phone access

Use LearnHarness on your iPhone through the desktop app on your computer.
The phone sees the same sessions, knowledge graph and settings, because it
uses the computer's own server: nothing is copied or synced, and there is no
second server to keep in step. Keep LearnHarness open on the computer while
you use it on the phone.

For a server that runs without the desktop app (Docker, a home server), see
[self-hosting.md](self-hosting.md) instead.

## Pair a phone

1. On the computer: **Settings → Phone access**, turn it on. A QR code and
   the computer's addresses appear.
2. On the iPhone, **scan the QR code** with the Camera app or with **Scan QR
   Code** in the LearnHarness app.

The phone and the computer must be on the same network. The phone stays
paired until you revoke it: **Settings → Phone access → Paired phones →
Revoke** on the computer, or **Settings → Unpair This iPhone** on the phone.

If the computer's address changes (a new DHCP lease, another Wi-Fi), the
phone finds it again over Bonjour by its certificate and reconnects.

## How it works

The desktop app runs a small HTTPS **gateway** on port 4399
(`electron/phone-access.cjs`). It is not another learning server: every
request from a paired phone is forwarded to the app's own server on
`127.0.0.1`, with the desktop capability the gateway holds. The phone never
sees that capability.

- **Encryption and identity.** The gateway uses a self-signed P-256
  certificate created once per computer (`phone-access-cert.cjs`). The
  iPhone app does not trust it through a certificate authority; it pins the
  certificate's SHA-256 fingerprint, for its own requests and for its web
  views. A different certificate is refused, even on the same address.
- **QR pairing.** The code is a `learnharness://pair?…` link carrying the
  computer's addresses, the full fingerprint and a one-time 128-bit code
  that expires after 5 minutes. The fingerprint reaches the phone through
  the camera, which an attacker on the network cannot alter.
- **QR only.** There is no pairing over the network without the code: the
  QR code is the one channel an attacker on the network can't touch, and
  pairing needs someone at the computer anyway.
- **Finding the computer again.** The computer advertises itself over
  Bonjour (`_learnharness._tcp`) with a 16-hex-digit prefix of its
  fingerprint and no secrets. A paired phone uses it only to find its own
  computer after an address change, and still checks the full pinned
  fingerprint before sending anything. On macOS the app registers through
  the system's Bonjour service (`/usr/bin/dns-sd`); elsewhere it uses
  `bonjour-service`.
- **Device tokens.** Each phone gets a random 256-bit token, kept in the
  iPhone's Keychain (this device only). The computer stores only its
  SHA-256 hash, with the phone's name and last use, in
  `<user data>/phone-access/devices.json` (mode 0600). Tokens do not
  expire; revoking deletes the hash and closes that phone's open
  connections at once.
- **Forwarding rules.** The gateway refuses unpaired requests before they
  reach the app, refuses cross-site requests, and strips anything a phone
  could use to impersonate the desktop (`Authorization`, the device cookie,
  `X-Forwarded-*`, `X-LearnHarness-*`, hop-by-hop headers). The pairing
  endpoint is rate limited per network address.
- **Off by default.** Nothing listens on the network until Phone access is
  turned on. The choice is remembered, and the gateway then starts with the
  app. If port 4399 is taken, Settings says so; the port is not changed
  silently, because paired phones look for it there.

Phone access is available when the desktop app runs its own server (or the
development server); it is off while the app is connected to a self-hosted
server.

## Files

| Path | Contents |
| --- | --- |
| `<user data>/phone-access/state.json` | Whether Phone access is on |
| `<user data>/phone-access/devices.json` | Paired phones: id, name, token hash, dates |
| `<user data>/phone-access/identity/key.pem` | The gateway's private key (0600) |
| `<user data>/phone-access/identity/cert.pem` | The gateway's certificate |

`<user data>` is `~/Library/Application Support/LearnHarness` on macOS.
Deleting the `identity` folder makes a new certificate: every phone must
pair again. These files are outside the learning-data folder, so backing up
`data/` does not include them.

## Limits

- Same network only. Away from home, use Tailscale on both devices: the
  computer's Tailscale address is listed with the others and works the
  same way.
- The computer must be awake with LearnHarness open.
- The iPhone app is the supported client. A browser can't pin the
  certificate, so the gateway is not meant for Safari.

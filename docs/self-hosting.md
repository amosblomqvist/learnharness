# Self-hosting with Docker

LearnHarness publishes a container image to `ghcr.io/amosblomqvist/learnharness`. The container serves the same web app the desktop shell embeds, with Chromium bundled for rendering visual explanations. It is intended for a home server on a trusted network, not as a multi-user internet service.

## Requirements

- Docker Engine with the Compose plugin, on a linux/amd64 host
- A provider API key or a custom OpenAI-compatible endpoint (see [Getting started](getting-started.md))

## Quickstart

```bash
mkdir learnharness && cd learnharness
curl -O https://raw.githubusercontent.com/amosblomqvist/learnharness/main/docker-compose.yml
docker compose up -d
```

Open `http://<server-ip>:3000` and add keys under **Settings → Providers**. Keys are stored in the `lh-config` volume as `/config/auth.json` and take effect without a restart.

With plain Docker:

```bash
docker run -d --name learnharness \
  -p 3000:3000 \
  -v learnharness-data:/data \
  -v learnharness-config:/config \
  --restart unless-stopped \
  ghcr.io/amosblomqvist/learnharness:latest
```

The image is published on every push to `main`: `latest` tracks `main`, `sha-<commit>` pins an exact build, and `vX.Y.Z` matches a release tag. Pin a tag in `image:` for reproducible updates. If the GHCR package is private, log in first with a token that has `read:packages`: `docker login ghcr.io`.

## Where your data lives

| Volume | Container path | Contents |
| --- | --- | --- |
| `lh-data` | `/data` | Learning data: sessions, knowledge graph, plugin data |
| `lh-config` | `/config` | Credentials: `auth.json` and provider connection files |

The container runs as the non-root `node` user. Named volumes work without further setup. If you bind-mount host directories instead, they must be writable by UID 1000 (`chown 1000:1000 <dir>`), or the server cannot persist sessions and keys.

## Reaching it from other machines

Browsing by IP address or `localhost` works out of the box. A DNS name is refused by the DNS-rebinding protection unless you allow it explicitly:

```yaml
    environment:
      LH_ALLOWED_HOSTS: learn.lan
```

Names are comma-separated, case-insensitive, and port-agnostic.

## Security

The web app has no login. Anyone who can reach the port can use the app, spend your provider keys, and read your learning data. Keep it on a trusted LAN, behind a VPN (Tailscale, WireGuard), or behind a reverse proxy with authentication. Do not port-forward the container to the internet.

Features that depend on the desktop shell are not available in the container: subscription connections and the locally installed [Claude Code](claude-code.md) CLI. Provider API keys and [custom OpenAI-compatible endpoints](custom-providers.md) work, including a local model server reachable from the container network.

## Updates

```bash
docker compose pull
docker compose up -d
```

Your data stays in the volumes across upgrades.

## Backups

Both volumes hold everything worth keeping. With the container running:

```bash
docker run --rm \
  --volumes-from "$(docker compose ps -q learnharness)" \
  -v "$(pwd)":/backup alpine \
  tar czf /backup/learnharness-$(date +%F).tar.gz /data /config
```

Restore into fresh volumes by reversing the copy: run the same container with `tar xzf /backup/<file> -C /` after populating `/backup`.

## Troubleshooting

- **Port already in use** — publish on another host port: `"3100:3000"`.
- **Health status** — the image self-reports with a probe of the server port; check `docker compose ps` or `docker inspect --format '{{.State.Health.Status}}' learnharness`.
- **Permission denied with bind mounts** — see UID 1000 note above.
- **`This host name is not allowed`** — add the name to `LH_ALLOWED_HOSTS`.
- **Logs** — `docker compose logs -f learnharness`.

# codex-dispatcher

Phone-friendly Codex UI served from the Codex VS Code extension webview. The dispatcher runs on the laptop, connects to the local `codex app-server`, and prints a URL that can be opened from a phone.

## Quick start

Install without Bun:

```bash
curl -fsSL https://raw.githubusercontent.com/toolittlecakes/codex-dispatcher/main/scripts/install.sh | sh
codex-dispatcher doctor
codex-dispatcher
```

The installer currently ships a macOS arm64 binary. It installs to `~/.local/bin` by default; set `CODEX_DISPATCHER_INSTALL_DIR` to choose another directory.

From this checkout:

```bash
bun run doctor
bun run start
```

To build a standalone binary:

```bash
bun run build:binary
./dist/codex-dispatcher doctor
./dist/codex-dispatcher
```

The compiled binary does not require Bun at runtime.

To install the command locally from this checkout:

```bash
bun link
codex-dispatcher doctor
codex-dispatcher
```

From an installed package:

```bash
codex-dispatcher doctor
codex-dispatcher
```

The launcher prints:

```text
Phone: https://<tunnel>.trycloudflare.com/extension-spike/?token=<token>
```

Open that URL on the phone. The first request uses the token to set an HttpOnly session cookie scoped to `/extension-spike`; the browser URL is then scrubbed.

## Requirements

- Codex CLI or Codex.app with `Contents/Resources/codex`
- VS Code Codex extension webview assets
- `cloudflared` for remote phone access

Bun is required only when running from source or building the binary. It is not required for the direct install path above.

If the VS Code Codex extension is missing, `codex-dispatcher` tries to install `openai.chatgpt` through the `code` CLI. If `code` is unavailable, set `CODEX_EXTENSION_WEBVIEW_ROOT` to the extension `webview` directory.

For local-only development:

```bash
codex-dispatcher --no-tunnel
```

## Relay mode

Cloudflare quick tunnels are useful for experiments, but they create a new URL on every restart. Relay mode is the path for a stable PWA URL.

Run a relay service:

```bash
GITHUB_CLIENT_ID=... \
GITHUB_CLIENT_SECRET=... \
RELAY_PUBLIC_BASE_URL=https://codex-dispatcher.app \
RELAY_DATA_PATH=/var/lib/codex-dispatcher/relay-state.json \
bun run dev:relay
```

For stable per-user URLs, point the root domain and wildcard subdomains at the relay host:

```text
A @ 23.94.86.204
A * 23.94.86.204
```

The TLS proxy must enable on-demand certificates for `*.codex-dispatcher.app` and use the relay ask endpoint.
The Caddy snippets are versioned in this repo under `deploy/caddy/`.

Import the global options snippet from the host Caddyfile global block:

```caddyfile
{
    email you@example.com
    import /home/sne/projects/codex-dispatcher-relay/deploy/caddy/global-options.caddy
}
```

Import the site blocks outside the global block:

```caddyfile
import /home/sne/projects/codex-dispatcher-relay/deploy/caddy/sites.caddy
```

Log in the CLI once:

```bash
CODEX_DISPATCHER_RELAY_URL=https://codex-dispatcher.app codex-dispatcher login
```

Start the dispatcher through the relay:

```bash
codex-dispatcher --relay
```

Only one dispatcher can be active per GitHub user. To replace an existing active dispatcher non-interactively:

```bash
codex-dispatcher --relay --kill-existing
```

The relay stores GitHub users, browser sessions, and CLI devices in `RELAY_DATA_PATH`. Active dispatcher sockets are not persisted; after a relay restart, run `codex-dispatcher --relay` again.

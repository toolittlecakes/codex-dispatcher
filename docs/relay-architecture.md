# Relay architecture

The relay is the production remote-access path for `codex-dispatcher`.
Cloudflare quick tunnels stay useful for local experiments, but they are not the main path because every restart creates a new URL.

## Main path

1. The user runs `codex-dispatcher login`.
2. The CLI uses GitHub OAuth device flow and receives a GitHub access token.
3. The CLI sends that token to the relay.
4. The relay validates the token with GitHub, upserts the user by GitHub numeric id, and returns:
   - relay user id,
   - public slug,
   - device id,
   - relay token,
   - stable URL.
5. The CLI stores relay state in `~/.codex-dispatcher/config.json`.
6. The user runs `codex-dispatcher`.
7. The CLI opens one dispatcher session to the relay.
8. Browser/PWA users log in with GitHub web OAuth on the relay.
9. The relay routes browser traffic for that GitHub user to that user's active dispatcher.
10. The CLI keeps the relay WebSocket alive with heartbeat frames and reconnects automatically after transient disconnects.

## Stable URL

The stable URL is owned by the relay, not by the laptop:

```text
https://<slug>.codex-dispatcher.app/
```

`slug` defaults to the GitHub login. Security is not based on the slug; the slug is only routing/UI. The stable identity is the GitHub numeric user id.

DNS points both the root domain and wildcard subdomains at the relay host:

```text
A @ 23.94.86.204
A * 23.94.86.204
```

The TLS proxy uses Caddy on-demand TLS for `*.codex-dispatcher.app`.
Caddy calls `GET /api/tls/ask?domain=<hostname>` before issuing a certificate.
The relay returns 2xx only for the root domain or an existing one-label user slug; unknown or nested subdomains fail closed.

The codex-dispatcher Caddy config is repo-owned:

```text
deploy/caddy/global-options.caddy
deploy/caddy/sites.caddy
```

The VPS host Caddyfile imports those snippets, so existing host-level sites stay in the host Caddyfile while codex-dispatcher routing lives with the relay code.

## Single dispatcher rule

One relay user can have at most one active dispatcher.

If a second dispatcher connects without takeover, the relay rejects it with:

```json
{
  "code": "dispatcher.already_active"
}
```

Interactive CLI behavior:

```text
Another dispatcher is already active for @sne.
Kill it and continue? [y/N]
```

Non-interactive CLI behavior:

```bash
codex-dispatcher --kill-existing
```

When `--kill-existing` is set, the relay closes the previous dispatcher session and accepts the new one.

## Explicit failure outcomes

- No relay config: `codex-dispatcher` tells the user to run `codex-dispatcher login`.
- Relay rejects GitHub token: login fails visibly; no config is written.
- Dispatcher already active: start fails unless the user confirms or passes `--kill-existing`.
- Browser user is not logged in: relay redirects to GitHub OAuth.
- Browser user has no active dispatcher: relay shows a visible "dispatcher offline" page.
- Relay-to-dispatcher HTTP proxy exceeds the explicit timeout: relay returns `504`, not an unhandled server error.
- Browser closes a streamed response while dispatcher chunks are still in flight: relay drops the late chunks instead of crashing.

## Environment

Relay server:

```text
GITHUB_CLIENT_ID
GITHUB_CLIENT_SECRET
RELAY_PUBLIC_BASE_URL=https://codex-dispatcher.app
RELAY_DATA_PATH=/var/lib/codex-dispatcher/relay-state.json
```

The relay stores users, browser sessions, and CLI devices in `RELAY_DATA_PATH`.
Active dispatcher WebSocket sessions are intentionally not persisted. A running CLI reconnects automatically after relay/network restarts; if the laptop process is not running, the browser sees the explicit dispatcher-offline state.

Relay HTTP server timeout is deliberately longer than the proxy timeout:

```text
HTTP idle timeout: 60 seconds
dispatcher proxy timeout: 30 seconds
```

This keeps slow app-server requests under dispatcher control and avoids Bun's default 10-second HTTP idle timeout turning valid but slow host messages into generic `502` responses.

CLI:

```text
CODEX_DISPATCHER_RELAY_URL=https://codex-dispatcher.app
```

## GitHub OAuth

The CLI uses GitHub OAuth device flow. Per GitHub docs, the device flow uses `client_id`, `device_code`, and the device-code grant type; `client_secret` is not needed for device flow.

The browser login uses GitHub web application flow with PKCE and a server-side `client_secret`.

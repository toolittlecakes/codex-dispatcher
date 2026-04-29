# Remote Access

## Production path: owned relay

The production remote-access path is the owned relay at `codex-dispatcher.app`.

```bash
CODEX_DISPATCHER_RELAY_URL=https://codex-dispatcher.app codex-dispatcher login
codex-dispatcher --relay --kill-existing
```

The phone/PWA URL is stable per GitHub user:

```text
https://<slug>.codex-dispatcher.app/
```

The slug defaults to the GitHub login. It is a routing label, not the security boundary. The durable identity is the GitHub numeric user id returned by GitHub OAuth.

The relay path is:

1. The laptop runs `codex-dispatcher --relay`.
2. The CLI opens one outbound WebSocket to the relay.
3. The browser logs in to the relay through GitHub web OAuth.
4. The relay matches the browser GitHub user to that user's active dispatcher.
5. HTTP and event-stream traffic is proxied to the laptop dispatcher over the outbound WebSocket.

The relay never stores conversation contents. It persists only GitHub users, browser sessions, and CLI device tokens.

## Reliability behavior

The CLI sends heartbeat frames every 20 seconds. If the relay WebSocket closes after it has been accepted, the CLI reconnects with exponential backoff up to 30 seconds.

Reconnects after an accepted session use takeover semantics. That means the relay closes any stale active dispatcher session for the same user and accepts the reconnecting CLI. This avoids a dead socket blocking the user's stable URL.

Relay HTTP timeout decisions:

- HTTP idle timeout is 60 seconds.
- Dispatcher proxy timeout is 30 seconds.
- Late dispatcher response chunks for browser-canceled streams are ignored.

These choices keep slow app-server requests as explicit relay failures instead of generic `502` crashes or Bun's default 10-second idle timeout.

## Failure states

- Browser is not logged in: redirect to GitHub OAuth.
- User has no active dispatcher: show `Dispatcher is offline.`
- Another dispatcher is already active: reject the new dispatcher unless takeover is explicit.
- Relay request to local dispatcher exceeds timeout: return `504`.

No fallback relay is selected silently. The active remote path must be visible in CLI logs and UI.

## Experimental path: Cloudflare quick tunnel

Cloudflare quick tunnels are still useful for local experiments because they do not require relay setup, but they create a new URL on every restart and are not the PWA path.

```bash
codex-dispatcher
```

The launcher starts `cloudflared tunnel --url http://localhost:<port>` and prints:

```text
Phone: https://<tunnel>.trycloudflare.com/?token=<token>
```

The first request uses the URL token to set an HttpOnly `codex_dispatcher_session` cookie. After that, the extension host endpoints use the cookie and the browser URL is scrubbed with `history.replaceState`.

For local-only development:

```bash
codex-dispatcher --no-tunnel
```

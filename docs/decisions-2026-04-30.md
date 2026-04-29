# Decisions: 2026-04-30

This log records the product and architecture decisions made while turning the dispatcher spike into the usable remote Codex-on-phone path.

## Keep the Codex extension UI

We will keep serving the Codex VS Code extension webview instead of cloning the UI.

The dispatcher owns the host adapter around that webview:

- VS Code-specific APIs are shimmed at the webview boundary.
- Codex app-server and IPC calls are bridged from the laptop.
- UI parity work stays focused on host behavior, viewport behavior, and extension contract compatibility.

## Use root path as the product surface

The old `/extension-spike` route was a spike artifact. The product surface is `/`.

This matters for the stable PWA URL: users should save `https://<slug>.codex-dispatcher.app/`, not an implementation-specific spike path.

## Stable URL comes from the owned relay

Cloudflare quick tunnels remain an experiment path, but not the product path. They rotate URLs on restart, which breaks a saved phone/PWA shortcut.

The main path is:

```text
phone browser/PWA -> relay -> outbound WebSocket -> laptop dispatcher -> local Codex app-server
```

The relay owns stable per-user URLs:

```text
https://<slug>.codex-dispatcher.app/
```

## GitHub is the identity boundary

User identity is GitHub OAuth, not a locally generated username.

- CLI login uses GitHub device flow.
- Browser login uses GitHub web OAuth with PKCE.
- Relay users are keyed by GitHub numeric id.
- The public slug defaults to the GitHub login and is only a routing label.

This lets a user log in once, save the PWA URL, and keep using the same URL across dispatcher restarts.

## One active dispatcher per user

One GitHub user can have at most one active dispatcher.

If a user starts another dispatcher, the relay rejects it unless takeover is explicit. The CLI supports non-interactive takeover:

```bash
codex-dispatcher --relay --kill-existing
```

Accepted reconnects also use takeover semantics so stale sockets do not block the user's stable URL.

## Relay deployment is repo-owned but host-integrated

The relay runs on `racknerd-2`, but the Caddy snippets for this project live in the repository under `deploy/caddy/`.

The host Caddyfile imports those snippets. This keeps codex-dispatcher routing versioned with the app while still allowing the VPS to keep unrelated host-level Caddy config outside this repo.

## No VS Code process is required in the final path

The final path does not depend on a running VS Code window. The dispatcher reuses the installed Codex extension webview assets and talks to Codex through `codex app-server` plus the local Codex/extension IPC bridge.

When the same thread is open in native Codex/VS Code and the phone dispatcher, ownership matters:

- native Codex/VS Code can own a thread;
- the phone dispatcher can act as follower;
- follower requests and thread stream state are routed through the local IPC bridge.

This is what makes messages sent from the phone synchronize back to the native Codex surface.

## Viewport must not scale

Mobile browser chrome and keyboard changes must not zoom the UI.

The dispatcher pins effective zoom to `1`, disables text-size adjustment, and uses VisualViewport geometry only to translate the fixed app surface when the keyboard changes the visible viewport.

Keyboard overlap is handled by viewport offset, not by responsive scaling of the extension UI.

## Relay reliability contract

The relay connection is expected to survive common network and service restarts:

- CLI sends heartbeat frames every 20 seconds.
- CLI reconnects after accepted relay WebSocket disconnects.
- Reconnect delay backs off from 1 second up to 30 seconds.
- Relay HTTP idle timeout is 60 seconds.
- Dispatcher proxy timeout is 30 seconds and returns `504`.
- Late chunks from canceled browser streams are ignored.
- Browser-canceled proxied requests are propagated to the CLI and abort the matching local fetch.
- New `/events` clients receive replayed `thread-stream-state-changed` snapshots for current mirrored threads, so reconnecting browsers do not stay behind after missing live patches.

The explicit failure state remains visible: if the laptop dispatcher process is not running, the relay returns `Dispatcher is offline.`

## No hidden fallback path

The dispatcher should fail visibly instead of silently switching paths.

Cloudflare quick tunnel, owned relay, and local-only mode are explicit modes. If the selected mode fails, the CLI or relay should surface that failure directly.

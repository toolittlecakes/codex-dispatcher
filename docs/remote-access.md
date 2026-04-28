# Remote Access

## Current path: Cloudflare quick tunnel

From an installed package, run:

```bash
codex-dispatcher
```

For a local install from this checkout:

```bash
bun link
codex-dispatcher
```

From this checkout, run:

```bash
bun run doctor
bun run start
```

To build and run without requiring Bun at runtime:

```bash
bun run build:binary
./dist/codex-dispatcher doctor
./dist/codex-dispatcher
```

The launcher finds the installed Codex VS Code extension webview. If it is missing, it runs `code --install-extension openai.chatgpt` and then verifies that the webview assets exist. It starts `cloudflared tunnel --url http://localhost:<port>`, waits for the `trycloudflare.com` URL, then starts the dispatcher with that URL in its runtime status.

The primary URL is the extension webview surface:

```text
Phone: https://<tunnel>.trycloudflare.com/extension-spike/?token=<token>
```

The first request uses the URL token to set an HttpOnly `codex_dispatcher_session` cookie scoped to `/extension-spike`. After that, the extension host endpoints use the cookie and the browser URL is scrubbed with `history.replaceState`.

The dispatcher also has the legacy local/PWA surface at `/`, but the phone-Codex path should use `/extension-spike/`.

For local-only development:

```bash
codex-dispatcher --no-tunnel
```

The UI shows whether it is using a Cloudflare tunnel or only local/LAN access, the token fingerprint, and the number of active browser sessions.

Access is gated by the dispatcher token in the URL. Use **Rotate token** in the UI if the link was exposed; rotation invalidates new connections with the old token, while already-open WebSocket sessions remain visible until they disconnect.

## Later path: owned relay

The relay should replace Cloudflare as a small authenticated rendezvous service:

- laptop dispatcher keeps one outbound WebSocket to the relay;
- phone connects to the relay with the same short-lived dispatcher token or a device-bound session token;
- relay forwards encrypted dispatcher traffic and never stores conversation contents;
- dispatcher UI keeps the same security surface: remote URL, token/session state, and active session visibility.

Do not add fallback relays silently. The active remote path should be explicit in the UI and logs.

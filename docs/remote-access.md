# Remote Access

## Current path: Cloudflare quick tunnel

Run:

```bash
bun run dev:tunnel
```

The wrapper starts `cloudflared tunnel --url http://localhost:8787`, waits for the `trycloudflare.com` URL, then starts the dispatcher with that URL in its runtime status. The UI shows whether it is using a Cloudflare tunnel or only local/LAN access, the token fingerprint, and the number of active browser sessions.

Access is gated by the dispatcher token in the URL. Use **Rotate token** in the UI if the link was exposed; rotation invalidates new connections with the old token, while already-open WebSocket sessions remain visible until they disconnect.

## Later path: owned relay

The relay should replace Cloudflare as a small authenticated rendezvous service:

- laptop dispatcher keeps one outbound WebSocket to the relay;
- phone connects to the relay with the same short-lived dispatcher token or a device-bound session token;
- relay forwards encrypted dispatcher traffic and never stores conversation contents;
- dispatcher UI keeps the same security surface: remote URL, token/session state, and active session visibility.

Do not add fallback relays silently. The active remote path should be explicit in the UI and logs.

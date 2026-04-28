# codex-dispatcher

Phone-friendly Codex UI served from the Codex VS Code extension webview. The dispatcher runs on the laptop, connects to the local `codex app-server`, and prints a URL that can be opened from a phone.

## Quick start

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

Bun is required when running from source or building the binary. It is not required to run a compiled `codex-dispatcher` binary.

If the VS Code Codex extension is missing, `codex-dispatcher` tries to install `openai.chatgpt` through the `code` CLI. If `code` is unavailable, set `CODEX_EXTENSION_WEBVIEW_ROOT` to the extension `webview` directory.

For local-only development:

```bash
codex-dispatcher --no-tunnel
```

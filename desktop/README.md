# Codex Dispatcher desktop (tray app)

A Tauri v2 menu-bar app that supervises `codex-dispatcher serve` as a bundled sidecar. No windows: the UI is the web page the dispatcher already serves; the tray only starts, restarts, and links to it.

## What it does

- Spawns the sidecar with `--relay --kill-existing` when `~/.codex-dispatcher/config.json` holds a relay login, plain LAN serve otherwise.
- Reads `~/.codex-dispatcher/runtime.json` (written by serve) for the local and phone URLs — menu items "Open in Browser" and "Copy Phone Link".
- "Log in to Relay…" runs the sidecar `login`, opens the GitHub device page, copies the code to the clipboard, and restarts serve through the relay on success.
- On sidecar exit: status shows the exit code, a notification points at `~/.codex-dispatcher/tray.log` (all sidecar output lands there), and "Restart" respawns it. No automatic restarts.
- "Start at Login" toggles a LaunchAgent (tauri-plugin-autostart).
- Quit sends the cli SIGTERM so it takes the dispatcher down with it; a SIGKILLed cli is also covered — the server watches its stdin pipe for parent death.

## Build

```sh
cd desktop
bun install
TAURI_SIGNING_PRIVATE_KEY="$HOME/.tauri/codex-dispatcher-updater.key" \
TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" \
bun run build   # compiles the sidecar from ../src/cli.ts, then bundles the .app
```

The bundle lands in `src-tauri/target/release/bundle/macos/Codex Dispatcher.app` (plus a .dmg and the updater's .app.tar.gz + .sig). The signing key pair is the tauri updater's (minisign): the private key lives outside the repo and in the `TAURI_SIGNING_PRIVATE_KEY` Actions secret, the public key sits in `tauri.conf.json`. Losing the private key means shipped apps can never update again.

## Releases and updates

Bumping the version (package.json + desktop/package.json + Cargo.toml + tauri.conf.json, kept equal) and pushing to main runs `.github/workflows/release.yml`: when no release for that version exists yet, it runs the tests, builds the bundle, tags `vX.Y.Z`, and publishes a GitHub release with the .dmg (first install), the updater archive + `latest.json` (the tray checks `releases/latest/download/latest.json` on launch and via "Check for Updates…"), and `codex-dispatcher-darwin-arm64` (the standalone cli, which `codex-dispatcher update` installs).

macOS-only for now: the sidecar script targets `aarch64-apple-darwin` and the bundle is unsigned by Apple (ad-hoc), so first installs hit a Gatekeeper warning until we notarize.

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
bun run build   # compiles the sidecar from ../src/cli.ts, then bundles the .app
```

The bundle lands in `src-tauri/target/release/bundle/macos/Codex Dispatcher.app`. macOS-only for now: the sidecar script targets `aarch64-apple-darwin` and the bundle is unsigned (ad-hoc), so distribution needs signing + notarization.

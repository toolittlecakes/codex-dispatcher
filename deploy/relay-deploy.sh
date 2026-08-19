#!/usr/bin/env bash
# Deploys the relay to the VPS and moves it under systemd.
# Run from the repo root: bash deploy/relay-deploy.sh [ssh-host]
set -euo pipefail

host="${1:-racknerd-2}"
remote_dir="projects/codex-dispatcher-relay"

rsync -az --delete src/ "$host:$remote_dir/src/"
rsync -az package.json bun.lock "$host:$remote_dir/"
rsync -az deploy/caddy/ "$host:$remote_dir/deploy/caddy/"

ssh "$host" bash -s <<'REMOTE'
set -euo pipefail

# The relay's secrets live only in the environment of whatever started it.
# Capture them into an EnvironmentFile once, from the still-running process.
env_file=~/.config/codex-dispatcher-relay.env
if [ ! -f "$env_file" ]; then
  pid=$(pgrep -f "bun run src/relay-server.ts" | head -1)
  if [ -z "$pid" ]; then
    echo "No running relay to capture the environment from, and $env_file does not exist." >&2
    exit 1
  fi
  mkdir -p ~/.config
  tr '\0' '\n' < "/proc/$pid/environ" | grep -E '^(PORT|HOST|RELAY_|GITHUB_)' > "$env_file"
  chmod 600 "$env_file"
fi

sudo tee /etc/systemd/system/codex-dispatcher-relay.service > /dev/null <<'UNIT'
[Unit]
Description=codex-dispatcher relay
After=network-online.target
Wants=network-online.target

[Service]
User=sne
WorkingDirectory=/home/sne/projects/codex-dispatcher-relay
EnvironmentFile=/home/sne/.config/codex-dispatcher-relay.env
ExecStart=/home/sne/.bun/bin/bun run src/relay-server.ts
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
UNIT

sudo systemctl daemon-reload
# A hand-started relay from before systemd would hold the port; a systemd one
# must be restarted through systemd or it races its own auto-restart.
if ! systemctl is-active --quiet codex-dispatcher-relay; then
  pkill -f "bun run src/relay-server.ts" || true
fi
sudo systemctl enable codex-dispatcher-relay
sudo systemctl restart codex-dispatcher-relay
sleep 1
sudo systemctl --no-pager --lines 5 status codex-dispatcher-relay
REMOTE

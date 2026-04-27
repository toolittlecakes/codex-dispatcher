# Codex Dispatcher Tasks

Goal: make the dispatcher behave like the VS Code Codex extension for shared sessions, while keeping the mobile/PWA surface lighter.

## 1. IPC state mirror - done

- Treat `thread-stream-state-changed` snapshots and patches as the primary live state source.
- Keep a local conversation-state cache keyed by conversation id.
- Render selected owner sessions from the mirrored state instead of waiting for app-server polling.
- Keep polling only as explicit refresh/read behavior, not as the live update path.
- Validation: Desktop/VS Code text deltas and turn state show in dispatcher during the same turn.

## 2. IPC approval and elicitation forwarding - done

- Parse owner conversation requests from mirrored state.
- Render command, file, permission, user-input, and MCP elicitation requests for follower sessions.
- Send decisions through the matching `thread-follower-*` IPC methods.
- Validation: an approval requested in VS Code/Desktop can be accepted or denied from dispatcher.

## 3. Dispatcher owner mode - done

- Respond to IPC discovery when dispatcher owns a conversation.
- Handle follower start, steer, interrupt, approvals, compact, settings, and queued follow-up requests.
- Broadcast dispatcher-owned stream snapshots/patches so VS Code/Desktop can follow it.
- Validation: a session started in dispatcher can be continued from VS Code/Desktop.

## 4. Extension-like chat rendering - done

- Render assistant markdown, reasoning, plans, tools, command output, diffs, file changes, images, and errors with compact mobile layouts.
- Preserve scroll behavior and streaming updates without layout jumps.
- Validation: common turn item types are readable on desktop and phone viewport sizes.

## 5. Extension-like composer and controls

- Add model/reasoning/collaboration controls, compact, edit-last-user-turn, attachments, and queued follow-ups.
- Keep controls discoverable on mobile without copying VS Code chrome weight.
- Validation: parity-critical extension actions have dispatcher equivalents.

## 6. Tunnel and security hardening

- Make Cloudflare tunnel startup/status explicit in the UI.
- Add token rotation/session visibility and safer remote-access defaults.
- Document the later relay path separately from the current Cloudflare path.
- Validation: phone access works from another network with visible connection/security state.

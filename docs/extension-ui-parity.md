# Codex Extension UI Parity Notes

Source inspected: `~/.vscode/extensions/openai.chatgpt-26.422.62136-darwin-arm64/webview/assets`.

## Message Actions

- User messages are a right-aligned grouped block: `group flex w-full flex-col items-end justify-end gap-1`.
- The user bubble uses `bg-token-foreground/5`, `max-w-[77%]`, `break-words`, `rounded-2xl`, and compact horizontal padding.
- User message actions sit below the bubble in `flex flex-row-reverse items-center gap-1`.
- User action controls are hidden by default with `opacity-0` and become visible on `group-hover` and `group-focus-within`.
- User actions are Copy plus Edit. Edit is conditional; it is only rendered when the message can be edited.
- Assistant actions use a separate row: `mt-3 flex h-5 items-center justify-start gap-0.5`.
- Assistant actions include Copy, rating, and Fork in the full extension. This dispatcher keeps Copy and Fork, and omits rating.
- Assistant timestamp is the part that fades in on hover; the action row itself remains present.

## Composer

- The extension has a distinct `composer-footer` container with responsive label hiding via container queries.
- The footer is below the composer input surface. It is not inside the bordered textarea/card surface.
- Local mode is labeled `Work locally`; remote mode is labeled `Remote`.
- The follow-up placeholder in local mode is `Ask for follow-up changes`.
- The `IDE context` indicator is a footer/inline control near reasoning, separated by a vertical divider.
- Extension mode maps the surface to `editor-background` and `editor-foreground`; only menus and top trays use translucent color-mix backgrounds.

## Chat Stream

- Conversation block spacing is tokenized with `--conversation-block-gap: 12px` and `--conversation-tool-assistant-gap: 16px`.
- Intermediate work is summarized with terse labels: `Thinking`, `Working for ...`, `Worked for ...`, `Ran ...`, `Searched web`, and `Explored ...`.
- Detail-heavy tool output is collapsed under compact accordions by default.
- Content should be clipped by the bottom composer area. Text may scroll behind the dock visually, but the dock surface must be opaque so it does not show through.

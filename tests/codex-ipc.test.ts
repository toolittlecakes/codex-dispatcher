import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexIpcBridge, type IpcBroadcastMessage } from "../src/codex-ipc";

type Collected = { method: string; params: unknown }[];

async function connectedBridge(socketPath: string, collected: Collected): Promise<CodexIpcBridge> {
  const bridge = new CodexIpcBridge(socketPath);
  bridge.onEvent((event) => {
    if (event.type === "broadcast" && event.broadcast.method !== "client-status-changed") {
      collected.push({ method: event.broadcast.method, params: event.broadcast.params });
    }
  });
  await bridge.start("test-client");
  return bridge;
}

async function waitForClientId(bridge: CodexIpcBridge): Promise<string> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const clientId = bridge.getSnapshot().clientId;
    if (clientId) {
      return clientId;
    }
    await Bun.sleep(10);
  }
  throw new Error("bridge never registered with the router");
}

describe("codex ipc", () => {
  test("delivers an addressed broadcast to the addressed client only", async () => {
    const root = mkdtempSync(join(tmpdir(), "codex-ipc-target-"));
    const socketPath = join(root, "ipc.sock");
    const addressedMessages: Collected = [];
    const bystanderMessages: Collected = [];

    const sender = await connectedBridge(socketPath, []);
    const addressed = await connectedBridge(socketPath, addressedMessages);
    const bystander = await connectedBridge(socketPath, bystanderMessages);

    try {
      const addressedId = await waitForClientId(addressed);
      await waitForClientId(bystander);

      expect(
        sender.broadcast("thread-stream-state-changed", { conversationId: "thread-1" }, {
          targetClientIds: [addressedId],
        }),
      ).toBe(true);
      // An owner with no followers must put nothing on the wire at all.
      expect(sender.broadcast("thread-stream-state-changed", { conversationId: "thread-2" }, {
        targetClientIds: [],
      })).toBe(false);
      sender.broadcast("thread-stream-following-status-requested", { conversationId: "thread-3" });

      const deadline = Date.now() + 2_000;
      while (bystanderMessages.length === 0 && Date.now() < deadline) {
        await Bun.sleep(10);
      }

      expect(addressedMessages.map((message) => message.method)).toEqual([
        "thread-stream-state-changed",
        "thread-stream-following-status-requested",
      ]);
      // The bystander sees only what was sent to everyone.
      expect(bystanderMessages).toEqual([
        { method: "thread-stream-following-status-requested", params: { conversationId: "thread-3" } },
      ]);
    } finally {
      sender.stop();
      addressed.stop();
      bystander.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("ignores an addressed broadcast that names someone else", async () => {
    const root = mkdtempSync(join(tmpdir(), "codex-ipc-ignore-"));
    const socketPath = join(root, "ipc.sock");
    const received: Collected = [];

    const bridge = await connectedBridge(socketPath, received);
    try {
      const clientId = await waitForClientId(bridge);
      const message: IpcBroadcastMessage = {
        type: "broadcast",
        method: "thread-stream-state-changed",
        sourceClientId: "someone-else",
        params: { conversationId: "thread-1" },
        targetClientIds: [`${clientId}-other`],
      };

      // Straight into the client's own handler: a router that does not filter
      // must not turn into a client that acts on other people's mail.
      (bridge as unknown as { handleBroadcast(message: IpcBroadcastMessage): void }).handleBroadcast(message);

      expect(received).toEqual([]);
    } finally {
      bridge.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname } from "node:path";
import { Socket } from "node:net";
import { join } from "node:path";
import { CodexIpcBridge, ipcMethodVersion, type IpcBroadcastMessage } from "../src/codex-ipc";
import { selectExtensionWebviewRoot } from "../src/extension-webview";

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

type RawMessage = {
  type: string;
  method?: string;
  requestId?: string;
  resultType?: string;
  error?: string;
  timeoutMs?: number;
  request?: { method?: string; timeoutMs?: number };
};

type RawIpcClient = {
  waitForBroadcasts(expected: number, timeoutMs?: number): Promise<{ method: string }[]>;
  waitForMessage(match: (message: RawMessage) => boolean, timeoutMs?: number): Promise<RawMessage>;
  send(message: unknown): void;
  close(): void;
};

async function rawIpcClient(socketPath: string): Promise<RawIpcClient> {
  const socket = new Socket();
  const broadcasts: { method: string }[] = [];
  const messages: RawMessage[] = [];
  let pending = Buffer.alloc(0);

  const writeMessage = (message: unknown): void => {
    const payload = JSON.stringify(message);
    const frame = Buffer.alloc(4 + Buffer.byteLength(payload, "utf8"));
    frame.writeUInt32LE(Buffer.byteLength(payload, "utf8"), 0);
    frame.write(payload, 4, "utf8");
    socket.write(frame);
  };

  socket.on("data", (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 4) {
      const size = pending.readUInt32LE(0);
      if (pending.length < 4 + size) {
        return;
      }
      const message = JSON.parse(pending.subarray(4, 4 + size).toString("utf8")) as RawMessage;
      pending = pending.subarray(4 + size);
      messages.push(message);
      if (message.type === "broadcast" && message.method && message.method !== "client-status-changed") {
        broadcasts.push({ method: message.method });
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    socket.on("error", reject);
    socket.connect(socketPath, () => resolve());
  });

  writeMessage({
    type: "request",
    requestId: "raw-1",
    method: "initialize",
    params: { clientType: "raw-test-client" },
  });

  return {
    async waitForBroadcasts(expected, timeoutMs = 1_000) {
      const deadline = Date.now() + timeoutMs;
      while (broadcasts.length < expected && Date.now() < deadline) {
        await Bun.sleep(10);
      }
      // Give a wrongly forwarded frame time to show up after the expected one.
      await Bun.sleep(50);
      return broadcasts;
    },
    async waitForMessage(match, timeoutMs = 1_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const found = messages.find(match);
        if (found) {
          return found;
        }
        await Bun.sleep(10);
      }
      throw new Error("the expected frame never arrived");
    },
    send: writeMessage,
    close: () => socket.destroy(),
  };
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
      await waitForClientId(sender);

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

  test("keeps an addressed broadcast off the wire of every other client", async () => {
    const root = mkdtempSync(join(tmpdir(), "codex-ipc-router-"));
    const socketPath = join(root, "ipc.sock");

    const sender = await connectedBridge(socketPath, []);
    // A raw client, not a CodexIpcBridge: the router has to do the filtering
    // itself, and a bridge would hide a leaky router behind its own check.
    const bystander = await rawIpcClient(socketPath);
    const addressed = await connectedBridge(socketPath, []);

    try {
      const addressedId = await waitForClientId(addressed);
      await waitForClientId(sender);

      sender.broadcast("thread-stream-state-changed", { conversationId: "thread-1" }, {
        targetClientIds: [addressedId],
      });
      sender.broadcast("thread-stream-following-status-requested", { conversationId: "thread-2" });

      const seen = await bystander.waitForBroadcasts(1);
      expect(seen.map((message) => message.method)).toEqual(["thread-stream-following-status-requested"]);
    } finally {
      bystander.close();
      sender.stop();
      addressed.stop();
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

  // Loading a long thread's history is a five-minute call. The router runs its
  // own timer over every forwarded request, so a deadline that stays in the
  // caller's process is a deadline the router overrules.
  test("carries the caller's deadline to the client that has to answer", async () => {
    const root = mkdtempSync(join(tmpdir(), "codex-ipc-deadline-"));
    const socketPath = join(root, "ipc.sock");

    const sender = await connectedBridge(socketPath, []);
    const peer = await rawIpcClient(socketPath);
    try {
      await waitForClientId(sender);
      // Nothing answers it; the frame on the wire is the whole point.
      sender
        .request("thread-follower-load-complete-history", { conversationId: "thread-1" }, { timeoutMs: 300_000 })
        .catch(() => {});

      const asked = await peer.waitForMessage((message) => message.type === "client-discovery-request");
      expect(asked.request?.method).toBe("thread-follower-load-complete-history");
      expect(asked.request?.timeoutMs).toBe(300_000);
    } finally {
      peer.close();
      sender.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("times a forwarded request out on the deadline the caller sent", async () => {
    const root = mkdtempSync(join(tmpdir(), "codex-ipc-router-deadline-"));
    const socketPath = join(root, "ipc.sock");

    const target = await connectedBridge(socketPath, []);
    const caller = await rawIpcClient(socketPath);
    try {
      const targetId = await waitForClientId(target);
      target.addRequestHandler("thread-follower-start-turn", () => true, () => new Promise<never>(() => {}));

      caller.send({
        type: "request",
        requestId: "raw-slow-1",
        method: "thread-follower-start-turn",
        params: { conversationId: "thread-1" },
        targetClientId: targetId,
        version: ipcMethodVersion("thread-follower-start-turn"),
        timeoutMs: 60,
      });

      // Well inside the router's own 10s default: the answer can only be this
      // early if the router used the deadline that came in on the wire.
      const response = await caller.waitForMessage(
        (message) => message.type === "response" && message.requestId === "raw-slow-1",
        2_000,
      );
      expect(response.resultType).toBe("error");
      expect(response.error).toBe("request-timeout");
    } finally {
      caller.close();
      target.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });

  // The one check that catches drift: every peer silently drops a broadcast or
  // request whose version is not the one it expects, so these numbers are only
  // ever right relative to the extension we are hosting.
  test("carries the method versions of the extension it hosts", () => {
    const webviewRoot = selectExtensionWebviewRoot(join(homedir(), ".vscode", "extensions"));
    if (!webviewRoot) {
      throw new Error("Install the Codex VS Code extension: this bridge is defined against its wire contract");
    }

    const bundle = readFileSync(join(dirname(webviewRoot), "out", "extension.js"), "utf8");
    const table = /\{"thread-stream-state-changed":\d+[^}]*\}/.exec(bundle);
    expect(table).not.toBeNull();

    for (const [method, version] of Object.entries(JSON.parse(table![0]) as Record<string, number>)) {
      expect([method, ipcMethodVersion(method)]).toEqual([method, version]);
    }
  });
});

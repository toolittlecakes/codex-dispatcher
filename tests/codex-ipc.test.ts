import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { Socket } from "node:net";
import { dirname, join } from "node:path";
import {
  CodexIpcBridge,
  codexIpcEndpoint,
  ipcMethodVersion,
  legacyCodexIpcSocketPath,
  type CodexIpcEvent,
  type IpcBroadcastMessage,
} from "../src/codex-ipc";
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

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (condition()) {
      return;
    }
    await Bun.sleep(10);
  }
  throw new Error("condition never held");
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
  waitForClose(timeoutMs?: number): Promise<boolean>;
  waitForBroadcasts(expected: number, timeoutMs?: number): Promise<{ method: string }[]>;
  waitForMessage(match: (message: RawMessage) => boolean, timeoutMs?: number): Promise<RawMessage>;
  send(message: unknown): void;
  close(): void;
};

async function rawIpcClient(socketPath: string): Promise<RawIpcClient> {
  const socket = new Socket();
  let closed = false;
  socket.on("close", () => {
    closed = true;
  });
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
    async waitForClose(timeoutMs = 5_000) {
      const deadline = Date.now() + timeoutMs;
      while (!closed && Date.now() < deadline) {
        await Bun.sleep(25);
      }
      return closed;
    },
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

  // Which socket we pick is not a detail: the extension resolves its endpoint
  // in a fixed order, and a dispatcher that picks differently ends up alone on
  // a bus of one — connected, healthy-looking and talking to nobody.
  describe("endpoint resolution", () => {
    async function withCodexHome(run: (home: string, legacyRoot: string) => Promise<void>): Promise<void> {
      const home = mkdtempSync(join(tmpdir(), "codex-home-"));
      const legacyRoot = mkdtempSync(join(tmpdir(), "codex-legacy-"));
      const previousHome = process.env.CODEX_HOME;
      const previousTmp = process.env.TMPDIR;
      process.env.CODEX_HOME = home;
      process.env.TMPDIR = legacyRoot;
      try {
        await run(home, legacyRoot);
      } finally {
        if (previousHome === undefined) {
          delete process.env.CODEX_HOME;
        } else {
          process.env.CODEX_HOME = previousHome;
        }
        if (previousTmp === undefined) {
          delete process.env.TMPDIR;
        } else {
          process.env.TMPDIR = previousTmp;
        }
        rmSync(home, { recursive: true, force: true });
        rmSync(legacyRoot, { recursive: true, force: true });
      }
    }

    test("hosts the bus where the extension looks for it", async () => {
      await withCodexHome(async (home) => {
        const bridge = new CodexIpcBridge();
        try {
          await bridge.start();
          expect(bridge.socketPath).toBe(join(home, "ipc", "ipc.sock"));
          expect(existsSync(bridge.socketPath)).toBe(true);
        } finally {
          bridge.stop();
        }
      });
    });

    test("joins the bus already hosted there instead of starting a second one", async () => {
      await withCodexHome(async (home) => {
        const host = new CodexIpcBridge();
        const guest = new CodexIpcBridge();
        try {
          await host.start("host-client");
          const hosted = statSync(join(home, "ipc", "ipc.sock")).ino;
          await guest.start("guest-client");
          expect(guest.socketPath).toBe(join(home, "ipc", "ipc.sock"));
          // Joining means leaving the socket alone: replacing it would put the
          // host on a bus of one, with no way back until it restarts.
          expect(statSync(guest.socketPath).ino).toBe(hosted);
          const guestId = await waitForClientId(guest);
          await waitFor(() => host.getSnapshot().peers.some((peer) => peer.clientId === guestId));
        } finally {
          guest.stop();
          host.stop();
        }
      });
    });

    // A socket in a directory anyone can write is a socket anyone can replace,
    // so the extension refuses it — and a dispatcher that takes it anyway ends
    // up on a bus the extension is not on.
    test("refuses a legacy socket whose directory is open to everyone", async () => {
      await withCodexHome(async (home) => {
        const legacyPath = legacyCodexIpcSocketPath();
        mkdirSync(dirname(legacyPath), { recursive: true });
        chmodSync(dirname(legacyPath), 0o777);
        const legacyHost = new CodexIpcBridge(legacyPath);
        const bridge = new CodexIpcBridge();
        try {
          await legacyHost.start("legacy-host");
          await bridge.start();
          expect(bridge.socketPath).toBe(join(home, "ipc", "ipc.sock"));
        } finally {
          bridge.stop();
          legacyHost.stop();
        }
      });
    });

    test("locks the socket it hosts to the user that hosts it", async () => {
      await withCodexHome(async () => {
        const bridge = new CodexIpcBridge();
        try {
          await bridge.start();
          expect(statSync(bridge.socketPath).mode & 0o777).toBe(0o600);
        } finally {
          bridge.stop();
        }
      });
    });

    // The extension still joins a live socket at the old location, so leaving it
    // for the newer one would split the two of us across two buses.
    test("falls in behind whoever is on the endpoint the extension used before", async () => {
      await withCodexHome(async () => {
        const legacyPath = legacyCodexIpcSocketPath();
        mkdirSync(dirname(legacyPath), { recursive: true });
        const legacyHost = new CodexIpcBridge(legacyPath);
        const bridge = new CodexIpcBridge();
        try {
          await legacyHost.start("legacy-host");
          await bridge.start();
          expect(bridge.socketPath).toBe(legacyPath);
          expect(existsSync(codexIpcEndpoint())).toBe(false);
        } finally {
          bridge.stop();
          legacyHost.stop();
        }
      });
    });

    // The extension removes whatever sits at the endpoint the moment its probe
    // misses it (`Fye`), and it can only ever host once: `routerStarted` is a
    // latch it never resets. So our socket file does get replaced under us, and
    // sitting on the orphan is invisible — we keep answering ourselves while
    // every VS Code window is on the other bus.
    test("rejoins the bus after its socket file is replaced under it", async () => {
      await withCodexHome(async (home) => {
        const socketPath = join(home, "ipc", "ipc.sock");
        const received: Collected = [];
        const started = Date.now();
        // The CI-only failures of this test come with an inconsistent peer map,
        // so a failure has to explain itself with the event order, not just the
        // final state.
        const timeline: string[] = [];
        const trace = (name: string, bridge: CodexIpcBridge) => {
          bridge.onEvent((event) => {
            const detail = event.type === "broadcast" ? event.broadcast.method : event.snapshot.status;
            const peers = event.snapshot.peers.map((peer) => peer.clientType).join(",");
            timeline.push(`+${Date.now() - started}ms ${name} ${event.type}:${detail} peers=[${peers}]`);
          });
        };
        const strandedReceived: Collected = [];
        const collect = (into: Collected) => (event: CodexIpcEvent) => {
          if (event.type === "broadcast" && event.broadcast.method !== "client-status-changed") {
            into.push({ method: event.broadcast.method, params: event.broadcast.params });
          }
        };
        const orphaned = new CodexIpcBridge();
        orphaned.onEvent(collect(received));
        const stranded = new CodexIpcBridge();
        stranded.onEvent(collect(strandedReceived));
        const usurper = new CodexIpcBridge();
        trace("orphaned", orphaned);
        trace("stranded", stranded);
        trace("usurper", usurper);
        let extensionLike: RawIpcClient | null = null;
        try {
          await orphaned.start("orphaned-client");
          await stranded.start("stranded-client");
          // The extension reconnects when its socket closes and never otherwise,
          // so walking away from the router without hanging up strands it for
          // good — it cannot even host a replacement (`routerStarted`).
          extensionLike = await rawIpcClient(socketPath);
          unlinkSync(socketPath);
          await usurper.start("usurper-client");

          // What rejoin promises is convergence: everyone ends up on one bus
          // and traffic flows again. Which bridge hosts it after the shuffle is
          // an election detail — a loaded machine (CI) can go through a second
          // election before settling, and the timeline showed exactly that. So
          // the check is a broadcast from the usurper reaching both stranded
          // clients, resent until the bus has knit itself back together.
          const delivered = () =>
            received.some((message) => message.method === "thread-read-state-changed") &&
            strandedReceived.some((message) => message.method === "thread-read-state-changed");
          const deadline = Date.now() + 25_000;
          while (!delivered() && Date.now() < deadline) {
            usurper.broadcast("thread-read-state-changed", { threadId: "t-1" });
            await Bun.sleep(250);
          }
          if (!delivered()) {
            const describe = (name: string, bridge: CodexIpcBridge) => `${name}: status=${bridge.getSnapshot().status}`;
            throw new Error(
              "rejoin never completed — "
              + [describe("usurper", usurper), describe("orphaned", orphaned), describe("stranded", stranded)].join("; ")
              + "\n" + timeline.join("\n"),
            );
          }

          expect(await extensionLike.waitForClose()).toBe(true);
        } finally {
          extensionLike?.close();
          usurper.stop();
          stranded.stop();
          orphaned.stop();
        }
      });
    }, 40_000);
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

  // A caller that gave up must stop being owed an answer: the webview cancels a
  // fetch and the wait on the bus behind it has to end with it, not when the
  // owner eventually replies.
  test("gives up on a request whose caller cancelled it", async () => {
    const root = mkdtempSync(join(tmpdir(), "codex-ipc-cancel-"));
    const socketPath = join(root, "ipc.sock");

    const sender = await connectedBridge(socketPath, []);
    const peer = await rawIpcClient(socketPath);
    try {
      await waitForClientId(sender);
      const cancel = new AbortController();
      // Nothing answers it, and the deadline is far enough away that only the
      // cancel can end this.
      const pending = sender.request(
        "thread-follower-load-complete-history",
        { conversationId: "thread-1" },
        { timeoutMs: 300_000, signal: cancel.signal },
      );

      await peer.waitForMessage((message) => message.type === "client-discovery-request");
      cancel.abort();
      await expect(pending).rejects.toThrow("cancelled");
    } finally {
      peer.close();
      sender.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });

  // The one check that catches drift: every peer silently drops a broadcast or
  // request whose version is not the one it expects, so these numbers are only
  // ever right relative to the extension we are hosting.
  test("carries the method versions of the extension it hosts", () => {
    // No VS Code at all (CI, standalone installs) means no host bundle to
    // check drift against; VS Code without the extension is still a dev
    // machine that has to install it.
    if (!existsSync(join(homedir(), ".vscode", "extensions"))) {
      return;
    }
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

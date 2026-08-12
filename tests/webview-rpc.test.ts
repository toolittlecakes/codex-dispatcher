import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RpcSession, RpcTarget } from "capnweb";
import { ExtensionWebview } from "../src/extension-webview";
import { ipcMethodVersion } from "../src/codex-ipc";
import type { JsonValue } from "../src/codex-app-server";
import type { IpcRequestOutcome, WebviewIpcCoordination } from "../src/webview-rpc";

type Broadcast = { method: string; params: JsonValue; targetClientIds: string[] | undefined };
type CoordinationCall = { method: string; payload: unknown };

// Stands in for the webview's own coordination service (class `hye` in the
// extension's webview bundle): the host calls into it on every IPC broadcast.
class ViewCoordination extends RpcTarget {
  readonly calls: CoordinationCall[] = [];

  threadStreamStateChanged(payload: unknown): void {
    this.calls.push({ method: "threadStreamStateChanged", payload });
  }

  threadStreamFollowingStatusRequested(payload: unknown): void {
    this.calls.push({ method: "threadStreamFollowingStatusRequested", payload });
  }
}

class ViewMain extends RpcTarget {
  constructor(private readonly coordination: ViewCoordination) {
    super();
  }

  get services(): { clientCoordination: ViewCoordination } {
    return { clientCoordination: this.coordination };
  }
}

type HostClientCoordination = {
  threadStreamFollowingChanged(payload: { params: JsonValue; targetClientIds?: string[] }): Promise<void>;
  requestThreadFollower(payload: {
    request: { method: string; params: JsonValue };
    targetClientId?: string;
  }): Promise<IpcRequestOutcome>;
};

const cookie = "codex_dispatcher_webview=secret";

async function post(webview: ExtensionWebview, clientId: string, message: unknown): Promise<void> {
  const response = await webview.fetch(
    new Request("http://localhost/host-message", {
      method: "POST",
      headers: { cookie, "x-dispatcher-client": clientId },
      body: JSON.stringify({ messages: [message] }),
    }),
    new URL("http://localhost/host-message"),
  );
  const body = (await response.json()) as { accepted: boolean; error?: string };
  if (!body.accepted) {
    throw new Error(`host rejected message: ${body.error ?? "unknown"}`);
  }
}

// A real capnweb client on the far end of the real SSE + POST pipe: the whole
// point of the session is that the shipped webview can talk to it, so a fake
// transport here would prove nothing.
async function connectWebviewRpc(webview: ExtensionWebview, clientId: string, sessionId: string) {
  const target = `http://localhost/events?client=${clientId}`;
  const response = await webview.fetch(
    new Request(target, { headers: { cookie } }),
    new URL(target),
  );
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const inbound: string[] = [];
  let waiting: ((message: string) => void) | null = null;

  const pump = (async () => {
    let pending = "";
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        return;
      }
      pending += decoder.decode(chunk.value);
      const frames = pending.split("\n\n");
      pending = frames.pop() ?? "";
      for (const frame of frames) {
        const data = frame.split("\n").find((line) => line.startsWith("data: "));
        if (!data) {
          continue;
        }
        const message = JSON.parse(data.slice(6)) as { type?: string; message?: string };
        if (message.type !== "vscode-capn-rpc-message" || typeof message.message !== "string") {
          continue;
        }
        if (waiting) {
          const resolve = waiting;
          waiting = null;
          resolve(message.message);
          continue;
        }
        inbound.push(message.message);
      }
    }
  })();

  await post(webview, clientId, { type: "vscode-capn-rpc-connect", sessionId });

  // POSTs are the wire here, so they have to leave in the order capnweb wrote
  // them: an out-of-order frame would abort the session.
  let sending: Promise<void> = Promise.resolve();
  const transport = {
    send(message: string): void {
      sending = sending.then(() => post(webview, clientId, { type: "vscode-capn-rpc-message", sessionId, message }));
    },
    receive(): Promise<string> {
      const next = inbound.shift();
      return next === undefined
        ? new Promise<string>((resolve) => {
            waiting = resolve;
          })
        : Promise.resolve(next);
    },
  };

  const coordination = new ViewCoordination();
  const session = new RpcSession<{ services: { clientCoordination: HostClientCoordination } }>(
    transport,
    new ViewMain(coordination),
  );

  return {
    coordination,
    host: session.getRemoteMain().services.clientCoordination,
    async close(): Promise<void> {
      await reader.cancel();
      await pump;
    },
  };
}

describe("webview rpc session", () => {
  test("carries IPC coordination both ways over one capnweb session", async () => {
    const previousRoot = process.env.CODEX_EXTENSION_WEBVIEW_ROOT;
    const root = mkdtempSync(join(tmpdir(), "codex-webview-rpc-"));
    process.env.CODEX_EXTENSION_WEBVIEW_ROOT = root;
    writeFileSync(join(root, "index.html"), "<html><head></head><body></body></html>");

    const broadcasts: Broadcast[] = [];
    const requests: { method: string; params: JsonValue; targetClientId: string | undefined }[] = [];
    const ipcCoordination: WebviewIpcCoordination = {
      broadcast: (method, params, targetClientIds) => {
        broadcasts.push({ method, params, targetClientIds });
      },
      request: async (method, params, targetClientId) => {
        requests.push({ method, params, targetClientId });
        return { resultType: "success", method, result: { ok: true } };
      },
      ideContext: () => null,
    };

    try {
      const webview = new ExtensionWebview({
        appServer: {} as never,
        defaultCwd: "/repo",
        getToken: () => "secret",
        statePath: join(root, "extension-state.json"),
        ipcCoordination,
      });

      const client = await connectWebviewRpc(webview, "tab-1", "session-1");

      await client.host.threadStreamFollowingChanged({
        params: { conversationId: "thread-1", hostId: "local", following: true },
        targetClientIds: ["vscode-client"],
      });
      expect(broadcasts).toEqual([
        {
          method: "thread-stream-following-changed",
          params: { conversationId: "thread-1", hostId: "local", following: true },
          targetClientIds: ["vscode-client"],
        },
      ]);

      const outcome = await client.host.requestThreadFollower({
        request: { method: "thread-follower-start-turn", params: { conversationId: "thread-1" } },
        targetClientId: "vscode-client",
      });
      expect(outcome).toMatchObject({ resultType: "success", result: { ok: true } });
      expect(requests).toEqual([
        {
          method: "thread-follower-start-turn",
          params: { conversationId: "thread-1" },
          targetClientId: "vscode-client",
        },
      ]);

      webview.handleIpcBroadcast({
        type: "broadcast",
        method: "thread-stream-state-changed",
        sourceClientId: "vscode-client",
        version: ipcMethodVersion("thread-stream-state-changed"),
        params: { conversationId: "thread-1", hostId: "local" },
      });
      // A payload shaped for a protocol version we do not speak is dropped
      // rather than guessed at, exactly as the extension drops it.
      webview.handleIpcBroadcast({
        type: "broadcast",
        method: "thread-stream-following-status-requested",
        sourceClientId: "vscode-client",
        version: ipcMethodVersion("thread-stream-following-status-requested") + 1,
        params: { conversationId: "thread-1", hostId: "local" },
      });

      const deadline = Date.now() + 1_000;
      while (client.coordination.calls.length === 0 && Date.now() < deadline) {
        await Bun.sleep(10);
      }
      await Bun.sleep(50);
      expect(client.coordination.calls).toEqual([
        {
          method: "threadStreamStateChanged",
          payload: { sourceClientId: "vscode-client", params: { conversationId: "thread-1", hostId: "local" } },
        },
      ]);

      await client.close();
    } finally {
      if (previousRoot === undefined) {
        delete process.env.CODEX_EXTENSION_WEBVIEW_ROOT;
      } else {
        process.env.CODEX_EXTENSION_WEBVIEW_ROOT = previousRoot;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });
});

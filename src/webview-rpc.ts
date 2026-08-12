import { RpcSession, RpcTarget } from "capnweb";
import type { JsonObject, JsonValue } from "./codex-app-server";
import type { IpcBroadcastMessage } from "./codex-ipc";
import { ipcMethodVersion } from "./codex-ipc";
import { toError } from "./shared";

// VS Code gives each webview its own capnweb RPC session on top of the same
// postMessage pipe (`registerAppHostSessionForWebview` in the extension's
// out/extension.js): the webview posts `vscode-capn-rpc-connect` with a session
// id, both sides then trade `vscode-capn-rpc-message` frames, and the whole IPC
// surface the webview has — following a thread, driving a thread another client
// owns, cache invalidation — hangs off that session. A host that never answers
// the connect leaves the webview's `clientCoordination` undefined, and because
// every call site guards it with `?.`, all of it silently does nothing.

export type IpcRequestOutcome =
  | { resultType: "success"; method: string; result: JsonValue; handledByClientId?: string }
  | { resultType: "error"; method: string; error: string };

export type WebviewIpcCoordination = {
  broadcast(method: string, params: JsonValue, targetClientIds?: string[]): void;
  request(method: string, params: JsonValue, targetClientId?: string): Promise<IpcRequestOutcome>;
  ideContext(): JsonValue;
};

type TargetedBroadcast = { params: JsonValue; targetClientIds?: string[] };

// Named rather than an index signature: these are the calls the webview's own
// coordination service exposes (class `hye` in the webview bundle), and a typo
// here would be a call into nothing.
type WebviewClientCoordination = {
  automationCapabilityEventReceived(payload: BroadcastPayload): Promise<void>;
  automationRunTriggeredEventReceived(payload: BroadcastPayload): Promise<void>;
  clientStatusChanged(payload: BroadcastPayload): Promise<void>;
  ipcConnectionReset(payload: BroadcastPayload): Promise<void>;
  threadStreamStateChanged(payload: BroadcastPayload): Promise<void>;
  threadStreamFollowingChanged(payload: BroadcastPayload): Promise<void>;
  threadStreamFollowingStatusRequested(payload: BroadcastPayload): Promise<void>;
  threadReadStateChanged(payload: BroadcastPayload): Promise<void>;
  threadArchived(payload: BroadcastPayload): Promise<void>;
  threadUnarchived(payload: BroadcastPayload): Promise<void>;
  threadQueuedFollowUpsChanged(payload: BroadcastPayload): Promise<void>;
  appConnectOAuthCallbackReceived(payload: BroadcastPayload): Promise<void>;
  invalidateQueryCache(payload: BroadcastPayload): Promise<void>;
};

type BroadcastPayload = { sourceClientId: string; params: JsonValue };

type WebviewAppView = { services: { clientCoordination: WebviewClientCoordination } };

const webviewBroadcastMethods: Record<string, keyof WebviewClientCoordination> = {
  "automation-capability-event": "automationCapabilityEventReceived",
  "automation-run-triggered-event": "automationRunTriggeredEventReceived",
  "client-status-changed": "clientStatusChanged",
  "ipc-connection-reset": "ipcConnectionReset",
  "thread-stream-state-changed": "threadStreamStateChanged",
  "thread-stream-following-changed": "threadStreamFollowingChanged",
  "thread-stream-following-status-requested": "threadStreamFollowingStatusRequested",
  "thread-read-state-changed": "threadReadStateChanged",
  "thread-archived": "threadArchived",
  "thread-unarchived": "threadUnarchived",
  "thread-queued-followups-changed": "threadQueuedFollowUpsChanged",
  "app-connect-oauth-callback-received": "appConnectOAuthCallbackReceived",
  "query-cache-invalidate": "invalidateQueryCache",
};

// The host half of the extension's `clientCoordination` (class `Yv`): every
// method is the webview handing us something to put on the IPC wire.
class ClientCoordination extends RpcTarget {
  constructor(private readonly ipc: WebviewIpcCoordination) {
    super();
  }

  threadArchived(params: JsonValue): void {
    this.ipc.broadcast("thread-archived", params);
  }

  threadUnarchived(params: JsonValue): void {
    this.ipc.broadcast("thread-unarchived", params);
  }

  threadQueuedFollowUpsChanged(params: JsonValue): void {
    this.ipc.broadcast("thread-queued-followups-changed", params);
  }

  threadStreamStateChanged({ params, targetClientIds }: TargetedBroadcast): void {
    this.ipc.broadcast("thread-stream-state-changed", params, targetClientIds);
  }

  threadStreamFollowingChanged({ params, targetClientIds }: TargetedBroadcast): void {
    this.ipc.broadcast("thread-stream-following-changed", params, targetClientIds);
  }

  threadStreamFollowingStatusRequested(params: JsonValue): void {
    this.ipc.broadcast("thread-stream-following-status-requested", params);
  }

  threadReadStateChanged(params: JsonValue): void {
    this.ipc.broadcast("thread-read-state-changed", params);
  }

  invalidateQueryCache(params: JsonValue): void {
    this.ipc.broadcast("query-cache-invalidate", params);
  }

  getIdeContext(): JsonValue {
    return this.ipc.ideContext();
  }

  async findThreadOwner({ hostId, conversationId }: { hostId: string; conversationId: string }): Promise<string | null> {
    const response = await this.ipc.request("thread-owner-discovery", { hostId, conversationId });
    if (response.resultType === "error") {
      if (response.error === "no-client-found") {
        return null;
      }
      throw new Error(response.error);
    }

    return response.handledByClientId ?? null;
  }

  requestThreadFollower({
    request,
    targetClientId,
  }: {
    request: { method: string; params: JsonValue };
    targetClientId?: string;
  }): Promise<IpcRequestOutcome> {
    return this.ipc.request(request.method, request.params, targetClientId);
  }
}

class AppHostMain extends RpcTarget {
  readonly #services: { clientCoordination: ClientCoordination };

  constructor(ipc: WebviewIpcCoordination) {
    super();
    this.#services = { clientCoordination: new ClientCoordination(ipc) };
  }

  get services(): { clientCoordination: ClientCoordination } {
    return this.#services;
  }
}

// capnweb pulls messages one at a time; VS Code's own transport (class `YP`)
// queues what arrives before the puller asks for it, and so must this one or a
// burst of frames would be lost between reads.
class WebviewRpcTransport {
  private readonly queued: string[] = [];
  private waiting: { resolve: (message: string) => void; reject: (error: Error) => void } | null = null;
  private aborted: Error | null = null;

  constructor(private readonly deliver: (message: string) => void) {}

  send(message: string): void {
    if (this.aborted) {
      throw this.aborted;
    }
    this.deliver(message);
  }

  receive(): Promise<string> {
    const next = this.queued.shift();
    if (next !== undefined) {
      return Promise.resolve(next);
    }
    if (this.aborted) {
      return Promise.reject(this.aborted);
    }

    return new Promise((resolve, reject) => {
      this.waiting = { resolve, reject };
    });
  }

  abort(reason: unknown): void {
    if (this.aborted) {
      return;
    }
    this.aborted = toError(reason);
    this.waiting?.reject(this.aborted);
    this.waiting = null;
  }

  accept(message: string): void {
    if (this.aborted) {
      return;
    }
    if (this.waiting) {
      const waiting = this.waiting;
      this.waiting = null;
      waiting.resolve(message);
      return;
    }
    this.queued.push(message);
  }
}

export class WebviewRpcSession {
  private readonly transport: WebviewRpcTransport;
  private readonly session: RpcSession<WebviewAppView>;
  private readonly coordination: WebviewClientCoordination;

  constructor(
    readonly sessionId: string,
    ipc: WebviewIpcCoordination,
    deliver: (message: JsonObject) => void,
    private readonly onError: (error: Error) => void,
  ) {
    this.transport = new WebviewRpcTransport((message) => {
      deliver({ type: "vscode-capn-rpc-message", sessionId, message });
    });
    this.session = new RpcSession<WebviewAppView>(this.transport, new AppHostMain(ipc));
    this.coordination = this.session.getRemoteMain().services.clientCoordination;
  }

  accept(message: string): void {
    this.transport.accept(message);
  }

  deliverBroadcast(broadcast: IpcBroadcastMessage): void {
    const method = webviewBroadcastMethods[broadcast.method];
    if (!method) {
      return;
    }
    // The wire carries the sender's idea of the payload shape. A version we do
    // not speak is not a message to guess at, so it is dropped here exactly as
    // the extension drops it.
    if ((broadcast.version ?? 0) !== ipcMethodVersion(broadcast.method)) {
      return;
    }

    const payload: BroadcastPayload = {
      sourceClientId: broadcast.sourceClientId,
      params: broadcast.params ?? null,
    };
    void this.coordination[method](payload).catch((error: unknown) => {
      this.onError(toError(error));
    });
  }

  dispose(): void {
    this.transport.abort(new Error("Webview RPC session disposed."));
  }
}

export function parseRpcConnect(message: JsonObject): string | null {
  return message.type === "vscode-capn-rpc-connect" && typeof message.sessionId === "string"
    ? message.sessionId
    : null;
}

export function parseRpcMessage(message: JsonObject): { sessionId: string; message: string } | null {
  if (message.type !== "vscode-capn-rpc-message") {
    return null;
  }
  if (typeof message.sessionId !== "string" || typeof message.message !== "string") {
    return null;
  }

  return { sessionId: message.sessionId, message: message.message };
}

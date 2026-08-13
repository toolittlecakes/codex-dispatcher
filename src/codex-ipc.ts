import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createServer, Socket, type Server } from "node:net";
import type { JsonObject, JsonValue } from "./codex-app-server";
import { isJsonObject, toError } from "./shared";

type IpcRequestMessage = {
  type: "request";
  requestId: string;
  sourceClientId?: string;
  targetClientId?: string;
  version?: number;
  method: string;
  params?: JsonValue;
  // The caller's deadline rides on the wire: the router runs its own timer over
  // the forwarded request, and without this it would give up long before the
  // caller does.
  timeoutMs?: number;
};

export type IpcResponseMessage = {
  type: "response";
  requestId: string;
  resultType: "success" | "error";
  method?: string;
  handledByClientId?: string;
  result?: JsonValue;
  error?: string;
};

export type IpcBroadcastMessage = {
  type: "broadcast";
  method: string;
  sourceClientId: string;
  version?: number;
  params?: JsonValue;
  // Present when the sender addressed named clients: per-conversation stream
  // state only goes to the clients that said they follow that conversation.
  targetClientIds?: string[];
};

type IpcClientDiscoveryRequestMessage = {
  type: "client-discovery-request";
  requestId: string;
  request: IpcRequestMessage;
};

type IpcClientDiscoveryResponseMessage = {
  type: "client-discovery-response";
  requestId: string;
  response: {
    canHandle: boolean;
  };
};

type IpcMessage =
  | IpcRequestMessage
  | IpcResponseMessage
  | IpcBroadcastMessage
  | IpcClientDiscoveryRequestMessage
  | IpcClientDiscoveryResponseMessage;

type PendingResponse = {
  timer: ReturnType<typeof setTimeout>;
  resolve: (value: IpcResponseMessage) => void;
  reject: (error: Error) => void;
};

type RegisteredClient = {
  id: string;
  type: string;
  socket: Socket;
};

type PendingRoutedRequest = {
  sourceClientId: string;
  sourceSocket: Socket;
  targetClientId: string;
  originalRequestId: string;
  timeout: ReturnType<typeof setTimeout>;
};

type PendingDiscoveryRequest = {
  clientId: string;
  resolve: (client: RegisteredClient) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

type IpcRequestHandler = {
  canHandle: (request: IpcRequestMessage) => boolean;
  handle: (request: IpcRequestMessage) => Promise<JsonValue> | JsonValue;
};

export type CodexIpcPeer = {
  clientId: string;
  clientType: string;
};

export type CodexIpcSnapshot = {
  status: "starting" | "connected" | "disconnected" | "error" | "closed";
  socketPath: string;
  clientId: string | null;
  peerCount: number;
  peers: CodexIpcPeer[];
  detail?: string;
};

export type CodexIpcEvent =
  | { type: "status"; snapshot: CodexIpcSnapshot }
  | { type: "broadcast"; broadcast: IpcBroadcastMessage; snapshot: CodexIpcSnapshot }
  | { type: "stderr"; text: string; snapshot: CodexIpcSnapshot };

const initializingClientId = "initializing-client";
const connectRetryMs = 1_000;
// How often we check that the endpoint still points at the bus we are on. A
// stat once a second costs nothing next to a bus that stays dead until someone
// reloads a window.
const busEndpointCheckMs = 1_000;
const requestTimeoutMs = 5_000;
const routedRequestTimeoutMs = 10_000;
const maxFrameBytes = 256 * 1024 * 1024;
const maxBufferBytes = 512 * 1024 * 1024;

// Copied from the verified extension (`B9` in out/extension.js). Every peer
// checks the version of what it receives and drops a mismatch without a word,
// so a number invented here is a message nobody ever sees.
const methodVersions: Record<string, number> = {
  "thread-stream-state-changed": 11,
  "thread-stream-following-changed": 1,
  "thread-stream-following-status-requested": 1,
  "ipc-connection-reset": 1,
  "thread-read-state-changed": 2,
  "thread-archived": 2,
  "thread-unarchived": 1,
  "thread-owner-discovery": 1,
  "thread-follower-start-turn": 1,
  "thread-follower-load-complete-history": 1,
  "thread-follower-compact-thread": 1,
  "thread-follower-steer-turn": 1,
  "thread-follower-interrupt-turn": 4,
  "thread-follower-update-thread-settings": 1,
  "thread-follower-edit-last-user-turn": 2,
  "thread-follower-command-approval-decision": 1,
  "thread-follower-file-approval-decision": 1,
  "thread-follower-permissions-request-approval-response": 1,
  "thread-follower-submit-user-input": 1,
  "thread-follower-submit-mcp-server-elicitation-response": 1,
  "thread-follower-set-queued-follow-ups-state": 1,
  "thread-queued-followups-changed": 1,
};

// Where the extension's own router lives (`gT` in out/extension.js). The
// directory is the extension's to own, so the same ownership check guards it:
// a bus under someone else's socket is a bus we must not join.
export function codexIpcEndpoint(): string {
  if (process.platform === "win32") {
    return join("\\\\.\\pipe", "codex-ipc");
  }

  const directory = join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "ipc");
  mkdirSync(directory, { mode: 0o700, recursive: true });
  const stats = lstatSync(directory);
  const uid = process.getuid?.();
  if (uid == null || !stats.isDirectory() || stats.uid !== uid) {
    throw new Error("Codex IPC directory is not owned by the current user");
  }
  chmodSync(directory, 0o700);

  return join(directory, "ipc.sock");
}

// The endpoint the extension used before it moved into CODEX_HOME (`Lye`). It
// still joins one there when it finds it, so a dispatcher that started first
// and owns this socket keeps working.
export function legacyCodexIpcSocketPath(): string {
  const uid = process.getuid?.();
  return join(tmpdir(), "codex-ipc", uid ? `ipc-${uid}.sock` : "ipc.sock");
}

function isOwnedSocket(path: string): boolean {
  const uid = process.getuid?.();
  if (uid == null) {
    return false;
  }

  try {
    const stats = lstatSync(path);
    return stats.isSocket() && stats.uid === uid;
  } catch {
    return false;
  }
}

// `$ye`: the legacy endpoint lives in a world-writable /tmp, so the socket being
// ours is not enough — anyone who can write its directory can swap it for their
// own. The extension refuses such a socket and hosts the bus elsewhere; a
// dispatcher that accepts it lands on a different bus than the extension.
function isSafeLegacySocket(path: string): boolean {
  const uid = process.getuid?.();
  if (uid == null || !isOwnedSocket(path)) {
    return false;
  }

  try {
    const directory = lstatSync(dirname(path));
    return directory.isDirectory() && directory.uid === uid && (directory.mode & 0o22) === 0;
  } catch {
    return false;
  }
}

// `Bye`: the socket inherits the umask, which is nobody's idea of a permission
// decision. The extension re-checks the socket it just created and locks it to
// its own user, refusing to serve on one it cannot.
function secureRouterSocket(path: string): void {
  if (process.platform === "win32") {
    return;
  }

  if (!isOwnedSocket(path)) {
    throw new Error("Codex IPC socket is not owned by the current user");
  }
  chmodSync(path, 0o600);
}

// Which socket, not just which path: a replaced endpoint keeps the name and
// changes the inode, and that is the only way to tell our own bus from the one
// that took its place.
function socketIdentity(path: string): string | null {
  try {
    const stats = lstatSync(path);
    return stats.isSocket() ? `${stats.dev}:${stats.ino}` : null;
  } catch {
    return null;
  }
}

// `Fye`: only a stale socket of ours is ours to remove. Anything else at that
// path belongs to someone else, and deleting it is how two clients end up
// fighting over one endpoint.
function unlinkStaleSocket(path: string): void {
  if (process.platform === "win32" || !isOwnedSocket(path)) {
    return;
  }

  try {
    unlinkSync(path);
  } catch {
    // Losing the race to another client that just cleaned up is not an error:
    // listen() decides who hosts the bus.
  }
}

export class CodexIpcBridge {
  private readonly routerManager: IpcRouterManager;
  private readonly listeners = new Set<(event: CodexIpcEvent) => void>();
  private readonly pendingResponses = new Map<string, PendingResponse>();
  private readonly peers = new Map<string, CodexIpcPeer>();
  private readonly requestHandlers = new Map<string, IpcRequestHandler>();

  private socket: Socket | null = null;
  private detachReader: (() => void) | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private busEndpointTimer: ReturnType<typeof setInterval> | null = null;
  private busIdentity: string | null = null;
  private clientId = initializingClientId;
  private disposed = false;
  private status: CodexIpcSnapshot["status"] = "starting";
  private detail: string | null = null;

  // Unset until start resolves it: which bus we are on is the answer to «is
  // anyone already hosting one», and that is only knowable at connect time.
  socketPath = "";

  constructor(private readonly fixedSocketPath?: string) {
    this.routerManager = new IpcRouterManager(fixedSocketPath);
  }

  onEvent(listener: (event: CodexIpcEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getSnapshot(): CodexIpcSnapshot {
    const snapshot: CodexIpcSnapshot = {
      status: this.status,
      socketPath: this.socketPath,
      clientId: this.clientId === initializingClientId ? null : this.clientId,
      peerCount: this.peers.size,
      peers: Array.from(this.peers.values()),
    };

    if (this.detail) {
      snapshot.detail = this.detail;
    }

    return snapshot;
  }

  async start(clientType = "dispatcher"): Promise<void> {
    if (this.disposed) {
      return;
    }

    this.setStatus("starting");
    try {
      this.socketPath = await this.routerManager.resolveEndpoint();
    } catch (error) {
      this.setStatus("error", toError(error).message);
      this.scheduleReconnect(clientType);
      return;
    }

    await this.connect(clientType);
    this.watchBusEndpoint();
  }

  // A replaced endpoint is silent on both sides: the router that lost it keeps
  // accepting on an unreachable inode, and everyone connected to it keeps a
  // working socket to a bus of its own. Nothing closes, so nothing reconnects —
  // it has to be looked at. Dropping the connection is the whole recovery: the
  // close handler runs the reconnect we already have, and the router manager
  // has by then forgotten it ever hosted, so the election starts over.
  private watchBusEndpoint(): void {
    if (this.busEndpointTimer) {
      return;
    }

    this.busEndpointTimer = setInterval(() => {
      if (this.disposed) {
        return;
      }

      // Both halves have to be looked at separately: while we are between
      // connections there is no bus identity to compare, and that is exactly
      // when a router of ours can lose its endpoint and never hear about it.
      const connectedToReplaced = this.busIdentity !== null && this.busIdentity !== socketIdentity(this.socketPath);
      if (!connectedToReplaced && !this.routerManager.hostsReplacedSocket()) {
        return;
      }

      this.setStatus("disconnected", "the IPC endpoint was replaced under the bus we were on");
      this.routerManager.stop();
      this.socket?.destroy();
    }, busEndpointCheckMs);
    this.busEndpointTimer.unref?.();
  }

  stop(): void {
    this.disposed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.busEndpointTimer) {
      clearInterval(this.busEndpointTimer);
      this.busEndpointTimer = null;
    }

    for (const pending of this.pendingResponses.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("disposed"));
    }
    this.pendingResponses.clear();

    this.detachReader?.();
    this.detachReader = null;
    this.socket?.destroy();
    this.socket = null;
    this.routerManager.stop();
    this.setStatus("closed");
  }

  request(
    method: string,
    params: JsonValue,
    options: { targetClientId?: string | undefined; timeoutMs?: number | undefined } = {},
  ): Promise<IpcResponseMessage> {
    return this.sendRequest(method, params, options);
  }

  addRequestHandler(
    method: string,
    canHandle: (request: IpcRequestMessage) => boolean,
    handle: (request: IpcRequestMessage) => Promise<JsonValue> | JsonValue,
  ): () => void {
    this.requestHandlers.set(method, { canHandle, handle });
    return () => {
      this.requestHandlers.delete(method);
    };
  }

  broadcast(method: string, params: JsonValue, options: { targetClientIds?: string[] } = {}): boolean {
    const socket = this.socket;
    if (!socket || !socket.writable || this.clientId === initializingClientId) {
      return false;
    }
    // An addressed broadcast with nobody to address is not a broadcast to
    // everyone: the sender scoped it, and an empty scope means send nothing.
    if (options.targetClientIds?.length === 0) {
      return false;
    }

    const message: IpcBroadcastMessage = {
      type: "broadcast",
      method,
      sourceClientId: this.clientId,
      version: ipcMethodVersion(method),
      params,
    };
    if (options.targetClientIds) {
      message.targetClientIds = options.targetClientIds;
    }

    writeFrame(socket, message);
    return true;
  }

  private async connect(clientType: string): Promise<void> {
    if (this.disposed) {
      return;
    }

    await new Promise<void>((resolve) => {
      // Same ordering as the router probe: a missing socket path errors inside
      // connect(), so the handlers have to be on the socket before it dials.
      const socket = new Socket();
      socket.on("error", (error) => {
        this.setStatus("error", error.message);
        resolve();
      });

      // Read before dialing, not after: a swap that lands mid-connect would
      // otherwise record the new socket against a connection to the old one,
      // and the check below would agree with itself forever. Reading first
      // errs the other way — one reconnect too many, never one too few.
      const dialled = socketIdentity(this.socketPath);
      socket.connect(this.socketPath, () => {
        if (this.disposed) {
          socket.destroy();
          resolve();
          return;
        }

        this.socket = socket;
        this.busIdentity = dialled;
        this.detachReader = attachMessageReader(
          socket,
          (message) => this.handleMessage(message),
          (error) => {
            this.emit({ type: "stderr", text: error.message, snapshot: this.getSnapshot() });
            socket.destroy();
          },
        );

        this.sendRequest("initialize", { clientType })
          .then((response) => {
            if (
              response.resultType === "success" &&
              response.method === "initialize" &&
              isJsonObject(response.result) &&
              typeof response.result.clientId === "string"
            ) {
              this.clientId = response.result.clientId;
              this.setStatus("connected");
              return;
            }

            socket.destroy(new Error("IPC initialize returned an unexpected response"));
          })
          .catch((error) => {
            this.setStatus("error", toError(error).message);
            socket.destroy();
          });

        resolve();
      });

      socket.on("close", () => {
        this.detachReader?.();
        this.detachReader = null;
        this.socket = null;
        this.busIdentity = null;
        this.clientId = initializingClientId;
        this.peers.clear();

        for (const [requestId, pending] of this.pendingResponses.entries()) {
          clearTimeout(pending.timer);
          pending.reject(new Error("connection-closed"));
          this.pendingResponses.delete(requestId);
        }

        if (!this.disposed) {
          this.setStatus("disconnected");
          this.scheduleReconnect(clientType);
        }
      });
    });
  }

  private sendRequest(
    method: string,
    params: JsonValue,
    options: { targetClientId?: string | undefined; timeoutMs?: number | undefined } = {},
  ): Promise<IpcResponseMessage> {
    const socket = this.socket;
    if (!socket || !socket.writable) {
      return Promise.reject(new Error("not-connected"));
    }

    const request: IpcRequestMessage = {
      type: "request",
      requestId: randomUUID(),
      sourceClientId: this.clientId,
      version: ipcMethodVersion(method),
      method,
      params,
    };
    if (options.targetClientId) {
      request.targetClientId = options.targetClientId;
    }
    if (options.timeoutMs !== undefined) {
      request.timeoutMs = options.timeoutMs;
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingResponses.delete(request.requestId);
        reject(new Error("timeout"));
      }, options.timeoutMs ?? requestTimeoutMs);

      this.pendingResponses.set(request.requestId, { timer, resolve, reject });
      writeFrame(socket, request);
    });
  }

  private handleMessage(message: IpcMessage): void {
    switch (message.type) {
      case "broadcast":
        this.handleBroadcast(message);
        return;

      case "client-discovery-request":
        this.handleClientDiscoveryRequest(message);
        return;

      case "client-discovery-response":
        return;

      case "response":
        this.handleResponse(message);
        return;

      case "request":
        void this.handleRequest(message);
        return;
    }
  }

  private handleBroadcast(message: IpcBroadcastMessage): void {
    // The router already filters, but a client that is not on the list must
    // not act on a frame it was only handed by an older router.
    if (message.targetClientIds && !message.targetClientIds.includes(this.clientId)) {
      return;
    }

    if (message.method === "client-status-changed") {
      this.applyClientStatusBroadcast(message.params);
      this.emit({ type: "status", snapshot: this.getSnapshot() });
    }

    this.emit({ type: "broadcast", broadcast: message, snapshot: this.getSnapshot() });
  }

  private handleResponse(message: IpcResponseMessage): void {
    const pending = this.pendingResponses.get(message.requestId);
    if (!pending) {
      return;
    }

    this.pendingResponses.delete(message.requestId);
    clearTimeout(pending.timer);
    pending.resolve(message);
  }

  private handleClientDiscoveryRequest(message: IpcClientDiscoveryRequestMessage): void {
    if (!this.socket || !this.socket.writable) {
      return;
    }

    const handler = this.getRequestHandler(message.request);
    writeFrame(this.socket, {
      type: "client-discovery-response",
      requestId: message.requestId,
      response: { canHandle: Boolean(handler) },
    });
  }

  private async handleRequest(message: IpcRequestMessage): Promise<void> {
    if (!this.socket || !this.socket.writable) {
      return;
    }

    const handler = this.getRequestHandler(message);
    if (!handler) {
      writeFrame(this.socket, {
        type: "response",
        requestId: message.requestId,
        resultType: "error",
        error: "no-handler-for-request",
      });
      return;
    }

    try {
      const result = await handler.handle(message);
      writeFrame(this.socket, {
        type: "response",
        requestId: message.requestId,
        resultType: "success",
        method: message.method,
        handledByClientId: this.clientId,
        result,
      });
    } catch (error) {
      writeFrame(this.socket, {
        type: "response",
        requestId: message.requestId,
        resultType: "error",
        error: toError(error).message,
      });
    }
  }

  private getRequestHandler(message: IpcRequestMessage): IpcRequestHandler | null {
    const handler = this.requestHandlers.get(message.method);
    if (!handler || !handler.canHandle(message)) {
      return null;
    }

    return handler;
  }

  private applyClientStatusBroadcast(params: JsonValue | undefined): void {
    if (!isJsonObject(params)) {
      return;
    }

    const clientId = params.clientId;
    const clientType = params.clientType;
    const status = params.status;
    if (typeof clientId !== "string" || typeof clientType !== "string") {
      return;
    }

    if (status === "connected") {
      this.peers.set(clientId, { clientId, clientType });
      return;
    }

    if (status === "disconnected") {
      this.peers.delete(clientId);
    }
  }

  private scheduleReconnect(clientType: string): void {
    if (this.reconnectTimer || this.disposed) {
      return;
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.start(clientType);
    }, connectRetryMs);
  }

  private setStatus(status: CodexIpcSnapshot["status"], detail: string | null = null): void {
    this.status = status;
    this.detail = detail;
    this.emit({ type: "status", snapshot: this.getSnapshot() });
  }

  private emit(event: CodexIpcEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

class IpcRouterManager {
  private server: Server | null = null;
  private router: IpcRouter | null = null;
  private socketPath = "";
  private started = false;
  private ownsSocket = false;
  private hostedSocketIdentity: string | null = null;

  constructor(private readonly fixedSocketPath?: string) {}

  // The extension's own resolution order (`getOrStartRouterEndpoint`), and it
  // has to be ours too: pick a different endpoint and both sides sit on a bus
  // of one, each convinced it is connected.
  async resolveEndpoint(): Promise<string> {
    if (this.started) {
      return this.socketPath;
    }

    this.socketPath = this.fixedSocketPath ?? codexIpcEndpoint();
    if (await this.canConnectToSocket(this.socketPath)) {
      return this.socketPath;
    }

    if (!this.fixedSocketPath && process.platform !== "win32") {
      // Whoever is on the old endpoint got there first and the extension will
      // join them, so we join them too rather than splitting the bus.
      const legacyPath = legacyCodexIpcSocketPath();
      if (isSafeLegacySocket(legacyPath) && (await this.canConnectToSocket(legacyPath))) {
        this.socketPath = legacyPath;
        return this.socketPath;
      }
    }

    await this.startRouter();
    return this.socketPath;
  }

  // Bind first and ask questions after. The extension removes whatever is at
  // the endpoint as soon as its probe misses it, and it can host only once
  // (`routerStarted` is a latch), so a socket we delete a moment after someone
  // bound it is a VS Code that never comes back to the bus. Only a path nobody
  // answers on is ours to clear.
  private async startRouter(): Promise<void> {
    if (await this.listenOnRouterSocket()) {
      return;
    }

    if (await this.canConnectToSocket(this.socketPath)) {
      return;
    }

    unlinkStaleSocket(this.socketPath);
    await this.listenOnRouterSocket();
  }

  private listenOnRouterSocket(): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      const server = createServer();
      const router = new IpcRouter(server);
      let settled = false;

      server.once("error", (error: NodeJS.ErrnoException) => {
        if (settled) {
          return;
        }

        settled = true;
        if (error.code === "EADDRINUSE") {
          server.close();
          resolve(false);
          return;
        }

        reject(error);
      });

      server.listen(this.socketPath, () => {
        settled = true;
        try {
          secureRouterSocket(this.socketPath);
        } catch (error) {
          server.close();
          reject(toError(error));
          return;
        }
        this.server = server;
        this.router = router;
        this.started = true;
        this.ownsSocket = true;
        this.hostedSocketIdentity = socketIdentity(this.socketPath);
        router.start();
        resolve(true);
      });
    });
  }

  // Nothing tells a listening server that its path was unlinked: it keeps
  // accepting on an inode no one can reach any more, and its own client stays
  // connected, so the bus looks healthy from the inside while every other
  // client is somewhere else.
  hostsReplacedSocket(): boolean {
    return this.ownsSocket && this.hostedSocketIdentity !== socketIdentity(this.socketPath);
  }

  stop(): void {
    const ownsLiveSocket = this.ownsSocket && !this.hostsReplacedSocket();
    this.router?.stop();
    this.router = null;
    this.server?.close();
    this.server = null;
    this.started = false;
    // Only the socket we are still listening on is ours to remove: once it has
    // been replaced, the file belongs to whoever hosts the bus now.
    if (ownsLiveSocket && process.platform !== "win32" && existsSync(this.socketPath)) {
      unlinkSync(this.socketPath);
    }
    this.ownsSocket = false;
    this.hostedSocketIdentity = null;
  }

  private canConnectToSocket(socketPath: string): Promise<boolean> {
    return new Promise((resolve) => {
      // Listener first: connecting to a socket path that does not exist reports
      // ENOENT before connect() returns, and an unhandled error here would fail
      // the start of the very router that is missing.
      const socket = new Socket();
      socket.on("error", () => {
        resolve(false);
      });
      socket.connect(socketPath, () => {
        socket.end();
        resolve(true);
      });
    });
  }
}

class IpcRouter {
  private readonly clients = new Map<Socket, RegisteredClient>();
  private readonly clientsById = new Map<string, RegisteredClient>();
  private readonly pendingRequests = new Map<string, PendingRoutedRequest>();
  private readonly pendingDiscoveryRequests = new Map<string, PendingDiscoveryRequest>();
  private readonly detachReaders = new Map<Socket, () => void>();

  constructor(private readonly server: Server) {}

  start(): void {
    this.server.on("connection", (socket) => {
      const detachReader = attachMessageReader(
        socket,
        (message) => {
          void this.handleMessage(socket, message);
        },
        () => {
          socket.destroy();
        },
      );
      this.detachReaders.set(socket, detachReader);

      const unregister = () => {
        detachReader();
        this.detachReaders.delete(socket);
        this.unregisterClient(socket);
      };
      socket.on("close", unregister);
      socket.on("end", unregister);
      socket.on("error", () => {});
    });

    this.server.on("close", () => {
      this.stop();
    });
  }

  stop(): void {
    for (const [requestId, request] of this.pendingRequests.entries()) {
      clearTimeout(request.timeout);
      this.pendingRequests.delete(requestId);
      if (request.sourceSocket.writable) {
        writeFrame(request.sourceSocket, {
          type: "response",
          requestId: request.originalRequestId,
          resultType: "error",
          error: "server-closed",
        });
      }
    }

    // Closing the server leaves everyone who is already connected talking to a
    // router that no longer answers, and the extension reconnects on close and
    // nothing else — so a router that walks away without hanging up takes every
    // client with it.
    const connected = Array.from(this.detachReaders.keys());
    for (const detachReader of this.detachReaders.values()) {
      detachReader();
    }
    this.detachReaders.clear();
    this.clients.clear();
    this.clientsById.clear();
    for (const socket of connected) {
      socket.destroy();
    }

    for (const [requestId, request] of this.pendingDiscoveryRequests.entries()) {
      clearTimeout(request.timeout);
      this.pendingDiscoveryRequests.delete(requestId);
      request.reject(new Error("server-closed"));
    }
  }

  private async handleMessage(socket: Socket, message: IpcMessage): Promise<void> {
    switch (message.type) {
      case "broadcast":
        this.handleBroadcast(socket, message);
        return;

      case "request":
        await this.handleRequest(socket, message);
        return;

      case "response":
        this.handleResponse(message);
        return;

      case "client-discovery-response":
        this.handleClientDiscoveryResponse(message);
        return;

      case "client-discovery-request":
        return;
    }
  }

  private handleBroadcast(socket: Socket, message: IpcBroadcastMessage): void {
    const senderClientId = this.clients.get(socket)?.id ?? message.sourceClientId;
    const forwarded = { ...message, sourceClientId: senderClientId };
    const frame = makeFrame(forwarded);
    const targets = message.targetClientIds ? new Set(message.targetClientIds) : null;

    for (const client of this.clients.values()) {
      if (client.socket !== socket && client.socket.writable && (targets === null || targets.has(client.id))) {
        writeFrame(client.socket, forwarded, frame);
      }
    }
  }

  private async handleRequest(socket: Socket, message: IpcRequestMessage): Promise<void> {
    if (message.method === "initialize") {
      this.registerClient(socket, message.requestId, message.params);
      return;
    }

    try {
      const client = await this.findClientForRequest(socket, message);
      this.forwardRequest(socket, message, client);
    } catch {
      writeFrame(socket, {
        type: "response",
        requestId: message.requestId,
        resultType: "error",
        error: "no-client-found",
      });
    }
  }

  private handleResponse(message: IpcResponseMessage): void {
    const pending = this.pendingRequests.get(message.requestId);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timeout);
    this.pendingRequests.delete(message.requestId);
    if (pending.sourceSocket.writable) {
      writeFrame(pending.sourceSocket, message);
    }
  }

  private async findClientForRequest(sourceSocket: Socket, message: IpcRequestMessage): Promise<RegisteredClient> {
    if (message.targetClientId) {
      const client = this.clientsById.get(message.targetClientId);
      if (!client || client.socket === sourceSocket) {
        throw new Error("client-not-found");
      }

      return this.sendClientDiscoveryRequest(message, client);
    }

    const candidates = Array.from(this.clients.values()).filter((client) => client.socket !== sourceSocket);
    return Promise.any(candidates.map((client) => this.sendClientDiscoveryRequest(message, client)));
  }

  private sendClientDiscoveryRequest(message: IpcRequestMessage, client: RegisteredClient): Promise<RegisteredClient> {
    const requestId = randomUUID();
    const discoveryRequest: IpcClientDiscoveryRequestMessage = {
      type: "client-discovery-request",
      requestId,
      request: message,
    };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingDiscoveryRequests.delete(requestId);
        reject(new Error("timeout"));
      }, routedRequestTimeoutMs);

      this.pendingDiscoveryRequests.set(requestId, {
        clientId: client.id,
        resolve,
        reject,
        timeout,
      });

      writeFrame(client.socket, discoveryRequest);
    });
  }

  private handleClientDiscoveryResponse(message: IpcClientDiscoveryResponseMessage): void {
    const pending = this.pendingDiscoveryRequests.get(message.requestId);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timeout);
    this.pendingDiscoveryRequests.delete(message.requestId);

    const client = this.clientsById.get(pending.clientId);
    if (message.response.canHandle && client) {
      pending.resolve(client);
      return;
    }

    pending.reject(new Error(message.response.canHandle ? "client-disconnected" : "client-cannot-handle-request"));
  }

  private registerClient(socket: Socket, requestId: string, params: JsonValue | undefined): void {
    const existingClient = this.clients.get(socket);
    if (existingClient) {
      writeFrame(socket, {
        type: "response",
        requestId,
        resultType: "success",
        method: "initialize",
        handledByClientId: existingClient.id,
        result: { clientId: existingClient.id },
      });
      return;
    }

    const clientId = randomUUID();
    const clientType = isJsonObject(params) && typeof params.clientType === "string" ? params.clientType : "unknown";
    const client = { id: clientId, type: clientType, socket };
    this.clients.set(socket, client);
    this.clientsById.set(clientId, client);
    this.broadcastClientStatus(client, "connected");

    writeFrame(socket, {
      type: "response",
      requestId,
      resultType: "success",
      method: "initialize",
      handledByClientId: clientId,
      result: { clientId },
    });
  }

  private unregisterClient(socket: Socket): void {
    const client = this.clients.get(socket);
    if (!client) {
      return;
    }

    this.clients.delete(socket);
    this.clientsById.delete(client.id);
    this.broadcastClientStatus(client, "disconnected");

    for (const [requestId, request] of this.pendingRequests.entries()) {
      if (request.targetClientId !== client.id && request.sourceClientId !== client.id) {
        continue;
      }

      clearTimeout(request.timeout);
      this.pendingRequests.delete(requestId);
      if (request.sourceClientId !== client.id && request.sourceSocket.writable) {
        writeFrame(request.sourceSocket, {
          type: "response",
          requestId: request.originalRequestId,
          resultType: "error",
          error: "client-disconnected",
        });
      }
    }

    for (const [requestId, request] of this.pendingDiscoveryRequests.entries()) {
      if (request.clientId !== client.id) {
        continue;
      }

      clearTimeout(request.timeout);
      this.pendingDiscoveryRequests.delete(requestId);
      request.reject(new Error("client-disconnected"));
    }
  }

  private broadcastClientStatus(client: RegisteredClient, status: "connected" | "disconnected"): void {
    const message: IpcBroadcastMessage = {
      type: "broadcast",
      method: "client-status-changed",
      sourceClientId: client.id,
      version: ipcMethodVersion("client-status-changed"),
      params: {
        clientId: client.id,
        clientType: client.type,
        status,
      },
    };

    for (const recipient of this.clients.values()) {
      if (recipient.id !== client.id && recipient.socket.writable) {
        writeFrame(recipient.socket, message);
      }
    }
  }

  private forwardRequest(sourceSocket: Socket, message: IpcRequestMessage, targetClient: RegisteredClient): void {
    const sourceClientId = message.sourceClientId ?? "";
    const timeout = setTimeout(() => {
      const pending = this.pendingRequests.get(message.requestId);
      if (!pending) {
        return;
      }

      this.pendingRequests.delete(message.requestId);
      if (pending.sourceSocket.writable) {
        writeFrame(pending.sourceSocket, {
          type: "response",
          requestId: pending.originalRequestId,
          resultType: "error",
          error: "request-timeout",
        });
      }
    }, message.timeoutMs ?? routedRequestTimeoutMs);

    this.pendingRequests.set(message.requestId, {
      sourceClientId,
      sourceSocket,
      targetClientId: targetClient.id,
      originalRequestId: message.requestId,
      timeout,
    });

    writeFrame(targetClient.socket, message);
  }
}

export function ipcMethodVersion(method: string): number {
  return methodVersions[method] ?? 0;
}

function attachMessageReader(
  socket: Socket,
  onMessage: (message: IpcMessage) => void,
  onError: (error: Error) => void,
): () => void {
  let buffer = Buffer.alloc(0);
  let frameLength: number | null = null;

  const handleData = (chunk: Buffer) => {
    if (chunk.length === 0) {
      return;
    }

    if (buffer.length + chunk.length > maxBufferBytes) {
      onError(new Error(`[IPC] Buffer exceeded limit (${maxBufferBytes} bytes)`));
      return;
    }

    buffer = Buffer.concat([buffer, chunk]);

    for (;;) {
      if (frameLength === null) {
        if (buffer.length < 4) {
          return;
        }

        frameLength = buffer.readUInt32LE(0);
        buffer = buffer.subarray(4);
        if (frameLength > maxFrameBytes) {
          onError(new Error(`[IPC] Frame exceeded limit (${frameLength} > ${maxFrameBytes} bytes)`));
          return;
        }
      }

      if (buffer.length < frameLength) {
        return;
      }

      const frame = buffer.subarray(0, frameLength);
      buffer = buffer.subarray(frameLength);
      frameLength = null;

      try {
        onMessage(JSON.parse(frame.toString("utf8")) as IpcMessage);
      } catch (error) {
        onError(toError(error));
        return;
      }
    }
  };

  socket.on("data", handleData);
  return () => {
    socket.off("data", handleData);
  };
}

function writeFrame(socket: Socket, message: IpcMessage, frame = makeFrame(message)): void {
  socket.write(frame);
}

function makeFrame(message: IpcMessage): Buffer {
  const payload = JSON.stringify(message);
  const payloadBytes = Buffer.byteLength(payload, "utf8");
  const frame = Buffer.alloc(4 + payloadBytes);
  frame.writeUInt32LE(payloadBytes, 0);
  frame.write(payload, 4, "utf8");
  return frame;
}

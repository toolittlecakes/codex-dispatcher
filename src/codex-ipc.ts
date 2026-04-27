import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { connect, createServer, type Server, type Socket } from "node:net";
import type { JsonObject, JsonValue } from "./codex-app-server";

type IpcRequestMessage = {
  type: "request";
  requestId: string;
  sourceClientId?: string;
  targetClientId?: string;
  version?: number;
  method: string;
  params?: JsonValue;
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
const requestTimeoutMs = 5_000;
const routedRequestTimeoutMs = 10_000;
const maxFrameBytes = 256 * 1024 * 1024;
const maxBufferBytes = 512 * 1024 * 1024;

const methodVersions: Record<string, number> = {
  "thread-stream-state-changed": 6,
  "thread-read-state-changed": 1,
  "thread-archived": 2,
  "thread-unarchived": 1,
  "thread-follower-start-turn": 1,
  "thread-follower-compact-thread": 1,
  "thread-follower-steer-turn": 1,
  "thread-follower-interrupt-turn": 1,
  "thread-follower-set-model-and-reasoning": 1,
  "thread-follower-set-collaboration-mode": 1,
  "thread-follower-edit-last-user-turn": 1,
  "thread-follower-command-approval-decision": 1,
  "thread-follower-file-approval-decision": 1,
  "thread-follower-permissions-request-approval-response": 1,
  "thread-follower-submit-user-input": 1,
  "thread-follower-submit-mcp-server-elicitation-response": 1,
  "thread-follower-set-queued-follow-ups-state": 1,
  "thread-queued-followups-changed": 1,
};

export function getCodexIpcSocketPath(): string {
  if (process.platform === "win32") {
    return join("\\\\.\\pipe", "codex-ipc");
  }

  const socketDirectory = join(tmpdir(), "codex-ipc");
  mkdirSync(socketDirectory, { recursive: true });
  const uid = process.getuid?.();
  return join(socketDirectory, uid ? `ipc-${uid}.sock` : "ipc.sock");
}

export class CodexIpcBridge {
  private readonly routerManager = new IpcRouterManager();
  private readonly listeners = new Set<(event: CodexIpcEvent) => void>();
  private readonly pendingResponses = new Map<string, PendingResponse>();
  private readonly peers = new Map<string, CodexIpcPeer>();

  private socket: Socket | null = null;
  private detachReader: (() => void) | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private clientId = initializingClientId;
  private disposed = false;
  private status: CodexIpcSnapshot["status"] = "starting";
  private detail: string | null = null;

  readonly socketPath = getCodexIpcSocketPath();

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
      await this.routerManager.startRouterIfNeeded();
    } catch (error) {
      this.setStatus("error", toError(error).message);
      this.scheduleReconnect(clientType);
      return;
    }

    await this.connect(clientType);
  }

  stop(): void {
    this.disposed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
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
    options: { targetClientId?: string } = {},
  ): Promise<IpcResponseMessage> {
    return this.sendRequest(method, params, options);
  }

  private async connect(clientType: string): Promise<void> {
    if (this.disposed) {
      return;
    }

    await new Promise<void>((resolve) => {
      const socket = connect(this.socketPath, () => {
        if (this.disposed) {
          socket.destroy();
          resolve();
          return;
        }

        this.socket = socket;
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

      socket.on("error", (error) => {
        this.setStatus("error", error.message);
        resolve();
      });

      socket.on("close", () => {
        this.detachReader?.();
        this.detachReader = null;
        this.socket = null;
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
    options: { targetClientId?: string } = {},
  ): Promise<IpcResponseMessage> {
    const socket = this.socket;
    if (!socket || !socket.writable) {
      return Promise.reject(new Error("not-connected"));
    }

    const request: IpcRequestMessage = {
      type: "request",
      requestId: randomUUID(),
      sourceClientId: this.clientId,
      version: methodVersion(method),
      method,
      params,
    };
    if (options.targetClientId) {
      request.targetClientId = options.targetClientId;
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingResponses.delete(request.requestId);
        reject(new Error("timeout"));
      }, requestTimeoutMs);

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
        this.handleRequest(message);
        return;
    }
  }

  private handleBroadcast(message: IpcBroadcastMessage): void {
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

    writeFrame(this.socket, {
      type: "client-discovery-response",
      requestId: message.requestId,
      response: { canHandle: false },
    });
  }

  private handleRequest(message: IpcRequestMessage): void {
    if (!this.socket || !this.socket.writable) {
      return;
    }

    writeFrame(this.socket, {
      type: "response",
      requestId: message.requestId,
      resultType: "error",
      error: "no-handler-for-request",
    });
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
  private started = false;
  private ownsSocket = false;
  private readonly socketPath = getCodexIpcSocketPath();

  async startRouterIfNeeded(): Promise<void> {
    if (this.started || (await this.canConnectToSocket())) {
      return;
    }

    if (process.platform !== "win32" && existsSync(this.socketPath)) {
      unlinkSync(this.socketPath);
    }

    await new Promise<void>((resolve, reject) => {
      const server = createServer();
      const router = new IpcRouter(server);
      let settled = false;

      server.once("error", (error: NodeJS.ErrnoException) => {
        if (settled) {
          return;
        }

        if (error.code === "EADDRINUSE") {
          settled = true;
          server.close();
          resolve();
          return;
        }

        settled = true;
        reject(error);
      });

      server.listen(this.socketPath, () => {
        settled = true;
        this.server = server;
        this.router = router;
        this.started = true;
        this.ownsSocket = true;
        router.start();
        resolve();
      });
    });
  }

  stop(): void {
    this.router?.stop();
    this.router = null;
    this.server?.close();
    this.server = null;
    this.started = false;
    if (this.ownsSocket && process.platform !== "win32" && existsSync(this.socketPath)) {
      unlinkSync(this.socketPath);
    }
    this.ownsSocket = false;
  }

  private canConnectToSocket(): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = connect(this.socketPath, () => {
        socket.end();
        resolve(true);
      });
      socket.on("error", () => {
        resolve(false);
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
    for (const detachReader of this.detachReaders.values()) {
      detachReader();
    }
    this.detachReaders.clear();
    this.clients.clear();
    this.clientsById.clear();

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

    for (const client of this.clients.values()) {
      if (client.socket !== socket && client.socket.writable) {
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
      version: methodVersion("client-status-changed"),
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
    }, routedRequestTimeoutMs);

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

function methodVersion(method: string): number {
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

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

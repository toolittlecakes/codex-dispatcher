import {
  decodeRelayFrame,
  encodeRelayFrame,
  type RelayControlFrame,
  type RelayFrame,
  type RelayHttpRequestCancelFrame,
  type RelayHttpRequestFrame,
} from "./relay-protocol";

export type RelayClientOptions = {
  relayUrl: string;
  relayToken: string;
  localBaseUrl: string;
  localDispatcherToken: string;
  killExisting: boolean;
  onStatus?: (message: string) => void;
};

export type RelayClient = {
  stableUrl: string;
  killedSessionId: string | null;
  close: () => void;
};

const heartbeatIntervalMs = 20_000;
const reconnectBaseDelayMs = 1_000;
const reconnectMaxDelayMs = 30_000;

export function startRelayClient(options: RelayClientOptions): Promise<RelayClient> {
  return new Promise<RelayClient>((resolve, reject) => {
    let settled = false;
    let stableUrl = "";
    let killedSessionId: string | null = null;
    let acceptedOnce = false;
    let closed = false;
    let reconnectAttempt = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    let ws: WebSocket | null = null;
    const activeRequests = new Map<string, AbortController>();

    const stopHeartbeat = () => {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
    };

    const startHeartbeat = (socket: WebSocket) => {
      stopHeartbeat();
      heartbeatTimer = setInterval(() => {
        sendFrame(socket, { type: "dispatcher-heartbeat", sentAt: Date.now() });
      }, heartbeatIntervalMs);
    };

    const scheduleReconnect = () => {
      if (closed || reconnectTimer) {
        return;
      }
      reconnectAttempt += 1;
      const delay = Math.min(reconnectMaxDelayMs, reconnectBaseDelayMs * 2 ** Math.min(reconnectAttempt - 1, 5));
      options.onStatus?.(`relay disconnected; reconnecting in ${delay}ms`);
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect(true);
      }, delay);
    };

    const abortActiveRequests = () => {
      for (const controller of activeRequests.values()) {
        controller.abort();
      }
      activeRequests.clear();
    };

    const connect = (killExisting: boolean) => {
      stopHeartbeat();
      const socket = new WebSocket(dispatcherWebSocketUrl({ ...options, killExisting }));
      ws = socket;

      socket.addEventListener("message", (event) => {
        void handleRelayMessage(options, socket, event.data, activeRequests).then((controlFrame) => {
          if (!controlFrame) {
            return;
          }
          if (controlFrame.type === "dispatcher-accepted") {
            stableUrl = controlFrame.stableUrl;
            killedSessionId = controlFrame.killedSessionId;
            acceptedOnce = true;
            reconnectAttempt = 0;
            startHeartbeat(socket);
            options.onStatus?.(`relay connected: ${stableUrl}`);
            if (!settled) {
              settled = true;
              resolve({
                stableUrl,
                killedSessionId,
                close: () => {
                  closed = true;
                  if (reconnectTimer) {
                    clearTimeout(reconnectTimer);
                    reconnectTimer = null;
                  }
                  stopHeartbeat();
                  abortActiveRequests();
                  ws?.close();
                },
              });
            }
            return;
          }
          if (!settled) {
            settled = true;
            reject(new Error(`${controlFrame.code}: ${controlFrame.message}`));
          } else {
            options.onStatus?.(`relay rejected reconnect: ${controlFrame.code}`);
          }
          socket.close();
        }).catch((error) => {
          if (!settled) {
            settled = true;
            reject(error);
          }
          options.onStatus?.(`relay message failed: ${error instanceof Error ? error.message : String(error)}`);
          socket.close();
        });
      });

      socket.addEventListener("error", () => {
        if (!settled) {
          settled = true;
          reject(new Error(`Relay connection failed: ${options.relayUrl}`));
          return;
        }
        options.onStatus?.("relay websocket error");
      });

      socket.addEventListener("close", () => {
        const wasCurrentSocket = ws === socket;
        if (wasCurrentSocket) {
          ws = null;
          stopHeartbeat();
          abortActiveRequests();
        }
        if (!settled) {
          settled = true;
          reject(new Error("Relay connection closed before dispatcher was accepted."));
          return;
        }
        if (wasCurrentSocket && acceptedOnce && !closed) {
          scheduleReconnect();
        }
      });
    };

    connect(options.killExisting);
  });
}

export function dispatcherWebSocketUrl(options: Pick<RelayClientOptions, "relayUrl" | "relayToken" | "killExisting">): string {
  const url = new URL("/api/dispatcher/connect", options.relayUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("token", options.relayToken);
  if (options.killExisting) {
    url.searchParams.set("killExisting", "1");
  }
  return url.toString();
}

async function handleRelayMessage(
  options: RelayClientOptions,
  ws: WebSocket,
  raw: string | Buffer,
  activeRequests?: Map<string, AbortController>,
): Promise<RelayControlFrame | null> {
  const frame = decodeRelayFrame(raw);
  switch (frame.type) {
    case "dispatcher-accepted":
    case "dispatcher-rejected":
      return frame;
    case "http-request":
      if (!activeRequests) {
        throw new Error("Relay request map is unavailable.");
      }
      void forwardHttpRequest(options, ws, frame, activeRequests);
      return null;
    case "http-request-cancel":
      handleHttpRequestCancel(frame, activeRequests);
      return null;
    default:
      return null;
  }
}

async function forwardHttpRequest(
  options: RelayClientOptions,
  ws: WebSocket,
  frame: RelayHttpRequestFrame,
  activeRequests: Map<string, AbortController>,
): Promise<void> {
  const controller = new AbortController();
  activeRequests.set(frame.requestId, controller);
  try {
    const headers = new Headers(frame.headers);
    headers.set("x-dispatcher-token", options.localDispatcherToken);
    const requestInit: RequestInit = {
      method: frame.method,
      headers,
      signal: controller.signal,
    };
    if (frame.bodyBase64) {
      requestInit.body = Buffer.from(frame.bodyBase64, "base64");
    }
    const response = await fetch(localRequestUrl(options.localBaseUrl, frame.path), requestInit);
    sendFrame(ws, {
      type: "http-response-start",
      requestId: frame.requestId,
      status: response.status,
      headers: Array.from(response.headers.entries()),
    });

    if (response.body) {
      const reader = response.body.getReader();
      while (true) {
        const result = await reader.read();
        if (result.done) {
          break;
        }
        sendFrame(ws, {
          type: "http-response-chunk",
          requestId: frame.requestId,
          bodyBase64: Buffer.from(result.value).toString("base64"),
        });
      }
    }

    sendFrame(ws, {
      type: "http-response-end",
      requestId: frame.requestId,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      return;
    }
    sendFrame(ws, {
      type: "http-response-error",
      requestId: frame.requestId,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    activeRequests.delete(frame.requestId);
  }
}

function handleHttpRequestCancel(
  frame: RelayHttpRequestCancelFrame,
  activeRequests: Map<string, AbortController> | undefined,
): void {
  const controller = activeRequests?.get(frame.requestId);
  if (!controller) {
    return;
  }
  controller.abort();
  activeRequests?.delete(frame.requestId);
}

function localRequestUrl(localBaseUrl: string, path: string): string {
  if (!path.startsWith("/")) {
    throw new Error(`Invalid relay request path: ${path}`);
  }
  return new URL(path, localBaseUrl).toString();
}

function sendFrame(ws: WebSocket, frame: RelayFrame): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(encodeRelayFrame(frame));
  }
}

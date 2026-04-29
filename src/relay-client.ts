import {
  decodeRelayFrame,
  encodeRelayFrame,
  type RelayControlFrame,
  type RelayFrame,
  type RelayHttpRequestFrame,
} from "./relay-protocol";

export type RelayClientOptions = {
  relayUrl: string;
  relayToken: string;
  localBaseUrl: string;
  localDispatcherToken: string;
  killExisting: boolean;
};

export type RelayClient = {
  stableUrl: string;
  killedSessionId: string | null;
  close: () => void;
};

export function startRelayClient(options: RelayClientOptions): Promise<RelayClient> {
  return new Promise<RelayClient>((resolve, reject) => {
    const ws = new WebSocket(dispatcherWebSocketUrl(options));
    let settled = false;
    let stableUrl = "";
    let killedSessionId: string | null = null;

    ws.addEventListener("message", (event) => {
      void handleRelayMessage(options, ws, event.data).then((controlFrame) => {
        if (!controlFrame || settled) {
          return;
        }
        if (controlFrame.type === "dispatcher-accepted") {
          stableUrl = controlFrame.stableUrl;
          killedSessionId = controlFrame.killedSessionId;
          settled = true;
          resolve({
            stableUrl,
            killedSessionId,
            close: () => ws.close(),
          });
          return;
        }
        settled = true;
        reject(new Error(`${controlFrame.code}: ${controlFrame.message}`));
        ws.close();
      }).catch((error) => {
        if (!settled) {
          settled = true;
          reject(error);
        }
        ws.close();
      });
    });

    ws.addEventListener("error", () => {
      if (!settled) {
        settled = true;
        reject(new Error(`Relay connection failed: ${options.relayUrl}`));
      }
    });

    ws.addEventListener("close", () => {
      if (!settled) {
        settled = true;
        reject(new Error("Relay connection closed before dispatcher was accepted."));
      }
    });

    void stableUrl;
    void killedSessionId;
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
): Promise<RelayControlFrame | null> {
  const frame = decodeRelayFrame(raw);
  switch (frame.type) {
    case "dispatcher-accepted":
    case "dispatcher-rejected":
      return frame;
    case "http-request":
      void forwardHttpRequest(options, ws, frame);
      return null;
    default:
      return null;
  }
}

async function forwardHttpRequest(options: RelayClientOptions, ws: WebSocket, frame: RelayHttpRequestFrame): Promise<void> {
  try {
    const headers = new Headers(frame.headers);
    headers.set("x-dispatcher-token", options.localDispatcherToken);
    const requestInit: RequestInit = {
      method: frame.method,
      headers,
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
    sendFrame(ws, {
      type: "http-response-error",
      requestId: frame.requestId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
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

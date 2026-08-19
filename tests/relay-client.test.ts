import { describe, expect, test } from "bun:test";
import { dispatcherWebSocketUrl, startRelayClient } from "../src/relay-client";
import { decodeRelayFrame, encodeRelayFrame } from "../src/relay-protocol";

describe("relay client", () => {
  test("builds dispatcher websocket URL from relay URL", () => {
    expect(
      dispatcherWebSocketUrl({
        relayUrl: "https://codex-dispatcher.app",
        relayToken: "token",
        killExisting: false,
      }),
    ).toBe("wss://codex-dispatcher.app/api/dispatcher/connect?token=token");
  });

  test("adds explicit takeover flag when requested", () => {
    expect(
      dispatcherWebSocketUrl({
        relayUrl: "http://localhost:8788",
        relayToken: "token",
        killExisting: true,
      }),
    ).toBe("ws://localhost:8788/api/dispatcher/connect?token=token&killExisting=1");
  });

  test("aborts local streaming requests when the relay cancels them", async () => {
    let relaySocket: Bun.ServerWebSocket<unknown> | null = null;
    const streamCanceled = deferred<void>();

    const localDispatcher = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname !== "/events") {
          return new Response("not found", { status: 404 });
        }
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(": connected\n\n"));
          },
          cancel() {
            streamCanceled.resolve();
          },
        }), {
          headers: {
            "content-type": "text/event-stream",
          },
        });
      },
    });

    const relay = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request, server) {
        if (server.upgrade(request)) {
          return undefined;
        }
        return new Response("upgrade required", { status: 400 });
      },
      websocket: {
        open(ws) {
          relaySocket = ws;
          ws.send(encodeRelayFrame({
            type: "dispatcher-accepted",
            stableUrl: "https://toolittlecakes.codex-dispatcher.app/",
            killedSessionId: null,
          }));
        },
        message(ws, raw) {
          const frame = decodeRelayFrame(raw.toString());
          if (frame.type !== "http-response-chunk") {
            return;
          }
          ws.send(encodeRelayFrame({ type: "http-request-cancel", requestId: frame.requestId }));
        },
      },
    });

    try {
      const client = await startRelayClient({
        relayUrl: relay.url.toString(),
        relayToken: "relay-token",
        localBaseUrl: localDispatcher.url.toString(),
        localDispatcherToken: "local-token",
        killExisting: false,
      });

      relaySocket?.send(encodeRelayFrame({
        type: "http-request",
        requestId: "req-events",
        method: "GET",
        path: "/events",
        headers: [],
        bodyBase64: null,
      }));

      await Promise.race([
        streamCanceled.promise,
        sleep(5_000).then(() => {
          throw new Error("local stream was not canceled");
        }),
      ]);
      client.close();
    } finally {
      relay.stop(true);
      localDispatcher.stop(true);
    }
  });

  // The response headers travel to the browser untouched, so the body has to
  // stay the exact bytes those headers describe: an inflated gzip response
  // would reach the browser as garbage it tries to gunzip.
  test("relays a gzip response without inflating it", async () => {
    const original = Buffer.from("const answer = 42;\n".repeat(500));
    const compressed = Bun.gzipSync(original);
    let relaySocket: Bun.ServerWebSocket<unknown> | null = null;
    const responseDone = deferred<void>();
    const chunks: Buffer[] = [];
    let responseHeaders: [string, string][] = [];

    const localDispatcher = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch() {
        return new Response(compressed, {
          headers: {
            "content-type": "text/javascript; charset=utf-8",
            "content-encoding": "gzip",
          },
        });
      },
    });

    const relay = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request, server) {
        if (server.upgrade(request)) {
          return undefined;
        }
        return new Response("upgrade required", { status: 400 });
      },
      websocket: {
        open(ws) {
          relaySocket = ws;
          ws.send(encodeRelayFrame({
            type: "dispatcher-accepted",
            stableUrl: "https://toolittlecakes.codex-dispatcher.app/",
            killedSessionId: null,
          }));
        },
        message(_ws, raw) {
          const frame = decodeRelayFrame(raw.toString());
          if (frame.type === "http-response-start") {
            responseHeaders = frame.headers;
          }
          if (frame.type === "http-response-chunk") {
            chunks.push(Buffer.from(frame.bodyBase64, "base64"));
          }
          if (frame.type === "http-response-end") {
            responseDone.resolve();
          }
        },
      },
    });

    try {
      const client = await startRelayClient({
        relayUrl: relay.url.toString(),
        relayToken: "relay-token",
        localBaseUrl: localDispatcher.url.toString(),
        localDispatcherToken: "local-token",
        killExisting: false,
      });

      relaySocket?.send(encodeRelayFrame({
        type: "http-request",
        requestId: "req-asset",
        method: "GET",
        path: "/assets/app.js",
        headers: [["accept-encoding", "gzip"]],
        bodyBase64: null,
      }));

      await Promise.race([
        responseDone.promise,
        sleep(5_000).then(() => {
          throw new Error("relayed response never completed");
        }),
      ]);

      const body = Buffer.concat(chunks);
      expect(responseHeaders).toContainEqual(["content-encoding", "gzip"]);
      expect(body.equals(compressed)).toBe(true);
      expect(Buffer.from(Bun.gunzipSync(body)).equals(original)).toBe(true);
      client.close();
    } finally {
      relay.stop(true);
      localDispatcher.stop(true);
    }
  });
});

function deferred<T>(): { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void } {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

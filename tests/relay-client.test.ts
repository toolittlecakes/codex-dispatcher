import { describe, expect, test } from "bun:test";
import { dispatcherWebSocketUrl } from "../src/relay-client";

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
});

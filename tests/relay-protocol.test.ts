import { describe, expect, test } from "bun:test";
import { decodeRelayFrame, encodeRelayFrame, type RelayFrame } from "../src/relay-protocol";

describe("relay protocol", () => {
  test("round trips streaming HTTP frames", () => {
    const frames: RelayFrame[] = [
      {
        type: "http-request",
        requestId: "req-1",
        method: "GET",
        path: "/events",
        headers: [["accept", "text/event-stream"]],
        bodyBase64: null,
      },
      {
        type: "http-response-start",
        requestId: "req-1",
        status: 200,
        headers: [["content-type", "text/event-stream"]],
      },
      {
        type: "http-response-chunk",
        requestId: "req-1",
        bodyBase64: Buffer.from("data: {}\n\n").toString("base64"),
      },
      {
        type: "http-response-end",
        requestId: "req-1",
      },
      {
        type: "http-request-cancel",
        requestId: "req-1",
      },
    ];

    expect(frames.map((frame) => decodeRelayFrame(encodeRelayFrame(frame)))).toEqual(frames);
  });

  test("round trips dispatcher takeover control frames", () => {
    const accepted: RelayFrame = {
      type: "dispatcher-accepted",
      stableUrl: "https://sne.codex-dispatcher.app/",
      killedSessionId: "old-session",
    };
    const rejected: RelayFrame = {
      type: "dispatcher-rejected",
      code: "dispatcher.already_active",
      message: "Another dispatcher is already active.",
    };

    expect(decodeRelayFrame(encodeRelayFrame(accepted))).toEqual(accepted);
    expect(decodeRelayFrame(encodeRelayFrame(rejected))).toEqual(rejected);
  });

  test("round trips dispatcher heartbeat frames", () => {
    const heartbeat: RelayFrame = {
      type: "dispatcher-heartbeat",
      sentAt: 1777480000000,
    };

    expect(decodeRelayFrame(encodeRelayFrame(heartbeat))).toEqual(heartbeat);
  });

  test("rejects malformed frames visibly", () => {
    expect(() => decodeRelayFrame("{}")).toThrow("missing type");
    expect(() => decodeRelayFrame('{"type":"http-response-start","requestId":"1","status":700,"headers":[]}')).toThrow(
      "status must be an HTTP status code",
    );
    expect(() => decodeRelayFrame('{"type":"dispatcher-rejected","code":"other","message":"no"}')).toThrow(
      "unsupported rejection code other",
    );
  });
});

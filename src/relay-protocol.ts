export type RelayHttpRequestFrame = {
  type: "http-request";
  requestId: string;
  method: string;
  path: string;
  headers: [string, string][];
  bodyBase64: string | null;
};

export type RelayHttpResponseStartFrame = {
  type: "http-response-start";
  requestId: string;
  status: number;
  headers: [string, string][];
};

export type RelayHttpResponseChunkFrame = {
  type: "http-response-chunk";
  requestId: string;
  bodyBase64: string;
};

export type RelayHttpResponseEndFrame = {
  type: "http-response-end";
  requestId: string;
};

export type RelayHttpResponseErrorFrame = {
  type: "http-response-error";
  requestId: string;
  error: string;
};

export type RelayHttpRequestCancelFrame = {
  type: "http-request-cancel";
  requestId: string;
};

export type RelayHeartbeatFrame = {
  type: "dispatcher-heartbeat";
  sentAt: number;
};

export type RelayControlFrame =
  | {
      type: "dispatcher-accepted";
      stableUrl: string;
      killedSessionId: string | null;
    }
  | {
      type: "dispatcher-rejected";
      code: "dispatcher.already_active" | "auth.invalid";
      message: string;
    };

export type RelayFrame =
  | RelayHttpRequestFrame
  | RelayHttpResponseStartFrame
  | RelayHttpResponseChunkFrame
  | RelayHttpResponseEndFrame
  | RelayHttpResponseErrorFrame
  | RelayHttpRequestCancelFrame
  | RelayHeartbeatFrame
  | RelayControlFrame;

export function encodeRelayFrame(frame: RelayFrame): string {
  return JSON.stringify(frame);
}

export function decodeRelayFrame(raw: string | Buffer): RelayFrame {
  const value = JSON.parse(raw.toString()) as unknown;
  if (!isRecord(value) || typeof value.type !== "string") {
    throw new Error("Invalid relay frame: missing type.");
  }
  switch (value.type) {
    case "http-request":
      return {
        type: "http-request",
        requestId: requiredString(value.requestId, "requestId"),
        method: requiredString(value.method, "method"),
        path: requiredString(value.path, "path"),
        headers: requiredHeaders(value.headers),
        bodyBase64: value.bodyBase64 === null ? null : requiredString(value.bodyBase64, "bodyBase64"),
      };
    case "http-response-start":
      return {
        type: "http-response-start",
        requestId: requiredString(value.requestId, "requestId"),
        status: requiredStatus(value.status),
        headers: requiredHeaders(value.headers),
      };
    case "http-response-chunk":
      return {
        type: "http-response-chunk",
        requestId: requiredString(value.requestId, "requestId"),
        bodyBase64: requiredString(value.bodyBase64, "bodyBase64"),
      };
    case "http-response-end":
      return {
        type: "http-response-end",
        requestId: requiredString(value.requestId, "requestId"),
      };
    case "http-response-error":
      return {
        type: "http-response-error",
        requestId: requiredString(value.requestId, "requestId"),
        error: requiredString(value.error, "error"),
      };
    case "http-request-cancel":
      return {
        type: "http-request-cancel",
        requestId: requiredString(value.requestId, "requestId"),
      };
    case "dispatcher-heartbeat":
      return {
        type: "dispatcher-heartbeat",
        sentAt: requiredTimestamp(value.sentAt, "sentAt"),
      };
    case "dispatcher-accepted":
      return {
        type: "dispatcher-accepted",
        stableUrl: requiredString(value.stableUrl, "stableUrl"),
        killedSessionId: value.killedSessionId === null ? null : requiredString(value.killedSessionId, "killedSessionId"),
      };
    case "dispatcher-rejected": {
      const code = requiredString(value.code, "code");
      if (code !== "dispatcher.already_active" && code !== "auth.invalid") {
        throw new Error(`Invalid relay frame: unsupported rejection code ${code}.`);
      }
      return {
        type: "dispatcher-rejected",
        code,
        message: requiredString(value.message, "message"),
      };
    }
    default:
      throw new Error(`Invalid relay frame: unsupported type ${value.type}.`);
  }
}

function requiredString(value: unknown, key: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Invalid relay frame: ${key} must be a non-empty string.`);
  }
  return value;
}

function requiredStatus(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 100 || value > 599) {
    throw new Error("Invalid relay frame: status must be an HTTP status code.");
  }
  return value;
}

function requiredTimestamp(value: unknown, key: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid relay frame: ${key} must be a non-negative timestamp.`);
  }
  return value;
}

function requiredHeaders(value: unknown): [string, string][] {
  if (!Array.isArray(value)) {
    throw new Error("Invalid relay frame: headers must be an array.");
  }
  return value.map((entry) => {
    if (
      !Array.isArray(entry) ||
      entry.length !== 2 ||
      typeof entry[0] !== "string" ||
      typeof entry[1] !== "string"
    ) {
      throw new Error("Invalid relay frame: header entries must be string pairs.");
    }
    return [entry[0], entry[1]];
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

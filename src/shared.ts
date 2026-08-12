import type { JsonObject, JsonValue } from "./codex-app-server";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return isRecord(value);
}

export function asJsonObject(value: JsonValue | undefined): JsonObject | null {
  return isJsonObject(value) ? value : null;
}

export function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

// A browser can legitimately send several cookies under one name — a cookie set
// on a parent domain sits next to a host-only one — and it picks the order
// itself, so reading only the first match can authenticate the wrong value.
export function cookieValues(header: string | null, name: string): string[] {
  const values: string[] = [];
  for (const part of header?.split(";") ?? []) {
    const [rawKey, ...rawValue] = part.trim().split("=");
    if (rawKey !== name) {
      continue;
    }
    try {
      values.push(decodeURIComponent(rawValue.join("=")));
    } catch {
      // Not a value we ever wrote; a malformed escape must not fail the request.
    }
  }
  return values;
}

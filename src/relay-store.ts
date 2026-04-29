import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { RelayState, type RelayStateSnapshot } from "./relay-state";

export function readRelayState(path: string): RelayState {
  if (!existsSync(path)) {
    return new RelayState();
  }
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  return RelayState.fromSnapshot(parseRelayStateSnapshot(parsed));
}

export function writeRelayState(path: string, state: RelayState): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state.snapshot(), null, 2)}\n`, { mode: 0o600 });
}

function parseRelayStateSnapshot(value: unknown): RelayStateSnapshot {
  if (!isRecord(value) || value.version !== 1) {
    throw new Error("Invalid relay state: expected version 1 snapshot.");
  }
  const snapshot: RelayStateSnapshot = {
    version: 1,
    nextUserOrdinal: requiredPositiveInteger(value.nextUserOrdinal, "nextUserOrdinal"),
    nextDeviceOrdinal: requiredPositiveInteger(value.nextDeviceOrdinal, "nextDeviceOrdinal"),
    users: requiredArray(value.users, "users").map(parseUser),
    browserSessions: requiredArray(value.browserSessions, "browserSessions").map(parseBrowserSession),
    devices: requiredArray(value.devices, "devices").map(parseDevice),
  };
  return snapshot;
}

function parseUser(value: unknown): RelayStateSnapshot["users"][number] {
  if (!isRecord(value)) {
    throw new Error("Invalid relay state: user must be an object.");
  }
  return {
    id: requiredString(value.id, "user.id"),
    githubId: requiredPositiveInteger(value.githubId, "user.githubId"),
    githubLogin: requiredString(value.githubLogin, "user.githubLogin"),
    slug: requiredString(value.slug, "user.slug"),
    createdAt: requiredNonNegativeInteger(value.createdAt, "user.createdAt"),
    updatedAt: requiredNonNegativeInteger(value.updatedAt, "user.updatedAt"),
  };
}

function parseBrowserSession(value: unknown): RelayStateSnapshot["browserSessions"][number] {
  if (!isRecord(value)) {
    throw new Error("Invalid relay state: browser session must be an object.");
  }
  return {
    token: requiredString(value.token, "browserSession.token"),
    userId: requiredString(value.userId, "browserSession.userId"),
    createdAt: requiredNonNegativeInteger(value.createdAt, "browserSession.createdAt"),
    expiresAt: requiredNonNegativeInteger(value.expiresAt, "browserSession.expiresAt"),
  };
}

function parseDevice(value: unknown): RelayStateSnapshot["devices"][number] {
  if (!isRecord(value)) {
    throw new Error("Invalid relay state: device must be an object.");
  }
  return {
    id: requiredString(value.id, "device.id"),
    userId: requiredString(value.userId, "device.userId"),
    token: requiredString(value.token, "device.token"),
    createdAt: requiredNonNegativeInteger(value.createdAt, "device.createdAt"),
    lastLoginAt: requiredNonNegativeInteger(value.lastLoginAt, "device.lastLoginAt"),
  };
}

function requiredString(value: unknown, key: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Invalid relay state: ${key} must be a non-empty string.`);
  }
  return value;
}

function requiredPositiveInteger(value: unknown, key: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`Invalid relay state: ${key} must be a positive integer.`);
  }
  return value;
}

function requiredNonNegativeInteger(value: unknown, key: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`Invalid relay state: ${key} must be a non-negative integer.`);
  }
  return value;
}

function requiredArray(value: unknown, key: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`Invalid relay state: ${key} must be an array.`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type DispatcherConfig = {
  relay?: {
    url: string;
    userId: string;
    githubLogin: string;
    slug: string;
    deviceId: string;
    token: string;
  };
};

export function dispatcherConfigPath(): string {
  return join(process.env.CODEX_DISPATCHER_HOME ?? join(homedir(), ".codex-dispatcher"), "config.json");
}

export function readDispatcherConfig(path = dispatcherConfigPath()): DispatcherConfig {
  if (!existsSync(path)) {
    return {};
  }
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  return parseDispatcherConfig(parsed);
}

export function writeDispatcherConfig(config: DispatcherConfig, path = dispatcherConfigPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

function parseDispatcherConfig(value: unknown): DispatcherConfig {
  if (!isRecord(value)) {
    throw new Error("Invalid codex-dispatcher config: expected object.");
  }
  const relay = value.relay;
  if (relay === undefined) {
    return {};
  }
  if (!isRecord(relay)) {
    throw new Error("Invalid codex-dispatcher config: relay must be an object.");
  }
  const config: DispatcherConfig = {
    relay: {
      url: requiredString(relay.url, "relay.url"),
      userId: requiredString(relay.userId, "relay.userId"),
      githubLogin: requiredString(relay.githubLogin, "relay.githubLogin"),
      slug: requiredString(relay.slug, "relay.slug"),
      deviceId: requiredString(relay.deviceId, "relay.deviceId"),
      token: requiredString(relay.token, "relay.token"),
    },
  };
  return config;
}

function requiredString(value: unknown, key: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Invalid codex-dispatcher config: ${key} must be a non-empty string.`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

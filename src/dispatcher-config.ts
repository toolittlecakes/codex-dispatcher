import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { isRecord } from "./shared";

export type DispatcherConfig = {
  webviewToken?: string;
  relay?: {
    url: string;
    userId: string;
    githubLogin: string;
    slug: string;
    deviceId: string;
    token: string;
  };
};

export function dispatcherHome(): string {
  return process.env.CODEX_DISPATCHER_HOME ?? join(homedir(), ".codex-dispatcher");
}

export function dispatcherConfigPath(): string {
  return join(dispatcherHome(), "config.json");
}

export type DispatcherRuntime = {
  pid: number;
  localUrl: string;
  phoneUrl: string | null;
};

// The tray app (and anything else that wants to link to a running dispatcher)
// reads this instead of parsing serve's stdout. The URLs embed the webview
// token, hence 0600.
export function dispatcherRuntimePath(): string {
  return join(dispatcherHome(), "runtime.json");
}

export function writeDispatcherRuntime(runtime: DispatcherRuntime, path = dispatcherRuntimePath()): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(runtime, null, 2)}\n`, { mode: 0o600 });
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
  const config: DispatcherConfig = {};
  if (value.webviewToken !== undefined) {
    config.webviewToken = requiredString(value.webviewToken, "webviewToken");
  }
  const relay = value.relay;
  if (relay === undefined) {
    return config;
  }
  if (!isRecord(relay)) {
    throw new Error("Invalid codex-dispatcher config: relay must be an object.");
  }
  config.relay = {
      url: requiredString(relay.url, "relay.url"),
      userId: requiredString(relay.userId, "relay.userId"),
      githubLogin: requiredString(relay.githubLogin, "relay.githubLogin"),
      slug: requiredString(relay.slug, "relay.slug"),
      deviceId: requiredString(relay.deviceId, "relay.deviceId"),
      token: requiredString(relay.token, "relay.token"),
  };
  return config;
}

// The phone bookmarks a ?token= link and its cookie carries the same value, so
// a token minted per process makes every dispatcher restart a dead page that
// only a freshly copied link can revive. One token per machine, held next to
// the relay login at 0600, is what lets the LAN link and the page outlive the
// process the way the relay path already does.
export function ensureWebviewToken(path = dispatcherConfigPath()): string {
  const config = readDispatcherConfig(path);
  if (config.webviewToken) {
    return config.webviewToken;
  }

  const token = randomBytes(18).toString("base64url");
  writeDispatcherConfig({ ...config, webviewToken: token }, path);
  return token;
}

function requiredString(value: unknown, key: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Invalid codex-dispatcher config: ${key} must be a non-empty string.`);
  }
  return value;
}

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureWebviewToken, readDispatcherConfig, writeDispatcherConfig } from "../src/dispatcher-config";

describe("dispatcher config", () => {
  test("reads an empty config when the file does not exist", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-dispatcher-config-"));
    try {
      expect(readDispatcherConfig(join(root, "missing.json"))).toEqual({});
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("writes and reads relay login state", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-dispatcher-config-"));
    const path = join(root, "nested", "config.json");
    try {
      const config = {
        relay: {
          url: "https://relay.example.test",
          userId: "usr_1",
          githubLogin: "sne",
          slug: "sne",
          deviceId: "dev_1",
          token: "relay-token",
        },
      };

      writeDispatcherConfig(config, path);

      expect(readDispatcherConfig(path)).toEqual(config);
      expect(statSync(path).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fails visibly on malformed relay config", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-dispatcher-config-"));
    const path = join(root, "config.json");
    try {
      writeFileSync(path, JSON.stringify({ relay: { url: "" } }));

      expect(() => readDispatcherConfig(path)).toThrow("relay.url must be a non-empty string");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // The phone bookmarks a ?token= link; a token minted per process made every
  // dispatcher restart a dead page on the LAN path.
  test("mints the webview token once and then keeps returning it", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-dispatcher-config-"));
    const path = join(root, "config.json");
    try {
      const token = ensureWebviewToken(path);
      expect(token.length).toBeGreaterThan(16);
      expect(ensureWebviewToken(path)).toBe(token);
      expect(statSync(path).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("keeps the webview token and the relay login from erasing each other", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-dispatcher-config-"));
    const path = join(root, "config.json");
    try {
      const token = ensureWebviewToken(path);
      const relay = {
        url: "https://relay.example.test",
        userId: "usr_1",
        githubLogin: "sne",
        slug: "sne",
        deviceId: "dev_1",
        token: "relay-token",
      };
      // What runRelayLogin does: read, merge, write.
      writeDispatcherConfig({ ...readDispatcherConfig(path), relay }, path);

      expect(readDispatcherConfig(path)).toEqual({ webviewToken: token, relay });
      expect(ensureWebviewToken(path)).toBe(token);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

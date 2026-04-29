import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRelayState, writeRelayState } from "../src/relay-store";
import { RelayState } from "../src/relay-state";

describe("relay store", () => {
  test("reads an empty relay state when the file does not exist", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-relay-store-"));
    try {
      const state = readRelayState(join(root, "missing.json"));
      expect(state.snapshot()).toMatchObject({
        users: [],
        browserSessions: [],
        devices: [],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("writes relay state with private file permissions", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-relay-store-"));
    const path = join(root, "state", "relay.json");
    try {
      const state = new RelayState();
      const user = state.upsertGitHubUser({ id: 1001, login: "sne" }, 10);
      state.createDevice(user.id, 20, () => "relay-token");

      writeRelayState(path, state);
      const restored = readRelayState(path);

      expect(restored.userForSlug("sne")).toEqual(user);
      expect(restored.authenticateDevice("relay-token", 30)?.userId).toBe(user.id);
      expect(statSync(path).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fails visibly on malformed state", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-relay-store-"));
    const path = join(root, "relay.json");
    try {
      writeFileSync(path, JSON.stringify({ version: 2 }));

      expect(() => readRelayState(path)).toThrow("expected version 1 snapshot");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

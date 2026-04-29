import { describe, expect, test } from "bun:test";
import { RelayState, slugifyGitHubLogin } from "../src/relay-state";

describe("relay state", () => {
  test("uses GitHub login as the default public slug", () => {
    const state = new RelayState();

    const user = state.upsertGitHubUser({ id: 1001, login: "ToolittleCakes" }, 10);

    expect(user).toMatchObject({
      githubId: 1001,
      githubLogin: "ToolittleCakes",
      slug: "toolittlecakes",
    });
    expect(state.userForSlug("toolittlecakes")).toEqual(user);
  });

  test("keeps relay identity stable when GitHub login casing changes", () => {
    const state = new RelayState();
    const first = state.upsertGitHubUser({ id: 1001, login: "ToolittleCakes" }, 10);

    const second = state.upsertGitHubUser({ id: 1001, login: "toolittlecakes" }, 20);

    expect(second.id).toBe(first.id);
    expect(second.slug).toBe(first.slug);
    expect(second.githubLogin).toBe("toolittlecakes");
    expect(second.updatedAt).toBe(20);
  });

  test("allocates a unique slug when another GitHub user owns the login slug", () => {
    const state = new RelayState();

    const first = state.upsertGitHubUser({ id: 1001, login: "sne" }, 10);
    const second = state.upsertGitHubUser({ id: 1002, login: "sne" }, 20);

    expect(first.slug).toBe("sne");
    expect(second.slug).toBe("sne-2");
  });

  test("authenticates browser sessions until expiry", () => {
    const state = new RelayState();
    const user = state.upsertGitHubUser({ id: 1001, login: "sne" }, 10);
    const session = state.createBrowserSession(user.id, 20, () => "browser-token");

    expect(state.authenticateBrowserSession(session.token, 30)).toEqual(user);
    expect(state.authenticateBrowserSession(session.token, session.expiresAt)).toBeNull();
  });

  test("issues dispatcher device tokens during CLI login", () => {
    const state = new RelayState();
    const user = state.upsertGitHubUser({ id: 1001, login: "sne" }, 10);

    const device = state.createDevice(user.id, 20, () => "relay-token");
    const authenticated = state.authenticateDevice("relay-token", 30);

    expect(device).toEqual({
      id: "dev_1",
      userId: user.id,
      token: "relay-token",
      createdAt: 20,
      lastLoginAt: 20,
    });
    expect(authenticated).toEqual({
      ...device,
      lastLoginAt: 30,
    });
    expect(state.authenticateDevice("missing", 30)).toBeNull();
  });

  test("rejects a second dispatcher unless killExisting is explicit", () => {
    const state = new RelayState();
    const user = state.upsertGitHubUser({ id: 1001, login: "sne" }, 10);

    const first = state.connectDispatcher({
      sessionId: "dispatcher-1",
      userId: user.id,
      deviceId: "laptop-1",
      now: 20,
      killExisting: false,
    });
    const second = state.connectDispatcher({
      sessionId: "dispatcher-2",
      userId: user.id,
      deviceId: "laptop-2",
      now: 30,
      killExisting: false,
    });

    expect(first.ok).toBe(true);
    expect(second).toEqual({
      ok: false,
      error: {
        code: "dispatcher.already_active",
        activeSession: {
          id: "dispatcher-1",
          userId: user.id,
          deviceId: "laptop-1",
          connectedAt: 20,
          lastSeenAt: 20,
        },
      },
    });
  });

  test("replaces the active dispatcher when killExisting is explicit", () => {
    const state = new RelayState();
    const user = state.upsertGitHubUser({ id: 1001, login: "sne" }, 10);
    state.connectDispatcher({
      sessionId: "dispatcher-1",
      userId: user.id,
      deviceId: "laptop-1",
      now: 20,
      killExisting: false,
    });

    const replacement = state.connectDispatcher({
      sessionId: "dispatcher-2",
      userId: user.id,
      deviceId: "laptop-2",
      now: 30,
      killExisting: true,
    });

    expect(replacement).toEqual({
      ok: true,
      killedSessionId: "dispatcher-1",
      session: {
        id: "dispatcher-2",
        userId: user.id,
        deviceId: "laptop-2",
        connectedAt: 30,
        lastSeenAt: 30,
      },
    });
    expect(state.activeDispatcherForSlug("sne")?.id).toBe("dispatcher-2");
  });

  test("snapshots persistent state without active dispatcher sessions", () => {
    const state = new RelayState();
    const user = state.upsertGitHubUser({ id: 1001, login: "sne" }, 10);
    state.createBrowserSession(user.id, 20, () => "browser-token");
    state.createDevice(user.id, 30, () => "relay-token");
    state.connectDispatcher({
      sessionId: "dispatcher-1",
      userId: user.id,
      deviceId: "dev_1",
      now: 40,
      killExisting: false,
    });

    const restored = RelayState.fromSnapshot(state.snapshot());

    expect(restored.userForSlug("sne")).toEqual(user);
    expect(restored.authenticateBrowserSession("browser-token", 50)).toEqual(user);
    expect(restored.authenticateDevice("relay-token", 50)?.userId).toBe(user.id);
    expect(restored.activeDispatcherForSlug("sne")).toBeNull();
  });

  test("slugifies GitHub logins conservatively", () => {
    expect(slugifyGitHubLogin(" Sne.Tools ")).toBe("sne-tools");
    expect(() => slugifyGitHubLogin(" - ")).toThrow("GitHub login cannot be converted");
  });
});

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ExtensionWebview,
  handleVSCodeRequest,
  makeFetchResponse,
  resolveWebviewAssetPath,
} from "../src/extension-webview";

describe("extension webview", () => {
  test("builds VS Code fetch success responses in the extension contract", () => {
    expect(makeFetchResponse({ requestId: "1", result: { ok: true } })).toEqual({
      type: "fetch-response",
      responseType: "success",
      requestId: "1",
      status: 200,
      headers: {},
      bodyJsonString: "{\"ok\":true}",
    });
  });

  test("rejects asset traversal outside the webview root", () => {
    expect(resolveWebviewAssetPath("/tmp/webview", "/assets/index.js")).toBe("/tmp/webview/assets/index.js");
    expect(resolveWebviewAssetPath("/tmp/webview", "/../secret.txt")).toBeNull();
  });

  test("handles explicit vscode endpoints needed during bootstrap", async () => {
    await expect(handleVSCodeRequest("extension-info", {}, "/repo")).resolves.toMatchObject({
      appName: "Codex",
      buildFlavor: "prod",
    });
    await expect(handleVSCodeRequest("list-pinned-threads", {}, "/repo")).resolves.toEqual({ threadIds: [] });
    await expect(handleVSCodeRequest("unknown-endpoint", {}, "/repo")).rejects.toThrow(
      "Unsupported vscode://codex/unknown-endpoint",
    );
  });

  test("promotes URL token to an HttpOnly cookie for extension traffic", async () => {
    const previousRoot = process.env.CODEX_EXTENSION_WEBVIEW_ROOT;
    const root = mkdtempSync(join(tmpdir(), "codex-webview-"));
    process.env.CODEX_EXTENSION_WEBVIEW_ROOT = root;
    writeFileSync(
      join(root, "index.html"),
      "<html><head><!-- PROD_BASE_TAG_HERE --><!-- PROD_CSP_TAG_HERE --></head><body></body></html>",
    );

    try {
      const webview = new ExtensionWebview({
        appServer: {} as never,
        defaultCwd: "/repo",
        getToken: () => "secret",
      });
      const response = await webview.fetch(
        new Request("http://localhost/?token=secret"),
        new URL("http://localhost/?token=secret"),
      );
      const html = await response.text();

      expect(response.headers.get("set-cookie")).toContain("codex_dispatcher_session=secret");
      expect(response.headers.get("set-cookie")).toContain("HttpOnly");
      expect(html).toContain("history.replaceState");
      expect(html).toContain('name="viewport"');
      expect(html).toContain("#root");
      expect(html).toContain("overflow: hidden !important");
      expect(html).toContain("-webkit-text-size-adjust: 100% !important");
      expect(html).toContain("font-size: 16px !important");
      expect(html).toContain("--codex-window-zoom: 1 !important");
      expect(html).toContain("height: var(--codex-dispatcher-viewport-height, 100vh) !important");
      expect(html).toContain("--codex-dispatcher-viewport-height");
      expect(html).toContain("--codex-dispatcher-viewport-offset-top");
      expect(html).toContain("offsetTop");
      expect(html).toContain("lockPageScroll");
      expect(html).toContain("visualViewport");
      expect(html).toContain('const hostMessageUrl = "/host-message";');
      expect(html).not.toContain("host-message?token=");

      const debug = await webview.fetch(
        new Request("http://localhost/debug", {
          headers: { cookie: "codex_dispatcher_session=secret" },
        }),
        new URL("http://localhost/debug"),
      );
      expect(debug.status).toBe(200);
    } finally {
      if (previousRoot === undefined) {
        delete process.env.CODEX_EXTENSION_WEBVIEW_ROOT;
      } else {
        process.env.CODEX_EXTENSION_WEBVIEW_ROOT = previousRoot;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("bridges Codex IPC messages into the extracted extension host contract", async () => {
    const previousRoot = process.env.CODEX_EXTENSION_WEBVIEW_ROOT;
    const root = mkdtempSync(join(tmpdir(), "codex-webview-"));
    process.env.CODEX_EXTENSION_WEBVIEW_ROOT = root;
    writeFileSync(join(root, "index.html"), "<html><head></head><body></body></html>");
    const followerRequests: Array<{ method: string; params: unknown }> = [];
    const ipcRequests: Array<{ method: string; params: unknown; targetClientId: string | undefined }> = [];

    try {
      const webview = new ExtensionWebview({
        appServer: {} as never,
        defaultCwd: "/repo",
        getToken: () => "secret",
        handleIpcRequest: async (method, params, targetClientId) => {
          ipcRequests.push({ method, params, targetClientId });
          return { mirrored: true };
        },
        getThreadRole: (conversationId) => (conversationId === "owned-thread" ? "owner" : "follower"),
        handleFollowerRequest: async (method, params) => {
          followerRequests.push({ method, params });
          return { ok: true };
        },
      });

      webview.handleIpcBroadcast({
        type: "broadcast",
        method: "thread-stream-state-changed",
        sourceClientId: "vscode-client",
        version: 6,
        params: { conversationId: "thread-1" },
      });

      const roleResponse = await webview.fetch(
        new Request("http://localhost/host-message", {
          method: "POST",
          headers: { cookie: "codex_dispatcher_session=secret" },
          body: JSON.stringify({
            type: "thread-role-request",
            requestId: "role-1",
            conversationId: "owned-thread",
          }),
        }),
        new URL("http://localhost/host-message"),
      );
      await expect(roleResponse.json()).resolves.toEqual({
        messages: [{ type: "thread-role-response", requestId: "role-1", role: "owner" }],
      });

      const followerResponse = await webview.fetch(
        new Request("http://localhost/host-message", {
          method: "POST",
          headers: { cookie: "codex_dispatcher_session=secret" },
          body: JSON.stringify({
            type: "thread-follower-start-turn-request",
            requestId: "follower-1",
            params: { conversationId: "thread-1" },
          }),
        }),
        new URL("http://localhost/host-message"),
      );
      await expect(followerResponse.json()).resolves.toEqual({
        messages: [{ type: "thread-follower-start-turn-response", requestId: "follower-1", result: { ok: true } }],
      });
      expect(followerRequests).toEqual([
        { method: "thread-follower-start-turn", params: { conversationId: "thread-1" } },
      ]);

      const ipcResponse = await webview.fetch(
        new Request("http://localhost/host-message", {
          method: "POST",
          headers: { cookie: "codex_dispatcher_session=secret" },
          body: JSON.stringify({
            type: "fetch",
            requestId: "ipc-1",
            url: "vscode://codex/ipc-request",
            method: "POST",
            body: JSON.stringify({
              method: "thread-follower-steer-turn",
              targetClientId: "vscode-client",
              params: { conversationId: "thread-1", input: [] },
            }),
          }),
        }),
        new URL("http://localhost/host-message"),
      );
      await expect(ipcResponse.json()).resolves.toEqual({
        messages: [
          {
            type: "fetch-response",
            responseType: "success",
            requestId: "ipc-1",
            status: 200,
            headers: {},
            bodyJsonString: "{\"mirrored\":true}",
          },
        ],
      });
      expect(ipcRequests).toEqual([
        {
          method: "thread-follower-steer-turn",
          params: { conversationId: "thread-1", input: [] },
          targetClientId: "vscode-client",
        },
      ]);

      const debug = await webview.fetch(
        new Request("http://localhost/debug", {
          headers: { cookie: "codex_dispatcher_session=secret" },
        }),
        new URL("http://localhost/debug"),
      );
      const snapshot = await debug.json();
      expect(snapshot.messageCounts).toMatchObject({
        "outbound:ipc-broadcast": 1,
        "outbound:thread-role-response": 1,
        "outbound:thread-follower-start-turn-response": 1,
        "outbound:fetch-response": 1,
      });
    } finally {
      if (previousRoot === undefined) {
        delete process.env.CODEX_EXTENSION_WEBVIEW_ROOT;
      } else {
        process.env.CODEX_EXTENSION_WEBVIEW_ROOT = previousRoot;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });
});

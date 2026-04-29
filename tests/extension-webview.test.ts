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
});

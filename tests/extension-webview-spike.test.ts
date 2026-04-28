import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ExtensionWebviewSpike,
  handleVSCodeRequest,
  makeFetchResponse,
  resolveWebviewAssetPath,
} from "../src/extension-webview-spike";

describe("extension webview spike", () => {
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
    expect(resolveWebviewAssetPath("/tmp/webview", "/extension-spike/assets/index.js")).toBe("/tmp/webview/assets/index.js");
    expect(resolveWebviewAssetPath("/tmp/webview", "/extension-spike/../secret.txt")).toBeNull();
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
      const spike = new ExtensionWebviewSpike({
        appServer: {} as never,
        defaultCwd: "/repo",
        getToken: () => "secret",
      });
      const response = await spike.fetch(
        new Request("http://localhost/extension-spike/?token=secret"),
        new URL("http://localhost/extension-spike/?token=secret"),
      );
      const html = await response.text();

      expect(response.headers.get("set-cookie")).toContain("codex_dispatcher_session=secret");
      expect(response.headers.get("set-cookie")).toContain("HttpOnly");
      expect(html).toContain("history.replaceState");
      expect(html).toContain("#root");
      expect(html).toContain("overflow: hidden");
      expect(html).toContain('const hostMessageUrl = "/extension-spike/host-message";');
      expect(html).not.toContain("host-message?token=");

      const debug = await spike.fetch(
        new Request("http://localhost/extension-spike/debug", {
          headers: { cookie: "codex_dispatcher_session=secret" },
        }),
        new URL("http://localhost/extension-spike/debug"),
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

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  ExtensionWebview,
  handleVSCodeRequest,
  isSupportedExtensionVersion,
  makeFetchResponse,
  parseExtensionVersion,
  resolveExtensionWebviewRoot,
  extensionVersionOf,
  resolveWebviewAssetPath,
  selectExtensionWebviewRoot,
} from "../src/extension-webview";
import { AppServerError } from "../src/codex-app-server";

type StreamCollector = {
  waitFor: (expected: number, timeoutMs?: number) => Promise<JsonRecord[]>;
  lastEventId: () => string | null;
  cancel: () => Promise<void>;
};

type JsonRecord = Record<string, unknown>;

async function openEventStream(webview: ExtensionWebview, clientId: string, lastEventId?: string): Promise<StreamCollector> {
  const target = `http://localhost/events?client=${clientId}`;
  const headers: Record<string, string> = { cookie: "codex_dispatcher_webview=secret" };
  if (lastEventId !== undefined) {
    headers["last-event-id"] = lastEventId;
  }
  const response = await webview.fetch(new Request(target, { headers }), new URL(target));
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const messages: JsonRecord[] = [];
  let pending = "";
  let latestEventId: string | null = null;

  // One read is kept in flight across poll iterations: a read abandoned on
  // timeout still consumes the next chunk, which would silently drop events.
  let inFlight: Promise<ReadableStreamReadResult<Uint8Array>> | null = null;

  return {
    async waitFor(expected, timeoutMs = 1_000) {
      const deadline = Date.now() + timeoutMs;
      while (messages.length < expected && Date.now() < deadline) {
        inFlight ??= reader.read();
        const settled = inFlight;
        const chunk = await Promise.race([
          settled.then((result) => result),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 25)),
        ]);
        if (chunk?.done) {
          break;
        }
        if (!chunk?.value) {
          continue;
        }
        inFlight = null;
        pending += decoder.decode(chunk.value);
        const frames = pending.split("\n\n");
        pending = frames.pop() ?? "";
        for (const frame of frames) {
          const id = frame.split("\n").find((line) => line.startsWith("id: "));
          if (id) {
            latestEventId = id.slice(4);
          }
          const data = frame.split("\n").find((line) => line.startsWith("data: "));
          if (data) {
            messages.push(JSON.parse(data.slice(6)) as JsonRecord);
          }
        }
      }
      return messages;
    },
    lastEventId: () => latestEventId,
    cancel: () => reader.cancel(),
  };
}

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
    await expect(handleVSCodeRequest("extension-info", {}, "/repo", "/ext/openai.chatgpt-26.803.61601-darwin-arm64/webview")).resolves.toMatchObject({
      appName: "Codex",
      buildFlavor: "prod",
    });
    await expect(handleVSCodeRequest("list-pinned-threads", {}, "/repo", null)).resolves.toEqual({ threadIds: [] });
    await expect(handleVSCodeRequest("unknown-endpoint", {}, "/repo", null)).rejects.toThrow(
      "Unsupported vscode://codex/unknown-endpoint",
    );
  });

  test("serves the newest extension version the bridge was verified against", () => {
    const extensionsDir = mkdtempSync(join(tmpdir(), "codex-extensions-"));
    const installVersion = (directory: string) => {
      const webview = join(extensionsDir, directory, "webview");
      mkdirSync(webview, { recursive: true });
      writeFileSync(join(webview, "index.html"), "<html></html>");
      return webview;
    };

    try {
      installVersion("openai.chatgpt-26.422.10000-darwin-arm64");
      installVersion("openai.chatgpt-26.803.10000-darwin-arm64");
      const verified = installVersion("openai.chatgpt-26.803.61601-darwin-arm64");
      // Newer than anything this bridge speaks to: picking it would silently
      // serve a contract nobody checked.
      installVersion("openai.chatgpt-27.101.10000-darwin-arm64");

      expect(selectExtensionWebviewRoot(extensionsDir)).toBe(verified);

      expect(extensionVersionOf(verified)).toBe("26.803.61601");
      expect(extensionVersionOf(null)).toBe("0.0.0");
      expect(extensionVersionOf("/somewhere/custom/webview")).toBe("0.0.0");

      rmSync(join(extensionsDir, "openai.chatgpt-26.422.10000-darwin-arm64"), { recursive: true });
      rmSync(join(extensionsDir, "openai.chatgpt-26.803.10000-darwin-arm64"), { recursive: true });
      rmSync(join(extensionsDir, "openai.chatgpt-26.803.61601-darwin-arm64"), { recursive: true });
      expect(() => selectExtensionWebviewRoot(extensionsDir)).toThrow("27.101.10000 is outside the range");

      rmSync(join(extensionsDir, "openai.chatgpt-27.101.10000-darwin-arm64"), { recursive: true });
      expect(selectExtensionWebviewRoot(extensionsDir)).toBeNull();
      expect(selectExtensionWebviewRoot(join(extensionsDir, "missing"))).toBeNull();
    } finally {
      rmSync(extensionsDir, { recursive: true, force: true });
    }
  });

  test("refuses an explicit webview root that holds no webview", () => {
    const previousRoot = process.env.CODEX_EXTENSION_WEBVIEW_ROOT;
    const empty = mkdtempSync(join(tmpdir(), "codex-empty-root-"));
    process.env.CODEX_EXTENSION_WEBVIEW_ROOT = join(empty, "typo");

    try {
      // Falling back to the scan here would answer a question the operator
      // already answered, with a different extension version.
      expect(() => resolveExtensionWebviewRoot()).toThrow("has no index.html");
    } finally {
      if (previousRoot === undefined) {
        delete process.env.CODEX_EXTENSION_WEBVIEW_ROOT;
      } else {
        process.env.CODEX_EXTENSION_WEBVIEW_ROOT = previousRoot;
      }
      rmSync(empty, { recursive: true, force: true });
    }
  });

  test("the extension installed on this machine is one the bridge claims to support", () => {
    const previousRoot = process.env.CODEX_EXTENSION_WEBVIEW_ROOT;
    delete process.env.CODEX_EXTENSION_WEBVIEW_ROOT;
    try {
      const installed = readdirSync(join(homedir(), ".vscode", "extensions"))
        .map((entry) => parseExtensionVersion(entry))
        .filter((version): version is number[] => version !== null);
      if (installed.length === 0) {
        return;
      }

      // Fails on the first auto-update past the verified range, which is the
      // whole point: the bridge emulates one extension's host contract.
      const root = resolveExtensionWebviewRoot();
      expect(root).not.toBeNull();
      expect(existsSync(join(root!, "index.html"))).toBe(true);
      expect(isSupportedExtensionVersion(parseExtensionVersion(basename(dirname(root!)))!)).toBe(true);
    } finally {
      if (previousRoot !== undefined) {
        process.env.CODEX_EXTENSION_WEBVIEW_ROOT = previousRoot;
      }
    }
  });

  test("hands the browser everything it needs to install the webview as an app", async () => {
    const previousRoot = process.env.CODEX_EXTENSION_WEBVIEW_ROOT;
    const root = mkdtempSync(join(tmpdir(), "codex-webview-"));
    process.env.CODEX_EXTENSION_WEBVIEW_ROOT = root;
    writeFileSync(join(root, "index.html"), "<html><head></head><body></body></html>");

    try {
      const webview = new ExtensionWebview({
        appServer: {} as never,
        defaultCwd: "/repo",
        getToken: () => "secret",
      });

      // The browser fetches the manifest and the worker without our session
      // cookie, so both have to answer an anonymous request.
      const manifestResponse = await webview.fetch(
        new Request("http://localhost/manifest.webmanifest"),
        new URL("http://localhost/manifest.webmanifest"),
      );
      expect(manifestResponse.status).toBe(200);
      expect(manifestResponse.headers.get("content-type")).toContain("application/manifest+json");
      const manifest = (await manifestResponse.json()) as {
        start_url: string;
        display: string;
        icons: Array<{ src: string; sizes: string; type: string }>;
      };
      expect(manifest.start_url).toBe("/");
      expect(manifest.display).toBe("standalone");
      expect(manifest.icons[0]?.src).toBe("/icon.png");
      expect(manifest.icons[0]?.type).toBe("image/png");

      const workerResponse = await webview.fetch(new Request("http://localhost/sw.js"), new URL("http://localhost/sw.js"));
      expect(workerResponse.status).toBe(200);
      expect(workerResponse.headers.get("content-type")).toContain("text/javascript");
      const worker = await workerResponse.text();
      expect(worker).toContain('addEventListener("fetch"');
      expect(worker).not.toContain("caches");

      const html = await (
        await webview.fetch(new Request("http://localhost/?token=secret"), new URL("http://localhost/?token=secret"))
      ).text();
      expect(html).toContain('rel="manifest" href="/manifest.webmanifest"');
      expect(html).toContain('rel="apple-touch-icon" href="/icon.png"');
      expect(html).toContain('navigator.serviceWorker.register("/sw.js"');
    } finally {
      if (previousRoot === undefined) {
        delete process.env.CODEX_EXTENSION_WEBVIEW_ROOT;
      } else {
        process.env.CODEX_EXTENSION_WEBVIEW_ROOT = previousRoot;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("serves the hosted extension's own icon as the home-screen icon", async () => {
    const previousRoot = process.env.CODEX_EXTENSION_WEBVIEW_ROOT;
    delete process.env.CODEX_EXTENSION_WEBVIEW_ROOT;
    try {
      const webview = new ExtensionWebview({
        appServer: {} as never,
        defaultCwd: "/repo",
        getToken: () => "secret",
      });
      const response = await webview.fetch(new Request("http://localhost/icon.png"), new URL("http://localhost/icon.png"));

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("image/png");
      expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(1000);
    } finally {
      if (previousRoot !== undefined) {
        process.env.CODEX_EXTENSION_WEBVIEW_ROOT = previousRoot;
      }
    }
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

      expect(response.headers.get("set-cookie")).toContain("codex_dispatcher_webview=secret");
      expect(response.headers.get("set-cookie")).toContain("HttpOnly");
      expect(response.headers.get("set-cookie")).toContain("Max-Age=7776000");
      // Plain http on the LAN is a first-class entry point, so Secure here
      // would hand out a cookie the browser refuses to send back.
      expect(response.headers.get("set-cookie")).not.toContain("Secure");

      const relayed = await webview.fetch(
        new Request("http://localhost/?token=secret", { headers: { "x-forwarded-proto": "https" } }),
        new URL("http://localhost/?token=secret"),
      );
      expect(relayed.headers.get("set-cookie")).toContain("Secure");

      // A truncated token must not pass: the comparison checks length before
      // the constant-time compare.
      const truncated = await webview.fetch(
        new Request("http://localhost/debug", { headers: { "x-dispatcher-token": "secre" } }),
        new URL("http://localhost/debug"),
      );
      expect(truncated.status).toBe(401);

      // Same character count, twice the bytes: comparing code units would let
      // this reach timingSafeEqual, which throws instead of refusing.
      const multibyte = await webview.fetch(
        new Request("http://localhost/debug", { headers: { "x-dispatcher-token": "ééééét" } }),
        new URL("http://localhost/debug"),
      );
      expect(multibyte.status).toBe(401);
      expect(html).toContain("history.replaceState");
      expect(html).toContain('name="viewport"');
      expect(html).toContain("maximum-scale=1");
      expect(html).toContain("user-scalable=no");
      expect(html).toContain("interactive-widget=resizes-visual");
      expect(html).toContain("#root");
      expect(html).toContain("overflow: hidden !important");
      expect(html).toContain("-webkit-text-size-adjust: 100% !important");
      expect(html).toContain("font-size: 16px !important");
      expect(html).toContain("--codex-window-zoom: 1 !important");
      expect(html).toContain("*::before");
      expect(html).toContain("zoom: 1 !important");
      expect(html).toContain("font-size: max(16px, 1rem) !important");
      expect(html).toContain("height: var(--codex-dispatcher-viewport-height, 100vh) !important");
      expect(html).toContain("--codex-dispatcher-viewport-height");
      expect(html).toContain("--codex-dispatcher-viewport-offset-top");
      expect(html).toContain("stableViewportHeight");
      expect(html).toContain("keyboardLikelyOpen");
      expect(html).toContain("enforceNoZoom");
      expect(html).toContain("scheduleViewportGeometry");
      expect(html).toContain("Math.floor(viewport.height)");
      expect(html).toContain("offsetTop");
      expect(html).toContain("lockPageScroll");
      expect(html).toContain("visualViewport");
      expect(html).toContain('const hostMessageUrl = "/host-message";');
      expect(html).not.toContain("host-message?token=");

      const debug = await webview.fetch(
        new Request("http://localhost/debug", {
          headers: { cookie: "codex_dispatcher_webview=secret" },
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

    try {
      const webview = new ExtensionWebview({
        appServer: {} as never,
        defaultCwd: "/repo",
        getToken: () => "secret",
        assertThreadFollowerOwner: async (conversationId) => {
          if (conversationId !== "thread-1") {
            throw new Error(`No IPC owner for thread ${conversationId}`);
          }
        },
        getThreadRole: (conversationId) => (conversationId === "owned-thread" ? "owner" : "follower"),
        handleFollowerRequest: async (method, params) => {
          followerRequests.push({ method, params });
          return { ok: true };
        },
      });

      const stream = await openEventStream(webview, "tab-1");

      const hostRoleResponse = await webview.fetch(
        new Request("http://localhost/host-message", {
          method: "POST",
          headers: { cookie: "codex_dispatcher_webview=secret", "x-dispatcher-client": "tab-1" },
          body: JSON.stringify({ messages: [{
            type: "fetch",
            requestId: "host-role-1",
            url: "vscode://codex/thread-role-for-host",
            method: "POST",
            body: JSON.stringify({ hostId: "local", conversationId: "thread-1" }),
          }] }),
        }),
        new URL("http://localhost/host-message"),
      );
      await expect(hostRoleResponse.json()).resolves.toEqual({ accepted: true });

      const hostFollowerResponse = await webview.fetch(
        new Request("http://localhost/host-message", {
          method: "POST",
          headers: { cookie: "codex_dispatcher_webview=secret", "x-dispatcher-client": "tab-1" },
          body: JSON.stringify({ messages: [{
            type: "fetch",
            requestId: "host-follower-1",
            url: "vscode://codex/thread-follower-start-turn-for-host",
            method: "POST",
            body: JSON.stringify({
              hostId: "local",
              conversationId: "thread-1",
              turnStartParams: { input: [{ type: "text", text: "from phone" }] },
            }),
          }] }),
        }),
        new URL("http://localhost/host-message"),
      );
      await expect(hostFollowerResponse.json()).resolves.toEqual({ accepted: true });
      expect(followerRequests).toEqual([
        {
          method: "thread-follower-start-turn",
          params: {
            conversationId: "thread-1",
            turnStartParams: { input: [{ type: "text", text: "from phone" }] },
          },
        },
      ]);

      const hostAssertResponse = await webview.fetch(
        new Request("http://localhost/host-message", {
          method: "POST",
          headers: { cookie: "codex_dispatcher_webview=secret", "x-dispatcher-client": "tab-1" },
          body: JSON.stringify({ messages: [{
            type: "fetch",
            requestId: "host-assert-1",
            url: "vscode://codex/assert-thread-follower-owner-for-host",
            method: "POST",
            body: JSON.stringify({ hostId: "local", conversationId: "thread-1" }),
          }] }),
        }),
        new URL("http://localhost/host-message"),
      );
      await expect(hostAssertResponse.json()).resolves.toEqual({ accepted: true });

      // Every reply arrives on one ordered channel, in causal order.
      const delivered = await stream.waitFor(3);
      await stream.cancel();
      expect(delivered.map((message) => message.type)).toEqual([
        "fetch-response",
        "fetch-response",
        "fetch-response",
      ]);
      expect(delivered[0]).toMatchObject({ requestId: "host-role-1", bodyJsonString: "\"follower\"" });
      expect(delivered[2]).toMatchObject({ requestId: "host-assert-1" });

      const debug = await webview.fetch(
        new Request("http://localhost/debug", {
          headers: { cookie: "codex_dispatcher_webview=secret" },
        }),
        new URL("http://localhost/debug"),
      );
      const snapshot = await debug.json();
      expect(snapshot.messageCounts).toMatchObject({
        "outbound:fetch-response": 3,
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

  test("replays pending host state to new event clients", async () => {
    const previousRoot = process.env.CODEX_EXTENSION_WEBVIEW_ROOT;
    const root = mkdtempSync(join(tmpdir(), "codex-webview-events-"));
    process.env.CODEX_EXTENSION_WEBVIEW_ROOT = root;
    writeFileSync(join(root, "index.html"), "<html><head></head><body></body></html>");

    try {
      const replayMessage = {
        type: "mcp-request",
        hostId: "local",
        request: { id: "req-1", method: "item/commandApproval", params: { threadId: "thread-1" } },
      };
      const webview = new ExtensionWebview({
        appServer: {} as never,
        defaultCwd: "/repo",
        getToken: () => "secret",
        getEventReplayMessages: () => [replayMessage],
      });

      const response = await webview.fetch(
        new Request("http://localhost/events", {
          headers: { cookie: "codex_dispatcher_webview=secret" },
        }),
        new URL("http://localhost/events"),
      );
      expect(response.status).toBe(200);

      const reader = response.body?.getReader();
      expect(reader).toBeDefined();
      let text = "";
      for (let index = 0; index < 3 && !text.includes("item/commandApproval"); index += 1) {
        const chunk = await reader?.read();
        if (chunk?.value) {
          text += new TextDecoder().decode(chunk.value);
        }
      }
      await reader?.cancel();

      expect(text).toContain(": connected");
      expect(text).toContain(`data: ${JSON.stringify(replayMessage)}`);
      expect(text).toMatch(/id: [0-9a-f-]+\.1\n/);
    } finally {
      if (previousRoot === undefined) {
        delete process.env.CODEX_EXTENSION_WEBVIEW_ROOT;
      } else {
        process.env.CODEX_EXTENSION_WEBVIEW_ROOT = previousRoot;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("replays events missed while the event stream was disconnected", async () => {
    const previousRoot = process.env.CODEX_EXTENSION_WEBVIEW_ROOT;
    const root = mkdtempSync(join(tmpdir(), "codex-webview-resume-"));
    process.env.CODEX_EXTENSION_WEBVIEW_ROOT = root;
    writeFileSync(join(root, "index.html"), "<html><head></head><body></body></html>");

    let replayCalls = 0;
    try {
      const webview = new ExtensionWebview({
        appServer: {} as never,
        defaultCwd: "/repo",
        getToken: () => "secret",
        getEventReplayMessages: () => {
          replayCalls += 1;
          return [{ type: "resync-snapshot" }];
        },
      });
      const openStream = async (lastEventId?: string) => {
        const headers: Record<string, string> = { cookie: "codex_dispatcher_webview=secret" };
        if (lastEventId !== undefined) {
          headers["last-event-id"] = lastEventId;
        }
        const response = await webview.fetch(
          new Request("http://localhost/events", { headers }),
          new URL("http://localhost/events"),
        );
        return response.body!.getReader();
      };
      const readAvailable = async (reader: ReadableStreamDefaultReader<Uint8Array>, chunks: number) => {
        let text = "";
        for (let index = 0; index < chunks; index += 1) {
          const chunk = await Promise.race([
            reader.read(),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), 150)),
          ]);
          if (!chunk?.value) {
            break;
          }
          text += new TextDecoder().decode(chunk.value);
        }
        return text;
      };

      const first = await openStream();
      const firstText = await readAvailable(first, 3);
      expect(firstText).toContain("resync-snapshot");
      await first.cancel();
      const epoch = firstText.match(/id: ([^.\n]+)\./)?.[1];
      expect(epoch).toBeDefined();

      // Events broadcast while nothing is listening must survive for the reconnect.
      webview.handleAppServerEvent({
        type: "notification",
        notification: { method: "codex/event/agent_message_delta", params: { delta: "from the app server" } },
      });
      webview.handleAppServerEvent({
        type: "notification",
        notification: { method: "codex/event/agent_message_delta", params: { delta: "missed while asleep" } },
      });

      const resumed = await openStream(`${epoch}.0`);
      const resumedText = await readAvailable(resumed, 4);
      await resumed.cancel();
      expect(resumedText).toContain("from the app server");
      expect(resumedText).toContain("missed while asleep");
      expect(resumedText).toContain(`id: ${epoch}.3`);
      // A resume replays the recorded stream; it must not regenerate state.
      expect(replayCalls).toBe(1);

      // An id the buffer cannot account for falls back to a full resynchronisation.
      const stale = await openStream(`${epoch}.9999`);
      const staleText = await readAvailable(stale, 3);
      await stale.cancel();
      expect(staleText).toContain("resync-snapshot");
    } finally {
      if (previousRoot === undefined) {
        delete process.env.CODEX_EXTENSION_WEBVIEW_ROOT;
      } else {
        process.env.CODEX_EXTENSION_WEBVIEW_ROOT = previousRoot;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("delivers replies produced before the webview managed to open its event stream", async () => {
    const previousRoot = process.env.CODEX_EXTENSION_WEBVIEW_ROOT;
    const root = mkdtempSync(join(tmpdir(), "codex-webview-race-"));
    process.env.CODEX_EXTENSION_WEBVIEW_ROOT = root;
    writeFileSync(join(root, "index.html"), "<html><head></head><body></body></html>");

    try {
      const webview = new ExtensionWebview({
        appServer: {} as never,
        defaultCwd: "/repo",
        getToken: () => "secret",
        statePath: join(root, "extension-state.json"),
        getEventReplayMessages: () => [{ type: "resync-snapshot" }],
      });

      // EventSource connects asynchronously, so a webview that posts during boot
      // can be answered before its stream exists.
      const accepted = await webview.fetch(
        new Request("http://localhost/host-message", {
          method: "POST",
          headers: { cookie: "codex_dispatcher_webview=secret", "x-dispatcher-client": "tab-1" },
          body: JSON.stringify({ messages: [{ type: "persisted-atom-sync-request" }] }),
        }),
        new URL("http://localhost/host-message"),
      );
      await expect(accepted.json()).resolves.toEqual({ accepted: true });

      const stream = await openEventStream(webview, "tab-1");
      const delivered = await stream.waitFor(2);
      await stream.cancel();
      // The buffered reply must not cost the tab its state snapshot: pending
      // approvals only ever arrive in the resync.
      expect(delivered).toEqual([{ type: "persisted-atom-sync", state: {} }, { type: "resync-snapshot" }]);
    } finally {
      if (previousRoot === undefined) {
        delete process.env.CODEX_EXTENSION_WEBVIEW_ROOT;
      } else {
        process.env.CODEX_EXTENSION_WEBVIEW_ROOT = previousRoot;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("keeps a reconnected event stream alive when the stale connection is torn down", async () => {
    const previousRoot = process.env.CODEX_EXTENSION_WEBVIEW_ROOT;
    const root = mkdtempSync(join(tmpdir(), "codex-webview-stale-"));
    process.env.CODEX_EXTENSION_WEBVIEW_ROOT = root;
    writeFileSync(join(root, "index.html"), "<html><head></head><body></body></html>");

    try {
      const webview = new ExtensionWebview({
        appServer: {} as never,
        defaultCwd: "/repo",
        getToken: () => "secret",
      });

      const stale = await openEventStream(webview, "tab-1");
      const reconnected = await openEventStream(webview, "tab-1");
      // The dead socket is only noticed after the tab already reconnected.
      await stale.cancel();

      webview.handleAppServerEvent({
        type: "notification",
        notification: { method: "codex/event/agent_message_delta", params: { delta: "from the app server" } },
      });

      const delivered = await reconnected.waitFor(1);
      await reconnected.cancel();
      expect(delivered.map((message) => message.type)).toEqual(["mcp-notification"]);
    } finally {
      if (previousRoot === undefined) {
        delete process.env.CODEX_EXTENSION_WEBVIEW_ROOT;
      } else {
        process.env.CODEX_EXTENSION_WEBVIEW_ROOT = previousRoot;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("hands the session to the newest tab instead of running two webviews", async () => {
    const previousRoot = process.env.CODEX_EXTENSION_WEBVIEW_ROOT;
    const root = mkdtempSync(join(tmpdir(), "codex-webview-tabs-"));
    process.env.CODEX_EXTENSION_WEBVIEW_ROOT = root;
    writeFileSync(join(root, "index.html"), "<html><head></head><body></body></html>");

    try {
      const webview = new ExtensionWebview({
        appServer: {} as never,
        defaultCwd: "/repo",
        getToken: () => "secret",
        statePath: join(root, "extension-state.json"),
      });

      const first = await openEventStream(webview, "tab-1");
      const second = await openEventStream(webview, "tab-2");

      webview.handleAppServerEvent({
        type: "notification",
        notification: { method: "codex/event/agent_message_delta", params: { delta: "from the app server" } },
      });

      // The displaced tab hears that it lost the seat and nothing after it: an
      // approval delivered to both tabs is answered twice, and the second
      // answer is an error from the app server.
      expect((await first.waitFor(1)).map((message) => message.type)).toEqual(["dispatcher-webview-superseded"]);
      expect((await second.waitFor(1)).map((message) => message.type)).toEqual(["mcp-notification"]);

      const late = await webview.fetch(
        new Request("http://localhost/host-message", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            cookie: "codex_dispatcher_webview=secret",
            "x-dispatcher-client": "tab-1",
          },
          body: JSON.stringify({ messages: [{ type: "ready" }] }),
        }),
        new URL("http://localhost/host-message"),
      );
      expect(late.status).toBe(409);

      await first.cancel();
      await second.cancel();
    } finally {
      if (previousRoot === undefined) {
        delete process.env.CODEX_EXTENSION_WEBVIEW_ROOT;
      } else {
        process.env.CODEX_EXTENSION_WEBVIEW_ROOT = previousRoot;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("keeps the seat with the newest tab when a backgrounded one reconnects", async () => {
    const previousRoot = process.env.CODEX_EXTENSION_WEBVIEW_ROOT;
    const root = mkdtempSync(join(tmpdir(), "codex-webview-reconnect-"));
    process.env.CODEX_EXTENSION_WEBVIEW_ROOT = root;
    writeFileSync(join(root, "index.html"), "<html><head></head><body></body></html>");

    try {
      const webview = new ExtensionWebview({
        appServer: {} as never,
        defaultCwd: "/repo",
        getToken: () => "secret",
        statePath: join(root, "extension-state.json"),
      });

      const broadcast = (conversationId: string) => {
        webview.handleAppServerEvent({
          type: "notification",
          notification: { method: "codex/event/agent_message_delta", params: { conversationId } },
        });
      };

      const first = await openEventStream(webview, "tab-1");
      broadcast("thread-1");
      await first.waitFor(1);
      const resumeFrom = first.lastEventId()!;
      // A phone putting the tab in the background kills the SSE socket; the page
      // stays alive and its EventSource will reconnect on its own.
      await first.cancel();

      const second = await openEventStream(webview, "tab-2");
      const reconnected = await openEventStream(webview, "tab-1", resumeFrom);

      broadcast("thread-2");

      // The reconnect only continues tab-1's old stream, so the session stays
      // with the tab the user actually opened last.
      expect((await second.waitFor(1)).map((message) => message.type)).toEqual(["mcp-notification"]);
      expect((await reconnected.waitFor(1)).map((message) => message.type)).toEqual([
        "dispatcher-webview-superseded",
      ]);

      await second.cancel();
      await reconnected.cancel();
    } finally {
      if (previousRoot === undefined) {
        delete process.env.CODEX_EXTENSION_WEBVIEW_ROOT;
      } else {
        process.env.CODEX_EXTENSION_WEBVIEW_ROOT = previousRoot;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("resumes a snapshot that was cut in half instead of dropping its tail", async () => {
    const previousRoot = process.env.CODEX_EXTENSION_WEBVIEW_ROOT;
    const root = mkdtempSync(join(tmpdir(), "codex-webview-snapshot-"));
    process.env.CODEX_EXTENSION_WEBVIEW_ROOT = root;
    writeFileSync(join(root, "index.html"), "<html><head></head><body></body></html>");

    try {
      const webview = new ExtensionWebview({
        appServer: {} as never,
        defaultCwd: "/repo",
        getToken: () => "secret",
        statePath: join(root, "extension-state.json"),
        getEventReplayMessages: () => [
          { type: "mcp-request", request: { id: "approval-1" } },
          { type: "thread-snapshot", conversationId: "thread-1" },
          { type: "thread-snapshot", conversationId: "thread-2" },
        ],
      });

      const first = await openEventStream(webview, "tab-1");
      const seen = await first.waitFor(1);
      expect(seen[0]).toEqual({ type: "mcp-request", request: { id: "approval-1" } });
      const lastEventId = first.lastEventId();
      await first.cancel();

      // The tab acknowledged only the approval; the rest of the snapshot must
      // still be reachable, otherwise the turn stalls with no prompt.
      const resumed = await openEventStream(webview, "tab-1", lastEventId!);
      const delivered = await resumed.waitFor(2);
      await resumed.cancel();
      expect(delivered).toEqual([
        { type: "thread-snapshot", conversationId: "thread-1" },
        { type: "thread-snapshot", conversationId: "thread-2" },
      ]);
    } finally {
      if (previousRoot === undefined) {
        delete process.env.CODEX_EXTENSION_WEBVIEW_ROOT;
      } else {
        process.env.CODEX_EXTENSION_WEBVIEW_ROOT = previousRoot;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("ignores a Last-Event-ID from an earlier incarnation of the same client", async () => {
    const previousRoot = process.env.CODEX_EXTENSION_WEBVIEW_ROOT;
    const root = mkdtempSync(join(tmpdir(), "codex-webview-epoch-"));
    process.env.CODEX_EXTENSION_WEBVIEW_ROOT = root;
    writeFileSync(join(root, "index.html"), "<html><head></head><body></body></html>");

    try {
      const webview = new ExtensionWebview({
        appServer: {} as never,
        defaultCwd: "/repo",
        getToken: () => "secret",
        statePath: join(root, "extension-state.json"),
        getEventReplayMessages: () => [{ type: "resync-snapshot" }],
      });

      await webview.fetch(
        new Request("http://localhost/host-message", {
          method: "POST",
          headers: { cookie: "codex_dispatcher_webview=secret", "x-dispatcher-client": "tab-1" },
          body: JSON.stringify({ messages: [{ type: "persisted-atom-sync-request" }] }),
        }),
        new URL("http://localhost/host-message"),
      );

      // Sequence numbers restarted with this client record; the browser still
      // remembers an id from before, and must not be resumed against it.
      const stream = await openEventStream(webview, "tab-1", "00000000-0000-4000-8000-000000000000.7");
      const delivered = await stream.waitFor(2);
      await stream.cancel();
      expect(delivered).toEqual([{ type: "persisted-atom-sync", state: {} }, { type: "resync-snapshot" }]);
    } finally {
      if (previousRoot === undefined) {
        delete process.env.CODEX_EXTENSION_WEBVIEW_ROOT;
      } else {
        process.env.CODEX_EXTENSION_WEBVIEW_ROOT = previousRoot;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reports threads the webview drives so the dispatcher can own them", async () => {
    const previousRoot = process.env.CODEX_EXTENSION_WEBVIEW_ROOT;
    const root = mkdtempSync(join(tmpdir(), "codex-webview-owner-"));
    process.env.CODEX_EXTENSION_WEBVIEW_ROOT = root;
    writeFileSync(join(root, "index.html"), "<html><head></head><body></body></html>");
    const active: string[] = [];

    try {
      const webview = new ExtensionWebview({
        appServer: {
          request: async (method: string) =>
            method === "thread/start" ? { thread: { id: "thread-new" } } : { ok: true },
        } as never,
        defaultCwd: "/repo",
        getToken: () => "secret",
        statePath: join(root, "extension-state.json"),
        onThreadActivity: (method, conversationId) => active.push(`${method}:${conversationId}`),
      });
      const postHostMessage = (body: unknown) =>
        webview.fetch(
          new Request("http://localhost/host-message", {
            method: "POST",
            headers: { cookie: "codex_dispatcher_webview=secret", "x-dispatcher-client": "tab-1" },
            body: JSON.stringify({ messages: [body] }),
          }),
          new URL("http://localhost/host-message"),
        );

      await postHostMessage({ type: "mcp-request", request: { id: 1, method: "thread/start", params: {} } });
      await postHostMessage({
        type: "mcp-request",
        request: { id: 2, method: "turn/start", params: { threadId: "thread-new", input: [] } },
      });
      await postHostMessage({ type: "mcp-request", request: { id: 3, method: "model/list", params: {} } });
      await postHostMessage({
        type: "mcp-request",
        request: { id: 4, method: "thread/read", params: { threadId: "someone-elses" } },
      });

      // The ack does not wait for the app server call, so let the last dispatch land.
      await Bun.sleep(20);

      // A thread this webview created or ran a turn on lives on our app server,
      // which is what makes the dispatcher its owner. Reading one does not.
      expect(active).toEqual(["thread/start:thread-new", "turn/start:thread-new", "thread/read:someone-elses"]);
    } finally {
      if (previousRoot === undefined) {
        delete process.env.CODEX_EXTENSION_WEBVIEW_ROOT;
      } else {
        process.env.CODEX_EXTENSION_WEBVIEW_ROOT = previousRoot;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("forwards webview mcp-response errors and numeric request ids to the app server", async () => {
    const previousRoot = process.env.CODEX_EXTENSION_WEBVIEW_ROOT;
    const root = mkdtempSync(join(tmpdir(), "codex-webview-mcp-"));
    process.env.CODEX_EXTENSION_WEBVIEW_ROOT = root;
    writeFileSync(join(root, "index.html"), "<html><head></head><body></body></html>");
    const answered: Array<{ id: string; response: unknown }> = [];

    try {
      const webview = new ExtensionWebview({
        appServer: {
          request: async (method: string) => ({ echoed: method }),
          respondToServerRequest: (id: string, response: unknown) => answered.push({ id, response }),
        } as never,
        defaultCwd: "/repo",
        getToken: () => "secret",
      });
      const stream = await openEventStream(webview, "tab-1");
      const postHostMessage = (body: unknown) =>
        webview.fetch(
          new Request("http://localhost/host-message", {
            method: "POST",
            headers: { cookie: "codex_dispatcher_webview=secret", "x-dispatcher-client": "tab-1" },
            body: JSON.stringify({ messages: [body] }),
          }),
          new URL("http://localhost/host-message"),
        );

      await postHostMessage({ type: "mcp-response", response: { id: 7, error: { message: "denied" } } });
      await postHostMessage({ type: "mcp-response", response: { id: "8", result: { decision: "approved" } } });
      expect(answered).toEqual([
        { id: "7", response: { error: { message: "denied" } } },
        { id: "8", response: { result: { decision: "approved" } } },
      ]);

      await postHostMessage({
        type: "mcp-request",
        request: { id: 11, method: "thread/read", params: {} },
      });
      const [reply] = await stream.waitFor(1);
      await stream.cancel();
      expect(reply).toEqual({
        type: "mcp-response",
        hostId: "local",
        message: { id: 11, result: { echoed: "thread/read" } },
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

  test("reports who is on the bus and which threads are ours", async () => {
    const previousRoot = process.env.CODEX_EXTENSION_WEBVIEW_ROOT;
    const root = mkdtempSync(join(tmpdir(), "codex-webview-bridge-state-"));
    process.env.CODEX_EXTENSION_WEBVIEW_ROOT = root;
    writeFileSync(join(root, "index.html"), "<html><head></head><body></body></html>");

    try {
      const webview = new ExtensionWebview({
        appServer: {} as never,
        defaultCwd: "/repo",
        getToken: () => "secret",
        getBridgeState: () => ({
          ipc: { status: "connected", peers: [{ clientId: "vscode-1", clientType: "vscode" }] },
          ownedThreads: [{ threadId: "thread-1", revision: 3, followers: ["vscode-1"] }],
        }),
      });

      const response = await webview.fetch(
        new Request("http://localhost/debug", { headers: { cookie: "codex_dispatcher_webview=secret" } }),
        new URL("http://localhost/debug"),
      );
      const snapshot = await response.json();

      expect(snapshot.bridge).toEqual({
        ipc: { status: "connected", peers: [{ clientId: "vscode-1", clientType: "vscode" }] },
        ownedThreads: [{ threadId: "thread-1", revision: 3, followers: ["vscode-1"] }],
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

  // The webview matches on the app server's exact wording to tell a stop that
  // lost a race from a stop that failed, so the error reaches it unedited.
  test("hands the app server's own error to the webview", async () => {
    const previousRoot = process.env.CODEX_EXTENSION_WEBVIEW_ROOT;
    const root = mkdtempSync(join(tmpdir(), "codex-webview-mcp-error-"));
    process.env.CODEX_EXTENSION_WEBVIEW_ROOT = root;
    writeFileSync(join(root, "index.html"), "<html><head></head><body></body></html>");

    try {
      const webview = new ExtensionWebview({
        appServer: {
          request: async (method: string) => {
            throw new AppServerError(method, "no active turn to interrupt", {
              code: -32603,
              message: "no active turn to interrupt",
            });
          },
        } as never,
        defaultCwd: "/repo",
        getToken: () => "secret",
      });
      const stream = await openEventStream(webview, "tab-1");
      await webview.fetch(
        new Request("http://localhost/host-message", {
          method: "POST",
          headers: { cookie: "codex_dispatcher_webview=secret", "x-dispatcher-client": "tab-1" },
          body: JSON.stringify({
            messages: [{ type: "mcp-request", request: { id: 3, method: "turn/interrupt", params: {} } }],
          }),
        }),
        new URL("http://localhost/host-message"),
      );

      const [reply] = await stream.waitFor(1);
      await stream.cancel();
      expect(reply).toEqual({
        type: "mcp-response",
        hostId: "local",
        message: { id: 3, error: { code: -32603, message: "no active turn to interrupt" } },
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

  test("starts batched host messages in order without letting a slow one block the rest", async () => {
    const previousRoot = process.env.CODEX_EXTENSION_WEBVIEW_ROOT;
    const root = mkdtempSync(join(tmpdir(), "codex-webview-fifo-"));
    process.env.CODEX_EXTENSION_WEBVIEW_ROOT = root;
    writeFileSync(join(root, "index.html"), "<html><head></head><body></body></html>");
    const origin = Bun.serve({
      port: 0,
      async fetch() {
        await Bun.sleep(150);
        return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
      },
    });

    try {
      const webview = new ExtensionWebview({
        appServer: {} as never,
        defaultCwd: "/repo",
        getToken: () => "secret",
        statePath: join(root, "extension-state.json"),
      });
      const stream = await openEventStream(webview, "tab-1");

      const accepted = await webview.fetch(
        new Request("http://localhost/host-message", {
          method: "POST",
          headers: { cookie: "codex_dispatcher_webview=secret", "x-dispatcher-client": "tab-1" },
          body: JSON.stringify({
            messages: [
              { type: "fetch", requestId: "slow", url: `${origin.url.origin}/slow`, method: "GET" },
              { type: "persisted-atom-sync-request" },
            ],
          }),
        }),
        new URL("http://localhost/host-message"),
      );
      // The ack must not wait for the network call the first message started.
      await expect(accepted.json()).resolves.toEqual({ accepted: true });

      // Messages that answer at the same speed keep their send order.
      await webview.fetch(
        new Request("http://localhost/host-message", {
          method: "POST",
          headers: { cookie: "codex_dispatcher_webview=secret", "x-dispatcher-client": "tab-1" },
          body: JSON.stringify({
            messages: [
              { type: "shared-object-subscribe", key: "workspace" },
              { type: "persisted-atom-sync-request" },
            ],
          }),
        }),
        new URL("http://localhost/host-message"),
      );

      const delivered = await stream.waitFor(4, 3_000);
      await stream.cancel();
      expect(delivered.map((message) => message.type)).toEqual([
        "persisted-atom-sync",
        "shared-object-updated",
        "persisted-atom-sync",
        "fetch-response",
      ]);
    } finally {
      await origin.stop(true);
      if (previousRoot === undefined) {
        delete process.env.CODEX_EXTENSION_WEBVIEW_ROOT;
      } else {
        process.env.CODEX_EXTENSION_WEBVIEW_ROOT = previousRoot;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reports completed non-2xx fetches as success so the webview keeps the error body", async () => {
    const previousRoot = process.env.CODEX_EXTENSION_WEBVIEW_ROOT;
    const root = mkdtempSync(join(tmpdir(), "codex-webview-fetch-"));
    process.env.CODEX_EXTENSION_WEBVIEW_ROOT = root;
    writeFileSync(join(root, "index.html"), "<html><head></head><body></body></html>");
    const origin = Bun.serve({
      port: 0,
      fetch(request) {
        if (new URL(request.url).pathname === "/rate-limited") {
          return new Response(JSON.stringify({ detail: "slow down", retry_after: 30 }), {
            status: 429,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
      },
    });

    try {
      const webview = new ExtensionWebview({
        appServer: {} as never,
        defaultCwd: "/repo",
        getToken: () => "secret",
      });
      const stream = await openEventStream(webview, "tab-1");
      let delivered = 0;
      const postFetch = async (path: string) => {
        await webview.fetch(
          new Request("http://localhost/host-message", {
            method: "POST",
            headers: { cookie: "codex_dispatcher_webview=secret", "x-dispatcher-client": "tab-1" },
            body: JSON.stringify({ messages: [{
              type: "fetch",
              requestId: `req-${path}`,
              url: `${origin.url.origin}${path}`,
              method: "GET",
            }] }),
          }),
          new URL("http://localhost/host-message"),
        );
        delivered += 1;
        const messages = await stream.waitFor(delivered);
        return messages[delivered - 1] as { responseType: string; status: number; bodyJsonString: string };
      };

      const failed = await postFetch("/rate-limited");
      expect(failed).toMatchObject({ responseType: "success", status: 429 });
      expect(JSON.parse(failed.bodyJsonString)).toEqual({ detail: "slow down", retry_after: 30 });

      const succeeded = await postFetch("/ok");
      expect(succeeded).toMatchObject({ responseType: "success", status: 200 });
      expect(JSON.parse(succeeded.bodyJsonString)).toEqual({ ok: true });
      await stream.cancel();
    } finally {
      await origin.stop(true);
      if (previousRoot === undefined) {
        delete process.env.CODEX_EXTENSION_WEBVIEW_ROOT;
      } else {
        process.env.CODEX_EXTENSION_WEBVIEW_ROOT = previousRoot;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("persists extension host state across webview host restarts", async () => {
    const previousRoot = process.env.CODEX_EXTENSION_WEBVIEW_ROOT;
    const root = mkdtempSync(join(tmpdir(), "codex-webview-state-"));
    const statePath = join(root, "state", "extension-state.json");
    process.env.CODEX_EXTENSION_WEBVIEW_ROOT = root;
    writeFileSync(join(root, "index.html"), "<html><head></head><body></body></html>");

    try {
      const firstHost = new ExtensionWebview({
        appServer: {} as never,
        defaultCwd: "/repo",
        getToken: () => "secret",
        statePath,
      });
      const firstStream = await openEventStream(firstHost, "tab-1");

      const atomUpdate = await firstHost.fetch(
        new Request("http://localhost/host-message", {
          method: "POST",
          headers: { cookie: "codex_dispatcher_webview=secret", "x-dispatcher-client": "tab-1" },
          body: JSON.stringify({ messages: [{
            type: "persisted-atom-update",
            key: "onboarding.complete",
            value: { done: true },
          }] }),
        }),
        new URL("http://localhost/host-message"),
      );
      await expect(atomUpdate.json()).resolves.toEqual({ accepted: true });

      const globalUpdate = await firstHost.fetch(
        new Request("http://localhost/host-message", {
          method: "POST",
          headers: { cookie: "codex_dispatcher_webview=secret", "x-dispatcher-client": "tab-1" },
          body: JSON.stringify({ messages: [{
            type: "fetch",
            requestId: "set-global",
            url: "vscode://codex/set-global-state",
            method: "POST",
            body: JSON.stringify({ key: "welcome.dismissed", value: true }),
          }] }),
        }),
        new URL("http://localhost/host-message"),
      );
      await expect(globalUpdate.json()).resolves.toEqual({ accepted: true });
      expect(await firstStream.waitFor(2)).toEqual([
        {
          type: "persisted-atom-updated",
          key: "onboarding.complete",
          value: { done: true },
          deleted: false,
        },
        {
          type: "fetch-response",
          responseType: "success",
          requestId: "set-global",
          status: 200,
          headers: {},
          bodyJsonString: "{\"success\":true}",
        },
      ]);
      await firstStream.cancel();

      expect(JSON.parse(readFileSync(statePath, "utf8"))).toEqual({
        globalState: { "welcome.dismissed": true },
        persistedAtomState: { "onboarding.complete": { done: true } },
      });
      expect(statSync(statePath).mode & 0o777).toBe(0o600);

      const restartedHost = new ExtensionWebview({
        appServer: {} as never,
        defaultCwd: "/repo",
        getToken: () => "secret",
        statePath,
      });
      const restartedStream = await openEventStream(restartedHost, "tab-1");

      const readyResponse = await restartedHost.fetch(
        new Request("http://localhost/host-message", {
          method: "POST",
          headers: { cookie: "codex_dispatcher_webview=secret", "x-dispatcher-client": "tab-1" },
          body: JSON.stringify({ messages: [{ type: "ready" }] }),
        }),
        new URL("http://localhost/host-message"),
      );
      await expect(readyResponse.json()).resolves.toEqual({ accepted: true });
      expect(await restartedStream.waitFor(3)).toEqual([
        { type: "chat-font-settings", chatFontSize: null, chatCodeFontSize: null },
        { type: "custom-prompts-updated", prompts: [] },
        { type: "persisted-atom-sync", state: { "onboarding.complete": { done: true } } },
      ]);

      const globalRead = await restartedHost.fetch(
        new Request("http://localhost/host-message", {
          method: "POST",
          headers: { cookie: "codex_dispatcher_webview=secret", "x-dispatcher-client": "tab-1" },
          body: JSON.stringify({ messages: [{
            type: "fetch",
            requestId: "get-global",
            url: "vscode://codex/get-global-state",
            method: "POST",
            body: JSON.stringify({ key: "welcome.dismissed" }),
          }] }),
        }),
        new URL("http://localhost/host-message"),
      );
      await expect(globalRead.json()).resolves.toEqual({ accepted: true });
      expect((await restartedStream.waitFor(4))[3]).toEqual({
        type: "fetch-response",
        responseType: "success",
        requestId: "get-global",
        status: 200,
        headers: {},
        bodyJsonString: "{\"value\":true}",
      });
      await restartedStream.cancel();
    } finally {
      if (previousRoot === undefined) {
        delete process.env.CODEX_EXTENSION_WEBVIEW_ROOT;
      } else {
        process.env.CODEX_EXTENSION_WEBVIEW_ROOT = previousRoot;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("keeps two hosts in one process on their own state", async () => {
    const previousRoot = process.env.CODEX_EXTENSION_WEBVIEW_ROOT;
    const root = mkdtempSync(join(tmpdir(), "codex-webview-two-hosts-"));
    process.env.CODEX_EXTENSION_WEBVIEW_ROOT = root;
    writeFileSync(join(root, "index.html"), "<html><head></head><body></body></html>");

    const host = (statePath: string) =>
      new ExtensionWebview({
        appServer: {} as never,
        defaultCwd: "/repo",
        getToken: () => "secret",
        statePath,
      });
    const post = (webview: ExtensionWebview, message: JsonRecord) =>
      webview.fetch(
        new Request("http://localhost/host-message", {
          method: "POST",
          headers: { cookie: "codex_dispatcher_webview=secret", "x-dispatcher-client": "tab-1" },
          body: JSON.stringify({ messages: [message] }),
        }),
        new URL("http://localhost/host-message"),
      );

    try {
      const firstPath = join(root, "first", "extension-state.json");
      const secondPath = join(root, "second", "extension-state.json");
      const first = host(firstPath);
      const second = host(secondPath);
      const secondStream = await openEventStream(second, "tab-1");

      await post(first, { type: "persisted-atom-update", key: "onboarding.complete", value: { done: true } });
      await post(second, { type: "ready" });

      // The second host was constructed first-come-last-served under the old
      // module-level state: it would answer with the other host's atoms.
      expect((await secondStream.waitFor(3))[2]).toEqual({ type: "persisted-atom-sync", state: {} });
      expect(existsSync(secondPath)).toBe(false);
      expect(JSON.parse(readFileSync(firstPath, "utf8"))).toEqual({
        globalState: {},
        persistedAtomState: { "onboarding.complete": { done: true } },
      });

      await secondStream.cancel();
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

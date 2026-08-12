import { timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir, platform, release } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { AppServerError } from "./codex-app-server";
import type {
  CodexAppServer,
  CodexAppServerEvent,
  JsonObject,
  JsonValue,
  ServerRequestResponse,
} from "./codex-app-server";
import type { IpcBroadcastMessage } from "./codex-ipc";
import {
  pwaHeadTags,
  pwaIconFilePath,
  pwaIconPath,
  pwaManifest,
  pwaManifestPath,
  pwaServiceWorkerPath,
  pwaServiceWorkerSource,
} from "./pwa";
import { ExtensionState, extensionStatePath } from "./extension-state";
import { cookieValues, isRecord, jsonResponse } from "./shared";
import { WebviewRpcSession, parseRpcConnect, parseRpcMessage, type WebviewIpcCoordination } from "./webview-rpc";

type HostMessage = JsonObject & {
  type?: string;
  id?: string;
  request?: JsonObject;
  response?: JsonObject;
  requestId?: string;
  url?: string;
  body?: string;
  method?: string;
  workerId?: string;
  hostId?: string;
  conversationId?: string;
  params?: JsonValue;
};

type ExtensionWebviewOptions = {
  appServer: CodexAppServer;
  defaultCwd: string;
  getToken: () => string;
  getEventReplayMessages?: () => JsonObject[];
  statePath?: string;
  assertThreadFollowerOwner?: (conversationId: string) => Promise<void> | void;
  getThreadRole?: (conversationId: string) => string | Promise<string>;
  handleFollowerRequest?: (method: string, params: JsonValue) => Promise<JsonValue>;
  ipcCoordination?: WebviewIpcCoordination;
  onThreadActivity?: (method: string, conversationId: string, thread?: JsonObject) => void;
};

// One ordered delivery channel per webview instance. VS Code hands the webview a
// single FIFO postMessage pipe; responses and broadcasts arriving over separate
// transports could otherwise be observed out of causal order.
type StreamClient = {
  id: string;
  epoch: string;
  controller: ReadableStreamDefaultController<Uint8Array> | null;
  heartbeat: ReturnType<typeof setInterval> | null;
  seq: number;
  buffer: { id: number; payload: JsonObject }[];
  detachedAt: number | null;
};

type FetchResponseOptions = {
  requestId: string | undefined;
  result?: JsonValue;
  error?: string;
  status?: number;
};

const routePrefix = "";
// Distinct from the relay's own `codex_dispatcher_session`: the relay sets that
// one on `.<relay domain>`, so a same-named cookie from us would be sent
// alongside it and the relay would read whichever the browser listed first.
const authCookieName = "codex_dispatcher_webview";
const encoder = new TextEncoder();
const maxDiagnosticMessages = 200;
// The webview only settles a pending fetch when a fetch-response arrives, and that
// response rides back in the /host-message POST body. Relay-proxied requests are
// given up on after 30s (relay-server startTimeout) and the connection is idle-closed
// after 60s, so a host fetch that outlives either would leave the webview waiting
// forever. Stay under the strictest link in that chain.
const externalFetchTimeoutMs = 25_000;
const maxReplayEvents = 500;
const detachedClientRetentionMs = 5 * 60_000;
// The follower endpoints the webview actually calls (its `requestThreadFollower`
// switch). Names it no longer knows would sit here answering nobody.
const hostFollowerEndpointMethods: Record<string, string> = {
  "thread-follower-start-turn-for-host": "thread-follower-start-turn",
  "thread-follower-load-complete-history-for-host": "thread-follower-load-complete-history",
  "thread-follower-steer-turn-for-host": "thread-follower-steer-turn",
  "thread-follower-interrupt-turn-for-host": "thread-follower-interrupt-turn",
  "thread-follower-compact-thread-for-host": "thread-follower-compact-thread",
  "thread-follower-update-thread-settings-for-host": "thread-follower-update-thread-settings",
  "thread-follower-edit-last-user-turn-for-host": "thread-follower-edit-last-user-turn",
  "thread-follower-command-approval-decision-for-host": "thread-follower-command-approval-decision",
  "thread-follower-file-approval-decision-for-host": "thread-follower-file-approval-decision",
  "thread-follower-permissions-request-approval-response-for-host": "thread-follower-permissions-request-approval-response",
  "thread-follower-submit-user-input-for-host": "thread-follower-submit-user-input",
  "thread-follower-submit-mcp-server-elicitation-response-for-host": "thread-follower-submit-mcp-server-elicitation-response",
};

export class ExtensionWebview {
  private readonly appServer: CodexAppServer;
  private readonly defaultCwd: string;
  private readonly getToken: () => string;
  private readonly getEventReplayMessages: (() => JsonObject[]) | undefined;
  private readonly assertThreadFollowerOwner: ((conversationId: string) => Promise<void> | void) | undefined;
  private readonly getThreadRole: ((conversationId: string) => string | Promise<string>) | undefined;
  private readonly handleFollowerRequest: ((method: string, params: JsonValue) => Promise<JsonValue>) | undefined;
  private readonly ipcCoordination: WebviewIpcCoordination | undefined;
  private readonly onThreadActivity: ((method: string, conversationId: string, thread?: JsonObject) => void) | undefined;
  private readonly clients = new Map<string, StreamClient>();
  // One RPC session per webview, exactly as VS Code keys them by webview.
  private readonly rpcSessions = new Map<string, WebviewRpcSession>();
  // VS Code hosts exactly one webview, and the extension is written for that:
  // an approval it answers twice is an error, and per-tab host replies drift
  // apart. The tab that opened a stream last is the one webview we admit.
  private activeClientId: string | null = null;
  private readonly startedAt = new Date().toISOString();
  private readonly messageCounts = new Map<string, number>();
  private readonly recentMessages: JsonObject[] = [];
  private readonly hostErrors: JsonObject[] = [];
  private readonly experimentalEnablementSetResults = new Map<string, JsonValue>();
  private readonly webviewRoot: string | null;
  private readonly state: ExtensionState;

  constructor(options: ExtensionWebviewOptions) {
    this.appServer = options.appServer;
    this.defaultCwd = options.defaultCwd;
    this.getToken = options.getToken;
    this.getEventReplayMessages = options.getEventReplayMessages;
    this.assertThreadFollowerOwner = options.assertThreadFollowerOwner;
    this.getThreadRole = options.getThreadRole;
    this.handleFollowerRequest = options.handleFollowerRequest;
    this.ipcCoordination = options.ipcCoordination;
    this.onThreadActivity = options.onThreadActivity;
    this.state = new ExtensionState(options.statePath ?? extensionStatePath());
    this.webviewRoot = resolveExtensionWebviewRoot();
  }

  async fetch(request: Request, url: URL): Promise<Response> {
    if (!this.webviewRoot) {
      return new Response("Codex VS Code extension webview was not found.", { status: 404 });
    }

    // The install metadata carries no secrets and the browser fetches the
    // manifest without our session cookie, so it stays outside the token gate.
    if (url.pathname === pwaManifestPath) {
      return new Response(pwaManifest(), {
        headers: { "content-type": "application/manifest+json; charset=utf-8" },
      });
    }

    if (url.pathname === pwaServiceWorkerPath) {
      return new Response(pwaServiceWorkerSource, {
        headers: { "content-type": "text/javascript; charset=utf-8", "service-worker-allowed": "/" },
      });
    }

    if (url.pathname === pwaIconPath) {
      return serveFile(pwaIconFilePath(this.webviewRoot));
    }

    if (!this.isAuthorized(request, url)) {
      return new Response("Unauthorized", { status: 401 });
    }

    if (url.pathname === `${routePrefix}/host-message`) {
      return this.handleHostMessage(request);
    }

    if (url.pathname === `${routePrefix}/events`) {
      return this.openEventStream(request);
    }

    if (url.pathname === `${routePrefix}/debug`) {
      return jsonResponse(this.debugSnapshot());
    }

    if (url.pathname === routePrefix || url.pathname === `${routePrefix}/` || url.pathname === `${routePrefix}/index.html`) {
      return this.serveIndex(request, url);
    }

    return this.serveAsset(url.pathname);
  }

  handleIpcBroadcast(broadcastMessage: IpcBroadcastMessage): void {
    this.recordMessage("outbound", { type: "ipc-broadcast", method: broadcastMessage.method });
    this.pruneDetachedClients();
    for (const [clientId, session] of this.rpcSessions) {
      if (!this.clients.has(clientId)) {
        session.dispose();
        this.rpcSessions.delete(clientId);
        continue;
      }
      session.deliverBroadcast(broadcastMessage);
    }
  }

  handleAppServerEvent(event: CodexAppServerEvent): void {
    if (event.type === "notification") {
      const { method, params } = event.notification;
      if (typeof method === "string") {
        this.broadcast({ type: "mcp-notification", hostId: "local", method, params: params ?? {} });
      }
      return;
    }

    if (event.type === "serverRequest") {
      this.broadcast({
        type: "mcp-request",
        hostId: "local",
        request: {
          id: event.request.id,
          method: event.request.method,
          params: event.request.params,
        },
      });
      return;
    }

    if (event.type === "status" && event.status === "exited") {
      this.broadcast({
        type: "codex-app-server-fatal-error",
        errorMessage: event.detail ?? "codex app-server exited",
        cliErrorMessage: null,
      });
    }
  }

  private isAuthorized(request: Request, url: URL): boolean {
    const token = this.getToken();
    return (
      secretEquals(url.searchParams.get("token"), token) ||
      secretEquals(request.headers.get("x-dispatcher-token"), token) ||
      cookieValues(request.headers.get("cookie"), authCookieName).some((value) => secretEquals(value, token))
    );
  }

  private async serveIndex(request: Request, url: URL): Promise<Response> {
    const indexPath = join(this.webviewRoot!, "index.html");
    let html = await Bun.file(indexPath).text();
    html = html.replace("<!-- PROD_BASE_TAG_HERE -->", `<base href="${routePrefix}/">`);
    html = html.replace("<!-- PROD_CSP_TAG_HERE -->", "");
    const defaultViewportMeta = '<meta name="viewport" content="width=device-width, initial-scale=1.0" />';
    if (html.includes(defaultViewportMeta)) {
      html = html.replace(defaultViewportMeta, this.buildViewportMeta());
    } else {
      html = html.replace("<head>", `<head>\n${this.buildViewportMeta()}`);
    }
    html = html.replace(
      "<head>",
      `<head>\n${pwaHeadTags()}\n${this.buildViewportStyle()}\n${this.buildShim(url.searchParams.get("token") ?? "")}`,
    );

    const headers = new Headers({ "content-type": "text/html; charset=utf-8" });
    if (secretEquals(url.searchParams.get("token"), this.getToken())) {
      headers.append("set-cookie", authCookie(this.getToken(), isSecureRequest(request, url)));
    }

    return new Response(html, { headers });
  }

  private buildViewportMeta(): string {
    return `<meta name="viewport" content="width=device-width, initial-scale=1, minimum-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover, interactive-widget=resizes-visual">`;
  }

  private async serveAsset(pathname: string): Promise<Response> {
    const assetPath = resolveWebviewAssetPath(this.webviewRoot!, pathname);
    if (!assetPath) {
      return new Response("Not found", { status: 404 });
    }

    return serveFile(assetPath);
  }

  private buildViewportStyle(): string {
    return `<style>
html {
  -webkit-text-size-adjust: 100% !important;
  text-size-adjust: 100% !important;
  font-size: 16px !important;
  --codex-window-zoom: 1 !important;
}

*,
*::before,
*::after {
  -webkit-text-size-adjust: 100% !important;
  text-size-adjust: 100% !important;
  zoom: 1 !important;
}

html,
body {
  width: var(--codex-dispatcher-viewport-width, 100vw) !important;
  max-width: var(--codex-dispatcher-viewport-width, 100vw) !important;
  height: var(--codex-dispatcher-viewport-height, 100vh) !important;
  height: var(--codex-dispatcher-viewport-height, 100dvh) !important;
  max-height: var(--codex-dispatcher-viewport-height, 100vh) !important;
  max-height: var(--codex-dispatcher-viewport-height, 100dvh) !important;
  min-width: 0;
  min-height: 0;
  margin: 0;
  padding: 0;
  overflow: hidden !important;
  overscroll-behavior: none;
  scrollbar-width: none;
  touch-action: manipulation;
}

html::-webkit-scrollbar,
body::-webkit-scrollbar {
  display: none;
}

body {
  position: fixed !important;
  inset: 0 auto auto 0 !important;
}

#root {
  width: var(--codex-dispatcher-viewport-width, 100vw) !important;
  height: var(--codex-dispatcher-viewport-height, 100vh) !important;
  height: var(--codex-dispatcher-viewport-height, 100dvh) !important;
  max-height: var(--codex-dispatcher-viewport-height, 100vh) !important;
  max-height: var(--codex-dispatcher-viewport-height, 100dvh) !important;
  min-width: 0;
  min-height: 0;
  overflow: hidden !important;
  position: fixed !important;
  top: 0 !important;
  left: 0 !important;
  right: auto !important;
  bottom: auto !important;
  transform: translate3d(
    var(--codex-dispatcher-viewport-offset-left, 0px),
    var(--codex-dispatcher-viewport-offset-top, 0px),
    0
  ) !important;
}

input,
textarea,
select,
[contenteditable="true"],
.ProseMirror,
.cm-editor,
.cm-content {
  font-size: max(16px, 1rem) !important;
}
</style>`;
  }

  private async handleHostMessage(request: Request): Promise<Response> {
    const client = this.clientFor(clientIdFromRequest(request));

    let batch: HostMessage[];
    try {
      batch = parseHostMessageBatch(await request.json());
    } catch {
      this.send(client, { type: "host-message-error", error: "Malformed host-message batch", sourceType: "unknown" });
      return jsonResponse({ accepted: false }, 400);
    }

    // Checked after the body is read, not before: another tab can take the seat
    // while we await it, and a batch dispatched past that point would drive the
    // session from two webviews at once.
    if (this.activeClientId !== null && this.activeClientId !== client.id) {
      this.send(client, { type: "dispatcher-webview-superseded" });
      return jsonResponse({ accepted: false, error: "superseded" }, 409);
    }

    // VS Code invokes the extension's message handler in send order but never
    // waits for it, so start each message in order and let the slow ones (an
    // external fetch) finish behind the messages that came after them.
    for (const message of batch) {
      this.recordMessage("inbound", message);
      void this.dispatchHostMessage(client, message);
    }
    return jsonResponse({ accepted: true });
  }

  private async dispatchHostMessage(client: StreamClient, message: HostMessage): Promise<void> {
    try {
      if (this.routeRpcMessage(client, message)) {
        return;
      }
      for (const outbound of await this.routeHostMessage(message)) {
        this.recordMessage("outbound", outbound);
        this.send(client, outbound);
      }
    } catch (error) {
      const hostError = {
        type: "host-message-error",
        error: error instanceof Error ? error.message : String(error),
        sourceType: typeof message.type === "string" ? message.type : "unknown",
      };
      this.remember(this.hostErrors, hostError);
      this.send(client, hostError);
    }
  }

  // Not part of the message table below: an RPC frame belongs to one webview's
  // session, and the table answers without knowing which webview asked.
  private routeRpcMessage(client: StreamClient, message: HostMessage): boolean {
    const sessionId = parseRpcConnect(message);
    if (sessionId !== null) {
      if (!this.ipcCoordination) {
        throw new Error("IPC coordination is unavailable");
      }
      // A reconnecting webview opens a new session and abandons the old one;
      // keeping both would double every broadcast into the same tab.
      this.rpcSessions.get(client.id)?.dispose();
      this.rpcSessions.set(
        client.id,
        new WebviewRpcSession(
          sessionId,
          this.ipcCoordination,
          (outbound) => {
            this.send(client, outbound);
          },
          (error) => {
            this.remember(this.hostErrors, { type: "webview-rpc-error", error: error.message });
          },
        ),
      );
      return true;
    }

    const frame = parseRpcMessage(message);
    if (!frame) {
      return false;
    }

    const session = this.rpcSessions.get(client.id);
    if (!session || session.sessionId !== frame.sessionId) {
      throw new Error(`No webview RPC session ${frame.sessionId}`);
    }
    session.accept(frame.message);
    return true;
  }

  private async routeHostMessage(message: HostMessage): Promise<JsonObject[]> {
    switch (message.type) {
      case "ready":
        return [
          { type: "chat-font-settings", chatFontSize: null, chatCodeFontSize: null },
          { type: "custom-prompts-updated", prompts: [] },
          { type: "persisted-atom-sync", state: this.state.persistedAtoms() },
        ];

      case "persisted-atom-sync-request":
        return [{ type: "persisted-atom-sync", state: this.state.persistedAtoms() }];

      case "persisted-atom-update":
        this.state.applyAtomUpdate(message);
        this.broadcast({
          type: "persisted-atom-updated",
          key: typeof message.key === "string" ? message.key : "",
          value: message.deleted ? null : message.value ?? null,
          deleted: message.deleted === true,
        });
        return [];

      case "fetch":
        return [await this.handleFetchMessage(message)];

      case "mcp-request":
      case "thread-prewarm-start":
        return [await this.handleMcpRequest(message)];

      case "mcp-notification":
        this.handleMcpNotification(message);
        return [];

      case "mcp-response":
        this.handleMcpResponse(message);
        return [];

      case "worker-request":
        return [this.handleWorkerRequest(message)];

      case "worker-request-cancel":
        return [];

      case "shared-object-subscribe":
        return [this.sharedObjectUpdateMessage(message.key)];

      case "shared-object-set":
        if (typeof message.key === "string") {
          const nextValue = message.value ?? null;
          if (!jsonValuesEqual(this.state.sharedObjectValue(message.key), nextValue)) {
            this.state.setSharedObject(message.key, nextValue);
            this.broadcast(this.sharedObjectUpdateMessage(message.key));
          }
        }
        return [];

      case "shared-object-unsubscribe":
      case "view-focused":
      case "log-message":
      case "set-telemetry-user":
      case "query-cache-invalidate":
        return [];

      default:
        return [];
    }
  }

  private async handleFetchMessage(message: HostMessage): Promise<JsonObject> {
    const requestId = typeof message.requestId === "string" ? message.requestId : undefined;
    try {
      if (typeof message.url === "string" && message.url.startsWith("vscode://codex/")) {
        const endpoint = parseVSCodeCodexEndpoint(message.url);
        const body = parseOptionalBody(message.body);
        const hostResult = await this.handleVSCodeHostRequest(endpoint, body);
        if (hostResult.handled) {
          return makeFetchResponse({ requestId, result: hostResult.result });
        }
        const result = await handleVSCodeRequest(endpoint, body, this.defaultCwd, this.webviewRoot);
        return makeFetchResponse({ requestId, result });
      }

      return await handleExternalFetch(message, requestId);
    } catch (error) {
      return makeFetchResponse({
        requestId,
        error: error instanceof Error ? error.message : String(error),
        status: 501,
      });
    }
  }

  private async handleVSCodeHostRequest(
    endpoint: string,
    body: JsonValue,
  ): Promise<{ handled: true; result: JsonValue } | { handled: false }> {
    // Memento storage belongs to this host's state, not to the stateless
    // endpoint table below it.
    if (endpoint === "get-global-state") {
      const key = asObject(body)?.key;
      return { handled: true, result: { value: typeof key === "string" ? this.state.globalValue(key) : null } };
    }

    if (endpoint === "set-global-state") {
      const params = asObject(body);
      if (typeof params?.key === "string") {
        this.state.setGlobalValue(params.key, params.value ?? null);
      }
      return { handled: true, result: { success: true } };
    }

    if (endpoint === "thread-role-for-host") {
      const params = requireObject(body, "thread-role-for-host params");
      const conversationId = requireString(params.conversationId, "conversationId");
      return { handled: true, result: this.getThreadRole ? await this.getThreadRole(conversationId) : "follower" };
    }

    if (endpoint === "assert-thread-follower-owner-for-host") {
      const params = requireObject(body, "assert-thread-follower-owner-for-host params");
      const conversationId = requireString(params.conversationId, "conversationId");
      if (this.assertThreadFollowerOwner) {
        await this.assertThreadFollowerOwner(conversationId);
      }
      return { handled: true, result: { ok: true } };
    }

    const followerMethod = hostFollowerEndpointMethods[endpoint];
    if (!followerMethod) {
      return { handled: false };
    }
    if (!this.handleFollowerRequest) {
      throw new Error("IPC follower bridge is unavailable");
    }

    return {
      handled: true,
      result: await this.handleFollowerRequest(followerMethod, stripHostId(requireObject(body, `${endpoint} params`))),
    };
  }

  private async handleMcpRequest(message: HostMessage): Promise<JsonObject> {
    const request = asObject(message.request);
    if (!request || !isRpcId(request.id) || typeof request.method !== "string") {
      return {
        type: "mcp-response",
        hostId: "local",
        message: {
          id: request?.id ?? "",
          error: { message: "Invalid mcp-request payload" },
        },
      };
    }

    try {
      const originalParams = request.params ?? {};
      const params = normalizeAppServerRequestParams(request.method, originalParams);
      const result = await this.handleAppServerRequest(request.method, params, originalParams);
      const startedThread = asObject(asObject(result)?.thread);
      const threadId = appServerThreadId(params, result);
      if (threadId) {
        this.onThreadActivity?.(request.method, threadId, startedThread ?? undefined);
      }
      return {
        type: "mcp-response",
        hostId: "local",
        message: { id: request.id, result },
      };
    } catch (error) {
      // The app server's error goes to the webview exactly as it arrived, the
      // way VS Code forwards it: the webview matches on its wording — «no
      // active turn to interrupt» is how it recognises a turn that ended
      // before the stop reached it — and our method prefix hides that.
      return {
        type: "mcp-response",
        hostId: "local",
        message: {
          id: request.id,
          error:
            error instanceof AppServerError
              ? error.payload
              : { message: error instanceof Error ? error.message : String(error) },
        },
      };
    }
  }

  private async handleAppServerRequest(method: string, params: JsonValue, originalParams: JsonValue): Promise<JsonValue> {
    if (method !== "experimentalFeature/enablement/set") {
      return this.appServer.request(method, params);
    }

    const key = JSON.stringify(params);
    const cachedResult = this.experimentalEnablementSetResults.get(key);
    if (cachedResult !== undefined) {
      return cachedResult;
    }

    await this.appServer.request(method, params);
    const result = {
      enablement: asObject(originalParams)?.enablement ?? asObject(params)?.enablement ?? {},
    };
    this.experimentalEnablementSetResults.set(key, result);
    return result;
  }

  private handleMcpNotification(message: HostMessage): void {
    const request = asObject(message.request);
    if (!request || typeof request.method !== "string") {
      throw new Error("Invalid mcp-notification payload");
    }
    this.appServer.notify(request.method, request.params ?? {});
  }

  private handleMcpResponse(message: HostMessage): void {
    const response = asObject(message.response);
    if (!response || !isRpcId(response.id)) {
      throw new Error("Invalid mcp-response payload");
    }
    this.appServer.respondToServerRequest(String(response.id), serverRequestResponse(response));
  }

  private handleWorkerRequest(message: HostMessage): JsonObject {
    const workerId = typeof message.workerId === "string" ? message.workerId : "";
    const request = asObject(message.request);
    if (!workerId || !request || typeof request.id !== "string" || typeof request.method !== "string") {
      return workerResponse(workerId, "", "unknown", workerError("Invalid worker-request payload"));
    }

    if (workerId === "git" && request.method === "stable-metadata") {
      const params = asObject(request.params);
      const cwd = typeof params?.cwd === "string" ? params.cwd : this.defaultCwd;
      const metadata = resolveGitStableMetadata(cwd);
      if (!metadata) {
        return workerResponse(workerId, request.id, request.method, workerError("Not a git repository"));
      }
      return workerResponse(workerId, request.id, request.method, workerOk(metadata));
    }

    if (workerId === "git" && request.method === "watch-repo") {
      return workerResponse(workerId, request.id, request.method, workerOk({ success: true }));
    }

    if (workerId === "git" && request.method === "unwatch-repo") {
      return workerResponse(workerId, request.id, request.method, workerOk({ success: true }));
    }

    if (workerId === "git" && request.method === "current-branch") {
      const params = asObject(request.params);
      const root = typeof params?.root === "string" ? params.root : this.defaultCwd;
      return workerResponse(workerId, request.id, request.method, workerOk({ branch: resolveGitCurrentBranch(root) }));
    }

    if (workerId === "git" && request.method === "submodule-paths") {
      const params = asObject(request.params);
      const root = typeof params?.root === "string" ? params.root : this.defaultCwd;
      return workerResponse(workerId, request.id, request.method, workerOk({ paths: resolveGitSubmodulePaths(root) }));
    }

    return workerResponse(workerId, request.id, request.method, workerError(`Unsupported worker request: ${workerId}/${request.method}`));
  }

  private sharedObjectUpdateMessage(key: JsonValue | undefined): JsonObject {
    const objectKey = typeof key === "string" ? key : "";
    return {
      type: "shared-object-updated",
      key: objectKey,
      value: this.state.sharedObjectValue(objectKey),
    };
  }

  private openEventStream(request: Request): Response {
    // Prune first: collecting a record right after handing it out would leave
    // this stream attached to an orphan that broadcasts no longer reach.
    this.pruneDetachedClients();
    const client = this.clientFor(clientIdFromRequest(request));
    const resumeFrom = parseResumePoint(client, request.headers.get("last-event-id"));
    // Only a page load takes the seat. A browser reconnect continues a stream
    // this webview already had, and treating it as a new webview would let a
    // backgrounded tab whose SSE dropped steal the session back from the tab
    // the user is actually looking at.
    if (resumeFrom === null) {
      this.makeActive(client);
    }
    const holdsSeat = this.activeClientId === client.id;

    let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.detachClient(client);
        client.controller = controller;
        client.detachedAt = null;
        client.heartbeat = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(": heartbeat\n\n"));
          } catch {
            this.detachIfCurrent(client, controller);
          }
        }, 5_000);
        streamController = controller;
        controller.enqueue(encoder.encode(": connected\n\n"));

        if (!holdsSeat) {
          // Its buffer stopped being the whole story the moment another webview
          // took over, so there is nothing safe to resume into: say why and let
          // the tab reload if the user wants it back.
          this.send(client, { type: "dispatcher-webview-superseded" });
          return;
        }

        const missed = bufferedAfter(client, resumeFrom);
        for (const event of missed ?? []) {
          controller.enqueue(encodeSseMessage(client, event.payload, event.id));
        }
        if (resumeFrom !== null && missed) {
          return;
        }

        // A stream this webview has never read from: whatever we could replay
        // above is its own pending traffic, and current state still has to
        // follow it — pending approvals live only in this snapshot. These go
        // through the normal numbering so a drop mid-snapshot can be resumed.
        for (const message of this.getEventReplayMessages?.() ?? []) {
          this.send(client, message);
        }
      },
      cancel: () => {
        // A dead socket can be reported long after the tab already reconnected;
        // only the connection that is still attached may tear the client down.
        this.detachIfCurrent(client, streamController);
      },
    });

    return new Response(stream, {
      headers: {
        "cache-control": "no-cache",
        "content-type": "text/event-stream; charset=utf-8",
      },
    });
  }

  private makeActive(client: StreamClient): void {
    if (this.activeClientId === client.id) {
      return;
    }

    const superseded = this.activeClientId === null ? undefined : this.clients.get(this.activeClientId);
    this.activeClientId = client.id;
    if (superseded) {
      // Its RPC session goes with the seat: a displaced tab is refused at
      // /host-message, so anything we asked it would wait for an answer that
      // can no longer come back.
      this.rpcSessions.get(superseded.id)?.dispose();
      this.rpcSessions.delete(superseded.id);
      // Told on its own stream, before it stops receiving broadcasts, so the
      // tab can say why it went quiet instead of just freezing.
      this.send(superseded, { type: "dispatcher-webview-superseded" });
    }
  }

  private clientFor(clientId: string): StreamClient {
    const existing = this.clients.get(clientId);
    if (existing) {
      return existing;
    }

    const client: StreamClient = {
      id: clientId,
      epoch: crypto.randomUUID(),
      controller: null,
      heartbeat: null,
      seq: 0,
      buffer: [],
      detachedAt: Date.now(),
    };
    this.clients.set(clientId, client);
    return client;
  }

  private detachIfCurrent(client: StreamClient, controller: ReadableStreamDefaultController<Uint8Array> | null): void {
    if (controller !== null && client.controller === controller) {
      this.detachClient(client);
    }
  }

  private detachClient(client: StreamClient): void {
    if (client.heartbeat) {
      clearInterval(client.heartbeat);
      client.heartbeat = null;
    }
    client.controller = null;
    client.detachedAt = Date.now();
  }

  private pruneDetachedClients(): void {
    const cutoff = Date.now() - detachedClientRetentionMs;
    for (const client of this.clients.values()) {
      if (client.detachedAt !== null && client.detachedAt < cutoff) {
        this.clients.delete(client.id);
        if (this.activeClientId === client.id) {
          // Leaving the id behind would keep a gone webview holding the seat:
          // every other tab would be told it was superseded by nobody.
          this.activeClientId = null;
        }
      }
    }
  }

  // Queue for a single webview. Buffered while its stream is down so a reconnect
  // can resume rather than lose the message.
  private send(client: StreamClient, message: JsonObject): void {
    client.seq += 1;
    client.buffer.push({ id: client.seq, payload: message });
    if (client.buffer.length > maxReplayEvents) {
      client.buffer.splice(0, client.buffer.length - maxReplayEvents);
    }

    if (!client.controller) {
      return;
    }

    try {
      client.controller.enqueue(encodeSseMessage(client, message, client.seq));
    } catch {
      this.detachClient(client);
    }
  }

  private broadcast(message: JsonObject): void {
    this.recordMessage("outbound", message);
    // Tabs that never come back are only reachable from here: a closed webview
    // stops opening streams, so this is the one place left to collect it.
    this.pruneDetachedClients();
    const active = this.activeClientId === null ? undefined : this.clients.get(this.activeClientId);
    if (active) {
      this.send(active, message);
    }
  }

  private buildShim(token: string): string {
    const encodedToken = JSON.stringify(token);
    return `<script>
(() => {
  const token = ${encodedToken};
  const vscodeLightTheme = {
    "--vscode-font-family": "-apple-system, BlinkMacSystemFont, \\"Segoe UI\\", sans-serif",
    "--vscode-font-size": "13px",
    "--vscode-font-weight": "normal",
    "--vscode-editor-font-family": "ui-monospace, \\"SFMono-Regular\\", \\"SF Mono\\", Menlo, Consolas, \\"Liberation Mono\\", monospace",
    "--vscode-editor-font-size": "12px",
    "--vscode-editor-font-weight": "normal",
    "--vscode-foreground": "#1f2328",
    "--vscode-disabledForeground": "rgba(31, 35, 40, 0.38)",
    "--vscode-errorForeground": "#d1242f",
    "--vscode-descriptionForeground": "rgba(31, 35, 40, 0.55)",
    "--vscode-icon-foreground": "#57606a",
    "--vscode-focusBorder": "#0969da",
    "--vscode-textLink-foreground": "#0969da",
    "--vscode-textLink-activeForeground": "#0550ae",
    "--vscode-textCodeBlock-background": "rgba(31, 35, 40, 0.06)",
    "--vscode-badge-background": "rgba(31, 35, 40, 0.08)",
    "--vscode-badge-foreground": "#1f2328",
    "--vscode-scrollbarSlider-background": "rgba(31, 35, 40, 0.16)",
    "--vscode-scrollbarSlider-hoverBackground": "rgba(31, 35, 40, 0.24)",
    "--vscode-scrollbarSlider-activeBackground": "rgba(31, 35, 40, 0.32)",
    "--vscode-progressBar-background": "#0969da",
    "--vscode-editor-background": "#ffffff",
    "--vscode-editor-foreground": "#1f2328",
    "--vscode-editorError-foreground": "#d1242f",
    "--vscode-editorWarning-foreground": "#9a6700",
    "--vscode-toolbar-hoverBackground": "rgba(31, 35, 40, 0.08)",
    "--vscode-toolbar-activeBackground": "rgba(31, 35, 40, 0.12)",
    "--vscode-input-background": "#ffffff",
    "--vscode-input-foreground": "#1f2328",
    "--vscode-input-border": "rgba(31, 35, 40, 0.14)",
    "--vscode-input-placeholderForeground": "rgba(31, 35, 40, 0.45)",
    "--vscode-inputValidation-infoBackground": "#ddf4ff",
    "--vscode-inputValidation-warningBackground": "#fff8c5",
    "--vscode-inputValidation-warningBorder": "#d4a72c",
    "--vscode-inputValidation-errorBackground": "#ffebe9",
    "--vscode-inputValidation-errorBorder": "#d1242f",
    "--vscode-dropdown-background": "#ffffff",
    "--vscode-dropdown-foreground": "#1f2328",
    "--vscode-dropdown-border": "rgba(31, 35, 40, 0.14)",
    "--vscode-button-foreground": "#ffffff",
    "--vscode-button-background": "#1f2328",
    "--vscode-button-border": "transparent",
    "--vscode-button-secondaryHoverBackground": "rgba(31, 35, 40, 0.08)",
    "--vscode-radio-activeForeground": "#0969da",
    "--vscode-checkbox-background": "#ffffff",
    "--vscode-checkbox-foreground": "#1f2328",
    "--vscode-checkbox-border": "rgba(31, 35, 40, 0.24)",
    "--vscode-list-focusOutline": "#0969da",
    "--vscode-list-activeSelectionBackground": "rgba(9, 105, 218, 0.12)",
    "--vscode-list-activeSelectionForeground": "#1f2328",
    "--vscode-list-activeSelectionIconForeground": "#0969da",
    "--vscode-list-hoverBackground": "rgba(31, 35, 40, 0.06)",
    "--vscode-sideBar-background": "#f6f8fa",
    "--vscode-sideBar-foreground": "#1f2328",
    "--vscode-sideBarTitle-foreground": "#1f2328",
    "--vscode-panel-background": "#ffffff",
    "--vscode-menu-background": "#ffffff",
    "--vscode-menu-border": "rgba(31, 35, 40, 0.14)",
    "--vscode-menubar-selectionForeground": "#1f2328",
    "--vscode-menubar-selectionBackground": "rgba(31, 35, 40, 0.06)",
    "--vscode-charts-red": "#d1242f",
    "--vscode-charts-blue": "#0969da",
    "--vscode-charts-yellow": "#d4a72c",
    "--vscode-charts-orange": "#bc4c00",
    "--vscode-charts-green": "#1a7f37",
    "--vscode-charts-purple": "#8250df",
    "--vscode-gitDecoration-addedResourceForeground": "#1a7f37",
    "--vscode-gitDecoration-deletedResourceForeground": "#d1242f",
    "--vscode-gitDecoration-modifiedResourceForeground": "#9a6700",
    "--vscode-terminal-foreground": "#1f2328",
    "--vscode-terminal-border": "rgba(31, 35, 40, 0.14)",
    "--vscode-terminal-ansiBlack": "#1f2328",
    "--vscode-terminal-ansiRed": "#d1242f",
    "--vscode-terminal-ansiGreen": "#1a7f37",
    "--vscode-terminal-ansiYellow": "#9a6700",
    "--vscode-terminal-ansiBlue": "#0969da",
    "--vscode-terminal-ansiMagenta": "#8250df",
    "--vscode-terminal-ansiCyan": "#1b7c83",
    "--vscode-terminal-ansiWhite": "#6e7781",
    "--vscode-terminal-ansiBrightBlack": "#57606a",
    "--vscode-terminal-ansiBrightRed": "#cf222e",
    "--vscode-terminal-ansiBrightGreen": "#116329",
    "--vscode-terminal-ansiBrightYellow": "#953800",
    "--vscode-terminal-ansiBrightBlue": "#0550ae",
    "--vscode-terminal-ansiBrightMagenta": "#6639ba",
    "--vscode-terminal-ansiBrightCyan": "#0a6169",
    "--vscode-terminal-ansiBrightWhite": "#8c959f",
  };
  const root = document.documentElement;
  const readLayoutWidth = () => document.documentElement.clientWidth || window.innerWidth;
  const readLayoutHeight = () => document.documentElement.clientHeight || window.innerHeight;
  let stableViewportWidth = Math.max(0, Math.floor(readLayoutWidth()));
  let stableViewportHeight = Math.max(0, Math.floor(readLayoutHeight()));
  const isEditableElement = (element) => {
    if (!(element instanceof Element)) return false;
    const tagName = element.tagName.toLowerCase();
    return (
      tagName === "input" ||
      tagName === "textarea" ||
      tagName === "select" ||
      element.isContentEditable === true ||
      element.closest('[contenteditable="true"], .ProseMirror, .cm-editor, .cm-content') !== null
    );
  };
  const keyboardLikelyOpen = () => {
    const viewport = window.visualViewport;
    return (
      Boolean(viewport) &&
      isEditableElement(document.activeElement) &&
      stableViewportHeight > 0 &&
      viewport.height < stableViewportHeight - 80
    );
  };
  const enforceNoZoom = () => {
    root.style.setProperty("--codex-window-zoom", "1", "important");
    root.style.zoom = "1";
    root.style.webkitTextSizeAdjust = "100%";
    root.style.textSizeAdjust = "100%";
    const body = document.body;
    if (body) {
      body.style.zoom = "1";
      body.style.webkitTextSizeAdjust = "100%";
      body.style.textSizeAdjust = "100%";
    }
    const appRoot = document.getElementById("root");
    if (appRoot) {
      appRoot.style.zoom = "1";
      appRoot.style.webkitTextSizeAdjust = "100%";
      appRoot.style.textSizeAdjust = "100%";
    }
  };
  const lockPageScroll = () => {
    if (window.scrollX !== 0 || window.scrollY !== 0) {
      window.scrollTo(0, 0);
    }
  };
  const scheduleViewportGeometry = () => {
    requestAnimationFrame(applyViewportGeometry);
    setTimeout(applyViewportGeometry, 250);
  };
  const applyViewportGeometry = () => {
    const viewport = window.visualViewport;
    const layoutHeight = Math.max(0, Math.floor(readLayoutHeight()));
    const layoutWidth = Math.max(0, Math.floor(readLayoutWidth()));
    const keyboardOpen = keyboardLikelyOpen();
    if (!keyboardOpen) {
      stableViewportHeight = layoutHeight;
      stableViewportWidth = layoutWidth;
    }
    const height = keyboardOpen && viewport
      ? Math.max(0, Math.floor(viewport.height))
      : stableViewportHeight || layoutHeight;
    const width = stableViewportWidth || layoutWidth;
    const offsetTop = viewport?.offsetTop || 0;
    const offsetLeft = viewport?.offsetLeft || 0;
    root.style.setProperty("--codex-dispatcher-viewport-height", Math.max(0, Math.floor(height)) + "px");
    root.style.setProperty("--codex-dispatcher-viewport-width", Math.max(0, Math.floor(width)) + "px");
    root.style.setProperty("--codex-dispatcher-viewport-offset-top", Math.floor(offsetTop) + "px");
    root.style.setProperty("--codex-dispatcher-viewport-offset-left", Math.floor(offsetLeft) + "px");
    enforceNoZoom();
    lockPageScroll();
  };
  applyViewportGeometry();
  window.addEventListener("resize", applyViewportGeometry, { passive: true });
  window.addEventListener("scroll", lockPageScroll, { passive: true });
  window.visualViewport?.addEventListener("resize", applyViewportGeometry, { passive: true });
  window.visualViewport?.addEventListener("scroll", applyViewportGeometry, { passive: true });
  document.addEventListener("focusin", scheduleViewportGeometry, true);
  document.addEventListener("focusout", scheduleViewportGeometry, true);
  if (token) {
    const cleanUrl = new URL(window.location.href);
    cleanUrl.searchParams.delete("token");
    history.replaceState(history.state, "", cleanUrl);
  }
  root.dataset.codexWindowType = root.dataset.codexWindowType || "extension";
  root.dataset.windowType = root.dataset.windowType || "extension";
  root.dataset.codexOs = root.dataset.codexOs || "darwin";
  root.classList.add("vscode-light");
  root.style.colorScheme = "light";
  for (const [name, value] of Object.entries(vscodeLightTheme)) {
    root.style.setProperty(name, value);
  }
  const applyBodyThemeClass = () => document.body?.classList.add("vscode-light");
  if (document.body) applyBodyThemeClass();
  else document.addEventListener("DOMContentLoaded", applyBodyThemeClass, { once: true });

  const hostMessageUrl = ${JSON.stringify(`${routePrefix}/host-message`)};
  // Identifies this webview across event stream reconnects so buffered replies survive.
  const clientId = (crypto.randomUUID?.() ?? String(Date.now()) + Math.random().toString(16).slice(2));
  const eventsUrl = ${JSON.stringify(`${routePrefix}/events?client=`)} + encodeURIComponent(clientId);
  const vscodeStateKey = "codex-extension-webview:vscode-state";
  const maxMessages = 500;
  const remember = (target, message) => {
    target.push(message);
    if (target.length > maxMessages) target.splice(0, target.length - maxMessages);
  };
  const rememberClientError = (error) => {
    remember(window.__codexHostAdapterClientErrors, {
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : null,
    });
  };
  const postToWindow = (message) => window.postMessage(message, window.location.origin);
  let superseded = false;
  const showSuperseded = () => {
    if (superseded) return;
    superseded = true;
    events.close();
    const overlay = document.createElement("div");
    overlay.setAttribute("data-codex-dispatcher-superseded", "");
    overlay.style.cssText = "position:fixed;inset:0;z-index:2147483647;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;padding:24px;text-align:center;background:rgba(0,0,0,.86);color:#fff;font:15px/1.45 system-ui,-apple-system,sans-serif";
    const text = document.createElement("div");
    text.textContent = "Codex moved to another tab. Only one can drive the session.";
    const button = document.createElement("button");
    button.textContent = "Use this tab instead";
    button.style.cssText = "padding:10px 18px;border:0;border-radius:8px;font:inherit;cursor:pointer;background:#fff;color:#000";
    button.addEventListener("click", () => window.location.reload());
    overlay.append(text, button);
    (document.body || document.documentElement).appendChild(overlay);
  };
  const deliver = (messages) => {
    for (const message of messages || []) {
      // Ours, not the extension's: the host contract has no notion of a webview
      // being replaced, so this one stops here.
      if (message && message.type === "dispatcher-webview-superseded") {
        showSuperseded();
        continue;
      }
      remember(window.__codexHostAdapterInboundMessages, message);
      postToWindow(message);
    }
  };
  const outbox = [];
  let flushing = false;
  const flushOutbox = async () => {
    if (flushing) {
      return;
    }
    flushing = true;
    try {
      while (outbox.length > 0) {
        // One request in flight at a time: parallel posts arrive in whatever
        // order the network feels like, and VS Code hands the extension its
        // postMessage traffic strictly in send order.
        const batch = outbox.splice(0, outbox.length);
        try {
          // Replies come back over the event stream, not in this response body, so the
          // webview observes host traffic in one order instead of racing two channels.
          const response = await fetch(hostMessageUrl, {
            method: "POST",
            headers: { "content-type": "application/json", "x-dispatcher-client": clientId },
            body: '{"messages":[' + batch.map((entry) => entry.json).join(",") + ']}',
          });
          if (response.status === 409) {
            showSuperseded();
          }
          if (!response.ok) {
            throw new Error("host rejected the message batch with " + response.status);
          }
        } catch (error) {
          // A dropped batch is a dead end for every promise waiting on it, so
          // make it loud instead of leaving the webview waiting forever.
          for (const entry of batch) {
            remember(window.__codexHostAdapterInboundMessages, {
              type: "host-adapter-error",
              error: error instanceof Error ? error.message : String(error),
              sourceType: entry.sourceType,
            });
          }
          console.error("[codex-extension-webview] host-message failed", error);
        }
      }
    } finally {
      flushing = false;
    }
  };
  const sendHostMessage = (message) => {
    remember(window.__codexHostAdapterMessages, message);
    // Serialise per message: VS Code's postMessage throws at the caller for a
    // value it cannot clone, instead of taking its neighbours down with it.
    const json = JSON.stringify(message);
    if (json === undefined) {
      throw new TypeError("postMessage payload is not serialisable for the host channel");
    }
    outbox.push({ json, sourceType: typeof message?.type === "string" ? message.type : "unknown" });
    void flushOutbox();
  };

  window.__codexHostAdapterMessages = [];
  window.__codexHostAdapterInboundMessages = [];
  window.__codexHostAdapterClientErrors = [];
  window.addEventListener("error", (event) => rememberClientError(event.error ?? event.message));
  window.addEventListener("unhandledrejection", (event) => rememberClientError(event.reason));
  window.acquireVsCodeApi = () => ({
    postMessage: (message) => { sendHostMessage(message); },
    getState: () => {
      try { return JSON.parse(localStorage.getItem(vscodeStateKey) || "null"); } catch { return null; }
    },
    setState: (state) => {
      localStorage.setItem(vscodeStateKey, JSON.stringify(state));
      return state;
    },
  });

  const events = new EventSource(eventsUrl);
  events.onmessage = (event) => {
    try { deliver([JSON.parse(event.data)]); } catch (error) { console.error(error); }
  };
  // EventSource reconnects on its own and replays through Last-Event-ID, but a
  // silent drop used to look identical to an idle session, so make it visible.
  events.onerror = () => {
    remember(window.__codexHostAdapterClientErrors, {
      message: "event stream disconnected",
      readyState: events.readyState,
    });
    if (events.readyState === EventSource.CLOSED) {
      console.error("[codex-extension-webview] event stream closed");
    }
  };
})();
</script>`;
  }

  private debugSnapshot(): JsonObject {
    return {
      routePrefix,
      startedAt: this.startedAt,
      webviewRoot: this.webviewRoot,
      clients: this.clients.size,
      messageCounts: Object.fromEntries(this.messageCounts.entries()) as JsonObject,
      recentMessages: this.recentMessages,
      hostErrors: this.hostErrors,
    };
  }

  private recordMessage(direction: "inbound" | "outbound", message: HostMessage | JsonObject): void {
    const type = typeof message.type === "string" ? message.type : "unknown";
    const countKey = `${direction}:${type}`;
    this.messageCounts.set(countKey, (this.messageCounts.get(countKey) ?? 0) + 1);
    this.remember(this.recentMessages, {
      direction,
      type,
      method: message.method ?? asObject(message.request)?.method ?? asObject(message.response)?.method,
      requestId: message.requestId,
      workerId: message.workerId,
      endpoint: typeof message.url === "string" && message.url.startsWith("vscode://codex/")
        ? parseVSCodeCodexEndpoint(message.url)
        : undefined,
    });
  }

  private remember(target: JsonObject[], value: JsonObject): void {
    target.push(value);
    if (target.length > maxDiagnosticMessages) {
      target.splice(0, target.length - maxDiagnosticMessages);
    }
  }
}

// This bridge hand-implements the host side of one extension's contract: the
// vscode://codex endpoint set, the follower methods, the IPC method versions.
// A version it was never checked against is a silent breakage, not an upgrade,
// so auto-update has to hit an error instead of a half-working webview.
// min: earliest version the UI parity work was done against; max: newest
// version verified end to end.
const supportedExtensionVersions = { min: [26, 422], max: [26, 803] };

// The build `serve --install-extension` puts on a fresh machine: installing
// marketplace latest would hand us a version the range above rejects.
export const verifiedExtensionVersion = "26.803.61601";

export function parseExtensionVersion(directoryName: string): number[] | null {
  const match = /^openai\.chatgpt-(\d+)\.(\d+)\.(\d+)/.exec(directoryName);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

export function isSupportedExtensionVersion(version: number[]): boolean {
  const release = version.slice(0, 2);
  return compareVersions(release, supportedExtensionVersions.min) >= 0
    && compareVersions(release, supportedExtensionVersions.max) <= 0;
}

export function resolveExtensionWebviewRoot(): string | null {
  const configured = process.env.CODEX_EXTENSION_WEBVIEW_ROOT;
  if (configured) {
    // An explicit root is the operator saying which contract to speak to, so a
    // path that holds no webview is their mistake to see, not ours to skip.
    if (!existsSync(join(configured, "index.html"))) {
      throw new Error(`CODEX_EXTENSION_WEBVIEW_ROOT=${configured} has no index.html`);
    }
    return resolve(configured);
  }

  return selectExtensionWebviewRoot(join(homedir(), ".vscode", "extensions"));
}

export function selectExtensionWebviewRoot(extensionsDir: string): string | null {
  let entries: string[];
  try {
    entries = readdirSync(extensionsDir);
  } catch {
    return null;
  }

  const installed = entries
    .map((entry) => ({ entry, version: parseExtensionVersion(entry) }))
    .filter((candidate): candidate is { entry: string; version: number[] } => candidate.version !== null)
    .filter((candidate) => existsSync(join(extensionsDir, candidate.entry, "webview", "index.html")));

  if (installed.length === 0) {
    return null;
  }

  const supported = installed
    .filter((candidate) => isSupportedExtensionVersion(candidate.version))
    .sort((left, right) => compareVersions(left.version, right.version));

  const newest = supported.at(-1);
  if (!newest) {
    const found = installed.map((candidate) => candidate.version.join(".")).join(", ");
    throw new Error(
      `Codex extension ${found} is outside the range this dispatcher emulates `
      + `(${supportedExtensionVersions.min.join(".")}.x - ${supportedExtensionVersions.max.join(".")}.x). `
      + "Update the dispatcher, or point CODEX_EXTENSION_WEBVIEW_ROOT at a webview directory you want it to serve.",
    );
  }

  return join(extensionsDir, newest.entry, "webview");
}

function compareVersions(left: number[], right: number[]): number {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

export function resolveWebviewAssetPath(webviewRoot: string, pathname: string): string | null {
  const suffix = pathname.startsWith(`${routePrefix}/`) ? pathname.slice(routePrefix.length + 1) : pathname;
  const decodedPath = decodeURIComponent(suffix);
  const filePath = resolve(webviewRoot, decodedPath);
  if (filePath !== webviewRoot && !filePath.startsWith(`${webviewRoot}${sep}`)) {
    return null;
  }
  return filePath;
}

export async function handleVSCodeRequest(
  endpoint: string,
  body: JsonValue,
  defaultCwd: string,
  webviewRoot: string | null,
): Promise<JsonValue> {
  const params = asObject(body) ?? {};

  switch (endpoint) {
    case "active-workspace-roots":
      return { roots: [defaultCwd] };
    case "workspace-root-options":
      return { roots: [defaultCwd] };
    case "codex-home": {
      const codexHome = join(homedir(), ".codex");
      return { codexHome, worktreesSegment: join(codexHome, "worktrees") };
    }
    case "home-directory":
      return { homeDirectory: homedir() };
    case "projectless-thread-cwd":
    case "projectless-workspace-root":
      return { path: defaultCwd };
    case "get-configuration":
      return { value: null };
    case "set-configuration":
      return { success: false };
    case "set-vs-context":
      return { success: true };
    case "list-pinned-threads":
      return { threadIds: [] };
    case "set-thread-pinned":
    case "set-pinned-threads-order":
      return { success: false };
    case "extension-info":
      return { version: extensionVersionOf(webviewRoot), buildNumber: null, buildFlavor: "prod", appName: "Codex", appIconMedium: null };
    case "locale-info":
      return { ideLocale: "en", systemLocale: Intl.DateTimeFormat().resolvedOptions().locale };
    case "os-info":
      return { platform: platform(), osVersion: release(), hasWsl: false, isVsCodeRunningInsideWsl: false };
    case "is-copilot-api-available":
      return { available: false };
    case "get-copilot-api-proxy-info":
      return null;
    case "account-info":
      return { accountId: null, userId: null, plan: null, email: null };
    case "app-server-connection-state":
      return { state: null, errorMessage: null };
    case "third-party-notices":
      return { text: null };
    case "inbox-items":
    case "list-automations":
      return { items: [] };
    case "ambient-suggestions":
      return { file: null };
    case "ambient-suggestions-generation-statuses":
      return { statuses: [] };
    case "list-pending-automation-run-threads":
      return { threadIds: [] };
    case "developer-instructions":
      return { instructions: typeof params.baseInstructions === "string" ? params.baseInstructions : "" };
    case "has-custom-cli-executable":
      return { hasCustomCliExecutable: false };
    case "mcp-codex-config":
      return { config: null };
    case "worktree-shell-environment-config":
      return { shellEnvironment: null };
    case "openai-api-key":
      return { value: process.env.OPENAI_API_KEY ?? null };
    case "recommended-skills":
      return { skills: [], repoRoot: null };
    case "local-custom-agents":
      return { agents: [] };
    case "ide-context":
      return { ideContext: null };
    case "open-in-targets":
      return { preferredTarget: null, availableTargets: [], targets: [] };
    case "terminal-shell-options":
      return { availableShells: [] };
    case "thread-terminal-snapshot":
      return { session: null };
    case "paths-exist":
      return { existingPaths: [] };
    case "find-files":
      return { files: [] };
    case "git-origins":
      return { origins: [], homeDir: homedir() };
    case "child-processes":
      return { rootProcess: null, processes: [] };
    case "is-packaged":
      return { isPackaged: false };
    case "chronicle-permissions":
      return {};
    case "browser-use-origin-state-read":
      return { approvalMode: "alwaysAsk", allowedOrigins: [], deniedOrigins: [] };
    case "browser-use-approval-mode-write":
      return { approvalMode: params.approvalMode ?? "alwaysAsk", allowedOrigins: [], deniedOrigins: [] };
    case "native-desktop-apps":
      return { apps: [] };
    default:
      throw new Error(`Unsupported vscode://codex/${endpoint}`);
  }
}

export function makeFetchResponse(options: FetchResponseOptions): JsonObject {
  if (options.error) {
    return {
      type: "fetch-response",
      responseType: "error",
      requestId: options.requestId,
      status: options.status ?? 500,
      error: options.error,
    };
  }

  return {
    type: "fetch-response",
    responseType: "success",
    requestId: options.requestId,
    status: options.status ?? 200,
    headers: {},
    bodyJsonString: JSON.stringify(options.result ?? null),
  };
}

async function handleExternalFetch(message: HostMessage, requestId: string | undefined): Promise<JsonObject> {
  const url = normalizeExternalFetchUrl(message.url);
  const whamResponse = makeWhamFetchResponse(url, requestId);
  if (whamResponse) {
    return whamResponse;
  }

  const statsigResponse = makeStatsigFetchResponse(url, requestId);
  if (statsigResponse) {
    return statsigResponse;
  }

  const headers = headersFromMessage(message);
  let body: BodyInit | undefined;

  if (typeof message.body === "string" && message.method !== "GET") {
    const base64Header = Array.from(headers.entries()).find(([key, value]) => key.toLowerCase() === "x-codex-base64" && value === "1");
    if (base64Header) {
      headers.delete(base64Header[0]);
      body = Buffer.from(message.body, "base64");
    } else {
      body = message.body;
    }
  }

  const init: RequestInit = {
    method: typeof message.method === "string" ? message.method : "GET",
    headers,
    signal: AbortSignal.timeout(externalFetchTimeoutMs),
  };
  if (body !== undefined) {
    init.body = body;
  }

  const response = await fetch(url, init);

  const responseHeaders: JsonObject = {};
  response.headers.forEach((value, key) => {
    if (key.toLowerCase() !== "authorization") {
      responseHeaders[key] = value;
    }
  });

  return {
    type: "fetch-response",
    responseType: "success",
    requestId,
    status: response.status,
    headers: responseHeaders,
    bodyJsonString: await readExternalFetchBody(response),
  };
}

// The webview resolves 2xx with JSON.parse(bodyJsonString) and rejects any other
// status with bodyJsonString as the error message, so every completed exchange is
// reported as `success` and the body carries the failure detail. `error` responses
// are reserved for exchanges that never completed.
export async function readExternalFetchBody(response: Response): Promise<string> {
  const contentTypeHeader = response.headers.get("content-type") ?? "";
  if (!response.ok) {
    return response.text();
  }

  if (contentTypeHeader.includes("application/json")) {
    const text = await response.text();
    return text.length > 0 ? text : "null";
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  return JSON.stringify({ base64: bytes.toString("base64"), contentType: contentTypeHeader });
}

function makeWhamFetchResponse(url: string, requestId: string | undefined): JsonObject | null {
  const parsedUrl = new URL(url);
  if (parsedUrl.hostname !== "chatgpt.com") {
    return null;
  }

  const path = parsedUrl.pathname.replace(/^\/backend-api/, "");
  if (path === "/wham/accounts/check") {
    return makeFetchResponse({ requestId, result: { account_ordering: [], accounts: {} } });
  }

  if (path === "/wham/tasks/list") {
    return makeFetchResponse({ requestId, result: { items: [] } });
  }

  if (path === "/wham/environments") {
    return makeFetchResponse({ requestId, result: [] });
  }

  if (path === "/wham/usage") {
    return makeFetchResponse({ requestId, result: null });
  }

  if (path.startsWith("/accounts/check/")) {
    return makeFetchResponse({ requestId, result: { accounts: {} } });
  }

  return null;
}

function makeStatsigFetchResponse(url: string, requestId: string | undefined): JsonObject | null {
  const parsedUrl = new URL(url);
  if (parsedUrl.hostname === "ab.chatgpt.com" && parsedUrl.pathname === "/v1/initialize") {
    return {
      type: "fetch-response",
      responseType: "success",
      requestId,
      status: 200,
      headers: { "content-type": "application/json" },
      bodyJsonString: JSON.stringify({
        feature_gates: {},
        dynamic_configs: {},
        layer_configs: {},
        sdkParams: {},
        has_updates: true,
        time: Date.now(),
      }),
    };
  }

  if (parsedUrl.hostname === "chatgpt.com" && parsedUrl.pathname.startsWith("/ces/")) {
    return {
      type: "fetch-response",
      responseType: "success",
      requestId,
      status: 202,
      headers: { "content-type": "application/json" },
      bodyJsonString: JSON.stringify({ success: true }),
    };
  }

  return null;
}

function normalizeExternalFetchUrl(url: JsonValue | undefined): string {
  if (typeof url !== "string" || url.length === 0) {
    throw new Error("Missing fetch URL");
  }
  if (url.startsWith("http://") || url.startsWith("https://") || url.startsWith("data:")) {
    return url;
  }
  if (url.startsWith("/")) {
    return `https://chatgpt.com/backend-api${url}`;
  }
  return `https://chatgpt.com/backend-api/${url.replace(/^\/+/, "")}`;
}

function headersFromMessage(message: HostMessage): Headers {
  const headers = new Headers();
  const rawHeaders = asObject(message.headers);
  for (const [key, value] of Object.entries(rawHeaders ?? {})) {
    if (typeof value === "string") {
      headers.set(key, value);
    }
  }
  return headers;
}

function normalizeAppServerRequestParams(method: string, params: JsonValue): JsonValue {
  const object = asObject(params);
  if (!object) {
    return params;
  }

  if (method === "config/read") {
    const cwd = asObject(object.cwd);
    if (cwd && typeof cwd.path === "string") {
      return { ...object, cwd: cwd.path };
    }
  }

  if (method === "experimentalFeature/enablement/set") {
    const enablement = asObject(object.enablement);
    if (enablement && "workspace_dependencies" in enablement) {
      const { workspace_dependencies: _removed, ...supportedEnablement } = enablement;
      return { ...object, enablement: supportedEnablement };
    }
  }

  return params;
}

function workerResponse(workerId: string, id: string, method: string, result: JsonValue): JsonObject {
  return {
    type: "worker-response",
    workerId,
    response: {
      id,
      method,
      result,
    },
  };
}

function workerOk(value: JsonValue): JsonObject {
  return { type: "ok", value };
}

function workerError(message: string): JsonObject {
  return { type: "error", error: { message } };
}

function resolveGitStableMetadata(cwd: string): JsonObject | null {
  const root = findGitRoot(cwd);
  if (!root) {
    return null;
  }

  return {
    root,
    commonDir: resolveGitCommonDir(root),
  };
}

function findGitRoot(cwd: string): string | null {
  let current = resolve(cwd);
  while (true) {
    if (existsSync(join(current, ".git"))) {
      return current;
    }

    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

function resolveGitCommonDir(root: string): string {
  const gitPath = join(root, ".git");
  try {
    const content = readFileSync(gitPath, "utf8").trim();
    const match = /^gitdir:\s*(.+)$/i.exec(content);
    if (match?.[1]) {
      return resolve(root, match[1]);
    }
  } catch {
    return gitPath;
  }
  return gitPath;
}

function resolveGitCurrentBranch(root: string): string | null {
  const result = Bun.spawnSync(["git", "-C", root, "branch", "--show-current"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (!result.success) {
    return null;
  }

  const branch = Buffer.from(result.stdout).toString("utf8").trim();
  return branch.length > 0 ? branch : null;
}

function resolveGitSubmodulePaths(root: string): JsonValue[] {
  const result = Bun.spawnSync(["git", "-C", root, "config", "--file", ".gitmodules", "--get-regexp", "path"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (!result.success) {
    return [];
  }

  return Buffer.from(result.stdout)
    .toString("utf8")
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/).at(1) ?? "")
    .filter((path) => path.length > 0);
}

function parseVSCodeCodexEndpoint(url: JsonValue | undefined): string {
  if (typeof url !== "string" || !url.startsWith("vscode://codex/")) {
    throw new Error(`Unsupported fetch URL: ${String(url)}`);
  }
  return url.slice("vscode://codex/".length);
}

function parseOptionalBody(body: JsonValue | undefined): JsonValue {
  if (typeof body !== "string" || body.length === 0) {
    return {};
  }
  return JSON.parse(body) as JsonValue;
}

function stripHostId(params: JsonObject): JsonObject {
  const { hostId: _hostId, ...rest } = params;
  return rest;
}

export function extensionVersionOf(webviewRoot: string | null): string {
  const version = webviewRoot ? parseExtensionVersion(basename(dirname(webviewRoot))) : null;
  return version ? version.join(".") : "0.0.0";
}

export function isRpcId(value: JsonValue | undefined): value is string | number {
  return typeof value === "string" || typeof value === "number";
}

export function serverRequestResponse(response: JsonObject): ServerRequestResponse {
  if (response.error !== undefined && response.error !== null) {
    return { error: response.error };
  }
  return { result: response.result ?? null };
}

function asObject(value: JsonValue | undefined): JsonObject | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value;
}

function requireObject(value: JsonValue | undefined, name: string): JsonObject {
  const object = asObject(value);
  if (!object) {
    throw new Error(`Invalid ${name}: expected object`);
  }
  return object;
}

function requireString(value: JsonValue | undefined, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Invalid ${name}: expected non-empty string`);
  }
  return value;
}

function encodeSseMessage(client: StreamClient, message: JsonObject, eventId: number): Uint8Array {
  return encoder.encode(`id: ${client.epoch}.${eventId}\ndata: ${JSON.stringify(message)}\n\n`);
}

function bufferedAfter(client: StreamClient, lastEventId: number | null): { id: number; payload: JsonObject }[] | null {
  if (lastEventId === null) {
    // No Last-Event-ID means this webview has not seen a single event yet, so
    // an intact buffer (still starting at the first event) is exactly what it
    // missed — a POST whose reply landed before the stream came up.
    const first = client.buffer[0];
    return first && first.id === 1 ? [...client.buffer] : null;
  }
  if (lastEventId === client.seq) {
    return [];
  }
  const oldest = client.buffer[0];
  if (!oldest || lastEventId < oldest.id - 1 || lastEventId > client.seq) {
    return null;
  }
  return client.buffer.filter((event) => event.id > lastEventId);
}

// A thread the webview drives against our app server: either it named one or
// the call created one.
function appServerThreadId(params: JsonValue, result: JsonValue): string | null {
  const fromResult = asObject(asObject(result)?.thread)?.id;
  if (typeof fromResult === "string") {
    return fromResult;
  }
  const fromParams = asObject(params)?.threadId;
  return typeof fromParams === "string" ? fromParams : null;
}

function parseHostMessageBatch(body: unknown): HostMessage[] {
  const messages = (body as { messages?: unknown } | null)?.messages;
  if (!Array.isArray(messages)) {
    throw new Error("host-message body must be { messages: [...] }");
  }
  return messages as HostMessage[];
}

function clientIdFromRequest(request: Request): string {
  const url = new URL(request.url);
  return url.searchParams.get("client") ?? request.headers.get("x-dispatcher-client") ?? "default";
}

// Sequence numbers restart whenever a client record is recreated (prune, host
// restart), so a resume is only meaningful when the epoch still matches.
function parseResumePoint(client: StreamClient, header: string | null): number | null {
  const separator = header?.lastIndexOf(".") ?? -1;
  if (!header || separator < 0 || header.slice(0, separator) !== client.epoch) {
    return null;
  }
  const parsed = Number(header.slice(separator + 1));
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

// An installed app launches its start_url without the token in the query, so
// the session has to outlive the browser process that first opened the link.
const authCookieMaxAgeSeconds = 90 * 24 * 60 * 60;

function authCookie(token: string, secure: boolean): string {
  // Secure is conditional on purpose: the LAN entry point is plain http, and an
  // unconditional flag would make the cookie unusable exactly there.
  return `${authCookieName}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Max-Age=${authCookieMaxAgeSeconds}; Path=${routePrefix || "/"}${secure ? "; Secure" : ""}`;
}

// The relay terminates TLS and forwards over plain http on loopback, so the
// original scheme only survives in the header it sets.
function isSecureRequest(request: Request, url: URL): boolean {
  return url.protocol === "https:" || request.headers.get("x-forwarded-proto") === "https";
}

function secretEquals(candidate: string | null, secret: string): boolean {
  if (candidate === null) {
    return false;
  }
  // Lengths are compared in bytes, not code units: timingSafeEqual throws on a
  // byte-length mismatch, so a multibyte candidate of the right character
  // length would turn a plain 401 into an unhandled exception.
  const candidateBytes = Buffer.from(candidate);
  const secretBytes = Buffer.from(secret);
  return candidateBytes.length === secretBytes.length && timingSafeEqual(candidateBytes, secretBytes);
}

function jsonValuesEqual(left: JsonValue, right: JsonValue): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function serveFile(filePath: string): Promise<Response> {
  const file = Bun.file(filePath);
  if (!(await file.exists())) {
    return new Response("Not found", { status: 404 });
  }

  return new Response(file, {
    headers: {
      "content-type": contentType(filePath),
    },
  });
}

function contentType(filePath: string): string {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (filePath.endsWith(".json")) return "application/json; charset=utf-8";
  if (filePath.endsWith(".wasm")) return "application/wasm";
  if (filePath.endsWith(".svg")) return "image/svg+xml";
  if (filePath.endsWith(".png")) return "image/png";
  if (filePath.endsWith(".jpg") || filePath.endsWith(".jpeg")) return "image/jpeg";
  return "application/octet-stream";
}

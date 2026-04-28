import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir, platform, release } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { CodexAppServer, CodexAppServerEvent, JsonObject, JsonValue } from "./codex-app-server";

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
};

type ExtensionWebviewSpikeOptions = {
  appServer: CodexAppServer;
  defaultCwd: string;
  getToken: () => string;
};

type SseClient = {
  id: string;
  controller: ReadableStreamDefaultController<Uint8Array>;
  heartbeat: ReturnType<typeof setInterval>;
};

type FetchResponseOptions = {
  requestId: string | undefined;
  result?: JsonValue;
  error?: string;
  status?: number;
};

const routePrefix = "/extension-spike";
const authCookieName = "codex_dispatcher_session";
const encoder = new TextEncoder();
const maxDiagnosticMessages = 200;
const globalState = new Map<string, JsonValue>();
const persistedAtomState = new Map<string, JsonValue>();
const sharedObjectState = new Map<string, JsonValue>();

export class ExtensionWebviewSpike {
  private readonly appServer: CodexAppServer;
  private readonly defaultCwd: string;
  private readonly getToken: () => string;
  private readonly clients = new Map<string, SseClient>();
  private readonly startedAt = new Date().toISOString();
  private readonly messageCounts = new Map<string, number>();
  private readonly recentMessages: JsonObject[] = [];
  private readonly hostErrors: JsonObject[] = [];
  private readonly experimentalEnablementSetResults = new Map<string, JsonValue>();
  private readonly webviewRoot: string | null;

  constructor(options: ExtensionWebviewSpikeOptions) {
    this.appServer = options.appServer;
    this.defaultCwd = options.defaultCwd;
    this.getToken = options.getToken;
    this.webviewRoot = resolveExtensionWebviewRoot();
  }

  canHandle(pathname: string): boolean {
    return pathname === routePrefix || pathname.startsWith(`${routePrefix}/`);
  }

  async fetch(request: Request, url: URL): Promise<Response> {
    if (!this.webviewRoot) {
      return new Response("Codex VS Code extension webview was not found.", { status: 404 });
    }

    if (!this.isAuthorized(request, url)) {
      return new Response("Unauthorized", { status: 401 });
    }

    if (url.pathname === `${routePrefix}/host-message`) {
      return this.handleHostMessage(request);
    }

    if (url.pathname === `${routePrefix}/events`) {
      return this.openEventStream();
    }

    if (url.pathname === `${routePrefix}/debug`) {
      return jsonResponse(this.debugSnapshot());
    }

    if (url.pathname === routePrefix || url.pathname === `${routePrefix}/` || url.pathname === `${routePrefix}/index.html`) {
      return this.serveIndex(url);
    }

    return this.serveAsset(url.pathname);
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
      url.searchParams.get("token") === token ||
      request.headers.get("x-dispatcher-token") === token ||
      cookieValue(request.headers.get("cookie"), authCookieName) === token
    );
  }

  private async serveIndex(url: URL): Promise<Response> {
    const indexPath = join(this.webviewRoot!, "index.html");
    let html = await Bun.file(indexPath).text();
    html = html.replace("<!-- PROD_BASE_TAG_HERE -->", `<base href="${routePrefix}/">`);
    html = html.replace("<!-- PROD_CSP_TAG_HERE -->", "");
    html = html.replace("<head>", `<head>\n${this.buildShim(url.searchParams.get("token") ?? "")}`);

    const headers = new Headers({ "content-type": "text/html; charset=utf-8" });
    if (url.searchParams.get("token") === this.getToken()) {
      headers.append("set-cookie", authCookie(this.getToken()));
    }

    return new Response(html, { headers });
  }

  private async serveAsset(pathname: string): Promise<Response> {
    const assetPath = resolveWebviewAssetPath(this.webviewRoot!, pathname);
    if (!assetPath) {
      return new Response("Not found", { status: 404 });
    }

    const file = Bun.file(assetPath);
    if (!(await file.exists())) {
      return new Response("Not found", { status: 404 });
    }

    return new Response(file, {
      headers: {
        "content-type": contentType(assetPath),
      },
    });
  }

  private async handleHostMessage(request: Request): Promise<Response> {
    let message: HostMessage;
    try {
      message = (await request.json()) as HostMessage;
    } catch {
      return jsonResponse({ messages: [makeFetchResponse({ requestId: undefined, error: "Invalid JSON", status: 400 })] }, 400);
    }

    this.recordMessage("inbound", message);
    try {
      const messages = await this.routeHostMessage(message);
      for (const outbound of messages) {
        this.recordMessage("outbound", outbound);
      }
      return jsonResponse({ messages });
    } catch (error) {
      const hostError = {
        type: "host-message-error",
        error: error instanceof Error ? error.message : String(error),
        sourceType: typeof message.type === "string" ? message.type : "unknown",
      };
      this.remember(this.hostErrors, hostError);
      return jsonResponse({ messages: [hostError] }, 500);
    }
  }

  private async routeHostMessage(message: HostMessage): Promise<JsonObject[]> {
    switch (message.type) {
      case "ready":
        return [
          { type: "chat-font-settings", chatFontSize: null, chatCodeFontSize: null },
          { type: "custom-prompts-updated", prompts: [] },
          { type: "persisted-atom-sync", state: persistedStateObject() },
        ];

      case "persisted-atom-sync-request":
        return [{ type: "persisted-atom-sync", state: persistedStateObject() }];

      case "persisted-atom-update":
        updatePersistedAtomState(message);
        this.broadcast({
          type: "persisted-atom-updated",
          key: typeof message.key === "string" ? message.key : "",
          value: message.deleted ? null : message.value ?? null,
          deleted: message.deleted === true,
        });
        return [];

      case "persisted-atom-reset":
        persistedAtomState.clear();
        this.broadcast({ type: "persisted-atom-sync", state: {} });
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
          if (!jsonValuesEqual(sharedObjectValue(message.key), nextValue)) {
            sharedObjectState.set(message.key, nextValue);
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
        const result = await handleVSCodeRequest(endpoint, body, this.defaultCwd);
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

  private async handleMcpRequest(message: HostMessage): Promise<JsonObject> {
    const request = asObject(message.request);
    if (!request || typeof request.id !== "string" || typeof request.method !== "string") {
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
      return {
        type: "mcp-response",
        hostId: "local",
        message: { id: request.id, result },
      };
    } catch (error) {
      return {
        type: "mcp-response",
        hostId: "local",
        message: {
          id: request.id,
          error: { message: error instanceof Error ? error.message : String(error) },
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
    if (!response || (typeof response.id !== "string" && typeof response.id !== "number")) {
      throw new Error("Invalid mcp-response payload");
    }
    this.appServer.respondToServerRequest(String(response.id), response.result ?? null);
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
      value: sharedObjectValue(objectKey),
    };
  }

  private openEventStream(): Response {
    let clientId = "";
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        clientId = crypto.randomUUID();
        const heartbeat = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(": heartbeat\n\n"));
          } catch {
            clearInterval(heartbeat);
            this.clients.delete(clientId);
          }
        }, 5_000);
        this.clients.set(clientId, { id: clientId, controller, heartbeat });
        controller.enqueue(encoder.encode(": connected\n\n"));
      },
      cancel: () => {
        if (clientId) {
          const client = this.clients.get(clientId);
          if (client) {
            clearInterval(client.heartbeat);
          }
          this.clients.delete(clientId);
        }
      },
    });

    return new Response(stream, {
      headers: {
        "cache-control": "no-cache",
        "content-type": "text/event-stream; charset=utf-8",
      },
    });
  }

  private broadcast(message: JsonObject): void {
    this.recordMessage("outbound", message);
    const payload = encoder.encode(`data: ${JSON.stringify(message)}\n\n`);
    for (const client of this.clients.values()) {
      try {
        client.controller.enqueue(payload);
      } catch {
        clearInterval(client.heartbeat);
        this.clients.delete(client.id);
      }
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
  const eventsUrl = ${JSON.stringify(`${routePrefix}/events`)};
  const vscodeStateKey = "codex-extension-spike:vscode-state";
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
  const deliver = (messages) => {
    for (const message of messages || []) {
      remember(window.__codexHostAdapterInboundMessages, message);
      postToWindow(message);
    }
  };
  const sendHostMessage = async (message) => {
    remember(window.__codexHostAdapterMessages, message);
    try {
      const response = await fetch(hostMessageUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(message),
      });
      const body = await response.json();
      deliver(body.messages);
    } catch (error) {
      const adapterError = {
        type: "host-adapter-error",
        error: error instanceof Error ? error.message : String(error),
        sourceType: typeof message?.type === "string" ? message.type : "unknown",
      };
      remember(window.__codexHostAdapterInboundMessages, adapterError);
      console.error("[codex-extension-spike] host-message failed", error);
    }
  };

  window.__codexHostAdapterMessages = [];
  window.__codexHostAdapterInboundMessages = [];
  window.__codexHostAdapterClientErrors = [];
  window.addEventListener("error", (event) => rememberClientError(event.error ?? event.message));
  window.addEventListener("unhandledrejection", (event) => rememberClientError(event.reason));
  window.acquireVsCodeApi = () => ({
    postMessage: (message) => { void sendHostMessage(message); },
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

export function resolveExtensionWebviewRoot(): string | null {
  const configured = process.env.CODEX_EXTENSION_WEBVIEW_ROOT;
  if (configured && existsSync(join(configured, "index.html"))) {
    return resolve(configured);
  }

  const extensionsDir = join(homedir(), ".vscode", "extensions");
  let entries: string[];
  try {
    entries = readdirSync(extensionsDir);
  } catch {
    return null;
  }

  const roots = entries
    .filter((entry) => entry.startsWith("openai.chatgpt-"))
    .map((entry) => join(extensionsDir, entry, "webview"))
    .filter((root) => existsSync(join(root, "index.html")));

  return roots.sort(compareExtensionRoots).at(-1) ?? null;
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

export async function handleVSCodeRequest(endpoint: string, body: JsonValue, defaultCwd: string): Promise<JsonValue> {
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
    case "get-global-state":
      return { value: typeof params.key === "string" ? globalState.get(params.key) ?? null : null };
    case "set-global-state":
      if (typeof params.key === "string") {
        globalState.set(params.key, params.value ?? null);
      }
      return { success: true };
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
      return { version: extensionVersion(), buildNumber: null, buildFlavor: "prod", appName: "Codex", appIconMedium: null };
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
    signal: AbortSignal.timeout(10_000),
  };
  if (body !== undefined) {
    init.body = body;
  }

  const response = await fetch(url, init);

  if (!response.ok) {
    return makeFetchResponse({
      requestId,
      status: response.status,
      error: response.statusText || `HTTP ${response.status}`,
    });
  }

  const responseHeaders: JsonObject = {};
  response.headers.forEach((value, key) => {
    if (key.toLowerCase() !== "authorization") {
      responseHeaders[key] = value;
    }
  });

  const contentTypeHeader = response.headers.get("content-type") ?? "";
  let bodyJsonString: string;
  if (contentTypeHeader.includes("application/json")) {
    bodyJsonString = JSON.stringify(await response.json());
  } else {
    const bytes = Buffer.from(await response.arrayBuffer());
    bodyJsonString = JSON.stringify({ base64: bytes.toString("base64"), contentType: contentTypeHeader });
  }

  return {
    type: "fetch-response",
    responseType: "success",
    requestId,
    status: response.status,
    headers: responseHeaders,
    bodyJsonString,
  };
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

function updatePersistedAtomState(message: JsonObject): void {
  if (typeof message.key !== "string") {
    throw new Error("Invalid persisted atom update");
  }
  if (message.deleted === true) {
    persistedAtomState.delete(message.key);
    return;
  }
  persistedAtomState.set(message.key, message.value ?? null);
}

function persistedStateObject(): JsonObject {
  return Object.fromEntries(persistedAtomState.entries()) as JsonObject;
}

function sharedObjectValue(key: string): JsonValue {
  if (sharedObjectState.has(key)) {
    return sharedObjectState.get(key) ?? null;
  }

  switch (key) {
    case "host_config":
      return { id: "local", display_name: "Local", kind: "local" };
    case "remote_connections":
    case "remote_control_connections":
      return [];
    case "statsig_default_enable_features":
      return {};
    case "pending_worktrees":
    case "diff_comments":
    case "diff_comments_from_model":
    case "composer_prefill":
      return null;
    default:
      return null;
  }
}

function extensionVersion(): string {
  const root = resolveExtensionWebviewRoot();
  if (!root) {
    return "0.0.0";
  }

  const extensionDir = basename(dirname(root));
  return extensionDir.replace(/^openai\.chatgpt-/, "").replace(/-.+$/, "");
}

function compareExtensionRoots(left: string, right: string): number {
  return basename(dirname(left)).localeCompare(basename(dirname(right)), undefined, { numeric: true });
}

function asObject(value: JsonValue | undefined): JsonObject | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value;
}

function jsonResponse(value: JsonValue, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function authCookie(token: string): string {
  return `${authCookieName}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=${routePrefix}`;
}

function cookieValue(header: string | null, name: string): string | null {
  for (const part of header?.split(";") ?? []) {
    const [rawKey, ...rawValue] = part.trim().split("=");
    if (rawKey === name) {
      try {
        return decodeURIComponent(rawValue.join("="));
      } catch {
        return null;
      }
    }
  }
  return null;
}

function jsonValuesEqual(left: JsonValue, right: JsonValue): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
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

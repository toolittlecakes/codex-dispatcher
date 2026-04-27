import { randomBytes } from "node:crypto";
import { networkInterfaces } from "node:os";
import { resolve, sep } from "node:path";
import { CodexAppServer, type JsonObject, type JsonValue } from "./codex-app-server";
import { CodexIpcBridge, type IpcBroadcastMessage } from "./codex-ipc";

type ClientMessage = {
  type?: string;
  requestId?: string;
  threadId?: string;
  turnId?: string;
  ownerClientId?: string;
  method?: string;
  text?: string;
  cwd?: string;
  limit?: number;
  searchTerm?: string;
  appServerRequestId?: string;
  params?: JsonValue;
  result?: JsonValue;
};

type WsData = {
  connectedAt: number;
};

const port = Number(process.env.PORT ?? "8787");
const host = process.env.HOST ?? "0.0.0.0";
const dispatcherToken = process.env.DISPATCHER_TOKEN ?? randomBytes(18).toString("base64url");
const defaultCwd = process.env.CODEX_DISPATCHER_CWD ?? process.cwd();
const publicRoot = resolve(import.meta.dir, "../public");
const appServer = new CodexAppServer();
const ipcBridge = new CodexIpcBridge();
const clients = new Set<Bun.ServerWebSocket<WsData>>();
const streamOwners = new Map<string, string>();

const followerRequestMethods = new Set([
  "thread-follower-start-turn",
  "thread-follower-steer-turn",
  "thread-follower-interrupt-turn",
  "thread-follower-compact-thread",
  "thread-follower-set-model-and-reasoning",
  "thread-follower-set-collaboration-mode",
  "thread-follower-edit-last-user-turn",
  "thread-follower-command-approval-decision",
  "thread-follower-file-approval-decision",
  "thread-follower-permissions-request-approval-response",
  "thread-follower-submit-user-input",
  "thread-follower-submit-mcp-server-elicitation-response",
  "thread-follower-set-queued-follow-ups-state",
]);

appServer.onEvent((event) => {
  if (event.type === "notification") {
    broadcast({ type: "codexNotification", notification: event.notification });
    return;
  }

  if (event.type === "serverRequest") {
    broadcast({ type: "serverRequest", request: event.request });
    return;
  }

  if (event.type === "serverRequestResolved") {
    broadcast({ type: "serverRequestResolved", id: event.id });
    return;
  }

  if (event.type === "stderr") {
    broadcast({ type: "appServerStderr", text: event.text });
    return;
  }

  broadcast({ type: "appServerStatus", status: event.status, detail: event.detail });
});

ipcBridge.onEvent((event) => {
  if (event.type === "broadcast") {
    const ownersChanged = applyIpcBroadcastEffects(event.broadcast);
    broadcast({
      type: "codexIpcBroadcast",
      broadcast: event.broadcast,
      ipc: event.snapshot,
      streamOwners: streamOwnersSnapshot(),
    });
    if (ownersChanged) {
      broadcast({ type: "threadStreamOwners", streamOwners: streamOwnersSnapshot() });
    }
    return;
  }

  if (event.type === "stderr") {
    broadcast({
      type: "codexIpcStderr",
      text: event.text,
      ipc: event.snapshot,
    });
    return;
  }

  broadcast({
    type: "codexIpcStatus",
    ipc: event.snapshot,
  });
});

await appServer.start();
await ipcBridge.start();

let server: Bun.Server<WsData>;
try {
  server = Bun.serve<WsData>({
  port,
  hostname: host,
  async fetch(request, bunServer) {
    const url = new URL(request.url);
    if (url.pathname === "/ws") {
      if (url.searchParams.get("token") !== dispatcherToken) {
        return new Response("Unauthorized", { status: 401 });
      }

      if (bunServer.upgrade(request, { data: { connectedAt: Date.now() } })) {
        return undefined;
      }

      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    return serveStatic(url.pathname);
  },
  websocket: {
    open(ws) {
      clients.add(ws);
      send(ws, {
        type: "ready",
        appServer: appServer.initialized,
        codexCliPath: appServer.codexCliPath,
        defaultCwd,
        ipc: ipcBridge.getSnapshot(),
        streamOwners: streamOwnersSnapshot(),
        pendingServerRequests: appServer.getPendingServerRequests(),
      });
    },
    close(ws) {
      clients.delete(ws);
    },
    message(ws, rawMessage) {
      void handleClientMessage(ws, rawMessage);
    },
  },
  });
} catch (error) {
  ipcBridge.stop();
  appServer.stop();
  throw error;
}

console.log(`Codex dispatcher listening on ${server.url.toString()}`);
console.log(`Open locally: http://localhost:${port}/?token=${dispatcherToken}`);
for (const address of lanAddresses()) {
  console.log(`Open from phone: http://${address}:${port}/?token=${dispatcherToken}`);
}

process.once("SIGINT", () => {
  ipcBridge.stop();
  appServer.stop();
  process.exit(0);
});

process.once("SIGTERM", () => {
  ipcBridge.stop();
  appServer.stop();
  process.exit(0);
});

async function handleClientMessage(ws: Bun.ServerWebSocket<WsData>, rawMessage: string | Buffer): Promise<void> {
  let message: ClientMessage;
  try {
    message = JSON.parse(rawMessage.toString()) as ClientMessage;
  } catch {
    send(ws, { type: "error", error: "Invalid JSON message" });
    return;
  }

  if (!message.type) {
    respond(ws, message.requestId, false, null, "Missing message type");
    return;
  }

  try {
    const result = await routeClientMessage(message);
    respond(ws, message.requestId, true, result, null);
  } catch (error) {
    respond(ws, message.requestId, false, null, error instanceof Error ? error.message : String(error));
  }
}

async function routeClientMessage(message: ClientMessage): Promise<JsonValue> {
  switch (message.type) {
    case "listThreads":
      return appServer.request("thread/list", {
        limit: typeof message.limit === "number" ? message.limit : 40,
        sortKey: "updated_at",
        sortDirection: "desc",
        archived: false,
        sourceKinds: [
          "cli",
          "vscode",
          "exec",
          "appServer",
          "subAgent",
          "subAgentReview",
          "subAgentCompact",
          "subAgentThreadSpawn",
          "subAgentOther",
          "unknown",
        ],
        searchTerm: normalizeOptionalString(message.searchTerm),
      });

    case "readThread":
      return appServer.request("thread/read", {
        threadId: requireString(message.threadId, "threadId"),
        includeTurns: true,
      });

    case "startThread":
      return appServer.request("thread/start", {
        cwd: normalizeOptionalString(message.cwd) ?? defaultCwd,
        serviceName: "codex_mobile_dispatcher",
        experimentalRawEvents: false,
        persistExtendedHistory: true,
      });

    case "resumeThread":
      return appServer.request("thread/resume", {
        threadId: requireString(message.threadId, "threadId"),
        persistExtendedHistory: true,
      });

    case "startTurn":
      return appServer.request("turn/start", {
        threadId: requireString(message.threadId, "threadId"),
        input: [textInput(requireString(message.text, "text"))],
        cwd: normalizeOptionalString(message.cwd),
      });

    case "steerTurn":
      return appServer.request("turn/steer", {
        threadId: requireString(message.threadId, "threadId"),
        expectedTurnId: requireString(message.turnId, "turnId"),
        input: [textInput(requireString(message.text, "text"))],
      });

    case "interruptTurn":
      return appServer.request("turn/interrupt", {
        threadId: requireString(message.threadId, "threadId"),
        turnId: requireString(message.turnId, "turnId"),
      });

    case "ipcFollowerRequest": {
      const threadId = requireString(message.threadId, "threadId");
      const method = requireFollowerRequestMethod(message.method);
      const ownerClientId = normalizeOptionalString(message.ownerClientId) ?? streamOwners.get(threadId);
      if (!ownerClientId) {
        throw new Error(`No IPC owner for thread ${threadId}`);
      }

      const response = await ipcBridge.request(method, message.params ?? {}, {
        targetClientId: ownerClientId,
      });
      if (response.resultType === "error") {
        throw new Error(response.error ?? `${method} failed`);
      }

      return response.result ?? { ok: true };
    }

    case "respondServerRequest":
      appServer.respondToServerRequest(
        requireString(message.appServerRequestId, "appServerRequestId"),
        message.result ?? null,
      );
      return { ok: true };

    default:
      throw new Error(`Unsupported client message type: ${message.type}`);
  }
}

function textInput(text: string): JsonValue {
  return {
    type: "text",
    text,
    text_elements: [],
  };
}

function applyIpcBroadcastEffects(broadcastMessage: IpcBroadcastMessage): boolean {
  if (broadcastMessage.method === "thread-stream-state-changed") {
    const params = asJsonObject(broadcastMessage.params);
    const threadId = typeof params?.conversationId === "string" ? params.conversationId : null;
    if (!threadId || !broadcastMessage.sourceClientId) {
      return false;
    }

    const previousOwner = streamOwners.get(threadId);
    streamOwners.set(threadId, broadcastMessage.sourceClientId);
    return previousOwner !== broadcastMessage.sourceClientId;
  }

  if (broadcastMessage.method !== "client-status-changed") {
    return false;
  }

  const params = asJsonObject(broadcastMessage.params);
  if (params?.status !== "disconnected" || typeof params.clientId !== "string") {
    return false;
  }

  let changed = false;
  for (const [threadId, ownerClientId] of streamOwners.entries()) {
    if (ownerClientId !== params.clientId) {
      continue;
    }

    streamOwners.delete(threadId);
    changed = true;
  }
  return changed;
}

function streamOwnersSnapshot(): JsonValue {
  return Array.from(streamOwners.entries()).map(([threadId, ownerClientId]) => ({
    threadId,
    ownerClientId,
  }));
}

function requireFollowerRequestMethod(method: string | undefined): string {
  if (!method || !followerRequestMethods.has(method)) {
    throw new Error(`Unsupported IPC follower method: ${method ?? "missing"}`);
  }

  return method;
}

function asJsonObject(value: JsonValue | undefined): JsonObject | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  return value;
}

async function serveStatic(pathname: string): Promise<Response> {
  const decodedPath = decodeURIComponent(pathname === "/" ? "/index.html" : pathname);
  const filePath = resolve(publicRoot, `.${decodedPath}`);
  if (!filePath.startsWith(`${publicRoot}${sep}`)) {
    return new Response("Not found", { status: 404 });
  }

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
  if (filePath.endsWith(".webmanifest")) return "application/manifest+json; charset=utf-8";
  if (filePath.endsWith(".svg")) return "image/svg+xml";
  return "application/octet-stream";
}

function send(ws: Bun.ServerWebSocket<WsData>, value: JsonValue): void {
  ws.send(JSON.stringify(value));
}

function broadcast(value: JsonValue): void {
  const payload = JSON.stringify(value);
  for (const ws of clients) {
    ws.send(payload);
  }
}

function respond(
  ws: Bun.ServerWebSocket<WsData>,
  requestId: string | undefined,
  ok: boolean,
  result: JsonValue,
  error: string | null,
): void {
  send(ws, {
    type: "response",
    requestId,
    ok,
    result,
    error,
  });
}

function requireString(value: string | undefined, name: string): string {
  if (!value || value.trim().length === 0) {
    throw new Error(`Missing ${name}`);
  }

  return value;
}

function normalizeOptionalString(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function lanAddresses(): string[] {
  const addresses: string[] = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) {
        addresses.push(entry.address);
      }
    }
  }
  return addresses;
}

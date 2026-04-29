import { createHash, randomBytes } from "node:crypto";
import { networkInterfaces } from "node:os";
import { resolve, sep } from "node:path";
import { applyJsonPatches, cloneJson } from "../public/json-patch.js";
import { CodexAppServer, type JsonObject, type JsonValue } from "./codex-app-server";
import { CodexIpcBridge, type IpcBroadcastMessage } from "./codex-ipc";
import {
  buildDispatcherSnapshotParams,
  buildDispatcherTurnStartRequest,
  buildQueuedFollowUpsBroadcastParams,
  dispatcherIpcHostId,
  updateCollaborationModeSettings,
} from "./dispatcher-owner";
import { ExtensionWebview } from "./extension-webview";

type ClientMessage = {
  type?: string;
  requestId?: string;
  threadId?: string;
  turnId?: string;
  ownerClientId?: string;
  method?: string;
  text?: string;
  cwd?: string;
  input?: JsonValue;
  model?: string | null;
  effort?: string | null;
  reasoningEffort?: string | null;
  collaborationMode?: JsonValue;
  inheritThreadSettings?: boolean;
  state?: JsonValue;
  limit?: number;
  searchTerm?: string;
  appServerRequestId?: string;
  params?: JsonValue;
  result?: JsonValue;
};

type WsData = {
  connectionId: string;
  connectedAt: number;
  remoteAddress: string | null;
  userAgent: string | null;
};

const port = Number(process.env.PORT ?? "8787");
const host = process.env.HOST ?? "0.0.0.0";
let dispatcherToken = process.env.DISPATCHER_TOKEN ?? randomBytes(18).toString("base64url");
let tokenCreatedAt = Date.now();
const defaultCwd = process.env.CODEX_DISPATCHER_CWD ?? process.cwd();
const dispatcherRemoteUrl = normalizeBaseUrl(process.env.DISPATCHER_REMOTE_URL);
const primaryClientPath = "/";
const publicRoot = resolve(import.meta.dir, "../public");
const appServer = new CodexAppServer();
const ipcBridge = new CodexIpcBridge();
const extensionWebview = new ExtensionWebview({
  appServer,
  defaultCwd,
  getToken: () => dispatcherToken,
  assertThreadFollowerOwner: (conversationId) => assertExtensionFollowerOwner(conversationId),
  handleIpcRequest: (method, params, targetClientId) => handleExtensionIpcRequest(method, params, targetClientId),
  getThreadRole: (conversationId) => extensionThreadRole(conversationId),
  handleFollowerRequest: (method, params) => handleExtensionFollowerRequest(method, params),
  handleThreadStreamSnapshotRequest: (hostId, conversationId) =>
    handleExtensionThreadStreamSnapshotRequest(hostId, conversationId),
});
const clients = new Set<Bun.ServerWebSocket<WsData>>();
const streamOwners = new Map<string, string>();
const mirroredConversations = new Map<string, JsonObject>();
const dispatcherOwnedConversations = new Map<string, JsonObject>();
const dispatcherOwnedRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>();

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

const dispatcherOwnerRequestMethods = new Set([
  "thread-follower-start-turn",
  "thread-follower-steer-turn",
  "thread-follower-interrupt-turn",
  "thread-follower-compact-thread",
  "thread-follower-set-model-and-reasoning",
  "thread-follower-set-collaboration-mode",
  "thread-follower-command-approval-decision",
  "thread-follower-file-approval-decision",
  "thread-follower-permissions-request-approval-response",
  "thread-follower-submit-user-input",
  "thread-follower-submit-mcp-server-elicitation-response",
  "thread-follower-set-queued-follow-ups-state",
]);

appServer.onEvent((event) => {
  extensionWebview.handleAppServerEvent(event);

  if (event.type === "notification") {
    broadcast({ type: "codexNotification", notification: event.notification });
    const threadId = notificationThreadId(event.notification);
    if (threadId && dispatcherOwnedConversations.has(threadId)) {
      scheduleDispatcherOwnedRefresh(threadId);
    }
    return;
  }

  if (event.type === "serverRequest") {
    broadcast({ type: "serverRequest", request: event.request });
    const threadId = requestThreadId(event.request);
    if (threadId && dispatcherOwnedConversations.has(threadId)) {
      scheduleDispatcherOwnedRefresh(threadId, 0);
    }
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
    extensionWebview.handleIpcBroadcast(event.broadcast);
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
    if (event.broadcast.method === "client-status-changed") {
      const params = asJsonObject(event.broadcast.params);
      if (params?.status === "connected") {
        broadcastDispatcherOwnedSnapshots();
      }
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

  const ownersCleared = clearIpcMirrorsIfDisconnected(event.snapshot.status);
  broadcast({
    type: "codexIpcStatus",
    ipc: event.snapshot,
  });
  if (ownersCleared) {
    broadcast({ type: "threadStreamOwners", streamOwners: streamOwnersSnapshot() });
  }
});

for (const method of dispatcherOwnerRequestMethods) {
  ipcBridge.addRequestHandler(
    method,
    (requestMessage) => canHandleDispatcherOwnerRequest(requestMessage.method, requestMessage.params),
    (requestMessage) => handleDispatcherOwnerRequest(requestMessage.method, requestMessage.params),
  );
}

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

      if (bunServer.upgrade(request, {
        data: {
          connectionId: randomBytes(8).toString("base64url"),
          connectedAt: Date.now(),
          remoteAddress: clientAddress(request),
          userAgent: request.headers.get("user-agent"),
        },
      })) {
        return undefined;
      }

      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    if (extensionWebview.canHandle(url.pathname)) {
      return extensionWebview.fetch(request, url);
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
        security: securitySnapshot(ws.data.connectionId),
        streamOwners: streamOwnersSnapshot(),
        mirroredConversations: mirroredConversationsSnapshot(),
        pendingServerRequests: appServer.getPendingServerRequests(),
      });
      broadcastSecurity();
    },
    close(ws) {
      clients.delete(ws);
      broadcastSecurity();
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
console.log(`Open locally: ${clientUrl(`http://localhost:${port}`)}`);
for (const address of lanAddresses()) {
  console.log(`Open from phone: ${clientUrl(`http://${address}:${port}`)}`);
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
    const result = await routeClientMessage(message, ws.data.connectionId);
    respond(ws, message.requestId, true, result, null);
  } catch (error) {
    respond(ws, message.requestId, false, null, error instanceof Error ? error.message : String(error));
  }
}

async function routeClientMessage(message: ClientMessage, connectionId?: string): Promise<JsonValue> {
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

    case "startThread": {
      const result = await appServer.request("thread/start", {
        cwd: normalizeOptionalString(message.cwd) ?? defaultCwd,
        serviceName: "codex_mobile_dispatcher",
        experimentalRawEvents: false,
        persistExtendedHistory: true,
      });
      markDispatcherOwnerFromResult(result);
      return result;
    }

    case "resumeThread":
      return appServer.request("thread/resume", {
        threadId: requireString(message.threadId, "threadId"),
        persistExtendedHistory: true,
      });

    case "forkThread":
      return appServer.request("thread/fork", {
        threadId: requireString(message.threadId, "threadId"),
      });

    case "startTurn": {
      const threadId = requireString(message.threadId, "threadId");
      const result = await appServer.request("turn/start", buildClientTurnStartRequest(message, threadId));
      markDispatcherOwner(threadId);
      scheduleDispatcherOwnedRefresh(threadId, 0);
      return result;
    }

    case "steerTurn": {
      const threadId = requireString(message.threadId, "threadId");
      const result = await appServer.request("turn/steer", {
        threadId,
        expectedTurnId: requireString(message.turnId, "turnId"),
        input: clientInput(message),
      });
      scheduleDispatcherOwnedRefresh(threadId, 0);
      return result;
    }

    case "interruptTurn": {
      const threadId = requireString(message.threadId, "threadId");
      const result = await appServer.request("turn/interrupt", {
        threadId,
        turnId: requireString(message.turnId, "turnId"),
      });
      scheduleDispatcherOwnedRefresh(threadId, 0);
      return result;
    }

    case "compactThread": {
      const threadId = requireString(message.threadId, "threadId");
      const result = await appServer.request("thread/compact/start", { threadId });
      scheduleDispatcherOwnedRefresh(threadId, 0);
      return result ?? { ok: true };
    }

    case "setThreadSettings": {
      const threadId = requireString(message.threadId, "threadId");
      await ensureDispatcherOwnedConversation(threadId);
      updateDispatcherOwnedConversation(threadId, (conversation) => {
        const model = normalizeNullableString(message.model);
        const reasoningEffort = normalizeNullableString(message.reasoningEffort ?? message.effort);
        if (model !== undefined) {
          conversation.latestModel = model;
        }
        if (reasoningEffort !== undefined) {
          conversation.latestReasoningEffort = reasoningEffort;
        }
        if (message.inheritThreadSettings === false || message.collaborationMode !== undefined) {
          conversation.latestCollaborationMode = message.collaborationMode ?? null;
        } else {
          const nextModel = model === undefined ? nullableConversationString(conversation.latestModel) : model;
          const nextReasoningEffort = reasoningEffort === undefined ? conversation.latestReasoningEffort : reasoningEffort;
          conversation.latestCollaborationMode = updateCollaborationModeSettings(
            conversation.latestCollaborationMode,
            nextModel,
            nextReasoningEffort,
          );
        }
      });
      broadcastDispatcherOwnedSnapshot(threadId);
      return { ok: true };
    }

    case "setQueuedFollowUps": {
      const threadId = requireString(message.threadId, "threadId");
      const stateValue = message.state ?? {};
      await ensureDispatcherOwnedConversation(threadId);
      updateDispatcherOwnedConversation(threadId, (conversation) => {
        conversation.queuedFollowUpsState = stateValue;
      });
      ipcBridge.broadcast("thread-queued-followups-changed", buildQueuedFollowUpsBroadcastParams(threadId, stateValue));
      broadcastDispatcherOwnedSnapshot(threadId);
      return { ok: true };
    }

    case "rotateToken": {
      dispatcherToken = randomBytes(18).toString("base64url");
      tokenCreatedAt = Date.now();
      const snapshot = securitySnapshot(connectionId);
      broadcastSecurity();
      return {
        token: dispatcherToken,
        security: snapshot,
      };
    }

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
      scheduleRefreshForServerRequest(requireString(message.appServerRequestId, "appServerRequestId"));
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

function buildClientTurnStartRequest(message: ClientMessage, threadId: string): JsonObject {
  const params: JsonObject = {
    threadId,
    input: clientInput(message),
    cwd: normalizeOptionalString(message.cwd),
  };
  const model = normalizeNullableString(message.model);
  const effort = normalizeNullableString(message.effort ?? message.reasoningEffort);
  if (model !== undefined) {
    params.model = model;
  }
  if (effort !== undefined) {
    params.effort = effort;
  }
  if (message.collaborationMode !== undefined || message.inheritThreadSettings === false) {
    params.collaborationMode = message.collaborationMode ?? null;
  }
  return params;
}

function clientInput(message: ClientMessage): JsonValue[] {
  if (Array.isArray(message.input) && message.input.length > 0) {
    const input = message.input.filter(isJsonObject);
    if (input.length > 0) {
      return input;
    }
  }
  return [textInput(requireString(message.text, "text"))];
}

async function readThreadObject(threadId: string): Promise<JsonObject> {
  const result = await appServer.request("thread/read", {
    threadId,
    includeTurns: true,
  });
  const resultObject = asJsonObject(result);
  const thread = asJsonObject(resultObject?.thread);
  if (!thread) {
    throw new Error(`Thread ${threadId} not found`);
  }
  return thread;
}

async function ensureDispatcherOwnedConversation(threadId: string): Promise<void> {
  if (dispatcherOwnedConversations.has(threadId)) {
    return;
  }
  const thread = await readThreadObject(threadId);
  dispatcherOwnedConversations.set(threadId, conversationFromThread(threadId, thread));
}

function applyIpcBroadcastEffects(broadcastMessage: IpcBroadcastMessage): boolean {
  if (broadcastMessage.method === "thread-stream-state-changed") {
    const params = asJsonObject(broadcastMessage.params);
    if (!params) {
      return false;
    }

    const threadId = typeof params?.conversationId === "string" ? params.conversationId : null;
    if (!threadId || !broadcastMessage.sourceClientId) {
      return false;
    }

    const previousOwner = streamOwners.get(threadId);
    if (!applyConversationMirror(threadId, params)) {
      streamOwners.delete(threadId);
      return previousOwner !== undefined;
    }

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
    mirroredConversations.delete(threadId);
    changed = true;
  }
  return changed;
}

async function handleDispatcherOwnerRequest(method: string, paramsValue: JsonValue | undefined): Promise<JsonValue> {
  const params = requireJsonObject(paramsValue, "params");
  const conversationId = requireJsonString(params.conversationId, "conversationId");
  if (!dispatcherOwnedConversations.has(conversationId)) {
    throw new Error(`Dispatcher does not own thread ${conversationId}`);
  }

  switch (method) {
    case "thread-follower-start-turn":
      return handleDispatcherOwnerStartTurn(conversationId, params);

    case "thread-follower-steer-turn":
      return handleDispatcherOwnerSteerTurn(conversationId, params);

    case "thread-follower-interrupt-turn":
      return handleDispatcherOwnerInterruptTurn(conversationId);

    case "thread-follower-compact-thread": {
      const result = await appServer.request("thread/compact/start", { threadId: conversationId });
      scheduleDispatcherOwnedRefresh(conversationId, 0);
      return result ?? { ok: true };
    }

    case "thread-follower-command-approval-decision":
    case "thread-follower-file-approval-decision": {
      const requestId = requireJsonString(params.requestId, "requestId");
      const decision = requireJsonString(params.decision, "decision");
      appServer.respondToServerRequest(requestId, { decision });
      scheduleDispatcherOwnedRefresh(conversationId, 0);
      return { ok: true };
    }

    case "thread-follower-permissions-request-approval-response":
    case "thread-follower-submit-user-input":
    case "thread-follower-submit-mcp-server-elicitation-response": {
      const requestId = requireJsonString(params.requestId, "requestId");
      appServer.respondToServerRequest(requestId, params.response ?? null);
      scheduleDispatcherOwnedRefresh(conversationId, 0);
      return { ok: true };
    }

    case "thread-follower-set-model-and-reasoning":
      updateDispatcherOwnedConversation(conversationId, (conversation) => {
        const model = nullableJsonString(params.model, "model");
        conversation.latestModel = model;
        if (typeof params.reasoningEffort === "string" || params.reasoningEffort === null) {
          conversation.latestReasoningEffort = params.reasoningEffort;
        }
        const reasoningEffort =
          params.reasoningEffort === undefined ? conversation.latestReasoningEffort : params.reasoningEffort;
        conversation.latestCollaborationMode = updateCollaborationModeSettings(
          conversation.latestCollaborationMode,
          model,
          reasoningEffort,
        );
      });
      broadcastDispatcherOwnedSnapshot(conversationId);
      return { ok: true };

    case "thread-follower-set-collaboration-mode":
      updateDispatcherOwnedConversation(conversationId, (conversation) => {
        conversation.latestCollaborationMode = params.collaborationMode ?? null;
      });
      broadcastDispatcherOwnedSnapshot(conversationId);
      return { ok: true };

    case "thread-follower-set-queued-follow-ups-state":
      updateDispatcherOwnedConversation(conversationId, (conversation) => {
        conversation.queuedFollowUpsState = params.state ?? null;
      });
      ipcBridge.broadcast(
        "thread-queued-followups-changed",
        buildQueuedFollowUpsBroadcastParams(conversationId, params.state ?? null),
      );
      broadcastDispatcherOwnedSnapshot(conversationId);
      return { ok: true };

    default:
      throw new Error(`Unsupported dispatcher owner method: ${method}`);
  }
}

async function handleDispatcherOwnerStartTurn(conversationId: string, params: JsonObject): Promise<JsonValue> {
  const turnStartParams = requireJsonObject(params.turnStartParams, "turnStartParams");
  const result = await appServer.request(
    "turn/start",
    buildDispatcherTurnStartRequest(
      conversationId,
      dispatcherOwnedConversations.get(conversationId),
      turnStartParams,
    ),
  );
  scheduleDispatcherOwnedRefresh(conversationId, 0);
  return { result };
}

async function handleDispatcherOwnerSteerTurn(conversationId: string, params: JsonObject): Promise<JsonValue> {
  const turnId = findInProgressTurnId(dispatcherOwnedConversations.get(conversationId));
  if (!turnId) {
    throw new Error(`No active turn for thread ${conversationId}`);
  }

  const result = await appServer.request("turn/steer", {
    threadId: conversationId,
    expectedTurnId: turnId,
    input: Array.isArray(params.input) ? params.input : [],
  });
  scheduleDispatcherOwnedRefresh(conversationId, 0);
  return { result };
}

async function handleDispatcherOwnerInterruptTurn(conversationId: string): Promise<JsonValue> {
  const turnId = findInProgressTurnId(dispatcherOwnedConversations.get(conversationId));
  if (!turnId) {
    return { ok: true };
  }

  const result = await appServer.request("turn/interrupt", {
    threadId: conversationId,
    turnId,
  });
  scheduleDispatcherOwnedRefresh(conversationId, 0);
  return result ?? { ok: true };
}

function canHandleDispatcherOwnerRequest(method: string, paramsValue: JsonValue | undefined): boolean {
  if (!dispatcherOwnerRequestMethods.has(method)) {
    return false;
  }

  const params = asJsonObject(paramsValue);
  const conversationId = typeof params?.conversationId === "string" ? params.conversationId : null;
  return Boolean(conversationId && dispatcherOwnedConversations.has(conversationId));
}

function markDispatcherOwnerFromResult(result: JsonValue): void {
  const resultObject = asJsonObject(result);
  const thread = asJsonObject(resultObject?.thread);
  if (!thread || typeof thread.id !== "string") {
    return;
  }

  const threadId = thread.id;
  dispatcherOwnedConversations.set(
    threadId,
    conversationFromThread(threadId, thread, dispatcherOwnedConversations.get(threadId)),
  );
  broadcastDispatcherOwnedSnapshot(threadId);
}

function markDispatcherOwner(threadId: string): void {
  if (!dispatcherOwnedConversations.has(threadId)) {
    dispatcherOwnedConversations.set(threadId, minimalDispatcherConversation(threadId));
  }
  broadcastDispatcherOwnedSnapshot(threadId);
}

function scheduleDispatcherOwnedRefresh(threadId: string, delayMs = 120): void {
  const existing = dispatcherOwnedRefreshTimers.get(threadId);
  if (existing) {
    clearTimeout(existing);
  }

  const timer = setTimeout(() => {
    dispatcherOwnedRefreshTimers.delete(threadId);
    void refreshDispatcherOwnedConversation(threadId);
  }, delayMs);
  dispatcherOwnedRefreshTimers.set(threadId, timer);
}

async function refreshDispatcherOwnedConversation(threadId: string): Promise<void> {
  if (!dispatcherOwnedConversations.has(threadId)) {
    return;
  }

  const result = await appServer.request("thread/read", {
    threadId,
    includeTurns: true,
  });
  const resultObject = asJsonObject(result);
  const thread = asJsonObject(resultObject?.thread);
  if (!thread) {
    return;
  }

  dispatcherOwnedConversations.set(
    threadId,
    conversationFromThread(threadId, thread, dispatcherOwnedConversations.get(threadId)),
  );
  broadcastDispatcherOwnedSnapshot(threadId);
}

function scheduleRefreshForServerRequest(requestId: string): void {
  const request = appServer.getPendingServerRequest(requestId);
  const threadId = request ? requestThreadId(request) : null;
  if (threadId && dispatcherOwnedConversations.has(threadId)) {
    scheduleDispatcherOwnedRefresh(threadId, 0);
  }
}

function broadcastDispatcherOwnedSnapshots(): void {
  for (const threadId of dispatcherOwnedConversations.keys()) {
    broadcastDispatcherOwnedSnapshot(threadId);
  }
}

function broadcastDispatcherOwnedSnapshot(threadId: string): void {
  const conversation = dispatcherOwnedConversations.get(threadId);
  if (!conversation) {
    return;
  }

  ipcBridge.broadcast("thread-stream-state-changed", buildDispatcherSnapshotParams(threadId, conversation));
}

function extensionThreadRole(threadId: string): string {
  return dispatcherOwnedConversations.has(threadId) ? "owner" : "follower";
}

function assertExtensionFollowerOwner(threadId: string): void {
  if (!streamOwners.has(threadId)) {
    throw new Error(`No IPC owner for thread ${threadId}`);
  }
}

async function handleExtensionIpcRequest(
  method: string,
  params: JsonValue,
  targetClientId: string | undefined,
): Promise<JsonValue> {
  if (dispatcherOwnerRequestMethods.has(method) && canHandleDispatcherOwnerRequest(method, params)) {
    return handleDispatcherOwnerRequest(method, params);
  }

  const response = await ipcBridge.request(method, params, targetClientId ? { targetClientId } : {});
  if (response.resultType === "error") {
    throw new Error(response.error ?? `${method} failed`);
  }

  return response.result ?? { ok: true };
}

async function handleExtensionFollowerRequest(method: string, params: JsonValue): Promise<JsonValue> {
  const threadId = requestThreadId({ params });
  const ownerClientId = threadId ? streamOwners.get(threadId) : null;
  if (!ownerClientId) {
    throw new Error(`No IPC owner for thread ${threadId ?? "unknown"}`);
  }

  const response = await ipcBridge.request(method, params, { targetClientId: ownerClientId });
  if (response.resultType === "error") {
    throw new Error(response.error ?? `${method} failed`);
  }

  return response.result ?? { ok: true };
}

function handleExtensionThreadStreamSnapshotRequest(hostId: string, threadId: string): void {
  const conversation = mirroredConversations.get(threadId);
  const ownerClientId = streamOwners.get(threadId);
  if (!conversation || !ownerClientId) {
    return;
  }

  extensionWebview.handleIpcBroadcast({
    type: "broadcast",
    method: "thread-stream-state-changed",
    sourceClientId: ownerClientId,
    params: {
      conversationId: threadId,
      hostId,
      change: {
        type: "snapshot",
        conversationState: conversation,
      },
    },
  });
}

function updateDispatcherOwnedConversation(threadId: string, update: (conversation: JsonObject) => void): void {
  const current = dispatcherOwnedConversations.get(threadId) ?? minimalDispatcherConversation(threadId);
  const next = cloneJsonObject(current);
  update(next);
  dispatcherOwnedConversations.set(threadId, next);
}

function conversationFromThread(threadId: string, thread: JsonObject, previous?: JsonObject): JsonObject {
  return {
    ...preservedDispatcherConversationFields(previous),
    ...cloneJsonObject(thread),
    id: threadId,
    hostId: dispatcherIpcHostId,
    requests: pendingRequestsForThread(threadId),
  };
}

function preservedDispatcherConversationFields(previous: JsonObject | undefined): JsonObject {
  if (!previous) {
    return {};
  }

  const preserved: JsonObject = {};
  for (const key of ["queuedFollowUpsState", "latestModel", "latestReasoningEffort", "latestCollaborationMode"]) {
    if (previous[key] !== undefined) {
      preserved[key] = cloneJson(previous[key]);
    }
  }
  return preserved;
}

function minimalDispatcherConversation(threadId: string): JsonObject {
  return {
    id: threadId,
    hostId: dispatcherIpcHostId,
    title: null,
    name: null,
    preview: null,
    cwd: defaultCwd,
    source: "appServer",
    status: { type: "running" },
    turns: [],
    requests: pendingRequestsForThread(threadId),
  };
}

function pendingRequestsForThread(threadId: string): JsonValue[] {
  return appServer.getPendingServerRequests().filter((request) => requestThreadId(request) === threadId);
}

function notificationThreadId(notification: JsonObject): string | null {
  return requestThreadId({ params: notification.params ?? {} });
}

function requestThreadId(request: { params: JsonValue }): string | null {
  const params = asJsonObject(request.params);
  if (typeof params?.threadId === "string") {
    return params.threadId;
  }
  return typeof params?.conversationId === "string" ? params.conversationId : null;
}

function findInProgressTurnId(conversation: JsonObject | undefined): string | null {
  const turns = Array.isArray(conversation?.turns) ? conversation.turns : [];
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = asJsonObject(turns[index]);
    if (!turn) {
      continue;
    }

    const status = turn.status;
    if (status !== "inProgress" && status !== "in_progress") {
      continue;
    }

    if (typeof turn.turnId === "string") {
      return turn.turnId;
    }
    if (typeof turn.id === "string") {
      return turn.id;
    }
  }
  return null;
}

function streamOwnersSnapshot(): JsonValue {
  return Array.from(streamOwners.entries()).map(([threadId, ownerClientId]) => ({
    threadId,
    ownerClientId,
  }));
}

function mirroredConversationsSnapshot(): JsonValue {
  return Array.from(mirroredConversations.entries()).map(([threadId, conversation]) => ({
    threadId,
    conversation,
  }));
}

function securitySnapshot(currentConnectionId?: string): JsonObject {
  return {
    tokenFingerprint: tokenFingerprint(dispatcherToken),
    tokenCreatedAt,
    localUrl: `http://localhost:${port}`,
    lanUrls: lanAddresses().map((address) => `http://${address}:${port}`),
    remoteUrl: dispatcherRemoteUrl,
    activeSessions: Array.from(clients).map((client) => ({
      id: client.data.connectionId,
      connectedAt: client.data.connectedAt,
      current: client.data.connectionId === currentConnectionId,
      remoteAddress: client.data.remoteAddress,
      userAgent: client.data.userAgent,
    })),
  };
}

function broadcastSecurity(): void {
  for (const client of clients) {
    send(client, {
      type: "dispatcherSecurity",
      security: securitySnapshot(client.data.connectionId),
    });
  }
}

function tokenFingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 12);
}

function clientAddress(request: Request): string | null {
  const forwarded = request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for");
  return forwarded?.split(",")[0]?.trim() || null;
}

function clearIpcMirrorsIfDisconnected(status: string): boolean {
  if (status !== "disconnected" && status !== "error" && status !== "closed") {
    return false;
  }

  const changed = streamOwners.size > 0 || mirroredConversations.size > 0;
  streamOwners.clear();
  mirroredConversations.clear();
  return changed;
}

function applyConversationMirror(threadId: string, params: JsonObject): boolean {
  const change = asJsonObject(params.change);
  if (!change) {
    mirroredConversations.delete(threadId);
    return false;
  }

  if (change.type === "snapshot") {
    const conversationState = asJsonObject(change.conversationState);
    if (!conversationState) {
      mirroredConversations.delete(threadId);
      return false;
    }

    mirroredConversations.set(threadId, {
      ...cloneJsonObject(conversationState),
      id: typeof conversationState.id === "string" ? conversationState.id : threadId,
    });
    return true;
  }

  if (change.type !== "patches" || !Array.isArray(change.patches)) {
    mirroredConversations.delete(threadId);
    return false;
  }

  const current = mirroredConversations.get(threadId);
  if (!current) {
    console.warn(`Received IPC patches before snapshot for ${threadId}`);
    return false;
  }

  try {
    const next = applyJsonPatches(current, change.patches);
    if (isJsonObject(next)) {
      mirroredConversations.set(threadId, next);
      return true;
    }
  } catch (error) {
    console.warn(`Failed to apply IPC patches for ${threadId}: ${error instanceof Error ? error.message : String(error)}`);
  }

  mirroredConversations.delete(threadId);
  return false;
}

function requireFollowerRequestMethod(method: string | undefined): string {
  if (!method || !followerRequestMethods.has(method)) {
    throw new Error(`Unsupported IPC follower method: ${method ?? "missing"}`);
  }

  return method;
}

function asJsonObject(value: JsonValue | undefined): JsonObject | null {
  return isJsonObject(value) ? value : null;
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  return true;
}

function cloneJsonObject(value: JsonObject): JsonObject {
  const cloned = cloneJson(value);
  if (!isJsonObject(cloned)) {
    throw new Error("Cloned JSON object changed shape");
  }
  return cloned;
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

function requireJsonObject(value: JsonValue | undefined, name: string): JsonObject {
  const object = asJsonObject(value);
  if (!object) {
    throw new Error(`Missing ${name}`);
  }

  return object;
}

function requireJsonString(value: JsonValue | undefined, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Missing ${name}`);
  }

  return value;
}

function nullableJsonString(value: JsonValue | undefined, name: string): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(`Missing ${name}`);
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function nullableConversationString(value: JsonValue | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function normalizeOptionalString(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeNullableString(value: string | null | undefined): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeBaseUrl(value: string | undefined): string | null {
  if (!value) {
    return null;
  }
  try {
    const url = new URL(value);
    url.pathname = "";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

function clientUrl(baseUrl: string): string {
  const url = new URL(primaryClientPath, baseUrl);
  url.searchParams.set("token", dispatcherToken);
  return url.toString();
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

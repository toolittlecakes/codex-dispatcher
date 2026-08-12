import { randomBytes } from "node:crypto";
import { networkInterfaces } from "node:os";
import { CodexAppServer, type JsonObject, type JsonValue } from "./codex-app-server";
import { CodexIpcBridge, type IpcBroadcastMessage } from "./codex-ipc";
import {
  buildDispatcherSnapshotParams,
  buildDispatcherTurnStartRequest,
  buildFollowingStatusRequestParams,
  buildQueuedFollowUpsBroadcastParams,
  dispatcherIpcHostId,
  parseStreamFollowingChange,
  updateCollaborationModeSettings,
} from "./dispatcher-owner";
import { ExtensionWebview } from "./extension-webview";
import { applyJsonPatches, cloneJson } from "./json-patch";
import { asJsonObject, isJsonObject } from "./shared";

const port = Number(process.env.PORT ?? "8787");
const host = process.env.HOST ?? "0.0.0.0";
const dispatcherToken = process.env.DISPATCHER_TOKEN ?? randomBytes(18).toString("base64url");
const defaultCwd = process.env.CODEX_DISPATCHER_CWD ?? process.cwd();
const primaryClientPath = "/";
const appServer = new CodexAppServer();
const ipcBridge = new CodexIpcBridge();
const extensionWebview = new ExtensionWebview({
  appServer,
  defaultCwd,
  getToken: () => dispatcherToken,
  getEventReplayMessages: () => buildExtensionEventReplayMessages(),
  assertThreadFollowerOwner: (conversationId) => assertExtensionFollowerOwner(conversationId),
  handleIpcRequest: (method, params, targetClientId) => handleExtensionIpcRequest(method, params, targetClientId),
  getThreadRole: (conversationId) => extensionThreadRole(conversationId),
  handleFollowerRequest: (method, params) => handleExtensionFollowerRequest(method, params),
  handleThreadStreamSnapshotRequest: (hostId, conversationId) =>
    handleExtensionThreadStreamSnapshotRequest(hostId, conversationId),
  onThreadActivity: (method, conversationId, thread) => {
    if (!threadDrivingMethods.has(method) || !claimDispatcherOwnership(conversationId)) {
      return;
    }
    if (thread) {
      // thread/start already handed us the thread; reading it back would fail
      // anyway until the first user message materialises it.
      adoptDispatcherOwnedThread(conversationId, thread);
      return;
    }
    scheduleDispatcherOwnedRefresh(conversationId, 0);
  },
});
const streamOwners = new Map<string, string>();
const mirroredConversations = new Map<string, JsonObject>();
const dispatcherOwnedConversations = new Map<string, JsonObject>();
const dispatcherOwnedRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
// Who asked to be kept up to date on which thread. A thread nobody follows is
// still ours to drive, it just costs no traffic.
const streamFollowersByConversation = new Map<string, Set<string>>();

// Reading, listing, renaming or archiving a thread is not driving it: only a
// call that runs or creates a turn makes this dispatcher the owner.
const threadDrivingMethods = new Set([
  "thread/start",
  "thread/resume",
  "thread/fork",
  "thread/compact/start",
  "thread/rollback",
  "turn/start",
  "turn/steer",
  "turn/interrupt",
]);


const dispatcherOwnerRequestMethods = new Set([
  "thread-follower-start-turn",
  "thread-follower-edit-last-user-turn",
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
    const threadId = notificationThreadId(event.notification);
    if (threadId && claimDispatcherOwnership(threadId) && dispatcherOwnedThreadHasTurns(threadId)) {
      scheduleDispatcherOwnedRefresh(threadId);
    }
    return;
  }

  if (event.type === "serverRequest") {
    const threadId = requestThreadId(event.request);
    if (threadId && claimDispatcherOwnership(threadId)) {
      scheduleDispatcherOwnedRefresh(threadId, 0);
    }
    return;
  }

  if (event.type === "stderr") {
    console.error(`[app-server] ${event.text.trimEnd()}`);
    return;
  }

  if (event.type === "status") {
    console.log(`[app-server] ${event.status}${event.detail ? `: ${event.detail}` : ""}`);
  }
});

ipcBridge.onEvent((event) => {
  if (event.type === "broadcast") {
    extensionWebview.handleIpcBroadcast(event.broadcast);
    applyIpcBroadcastEffects(event.broadcast);
    return;
  }

  if (event.type === "stderr") {
    console.error(`[codex-ipc] ${event.text.trimEnd()}`);
    return;
  }

  clearIpcMirrorsIfDisconnected(event.snapshot.status);
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

let server: Bun.Server<undefined>;
try {
  server = Bun.serve({
    port,
    hostname: host,
    fetch(request) {
      return extensionWebview.fetch(request, new URL(request.url));
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

function applyIpcBroadcastEffects(broadcastMessage: IpcBroadcastMessage): void {
  if (broadcastMessage.method === "thread-stream-state-changed") {
    const params = asJsonObject(broadcastMessage.params);
    if (!params) {
      return;
    }

    const threadId = typeof params?.conversationId === "string" ? params.conversationId : null;
    if (!threadId || !broadcastMessage.sourceClientId) {
      return;
    }

    if (!applyConversationMirror(threadId, params)) {
      streamOwners.delete(threadId);
      return;
    }

    streamOwners.set(threadId, broadcastMessage.sourceClientId);
    releaseDispatcherOwnership(threadId);
    return;
  }

  if (broadcastMessage.method === "thread-stream-following-changed") {
    const change = parseStreamFollowingChange(broadcastMessage.params, broadcastMessage.sourceClientId);
    if (change) {
      applyStreamFollowingChange(change.conversationId, change.clientId, change.following);
    }
    return;
  }

  if (broadcastMessage.method !== "client-status-changed") {
    return;
  }

  const params = asJsonObject(broadcastMessage.params);
  if (params?.status !== "disconnected" || typeof params.clientId !== "string") {
    return;
  }

  for (const followers of streamFollowersByConversation.values()) {
    followers.delete(params.clientId);
  }

  for (const [threadId, ownerClientId] of streamOwners.entries()) {
    if (ownerClientId !== params.clientId) {
      continue;
    }

    streamOwners.delete(threadId);
    mirroredConversations.delete(threadId);
  }
}

// A client announcing it follows a thread we drive is the only thing that opens
// the tap: it gets the current state right away and every later change until it
// says otherwise.
function applyStreamFollowingChange(conversationId: string, clientId: string, following: boolean): void {
  const followers = streamFollowersByConversation.get(conversationId) ?? new Set<string>();
  if (!following) {
    followers.delete(clientId);
    if (followers.size === 0) {
      streamFollowersByConversation.delete(conversationId);
    }
    return;
  }

  followers.add(clientId);
  streamFollowersByConversation.set(conversationId, followers);
  sendDispatcherOwnedSnapshot(conversationId, [clientId]);
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

    case "thread-follower-edit-last-user-turn":
      return handleDispatcherOwnerEditLastUserTurn(
        conversationId,
        requireJsonString(params.turnId, "turnId"),
        requireJsonString(params.message, "message"),
      );

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
      appServer.respondToServerRequest(requestId, { result: { decision } });
      scheduleDispatcherOwnedRefresh(conversationId, 0);
      return { ok: true };
    }

    case "thread-follower-permissions-request-approval-response":
    case "thread-follower-submit-user-input":
    case "thread-follower-submit-mcp-server-elicitation-response": {
      const requestId = requireJsonString(params.requestId, "requestId");
      appServer.respondToServerRequest(requestId, { result: params.response ?? null });
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

// What the real owner does for this follower request: roll the last turn back
// and run it again with the edited message.
async function handleDispatcherOwnerEditLastUserTurn(
  conversationId: string,
  turnId: string,
  message: string,
): Promise<JsonValue> {
  const conversation = dispatcherOwnedConversations.get(conversationId);
  const turns = Array.isArray(conversation?.turns) ? conversation.turns : [];
  const lastTurn = asJsonObject(turns.at(-1));
  if (!lastTurn || lastTurn.id !== turnId) {
    throw new Error("Only the most recent message can be edited.");
  }
  if (lastTurn.status === "inProgress") {
    throw new Error("Cannot edit a message while a turn is in progress.");
  }

  const input = editedUserMessageInput(lastTurn, message);
  const rollback = await appServer.request("thread/rollback", { threadId: conversationId, numTurns: 1 });
  const cwd = asJsonObject(asJsonObject(rollback)?.thread)?.cwd ?? conversation?.cwd;
  const result = await appServer.request(
    "turn/start",
    buildDispatcherTurnStartRequest(conversationId, conversation, { input, cwd: cwd ?? null }),
  );
  scheduleDispatcherOwnedRefresh(conversationId, 0);
  return result ?? { ok: true };
}

// thread/read gives us the turn as items, not as the start params the extension
// keeps in memory, so the edited turn is rebuilt from the user message itself.
function editedUserMessageInput(turn: JsonObject, message: string): JsonValue[] {
  const items = Array.isArray(turn.items) ? turn.items : [];
  const userMessage = items.map((item) => asJsonObject(item)).find((item) => item?.type === "userMessage");
  const parts = (Array.isArray(userMessage?.content) ? userMessage.content : []).map((part) => asJsonObject(part));
  const textIndex = parts.findIndex((part) => part?.type === "text");
  if (textIndex === -1) {
    throw new Error("The last user message has no text to edit.");
  }
  if (parts.some((part) => part?.type !== "text")) {
    throw new Error("Editing a message with attachments is not supported on a dispatcher-owned thread.");
  }

  return parts.map((part, index) =>
    index === textIndex ? { ...part, text: message, text_elements: [] } : (part as JsonValue),
  );
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

// The app server refuses to read a thread's turns before its first user
// message, and a thread with no turns has nothing to refresh anyway. The turn
// the webview submits refreshes unconditionally, which is what ends this state.
function dispatcherOwnedThreadHasTurns(threadId: string): boolean {
  const turns = dispatcherOwnedConversations.get(threadId)?.turns;
  return Array.isArray(turns) && turns.length > 0;
}

// A snapshot from another client means that window is now driving the thread.
// Two owners would race turns on the same rollout and flip followers between
// two states, so ownership has exactly one holder and we hand it over.
function releaseDispatcherOwnership(threadId: string): void {
  if (!dispatcherOwnedConversations.delete(threadId)) {
    return;
  }
  streamFollowersByConversation.delete(threadId);
  const pending = dispatcherOwnedRefreshTimers.get(threadId);
  if (pending) {
    clearTimeout(pending);
    dispatcherOwnedRefreshTimers.delete(threadId);
  }
}

function adoptDispatcherOwnedThread(threadId: string, thread: JsonObject): void {
  dispatcherOwnedConversations.set(
    threadId,
    conversationFromThread(threadId, thread, dispatcherOwnedConversations.get(threadId)),
  );
  broadcastDispatcherOwnedSnapshot(threadId);
}

// Every VS Code window runs its own app server, so a turn streaming on ours is
// a turn this dispatcher drives — that is what makes the phone the owner and
// lets VS Code attach to it as a follower. A thread a VS Code window already
// announced ownership of stays theirs.
function claimDispatcherOwnership(threadId: string): boolean {
  if (dispatcherOwnedConversations.has(threadId)) {
    return true;
  }
  if (streamOwners.has(threadId)) {
    return false;
  }

  dispatcherOwnedConversations.set(threadId, minimalDispatcherConversation(threadId));
  // Windows that already had this thread open were following whoever drove it
  // before us and have no reason to announce themselves again, so ask.
  ipcBridge.broadcast("thread-stream-following-status-requested", buildFollowingStatusRequestParams(threadId));
  return true;
}

// Trailing throttle, not debounce: a thread streaming faster than the interval
// would otherwise never refresh until the model paused, and every follower
// would sit on a frozen snapshot until the turn ended.
function scheduleDispatcherOwnedRefresh(threadId: string, delayMs = 120): void {
  const pending = dispatcherOwnedRefreshTimers.get(threadId);
  if (pending) {
    if (delayMs === 0) {
      clearTimeout(pending);
      dispatcherOwnedRefreshTimers.delete(threadId);
    } else {
      return;
    }
  }

  const timer = setTimeout(() => {
    dispatcherOwnedRefreshTimers.delete(threadId);
    // Timer callback: this is the boundary that owns the failure, and losing a
    // snapshot refresh must not take the whole dispatcher down with it.
    refreshDispatcherOwnedConversation(threadId).catch((error: unknown) => {
      console.error(`dispatcher-owned refresh failed for ${threadId}:`, error);
    });
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

function broadcastDispatcherOwnedSnapshot(threadId: string): void {
  const followers = streamFollowersByConversation.get(threadId);
  if (!followers || followers.size === 0) {
    return;
  }

  sendDispatcherOwnedSnapshot(threadId, [...followers]);
}

function sendDispatcherOwnedSnapshot(threadId: string, targetClientIds: string[]): void {
  const conversation = dispatcherOwnedConversations.get(threadId);
  if (!conversation) {
    return;
  }

  ipcBridge.broadcast("thread-stream-state-changed", buildDispatcherSnapshotParams(threadId, conversation), {
    targetClientIds,
  });
}

function buildExtensionEventReplayMessages(): JsonObject[] {
  const messages: JsonObject[] = [];

  // Approvals and elicitations are requests the app server is still blocked on, so
  // a reconnecting webview has to see them again or the turn stalls with no prompt.
  for (const request of appServer.getPendingServerRequests()) {
    messages.push({
      type: "mcp-request",
      hostId: "local",
      request: { id: request.id, method: request.method, params: request.params },
    });
  }

  for (const [threadId, conversation] of mirroredConversations.entries()) {
    const ownerClientId = streamOwners.get(threadId);
    if (!ownerClientId) {
      continue;
    }
    messages.push(buildThreadStreamSnapshotMessage(threadId, ownerClientId, conversation));
  }

  // Threads this dispatcher owns are deliberately absent: the webview drives
  // them through our app server and already has their state, and a replay per
  // owned thread grows with every thread the phone has ever run.
  return messages;
}

function buildThreadStreamSnapshotMessage(
  threadId: string,
  sourceClientId: string,
  conversation: JsonObject,
): JsonObject {
  const hostId = typeof conversation.hostId === "string" ? conversation.hostId : dispatcherIpcHostId;
  const conversationState = {
    ...cloneJsonObject(conversation),
    id: threadId,
    hostId,
  };

  return {
    type: "ipc-broadcast",
    method: "thread-stream-state-changed",
    sourceClientId,
    version: 6,
    params: {
      conversationId: threadId,
      hostId,
      change: {
        type: "snapshot",
        conversationState,
      },
    },
  };
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

function clearIpcMirrorsIfDisconnected(status: string): void {
  if (status !== "disconnected" && status !== "error" && status !== "closed") {
    return;
  }

  streamOwners.clear();
  mirroredConversations.clear();
  // Client ids are handed out per connection, so nothing that followed us over
  // the old socket exists any more; they announce again after reconnecting.
  streamFollowersByConversation.clear();
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

function cloneJsonObject(value: JsonObject): JsonObject {
  const cloned = cloneJson(value);
  if (!isJsonObject(cloned)) {
    throw new Error("Cloned JSON object changed shape");
  }
  return cloned;
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

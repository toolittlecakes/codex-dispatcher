import { randomBytes } from "node:crypto";
import { networkInterfaces } from "node:os";
import { AppServerError, CodexAppServer, type JsonObject, type JsonValue } from "./codex-app-server";
import { CodexIpcBridge, type IpcBroadcastMessage } from "./codex-ipc";
import { defaultCertificateDirectory, ensureDispatcherCertificate } from "./dispatcher-tls";
import {
  applyThreadSettingsNotification,
  applyThreadSettingsUpdate,
  buildDispatcherSnapshotParams,
  buildDispatcherTurnStartRequest,
  buildFollowingChangeParams,
  buildFollowingStatusRequestParams,
  buildOwnerConversationState,
  buildQueuedFollowUpsBroadcastParams,
  dispatcherIpcHostId,
  isNoActiveTurnError,
  minimalOwnerConversationState,
  mismatchedTurnId,
  parseStreamFollowingChange,
} from "./dispatcher-owner";
import { ExtensionWebview } from "./extension-webview";
import { ThreadMirrors } from "./thread-mirrors";
import { applyJsonPatches, cloneJson } from "./json-patch";
import { asJsonObject, isJsonObject, toError } from "./shared";
import type { IpcRequestOutcome } from "./webview-rpc";

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
  getThreadRole: (conversationId) => extensionThreadRole(conversationId),
  handleFollowerRequest: (method, params, signal) => handleExtensionFollowerRequest(method, params, signal),
  getBridgeState: () => buildBridgeDebugState(),
  ipcCoordination: {
    broadcast: (method, params, targetClientIds) => broadcastForWebview(method, params, targetClientIds),
    request: (method, params, options) => requestForWebview(method, params, options),
    // No editor behind this host, so there is no IDE context to report.
    ideContext: () => null,
  },
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
const threadMirrors = new ThreadMirrors();
const dispatcherOwnedConversations = new Map<string, JsonObject>();
const dispatcherOwnedRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
const dispatcherOwnedRevisions = new Map<string, number>();
const dispatcherOwnedRefreshesInFlight = new Set<string>();
const dispatcherOwnedRefreshRequested = new Set<string>();
// The app server refuses to read a thread's turns before its first user
// message, so the read waits for the notification that says one exists. Our own
// conversation cannot answer this question: the only thing that ever puts turns
// in it is the read this gate stands in front of.
const dispatcherOwnedThreadsWithTurns = new Set<string>();
// A settings change we made, and how many the app server has announced since:
// together they say whether our own write is still the newest thing we know.
const pendingThreadSettingsUpdates = new Map<string, Promise<void>>();
const dispatcherOwnedSettingsAnnouncements = new Map<string, number>();
// Who asked to be kept up to date on which thread. A thread nobody follows is
// still ours to drive, it just costs no traffic.
const streamFollowersByConversation = new Map<string, Set<string>>();
let announcedIpcClientId: string | null = null;

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


// The follower calls a thread owner has to answer, straight from the
// extension's own registration list (`wq` in out/extension.js).
const dispatcherOwnerRequestMethods = new Set([
  "thread-follower-start-turn",
  "thread-follower-load-complete-history",
  "thread-follower-edit-last-user-turn",
  "thread-follower-steer-turn",
  "thread-follower-interrupt-turn",
  "thread-follower-compact-thread",
  "thread-follower-update-thread-settings",
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
    if (!threadId || !claimDispatcherOwnership(threadId)) {
      return;
    }

    if (event.notification.method === "turn/started") {
      dispatcherOwnedThreadsWithTurns.add(threadId);
    }
    // Thread settings belong to the app server — they are what its next turn
    // runs with — so our conversation follows this notification. It is also the
    // only way a change made in the webview attached to us reaches followers,
    // and the only way a follower's change reaches that webview.
    if (event.notification.method === "thread/settings/updated") {
      const settings = asJsonObject(event.notification.params)?.threadSettings ?? null;
      dispatcherOwnedSettingsAnnouncements.set(threadId, (dispatcherOwnedSettingsAnnouncements.get(threadId) ?? 0) + 1);
      updateDispatcherOwnedConversation(threadId, (conversation) => {
        applyThreadSettingsNotification(conversation, settings);
      });
      broadcastDispatcherOwnedSnapshot(threadId);
    }
    if (dispatcherOwnedThreadsWithTurns.has(threadId)) {
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
  announceStreamInterestOnRegistration(event.snapshot.clientId);
});

for (const method of dispatcherOwnerRequestMethods) {
  ipcBridge.addRequestHandler(
    method,
    (requestMessage) => canHandleDispatcherOwnerRequest(requestMessage.method, requestMessage.params),
    (requestMessage) => answerAsThreadOwner(requestMessage.method, requestMessage.params),
  );
}

// A follower reads its owner's failures literally — «no active turn to steer»
// is how it recognises a turn that ended and turns the steer into an ordinary
// message. The real owner puts the app server's own words on the wire, so our
// method prefix comes off before the answer leaves this process.
async function answerAsThreadOwner(method: string, params: JsonValue | undefined): Promise<JsonValue> {
  try {
    return await handleDispatcherOwnerRequest(method, params);
  } catch (error) {
    throw error instanceof AppServerError ? new Error(error.reason) : error;
  }
}

// The one owner call that is not a follower request: before resuming a thread a
// client asks who is already driving it, and only its owner answers (the
// registration next to `wq`). Left unanswered, the asker concludes the thread is
// free and resumes it itself — taking the rollout out from under a turn the
// phone is running.
ipcBridge.addRequestHandler(
  "thread-owner-discovery",
  (requestMessage) => canAnswerThreadOwnerDiscovery(requestMessage.params),
  async () => ({}),
);

await appServer.start();
await ipcBridge.start();

// Off only where something in front of us terminates TLS — the relay and the
// tunnel both do, and both reach us over loopback.
const addresses = lanAddresses();
const certificate = process.env.DISPATCHER_TLS === "off" ? null : ensureDispatcherCertificate(
  defaultCertificateDirectory(),
  addresses,
);

let server: Bun.Server<undefined>;
try {
  server = Bun.serve({
    port,
    hostname: host,
    ...(certificate ? { tls: { cert: certificate.cert, key: certificate.key } } : {}),
    fetch(request) {
      return extensionWebview.fetch(request, new URL(request.url));
    },
  });
} catch (error) {
  ipcBridge.stop();
  appServer.stop();
  throw error;
}

const scheme = certificate ? "https" : "http";
console.log(`Codex dispatcher listening on ${server.url.toString()}`);
console.log(`Open locally: ${clientUrl(`${scheme}://localhost:${port}`)}`);
if (certificate) {
  for (const address of addresses) {
    console.log(`Open from phone: ${clientUrl(`https://${address}:${port}`)}`);
  }
  console.log(`Certificate: ${certificate.path}`);
  // The phone has to accept this certificate by hand, and the fingerprint is
  // the only thing it can be checked against.
  console.log(`Fingerprint: ${certificate.fingerprint}`);
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

    applyConversationMirror(threadId, params, broadcastMessage.sourceClientId);
    return;
  }

  if (broadcastMessage.method === "thread-stream-following-changed") {
    const change = parseStreamFollowingChange(broadcastMessage.params, broadcastMessage.sourceClientId);
    if (change) {
      applyStreamFollowingChange(change.conversationId, change.clientId, change.following);
    }
    return;
  }

  if (broadcastMessage.method === "thread-stream-following-status-requested") {
    // Another client just took a thread over and is looking for followers. We
    // keep every thread we have open, so answer for the ones we hold: their
    // snapshot is how we learn we are no longer the one driving it.
    const params = asJsonObject(broadcastMessage.params);
    const conversationId = typeof params?.conversationId === "string" ? params.conversationId : null;
    if (params?.hostId === dispatcherIpcHostId && conversationId && hasConversationOpen(conversationId)) {
      announceFollowing(conversationId, [broadcastMessage.sourceClientId]);
    }
    return;
  }

  if (broadcastMessage.method !== "client-status-changed") {
    return;
  }

  const params = asJsonObject(broadcastMessage.params);
  if (typeof params?.clientId !== "string") {
    return;
  }

  if (params.status === "connected") {
    // A client that just arrived does not know our id yet, so it cannot address
    // us. Tell it what we watch, the way every other window does.
    for (const conversationId of openConversationIds()) {
      announceFollowing(conversationId, [params.clientId]);
    }
    return;
  }

  if (params.status !== "disconnected") {
    return;
  }

  for (const [threadId, followers] of streamFollowersByConversation.entries()) {
    if (followers.delete(params.clientId) && followers.size === 0) {
      streamFollowersByConversation.delete(threadId);
    }
  }

  threadMirrors.forgetClient(params.clientId);
}

// Everything this dispatcher has state for: the threads it drives and the ones
// it mirrors from another window. This is its equivalent of the threads a VS
// Code window has open, and it follows all of them.
function openConversationIds(): string[] {
  return [...new Set([...dispatcherOwnedConversations.keys(), ...threadMirrors.threadIds()])];
}

function hasConversationOpen(conversationId: string): boolean {
  return dispatcherOwnedConversations.has(conversationId) || threadMirrors.has(conversationId);
}

function announceFollowing(conversationId: string, targetClientIds?: string[]): void {
  ipcBridge.broadcast(
    "thread-stream-following-changed",
    buildFollowingChangeParams(conversationId, true),
    targetClientIds ? { targetClientIds } : {},
  );
}

// Our client id is new after every reconnect, so nobody can address us until we
// speak first: say what we follow, and ask who follows the threads we drive.
function announceStreamInterestOnRegistration(clientId: string | null): void {
  if (clientId === null || clientId === announcedIpcClientId) {
    return;
  }

  announcedIpcClientId = clientId;
  for (const conversationId of openConversationIds()) {
    announceFollowing(conversationId);
  }
  for (const conversationId of dispatcherOwnedConversations.keys()) {
    ipcBridge.broadcast("thread-stream-following-status-requested", buildFollowingStatusRequestParams(conversationId));
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
      return handleDispatcherOwnerInterruptTurn(
        conversationId,
        typeof params.expectedTurnId === "string" ? params.expectedTurnId : null,
      );

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

    // The extension's owner answers this with the same call it makes for its own
    // settings changes, so the app server is the one place they live. Our
    // conversation and the webview attached to us both learn about it from the
    // notification that call raises.
    case "thread-follower-update-thread-settings":
      await updateDispatcherOwnedThreadSettings(conversationId, asJsonObject(params.threadSettings) ?? {});
      return { ok: true };

    // We keep the whole conversation as the app server hands it to us, so there
    // is no older history to fetch: re-read it, publish it, and answer with the
    // revision the follower has to wait for.
    case "thread-follower-load-complete-history": {
      await refreshDispatcherOwnedConversation(conversationId);
      // Ownership can move while we read: another window's snapshot hands the
      // thread over, and then we have no revision to promise — the follower
      // would sit out its five minutes waiting for one. This is the error the
      // real owner raises in the same spot.
      if (!dispatcherOwnedConversations.has(conversationId)) {
        throw new Error("no-client-found: thread stream owner became unavailable");
      }

      broadcastDispatcherOwnedSnapshot(conversationId);
      return { revision: dispatcherOwnedRevision(conversationId) };
    }

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
  if (!lastTurn || lastTurn.turnId !== turnId) {
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
  // The follower sends the turn the moment we answer its settings change, and
  // the app server answers that change before it announces it. Starting the
  // turn from our copy in between would name the model the user just replaced.
  await pendingThreadSettingsUpdates.get(conversationId);
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

// The app server answers a settings change before it announces it, so between
// those two moments our copy of the thread still names the old model. The
// webview closes the same window the same way (`pendingThreadSettingsUpdates`):
// apply what we just wrote, unless the announcement got there first.
async function updateDispatcherOwnedThreadSettings(threadId: string, threadSettings: JsonObject): Promise<void> {
  const announced = dispatcherOwnedSettingsAnnouncements.get(threadId) ?? 0;
  const update = (async () => {
    await appServer.request("thread/settings/update", { threadId, ...threadSettings });
    if ((dispatcherOwnedSettingsAnnouncements.get(threadId) ?? 0) !== announced) {
      return;
    }
    updateDispatcherOwnedConversation(threadId, (conversation) => {
      applyThreadSettingsUpdate(conversation, threadSettings);
    });
    broadcastDispatcherOwnedSnapshot(threadId);
  })();

  pendingThreadSettingsUpdates.set(threadId, update);
  try {
    await update;
  } finally {
    if (pendingThreadSettingsUpdates.get(threadId) === update) {
      pendingThreadSettingsUpdates.delete(threadId);
    }
  }
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

// The follower asks for the turn it can see, and reads back which turn actually
// stopped: the buffered-turn flow compares `interruptedTurnId` with its own and
// aborts the whole flow when they differ, so answering without it broke every
// interrupt that goes through it. `null` means «nothing was running» — either no
// turn at all, or a newer one than the follower knew about, which the extension
// deliberately leaves alone.
async function handleDispatcherOwnerInterruptTurn(
  conversationId: string,
  expectedTurnId: string | null,
): Promise<JsonValue> {
  const turnId = findInProgressTurnId(dispatcherOwnedConversations.get(conversationId));
  if (!turnId || (expectedTurnId !== null && expectedTurnId !== turnId)) {
    return { interruptedTurnId: null, ok: true };
  }

  const interruptedTurnId = await interruptDispatcherOwnedTurn(conversationId, turnId, expectedTurnId);
  scheduleDispatcherOwnedRefresh(conversationId, 0);
  return { interruptedTurnId, ok: true };
}

// Our copy of the thread is a throttled read, so a stop pressed at the wrong
// millisecond aims at a turn the app server has already moved past: it answers
// with the turn that is really running, or with «no active turn» when the last
// one just finished. The extension resolves both without an error (`Lze`), and
// a stop that throws in the follower's UI for winning a race is worse than a
// stop that quietly did nothing.
async function interruptDispatcherOwnedTurn(
  conversationId: string,
  turnId: string,
  expectedTurnId: string | null,
): Promise<string | null> {
  try {
    await appServer.request("turn/interrupt", { threadId: conversationId, turnId });
    return turnId;
  } catch (error) {
    // The app server's own message, not ours: our wrapper prefixes it with the
    // method, and these are matched against what the app server said.
    const message = error instanceof AppServerError ? error.reason : toError(error).message;
    const actualTurnId = mismatchedTurnId(message);
    if (actualTurnId) {
      if (expectedTurnId !== null && actualTurnId !== expectedTurnId) {
        return null;
      }

      try {
        await appServer.request("turn/interrupt", { threadId: conversationId, turnId: actualTurnId });
      } catch (retryError) {
        if (!(retryError instanceof AppServerError) || !isNoActiveTurnError(retryError.reason)) {
          throw retryError;
        }
      }
      return actualTurnId;
    }

    if (isNoActiveTurnError(message)) {
      return expectedTurnId === null ? turnId : null;
    }

    throw error;
  }
}

function canHandleDispatcherOwnerRequest(method: string, paramsValue: JsonValue | undefined): boolean {
  if (!dispatcherOwnerRequestMethods.has(method)) {
    return false;
  }

  const params = asJsonObject(paramsValue);
  const conversationId = typeof params?.conversationId === "string" ? params.conversationId : null;
  return Boolean(conversationId && dispatcherOwnedConversations.has(conversationId));
}

// Discovery is asked of every client at once, so the answer has to be narrow:
// only the host the thread belongs to, and only while we still own it.
function canAnswerThreadOwnerDiscovery(paramsValue: JsonValue | undefined): boolean {
  const params = asJsonObject(paramsValue);
  if (params?.hostId !== dispatcherIpcHostId) {
    return false;
  }

  const conversationId = typeof params.conversationId === "string" ? params.conversationId : null;
  return Boolean(conversationId && dispatcherOwnedConversations.has(conversationId));
}


// A snapshot from another client means that window is now driving the thread.
// Two owners would race turns on the same rollout and flip followers between
// two states, so ownership has exactly one holder and we hand it over.
function releaseDispatcherOwnership(threadId: string): void {
  if (!dispatcherOwnedConversations.delete(threadId)) {
    return;
  }
  streamFollowersByConversation.delete(threadId);
  dispatcherOwnedRevisions.delete(threadId);
  dispatcherOwnedRefreshRequested.delete(threadId);
  dispatcherOwnedThreadsWithTurns.delete(threadId);
  dispatcherOwnedSettingsAnnouncements.delete(threadId);
  const pending = dispatcherOwnedRefreshTimers.get(threadId);
  if (pending) {
    clearTimeout(pending);
    dispatcherOwnedRefreshTimers.delete(threadId);
  }
}

// The gate stands for "the app server will answer thread/read for this thread",
// and a thread carrying turns has passed the first user message that makes it
// readable. A resumed or forked thread arrives that way, long before any
// `turn/started` of ours.
function noteDispatcherOwnedThreadIsReadable(threadId: string, thread: JsonObject): void {
  const turns = thread.turns;
  if (Array.isArray(turns) && turns.length > 0) {
    dispatcherOwnedThreadsWithTurns.add(threadId);
  }
}

function adoptDispatcherOwnedThread(threadId: string, thread: JsonObject): void {
  noteDispatcherOwnedThreadIsReadable(threadId, thread);
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
  if (threadMirrors.ownerOf(threadId)) {
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

// One read per thread at a time. Two thread/read calls can finish in either
// order, and the older answer landing last would publish a snapshot the
// followers already moved past.
async function refreshDispatcherOwnedConversation(threadId: string): Promise<void> {
  if (dispatcherOwnedRefreshesInFlight.has(threadId)) {
    dispatcherOwnedRefreshRequested.add(threadId);
    return;
  }

  dispatcherOwnedRefreshesInFlight.add(threadId);
  try {
    await readDispatcherOwnedConversation(threadId);
  } finally {
    dispatcherOwnedRefreshesInFlight.delete(threadId);
    if (dispatcherOwnedRefreshRequested.delete(threadId)) {
      // Back through the timer so a failed read is still reported at the one
      // boundary that handles it instead of chaining onto this call.
      scheduleDispatcherOwnedRefresh(threadId, 0);
    }
  }
}

async function readDispatcherOwnedConversation(threadId: string): Promise<void> {
  if (!dispatcherOwnedConversations.has(threadId)) {
    return;
  }

  const result = await appServer.request("thread/read", {
    threadId,
    includeTurns: true,
  });
  const resultObject = asJsonObject(result);
  const thread = asJsonObject(resultObject?.thread);
  // Checked again after the read: a VS Code window can take the thread over
  // while it is in flight, and writing the answer back would make us its owner
  // again behind the handover.
  if (!thread || !dispatcherOwnedConversations.has(threadId)) {
    return;
  }

  noteDispatcherOwnedThreadIsReadable(threadId, thread);
  dispatcherOwnedConversations.set(
    threadId,
    conversationFromThread(threadId, thread, dispatcherOwnedConversations.get(threadId)),
  );
  broadcastDispatcherOwnedSnapshot(threadId);
}

function broadcastDispatcherOwnedSnapshot(threadId: string): void {
  // Revisions belong to the owner. Numbering a thread we have handed over would
  // leave an entry nothing ever deletes, and hand the new owner's followers a
  // revision that means nothing to them.
  if (!dispatcherOwnedConversations.has(threadId)) {
    return;
  }

  // The thread moved, so the revision moves with it even when nobody is
  // listening: a follower arriving later must not be handed a revision that
  // stands for older state than it names.
  dispatcherOwnedRevisions.set(threadId, dispatcherOwnedRevision(threadId) + 1);

  const followers = streamFollowersByConversation.get(threadId);
  if (!followers || followers.size === 0) {
    return;
  }

  sendDispatcherOwnedSnapshot(threadId, [...followers]);
}

function dispatcherOwnedRevision(threadId: string): number {
  return dispatcherOwnedRevisions.get(threadId) ?? 0;
}

function sendDispatcherOwnedSnapshot(threadId: string, targetClientIds: string[]): void {
  const conversation = dispatcherOwnedConversations.get(threadId);
  if (!conversation) {
    return;
  }

  ipcBridge.broadcast(
    "thread-stream-state-changed",
    buildDispatcherSnapshotParams(threadId, conversation, dispatcherOwnedRevision(threadId)),
    { targetClientIds },
  );
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

  // Mirrored threads are deliberately absent too: IPC state reaches the webview
  // over its RPC session, which a reload rebuilds from scratch — the webview
  // re-announces what it follows and the owners answer with fresh snapshots.
  // Threads this dispatcher owns are deliberately absent: the webview drives
  // them through our app server and already has their state, and a replay per
  // owned thread grows with every thread the phone has ever run.
  return messages;
}

// What the follower path actually depends on, none of which the webview's own
// traffic reveals: who else is on the bus, which threads we drive, who is
// listening to them, and whose snapshots we are mirroring.
function buildBridgeDebugState(): JsonObject {
  const snapshot = ipcBridge.getSnapshot();
  return {
    ipc: {
      status: snapshot.status,
      socketPath: snapshot.socketPath,
      clientId: snapshot.clientId,
      peers: snapshot.peers.map((peer) => ({ clientId: peer.clientId, clientType: peer.clientType })),
      detail: snapshot.detail ?? null,
    },
    ownedThreads: [...dispatcherOwnedConversations.keys()].map((threadId) => ({
      threadId,
      revision: dispatcherOwnedRevision(threadId),
      followers: [...(streamFollowersByConversation.get(threadId) ?? [])],
    })),
    mirroredThreads: threadMirrors.threadIds(),
    threadOwners: threadMirrors.ownersByThread(),
  };
}

function extensionThreadRole(threadId: string): string {
  return dispatcherOwnedConversations.has(threadId) ? "owner" : "follower";
}

function assertExtensionFollowerOwner(threadId: string): void {
  if (!threadMirrors.ownerOf(threadId)) {
    throw new Error(`No IPC owner for thread ${threadId}`);
  }
}

// The webview's own IPC calls, arriving over its RPC session. Unlike the
// `-for-host` endpoints these are not scoped to a thread we own: the webview is
// speaking as a client of the bus, so its traffic goes straight onto the bus.
function broadcastForWebview(method: string, params: JsonValue, targetClientIds: string[] | undefined): void {
  if (targetClientIds?.length === 0) {
    return;
  }
  if (!ipcBridge.broadcast(method, params, targetClientIds ? { targetClientIds } : {})) {
    throw new Error(`codex-ipc is not connected; ${method} was not broadcast`);
  }
}

async function requestForWebview(
  method: string,
  params: JsonValue,
  options: { targetClientId?: string | undefined; timeoutMs?: number | undefined },
): Promise<IpcRequestOutcome> {
  const response = await ipcBridge.request(method, params, options);
  if (response.resultType === "error") {
    return { resultType: "error", method, error: response.error ?? `${method} failed` };
  }

  const outcome: IpcRequestOutcome = { resultType: "success", method, result: response.result ?? null };
  if (response.handledByClientId) {
    outcome.handledByClientId = response.handledByClientId;
  }
  return outcome;
}

async function handleExtensionFollowerRequest(method: string, params: JsonValue, signal: AbortSignal): Promise<JsonValue> {
  const threadId = requestThreadId({ params });
  const ownerClientId = threadId ? threadMirrors.ownerOf(threadId) : null;
  if (!ownerClientId) {
    throw new Error(`No IPC owner for thread ${threadId ?? "unknown"}`);
  }

  const response = await ipcBridge.request(method, params, { targetClientId: ownerClientId, signal });
  if (response.resultType === "error") {
    throw new Error(response.error ?? `${method} failed`);
  }

  return response.result ?? { ok: true };
}

function updateDispatcherOwnedConversation(threadId: string, update: (conversation: JsonObject) => void): void {
  const current = dispatcherOwnedConversations.get(threadId) ?? minimalDispatcherConversation(threadId);
  const next = cloneJsonObject(current);
  update(next);
  dispatcherOwnedConversations.set(threadId, next);
}

function conversationFromThread(threadId: string, thread: JsonObject, previous?: JsonObject): JsonObject {
  return buildOwnerConversationState(
    threadId,
    cloneJsonObject(thread),
    previous ? cloneJsonObject(previous) : undefined,
    pendingRequestsForThread(threadId),
  );
}

function minimalDispatcherConversation(threadId: string): JsonObject {
  return minimalOwnerConversationState(threadId, defaultCwd, pendingRequestsForThread(threadId));
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
  }
  return null;
}

function clearIpcMirrorsIfDisconnected(status: string): void {
  if (status !== "disconnected" && status !== "error" && status !== "closed") {
    return;
  }

  threadMirrors.clear();
  // Client ids are handed out per connection, so nothing that followed us over
  // the old socket exists any more; they announce again after reconnecting.
  streamFollowersByConversation.clear();
}

function applyConversationMirror(threadId: string, params: JsonObject, sourceClientId: string): void {
  const outcome = threadMirrors.apply(threadId, params, sourceClientId);
  if (outcome === "adopted") {
    releaseDispatcherOwnership(threadId);
    return;
  }

  if (outcome === "patch-failed") {
    // The extension warns and keeps the thread it has: the next snapshot is
    // what repairs a mirror, and until then a stale copy still answers.
    console.warn(`Failed to apply IPC patches for ${threadId}`);
  }
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

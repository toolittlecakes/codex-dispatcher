import type { JsonObject, JsonValue } from "./codex-app-server";
import { applyJsonPatches } from "./json-patch";
import { asJsonObject, isJsonObject } from "./shared";

export const dispatcherIpcHostId = "local";

export type MirroredThread = { conversation: JsonObject; revision: number | null; ownerClientId: string };

export type StreamStateOutcome =
  | { kind: "ignored" }
  | { kind: "adopted"; conversation: JsonObject; revision: number | null }
  | { kind: "patched"; conversation: JsonObject; revision: number | null }
  | { kind: "patch-failed"; message: string };

// The follower half of the snapshot protocol above. Every client on the bus
// broadcasts patches for the threads it owns, so a follower constantly sees
// changes built on state it does not have; the extension answers those by
// checking the sender against the owner its last snapshot named and the
// patch's `baseRevision` against the revision it holds, and ignoring whatever
// fails either test. Only a snapshot names an owner, and nothing here ever
// unnames one — a mirror that cannot follow along waits for the next snapshot
// rather than forgetting who to ask.
export function applyStreamStateChange(
  threadId: string,
  params: JsonObject,
  sourceClientId: string,
  current: MirroredThread | null,
): StreamStateOutcome {
  const change = asJsonObject(params.change);
  if (!change) {
    return { kind: "ignored" };
  }

  if (change.type === "snapshot") {
    const conversationState = asJsonObject(change.conversationState);
    if (!conversationState) {
      return { kind: "ignored" };
    }

    return {
      kind: "adopted",
      conversation: {
        ...conversationState,
        id: typeof conversationState.id === "string" ? conversationState.id : threadId,
      },
      revision: typeof change.revision === "number" ? change.revision : null,
    };
  }

  if (
    change.type !== "patches" ||
    !Array.isArray(change.patches) ||
    !current ||
    current.ownerClientId !== sourceClientId ||
    current.revision !== (typeof change.baseRevision === "number" ? change.baseRevision : null)
  ) {
    return { kind: "ignored" };
  }

  try {
    const next = applyJsonPatches(current.conversation, change.patches);
    if (!isJsonObject(next)) {
      return { kind: "patch-failed", message: "patched conversation is not an object" };
    }

    return { kind: "patched", conversation: next, revision: typeof change.revision === "number" ? change.revision : null };
  } catch (error) {
    return { kind: "patch-failed", message: error instanceof Error ? error.message : String(error) };
  }
}

// Followers key their state off the revision: they store the one that came with
// the snapshot, refuse patches that do not build on it, and wait for a revision
// to pass before treating a request as applied. A snapshot without one leaves
// every follower stuck at `undefined`.
export function buildDispatcherSnapshotParams(
  conversationId: string,
  conversation: JsonObject,
  revision: number,
): JsonObject {
  return {
    conversationId,
    hostId: dispatcherIpcHostId,
    change: {
      type: "snapshot",
      revision,
      conversationState: {
        ...conversation,
        hostId: dispatcherIpcHostId,
      },
    },
  };
}

// What a snapshot actually carries is the webview's own conversation object
// (`VIe`), not the app-server thread: the follower puts `conversationState`
// into its store as it stands — normalising nothing but dates and the title —
// and then reads `turn.params.input` off it. Handing it a thread crashes the
// page it lands on, which is what E21 was.
export function buildOwnerConversationState(
  conversationId: string,
  thread: JsonObject,
  previous: JsonObject | undefined,
  requests: JsonValue[],
): JsonObject {
  const timestamps = conversationTimestamps(thread);
  const conversation: JsonObject = {
    id: conversationId,
    sessionId: thread.sessionId ?? null,
    forkedFromId: thread.forkedFromId ?? null,
    hostId: dispatcherIpcHostId,
    turns: ownerTurnsFromThread(conversationId, thread, previous),
    requests,
    createdAt: timestamps.createdAt,
    updatedAt: timestamps.updatedAt,
    recencyAt: timestamps.recencyAt ?? timestamps.updatedAt,
    // `Fb(thread.name)`: the app-server thread has no `title` at all, and the
    // name is what every conversation the webview builds takes its title from.
    title: threadTitle(thread.name),
    source: thread.source ?? null,
    threadSource: thread.threadSource ?? "user",
    historyMode: thread.historyMode ?? null,
    parentThreadId: thread.parentThreadId ?? null,
    mode: thread.mode ?? null,
    threadStartKind: thread.threadStartKind ?? null,
    modelProvider: thread.modelProvider ?? null,
    latestModel: previous?.latestModel ?? "",
    latestReasoningEffort: previous?.latestReasoningEffort ?? null,
    previousTurnModel: previous?.previousTurnModel ?? null,
    latestCollaborationMode: previous?.latestCollaborationMode ?? defaultCollaborationMode(),
    hasUnreadTurn: false,
    threadRuntimeStatus: thread.status ?? null,
    rolloutPath: thread.path ?? "",
    gitInfo: thread.gitInfo ?? null,
    // The thread runs on our app server and is loaded there, which is exactly
    // what this field says. A follower that reads `needs_resume` offers to
    // resume a thread it does not drive.
    resumeState: "resumed",
    latestTokenUsageInfo: previous?.latestTokenUsageInfo ?? null,
    workspaceKind: "project",
    workspaceBrowserRoot: null,
    projectlessOutputDirectory: null,
    cwd: thread.cwd ?? previous?.cwd ?? null,
  };

  // Ours to keep, not the thread's: the follower changed them through us and
  // our next snapshot is what it reads them back from.
  for (const key of ["latestThreadSettings", "queuedFollowUpsState"]) {
    if (previous?.[key] !== undefined) {
      conversation[key] = previous[key];
    }
  }
  return conversation;
}

export function minimalOwnerConversationState(
  conversationId: string,
  cwd: string,
  requests: JsonValue[],
): JsonObject {
  const now = Date.now();
  return buildOwnerConversationState(
    conversationId,
    { createdAt: now / 1000, updatedAt: now / 1000, cwd, turns: [] },
    undefined,
    requests,
  );
}

// Every conversation the webview builds carries a mode, and the code that reads
// it — settings merges, turn starts, the model label — reaches straight through
// to `.settings.model`. A null here is the same crash E21 was, one field over.
function defaultCollaborationMode(): JsonObject {
  return { mode: "default", settings: { model: "", reasoning_effort: null, developer_instructions: null } };
}

function threadTitle(name: JsonValue | undefined): string | null {
  if (typeof name !== "string") {
    return null;
  }

  const trimmed = name.trim();
  return trimmed.length > 0 ? trimmed : null;
}

// `Ob`: seconds on the wire, milliseconds in the store.
function conversationTimestamps(thread: JsonObject): {
  createdAt: number;
  updatedAt: number;
  recencyAt: number | null;
} {
  const createdAt = millisecondsFromSeconds(thread.createdAt) ?? Date.now();
  return {
    createdAt,
    updatedAt: millisecondsFromSeconds(thread.updatedAt) ?? createdAt,
    recencyAt: millisecondsFromSeconds(thread.recencyAt),
  };
}

// `tPe`
function millisecondsFromSeconds(value: JsonValue | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value * 1000)) {
    return null;
  }
  return value * 1000;
}

// `jy`: an app-server turn is items and timings, a stored turn is the start
// params plus the stream state around them. `permissionParamsSource: "inferred"`
// is the extension's own word for what this is — params rebuilt from history
// rather than the ones the turn actually ran with.
function ownerTurnsFromThread(
  conversationId: string,
  thread: JsonObject,
  previous: JsonObject | undefined,
): JsonValue[] {
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  const settings = asJsonObject(previous?.latestThreadSettings) ?? {};
  const cwd = thread.cwd ?? previous?.cwd ?? null;

  return turns.flatMap((turnValue) => {
    const turn = asJsonObject(turnValue);
    if (!turn || typeof turn.id !== "string") {
      return [];
    }

    const items = Array.isArray(turn.items) ? turn.items : [];
    const userMessage = items.map((item) => asJsonObject(item)).find((item) => item?.type === "userMessage");
    return [
      {
        params: {
          threadId: conversationId,
          input: Array.isArray(userMessage?.content) ? userMessage.content : [],
          approvalPolicy: settings.approvalPolicy ?? null,
          approvalsReviewer: settings.approvalsReviewer ?? null,
          ...ownerTurnPermissionParams(settings),
          model: previous?.latestModel ?? "",
          cwd,
          // The extension parses these back out of the message text (`Eae`); we
          // do not, so the mention block stays visible in the message and the
          // chips above it are missing on a dispatcher-owned turn.
          attachments: [],
          effort: previous?.latestReasoningEffort ?? null,
          summary: "none",
          personality: null,
          outputSchema: null,
          collaborationMode: null,
        },
        permissionParamsSource: "inferred",
        turnId: turn.id,
        turnStartedAtMs: millisecondsFromSeconds(turn.startedAt),
        durationMs: turn.durationMs ?? null,
        finalAssistantStartedAtMs: millisecondsFromSeconds(turn.completedAt),
        status: turn.status ?? null,
        error: turn.error ?? null,
        diff: null,
        items: items.map((item) => ownerTurnItem(item)),
      },
    ];
  });
}

// `Jr`/`jr`
function ownerTurnPermissionParams(settings: JsonObject): JsonObject {
  const profile = asJsonObject(settings.activePermissionProfile);
  const sandboxPolicy = asJsonObject(settings.sandboxPolicy);
  if (!profile) {
    return { sandboxPolicy: settings.sandboxPolicy ?? null };
  }

  const writableRoots = sandboxPolicy?.type === "workspaceWrite" ? sandboxPolicy.writableRoots : [];
  return {
    permissions: profile.id ?? null,
    runtimeWorkspaceRoots: settings.runtimeWorkspaceRoots ?? writableRoots ?? [],
  };
}

// `rPe`. The image branch is deliberately not ported: it rewrites the saved
// path into a webview URI of the owner's own webview, which means nothing in
// the follower's.
function ownerTurnItem(itemValue: JsonValue): JsonValue {
  const item = asJsonObject(itemValue);
  if (item?.type !== "collabAgentToolCall") {
    return itemValue;
  }

  const receiverThreadIds = Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds : [];
  return { ...item, receiverThreads: receiverThreadIds.map((threadId) => ({ threadId, thread: null })) };
}

// The 26.803 replacement for the old per-setting follower calls: one payload
// carrying whatever the follower changed. The merge is a line-by-line copy of
// the webview's own (`Cb` in the webview bundle), because the follower ran
// exactly that over its local state before asking us — and our snapshot then
// overwrites that state wholesale, so anything we merge differently is a
// silent rollback of what the user just picked.
export function applyThreadSettingsUpdate(conversation: JsonObject, threadSettingsValue: JsonValue): void {
  const update = asJsonObject(threadSettingsValue);
  if (!update) {
    throw new Error("threadSettings must be an object");
  }

  const previous = asJsonObject(conversation.latestThreadSettings) ?? {};
  const previousModeModel = collaborationModeModel(conversation.latestCollaborationMode);
  const collaborationMode = mergeCollaborationMode(conversation.latestCollaborationMode, update);

  // Picking a collaboration mode is how the webview changes the model: it sends
  // the mode alone, with the model and effort inside its settings.
  const model =
    update.model ?? collaborationModeModel(update.collaborationMode) ?? previous.model ?? conversation.latestModel;
  const effort = mergeEffort(previous.effort === undefined ? conversation.latestReasoningEffort : previous.effort, update);

  conversation.latestThreadSettings = {
    ...previous,
    ...update,
    ...permissionProfileUpdate(update),
    ...(update.sandboxPolicy !== undefined && update.permissions === undefined ? { permissions: null } : {}),
    model,
    effort,
    collaborationMode,
  };
  conversation.latestModel = model ?? conversation.latestModel;
  conversation.latestReasoningEffort = effort === undefined ? conversation.latestReasoningEffort : effort;
  conversation.latestCollaborationMode = collaborationMode;
  conversation.cwd = update.cwd ?? conversation.cwd;
  rememberPreviousTurnModel(conversation, previousModeModel, collaborationModeModel(collaborationMode));
}

// The app server's own notification, which carries the thread's whole settings
// object rather than the piece somebody changed. The webview keeps a separate
// function for it (`gIe`) and replaces wholesale: merging it like a patch would
// keep keys the thread no longer has and never pick up a cleared one.
export function applyThreadSettingsNotification(conversation: JsonObject, threadSettingsValue: JsonValue): void {
  const settings = asJsonObject(threadSettingsValue);
  if (!settings) {
    throw new Error("threadSettings must be an object");
  }

  const previousModeModel = collaborationModeModel(conversation.latestCollaborationMode);
  conversation.latestThreadSettings = settings;
  conversation.latestModel = settings.model ?? null;
  conversation.modelProvider = settings.modelProvider ?? null;
  conversation.latestReasoningEffort = settings.effort ?? null;
  conversation.latestCollaborationMode = settings.collaborationMode ?? null;
  conversation.cwd = settings.cwd ?? null;
  rememberPreviousTurnModel(conversation, previousModeModel, collaborationModeModel(settings.collaborationMode));
}

// `yIe`: a mode sent by the follower replaces ours as given; otherwise a model
// or effort change is folded into the mode we already have, since that is what
// the next turn is started from.
function mergeCollaborationMode(collaborationModeValue: JsonValue | undefined, update: JsonObject): JsonValue | undefined {
  if (update.collaborationMode != null) {
    return update.collaborationMode;
  }
  if (update.model == null && update.effort === undefined) {
    return collaborationModeValue;
  }

  const collaborationMode = asJsonObject(collaborationModeValue);
  const settings = asJsonObject(collaborationMode?.settings);
  if (!collaborationMode || !settings) {
    return collaborationModeValue;
  }

  return {
    ...collaborationMode,
    settings: {
      ...settings,
      model: update.model ?? settings.model,
      reasoning_effort: update.effort === undefined ? settings.reasoning_effort : update.effort,
    },
  };
}

// `bIe`: an explicit effort wins, a new mode carries its own, and anything else
// leaves the thread's effort alone.
function mergeEffort(previousEffort: JsonValue | undefined, update: JsonObject): JsonValue | undefined {
  if (update.effort !== undefined) {
    return update.effort;
  }
  if (update.collaborationMode == null) {
    return previousEffort;
  }

  return asJsonObject(asJsonObject(update.collaborationMode)?.settings)?.reasoning_effort;
}

// `vIe`: the permission profile is the resolved form of three different ways the
// webview can express the same change.
function permissionProfileUpdate(update: JsonObject): JsonObject {
  if (update.activePermissionProfile !== undefined) {
    return { activePermissionProfile: update.activePermissionProfile };
  }
  if (update.sandboxPolicy !== undefined) {
    return { activePermissionProfile: null };
  }
  if (update.permissions === undefined) {
    return {};
  }

  return {
    activePermissionProfile: update.permissions == null ? null : { id: update.permissions, extends: null },
  };
}

// `xIe`: the UI marks that the model changed since the last turn ran, and drops
// the mark once the model is switched back.
function rememberPreviousTurnModel(
  conversation: JsonObject,
  previousModeModel: JsonValue | undefined,
  nextModeModel: JsonValue | undefined,
): void {
  const turns = Array.isArray(conversation.turns) ? conversation.turns : [];
  if (turns.length === 0 || typeof previousModeModel !== "string" || previousModeModel.length === 0) {
    return;
  }
  if (nextModeModel === previousModeModel) {
    return;
  }
  if (conversation.previousTurnModel == null) {
    conversation.previousTurnModel = previousModeModel;
    return;
  }
  if (nextModeModel === conversation.previousTurnModel) {
    conversation.previousTurnModel = null;
  }
}

function collaborationModeModel(collaborationModeValue: JsonValue | undefined): JsonValue | undefined {
  return asJsonObject(asJsonObject(collaborationModeValue)?.settings)?.model;
}

// The app server names the turn it is actually running when it refuses an
// interrupt aimed at another one. Both spellings come from the webview's own
// parser (`Fze`), which reads either the message or the raw Rust error.
export function mismatchedTurnId(message: string): string | null {
  const named = /expected active turn id `?([^`\s]+)`? but found `?([^`\s]+)`?/.exec(message);
  if (named) {
    return named[2] ?? null;
  }

  return /ExpectedTurnMismatch\s*\{[^}]*actual:\s*"([^"]+)"/.exec(message)?.[1] ?? null;
}

export function isNoActiveTurnError(message: string): boolean {
  return message === "no active turn to interrupt";
}

// Asked once, when this dispatcher takes a thread over: every client with that
// thread open answers with a following change, which is how an owner that
// arrived after its followers finds out they are there.
export function buildFollowingStatusRequestParams(conversationId: string): JsonObject {
  return { conversationId, hostId: dispatcherIpcHostId };
}

export function buildFollowingChangeParams(conversationId: string, following: boolean): JsonObject {
  return { conversationId, hostId: dispatcherIpcHostId, following };
}

export type StreamFollowingChange = {
  conversationId: string;
  clientId: string;
  following: boolean;
};

export function parseStreamFollowingChange(
  paramsValue: JsonValue | undefined,
  sourceClientId: string,
): StreamFollowingChange | null {
  const params = asJsonObject(paramsValue);
  if (!params || params.hostId !== dispatcherIpcHostId) {
    return null;
  }
  if (typeof params.conversationId !== "string" || typeof params.following !== "boolean" || !sourceClientId) {
    return null;
  }

  return { conversationId: params.conversationId, clientId: sourceClientId, following: params.following };
}

export function buildQueuedFollowUpsBroadcastParams(conversationId: string, stateValue: JsonValue): JsonObject {
  return {
    conversationId,
    messages: queuedFollowUpMessagesForConversation(conversationId, stateValue),
  };
}

export function buildDispatcherTurnStartRequest(
  conversationId: string,
  conversation: JsonObject | undefined,
  turnStartParams: JsonObject,
): JsonObject {
  const inherited = turnStartParams.inheritThreadSettings !== false;
  const collaborationMode =
    turnStartParams.collaborationMode ??
    (inherited ? conversation?.latestCollaborationMode ?? null : null);
  // Only a mode the caller named itself carries the model and effort: an
  // inherited one rides along with the thread's own, and dropping them there
  // would run the turn on the app server's default model.
  const modeCarriesModel = turnStartParams.collaborationMode != null;
  // `Wb`: a thread starts life with an empty model and keeps it until the app
  // server names one, and an empty string sent here is a model, not a silence.
  const model = modeCarriesModel
    ? null
    : normalizeJsonString(turnStartParams.model ?? (inherited ? conversation?.latestModel : null));
  const effort = modeCarriesModel
    ? null
    : turnStartParams.effort === undefined
      ? inherited
        ? conversation?.latestReasoningEffort ?? null
        : null
      : turnStartParams.effort;

  return {
    threadId: conversationId,
    input: Array.isArray(turnStartParams.input) ? turnStartParams.input : [],
    cwd: normalizeJsonString(turnStartParams.cwd),
    attachments: Array.isArray(turnStartParams.attachments) ? turnStartParams.attachments : [],
    approvalPolicy: turnStartParams.approvalPolicy ?? null,
    approvalsReviewer: turnStartParams.approvalsReviewer ?? null,
    sandboxPolicy: turnStartParams.sandboxPolicy ?? null,
    model,
    effort,
    collaborationMode,
  };
}

function queuedFollowUpMessagesForConversation(conversationId: string, stateValue: JsonValue): JsonValue[] {
  const state = asJsonObject(stateValue);
  const messages = state?.[conversationId];
  return Array.isArray(messages) ? messages : [];
}

function normalizeJsonString(value: JsonValue | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

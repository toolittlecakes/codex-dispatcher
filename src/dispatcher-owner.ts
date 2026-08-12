import type { JsonObject, JsonValue } from "./codex-app-server";
import { asJsonObject } from "./shared";

export const dispatcherIpcHostId = "local";

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
  const model = collaborationMode
    ? null
    : turnStartParams.model ?? (inherited ? conversation?.latestModel ?? null : null);
  const effort =
    collaborationMode
      ? null
      : turnStartParams.effort ?? (inherited ? conversation?.latestReasoningEffort ?? null : null);

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

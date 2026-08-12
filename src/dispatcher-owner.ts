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
// carrying whatever the follower changed, merged over what the thread already
// had. Model, effort and collaboration mode stay mirrored onto the `latest*`
// fields because that is where the rest of the conversation state reads them.
export function applyThreadSettingsUpdate(conversation: JsonObject, threadSettingsValue: JsonValue): void {
  const threadSettings = asJsonObject(threadSettingsValue);
  if (!threadSettings) {
    throw new Error("threadSettings must be an object");
  }

  const previous = asJsonObject(conversation.latestThreadSettings) ?? {};
  const merged: JsonObject = { ...previous, ...threadSettings };
  conversation.latestThreadSettings = merged;

  if (merged.model !== undefined) {
    conversation.latestModel = merged.model;
  }
  if (merged.effort !== undefined) {
    conversation.latestReasoningEffort = merged.effort;
  }
  if (threadSettings.collaborationMode !== undefined) {
    conversation.latestCollaborationMode = threadSettings.collaborationMode;
    return;
  }

  conversation.latestCollaborationMode = updateCollaborationModeSettings(
    conversation.latestCollaborationMode,
    typeof conversation.latestModel === "string" ? conversation.latestModel : null,
    conversation.latestReasoningEffort,
  );
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

export function updateCollaborationModeSettings(
  collaborationModeValue: JsonValue | undefined,
  model: string | null,
  reasoningEffort: JsonValue | undefined,
): JsonValue | undefined {
  const collaborationMode = asJsonObject(collaborationModeValue);
  const settings = asJsonObject(collaborationMode?.settings);
  if (!collaborationMode || !settings) {
    return collaborationModeValue;
  }

  return {
    ...collaborationMode,
    settings: {
      ...settings,
      model,
      reasoning_effort: reasoningEffort ?? null,
    },
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

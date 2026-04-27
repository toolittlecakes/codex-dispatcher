import type { JsonObject, JsonValue } from "./codex-app-server";

export const dispatcherIpcHostId = "local";

export function buildDispatcherSnapshotParams(conversationId: string, conversation: JsonObject): JsonObject {
  return {
    conversationId,
    hostId: dispatcherIpcHostId,
    change: {
      type: "snapshot",
      conversationState: {
        ...conversation,
        hostId: dispatcherIpcHostId,
      },
    },
  };
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

function asJsonObject(value: JsonValue | undefined): JsonObject | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  return value;
}

import { describe, expect, test } from "bun:test";
import { AppServerError } from "../src/codex-app-server";
import {
  applyThreadSettingsUpdate,
  buildDispatcherSnapshotParams,
  buildDispatcherTurnStartRequest,
  buildOwnerConversationState,
  buildQueuedFollowUpsBroadcastParams,
  dispatcherIpcHostId,
  isNoActiveTurnError,
  minimalOwnerConversationState,
  mismatchedTurnId,
  parseStreamFollowingChange,
} from "../src/dispatcher-owner";
import { asJsonObject } from "../src/shared";

describe("dispatcher owner IPC helpers", () => {
  test("uses the local host id expected by VS Code for stream snapshots", () => {
    expect(
      buildDispatcherSnapshotParams("thread-1", {
        id: "thread-1",
        turns: [],
      }, 7),
    ).toEqual({
      conversationId: "thread-1",
      hostId: dispatcherIpcHostId,
      change: {
        type: "snapshot",
        // Followers store this and refuse anything that does not build on it.
        revision: 7,
        conversationState: {
          id: "thread-1",
          hostId: dispatcherIpcHostId,
          turns: [],
        },
      },
    });
  });

  test("hands the follower a stored turn, not the app-server one it cannot read", () => {
    const conversation = buildOwnerConversationState(
      "thread-1",
      {
        createdAt: 1_700_000_000,
        updatedAt: 1_700_000_060,
        cwd: "/repo",
        turns: [
          {
            id: "turn-1",
            status: "completed",
            startedAt: 1_700_000_010,
            completedAt: 1_700_000_050,
            durationMs: 40_000,
            items: [{ type: "userMessage", content: [{ type: "text", text: "hi" }] }],
          },
        ],
      },
      { latestModel: "gpt-5.4", latestReasoningEffort: "high" },
      [],
    );

    const turn = asJsonObject(asJsonObject(conversation.turns?.[0])!);
    // The crash this replaced: the follower reads `params.input` off every turn.
    expect(asJsonObject(turn?.params)?.input).toEqual([{ type: "text", text: "hi" }]);
    expect(turn?.turnId).toBe("turn-1");
    expect(turn?.permissionParamsSource).toBe("inferred");
    // Seconds on the wire, milliseconds in the store.
    expect(turn?.turnStartedAtMs).toBe(1_700_000_010_000);
    expect(turn?.finalAssistantStartedAtMs).toBe(1_700_000_050_000);
    expect(asJsonObject(turn?.params)?.model).toBe("gpt-5.4");
    expect(asJsonObject(turn?.params)?.effort).toBe("high");
    expect(conversation.createdAt).toBe(1_700_000_000_000);
    expect(conversation.recencyAt).toBe(1_700_000_060_000);
    expect(conversation.resumeState).toBe("resumed");
    expect(conversation.workspaceKind).toBe("project");
    expect(conversation.hostId).toBe(dispatcherIpcHostId);
  });

  test("titles the conversation from the thread name the webview reads it from", () => {
    expect(buildOwnerConversationState("thread-1", { name: "  Fix the bus  ", turns: [] }, undefined, []).title).toBe(
      "Fix the bus",
    );
    // An unnamed thread is the common case: the app-server thread has no title.
    expect(buildOwnerConversationState("thread-1", { turns: [] }, undefined, []).title).toBeNull();
  });

  test("always carries a collaboration mode, which the follower reads through without a guard", () => {
    expect(buildOwnerConversationState("thread-1", { turns: [] }, undefined, []).latestCollaborationMode).toEqual({
      mode: "default",
      settings: { model: "", reasoning_effort: null, developer_instructions: null },
    });
  });

  test("keeps what the follower changed through us across a thread re-read", () => {
    const previous = minimalOwnerConversationState("thread-1", "/repo", []);
    applyThreadSettingsUpdate(previous, { model: "gpt-5.4", permissions: "read-only" });
    previous.queuedFollowUpsState = { "thread-1": [{ id: "msg-1" }] };

    const conversation = buildOwnerConversationState("thread-1", { cwd: "/repo", turns: [] }, previous, []);
    expect(conversation.latestModel).toBe("gpt-5.4");
    expect(conversation.queuedFollowUpsState).toEqual({ "thread-1": [{ id: "msg-1" }] });
    expect(asJsonObject(conversation.latestThreadSettings)?.activePermissionProfile).toEqual({
      id: "read-only",
      extends: null,
    });
  });

  test("names the permission profile the turn ran under instead of a sandbox policy", () => {
    const previous = minimalOwnerConversationState("thread-1", "/repo", []);
    applyThreadSettingsUpdate(previous, { permissions: "read-only" });

    const params = asJsonObject(
      asJsonObject(
        buildOwnerConversationState(
          "thread-1",
          { cwd: "/repo", turns: [{ id: "turn-1", items: [] }] },
          previous,
          [],
        ).turns?.[0],
      )?.params,
    );
    expect(params?.permissions).toBe("read-only");
    expect(params?.runtimeWorkspaceRoots).toEqual([]);
    expect(params?.sandboxPolicy).toBeUndefined();
  });

  test("broadcasts queued follow-up messages from the follower state map", () => {
    const first = { id: "msg-1", text: "continue" };
    expect(
      buildQueuedFollowUpsBroadcastParams("thread-1", {
        "thread-1": [first],
        "thread-2": [{ id: "msg-2", text: "other" }],
      }),
    ).toEqual({
      conversationId: "thread-1",
      messages: [first],
    });
  });

  test("inherits cached model and reasoning when follower start-turn requests thread settings", () => {
    expect(
      buildDispatcherTurnStartRequest(
        "thread-1",
        {
          latestModel: "gpt-5.4",
          latestReasoningEffort: "high",
        },
        {
          input: [{ type: "text", text: "hi" }],
          cwd: " /tmp/project ",
          inheritThreadSettings: true,
        },
      ),
    ).toMatchObject({
      threadId: "thread-1",
      input: [{ type: "text", text: "hi" }],
      cwd: "/tmp/project",
      model: "gpt-5.4",
      effort: "high",
      collaborationMode: null,
    });
  });

  // The thread always has a collaboration mode, so nulling the model whenever
  // one is present would run every inherited turn on the default model.
  test("keeps the thread's model on a turn that only inherited its collaboration mode", () => {
    expect(
      buildDispatcherTurnStartRequest(
        "thread-1",
        {
          latestModel: "gpt-5.4",
          latestReasoningEffort: "high",
          latestCollaborationMode: { mode: "default", settings: { model: "gpt-5.4", reasoning_effort: "high" } },
        },
        { input: [{ type: "text", text: "hi" }] },
      ),
    ).toMatchObject({ model: "gpt-5.4", effort: "high" });
  });

  test("lets a collaboration mode the caller named carry the model and effort itself", () => {
    expect(
      buildDispatcherTurnStartRequest(
        "thread-1",
        { latestModel: "gpt-5.4", latestReasoningEffort: "high" },
        {
          input: [{ type: "text", text: "hi" }],
          collaborationMode: { mode: "plan", settings: { model: "gpt-5-codex", reasoning_effort: "low" } },
        },
      ),
    ).toMatchObject({ model: null, effort: null });
  });

  test("reads a following announcement addressed to our host", () => {
    expect(
      parseStreamFollowingChange({ conversationId: "thread-1", hostId: dispatcherIpcHostId, following: true }, "client-7"),
    ).toEqual({ conversationId: "thread-1", clientId: "client-7", following: true });
  });

  test("ignores a following announcement for someone else's host", () => {
    // A remote host's threads are not ours to stream, and answering them would
    // push our conversation state to a client that asked another owner for it.
    expect(
      parseStreamFollowingChange({ conversationId: "thread-1", hostId: "ssh-remote", following: true }, "client-7"),
    ).toBeNull();
    expect(parseStreamFollowingChange({ conversationId: "thread-1", hostId: dispatcherIpcHostId }, "client-7")).toBeNull();
    expect(
      parseStreamFollowingChange({ conversationId: "thread-1", hostId: dispatcherIpcHostId, following: true }, ""),
    ).toBeNull();
  });

  test("merges a follower's thread settings over the ones the thread already had", () => {
    const conversation = {
      id: "thread-1",
      latestModel: "gpt-5",
      latestReasoningEffort: "medium",
      latestThreadSettings: { model: "gpt-5", effort: "medium", cwd: "/repo" },
      latestCollaborationMode: { id: "pair", settings: { model: "gpt-5", reasoning_effort: "medium" } },
    };

    applyThreadSettingsUpdate(conversation, { model: "gpt-5-codex", effort: "high" });

    expect(conversation.latestThreadSettings).toEqual({
      model: "gpt-5-codex",
      effort: "high",
      cwd: "/repo",
      collaborationMode: { id: "pair", settings: { model: "gpt-5-codex", reasoning_effort: "high" } },
    });
    // The rest of the conversation state reads the model and effort from the
    // `latest*` fields, so a settings update that only lands in the settings
    // object leaves the thread running on the old model.
    expect(conversation.latestModel).toBe("gpt-5-codex");
    expect(conversation.latestReasoningEffort).toBe("high");
    expect(conversation.latestCollaborationMode).toEqual({
      id: "pair",
      settings: { model: "gpt-5-codex", reasoning_effort: "high" },
    });
  });

  // The mode picker is the only way the webview changes the model, and it sends
  // the mode alone — the model and effort ride inside its settings.
  test("takes the model and effort out of a collaboration mode the follower picked", () => {
    const conversation = {
      id: "thread-1",
      latestModel: "gpt-5",
      latestReasoningEffort: "medium",
      latestThreadSettings: { model: "gpt-5", effort: "medium" },
      latestCollaborationMode: { mode: "default", settings: { model: "gpt-5", reasoning_effort: "medium" } },
    };

    applyThreadSettingsUpdate(conversation, {
      collaborationMode: { mode: "plan", settings: { model: "gpt-5-codex", reasoning_effort: "high" } },
    });

    expect(conversation.latestModel).toBe("gpt-5-codex");
    expect(conversation.latestReasoningEffort).toBe("high");
    expect(conversation.latestCollaborationMode).toEqual({
      mode: "plan",
      settings: { model: "gpt-5-codex", reasoning_effort: "high" },
    });
  });

  // A mode is only replaced by another mode: a payload without one keeps the
  // thread's, so an unrelated setting cannot silently drop the user's mode.
  test("keeps the collaboration mode when the update carries none", () => {
    const conversation = {
      id: "thread-1",
      latestCollaborationMode: { mode: "plan", settings: { model: "gpt-5", reasoning_effort: "high" } },
    };

    applyThreadSettingsUpdate(conversation, { collaborationMode: null });

    expect(conversation.latestCollaborationMode).toEqual({
      mode: "plan",
      settings: { model: "gpt-5", reasoning_effort: "high" },
    });
  });

  // Our copy of the thread is a throttled read, so a stop can name a turn the app
  // server has already moved past; it answers by naming the one it is running.
  test("reads the running turn out of an interrupt the app server refused", () => {
    expect(mismatchedTurnId("expected active turn id `turn-1` but found `turn-2`")).toBe("turn-2");
    expect(mismatchedTurnId('ExpectedTurnMismatch { expected: "turn-1", actual: "turn-2" }')).toBe("turn-2");
    expect(mismatchedTurnId("no active turn to interrupt")).toBeNull();
    expect(isNoActiveTurnError("no active turn to interrupt")).toBe(true);
    expect(isNoActiveTurnError("thread not found")).toBe(false);
  });

  // These strings are the app server's, and it is the only party that phrases
  // them: a wrapper that folds the method into the message leaves nothing to
  // match on.
  test("keeps the app server's own wording out of our framing", () => {
    const error = new AppServerError("turn/interrupt", "no active turn to interrupt");

    expect(error.message).toBe("turn/interrupt: no active turn to interrupt");
    expect(isNoActiveTurnError(error.reason)).toBe(true);
  });

  test("resolves a permissions change into the profile the next turn runs with", () => {
    const conversation = { id: "thread-1", activePermissionProfile: { id: "old", extends: null } };

    applyThreadSettingsUpdate(conversation, { permissions: "read-only" });

    expect(asJsonObject(conversation.latestThreadSettings)?.activePermissionProfile).toEqual({
      id: "read-only",
      extends: null,
    });
  });
});

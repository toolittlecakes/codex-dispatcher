import { describe, expect, test } from "bun:test";
import {
  applyThreadSettingsUpdate,
  buildDispatcherSnapshotParams,
  buildDispatcherTurnStartRequest,
  buildQueuedFollowUpsBroadcastParams,
  dispatcherIpcHostId,
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

  test("resolves a permissions change into the profile the next turn runs with", () => {
    const conversation = { id: "thread-1", activePermissionProfile: { id: "old", extends: null } };

    applyThreadSettingsUpdate(conversation, { permissions: "read-only" });

    expect(asJsonObject(conversation.latestThreadSettings)?.activePermissionProfile).toEqual({
      id: "read-only",
      extends: null,
    });
  });
});

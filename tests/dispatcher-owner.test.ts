import { describe, expect, test } from "bun:test";
import {
  buildDispatcherSnapshotParams,
  buildDispatcherTurnStartRequest,
  buildQueuedFollowUpsBroadcastParams,
  dispatcherIpcHostId,
  updateCollaborationModeSettings,
} from "../src/dispatcher-owner";

describe("dispatcher owner IPC helpers", () => {
  test("uses the local host id expected by VS Code for stream snapshots", () => {
    expect(
      buildDispatcherSnapshotParams("thread-1", {
        id: "thread-1",
        turns: [],
      }),
    ).toEqual({
      conversationId: "thread-1",
      hostId: dispatcherIpcHostId,
      change: {
        type: "snapshot",
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

  test("keeps model and effort inside collaboration mode settings", () => {
    expect(
      updateCollaborationModeSettings(
        {
          mode: "collaborative",
          settings: {
            model: "old-model",
            reasoning_effort: "medium",
          },
        },
        "gpt-5.4",
        "high",
      ),
    ).toEqual({
      mode: "collaborative",
      settings: {
        model: "gpt-5.4",
        reasoning_effort: "high",
      },
    });
  });
});

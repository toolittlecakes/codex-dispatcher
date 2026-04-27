import { describe, expect, test } from "bun:test";
import {
  buildApprovalResponseRequest,
  collectApprovalRequests,
  prunePendingApprovalResponses,
} from "../public/approval-requests.js";

describe("approval request helpers", () => {
  test("collects app-server requests and owner mirrored requests", () => {
    const mirroredThreads = new Map([
      [
        "owned-thread",
        {
          requests: [
            {
              id: "ipc-command",
              method: "item/commandExecution/requestApproval",
              params: { command: "date" },
            },
            { id: "unsupported", method: "item/tool/call", params: {} },
          ],
        },
      ],
      [
        "unowned-thread",
        {
          requests: [
            {
              id: "ipc-file",
              method: "item/fileChange/requestApproval",
              params: {},
            },
          ],
        },
      ],
    ]);

    const requests = collectApprovalRequests({
      appServerRequests: [
        {
          id: 7,
          method: "item/permissions/requestApproval",
          params: { permissions: {} },
        },
        {
          id: 8,
          method: "item/tool/call",
          params: {},
        },
      ],
      mirroredThreads,
      streamOwners: new Map([["owned-thread", "owner-1"]]),
    });

    expect(requests.map((request) => request.key)).toEqual([
      "app:7",
      "app:8",
      "ipc:owned-thread:ipc-command",
      "ipc:owned-thread:unsupported",
    ]);
    expect(requests[2]).toMatchObject({
      conversationId: "owned-thread",
      ownerClientId: "owner-1",
      requestId: "ipc-command",
      source: "ipc",
    });
    expect(requests[3]).toMatchObject({
      method: "item/tool/call",
      source: "ipc",
    });
  });

  test("builds app-server response requests unchanged", () => {
    expect(
      buildApprovalResponseRequest(
        {
          id: 7,
          method: "item/permissions/requestApproval",
          source: "appServer",
        },
        { permissions: {}, scope: "turn" },
      ),
    ).toEqual({
      type: "respondServerRequest",
      payload: {
        appServerRequestId: "7",
        result: { permissions: {}, scope: "turn" },
      },
    });
  });

  test("maps command and file approvals to IPC follower decisions", () => {
    expect(
      buildApprovalResponseRequest(
        {
          conversationId: "thread-1",
          method: "item/commandExecution/requestApproval",
          ownerClientId: "owner-1",
          requestId: "request-1",
          source: "ipc",
        },
        { decision: "accept" },
      ),
    ).toEqual({
      type: "ipcFollowerRequest",
      payload: {
        method: "thread-follower-command-approval-decision",
        ownerClientId: "owner-1",
        params: {
          conversationId: "thread-1",
          decision: "accept",
          requestId: "request-1",
        },
        threadId: "thread-1",
      },
    });

    expect(
      buildApprovalResponseRequest(
        {
          conversationId: "thread-1",
          method: "item/fileChange/requestApproval",
          ownerClientId: "owner-1",
          requestId: "request-2",
          source: "ipc",
        },
        { decision: "decline" },
      ).payload.method,
    ).toBe("thread-follower-file-approval-decision");
  });

  test("maps permissions, user input, and MCP elicitation to IPC follower responses", () => {
    const cases = [
      [
        "item/permissions/requestApproval",
        "thread-follower-permissions-request-approval-response",
        { permissions: {}, scope: "turn" },
      ],
      [
        "item/tool/requestUserInput",
        "thread-follower-submit-user-input",
        { answers: { mode: { answers: ["fast"] } } },
      ],
      [
        "mcpServer/elicitation/request",
        "thread-follower-submit-mcp-server-elicitation-response",
        { action: "cancel", content: null, _meta: null },
      ],
    ];

    for (const [requestMethod, followerMethod, response] of cases) {
      expect(
        buildApprovalResponseRequest(
          {
            conversationId: "thread-1",
            method: requestMethod,
            ownerClientId: "owner-1",
            requestId: "request-1",
            source: "ipc",
          },
          response,
        ),
      ).toEqual({
        type: "ipcFollowerRequest",
        payload: {
          method: followerMethod,
          ownerClientId: "owner-1",
          params: {
            conversationId: "thread-1",
            requestId: "request-1",
            response,
          },
          threadId: "thread-1",
        },
      });
    }
  });

  test("tracks pending IPC responses without mutating mirrored requests", () => {
    const mirroredRequest = {
      id: "ipc-command",
      method: "item/commandExecution/requestApproval",
      params: { command: "date" },
    };
    const mirroredConversation = {
      requests: [mirroredRequest],
    };
    const mirroredThreads = new Map([["owned-thread", mirroredConversation]]);
    const pendingApprovalResponseKeys = new Set(["ipc:owned-thread:ipc-command"]);

    const activeRequests = collectApprovalRequests({
      appServerRequests: [],
      mirroredThreads,
      pendingApprovalResponseKeys,
      streamOwners: new Map([["owned-thread", "owner-1"]]),
    });

    expect(activeRequests[0]).toMatchObject({
      key: "ipc:owned-thread:ipc-command",
      responsePending: true,
    });
    expect(mirroredConversation.requests).toEqual([mirroredRequest]);

    prunePendingApprovalResponses(pendingApprovalResponseKeys, activeRequests);
    expect(pendingApprovalResponseKeys.has("ipc:owned-thread:ipc-command")).toBe(true);

    mirroredConversation.requests = [];
    prunePendingApprovalResponses(
      pendingApprovalResponseKeys,
      collectApprovalRequests({
        appServerRequests: [],
        mirroredThreads,
        pendingApprovalResponseKeys,
        streamOwners: new Map([["owned-thread", "owner-1"]]),
      }),
    );
    expect(pendingApprovalResponseKeys.has("ipc:owned-thread:ipc-command")).toBe(false);
  });
});

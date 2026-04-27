const followerResponseMethods = {
  "item/commandExecution/requestApproval": "thread-follower-command-approval-decision",
  "item/fileChange/requestApproval": "thread-follower-file-approval-decision",
  "item/permissions/requestApproval": "thread-follower-permissions-request-approval-response",
  "item/tool/requestUserInput": "thread-follower-submit-user-input",
  "mcpServer/elicitation/request": "thread-follower-submit-mcp-server-elicitation-response",
};

export function collectApprovalRequests({ appServerRequests, mirroredThreads, streamOwners }) {
  const requests = [];

  for (const request of appServerRequests || []) {
    if (request?.id == null) {
      continue;
    }

    requests.push({
      ...request,
      key: `app:${String(request.id)}`,
      requestId: String(request.id),
      source: "appServer",
    });
  }

  for (const [conversationId, conversation] of mirroredThreads || []) {
    const ownerClientId = streamOwners?.get(conversationId);
    if (!ownerClientId || !Array.isArray(conversation?.requests)) {
      continue;
    }

    for (const request of conversation.requests) {
      if (!isSupportedApprovalRequest(request)) {
        continue;
      }

      requests.push({
        ...request,
        conversationId,
        key: `ipc:${conversationId}:${String(request.id)}`,
        ownerClientId,
        requestId: String(request.id),
        source: "ipc",
      });
    }
  }

  return requests;
}

export function buildApprovalResponseRequest(requestValue, result) {
  if (requestValue.source !== "ipc") {
    return {
      type: "respondServerRequest",
      payload: {
        appServerRequestId: String(requestValue.id),
        result,
      },
    };
  }

  const method = followerResponseMethods[requestValue.method];
  if (!method) {
    throw new Error(`Unsupported IPC approval request method: ${String(requestValue.method)}`);
  }

  const params = {
    conversationId: requiredString(requestValue.conversationId, "conversationId"),
    requestId: requiredString(requestValue.requestId || requestValue.id, "requestId"),
  };

  if (requestValue.method === "item/commandExecution/requestApproval" || requestValue.method === "item/fileChange/requestApproval") {
    params.decision = requiredString(result?.decision, "decision");
  } else {
    params.response = result ?? null;
  }

  return {
    type: "ipcFollowerRequest",
    payload: {
      method,
      ownerClientId: requiredString(requestValue.ownerClientId, "ownerClientId"),
      params,
      threadId: params.conversationId,
    },
  };
}

export function isSupportedApprovalRequest(request) {
  return Boolean(request?.id != null && followerResponseMethods[request.method]);
}

function requiredString(value, name) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Missing ${name}`);
  }

  return value;
}

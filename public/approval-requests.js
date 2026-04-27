const followerResponseMethods = {
  "item/commandExecution/requestApproval": "thread-follower-command-approval-decision",
  "item/fileChange/requestApproval": "thread-follower-file-approval-decision",
  "item/permissions/requestApproval": "thread-follower-permissions-request-approval-response",
  "item/tool/requestUserInput": "thread-follower-submit-user-input",
  "mcpServer/elicitation/request": "thread-follower-submit-mcp-server-elicitation-response",
};

export function collectApprovalRequests({
  appServerRequests,
  mirroredThreads,
  pendingApprovalResponseKeys = new Set(),
  streamOwners,
}) {
  const requests = [];

  for (const request of appServerRequests || []) {
    if (request?.id == null) {
      continue;
    }

    const key = `app:${String(request.id)}`;
    requests.push(normalizeRequest(request, key, "appServer", pendingApprovalResponseKeys));
  }

  for (const [conversationId, conversation] of mirroredThreads || []) {
    const ownerClientId = streamOwners?.get(conversationId);
    if (!ownerClientId || !Array.isArray(conversation?.requests)) {
      continue;
    }

    for (const request of conversation.requests) {
      if (request?.id == null) {
        continue;
      }

      const key = `ipc:${conversationId}:${String(request.id)}`;
      requests.push(normalizeRequest(request, key, "ipc", pendingApprovalResponseKeys, {
        conversationId,
        ownerClientId,
      }));
    }
  }

  return requests;
}

export function prunePendingApprovalResponses(pendingApprovalResponseKeys, activeRequests) {
  const activeKeys = new Set(activeRequests.map((request) => request.key));
  for (const key of pendingApprovalResponseKeys) {
    if (!activeKeys.has(key)) {
      pendingApprovalResponseKeys.delete(key);
    }
  }
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

function normalizeRequest(request, key, source, pendingApprovalResponseKeys, extra = {}) {
  return {
    ...request,
    ...extra,
    key,
    requestId: String(request.id),
    responsePending: pendingApprovalResponseKeys.has(key),
    source,
  };
}

function requiredString(value, name) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Missing ${name}`);
  }

  return value;
}

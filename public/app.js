const state = {
  token: new URLSearchParams(location.search).get("token") || localStorage.getItem("dispatcherToken") || "",
  ws: null,
  requestSeq: 1,
  pending: new Map(),
  approvals: new Map(),
  threads: [],
  currentThread: null,
  selectedThreadId: null,
  activeTurnId: null,
  externalActiveTurnId: null,
  liveItems: new Map(),
  defaultCwd: "",
  fastSyncTimer: 0,
  ipc: null,
  streamOwners: new Map(),
  syncTimer: 0,
  isSyncing: false,
  lastThreadSignatures: new Map(),
};

const dom = {
  activeTurnPill: document.querySelector("#activeTurnPill"),
  approvalCount: document.querySelector("#approvalCount"),
  approvalList: document.querySelector("#approvalList"),
  approvalTray: document.querySelector("#approvalTray"),
  composer: document.querySelector("#composer"),
  cwdInput: document.querySelector("#cwdInput"),
  messages: document.querySelector("#messages"),
  newThreadButton: document.querySelector("#newThreadButton"),
  promptInput: document.querySelector("#promptInput"),
  ipcPill: document.querySelector("#ipcPill"),
  refreshButton: document.querySelector("#refreshButton"),
  searchInput: document.querySelector("#searchInput"),
  sendButton: document.querySelector("#sendButton"),
  sessionModePill: document.querySelector("#sessionModePill"),
  sidebarBackdrop: document.querySelector("#sidebarBackdrop"),
  statusPill: document.querySelector("#statusPill"),
  stopButton: document.querySelector("#stopButton"),
  threadList: document.querySelector("#threadList"),
  threadMeta: document.querySelector("#threadMeta"),
  threadPane: document.querySelector("#threadPane"),
  threadsButton: document.querySelector("#threadsButton"),
  threadTitle: document.querySelector("#threadTitle"),
  tokenForm: document.querySelector("#tokenForm"),
  tokenInput: document.querySelector("#tokenInput"),
  tokenPanel: document.querySelector("#tokenPanel"),
};

dom.tokenForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const token = dom.tokenInput.value.trim();
  if (!token) return;
  state.token = token;
  localStorage.setItem("dispatcherToken", token);
  connect();
});

dom.refreshButton.addEventListener("click", () => {
  void loadThreads();
});

dom.newThreadButton.addEventListener("click", () => {
  void createThread();
});

dom.threadsButton.addEventListener("click", () => {
  openSidebar();
});

dom.sidebarBackdrop.addEventListener("click", () => {
  closeSidebar();
});

dom.searchInput.addEventListener("input", debounce(() => {
  void loadThreads();
}, 250));

dom.composer.addEventListener("submit", (event) => {
  event.preventDefault();
  void submitPrompt();
});

dom.stopButton.addEventListener("click", () => {
  void interruptTurn();
});

dom.promptInput.addEventListener("input", () => {
  dom.promptInput.style.height = "auto";
  dom.promptInput.style.height = `${Math.min(dom.promptInput.scrollHeight, 180)}px`;
});

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}

connect();

function connect() {
  if (!state.token) {
    showTokenPanel(true);
    setStatus("Missing token", true);
    return;
  }

  showTokenPanel(false);
  setStatus("Connecting", false);

  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${protocol}//${location.host}/ws?token=${encodeURIComponent(state.token)}`);
  state.ws = ws;

  ws.addEventListener("open", () => {
    setStatus("Connected", false);
  });

  ws.addEventListener("message", (event) => {
    handleServerMessage(JSON.parse(event.data));
  });

  ws.addEventListener("close", () => {
    setStatus("Disconnected", true);
  });

  ws.addEventListener("error", () => {
    setStatus("Connection failed", true);
    showTokenPanel(true);
  });
}

function openSidebar() {
  dom.threadPane.classList.add("open");
  dom.sidebarBackdrop.classList.remove("hidden");
}

function closeSidebar() {
  dom.threadPane.classList.remove("open");
  dom.sidebarBackdrop.classList.add("hidden");
}

function startSyncLoop() {
  if (state.syncTimer) {
    window.clearInterval(state.syncTimer);
  }

  state.syncTimer = window.setInterval(() => {
    void syncExternalState();
  }, 1800);
}

function scheduleFastSync(delay = 220) {
  if (state.fastSyncTimer) {
    window.clearTimeout(state.fastSyncTimer);
  }

  state.fastSyncTimer = window.setTimeout(() => {
    state.fastSyncTimer = 0;
    void syncExternalState();
  }, delay);
}

async function syncExternalState() {
  if (state.isSyncing || !state.ws || state.ws.readyState !== WebSocket.OPEN) {
    return;
  }

  state.isSyncing = true;
  try {
    const previousSelectedSignature = state.selectedThreadId
      ? state.lastThreadSignatures.get(state.selectedThreadId)
      : null;

    await loadThreads({ openFirst: false });

    if (!state.selectedThreadId) {
      return;
    }

    const nextSelectedSignature = state.lastThreadSignatures.get(state.selectedThreadId);
    const hasInProgressTurn = Boolean(findInProgressTurn(state.currentThread));
    if (nextSelectedSignature !== previousSelectedSignature || hasInProgressTurn) {
      await refreshCurrentThread({ preserveScroll: true });
    }
  } catch (error) {
    console.warn("sync failed", error);
  } finally {
    state.isSyncing = false;
  }
}

function handleServerMessage(message) {
  switch (message.type) {
    case "ready":
      state.defaultCwd = message.defaultCwd || "";
      dom.cwdInput.value = state.defaultCwd;
      setIpcStatus(message.ipc);
      setStreamOwners(message.streamOwners || []);
      for (const request of message.pendingServerRequests || []) {
        state.approvals.set(String(request.id), request);
      }
      renderApprovals();
      startSyncLoop();
      void loadThreads();
      break;

    case "response":
      settleRequest(message);
      break;

    case "codexNotification":
      void handleCodexNotification(message.notification);
      break;

    case "serverRequest":
      state.approvals.set(String(message.request.id), message.request);
      renderApprovals();
      break;

    case "serverRequestResolved":
      state.approvals.delete(String(message.id));
      renderApprovals();
      break;

    case "appServerStatus":
      setStatus(message.status === "ready" ? "Ready" : message.status, message.status === "exited");
      break;

    case "codexIpcStatus":
      setIpcStatus(message.ipc);
      break;

    case "codexIpcBroadcast":
      if (message.streamOwners) {
        setStreamOwners(message.streamOwners);
      }
      handleIpcBroadcast(message.broadcast, message.ipc);
      break;

    case "codexIpcStderr":
      setIpcStatus(message.ipc);
      break;

    case "threadStreamOwners":
      setStreamOwners(message.streamOwners || []);
      break;

    default:
      break;
  }
}

function handleIpcBroadcast(broadcast, ipc) {
  setIpcStatus(ipc);
  const method = broadcast?.method;
  const params = broadcast?.params || {};

  if (method === "thread-stream-state-changed") {
    if (typeof params.conversationId === "string" && typeof broadcast.sourceClientId === "string") {
      setThreadOwner(params.conversationId, broadcast.sourceClientId);
    }
    scheduleFastSync();
    return;
  }

  if (
    method === "thread-read-state-changed" ||
    method === "thread-archived" ||
    method === "thread-unarchived" ||
    method === "thread-queued-followups-changed"
  ) {
    scheduleFastSync();
    return;
  }

  if (method === "client-status-changed" && params.status === "connected") {
    scheduleFastSync(500);
  }
}

function settleRequest(message) {
  const pending = state.pending.get(message.requestId);
  if (!pending) return;
  state.pending.delete(message.requestId);

  if (message.ok) {
    pending.resolve(message.result);
    return;
  }

  pending.reject(new Error(message.error || "Request failed"));
}

async function handleCodexNotification(notification) {
  const method = notification.method;
  const params = notification.params || {};

  if (method === "thread/started") {
    await loadThreads();
    return;
  }

  if (method === "turn/started") {
    if (params.threadId === state.selectedThreadId) {
      state.activeTurnId = params.turn?.id || params.turnId || state.activeTurnId;
      renderComposerState();
    }
    return;
  }

  if (method === "item/agentMessage/delta") {
    if (params.threadId !== state.selectedThreadId) return;
    const key = `${params.turnId}:${params.itemId}`;
    const existing = state.liveItems.get(key) || {
      type: "agentMessage",
      id: params.itemId,
      text: "",
    };
    existing.text += params.delta || "";
    state.liveItems.set(key, existing);
    renderMessages();
    scrollMessagesToEnd();
    return;
  }

  if (method === "item/completed") {
    if (params.threadId !== state.selectedThreadId) return;
    const item = params.item;
    if (item?.id) {
      for (const key of state.liveItems.keys()) {
        if (key.endsWith(`:${item.id}`)) {
          state.liveItems.delete(key);
        }
      }
    }
    await refreshCurrentThread();
    return;
  }

  if (method === "turn/completed") {
    if (params.threadId !== state.selectedThreadId) return;
    state.activeTurnId = null;
    state.externalActiveTurnId = null;
    state.liveItems.clear();
    renderComposerState();
    await refreshCurrentThread();
    await loadThreads();
    return;
  }

  if (method === "thread/name/updated" || method === "thread/status/changed") {
    await loadThreads();
    if (params.threadId === state.selectedThreadId) {
      await refreshCurrentThread();
    }
  }
}

async function loadThreads(options = {}) {
  const result = await request("listThreads", {
    searchTerm: dom.searchInput.value.trim(),
  });
  state.threads = result.data || result.threads || [];
  updateThreadSignatures(state.threads);
  renderThreads();
  if (options.openFirst !== false && !state.selectedThreadId && state.threads[0]) {
    await openThread(state.threads[0].id);
  }
}

async function createThread() {
  const result = await request("startThread", {
    cwd: dom.cwdInput.value.trim(),
  });
  const thread = result.thread;
  state.selectedThreadId = thread.id;
  state.currentThread = thread;
  state.externalActiveTurnId = null;
  state.liveItems.clear();
  renderThreads();
  renderThreadHeader();
  renderMessages();
  await loadThreads();
}

async function openThread(threadId) {
  state.selectedThreadId = threadId;
  state.externalActiveTurnId = null;
  state.liveItems.clear();
  closeSidebar();
  renderThreads();

  const result = await request("resumeThread", { threadId });
  state.currentThread = result.thread;
  trackExternalActiveTurn();
  dom.cwdInput.value = result.cwd || result.thread?.cwd || state.defaultCwd;
  renderThreadHeader();
  renderMessages();
  scrollMessagesToEnd();
}

async function refreshCurrentThread(options = {}) {
  if (!state.selectedThreadId) return;
  const wasNearBottom = isNearMessageBottom();
  const result = await request("readThread", { threadId: state.selectedThreadId });
  state.currentThread = result.thread;
  trackExternalActiveTurn();
  renderThreadHeader();
  renderMessages();
  if (!options.preserveScroll || wasNearBottom) {
    scrollMessagesToEnd();
  }
}

async function submitPrompt() {
  const text = dom.promptInput.value.trim();
  if (!text) return;
  const ownerClientId = selectedThreadOwner();
  if (state.externalActiveTurnId && !state.activeTurnId && !ownerClientId) {
    setStatus("Live elsewhere", false);
    return;
  }

  if (!state.selectedThreadId) {
    await createThread();
  }

  const threadId = state.selectedThreadId;
  const nextOwnerClientId = selectedThreadOwner();
  const payload = {
    threadId,
    text,
    cwd: dom.cwdInput.value.trim(),
  };

  dom.promptInput.value = "";
  dom.promptInput.style.height = "auto";
  renderComposerState();

  try {
    if (nextOwnerClientId) {
      const steering = Boolean(state.activeTurnId || state.externalActiveTurnId);
      await request("ipcFollowerRequest", {
        threadId,
        ownerClientId: nextOwnerClientId,
        method: steering ? "thread-follower-steer-turn" : "thread-follower-start-turn",
        params: steering
          ? {
              conversationId: threadId,
              input: [textInput(text)],
              attachments: [],
              restoreMessage: restoreMessage(payload.cwd),
            }
          : {
              conversationId: threadId,
              turnStartParams: {
                input: [textInput(text)],
                cwd: payload.cwd || state.defaultCwd,
                attachments: [],
                inheritThreadSettings: true,
              },
            },
      });
      setStatus("Sent via IPC", false);
      scheduleFastSync();
      return;
    }

    if (state.activeTurnId) {
      await request("steerTurn", {
        ...payload,
        turnId: state.activeTurnId,
      });
      return;
    }

    const result = await request("startTurn", payload);
    state.activeTurnId = result.turn?.id || null;
    state.externalActiveTurnId = null;
    renderComposerState();
    await refreshCurrentThread();
    scrollMessagesToEnd();
  } catch (error) {
    dom.promptInput.value = text;
    dom.promptInput.style.height = "auto";
    dom.promptInput.style.height = `${Math.min(dom.promptInput.scrollHeight, 180)}px`;
    renderComposerState();
    setStatus(error instanceof Error ? error.message : String(error), true);
  }
}

async function interruptTurn() {
  if (!state.selectedThreadId) return;
  const ownerClientId = selectedThreadOwner();
  try {
    if (ownerClientId && (state.activeTurnId || state.externalActiveTurnId)) {
      await request("ipcFollowerRequest", {
        threadId: state.selectedThreadId,
        ownerClientId,
        method: "thread-follower-interrupt-turn",
        params: { conversationId: state.selectedThreadId },
      });
      setStatus("Interrupt sent", false);
      return;
    }

    if (!state.activeTurnId) return;
    await request("interruptTurn", {
      threadId: state.selectedThreadId,
      turnId: state.activeTurnId,
    });
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), true);
  }
}

function request(type, payload = {}) {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
    return Promise.reject(new Error("WebSocket is not connected"));
  }

  const requestId = String(state.requestSeq++);
  const message = { ...payload, type, requestId };

  return new Promise((resolve, reject) => {
    state.pending.set(requestId, { resolve, reject });
    state.ws.send(JSON.stringify(message));
  });
}

function textInput(text) {
  return {
    type: "text",
    text,
    text_elements: [],
  };
}

function restoreMessage(cwd) {
  const currentCwd = cwd || state.currentThread?.cwd || state.defaultCwd || "/";
  return {
    cwd: currentCwd,
    context: {
      workspaceRoots: currentCwd ? [currentCwd] : [],
      collaborationMode: state.currentThread?.latestCollaborationMode || null,
      prompt: "",
      addedFiles: [],
      fileAttachments: [],
      imageAttachments: [],
      commentAttachments: [],
      ideContext: null,
    },
  };
}

function renderThreads() {
  if (state.threads.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No threads found.";
    dom.threadList.replaceChildren(empty);
    return;
  }

  dom.threadList.replaceChildren(...state.threads.map(renderThreadRow));
}

function renderThreadRow(thread) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `thread-row${thread.id === state.selectedThreadId ? " active" : ""}`;
  button.addEventListener("click", () => {
    void openThread(thread.id);
  });

  const main = document.createElement("div");
  main.className = "thread-row-main";

  const title = document.createElement("strong");
  title.textContent = thread.name || thread.preview || "Untitled thread";

  const badge = document.createElement("span");
  const ownerClientId = threadOwner(thread.id);
  badge.className = `thread-badge ${ownerClientId || isRunningStatus(thread.status) ? "running" : ""}`;
  badge.textContent = ownerClientId ? "IPC" : isRunningStatus(thread.status) ? statusLabel(thread.status) : sourceLabel(thread.source);

  main.append(title, badge);

  const meta = document.createElement("span");
  meta.textContent = `${shortPath(thread.cwd) || sourceLabel(thread.source)} - ${formatTime(thread.updatedAt || thread.createdAt)}`;

  button.append(main, meta);
  return button;
}

function renderThreadHeader() {
  const thread = state.currentThread;
  if (!thread) {
    dom.threadTitle.textContent = "No thread selected";
    dom.threadMeta.replaceChildren(metaChip("Connect and pick a session"));
    renderSessionMode();
    return;
  }

  dom.threadTitle.textContent = thread.name || thread.preview || "Untitled thread";
  const ownerClientId = selectedThreadOwner();
  dom.threadMeta.replaceChildren(
    metaChip(shortPath(thread.cwd) || "No cwd"),
    metaChip(ownerClientId ? "IPC follower" : sourceLabel(thread.source), ownerClientId ? "ipc" : ""),
    metaChip(`${turnCount(thread)} turns`),
    metaChip(statusLabel(thread.status), isRunningStatus(thread.status) ? "running" : ""),
  );
  renderSessionMode();
}

function renderMessages() {
  const items = collectItems();
  if (items.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "Start a new Codex turn from this device, or open an existing Desktop/VS Code thread.";
    dom.messages.replaceChildren(empty);
    return;
  }

  dom.messages.replaceChildren(...items.map(renderItem));
}

function collectItems() {
  const turns = state.currentThread?.turns || [];
  const items = [];
  for (const turn of turns) {
    for (const item of turn.items || []) {
      items.push(item);
    }
  }
  for (const liveItem of state.liveItems.values()) {
    items.push(liveItem);
  }
  return items;
}

function renderItem(item) {
  const element = document.createElement("article");
  element.className = `message ${messageClass(item)}`;

  const label = document.createElement("span");
  label.className = "message-label";
  label.textContent = messageLabel(item);
  element.append(label);

  if (item.type === "commandExecution") {
    element.append(renderToolSummary(item.command, item.status, item.cwd));
    element.append(renderDetails("Command", item.command));
    if (item.aggregatedOutput) {
      element.append(renderDetails("Output", item.aggregatedOutput));
    }
    return element;
  }

  if (item.type === "mcpToolCall" || item.type === "dynamicToolCall") {
    element.append(renderToolSummary(`${item.server || item.namespace || "tool"} / ${item.tool}`, item.status, null));
    element.append(renderDetails("Details", JSON.stringify(item.result || item.contentItems || item.error || item.arguments, null, 2)));
    return element;
  }

  const body = document.createElement("div");
  body.className = "message-body";
  body.textContent = itemText(item);
  element.append(body);
  return element;
}

function renderToolSummary(titleText, statusText, subText) {
  const summary = document.createElement("div");
  summary.className = "tool-summary";

  const title = document.createElement("div");
  title.className = "tool-title";
  title.textContent = subText ? `${titleText} - ${shortPath(subText)}` : titleText;

  const status = document.createElement("span");
  status.className = "tool-status";
  status.textContent = statusText || "pending";

  summary.append(title, status);
  return summary;
}

function renderDetails(labelText, bodyText) {
  const details = document.createElement("details");
  details.className = "tool-details";

  const summary = document.createElement("summary");
  summary.textContent = labelText;
  details.append(summary);

  const pre = document.createElement("pre");
  pre.textContent = bodyText || "";
  details.append(pre);
  return details;
}

function messageClass(item) {
  if (item.type === "userMessage") return "user";
  if (item.type === "agentMessage") return "agent";
  if (item.type === "reasoning" || item.type === "plan") return item.type;
  return "tool";
}

function messageLabel(item) {
  switch (item.type) {
    case "userMessage":
      return "You";
    case "agentMessage":
      return "Codex";
    case "reasoning":
      return "Reasoning";
    case "plan":
      return "Plan";
    case "commandExecution":
      return `Command - ${item.status || ""}`;
    case "fileChange":
      return `File change - ${item.status || ""}`;
    case "mcpToolCall":
      return "MCP tool";
    case "dynamicToolCall":
      return "Tool";
    default:
      return item.type || "Item";
  }
}

function itemText(item) {
  switch (item.type) {
    case "userMessage":
      return item.content.map(inputText).filter(Boolean).join("\n");
    case "agentMessage":
      return item.text || "";
    case "reasoning":
      return [...(item.summary || []), ...(item.content || [])].join("\n");
    case "plan":
      return item.text || "";
    case "fileChange":
      return (item.changes || [])
        .map((change) => `${change.kind}: ${change.path}`)
        .join("\n") || `${item.changes?.length || 0} file change(s)`;
    case "webSearch":
      return item.query || "";
    case "imageView":
      return item.path || "";
    case "imageGeneration":
      return item.savedPath || item.result || item.status || "";
    default:
      return JSON.stringify(item, null, 2);
  }
}

function inputText(input) {
  if (input.type === "text") return input.text;
  if (input.type === "image") return `[image] ${input.url}`;
  if (input.type === "localImage") return `[local image] ${input.path}`;
  if (input.type === "mention") return `@${input.name}`;
  if (input.type === "skill") return `[skill] ${input.name}`;
  return "";
}

function renderApprovals() {
  const requests = Array.from(state.approvals.values());
  dom.approvalTray.classList.toggle("hidden", requests.length === 0);
  dom.approvalCount.textContent = requests.length > 0 ? String(requests.length) : "";
  dom.approvalCount.className = requests.length > 0 ? "approval-count-badge" : "";
  dom.approvalList.replaceChildren(...requests.map(renderApproval));
}

function renderApproval(requestValue) {
  const card = document.createElement("section");
  card.className = "approval-card";
  const title = document.createElement("h3");
  title.textContent = approvalTitle(requestValue.method);
  card.append(title);

  const description = document.createElement("p");
  description.textContent = approvalDescription(requestValue);
  card.append(description);

  const pre = document.createElement("pre");
  pre.textContent = approvalBody(requestValue);
  card.append(pre);

  if (requestValue.method === "item/tool/requestUserInput") {
    card.append(renderUserInputForm(requestValue));
    return card;
  }

  const actions = document.createElement("div");
  actions.className = "approval-actions";
  for (const action of approvalActions(requestValue)) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = action.className;
    button.textContent = action.label;
    button.addEventListener("click", () => {
      void respondToApproval(requestValue, action.result);
    });
    actions.append(button);
  }
  card.append(actions);
  return card;
}

function renderUserInputForm(requestValue) {
  const form = document.createElement("form");
  form.className = "approval-form";

  for (const question of requestValue.params?.questions || []) {
    const field = document.createElement("label");
    field.className = "search-field";
    const label = document.createElement("span");
    label.textContent = question.header || question.question || question.id;
    field.append(label);

    if (question.options?.length) {
      const select = document.createElement("select");
      select.name = question.id;
      for (const option of question.options) {
        const element = document.createElement("option");
        element.value = option.label;
        element.textContent = option.label;
        select.append(element);
      }
      field.append(select);
    } else {
      const input = document.createElement("input");
      input.name = question.id;
      input.type = question.isSecret ? "password" : "text";
      input.placeholder = question.question || "";
      field.append(input);
    }

    form.append(field);
  }

  const actions = document.createElement("div");
  actions.className = "approval-actions";
  const submit = document.createElement("button");
  submit.className = "allow";
  submit.type = "submit";
  submit.textContent = "Submit";
  actions.append(submit);
  form.append(actions);

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const answers = {};
    for (const question of requestValue.params?.questions || []) {
      const value = String(data.get(question.id) || "").trim();
      answers[question.id] = { answers: value ? [value] : [] };
    }
    void respondToApproval(requestValue, { answers });
  });

  return form;
}

function approvalTitle(method) {
  if (method === "item/commandExecution/requestApproval") return "Command approval";
  if (method === "item/fileChange/requestApproval") return "File change approval";
  if (method === "item/permissions/requestApproval") return "Permission approval";
  if (method === "item/tool/requestUserInput") return "User input requested";
  if (method === "mcpServer/elicitation/request") return "MCP input requested";
  return "Unsupported app-server request";
}

function approvalDescription(requestValue) {
  const params = requestValue.params || {};
  return params.reason || params.message || params.cwd || requestValue.method;
}

function approvalBody(requestValue) {
  const params = requestValue.params || {};
  if (requestValue.method === "item/commandExecution/requestApproval") {
    return params.command || JSON.stringify(params, null, 2);
  }
  if (requestValue.method === "item/fileChange/requestApproval") {
    return params.grantRoot || JSON.stringify(params, null, 2);
  }
  return JSON.stringify(params, null, 2);
}

function approvalActions(requestValue) {
  const params = requestValue.params || {};
  switch (requestValue.method) {
    case "item/commandExecution/requestApproval":
      return [
        { label: "Allow", className: "allow", result: { decision: "accept" } },
        { label: "Allow session", className: "secondary", result: { decision: "acceptForSession" } },
        { label: "Deny", className: "deny", result: { decision: "decline" } },
      ];

    case "item/fileChange/requestApproval":
      return [
        { label: "Allow", className: "allow", result: { decision: "accept" } },
        { label: "Allow session", className: "secondary", result: { decision: "acceptForSession" } },
        { label: "Deny", className: "deny", result: { decision: "decline" } },
      ];

    case "item/permissions/requestApproval":
      return [
        {
          label: "Grant session",
          className: "allow",
          result: { permissions: grantedPermissions(params.permissions), scope: "session" },
        },
        { label: "Deny", className: "deny", result: { permissions: {}, scope: "turn" } },
      ];

    case "mcpServer/elicitation/request":
      return [
        { label: "Cancel", className: "deny", result: { action: "cancel", content: null, _meta: null } },
      ];

    default:
      return [];
  }
}

function grantedPermissions(permissions) {
  const granted = {};
  if (permissions?.network) {
    granted.network = permissions.network;
  }
  if (permissions?.fileSystem) {
    granted.fileSystem = permissions.fileSystem;
  }
  return granted;
}

async function respondToApproval(requestValue, result) {
  await request("respondServerRequest", {
    appServerRequestId: String(requestValue.id),
    result,
  });
  state.approvals.delete(String(requestValue.id));
  renderApprovals();
}

function renderComposerState() {
  const active = Boolean(state.activeTurnId);
  const externalActive = Boolean(state.externalActiveTurnId && !state.activeTurnId);
  const canFollowExternal = Boolean(externalActive && selectedThreadOwner());
  dom.stopButton.classList.toggle("hidden", !active && !canFollowExternal);
  dom.activeTurnPill.classList.toggle("hidden", !active && !externalActive);
  dom.activeTurnPill.textContent = active ? "Active turn" : canFollowExternal ? "Following" : "Live elsewhere";
  dom.sendButton.disabled = externalActive && !canFollowExternal;
  dom.sendButton.textContent = active || canFollowExternal ? "Steer" : externalActive ? "Live" : "Send";
  renderSessionMode();
}

function renderSessionMode() {
  const ownerClientId = selectedThreadOwner();
  dom.sessionModePill.classList.toggle("ipc", Boolean(ownerClientId));
  dom.sessionModePill.textContent = ownerClientId ? "IPC follower" : "App server";
  dom.sessionModePill.title = ownerClientId ? `Owner ${ownerClientId}` : "Turns start in dispatcher app-server";
}

function setStatus(text, offline) {
  dom.statusPill.textContent = text;
  dom.statusPill.classList.toggle("offline", Boolean(offline));
}

function setIpcStatus(ipc) {
  if (!ipc) {
    return;
  }

  state.ipc = ipc;
  renderIpcStatus();
}

function renderIpcStatus() {
  const ipc = state.ipc;
  if (!ipc) {
    return;
  }

  dom.ipcPill.classList.remove("offline", "error");
  dom.ipcPill.title = ipc.detail || ipc.socketPath || "";

  if (ipc.status === "connected") {
    if (ipc.peerCount > 0) {
      dom.ipcPill.textContent = `IPC ${ipc.peerCount} ${ipc.peerCount === 1 ? "peer" : "peers"}`;
      return;
    }

    dom.ipcPill.textContent = state.streamOwners.size > 0 ? "IPC owner" : "IPC local";
    return;
  }

  if (ipc.status === "error") {
    dom.ipcPill.textContent = "IPC error";
    dom.ipcPill.classList.add("error");
    return;
  }

  if (ipc.status === "starting") {
    dom.ipcPill.textContent = "IPC starting";
    return;
  }

  dom.ipcPill.textContent = "IPC offline";
  dom.ipcPill.classList.add("offline");
}

function setStreamOwners(entries) {
  state.streamOwners.clear();
  for (const entry of entries || []) {
    if (typeof entry?.threadId === "string" && typeof entry.ownerClientId === "string") {
      state.streamOwners.set(entry.threadId, entry.ownerClientId);
    }
  }
  renderThreads();
  renderThreadHeader();
  renderComposerState();
  renderIpcStatus();
}

function setThreadOwner(threadId, ownerClientId) {
  const previous = state.streamOwners.get(threadId);
  if (previous === ownerClientId) {
    return;
  }

  state.streamOwners.set(threadId, ownerClientId);
  renderThreads();
  renderThreadHeader();
  renderComposerState();
  renderIpcStatus();
}

function showTokenPanel(show) {
  dom.tokenPanel.classList.toggle("hidden", !show);
  if (show) {
    dom.tokenInput.value = state.token;
  }
}

function scrollMessagesToEnd() {
  dom.messages.scrollTop = dom.messages.scrollHeight;
}

function isNearMessageBottom() {
  return dom.messages.scrollHeight - dom.messages.scrollTop - dom.messages.clientHeight < 160;
}

function updateThreadSignatures(threads) {
  for (const thread of threads) {
    state.lastThreadSignatures.set(thread.id, threadSignature(thread));
  }
}

function threadSignature(thread) {
  return [
    thread.updatedAt || "",
    stableLabel(thread.status),
    thread.name || "",
    thread.preview || "",
    thread.cwd || "",
  ].join("|");
}

function trackExternalActiveTurn() {
  const turn = findInProgressTurn(state.currentThread);
  state.externalActiveTurnId = turn && turn.id !== state.activeTurnId ? turn.id : null;
  renderComposerState();
}

function selectedThreadOwner() {
  return threadOwner(state.selectedThreadId);
}

function threadOwner(threadId) {
  if (!threadId) return null;
  return state.streamOwners.get(threadId) || null;
}

function findInProgressTurn(thread) {
  const turns = thread?.turns || [];
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    if (turns[index]?.status === "inProgress") {
      return turns[index];
    }
  }
  return null;
}

function metaChip(text, extraClass = "") {
  const chip = document.createElement("span");
  chip.className = `meta-chip ${extraClass}`.trim();
  chip.textContent = text;
  return chip;
}

function sourceLabel(source) {
  if (!source) return "codex";
  if (typeof source === "string") return source;
  if (source.custom) return source.custom;
  if (source.subAgent) return "sub-agent";
  if (source.type) return source.type;
  return "codex";
}

function statusLabel(status) {
  if (!status) return "unknown";
  if (typeof status === "string") return status;
  if (typeof status.type === "string") return status.type;
  if (typeof status.kind === "string") return status.kind;
  return "status";
}

function isRunningStatus(status) {
  if (!status) return false;
  if (typeof status === "string") return status === "running" || status === "active";
  return status.type === "running" || status.type === "active" || status.kind === "running";
}

function stableLabel(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function shortPath(path) {
  if (!path || typeof path !== "string") return "";
  const home = "/Users/sne";
  const normalized = path.startsWith(home) ? `~${path.slice(home.length)}` : path;
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length <= 3) return normalized;
  return `${parts[0] === "~" ? "~" : parts[0]}/.../${parts.slice(-2).join("/")}`;
}

function turnCount(thread) {
  return Array.isArray(thread?.turns) ? thread.turns.length : 0;
}

function formatTime(value) {
  if (!value) return "";
  const date = new Date(value);
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function debounce(fn, delay) {
  let timeout = 0;
  return (...args) => {
    window.clearTimeout(timeout);
    timeout = window.setTimeout(() => fn(...args), delay);
  };
}

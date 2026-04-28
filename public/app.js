import {
  buildApprovalResponseRequest,
  collectApprovalRequests,
  prunePendingApprovalResponses,
} from "./approval-requests.js";
import { applyJsonPatches, cloneJson, isPlainObject } from "./json-patch.js";

const state = {
  token: new URLSearchParams(location.search).get("token") || localStorage.getItem("dispatcherToken") || "",
  ws: null,
  requestSeq: 1,
  pending: new Map(),
  approvals: new Map(),
  pendingApprovalResponses: new Set(),
  threads: [],
  currentThread: null,
  selectedThreadId: null,
  activeTurnId: null,
  externalActiveTurnId: null,
  liveItems: new Map(),
  pendingAttachments: [],
  queuedFollowUps: new Map(),
  editingTurn: null,
  security: null,
  defaultCwd: "",
  fastSyncTimer: 0,
  ipc: null,
  streamOwners: new Map(),
  mirroredThreads: new Map(),
  isSyncing: false,
  lastThreadSignatures: new Map(),
};

const dom = {
  activeTurnPill: document.querySelector("#activeTurnPill"),
  attachButton: document.querySelector("#attachButton"),
  attachmentInput: document.querySelector("#attachmentInput"),
  attachmentStrip: document.querySelector("#attachmentStrip"),
  approvalCount: document.querySelector("#approvalCount"),
  approvalList: document.querySelector("#approvalList"),
  approvalTray: document.querySelector("#approvalTray"),
  collaborationSelect: document.querySelector("#collaborationSelect"),
  compactButton: document.querySelector("#compactButton"),
  composer: document.querySelector("#composer"),
  cwdInput: document.querySelector("#cwdInput"),
  editLastButton: document.querySelector("#editLastButton"),
  messages: document.querySelector("#messages"),
  modelInput: document.querySelector("#modelInput"),
  newThreadButton: document.querySelector("#newThreadButton"),
  promptInput: document.querySelector("#promptInput"),
  ipcPill: document.querySelector("#ipcPill"),
  queueButton: document.querySelector("#queueButton"),
  queueStrip: document.querySelector("#queueStrip"),
  reasoningSelect: document.querySelector("#reasoningSelect"),
  refreshButton: document.querySelector("#refreshButton"),
  searchInput: document.querySelector("#searchInput"),
  securityPanel: document.querySelector("#securityPanel"),
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

dom.attachButton.addEventListener("click", () => {
  dom.attachmentInput.click();
});

dom.attachmentInput.addEventListener("change", () => {
  void addImageAttachments(dom.attachmentInput.files);
  dom.attachmentInput.value = "";
});

dom.compactButton.addEventListener("click", () => {
  void compactCurrentThread();
});

dom.editLastButton.addEventListener("click", () => {
  startEditingLastUserTurn();
});

dom.queueButton.addEventListener("click", () => {
  void queuePrompt();
});

dom.modelInput.addEventListener("change", () => {
  void syncThreadSettings();
});

dom.reasoningSelect.addEventListener("change", () => {
  void syncThreadSettings();
});

dom.collaborationSelect.addEventListener("change", () => {
  void syncThreadSettings();
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
    const hasInProgressTurn = Boolean(findInProgressTurn(currentThreadState()));
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
      setSecurity(message.security);
      setStreamOwners(message.streamOwners || []);
      setMirroredConversations(message.mirroredConversations || []);
      for (const request of message.pendingServerRequests || []) {
        state.approvals.set(String(request.id), request);
      }
      renderApprovals();
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

    case "dispatcherSecurity":
      setSecurity(message.security);
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
      applyThreadStreamChange(params.conversationId, params.change);
    }
    return;
  }

  if (method === "thread-read-state-changed") {
    updateMirroredConversation(params.conversationId, (thread) => {
      thread.hasUnreadTurn = Boolean(params.hasUnreadTurn);
    });
    return;
  }

  if (method === "thread-queued-followups-changed") {
    if (typeof params.conversationId === "string" && Array.isArray(params.messages)) {
      state.queuedFollowUps.set(params.conversationId, params.messages);
      renderQueuedFollowUps();
    }
    scheduleFastSync();
    return;
  }

  if (method === "thread-archived" || method === "thread-unarchived") {
    scheduleFastSync();
    return;
  }

  if (method === "client-status-changed") {
    if (params.status === "disconnected" && typeof params.clientId === "string") {
      dropMirrorsOwnedBy(params.clientId);
      return;
    }

    if (params.status === "connected") {
      scheduleFastSync(500);
    }
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
    const completedThreadId = params.threadId;
    if (completedThreadId === state.selectedThreadId) {
      state.activeTurnId = null;
      state.externalActiveTurnId = null;
      state.liveItems.clear();
      renderComposerState();
      await refreshCurrentThread();
      await loadThreads();
    }
    try {
      await runNextQueuedFollowUp(completedThreadId);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error), true);
    }
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
  const threads = visibleThreads();
  if (options.openFirst !== false && !state.selectedThreadId && threads[0]) {
    await openThread(threads[0].id);
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
  state.pendingAttachments = [];
  state.editingTurn = null;
  hydrateComposerControls(thread);
  renderThreads();
  renderSelectedThread();
  await loadThreads();
}

async function openThread(threadId) {
  state.selectedThreadId = threadId;
  state.externalActiveTurnId = null;
  state.liveItems.clear();
  state.pendingAttachments = [];
  state.editingTurn = null;
  closeSidebar();
  state.currentThread = state.threads.find((thread) => thread.id === threadId) || state.mirroredThreads.get(threadId) || null;
  hydrateComposerControls(state.currentThread);
  renderThreads();

  if (state.mirroredThreads.has(threadId)) {
    renderSelectedThread();
    return;
  }

  const result = await request("resumeThread", { threadId });
  state.currentThread = result.thread;
  trackExternalActiveTurn();
  dom.cwdInput.value = currentThreadState()?.cwd || result.cwd || result.thread?.cwd || state.defaultCwd;
  hydrateComposerControls(currentThreadState());
  renderSelectedThread();
}

async function refreshCurrentThread(options = {}) {
  if (!state.selectedThreadId) return;
  const result = await request("readThread", { threadId: state.selectedThreadId });
  state.currentThread = result.thread;
  renderSelectedThread({ preserveScroll: options.preserveScroll });
}

async function submitPrompt() {
  const text = dom.promptInput.value.trim();
  if (!text && state.pendingAttachments.length === 0) return;
  const ownerClientId = selectedThreadOwner();
  if (state.externalActiveTurnId && !state.activeTurnId && !ownerClientId) {
    setStatus("Live elsewhere", false);
    return;
  }

  if (state.editingTurn) {
    await saveEditedLastUserTurn(text);
    return;
  }

  if (!state.selectedThreadId) {
    await createThread();
  }

  const threadId = state.selectedThreadId;
  const nextOwnerClientId = selectedThreadOwner();
  const attachments = state.pendingAttachments;
  const input = buildComposerInput(text, attachments);
  const turnSettings = selectedTurnSettings();
  const payload = {
    threadId,
    text,
    input,
    cwd: dom.cwdInput.value.trim(),
    ...turnSettings,
  };

  dom.promptInput.value = "";
  dom.promptInput.style.height = "auto";
  state.pendingAttachments = [];
  renderComposerState();
  renderAttachments();

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
              input,
              attachments: [],
              restoreMessage: restoreMessage(payload.cwd),
            }
          : {
              conversationId: threadId,
              turnStartParams: {
                input,
                cwd: payload.cwd || state.defaultCwd,
                attachments: [],
                inheritThreadSettings: turnSettings.inheritThreadSettings,
                model: turnSettings.model,
                effort: turnSettings.effort,
                collaborationMode: turnSettings.collaborationMode,
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
    state.pendingAttachments = attachments;
    dom.promptInput.style.height = "auto";
    dom.promptInput.style.height = `${Math.min(dom.promptInput.scrollHeight, 180)}px`;
    renderComposerState();
    renderAttachments();
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

async function compactCurrentThread() {
  if (!state.selectedThreadId) return;
  const threadId = state.selectedThreadId;
  const ownerClientId = selectedThreadOwner();
  try {
    if (ownerClientId) {
      await request("ipcFollowerRequest", {
        threadId,
        ownerClientId,
        method: "thread-follower-compact-thread",
        params: { conversationId: threadId },
      });
    } else {
      await request("compactThread", { threadId });
      await refreshCurrentThread({ preserveScroll: true });
    }
    setStatus("Compact requested", false);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), true);
  }
}

function startEditingLastUserTurn() {
  if (!selectedThreadOwner()) return;
  const turn = editableLastTurn(currentThreadState());
  if (!turn) return;
  state.editingTurn = {
    threadId: state.selectedThreadId,
    turnId: turn.turnId || turn.id,
    originalText: userInputText(turn.params?.input || []),
  };
  dom.promptInput.value = state.editingTurn.originalText;
  dom.promptInput.focus();
  dom.promptInput.style.height = "auto";
  dom.promptInput.style.height = `${Math.min(dom.promptInput.scrollHeight, 180)}px`;
  renderComposerState();
}

async function saveEditedLastUserTurn(text) {
  const editingTurn = state.editingTurn;
  if (!editingTurn || editingTurn.threadId !== state.selectedThreadId || !text) return;
  const ownerClientId = selectedThreadOwner();
  if (!ownerClientId) {
    setStatus("Edit last requires an IPC owner", true);
    renderComposerState();
    return;
  }
  dom.promptInput.value = "";
  dom.promptInput.style.height = "auto";
  state.editingTurn = null;
  renderComposerState();

  try {
    await request("ipcFollowerRequest", {
      threadId: editingTurn.threadId,
      ownerClientId,
      method: "thread-follower-edit-last-user-turn",
      params: {
        conversationId: editingTurn.threadId,
        turnId: editingTurn.turnId,
        message: text,
      },
    });
    scheduleFastSync();
  } catch (error) {
    state.editingTurn = editingTurn;
    dom.promptInput.value = text;
    dom.promptInput.style.height = `${Math.min(dom.promptInput.scrollHeight, 180)}px`;
    renderComposerState();
    setStatus(error instanceof Error ? error.message : String(error), true);
  }
}

async function queuePrompt() {
  const text = dom.promptInput.value.trim();
  if (!state.selectedThreadId || !text) return;
  const threadId = state.selectedThreadId;
  const message = {
    id: randomId(),
    text,
    context: restoreMessage(dom.cwdInput.value.trim()).context,
    cwd: dom.cwdInput.value.trim() || currentThreadState()?.cwd || state.defaultCwd,
    createdAt: Date.now(),
  };
  const messages = [...queuedMessages(threadId), message];
  try {
    await setQueuedFollowUps(threadId, messages);
    dom.promptInput.value = "";
    dom.promptInput.style.height = "auto";
    renderComposerState();
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), true);
  }
}

async function setQueuedFollowUps(threadId, messages) {
  const previousMessages = queuedMessages(threadId);
  state.queuedFollowUps.set(threadId, messages);
  renderQueuedFollowUps();
  const ownerClientId = threadOwner(threadId);
  try {
    if (ownerClientId) {
      await request("ipcFollowerRequest", {
        threadId,
        ownerClientId,
        method: "thread-follower-set-queued-follow-ups-state",
        params: {
          conversationId: threadId,
          state: { [threadId]: messages },
        },
      });
      return;
    }

    await request("setQueuedFollowUps", {
      threadId,
      state: { [threadId]: messages },
    });
  } catch (error) {
    state.queuedFollowUps.set(threadId, previousMessages);
    renderQueuedFollowUps();
    throw error;
  }
}

async function syncThreadSettings() {
  if (!state.selectedThreadId) return;
  const threadId = state.selectedThreadId;
  const settings = selectedTurnSettings();
  const ownerClientId = selectedThreadOwner();
  try {
    if (ownerClientId) {
      const thread = currentThreadState();
      const ownerModel = settings.model || thread?.latestModel || thread?.latestCollaborationMode?.settings?.model || null;
      if (thread?.latestCollaborationMode && ownerModel && (settings.model || settings.effort)) {
        await request("ipcFollowerRequest", {
          threadId,
          ownerClientId,
          method: "thread-follower-set-model-and-reasoning",
          params: {
            conversationId: threadId,
            model: ownerModel,
            reasoningEffort: settings.effort,
          },
        });
      }
      if (settings.collaborationMode !== null || settings.inheritThreadSettings !== false) {
        return;
      }
      await request("ipcFollowerRequest", {
        threadId,
        ownerClientId,
        method: "thread-follower-set-collaboration-mode",
        params: { conversationId: threadId, collaborationMode: null },
      });
      return;
    }

    await request("setThreadSettings", {
      threadId,
      model: settings.model,
      reasoningEffort: settings.effort,
      collaborationMode: settings.collaborationMode,
      inheritThreadSettings: settings.inheritThreadSettings,
    });
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), true);
  }
}

async function rotateAccessToken() {
  try {
    const result = await request("rotateToken");
    if (typeof result?.token === "string") {
      state.token = result.token;
      localStorage.setItem("dispatcherToken", result.token);
      const url = new URL(location.href);
      url.searchParams.set("token", result.token);
      history.replaceState(null, "", url);
    }
    setSecurity(result?.security);
    setStatus("Token rotated", false);
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
  const thread = currentThreadState();
  const currentCwd = cwd || thread?.cwd || state.defaultCwd || "/";
  return {
    cwd: currentCwd,
    context: {
      workspaceRoots: currentCwd ? [currentCwd] : [],
      collaborationMode: thread?.latestCollaborationMode || null,
      prompt: "",
      addedFiles: [],
      fileAttachments: [],
      imageAttachments: [],
      commentAttachments: [],
      ideContext: null,
    },
  };
}

async function addImageAttachments(fileList) {
  const files = Array.from(fileList || []).filter((file) => file.type.startsWith("image/"));
  if (files.length === 0) return;
  try {
    const attachments = await Promise.all(files.map(readImageAttachment));
    state.pendingAttachments.push(...attachments);
    renderAttachments();
    renderComposerState();
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), true);
  }
}

function readImageAttachment(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      resolve({
        id: randomId(),
        name: file.name,
        type: file.type,
        url: String(reader.result || ""),
      });
    });
    reader.addEventListener("error", () => reject(new Error(`Could not read ${file.name}`)));
    reader.readAsDataURL(file);
  });
}

function buildComposerInput(text, attachments) {
  const input = [];
  if (text) {
    input.push(textInput(text));
  }
  for (const attachment of attachments) {
    input.push({
      type: "image",
      url: attachment.url,
    });
  }
  return input;
}

function selectedTurnSettings() {
  const model = dom.modelInput.value.trim() || null;
  const effort = dom.reasoningSelect.value || null;
  const collaborationOff = dom.collaborationSelect.value === "off";
  return {
    model,
    effort,
    inheritThreadSettings: !collaborationOff,
    collaborationMode: collaborationOff ? null : undefined,
  };
}

function hydrateComposerControls(thread) {
  const latestTurn = Array.isArray(thread?.turns) ? thread.turns.at(-1) : null;
  const collaborationMode = thread?.latestCollaborationMode || latestTurn?.params?.collaborationMode || null;
  const model = thread?.latestModel || collaborationMode?.settings?.model || latestTurn?.params?.model || "";
  const effort =
    thread?.latestReasoningEffort ||
    collaborationMode?.settings?.reasoning_effort ||
    latestTurn?.params?.effort ||
    latestTurn?.params?.reasoningEffort ||
    "";

  dom.modelInput.value = typeof model === "string" ? model : "";
  dom.reasoningSelect.value = typeof effort === "string" ? effort : "";
  dom.collaborationSelect.value = "inherit";
  dom.collaborationSelect.title = collaborationMode ? stringifyPretty(collaborationMode) : "No active collaboration mode";
}

function renderAttachments() {
  dom.attachmentStrip.classList.toggle("hidden", state.pendingAttachments.length === 0);
  dom.attachmentStrip.replaceChildren(...state.pendingAttachments.map(renderAttachmentChip));
}

function renderAttachmentChip(attachment) {
  const chip = document.createElement("span");
  chip.className = "attachment-chip";
  const label = document.createElement("span");
  label.textContent = attachment.name || "Image";
  const remove = document.createElement("button");
  remove.type = "button";
  remove.textContent = "x";
  remove.addEventListener("click", () => {
    state.pendingAttachments = state.pendingAttachments.filter((item) => item.id !== attachment.id);
    renderAttachments();
    renderComposerState();
  });
  chip.append(label, remove);
  return chip;
}

function renderQueuedFollowUps() {
  const messages = queuedMessages(state.selectedThreadId);
  dom.queueStrip.classList.toggle("hidden", messages.length === 0);
  dom.queueStrip.replaceChildren(...messages.map(renderQueuedFollowUpChip));
}

function renderQueuedFollowUpChip(message) {
  const chip = document.createElement("span");
  chip.className = "queue-chip";
  const label = document.createElement("span");
  label.textContent = message.text || "Queued follow-up";
  const remove = document.createElement("button");
  remove.type = "button";
  remove.textContent = "x";
  remove.addEventListener("click", () => {
    const threadId = state.selectedThreadId;
    if (!threadId) return;
    setQueuedFollowUps(threadId, queuedMessages(threadId).filter((item) => item.id !== message.id))
      .catch((error) => setStatus(error instanceof Error ? error.message : String(error), true));
  });
  chip.append(label, remove);
  return chip;
}

function queuedMessages(threadId) {
  if (!threadId) return [];
  const messages = state.queuedFollowUps.get(threadId);
  return Array.isArray(messages) ? messages : [];
}

async function runNextQueuedFollowUp(threadId) {
  if (!threadId || threadOwner(threadId)) {
    return;
  }
  const isSelectedThread = state.selectedThreadId === threadId;
  if (isSelectedThread && state.activeTurnId) {
    return;
  }
  const queued = queuedMessages(threadId);
  const [nextMessage, ...remaining] = queued;
  if (!nextMessage) return;

  await setQueuedFollowUps(threadId, remaining);
  try {
    const result = await request("startTurn", {
      threadId,
      text: nextMessage.text,
      input: [textInput(nextMessage.text)],
      cwd: nextMessage.cwd || (isSelectedThread ? dom.cwdInput.value.trim() : ""),
      ...(isSelectedThread ? selectedTurnSettings() : {}),
    });
    if (isSelectedThread) {
      state.activeTurnId = result.turn?.id || null;
      renderComposerState();
      await refreshCurrentThread();
    }
  } catch (error) {
    try {
      await setQueuedFollowUps(threadId, queued);
    } catch (restoreError) {
      state.queuedFollowUps.set(threadId, queued);
      renderQueuedFollowUps();
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}; queue restore failed: ${
          restoreError instanceof Error ? restoreError.message : String(restoreError)
        }`,
      );
    }
    throw error;
  }
}

function editableLastTurn(thread) {
  const turns = Array.isArray(thread?.turns) ? thread.turns : [];
  const turn = turns.at(-1);
  if (!turn || turn.status === "inProgress") return null;
  const turnId = turn.turnId || turn.id;
  if (!turnId || !userInputText(turn.params?.input || [])) return null;
  return turn;
}

function userInputText(input) {
  return Array.isArray(input)
    ? input.filter((item) => item?.type === "text").map((item) => item.text || "").join("\n").trim()
    : "";
}

function randomId() {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function setMirroredConversations(entries) {
  state.mirroredThreads.clear();
  for (const entry of entries || []) {
    if (typeof entry?.threadId === "string" && isPlainObject(entry.conversation)) {
      state.mirroredThreads.set(entry.threadId, normalizeMirroredThread(entry.threadId, entry.conversation));
    }
  }
  renderThreads();
  renderApprovals();
  renderSelectedThread();
}

function applyThreadStreamChange(threadId, change) {
  if (!isPlainObject(change)) {
    dropMirroredThread(threadId, "Invalid IPC stream change");
    return;
  }

  try {
    if (change.type === "snapshot" && isPlainObject(change.conversationState)) {
      state.mirroredThreads.set(threadId, normalizeMirroredThread(threadId, change.conversationState));
      renderThreads();
      renderApprovals();
      renderSelectedThread({ preserveScroll: true });
      return;
    }

    if (change.type === "patches" && Array.isArray(change.patches)) {
      const current = state.mirroredThreads.get(threadId);
      if (!current) {
        dropMirroredThread(threadId, `Received IPC patches before snapshot for ${threadId}`);
        return;
      }

      state.mirroredThreads.set(threadId, normalizeMirroredThread(threadId, applyJsonPatches(current, change.patches)));
      renderThreads();
      renderApprovals();
      renderSelectedThread({ preserveScroll: true });
      return;
    }

    dropMirroredThread(threadId, `Unsupported IPC stream change ${String(change.type)}`);
  } catch (error) {
    dropMirroredThread(threadId, error instanceof Error ? error.message : String(error));
  }
}

function updateMirroredConversation(threadId, update) {
  if (typeof threadId !== "string") {
    return;
  }

  const current = state.mirroredThreads.get(threadId);
  if (!current) {
    return;
  }

  const next = cloneJson(current);
  update(next);
  state.mirroredThreads.set(threadId, normalizeMirroredThread(threadId, next));
  renderThreads();
  renderApprovals();
  renderSelectedThread({ preserveScroll: true });
}

function normalizeMirroredThread(threadId, conversation) {
  const normalized = cloneJson(conversation);
  normalized.id = typeof normalized.id === "string" ? normalized.id : threadId;
  normalized.name = normalized.name || normalized.title || normalized.preview || "Untitled thread";
  normalized.preview = normalized.preview || normalized.title || normalized.name;
  normalized.status = normalized.status || deriveConversationStatus(normalized);
  normalized.source = normalized.source || "vscode";
  return normalized;
}

function currentThreadState() {
  const mirrored = threadOwner(state.selectedThreadId) ? state.mirroredThreads.get(state.selectedThreadId) : null;
  if (!mirrored) {
    return state.currentThread;
  }

  return mergeThreadState(state.currentThread, mirrored);
}

function mergeThreadState(baseThread, mirroredThread) {
  return {
    ...(baseThread || {}),
    ...mirroredThread,
    id: mirroredThread.id || baseThread?.id || state.selectedThreadId,
    name: mirroredThread.title || mirroredThread.name || baseThread?.name || baseThread?.preview,
    preview: mirroredThread.preview || mirroredThread.title || baseThread?.preview,
    cwd: mirroredThread.cwd || baseThread?.cwd || state.defaultCwd,
    source: mirroredThread.source || baseThread?.source,
  };
}

function renderSelectedThread(options = {}) {
  const thread = currentThreadState();
  if (thread?.cwd && document.activeElement !== dom.cwdInput) {
    dom.cwdInput.value = thread.cwd;
  }

  const wasNearBottom = options.preserveScroll ? isNearMessageBottom() : true;
  trackExternalActiveTurn();
  renderThreadHeader();
  renderMessages();
  renderAttachments();
  renderQueuedFollowUps();
  if (!options.preserveScroll || wasNearBottom) {
    scrollMessagesToEnd();
  }
}

function dropMirrorsOwnedBy(ownerClientId) {
  const threadIds = [];
  for (const [threadId, threadOwnerClientId] of state.streamOwners.entries()) {
    if (threadOwnerClientId === ownerClientId) threadIds.push(threadId);
  }

  for (const threadId of threadIds) {
    dropMirroredThread(threadId, "IPC owner disconnected");
  }
}

function dropMirroredThread(threadId, reason) {
  state.mirroredThreads.delete(threadId);
  state.streamOwners.delete(threadId);
  clearSelectedMirrorThread(threadId, reason);
  renderThreads();
  renderApprovals();
  if (threadId === state.selectedThreadId || !state.selectedThreadId) {
    renderSelectedThread({ preserveScroll: true });
  }
  renderIpcStatus();
}

function renderThreads() {
  const threads = visibleThreads();
  if (threads.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No threads found.";
    dom.threadList.replaceChildren(empty);
    return;
  }

  dom.threadList.replaceChildren(...threads.map(renderThreadRow));
}

function visibleThreads() {
  const visible = state.threads.map((thread) => mergeThreadState(thread, state.mirroredThreads.get(thread.id) || {}));
  const seen = new Set(visible.map((thread) => thread.id));
  for (const [threadId, mirroredThread] of state.mirroredThreads.entries()) {
    if (threadOwner(threadId) && !seen.has(threadId)) {
      visible.push(mirroredThread);
      seen.add(threadId);
    }
  }
  return visible;
}

function renderThreadRow(thread) {
  const displayThread = mergeThreadState(thread, state.mirroredThreads.get(thread.id) || {});
  const button = document.createElement("button");
  button.type = "button";
  button.className = `thread-row${displayThread.id === state.selectedThreadId ? " active" : ""}`;
  button.addEventListener("click", () => {
    void openThread(displayThread.id);
  });

  const main = document.createElement("div");
  main.className = "thread-row-main";

  const title = document.createElement("strong");
  title.textContent = displayThread.name || displayThread.preview || "Untitled thread";

  const badge = document.createElement("span");
  const ownerClientId = threadOwner(displayThread.id);
  badge.className = `thread-badge ${ownerClientId || isRunningStatus(displayThread.status) ? "running" : ""}`;
  badge.textContent = ownerClientId
    ? "IPC"
    : isRunningStatus(displayThread.status)
      ? statusLabel(displayThread.status)
      : sourceLabel(displayThread.source);

  main.append(title, badge);

  const meta = document.createElement("span");
  meta.textContent = `${shortPath(displayThread.cwd) || sourceLabel(displayThread.source)} - ${formatTime(displayThread.updatedAt || displayThread.createdAt)}`;

  button.append(main, meta);
  return button;
}

function renderThreadHeader() {
  const thread = currentThreadState();
  if (!thread) {
    dom.threadTitle.textContent = "CODEX";
    dom.threadMeta.replaceChildren(metaChip("Tasks"));
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
  const stickToEnd = isNearMessageBottom();
  const items = collectItems();
  if (items.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "Start a new Codex turn from this device, or open an existing Desktop/VS Code thread.";
    dom.messages.replaceChildren(empty);
    return;
  }

  dom.messages.replaceChildren(...items.map(renderItem));
  if (stickToEnd) {
    scrollMessagesToEnd();
  }
}

function collectItems() {
  const turns = currentThreadState()?.turns || [];
  const items = [];
  for (const [turnIndex, turn] of turns.entries()) {
    const turnItems = turn.items || [];
    if (!turnItems.some((item) => item?.type === "userMessage") && Array.isArray(turn.params?.input)) {
      items.push({
        type: "userMessage",
        id: `turn-${turn.turnId || turnIndex}-input`,
        content: turn.params.input,
      });
    }
    for (const item of turnItems) {
      items.push(renderableItem(item));
    }
    if (hasDisplayValue(turn.diff)) {
      items.push({
        type: "turnDiff",
        id: `turn-${turn.turnId || turnIndex}-diff`,
        diff: turn.diff,
      });
    }
  }
  for (const liveItem of state.liveItems.values()) {
    items.push(renderableItem(liveItem));
  }
  return items;
}

function renderableItem(item) {
  if (item && typeof item === "object") {
    return item;
  }
  return {
    type: "error",
    message: "Malformed item",
    additionalDetails: item,
  };
}

function renderItem(item) {
  const element = document.createElement("article");
  element.className = `message ${messageClass(item)}`;

  const label = document.createElement("span");
  label.className = "message-label";
  label.textContent = messageLabel(item);
  element.append(label);

  element.append(renderItemBody(item));
  return element;
}

function renderItemBody(item) {
  if (item.type === "agentMessage") {
    return renderMarkdown(item.text || "");
  }

  if (item.type === "userMessage") {
    return renderMarkdown(itemText(item));
  }

  if (item.type === "reasoning") {
    return renderReasoning(item);
  }

  if (item.type === "plan" || item.type === "todo-list" || item.type === "planImplementation") {
    return renderPlanItem(item);
  }

  if (item.type === "commandExecution") {
    return renderCommandExecution(item);
  }

  if (item.type === "mcpToolCall" || item.type === "dynamicToolCall" || item.type === "collabAgentToolCall") {
    return renderToolCall(item);
  }

  if (item.type === "fileChange") {
    return renderFileChange(item);
  }

  if (item.type === "turnDiff") {
    return renderDiff("Diff", item.diff);
  }

  if (item.type === "imageView" || item.type === "imageGeneration") {
    return renderImageItem(item);
  }

  if (item.type === "error") {
    return renderErrorItem(item);
  }

  if (item.type === "webSearch") {
    return renderKeyValueBody([["Query", item.query], ["Status", item.action || item.status]]);
  }

  const body = document.createElement("div");
  body.className = "message-body";
  body.textContent = itemText(item);
  return body;
}

function renderReasoning(item) {
  const body = document.createElement("div");
  body.className = "message-body reasoning-body";

  const summary = flattenTextParts(item.summary);
  const content = flattenTextParts(item.content);
  if (summary) {
    body.append(renderMarkdown(summary));
  }
  if (content) {
    body.append(renderDetails("Raw reasoning", content));
  }
  if (!summary && !content) {
    body.textContent = item.status || "Reasoning";
  }
  return body;
}

function renderPlanItem(item) {
  if (item.type === "todo-list" && Array.isArray(item.plan)) {
    const body = document.createElement("div");
    body.className = "message-body";
    if (item.explanation) {
      body.append(renderMarkdown(item.explanation));
    }
    const list = document.createElement("ol");
    list.className = "plan-list";
    for (const entry of item.plan) {
      const planEntry = isPlainObject(entry) ? entry : {};
      const row = document.createElement("li");
      row.className = `plan-step ${String(planEntry.status || "").toLowerCase()}`;
      row.textContent = [planEntry.status, planEntry.step || planEntry.text || stringifyPretty(entry)]
        .filter(Boolean)
        .join(" - ");
      list.append(row);
    }
    body.append(list);
    return body;
  }

  if (item.type === "planImplementation") {
    return renderKeyValueBody([
      ["Plan", item.planContent],
      ["Status", item.isCompleted ? "completed" : "in progress"],
    ]);
  }

  return renderMarkdown(item.text || item.content || "");
}

function renderCommandExecution(item) {
  const body = document.createElement("div");
  body.className = "message-body tool-body";
  body.append(renderToolSummary(item.command || "Command", item.status, item.cwd));
  body.append(renderDetails("Command", item.command || ""));
  if (item.exitCode != null) {
    body.append(renderKeyValueBody([["Exit code", String(item.exitCode)]]));
  }
  if (item.aggregatedOutput) {
    body.append(renderDetails("Output", item.aggregatedOutput, true));
  }
  return body;
}

function renderToolCall(item) {
  const title = item.type === "collabAgentToolCall"
    ? `${item.tool || item.action || "agent"}`
    : `${item.server || item.namespace || "tool"} / ${item.tool || item.functionName || item.name || "call"}`;
  const body = document.createElement("div");
  body.className = "message-body tool-body";
  body.append(renderToolSummary(title, item.status || (item.completed ? "completed" : "pending"), null));

  const args = item.arguments || item.invocation?.arguments || item.prompt || null;
  const result = item.result || item.contentItems || item.error || item.agentsStates || null;
  if (args) {
    body.append(renderDetails("Arguments", stringifyPretty(args)));
  }
  if (result) {
    body.append(renderDetails("Result", stringifyPretty(result)));
  }
  return body;
}

function renderFileChange(item) {
  const body = document.createElement("div");
  body.className = "message-body file-change-body";
  const changes = Array.isArray(item.changes) ? item.changes : [];
  if (changes.length === 0) {
    body.textContent = "No file changes";
    return body;
  }

  const list = document.createElement("div");
  list.className = "file-change-list";
  for (const change of changes) {
    const changeObject = isPlainObject(change) ? change : {};
    const row = document.createElement("div");
    row.className = "change-row";
    const kind = document.createElement("span");
    kind.className = "change-kind";
    kind.textContent = fileChangeKind(changeObject);
    const path = document.createElement("span");
    path.className = "change-path";
    path.textContent = fileChangePath(changeObject) || stringifyPretty(change);
    row.append(kind, path);
    list.append(row);

    const diff = fileChangeDiff(changeObject);
    if (diff) {
      list.append(renderDetails("Patch", diff, true));
    }
  }
  body.append(list);
  return body;
}

function renderDiff(label, diff) {
  const body = document.createElement("div");
  body.className = "message-body";
  body.append(renderDetails(label, formatDiffValue(diff), true, true));
  return body;
}

function renderImageItem(item) {
  const body = document.createElement("div");
  body.className = "message-body image-body";
  const src = displayableImageSrc(item.src || item.url || item.result);
  if (src) {
    const image = document.createElement("img");
    image.className = "image-preview";
    image.src = src;
    image.alt = item.prompt || item.path || "Generated image";
    body.append(image);
  }
  body.append(renderKeyValueBody([
    ["Status", item.status],
    ["Path", item.path || item.savedPath],
    ["Prompt", item.prompt],
  ]));
  return body;
}

function renderErrorItem(item) {
  const body = document.createElement("div");
  body.className = "message-body error-body";
  body.append(renderMarkdown(item.message || item.content || "Error"));
  if (item.additionalDetails || item.errorInfo) {
    body.append(renderDetails("Details", stringifyPretty(item.additionalDetails || item.errorInfo)));
  }
  return body;
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

function renderDetails(labelText, bodyText, startOpen = false, diff = false) {
  const details = document.createElement("details");
  details.className = "tool-details";
  details.open = Boolean(startOpen);

  const summary = document.createElement("summary");
  summary.textContent = labelText;
  details.append(summary);

  const pre = document.createElement("pre");
  if (diff) {
    pre.className = "diff-pre";
  }
  pre.textContent = bodyText || "";
  details.append(pre);
  return details;
}

function messageClass(item) {
  if (item.type === "userMessage") return "user";
  if (item.type === "agentMessage") return "agent";
  if (item.type === "reasoning" || item.type === "plan") return item.type;
  if (item.type === "todo-list" || item.type === "planImplementation") return "plan";
  if (item.type === "fileChange" || item.type === "turnDiff") return "diff";
  if (item.type === "imageView" || item.type === "imageGeneration") return "image";
  if (item.type === "error") return "error";
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
    case "turnDiff":
      return "Diff";
    case "mcpToolCall":
      return "MCP tool";
    case "dynamicToolCall":
      return "Tool";
    case "todo-list":
      return "Plan";
    case "planImplementation":
      return "Plan";
    case "error":
      return "Error";
    default:
      return item.type || "Item";
  }
}

function itemText(item) {
  switch (item.type) {
    case "userMessage":
      return Array.isArray(item.content)
        ? item.content.map(inputText).filter(Boolean).join("\n")
        : stringifyPretty(item.content);
    case "agentMessage":
      return item.text || "";
    case "reasoning":
      return [flattenTextParts(item.summary), flattenTextParts(item.content)].filter(Boolean).join("\n");
    case "plan":
      return item.text || "";
    case "fileChange": {
      const changes = Array.isArray(item.changes) ? item.changes : [];
      return changes
        .map((change) => `${fileChangeKind(isPlainObject(change) ? change : {})}: ${fileChangePath(change) || stringifyPretty(change)}`)
        .join("\n") || `${changes.length} file change(s)`;
    }
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

function renderMarkdown(text) {
  const body = document.createElement("div");
  body.className = "message-body rich-text";
  const blocks = splitMarkdownCodeBlocks(String(text || ""));
  for (const block of blocks) {
    if (block.type === "code") {
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      code.textContent = block.content;
      if (block.language) {
        pre.dataset.language = block.language;
      }
      pre.append(code);
      body.append(pre);
      continue;
    }
    appendMarkdownText(body, block.content);
  }
  return body;
}

function splitMarkdownCodeBlocks(text) {
  const blocks = [];
  const fence = /```([^\n`]*)\n?([\s\S]*?)```/g;
  let cursor = 0;
  for (const match of text.matchAll(fence)) {
    if (match.index > cursor) {
      blocks.push({ type: "text", content: text.slice(cursor, match.index) });
    }
    blocks.push({
      type: "code",
      language: (match[1] || "").trim(),
      content: (match[2] || "").replace(/\n$/, ""),
    });
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) {
    blocks.push({ type: "text", content: text.slice(cursor) });
  }
  return blocks.length > 0 ? blocks : [{ type: "text", content: "" }];
}

function appendMarkdownText(parent, text) {
  const lines = String(text || "").split(/\r?\n/);
  let paragraph = [];
  let list = null;
  let listKind = null;

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    const p = document.createElement("p");
    appendInlineMarkdown(p, paragraph.join("\n").trim());
    parent.append(p);
    paragraph = [];
  };

  const flushList = () => {
    if (!list) return;
    parent.append(list);
    list = null;
    listKind = null;
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      flushParagraph();
      flushList();
      continue;
    }

    const heading = trimmed.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      flushList();
      const level = Math.min(4, heading[1].length + 2);
      const h = document.createElement(`h${level}`);
      appendInlineMarkdown(h, heading[2]);
      parent.append(h);
      continue;
    }

    const bullet = trimmed.match(/^[-*]\s+(.+)$/);
    const numbered = trimmed.match(/^\d+[.)]\s+(.+)$/);
    if (bullet || numbered) {
      flushParagraph();
      const nextKind = bullet ? "ul" : "ol";
      if (!list || listKind !== nextKind) {
        flushList();
        list = document.createElement(nextKind);
        listKind = nextKind;
      }
      const li = document.createElement("li");
      appendInlineMarkdown(li, bullet ? bullet[1] : numbered[1]);
      list.append(li);
      continue;
    }

    if (trimmed.startsWith(">")) {
      flushParagraph();
      flushList();
      const quote = document.createElement("blockquote");
      appendInlineMarkdown(quote, trimmed.replace(/^>\s?/, ""));
      parent.append(quote);
      continue;
    }

    paragraph.push(line);
  }

  flushParagraph();
  flushList();
}

function appendInlineMarkdown(parent, text) {
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]\n]+\]\(([^)\n]+)\))/g;
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > cursor) {
      parent.append(document.createTextNode(text.slice(cursor, match.index)));
    }
    const token = match[0];
    if (token.startsWith("`")) {
      const code = document.createElement("code");
      code.textContent = token.slice(1, -1);
      parent.append(code);
    } else if (token.startsWith("**")) {
      const strong = document.createElement("strong");
      strong.textContent = token.slice(2, -2);
      parent.append(strong);
    } else {
      const parts = token.match(/^\[([^\]\n]+)\]\(([^)\n]+)\)$/);
      const url = parts?.[2] || "";
      if (isSafeUrl(url)) {
        const link = document.createElement("a");
        link.href = url;
        link.target = "_blank";
        link.rel = "noreferrer";
        link.textContent = parts[1];
        parent.append(link);
      } else {
        parent.append(document.createTextNode(parts?.[1] || token));
      }
    }
    cursor = match.index + token.length;
  }
  if (cursor < text.length) {
    parent.append(document.createTextNode(text.slice(cursor)));
  }
}

function renderKeyValueBody(entries) {
  const body = document.createElement("div");
  body.className = "message-body key-value-body";
  for (const [label, value] of entries) {
    if (value == null || value === "") continue;
    const row = document.createElement("div");
    row.className = "key-value-row";
    const key = document.createElement("span");
    key.textContent = label;
    const val = document.createElement("span");
    val.textContent = typeof value === "string" ? value : stringifyPretty(value);
    row.append(key, val);
    body.append(row);
  }
  return body;
}

function flattenTextParts(parts) {
  if (!Array.isArray(parts)) {
    return typeof parts === "string" ? parts : "";
  }
  return parts
    .map((part) => {
      if (typeof part === "string") return part;
      if (typeof part?.text === "string") return part.text;
      if (typeof part?.content === "string") return part.content;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function stringifyPretty(value) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function hasDisplayValue(value) {
  if (value == null || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

function formatDiffValue(value) {
  if (Array.isArray(value)) {
    return value.map(formatDiffEntry).filter(Boolean).join("\n");
  }
  return formatDiffEntry(value);
}

function formatDiffEntry(value) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return String(value || "");
  return value.unified_diff || value.diff || value.content || stringifyPretty(value);
}

function fileChangeKind(change) {
  const kind = change.kind;
  if (typeof kind === "string") return kind;
  if (typeof kind?.type === "string") return kind.type;
  if (change.move_path) return "move";
  return "change";
}

function fileChangePath(change) {
  return change?.path || change?.move_path || "";
}

function fileChangeDiff(change) {
  return change?.unified_diff || change?.diff || change?.content || "";
}

function isSafeUrl(value) {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value, location.href);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function displayableImageSrc(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (trimmed.startsWith("data:image/") || /^https?:\/\//.test(trimmed)) {
    return trimmed;
  }

  const compact = trimmed.replace(/\s/g, "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact) || compact.length < 64) {
    return "";
  }

  if (compact.startsWith("iVBORw0KGgo")) return `data:image/png;base64,${compact}`;
  if (compact.startsWith("/9j/")) return `data:image/jpeg;base64,${compact}`;
  if (compact.startsWith("R0lGOD")) return `data:image/gif;base64,${compact}`;
  if (compact.startsWith("UklGR")) return `data:image/webp;base64,${compact}`;
  return `data:image/png;base64,${compact}`;
}

function inputText(input) {
  if (!input || typeof input !== "object") return stringifyPretty(input);
  if (input.type === "text") return input.text;
  if (input.type === "image") return `[image] ${input.url}`;
  if (input.type === "localImage") return `[local image] ${input.path}`;
  if (input.type === "mention") return `@${input.name}`;
  if (input.type === "skill") return `[skill] ${input.name}`;
  return "";
}

function renderApprovals() {
  const requests = collectApprovalRequests({
    appServerRequests: Array.from(state.approvals.values()),
    mirroredThreads: state.mirroredThreads,
    pendingApprovalResponseKeys: state.pendingApprovalResponses,
    streamOwners: state.streamOwners,
  });
  prunePendingApprovalResponses(state.pendingApprovalResponses, requests);
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

  if (requestValue.responsePending) {
    const pending = document.createElement("p");
    pending.textContent = requestValue.source === "ipc" ? "Sent to owner. Waiting for owner state." : "Response sent.";
    card.append(pending);
  }

  const pre = document.createElement("pre");
  pre.textContent = approvalBody(requestValue);
  card.append(pre);

  if (requestValue.method === "item/tool/requestUserInput") {
    card.append(renderUserInputForm(requestValue));
    return card;
  }

  if (requestValue.method === "mcpServer/elicitation/request" && mcpElicitationFields(requestValue).length > 0) {
    card.append(renderMcpElicitationForm(requestValue));
    return card;
  }

  const actions = document.createElement("div");
  actions.className = "approval-actions";
  for (const action of approvalActions(requestValue)) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = action.className;
    button.disabled = Boolean(requestValue.responsePending);
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
      select.disabled = Boolean(requestValue.responsePending);
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
      input.disabled = Boolean(requestValue.responsePending);
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
  submit.disabled = Boolean(requestValue.responsePending);
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

function renderMcpElicitationForm(requestValue) {
  const form = document.createElement("form");
  form.className = "approval-form";
  const fields = mcpElicitationFields(requestValue);

  for (const fieldConfig of fields) {
    const field = document.createElement("label");
    field.className = "search-field";

    const label = document.createElement("span");
    label.textContent = fieldConfig.label;
    field.append(label);

    if (fieldConfig.options.length > 0) {
      const select = document.createElement("select");
      select.disabled = Boolean(requestValue.responsePending);
      select.name = fieldConfig.name;
      select.required = fieldConfig.required;
      if (!fieldConfig.required) {
        const empty = document.createElement("option");
        empty.value = "";
        empty.textContent = "";
        select.append(empty);
      }
      fieldConfig.options.forEach((option, index) => {
        const element = document.createElement("option");
        element.value = String(index);
        element.textContent = formatJsonOption(option);
        select.append(element);
      });
      field.append(select);
    } else if (fieldConfig.type === "boolean" && !fieldConfig.required) {
      const select = document.createElement("select");
      select.disabled = Boolean(requestValue.responsePending);
      select.name = fieldConfig.name;

      for (const option of [
        ["", ""],
        ["true", "true"],
        ["false", "false"],
      ]) {
        const element = document.createElement("option");
        element.value = option[0];
        element.textContent = option[1];
        select.append(element);
      }
      field.append(select);
    } else if (fieldConfig.type === "boolean") {
      const input = document.createElement("input");
      input.disabled = Boolean(requestValue.responsePending);
      input.name = fieldConfig.name;
      input.type = "checkbox";
      field.append(input);
    } else {
      const input = document.createElement("input");
      input.disabled = Boolean(requestValue.responsePending);
      input.name = fieldConfig.name;
      input.required = fieldConfig.required;
      input.type = fieldConfig.type === "number" || fieldConfig.type === "integer" ? "number" : "text";
      if (fieldConfig.type === "integer") {
        input.step = "1";
      }
      input.placeholder = fieldConfig.description || "";
      field.append(input);
    }

    form.append(field);
  }

  const actions = document.createElement("div");
  actions.className = "approval-actions";

  const submit = document.createElement("button");
  submit.className = "allow";
  submit.disabled = Boolean(requestValue.responsePending);
  submit.type = "submit";
  submit.textContent = "Submit";
  actions.append(submit);

  const cancel = document.createElement("button");
  cancel.className = "deny";
  cancel.disabled = Boolean(requestValue.responsePending);
  cancel.type = "button";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => {
    void respondToApproval(requestValue, { action: "cancel", content: null, _meta: null });
  });
  actions.append(cancel);

  form.append(actions);

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const content = {};
    try {
      for (const fieldConfig of fields) {
        const value = mcpFieldValue(fieldConfig, data);
        if (value.shouldInclude) {
          content[fieldConfig.name] = value.value;
        }
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error), true);
      return;
    }
    void respondToApproval(requestValue, { action: "accept", content, _meta: null });
  });

  return form;
}

function approvalTitle(method) {
  if (method === "item/commandExecution/requestApproval") return "Command approval";
  if (method === "item/fileChange/requestApproval") return "File change approval";
  if (method === "item/permissions/requestApproval") return "Permission approval";
  if (method === "item/tool/requestUserInput") return "User input requested";
  if (method === "mcpServer/elicitation/request") return "MCP input requested";
  return "Unsupported request";
}

function approvalDescription(requestValue) {
  const params = requestValue.params || {};
  const source = requestValue.source === "ipc" ? `${threadTitle(requestValue.conversationId)} - ` : "";
  return `${source}${params.reason || params.message || params.cwd || requestValue.method}`;
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
        { label: "Accept", className: "allow", result: { action: "accept", content: {}, _meta: null } },
        { label: "Decline", className: "secondary", result: { action: "decline", content: null, _meta: null } },
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
  const pendingKey = requestValue.key || `${requestValue.source || "request"}:${String(requestValue.id)}`;
  state.pendingApprovalResponses.add(pendingKey);
  renderApprovals();

  try {
    const responseRequest = buildApprovalResponseRequest(requestValue, result);
    await request(responseRequest.type, responseRequest.payload);

    if (requestValue.source !== "ipc") {
      state.approvals.delete(String(requestValue.id));
      state.pendingApprovalResponses.delete(pendingKey);
    }

    setStatus("Approval sent", false);
    renderApprovals();
  } catch (error) {
    state.pendingApprovalResponses.delete(pendingKey);
    setStatus(error instanceof Error ? error.message : String(error), true);
    renderApprovals();
  }
}

function mcpElicitationFields(requestValue) {
  const schema = requestValue.params?.requestedSchema;
  if (!isPlainObject(schema) || !isPlainObject(schema.properties)) {
    return [];
  }

  const required = Array.isArray(schema.required) ? new Set(schema.required.filter((name) => typeof name === "string")) : new Set();
  return Object.entries(schema.properties).flatMap(([name, fieldSchema]) => {
    if (!isPlainObject(fieldSchema)) {
      return [];
    }

    const type = Array.isArray(fieldSchema.type) ? fieldSchema.type.find((value) => value !== "null") : fieldSchema.type;
    return [{
      description: typeof fieldSchema.description === "string" ? fieldSchema.description : "",
      label: typeof fieldSchema.title === "string" ? fieldSchema.title : name,
      name,
      options: Array.isArray(fieldSchema.enum) ? fieldSchema.enum : [],
      required: required.has(name),
      type: typeof type === "string" ? type : "string",
    }];
  });
}

function mcpFieldValue(fieldConfig, data) {
  if (fieldConfig.options.length > 0) {
    const rawIndex = String(data.get(fieldConfig.name) || "");
    if (!fieldConfig.required && rawIndex.length === 0) {
      return { shouldInclude: false, value: null };
    }

    const index = Number(rawIndex);
    if (!Number.isInteger(index) || index < 0 || index >= fieldConfig.options.length) {
      throw new Error(`Invalid value for ${fieldConfig.label}`);
    }

    return { shouldInclude: true, value: fieldConfig.options[index] };
  }

  if (fieldConfig.type === "boolean" && !fieldConfig.required) {
    const rawValue = String(data.get(fieldConfig.name) || "");
    if (rawValue.length === 0) {
      return { shouldInclude: false, value: null };
    }

    return { shouldInclude: true, value: rawValue === "true" };
  }

  if (fieldConfig.type === "boolean") {
    return { shouldInclude: true, value: data.get(fieldConfig.name) === "on" };
  }

  const rawValue = String(data.get(fieldConfig.name) || "").trim();
  if (!fieldConfig.required && rawValue.length === 0) {
    return { shouldInclude: false, value: null };
  }
  if (fieldConfig.required && rawValue.length === 0) {
    throw new Error(`Missing value for ${fieldConfig.label}`);
  }

  if (fieldConfig.type !== "number" && fieldConfig.type !== "integer") {
    return { shouldInclude: true, value: rawValue };
  }

  const numericValue = Number(rawValue);
  if (!Number.isFinite(numericValue)) {
    throw new Error(`Invalid number for ${fieldConfig.label}`);
  }

  if (fieldConfig.type === "integer" && !Number.isInteger(numericValue)) {
    throw new Error(`Invalid integer for ${fieldConfig.label}`);
  }

  return { shouldInclude: true, value: numericValue };
}

function formatJsonOption(value) {
  if (typeof value === "string") {
    return value;
  }

  if (value === null) {
    return "null";
  }

  return JSON.stringify(value);
}

function renderComposerState() {
  const active = Boolean(state.activeTurnId);
  const externalActive = Boolean(state.externalActiveTurnId && !state.activeTurnId);
  const canFollowExternal = Boolean(externalActive && selectedThreadOwner());
  const editing = Boolean(state.editingTurn);
  const hasThread = Boolean(state.selectedThreadId);
  const canEdit = Boolean(selectedThreadOwner() && editableLastTurn(currentThreadState())) && !active && !externalActive;
  dom.stopButton.classList.toggle("hidden", !active && !canFollowExternal);
  dom.activeTurnPill.classList.toggle("hidden", !active && !externalActive);
  dom.activeTurnPill.textContent = active ? "Active turn" : canFollowExternal ? "Following" : "Live elsewhere";
  dom.sendButton.disabled = !editing && externalActive && !canFollowExternal;
  const sendAction = editing
    ? "Save edited turn"
    : active || canFollowExternal
      ? "Steer active turn"
      : externalActive
        ? "Live elsewhere"
        : "Send";
  dom.sendButton.textContent = editing ? "✓" : active || canFollowExternal ? "↗" : externalActive ? "…" : "↑";
  dom.sendButton.title = sendAction;
  dom.sendButton.setAttribute("aria-label", sendAction);
  dom.attachButton.disabled = editing;
  dom.queueButton.classList.toggle("hidden", editing || (!active && !canFollowExternal));
  dom.compactButton.disabled = !hasThread || active || externalActive;
  dom.editLastButton.disabled = !canEdit;
  dom.editLastButton.textContent = editing ? "Editing" : "Edit";
  dom.editLastButton.title = editing ? "Editing last user turn" : "Edit last user turn";
  dom.editLastButton.setAttribute("aria-label", dom.editLastButton.title);
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

function setSecurity(security) {
  if (!security) {
    return;
  }
  state.security = security;
  renderSecurity();
}

function renderSecurity() {
  const security = state.security;
  dom.securityPanel.classList.toggle("hidden", !security);
  if (!security) return;

  const remoteUrl = typeof security.remoteUrl === "string" ? security.remoteUrl : "";
  const lanUrls = Array.isArray(security.lanUrls) ? security.lanUrls : [];
  const sessions = Array.isArray(security.activeSessions) ? security.activeSessions : [];
  const primaryUrl = remoteUrl || lanUrls[0] || security.localUrl || "";

  const title = document.createElement("div");
  title.className = "security-title";
  title.textContent = remoteUrl ? "Cloudflare tunnel" : "Local access";

  const chips = document.createElement("div");
  chips.className = "security-chips";
  chips.append(
    securityChip(`Token ${security.tokenFingerprint || "unknown"}`),
    securityChip(`${sessions.length} ${sessions.length === 1 ? "session" : "sessions"}`),
  );
  if (primaryUrl) {
    chips.append(securityChip(shortAccessUrl(primaryUrl)));
  }

  const actions = document.createElement("div");
  actions.className = "security-actions";
  if (primaryUrl) {
    const open = document.createElement("a");
    open.className = "ghost-button";
    open.href = accessUrlWithToken(primaryUrl);
    open.target = "_blank";
    open.rel = "noreferrer";
    open.textContent = remoteUrl ? "Open tunnel" : "Open local";
    actions.append(open);
  }
  const rotate = document.createElement("button");
  rotate.className = "ghost-button";
  rotate.type = "button";
  rotate.textContent = "Rotate token";
  rotate.addEventListener("click", () => {
    void rotateAccessToken();
  });
  actions.append(rotate);

  dom.securityPanel.replaceChildren(title, chips, actions);
}

function securityChip(text) {
  const chip = document.createElement("span");
  chip.className = "security-chip";
  chip.textContent = text;
  return chip;
}

function accessUrlWithToken(baseUrl) {
  const url = new URL(baseUrl);
  url.searchParams.set("token", state.token);
  return url.toString();
}

function shortAccessUrl(value) {
  try {
    return new URL(value).host;
  } catch {
    return value;
  }
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
  const previousOwnedThreadIds = new Set(state.streamOwners.keys());
  let selectedMirrorCleared = false;
  state.streamOwners.clear();
  const ownedThreadIds = new Set();
  for (const entry of entries || []) {
    if (typeof entry?.threadId === "string" && typeof entry.ownerClientId === "string") {
      state.streamOwners.set(entry.threadId, entry.ownerClientId);
      ownedThreadIds.add(entry.threadId);
    }
  }
  for (const threadId of state.mirroredThreads.keys()) {
    if (!ownedThreadIds.has(threadId)) {
      state.mirroredThreads.delete(threadId);
      if (previousOwnedThreadIds.has(threadId)) {
        selectedMirrorCleared = clearSelectedMirrorThread(threadId, "IPC owner disconnected") || selectedMirrorCleared;
      }
    }
  }
  renderThreads();
  renderApprovals();
  if (selectedMirrorCleared) {
    renderSelectedThread({ preserveScroll: true });
    renderIpcStatus();
    return;
  }

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
  renderApprovals();
  renderThreadHeader();
  renderComposerState();
  renderIpcStatus();
}

function clearSelectedMirrorThread(threadId, reason) {
  if (threadId !== state.selectedThreadId) {
    return false;
  }

  const fallbackThread = state.threads.find((thread) => thread.id === threadId) || null;
  state.currentThread = fallbackThread;
  if (!fallbackThread) {
    state.selectedThreadId = null;
  }
  setStatus(reason, true);
  return true;
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
  const turn = findInProgressTurn(currentThreadState());
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

function threadTitle(threadId) {
  const thread = threadId ? state.mirroredThreads.get(threadId) || state.threads.find((item) => item.id === threadId) : null;
  return thread?.name || thread?.title || thread?.preview || "IPC session";
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

function deriveConversationStatus(thread) {
  if (findInProgressTurn(thread)) {
    return { type: "running" };
  }

  if (thread?.resumeState === "needs_resume") {
    return { type: "needs_resume" };
  }

  return { type: "idle" };
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

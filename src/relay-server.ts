import { randomBytes } from "node:crypto";
import { buildGitHubAuthorizeRequest, buildGitHubWebTokenBody } from "./github-oauth";
import { isRelayTlsDomainAllowed, slugFromRelayHostname } from "./relay-host";
import { decodeRelayFrame, encodeRelayFrame, type RelayFrame } from "./relay-protocol";
import { readRelayState, writeRelayState } from "./relay-store";
import type { GitHubIdentity, RelayDispatcherSession } from "./relay-state";

type DispatcherWsData = {
  kind: "dispatcher";
  session: RelayDispatcherSession | null;
  acceptedFrame: RelayFrame;
};

type PendingRequest = {
  controller: ReadableStreamDefaultController<Uint8Array> | null;
  closed: boolean;
  resolve: (response: Response) => void;
  reject: (error: Error) => void;
};

type PendingOAuth = {
  codeVerifier: string;
  returnTo: string;
  createdAt: number;
};

const relayPort = Number(process.env.PORT ?? "8788");
const relayHost = process.env.HOST ?? "0.0.0.0";
const relayHttpIdleTimeoutSeconds = 60;
const publicBaseUrl = requiredEnv("RELAY_PUBLIC_BASE_URL");
const relayDataPath = requiredEnv("RELAY_DATA_PATH");
const githubClientId = requiredEnv("GITHUB_CLIENT_ID");
const githubClientSecret = requiredEnv("GITHUB_CLIENT_SECRET");
const publicBase = new URL(publicBaseUrl);
const state = readRelayState(relayDataPath);
const pendingOAuthByState = new Map<string, PendingOAuth>();
const dispatcherSocketsBySessionId = new Map<string, Bun.ServerWebSocket<DispatcherWsData>>();
const pendingRequestsById = new Map<string, PendingRequest>();

const relayServer = Bun.serve<DispatcherWsData>({
  port: relayPort,
  hostname: relayHost,
  idleTimeout: relayHttpIdleTimeoutSeconds,
  async fetch(request, server) {
    const url = new URL(request.url);

    if (url.pathname === "/api/cli/login" && request.method === "POST") {
      return handleCliLogin(request);
    }

    if (url.pathname === "/api/oauth/github/client" && request.method === "GET") {
      return jsonResponse({ clientId: githubClientId });
    }

    if (url.pathname === "/api/tls/ask" && request.method === "GET") {
      return handleTlsAsk(url);
    }

    if (url.pathname === "/api/dispatcher/connect") {
      return handleDispatcherConnect(request, url, server);
    }

    if (url.pathname === "/auth/github/start" && request.method === "GET") {
      return handleBrowserLoginStart(url);
    }

    if (url.pathname === "/auth/github/callback" && request.method === "GET") {
      return handleBrowserLoginCallback(request, url);
    }

    return proxyBrowserRequest(request, url);
  },
  websocket: {
    open(ws) {
      ws.send(encodeRelayFrame(ws.data.acceptedFrame));
      if (ws.data.session) {
        dispatcherSocketsBySessionId.set(ws.data.session.id, ws);
      } else {
        ws.close();
      }
    },
    close(ws) {
      const session = ws.data.session;
      if (!session) {
        return;
      }
      dispatcherSocketsBySessionId.delete(session.id);
      state.disconnectDispatcher(session.userId, session.id);
    },
    message(_ws, raw) {
      handleDispatcherFrame(raw.toString());
    },
  },
});

console.log(`codex-dispatcher relay listening on ${relayServer.url.toString()}`);

async function handleCliLogin(request: Request): Promise<Response> {
  const body = await request.json() as unknown;
  if (!isRecord(body) || typeof body.githubToken !== "string" || body.githubToken.length === 0) {
    return jsonResponse({ error: "githubToken is required" }, 400);
  }

  const githubUser = await fetchGitHubUser(body.githubToken);
  const user = state.upsertGitHubUser(githubUser, Date.now());
  const device = state.createDevice(user.id, Date.now(), secureToken);
  persistRelayState();
  return jsonResponse({
    relay: {
      url: publicBaseUrl,
      userId: user.id,
      githubLogin: user.githubLogin,
      slug: user.slug,
      deviceId: device.id,
      token: device.token,
    },
    stableUrl: stableUrlForSlug(user.slug),
  });
}

function handleTlsAsk(url: URL): Response {
  const domain = url.searchParams.get("domain") ?? "";
  const allowed = isRelayTlsDomainAllowed(domain, publicBase.hostname, (slug) => state.userForSlug(slug) !== null);
  return allowed ? new Response("ok") : new Response("Unknown relay domain.", { status: 404 });
}

function handleDispatcherConnect(
  request: Request,
  url: URL,
  server: Bun.Server<DispatcherWsData>,
): Response | undefined {
  const token = url.searchParams.get("token") ?? "";
  const device = state.authenticateDevice(token, Date.now());
  if (!device) {
    return new Response("Unauthorized", { status: 401 });
  }
  persistRelayState();

  const result = state.connectDispatcher({
    sessionId: `dsp_${secureToken()}`,
    userId: device.userId,
    deviceId: device.id,
    now: Date.now(),
    killExisting: url.searchParams.get("killExisting") === "1",
  });
  const user = state.userForId(device.userId);
  if (!user) {
    return new Response("Unauthorized", { status: 401 });
  }

  const acceptedFrame: RelayFrame = result.ok
    ? {
        type: "dispatcher-accepted",
        stableUrl: stableUrlForSlug(user.slug),
        killedSessionId: result.killedSessionId,
      }
    : {
        type: "dispatcher-rejected",
        code: result.error.code,
        message: "Another dispatcher is already active for this GitHub user.",
      };
  if (result.ok && result.killedSessionId) {
    dispatcherSocketsBySessionId.get(result.killedSessionId)?.close();
    dispatcherSocketsBySessionId.delete(result.killedSessionId);
  }

  if (server.upgrade(request, {
    data: {
      kind: "dispatcher",
      session: result.ok ? result.session : null,
      acceptedFrame,
    },
  })) {
    return undefined;
  }

  return new Response("WebSocket upgrade failed", { status: 400 });
}

function handleBrowserLoginStart(url: URL): Response {
  const returnTo = safeReturnPath(url.searchParams.get("returnTo") ?? "/");
  const auth = buildGitHubAuthorizeRequest({
    clientId: githubClientId,
    redirectUri: new URL("/auth/github/callback", publicBaseUrl).toString(),
  });
  pendingOAuthByState.set(auth.state, {
    codeVerifier: auth.codeVerifier,
    returnTo,
    createdAt: Date.now(),
  });
  return redirectResponse(auth.url, {
    "set-cookie": cookie("codex_dispatcher_oauth_state", auth.state, 900),
  });
}

async function handleBrowserLoginCallback(request: Request, url: URL): Promise<Response> {
  const stateParam = url.searchParams.get("state") ?? "";
  const code = url.searchParams.get("code") ?? "";
  const cookieState = cookieValue(request.headers.get("cookie"), "codex_dispatcher_oauth_state");
  const pending = pendingOAuthByState.get(stateParam);
  pendingOAuthByState.delete(stateParam);

  if (!pending || !code || cookieState !== stateParam) {
    return new Response("Invalid GitHub login state.", { status: 400 });
  }

  const token = await exchangeGitHubCode(code, pending.codeVerifier);
  const githubUser = await fetchGitHubUser(token);
  const user = state.upsertGitHubUser(githubUser, Date.now());
  const session = state.createBrowserSession(user.id, Date.now(), secureToken);
  persistRelayState();
  return redirectResponse(stableUrlForSlug(user.slug, pending.returnTo), {
    "set-cookie": [
      cookie("codex_dispatcher_session", session.token, 60 * 60 * 24 * 30),
      expiredCookie("codex_dispatcher_oauth_state"),
    ],
  });
}

async function proxyBrowserRequest(request: Request, url: URL): Promise<Response> {
  const slug = slugFromHost(url.hostname);
  if (!slug) {
    return new Response("Unknown dispatcher URL.", { status: 404 });
  }

  const user = state.userForSlug(slug);
  if (!user) {
    return new Response("Unknown dispatcher user.", { status: 404 });
  }

  const browserToken = cookieValue(request.headers.get("cookie"), "codex_dispatcher_session");
  const browserUser = browserToken ? state.authenticateBrowserSession(browserToken, Date.now()) : null;
  if (browserToken && !browserUser) {
    persistRelayState();
  }
  if (!browserToken || browserUser?.id !== user.id) {
    const loginUrl = new URL("/auth/github/start", publicBaseUrl);
    loginUrl.searchParams.set("returnTo", `${url.pathname}${url.search}`);
    return redirectResponse(loginUrl.toString());
  }

  const dispatcher = state.activeDispatcherForSlug(slug);
  if (!dispatcher) {
    return new Response("Dispatcher is offline.", { status: 503 });
  }
  const ws = dispatcherSocketsBySessionId.get(dispatcher.id);
  if (!ws) {
    return new Response("Dispatcher connection is unavailable.", { status: 503 });
  }

  return proxyThroughDispatcher(request, url, ws);
}

async function proxyThroughDispatcher(
  request: Request,
  url: URL,
  ws: Bun.ServerWebSocket<DispatcherWsData>,
): Promise<Response> {
  const requestId = `req_${secureToken()}`;
  const bodyBase64 = request.method === "GET" || request.method === "HEAD"
    ? null
    : Buffer.from(await request.arrayBuffer()).toString("base64");

  const responsePromise = new Promise<Response>((resolve, reject) => {
    const startTimeout = setTimeout(() => {
      pendingRequestsById.delete(requestId);
      resolve(new Response("Dispatcher response timed out.", { status: 504 }));
    }, 30_000);
    pendingRequestsById.set(requestId, {
      controller: null,
      closed: false,
      resolve: (response) => {
        clearTimeout(startTimeout);
        resolve(response);
      },
      reject: (error) => {
        clearTimeout(startTimeout);
        reject(error);
      },
    });
  });

  ws.send(encodeRelayFrame({
    type: "http-request",
    requestId,
    method: request.method,
    path: `${url.pathname}${url.search}`,
    headers: Array.from(request.headers.entries()),
    bodyBase64,
  }));

  return responsePromise;
}

function handleDispatcherFrame(raw: string): void {
  const frame = decodeRelayFrame(raw);
  switch (frame.type) {
    case "http-response-start": {
      const pending = pendingRequestsById.get(frame.requestId);
      if (!pending) {
        return;
      }
      pending.resolve(new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          pending.controller = controller;
        },
        cancel() {
          pending.closed = true;
          pendingRequestsById.delete(frame.requestId);
        },
      }), {
        status: frame.status,
        headers: frame.headers,
      }));
      return;
    }
    case "http-response-chunk": {
      const pending = pendingRequestsById.get(frame.requestId);
      if (!pending?.controller || pending.closed) {
        return;
      }
      try {
        pending.controller.enqueue(Buffer.from(frame.bodyBase64, "base64"));
      } catch {
        pending.closed = true;
        pendingRequestsById.delete(frame.requestId);
      }
      return;
    }
    case "http-response-end": {
      const pending = pendingRequestsById.get(frame.requestId);
      if (!pending?.controller || pending.closed) {
        return;
      }
      pendingRequestsById.delete(frame.requestId);
      pending.closed = true;
      try {
        pending.controller.close();
      } catch {
        return;
      }
      return;
    }
    case "http-response-error": {
      const pending = pendingRequestsById.get(frame.requestId);
      if (!pending) {
        return;
      }
      pendingRequestsById.delete(frame.requestId);
      pending.closed = true;
      pending.reject(new Error(frame.error));
      return;
    }
    case "dispatcher-heartbeat":
      return;
    default:
      return;
  }
}

async function fetchGitHubUser(token: string): Promise<GitHubIdentity> {
  const response = await fetch("https://api.github.com/user", {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "user-agent": "codex-dispatcher-relay",
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub user request failed: ${response.status}`);
  }
  const body = await response.json() as unknown;
  if (!isRecord(body) || typeof body.id !== "number" || typeof body.login !== "string") {
    throw new Error("GitHub user response did not include id/login.");
  }
  return {
    id: body.id,
    login: body.login,
  };
}

async function exchangeGitHubCode(code: string, codeVerifier: string): Promise<string> {
  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: buildGitHubWebTokenBody({
      clientId: githubClientId,
      clientSecret: githubClientSecret,
      code,
      redirectUri: new URL("/auth/github/callback", publicBaseUrl).toString(),
      codeVerifier,
    }),
  });
  if (!response.ok) {
    throw new Error(`GitHub token exchange failed: ${response.status}`);
  }
  const body = await response.json() as unknown;
  if (!isRecord(body) || typeof body.access_token !== "string") {
    throw new Error("GitHub token exchange did not return an access token.");
  }
  return body.access_token;
}

function stableUrlForSlug(slug: string, path = "/"): string {
  const url = new URL(publicBaseUrl);
  url.hostname = `${slug}.${url.hostname}`;
  return new URL(path.startsWith("/") ? path : "/", url).toString();
}

function slugFromHost(hostname: string): string | null {
  return slugFromRelayHostname(hostname, publicBase.hostname);
}

function safeReturnPath(value: string): string {
  return value.startsWith("/") && !value.startsWith("//") ? value : "/";
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function redirectResponse(location: string, headers?: Record<string, string | string[]>): Response {
  const responseHeaders = new Headers({ location });
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (Array.isArray(value)) {
      for (const entry of value) {
        responseHeaders.append(key, entry);
      }
    } else {
      responseHeaders.append(key, value);
    }
  }
  return new Response(null, { status: 302, headers: responseHeaders });
}

function cookie(name: string, value: string, maxAgeSeconds: number): string {
  const domain = publicBase.hostname.includes(".") ? `; Domain=.${publicBase.hostname}` : "";
  const secure = publicBase.protocol === "https:" ? "; Secure" : "";
  return `${name}=${encodeURIComponent(value)}; Max-Age=${maxAgeSeconds}; Path=/; HttpOnly; SameSite=Lax${secure}${domain}`;
}

function expiredCookie(name: string): string {
  const domain = publicBase.hostname.includes(".") ? `; Domain=.${publicBase.hostname}` : "";
  const secure = publicBase.protocol === "https:" ? "; Secure" : "";
  return `${name}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax${secure}${domain}`;
}

function cookieValue(header: string | null, name: string): string | null {
  if (!header) {
    return null;
  }
  for (const part of header.split(";")) {
    const [rawKey, ...rawValue] = part.trim().split("=");
    if (rawKey === name) {
      return decodeURIComponent(rawValue.join("="));
    }
  }
  return null;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function persistRelayState(): void {
  writeRelayState(relayDataPath, state);
}

function secureToken(): string {
  return randomBytes(24).toString("base64url");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

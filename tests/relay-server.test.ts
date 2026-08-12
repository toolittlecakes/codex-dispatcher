import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeRelayFrame, encodeRelayFrame, type RelayFrame } from "../src/relay-protocol";

const baseHostname = "codex-dispatcher.test";
const browserSessionToken = "browser-token";
const dispatcherToken = "device-token";
const otherDispatcherToken = "other-device-token";
const tempDirs: string[] = [];

afterEach(() => {
  for (const path of tempDirs.splice(0)) {
    rmSync(path, { force: true, recursive: true });
  }
});

describe("relay server", () => {
  test("keeps running when a canceled browser stream receives late dispatcher chunks", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-dispatcher-relay-"));
    tempDirs.push(dir);
    const statePath = join(dir, "state.json");
    writeFileSync(statePath, JSON.stringify(relayStateSnapshot(), null, 2));

    const relay = Bun.spawn([process.execPath, "run", "src/relay-server.ts"], {
      cwd: process.cwd(),
      env: {
        ...Bun.env,
        GITHUB_CLIENT_ID: "test-client",
        GITHUB_CLIENT_SECRET: "test-secret",
        HOST: "127.0.0.1",
        PORT: "0",
        RELAY_DATA_PATH: statePath,
        RELAY_PUBLIC_BASE_URL: `http://${baseHostname}`,
      },
      stderr: "pipe",
      stdout: "pipe",
    });

    try {
      const relayUrl = await waitForRelayUrl(relay);
      const ws = new WebSocket(new URL(`/api/dispatcher/connect?token=${dispatcherToken}`, relayUrl));
      const accepted = await waitForFrame(ws);
      expect(accepted.type).toBe("dispatcher-accepted");

      let requestId = "";
      const cancelFramePromise = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("relay did not cancel browser request")), 5_000);
        ws.addEventListener("message", (event) => {
          const frame = decodeRelayFrame(String(event.data));
          if (frame.type !== "http-request-cancel" || frame.requestId !== requestId) {
            return;
          }
          clearTimeout(timeout);
          resolve();
        });
      });
      const requestFramePromise = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("relay did not proxy browser request")), 5_000);
        ws.addEventListener("message", (event) => {
          const frame = decodeRelayFrame(String(event.data));
          if (frame.type !== "http-request") {
            return;
          }
          clearTimeout(timeout);
          requestId = frame.requestId;
          ws.send(encodeRelayFrame({
            type: "http-response-start",
            requestId,
            status: 200,
            headers: [["content-type", "text/plain"]],
          }));
          ws.send(encodeRelayFrame({
            type: "http-response-chunk",
            requestId,
            bodyBase64: Buffer.from("first").toString("base64"),
          }));
          resolve();
        });
      });

      const browserClosed = closeRawHttpStreamAfterFirstChunk(new URL(relayUrl), "/stream");
      await requestFramePromise;
      await browserClosed;
      await cancelFramePromise;

      ws.send(encodeRelayFrame({
        type: "http-response-chunk",
        requestId,
        bodyBase64: Buffer.from("late").toString("base64"),
      }));
      ws.send(encodeRelayFrame({ type: "http-response-end", requestId }));

      const exitCode = await Promise.race([relay.exited, sleep(200).then(() => null)]);
      expect(exitCode).toBeNull();
      ws.close();
    } finally {
      relay.kill();
      await relay.exited.catch(() => undefined);
    }
  });

  test("terminates the browser stream when the dispatcher fails mid-response", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-dispatcher-relay-"));
    tempDirs.push(dir);
    const statePath = join(dir, "state.json");
    writeFileSync(statePath, JSON.stringify(relayStateSnapshot(), null, 2));

    const relay = Bun.spawn([process.execPath, "run", "src/relay-server.ts"], {
      cwd: process.cwd(),
      env: {
        ...Bun.env,
        GITHUB_CLIENT_ID: "test-client",
        GITHUB_CLIENT_SECRET: "test-secret",
        HOST: "127.0.0.1",
        PORT: "0",
        RELAY_DATA_PATH: statePath,
        RELAY_PUBLIC_BASE_URL: `http://${baseHostname}`,
      },
      stderr: "pipe",
      stdout: "pipe",
    });

    try {
      const relayUrl = await waitForRelayUrl(relay);
      const ws = new WebSocket(new URL(`/api/dispatcher/connect?token=${dispatcherToken}`, relayUrl));
      expect((await waitForFrame(ws)).type).toBe("dispatcher-accepted");

      ws.addEventListener("message", (event) => {
        const frame = decodeRelayFrame(String(event.data));
        if (frame.type !== "http-request") {
          return;
        }
        ws.send(encodeRelayFrame({
          type: "http-response-start",
          requestId: frame.requestId,
          status: 200,
          headers: [["content-type", "text/plain"]],
        }));
        ws.send(encodeRelayFrame({
          type: "http-response-chunk",
          requestId: frame.requestId,
          bodyBase64: Buffer.from("partial").toString("base64"),
        }));
        ws.send(encodeRelayFrame({
          type: "http-response-error",
          requestId: frame.requestId,
          error: "local dispatcher body read failed",
        }));
      });

      const response = await fetch(new URL("/stream", relayUrl), {
        headers: {
          host: `toolittlecakes.${baseHostname}`,
          cookie: `codex_dispatcher_session=${browserSessionToken}`,
        },
      });
      expect(response.status).toBe(200);

      // Before the fix the error frame was dropped once streaming had started, so
      // the browser response stayed open until the client gave up.
      const outcome = await Promise.race([
        response
          .text()
          .then(() => "settled" as const)
          .catch(() => "settled" as const),
        sleep(3_000).then(() => "hung" as const),
      ]);
      expect(outcome).toBe("settled");

      const exitCode = await Promise.race([relay.exited, sleep(200).then(() => null)]);
      expect(exitCode).toBeNull();
      ws.close();
    } finally {
      relay.kill();
      await relay.exited.catch(() => undefined);
    }
  });

  test("ignores response frames for requests owned by another dispatcher session", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-dispatcher-relay-"));
    tempDirs.push(dir);
    const statePath = join(dir, "state.json");
    writeFileSync(statePath, JSON.stringify(relayStateSnapshot(), null, 2));

    const relay = Bun.spawn([process.execPath, "run", "src/relay-server.ts"], {
      cwd: process.cwd(),
      env: {
        ...Bun.env,
        GITHUB_CLIENT_ID: "test-client",
        GITHUB_CLIENT_SECRET: "test-secret",
        HOST: "127.0.0.1",
        PORT: "0",
        RELAY_DATA_PATH: statePath,
        RELAY_PUBLIC_BASE_URL: `http://${baseHostname}`,
      },
      stderr: "pipe",
      stdout: "pipe",
    });

    try {
      const relayUrl = await waitForRelayUrl(relay);
      const owner = new WebSocket(new URL(`/api/dispatcher/connect?token=${dispatcherToken}`, relayUrl));
      expect((await waitForFrame(owner)).type).toBe("dispatcher-accepted");

      // A dispatcher belonging to a different GitHub user, connected at the same time.
      const attacker = new WebSocket(new URL(`/api/dispatcher/connect?token=${otherDispatcherToken}`, relayUrl));
      expect((await waitForFrame(attacker)).type).toBe("dispatcher-accepted");

      const proxiedRequestId = new Promise<string>((resolve) => {
        owner.addEventListener("message", (event) => {
          const frame = decodeRelayFrame(String(event.data));
          if (frame.type === "http-request") {
            resolve(frame.requestId);
          }
        });
      });

      const responsePromise = fetch(new URL("/stream", relayUrl), {
        headers: {
          host: `toolittlecakes.${baseHostname}`,
          cookie: `codex_dispatcher_session=${browserSessionToken}`,
        },
      });
      const requestId = await proxiedRequestId;

      attacker.send(encodeRelayFrame({
        type: "http-response-start",
        requestId,
        status: 200,
        headers: [["content-type", "text/plain"]],
      }));
      attacker.send(encodeRelayFrame({
        type: "http-response-chunk",
        requestId,
        bodyBase64: Buffer.from("forged").toString("base64"),
      }));
      attacker.send(encodeRelayFrame({ type: "http-response-end", requestId }));
      await sleep(150);

      owner.send(encodeRelayFrame({
        type: "http-response-start",
        requestId,
        status: 200,
        headers: [["content-type", "text/plain"]],
      }));
      owner.send(encodeRelayFrame({
        type: "http-response-chunk",
        requestId,
        bodyBase64: Buffer.from("real").toString("base64"),
      }));
      owner.send(encodeRelayFrame({ type: "http-response-end", requestId }));

      const body = await Promise.race([
        responsePromise.then((response) => response.text()).catch(() => "<failed>"),
        sleep(5_000).then(() => "<hung>"),
      ]);
      expect(body).toBe("real");

      const exitCode = await Promise.race([relay.exited, sleep(200).then(() => null)]);
      expect(exitCode).toBeNull();
      owner.close();
      attacker.close();
    } finally {
      relay.kill();
      await relay.exited.catch(() => undefined);
    }
  });

  test("lets an anonymous browser read the PWA install metadata it never sends cookies for", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-dispatcher-relay-"));
    tempDirs.push(dir);
    const statePath = join(dir, "state.json");
    writeFileSync(statePath, JSON.stringify(relayStateSnapshot(), null, 2));

    const relay = Bun.spawn([process.execPath, "run", "src/relay-server.ts"], {
      cwd: process.cwd(),
      env: {
        ...Bun.env,
        GITHUB_CLIENT_ID: "test-client",
        GITHUB_CLIENT_SECRET: "test-secret",
        HOST: "127.0.0.1",
        PORT: "0",
        RELAY_DATA_PATH: statePath,
        RELAY_PUBLIC_BASE_URL: `http://${baseHostname}`,
      },
      stderr: "pipe",
      stdout: "pipe",
    });

    try {
      const relayUrl = await waitForRelayUrl(relay);
      const dispatcher = new WebSocket(new URL(`/api/dispatcher/connect?token=${dispatcherToken}`, relayUrl));
      expect((await waitForFrame(dispatcher)).type).toBe("dispatcher-accepted");

      dispatcher.addEventListener("message", (event) => {
        const frame = decodeRelayFrame(String(event.data));
        if (frame.type !== "http-request") {
          return;
        }
        dispatcher.send(encodeRelayFrame({
          type: "http-response-start",
          requestId: frame.requestId,
          status: 200,
          headers: [["content-type", "application/manifest+json"]],
        }));
        dispatcher.send(encodeRelayFrame({
          type: "http-response-chunk",
          requestId: frame.requestId,
          bodyBase64: Buffer.from(`{"path":"${frame.path}"}`).toString("base64"),
        }));
        dispatcher.send(encodeRelayFrame({ type: "http-response-end", requestId: frame.requestId }));
      });

      // The browser fetches the manifest with credentials omitted, so a login
      // redirect here is what makes a relay URL uninstallable.
      const manifest = await fetch(new URL("/manifest.webmanifest", relayUrl), {
        headers: { host: `toolittlecakes.${baseHostname}` },
        redirect: "manual",
      });
      expect(manifest.status).toBe(200);
      expect(await manifest.text()).toBe('{"path":"/manifest.webmanifest"}');

      const icon = await fetch(new URL("/icon.png", relayUrl), {
        headers: { host: `toolittlecakes.${baseHostname}` },
        redirect: "manual",
      });
      expect(icon.status).toBe(200);

      const page = await fetch(new URL("/", relayUrl), {
        headers: { host: `toolittlecakes.${baseHostname}` },
        redirect: "manual",
      });
      expect(page.status).toBe(302);
      expect(page.headers.get("location")).toContain("/auth/github/start");

      dispatcher.close();
    } finally {
      relay.kill();
      await relay.exited.catch(() => undefined);
    }
  });
});

function relayStateSnapshot(): unknown {
  return {
    version: 1,
    nextUserOrdinal: 3,
    nextDeviceOrdinal: 3,
    users: [{
      id: "usr_1",
      githubId: 1001,
      githubLogin: "ToolittleCakes",
      slug: "toolittlecakes",
      createdAt: 1,
      updatedAt: 1,
    }, {
      id: "usr_2",
      githubId: 1002,
      githubLogin: "OtherUser",
      slug: "otheruser",
      createdAt: 1,
      updatedAt: 1,
    }],
    browserSessions: [{
      token: browserSessionToken,
      userId: "usr_1",
      createdAt: 1,
      expiresAt: Date.now() + 60_000,
    }],
    devices: [{
      id: "dev_1",
      userId: "usr_1",
      token: dispatcherToken,
      createdAt: 1,
      lastLoginAt: 1,
    }, {
      id: "dev_2",
      userId: "usr_2",
      token: otherDispatcherToken,
      createdAt: 1,
      lastLoginAt: 1,
    }],
  };
}

async function closeRawHttpStreamAfterFirstChunk(relayUrl: URL, path: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const port = Number(relayUrl.port);
    const socket = connect(port, relayUrl.hostname);
    let settled = false;
    let received = "";
    const timeout = setTimeout(() => {
      finish(new Error("relay did not stream the first chunk"));
    }, 5_000);

    const finish = (error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      if (error) {
        reject(error);
        return;
      }
      resolve();
    };

    socket.on("connect", () => {
      socket.write([
        `GET ${path} HTTP/1.1`,
        `Host: toolittlecakes.${baseHostname}`,
        `Cookie: codex_dispatcher_session=${browserSessionToken}`,
        "Connection: close",
        "",
        "",
      ].join("\r\n"));
    });
    socket.on("data", (chunk) => {
      received += chunk.toString("utf8");
      if (received.includes("first")) {
        finish();
      }
    });
    socket.on("error", (error) => finish(error));
  });
}

async function waitForRelayUrl(relay: Bun.Subprocess<"pipe", "pipe", "inherit">): Promise<string> {
  const reader = relay.stdout.getReader();
  const decoder = new TextDecoder();
  let output = "";
  const deadline = Date.now() + 5_000;

  while (Date.now() < deadline) {
    const result = await Promise.race([
      reader.read(),
      sleep(100).then(() => null),
    ]);
    if (result === null) {
      continue;
    }
    if (result.done) {
      break;
    }
    output += decoder.decode(result.value);
    const match = output.match(/codex-dispatcher relay listening on (http:\/\/127\.0\.0\.1:\d+\/)/);
    if (match) {
      return match[1];
    }
  }

  throw new Error(`relay did not start: ${output}`);
}

async function waitForFrame(ws: WebSocket): Promise<RelayFrame> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("websocket frame timed out")), 5_000);
    ws.addEventListener("message", (event) => {
      clearTimeout(timeout);
      resolve(decodeRelayFrame(String(event.data)));
    }, { once: true });
    ws.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error("websocket error"));
    }, { once: true });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

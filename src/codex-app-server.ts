import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue | undefined };

export type JsonObject = { [key: string]: JsonValue | undefined };

type RpcId = string | number;

type RpcMessage = JsonObject & {
  id?: RpcId;
  method?: string;
  params?: JsonValue;
  result?: JsonValue;
  error?: JsonValue;
};

export type AppServerRequest = {
  id: RpcId;
  method: string;
  params: JsonValue;
};

export type CodexAppServerEvent =
  | { type: "status"; status: "starting" | "ready" | "exited"; detail?: string }
  | { type: "stderr"; text: string }
  | { type: "notification"; notification: RpcMessage }
  | { type: "serverRequest"; request: AppServerRequest }
  | { type: "serverRequestResolved"; id: string };

type PendingRequest = {
  method: string;
  resolve: (value: JsonValue) => void;
  reject: (error: Error) => void;
};

const desktopCodexPath = "/Applications/Codex.app/Contents/Resources/codex";

export function resolveCodexCliPath(): string {
  const configured = process.env.CODEX_CLI_PATH;
  if (configured && configured.length > 0) {
    return configured;
  }

  if (existsSync(desktopCodexPath)) {
    return desktopCodexPath;
  }

  return "codex";
}

export class CodexAppServer {
  readonly codexCliPath: string;

  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private initializedResult: JsonValue = null;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly serverRequests = new Map<string, AppServerRequest>();
  private readonly listeners = new Set<(event: CodexAppServerEvent) => void>();

  constructor(codexCliPath = resolveCodexCliPath()) {
    this.codexCliPath = codexCliPath;
  }

  get initialized(): JsonValue {
    return this.initializedResult;
  }

  getPendingServerRequests(): AppServerRequest[] {
    return Array.from(this.serverRequests.values());
  }

  getPendingServerRequest(id: string): AppServerRequest | null {
    return this.serverRequests.get(id) ?? null;
  }

  onEvent(listener: (event: CodexAppServerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async start(): Promise<JsonValue> {
    if (this.child) {
      throw new Error("codex app-server is already running");
    }

    this.emit({ type: "status", status: "starting" });
    this.child = spawn(this.codexCliPath, ["app-server"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });

    const lines = createInterface({ input: this.child.stdout });
    lines.on("line", (line) => this.handleLine(line));

    this.child.stderr.on("data", (chunk: Buffer) => {
      this.emit({ type: "stderr", text: chunk.toString("utf8") });
    });

    this.child.on("error", (error) => {
      this.rejectAll(error);
      this.emit({ type: "status", status: "exited", detail: error.message });
    });

    this.child.on("exit", (code, signal) => {
      this.child = null;
      const detail = `codex app-server exited with code ${String(code)} signal ${String(signal)}`;
      this.rejectAll(new Error(detail));
      this.emit({ type: "status", status: "exited", detail });
    });

    this.initializedResult = await this.request("initialize", {
      clientInfo: {
        name: "codex_mobile_dispatcher",
        title: "Codex Mobile Dispatcher",
        version: "0.0.1",
      },
      capabilities: {
        experimentalApi: true,
      },
    });

    this.notify("initialized", {});
    this.emit({ type: "status", status: "ready" });
    return this.initializedResult;
  }

  request(method: string, params: JsonValue = {}): Promise<JsonValue> {
    const id = this.nextId++;
    const key = String(id);

    return new Promise((resolve, reject) => {
      this.pending.set(key, { method, resolve, reject });
      try {
        this.write({ id, method, params });
      } catch (error) {
        this.pending.delete(key);
        reject(toError(error));
      }
    });
  }

  notify(method: string, params: JsonValue = {}): void {
    this.write({ method, params });
  }

  respondToServerRequest(id: string, result: JsonValue): void {
    const request = this.serverRequests.get(id);
    if (!request) {
      throw new Error(`No pending app-server request with id ${id}`);
    }

    this.write({ id: request.id, result });
    this.serverRequests.delete(id);
    this.emit({ type: "serverRequestResolved", id });
  }

  stop(): void {
    if (!this.child) {
      return;
    }

    this.child.kill("SIGTERM");
  }

  private write(message: RpcMessage): void {
    if (!this.child) {
      throw new Error("codex app-server is not running");
    }

    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string): void {
    if (line.trim().length === 0) {
      return;
    }

    let message: RpcMessage;
    try {
      message = JSON.parse(line) as RpcMessage;
    } catch {
      this.emit({ type: "stderr", text: `Unparseable app-server line: ${line}` });
      return;
    }

    const id = typeof message.id === "string" || typeof message.id === "number" ? message.id : null;
    if (typeof message.method === "string" && id !== null) {
      const request = {
        id,
        method: message.method,
        params: message.params ?? {},
      };
      this.serverRequests.set(String(id), request);
      this.emit({ type: "serverRequest", request });
      return;
    }

    if (id !== null && ("result" in message || "error" in message)) {
      this.handleResponse(id, message);
      return;
    }

    if (typeof message.method === "string") {
      this.emit({ type: "notification", notification: message });
      return;
    }

    this.emit({ type: "stderr", text: `Unknown app-server message: ${line}` });
  }

  private handleResponse(id: RpcId, message: RpcMessage): void {
    const key = String(id);
    const pending = this.pending.get(key);
    if (!pending) {
      this.emit({ type: "stderr", text: `Response for unknown request ${key}` });
      return;
    }

    this.pending.delete(key);
    if ("error" in message && message.error !== undefined && message.error !== null) {
      pending.reject(new Error(formatAppServerError(pending.method, message.error)));
      return;
    }

    pending.resolve(message.result ?? null);
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }

  private emit(event: CodexAppServerEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

function formatAppServerError(method: string, error: JsonValue): string {
  if (typeof error === "object" && error !== null && !Array.isArray(error)) {
    const message = error.message;
    if (typeof message === "string") {
      return `${method}: ${message}`;
    }
  }

  return `${method}: ${JSON.stringify(error)}`;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

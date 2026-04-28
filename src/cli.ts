#!/usr/bin/env bun

import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { resolveCodexCliPath } from "./codex-app-server";
import { resolveExtensionWebviewRoot } from "./extension-webview-spike";

type CliCommand = "serve" | "doctor";

type CliOptions = {
  command: CliCommand;
  cwd: string;
  host: string;
  installExtension: boolean;
  port: number | null;
  showHelp: boolean;
  tunnel: "cloudflare" | null;
};

type CommandCheck = {
  ok: boolean;
  detail: string;
};

const defaultPort = 8792;
const extensionId = "openai.chatgpt";
const extensionRoute = "/extension-spike/";
const serverEntry = new URL("./server.ts", import.meta.url).pathname;
const internalServerCommand = "__server";

let shuttingDown = false;
let dispatcher: ChildProcess | null = null;
let tunnel: ChildProcess | null = null;

try {
  if (process.argv[2] === internalServerCommand) {
    await import("./server");
    await new Promise<never>(() => {});
  }

  const options = parseArgs(process.argv.slice(2));
  if (options.showHelp) {
    printHelp();
    process.exit(0);
  }

  if (options.command === "doctor") {
    const ok = await runDoctor(options);
    process.exit(ok ? 0 : 1);
  }

  const webviewRoot = await ensureCodexExtensionWebviewRoot(options.installExtension);
  const port = options.port ?? await findOpenPort(defaultPort);
  const token = randomBytes(18).toString("base64url");
  const localTarget = `http://localhost:${port}`;

  console.log(`Codex extension webview: ${webviewRoot}`);

  const tunnelStart = options.tunnel === "cloudflare"
    ? await startCloudflareTunnel(localTarget)
    : null;
  tunnel = tunnelStart?.child ?? null;
  dispatcher = await startDispatcher({
    cwd: options.cwd,
    host: options.host,
    port,
    remoteUrl: tunnelStart?.url ?? null,
    token,
  });

  console.log("");
  console.log(`Local:  ${extensionUrl(localTarget, token)}`);
  if (tunnelStart) {
    console.log(`Phone:  ${extensionUrl(tunnelStart.url, token)}`);
  } else {
    console.log("Phone:  tunnel disabled; use the Local URL from this machine only");
  }
  console.log("");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  shutdown(1);
}

process.once("SIGINT", () => shutdown(0));
process.once("SIGTERM", () => shutdown(0));

await new Promise<never>(() => {});

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    command: "serve",
    cwd: process.cwd(),
    host: "0.0.0.0",
    installExtension: true,
    port: null,
    showHelp: false,
    tunnel: "cloudflare",
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) {
      continue;
    }
    if (arg === "serve" || arg === "doctor") {
      options.command = arg;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      options.showHelp = true;
      continue;
    }
    if (arg === "--no-tunnel") {
      options.tunnel = null;
      continue;
    }
    if (arg === "--no-install-extension") {
      options.installExtension = false;
      continue;
    }
    if (arg === "--tunnel") {
      const value = args[index + 1];
      if (value !== "cloudflare") {
        throw new Error("Only --tunnel cloudflare is supported.");
      }
      options.tunnel = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--tunnel=")) {
      const value = arg.slice("--tunnel=".length);
      if (value !== "cloudflare") {
        throw new Error("Only --tunnel=cloudflare is supported.");
      }
      options.tunnel = value;
      continue;
    }
    if (arg === "--port") {
      options.port = parsePort(args[index + 1]);
      index += 1;
      continue;
    }
    if (arg.startsWith("--port=")) {
      options.port = parsePort(arg.slice("--port=".length));
      continue;
    }
    if (arg === "--host") {
      options.host = requireNextArg(args, index, "--host");
      index += 1;
      continue;
    }
    if (arg.startsWith("--host=")) {
      options.host = arg.slice("--host=".length);
      continue;
    }
    if (arg === "--cwd") {
      options.cwd = resolve(requireNextArg(args, index, "--cwd"));
      index += 1;
      continue;
    }
    if (arg.startsWith("--cwd=")) {
      options.cwd = resolve(arg.slice("--cwd=".length));
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function printHelp(): void {
  console.log(`codex-dispatcher

Runs the Codex VS Code extension webview against the local codex app-server and prints a phone URL.

Usage:
  codex-dispatcher [serve] [options]
  codex-dispatcher doctor [options]

Options:
  --port <port>              Port to bind. Defaults to the first free port from ${defaultPort}.
  --host <host>              Host to bind. Defaults to 0.0.0.0.
  --cwd <path>               Project cwd passed to Codex. Defaults to the current directory.
  --tunnel cloudflare        Start a Cloudflare quick tunnel. This is the default.
  --no-tunnel                Only print the local URL.
  --no-install-extension     Fail if the Codex VS Code extension webview is not installed.
  -h, --help                 Show this help.
`);
}

async function runDoctor(options: CliOptions): Promise<boolean> {
  const checks: { label: string; ok: boolean; detail: string }[] = [];

  checks.push({
    label: "Bun runtime",
    ok: true,
    detail: process.execPath,
  });

  const codexCliPath = resolveCodexCliPath();
  checks.push(await checkExecutable("Codex CLI", codexCliPath, ["--version"]));

  const webviewRoot = resolveExtensionWebviewRoot();
  const codeCli = await checkExecutable("VS Code CLI", "code", ["--version"]);
  checks.push({
    label: "Codex VS Code extension webview",
    ok: webviewRoot !== null || (options.installExtension && codeCli.ok),
    detail: webviewRoot ?? (
      options.installExtension && codeCli.ok
        ? `not installed yet; serve will install ${extensionId}`
        : "not found; install the extension or set CODEX_EXTENSION_WEBVIEW_ROOT"
    ),
  });
  checks.push(codeCli);

  if (options.tunnel === "cloudflare") {
    checks.push(await checkExecutable("cloudflared", process.env.CLOUDFLARED_PATH ?? "cloudflared", ["--version"]));
  } else {
    checks.push({
      label: "Tunnel",
      ok: true,
      detail: "disabled by --no-tunnel",
    });
  }

  checks.push({
    label: "Server entry",
    ok: canStartServerProcess(),
    detail: existsSync(serverEntry) ? serverEntry : "bundled into executable",
  });

  console.log("codex-dispatcher doctor");
  for (const check of checks) {
    console.log(`${check.ok ? "OK" : "FAIL"}  ${check.label}: ${check.detail}`);
  }

  return checks.every((check) => check.ok);
}

async function checkExecutable(label: string, command: string, args: string[]): Promise<{ label: string; ok: boolean; detail: string }> {
  const result = command.includes("/") && !existsSync(command)
    ? { ok: false, detail: `${command} was not found` }
    : await canRun(command, args);
  if (result.ok) {
    return { label, ok: true, detail: result.detail || command };
  }
  return { label, ok: false, detail: result.detail || `${command} was not found` };
}

async function ensureCodexExtensionWebviewRoot(installMissing: boolean): Promise<string> {
  const existing = resolveExtensionWebviewRoot();
  if (existing) {
    return existing;
  }

  if (!installMissing) {
    throw new Error(
      "Codex VS Code extension webview was not found. Install the extension or set CODEX_EXTENSION_WEBVIEW_ROOT.",
    );
  }

  console.log(`Codex VS Code extension was not found. Installing ${extensionId} with the VS Code CLI...`);
  await runCommand("code", ["--install-extension", extensionId]);

  const installed = resolveExtensionWebviewRoot();
  if (!installed) {
    throw new Error(
      "VS Code reported extension installation finished, but Codex webview assets were not found. Set CODEX_EXTENSION_WEBVIEW_ROOT to the extension webview directory.",
    );
  }
  return installed;
}

function runCommand(command: string, args: string[]): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("error", (error) => reject(error));
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} failed: code=${String(code)} signal=${String(signal)}`));
    });
  }).catch((error) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new Error(
        "VS Code CLI `code` was not found. Install the VS Code shell command or set CODEX_EXTENSION_WEBVIEW_ROOT.",
      );
    }
    throw error;
  });
}

function canRun(command: string, args: string[]): Promise<CommandCheck> {
  return new Promise<CommandCheck>((resolveCheck) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const remember = (chunk: Buffer) => {
      output += chunk.toString("utf8");
    };

    child.stdout.on("data", remember);
    child.stderr.on("data", remember);
    child.on("error", (error) => {
      resolveCheck({ ok: false, detail: error.message });
    });
    child.on("exit", (code) => {
      if (code === 0) {
        resolveCheck({ ok: true, detail: firstOutputLine(output) || command });
        return;
      }
      resolveCheck({ ok: false, detail: firstOutputLine(output) || `${command} exited with code ${String(code)}` });
    });
  });
}

function startDispatcher(options: {
  cwd: string;
  host: string;
  port: number;
  remoteUrl: string | null;
  token: string;
}): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const launch = serverLaunchCommand();
    const child = spawn(launch.command, launch.args, {
      stdio: ["inherit", "pipe", "pipe"],
      env: {
        ...process.env,
        CODEX_DISPATCHER_CWD: options.cwd,
        DISPATCHER_TOKEN: options.token,
        HOST: options.host,
        PORT: String(options.port),
        ...(options.remoteUrl ? { DISPATCHER_REMOTE_URL: options.remoteUrl } : {}),
      },
    });

    let ready = false;
    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      process.stdout.write(prefixLines("dispatcher", text));
      if (!ready && text.includes("Codex dispatcher listening")) {
        ready = true;
        resolve(child);
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      process.stderr.write(prefixLines("dispatcher", chunk.toString("utf8")));
    });

    child.on("error", (error) => {
      if (!ready) {
        reject(error);
        return;
      }
      shutdown(1);
    });

    child.on("exit", (code, signal) => {
      if (!ready) {
        reject(new Error(`dispatcher exited before ready: code=${String(code)} signal=${String(signal)}`));
        return;
      }
      if (!shuttingDown) {
        console.error(`dispatcher exited: code=${String(code)} signal=${String(signal)}`);
        shutdown(typeof code === "number" ? code : 1);
      }
    });
  });
}

function serverLaunchCommand(): { command: string; args: string[] } {
  if (existsSync(serverEntry)) {
    return { command: process.execPath, args: ["run", serverEntry] };
  }
  if (isBundledServerEntry()) {
    return { command: process.execPath, args: [internalServerCommand] };
  }
  throw new Error(`Server entry was not found: ${serverEntry}`);
}

function canStartServerProcess(): boolean {
  return existsSync(serverEntry) || isBundledServerEntry();
}

function isBundledServerEntry(): boolean {
  return serverEntry.startsWith("/$bunfs/");
}

function startCloudflareTunnel(localTarget: string): Promise<{ child: ChildProcess; url: string }> {
  const cloudflaredPath = process.env.CLOUDFLARED_PATH ?? "cloudflared";
  return new Promise<{ child: ChildProcess; url: string }>((resolve, reject) => {
    const child = spawn(cloudflaredPath, ["--no-autoupdate", "tunnel", "--url", localTarget], {
      stdio: ["inherit", "pipe", "pipe"],
      env: process.env,
    });

    let ready = false;
    const handleOutput = (chunk: Buffer, stream: NodeJS.WriteStream) => {
      const text = chunk.toString("utf8");
      stream.write(prefixLines("cloudflared", text));
      const url = findTryCloudflareUrl(text);
      if (!ready && url) {
        ready = true;
        resolve({ child, url });
      }
    };

    child.stdout.on("data", (chunk: Buffer) => handleOutput(chunk, process.stdout));
    child.stderr.on("data", (chunk: Buffer) => handleOutput(chunk, process.stderr));

    child.on("error", (error) => reject(error));
    child.on("exit", (code, signal) => {
      if (!ready) {
        reject(new Error(`cloudflared exited before tunnel URL: code=${String(code)} signal=${String(signal)}`));
        return;
      }
      if (!shuttingDown) {
        console.error(`cloudflared exited: code=${String(code)} signal=${String(signal)}`);
        shutdown(typeof code === "number" ? code : 1);
      }
    });
  }).catch((error) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new Error("cloudflared was not found. Install cloudflared or run with --no-tunnel.");
    }
    throw error;
  });
}

function findTryCloudflareUrl(text: string): string | null {
  const match = text.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
  return match?.[0] ?? null;
}

function findOpenPort(startPort: number): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const tryPort = (port: number) => {
      const probe = createServer();
      probe.once("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "EADDRINUSE") {
          tryPort(port + 1);
          return;
        }
        reject(error);
      });
      probe.once("listening", () => {
        probe.close(() => resolvePort(port));
      });
      probe.listen(port, "127.0.0.1");
    };
    tryPort(startPort);
  });
}

function extensionUrl(baseUrl: string, token: string): string {
  return `${baseUrl}${extensionRoute}?token=${encodeURIComponent(token)}`;
}

function parsePort(value: string | undefined): number {
  if (!value) {
    throw new Error("Missing port value.");
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port: ${value}`);
  }
  return port;
}

function requireNextArg(args: string[], index: number, name: string): string {
  const value = args[index + 1];
  if (!value) {
    throw new Error(`Missing value for ${name}.`);
  }
  return value;
}

function prefixLines(prefix: string, text: string): string {
  return text
    .split("\n")
    .map((line, index, lines) => {
      if (line.length === 0 && index === lines.length - 1) {
        return "";
      }
      return `[${prefix}] ${line}`;
    })
    .join("\n");
}

function firstOutputLine(output: string): string | null {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0) ?? null;
}

function shutdown(code: number): never {
  shuttingDown = true;
  tunnel?.kill("SIGTERM");
  dispatcher?.kill("SIGTERM");
  process.exit(code);
}

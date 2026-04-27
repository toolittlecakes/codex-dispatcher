import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";

const port = process.env.PORT ?? "8787";
const host = process.env.HOST ?? "0.0.0.0";
const token = process.env.DISPATCHER_TOKEN ?? randomBytes(18).toString("base64url");
const cloudflaredPath = process.env.CLOUDFLARED_PATH ?? "cloudflared";
const localTarget = `http://localhost:${port}`;

let shuttingDown = false;
let dispatcher: ChildProcess | null = null;
let tunnel: ChildProcess | null = null;

dispatcher = await startDispatcher();
tunnel = await startCloudflareTunnel();

process.once("SIGINT", () => shutdown(0));
process.once("SIGTERM", () => shutdown(0));

await new Promise<never>(() => {});

function startDispatcher(): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["run", "src/server.ts"], {
      stdio: ["inherit", "pipe", "pipe"],
      env: {
        ...process.env,
        PORT: port,
        HOST: host,
        DISPATCHER_TOKEN: token,
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

function startCloudflareTunnel(): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
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
        console.log("");
        console.log(`Remote URL: ${url}/?token=${encodeURIComponent(token)}`);
        console.log(`Local URL:  http://localhost:${port}/?token=${encodeURIComponent(token)}`);
        console.log("");
        resolve(child);
      }
    };

    child.stdout.on("data", (chunk: Buffer) => handleOutput(chunk, process.stdout));
    child.stderr.on("data", (chunk: Buffer) => handleOutput(chunk, process.stderr));

    child.on("error", (error) => {
      reject(error);
    });

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
  });
}

function findTryCloudflareUrl(text: string): string | null {
  const match = text.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
  return match?.[0] ?? null;
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

function shutdown(code: number): never {
  shuttingDown = true;
  tunnel?.kill("SIGTERM");
  dispatcher?.kill("SIGTERM");
  process.exit(code);
}

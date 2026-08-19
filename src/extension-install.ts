import { spawn } from "node:child_process";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dispatcherHome } from "./dispatcher-config";

// The dispatcher only serves the extension's webview assets; the host side is
// re-implemented in this repo and codex itself comes from the user's CLI. So
// installing "the extension" means fetching the vsix straight from the
// marketplace and keeping just its webview directory — no VS Code involved.

export function dispatcherExtensionsDir(): string {
  return join(dispatcherHome(), "extensions");
}

export function marketplaceVsixUrl(version: string, targetPlatform: string): string {
  return "https://marketplace.visualstudio.com/_apis/public/gallery/publishers/openai/vsextensions/chatgpt/"
    + `${version}/vspackage?targetPlatform=${targetPlatform}`;
}

export function vsixTargetPlatform(platform = process.platform, arch = process.arch): string {
  const supported: Record<string, string> = {
    "darwin-arm64": "darwin-arm64",
    "darwin-x64": "darwin-x64",
    "linux-arm64": "linux-arm64",
    "linux-x64": "linux-x64",
    "win32-arm64": "win32-arm64",
    "win32-x64": "win32-x64",
  };
  const target = supported[`${platform}-${arch}`];
  if (!target) {
    throw new Error(`No Codex extension build for ${platform}-${arch}.`);
  }
  return target;
}

export async function installExtensionWebview(
  version: string,
  extensionsDir = dispatcherExtensionsDir(),
): Promise<string> {
  const url = marketplaceVsixUrl(version, vsixTargetPlatform());
  console.log(`Downloading Codex extension ${version} from the VS Code marketplace (~170MB)...`);
  const response = await fetch(url, { signal: AbortSignal.timeout(600_000) });
  if (!response.ok) {
    throw new Error(`Marketplace download failed: ${response.status} for ${url}`);
  }
  // The marketplace serves the vsix with Content-Encoding: gzip, so fetch hands
  // us the zip itself; anything else here means the download is not a vsix.
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    throw new Error("Marketplace download is not a vsix (missing zip signature).");
  }

  const destination = join(extensionsDir, `openai.chatgpt-${version}`);
  const staging = `${destination}.download-${process.pid}`;
  try {
    mkdirSync(staging, { recursive: true });
    const vsixPath = join(staging, "extension.vsix");
    writeFileSync(vsixPath, bytes);
    await unzipWebview(vsixPath, staging);

    const webview = join(staging, "extension", "webview");
    if (!existsSync(join(webview, "index.html"))) {
      throw new Error("Downloaded vsix has no webview/index.html.");
    }
    rmSync(destination, { recursive: true, force: true });
    mkdirSync(destination, { recursive: true });
    renameSync(webview, join(destination, "webview"));
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  return join(destination, "webview");
}

function unzipWebview(vsixPath: string, into: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn("unzip", ["-q", vsixPath, "extension/webview/*", "-d", into], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => reject(error));
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`unzip failed with code ${String(code)}: ${stderr.trim()}`));
    });
  });
}

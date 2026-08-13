import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// A browser grants `crypto.randomUUID` and `crypto.subtle` only to a secure
// context, and the extension's webview reaches for both while it boots. A LAN
// address over plain http is not one — which is exactly the address a phone
// comes in on — so the page dies before it renders anything. TLS is what makes
// that address usable at all.
export type DispatcherCertificate = {
  cert: string;
  key: string;
  path: string;
  fingerprint: string;
};

export function defaultCertificateDirectory(): string {
  return process.env.DISPATCHER_TLS_DIR ?? join(homedir(), ".codex-dispatcher", "tls");
}

export function ensureDispatcherCertificate(directory: string, hosts: string[]): DispatcherCertificate {
  const certPath = join(directory, "cert.pem");
  const keyPath = join(directory, "key.pem");
  const required = subjectAltNames(hosts);

  // The address a laptop hands out changes with the network it is on, and a
  // certificate that does not name the current one is a warning the phone
  // cannot click past.
  if (!certificateIsUsable(certPath, keyPath, required)) {
    mkdirSync(directory, { recursive: true });
    generateCertificate(certPath, keyPath, required);
  }
  // LibreSSL leaves the key's mode to the umask, and unconditionally rather
  // than only for one we just wrote: a key issued before we started doing this
  // is still lying there readable by everyone.
  chmodSync(keyPath, 0o600);

  return {
    cert: readFileSync(certPath, "utf8"),
    key: readFileSync(keyPath, "utf8"),
    path: certPath,
    fingerprint: certificateFingerprint(certPath),
  };
}

export function subjectAltNames(hosts: string[]): string[] {
  const names = ["DNS:localhost", "IP:127.0.0.1", "IP:0:0:0:0:0:0:0:1"];
  for (const host of hosts) {
    const name = isIpAddress(host) ? `IP:${host}` : `DNS:${host}`;
    if (!names.includes(name)) {
      names.push(name);
    }
  }
  return names;
}

export function coversSubjectAltNames(certificateNames: string[], required: string[]): boolean {
  return required.every((name) => certificateNames.includes(name));
}

// Read out of the printed certificate, where the names sit one indented line at
// a time and addresses are spelled `IP Address:` — the request that asked for
// them says `IP:`.
export function parseSubjectAltNames(printedExtension: string): string[] {
  const names: string[] = [];
  for (const part of printedExtension.split(/[\n,]/)) {
    const name = part.trim().replace(/^IP Address:/, "IP:");
    if (name.startsWith("DNS:") || name.startsWith("IP:")) {
      names.push(name);
    }
  }
  return names;
}

// Anything the pair on disk cannot do — missing, expired, truncated by an
// interrupted first run, unreadable by this openssl — means the same thing
// here: it is not what we serve, so issue one that is. A certificate without a
// key that matches it would otherwise fail inside `Bun.serve` on every start,
// which is the wall this is here to avoid.
function certificateIsUsable(certPath: string, keyPath: string, required: string[]): boolean {
  if (opensslStatus(["x509", "-noout", "-checkend", "0", "-in", certPath]) !== 0) {
    return false;
  }

  if (opensslStatus(["pkey", "-noout", "-in", keyPath]) !== 0) {
    return false;
  }

  // `-ext subjectAltName` would be shorter, but the openssl macOS ships is
  // LibreSSL and has no such option: printing the whole certificate is the
  // reading both understand.
  const printed = opensslOutput(["x509", "-noout", "-text", "-in", certPath]);
  return printed !== null && coversSubjectAltNames(parseSubjectAltNames(printed), required);
}

function generateCertificate(certPath: string, keyPath: string, names: string[]): void {
  openssl([
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-sha256",
    // Apple refuses to trust a certificate that outlives 825 days, and the
    // phone is the device that has to accept this one.
    "-days",
    "825",
    "-subj",
    "/CN=codex-dispatcher",
    "-addext",
    `subjectAltName=${names.join(",")}`,
    "-keyout",
    keyPath,
    "-out",
    certPath,
  ]);
}

function certificateFingerprint(certPath: string): string {
  return openssl(["x509", "-noout", "-fingerprint", "-sha256", "-in", certPath]).split("=").slice(1).join("=").trim();
}

function openssl(args: string[]): string {
  const result = spawnSync("openssl", args, { encoding: "utf8" });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`openssl ${args[0]} failed: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

// Inspecting a certificate answers a question; only issuing one has to succeed.
function opensslStatus(args: string[]): number | null {
  return spawnSync("openssl", args, { encoding: "utf8" }).status;
}

function opensslOutput(args: string[]): string | null {
  const result = spawnSync("openssl", args, { encoding: "utf8" });
  return result.status === 0 ? result.stdout : null;
}

function isIpAddress(host: string): boolean {
  return /^[0-9.]+$/.test(host) || host.includes(":");
}

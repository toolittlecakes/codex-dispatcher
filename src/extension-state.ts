import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { JsonObject, JsonValue } from "./codex-app-server";
import { isRecord } from "./shared";

type PersistentExtensionState = {
  globalState: JsonObject;
  persistedAtomState: JsonObject;
  settings: JsonObject;
};

export function extensionStatePath(): string {
  return join(process.env.CODEX_DISPATCHER_HOME ?? join(homedir(), ".codex-dispatcher"), "extension-state.json");
}

// What VS Code keeps for an extension between windows: memento storage, the
// webview's persisted atoms and the shared objects it subscribes to. Owned by
// the host that serves the webview, so two hosts in one process (tests) do not
// write over each other.
export class ExtensionState {
  private readonly globalState = new Map<string, JsonValue>();
  private readonly persistedAtomState = new Map<string, JsonValue>();
  private readonly sharedObjectState = new Map<string, JsonValue>();
  // VS Code spreads settings over three stores because it has three; which one
  // a setting lands in is invisible to the webview, which reads and writes all
  // of them through the same endpoints. So they get one store here, kept apart
  // from the atoms only so that neither can shadow a key of the other.
  private readonly settings = new Map<string, JsonValue>();

  constructor(private readonly path: string) {
    if (!existsSync(path)) {
      return;
    }

    const state = parsePersistentExtensionState(JSON.parse(readFileSync(path, "utf8")) as unknown);
    for (const [key, value] of Object.entries(state.globalState)) {
      this.globalState.set(key, value ?? null);
    }
    for (const [key, value] of Object.entries(state.persistedAtomState)) {
      this.persistedAtomState.set(key, value ?? null);
    }
    for (const [key, value] of Object.entries(state.settings)) {
      this.settings.set(key, value ?? null);
    }
  }

  storedSetting(key: string): JsonValue | undefined {
    return this.settings.get(key);
  }

  storedSettings(): JsonObject {
    return Object.fromEntries(this.settings.entries()) as JsonObject;
  }

  setSetting(key: string, value: JsonValue): void {
    this.settings.set(key, value);
    this.write();
  }

  globalValue(key: string): JsonValue {
    return this.globalState.get(key) ?? null;
  }

  setGlobalValue(key: string, value: JsonValue): void {
    this.globalState.set(key, value);
    this.write();
  }

  persistedAtoms(): JsonObject {
    return Object.fromEntries(this.persistedAtomState.entries()) as JsonObject;
  }

  applyAtomUpdate(message: JsonObject): void {
    if (typeof message.key !== "string") {
      throw new Error("Invalid persisted atom update");
    }

    if (message.deleted === true) {
      this.persistedAtomState.delete(message.key);
    } else {
      this.persistedAtomState.set(message.key, message.value ?? null);
    }
    this.write();
  }

  resetAtoms(): void {
    this.persistedAtomState.clear();
    this.write();
  }

  sharedObjectValue(key: string): JsonValue {
    if (this.sharedObjectState.has(key)) {
      return this.sharedObjectState.get(key) ?? null;
    }

    switch (key) {
      case "host_config":
        return { id: "local", display_name: "Local", kind: "local" };
      case "remote_connections":
      case "remote_control_connections":
        return [];
      case "statsig_default_enable_features":
        return {};
      case "pending_worktrees":
      case "diff_comments":
      case "diff_comments_from_model":
      case "composer_prefill":
        return null;
      default:
        return null;
    }
  }

  setSharedObject(key: string, value: JsonValue): void {
    this.sharedObjectState.set(key, value);
  }

  private write(): void {
    const state: PersistentExtensionState = {
      globalState: Object.fromEntries(this.globalState.entries()) as JsonObject,
      persistedAtomState: this.persistedAtoms(),
      settings: this.storedSettings(),
    };
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  }
}

function parsePersistentExtensionState(value: unknown): PersistentExtensionState {
  if (!isRecord(value)) {
    throw new Error("Invalid codex-dispatcher extension state: expected object.");
  }
  return {
    globalState: optionalStateObject(value.globalState, "globalState"),
    persistedAtomState: optionalStateObject(value.persistedAtomState, "persistedAtomState"),
    settings: optionalStateObject(value.settings, "settings"),
  };
}

function optionalStateObject(value: unknown, key: string): JsonObject {
  if (value === undefined) {
    return {};
  }
  if (!isRecord(value)) {
    throw new Error(`Invalid codex-dispatcher extension state: ${key} must be an object.`);
  }
  return value as JsonObject;
}

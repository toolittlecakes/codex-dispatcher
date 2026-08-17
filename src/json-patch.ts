import type { JsonValue } from "./codex-app-server";

type PatchOp = "add" | "replace" | "remove";
type PathPart = string | number;
type PatchTarget = Record<string, JsonValue> | JsonValue[];

export function applyJsonPatches(base: JsonValue, patches: JsonValue[]): JsonValue {
  let next = cloneJson(base);
  for (const patch of patches) {
    if (!isPlainObject(patch) || typeof patch.op !== "string") {
      throw new Error("Invalid patch object");
    }
    const op = validatePatchOp(patch.op);
    validatePatchValue(patch, op);

    const path = normalizePatchPath(patch.path);
    if (path.length === 0) {
      next = op === "remove" ? null : cloneJson(patch.value ?? null);
      continue;
    }

    const { target, key } = resolvePatchTarget(next, path);
    if (op === "remove") {
      removePatchValue(target, key);
      continue;
    }

    setPatchValue(target, key, cloneJson(patch.value ?? null), op);
  }
  return next;
}

export function isPlainObject(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function cloneJson<T extends JsonValue>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function normalizePatchPath(path: JsonValue | undefined): PathPart[] {
  if (Array.isArray(path)) {
    return path.map(validatePathPart);
  }

  if (typeof path !== "string") {
    throw new Error("Invalid patch path");
  }

  if (path === "") {
    return [];
  }

  if (!path.startsWith("/")) {
    throw new Error("Invalid JSON pointer path");
  }

  return path
    .slice(1)
    .split("/")
    .map((part) => validatePathPart(decodePointerPathPart(part)));
}

function validatePathPart(part: JsonValue): PathPart {
  if (typeof part !== "string" && typeof part !== "number") {
    throw new Error("Invalid patch path part");
  }

  if (typeof part === "number") {
    return part;
  }

  if (part !== "__proto__" && part !== "prototype" && part !== "constructor") {
    return part;
  }

  throw new Error(`Forbidden patch path segment ${part}`);
}

function validatePatchOp(op: string): PatchOp {
  if (op === "add" || op === "replace" || op === "remove") {
    return op;
  }

  throw new Error(`Unsupported patch op ${op}`);
}

function validatePatchValue(patch: Record<string, JsonValue>, op: PatchOp): void {
  if ((op === "add" || op === "replace") && !hasOwn(patch, "value")) {
    throw new Error(`Patch op ${op} requires value`);
  }
}

function decodePointerPathPart(part: string): string {
  if (/~(?![01])/u.test(part)) {
    throw new Error("Invalid JSON pointer escape");
  }

  return part.replace(/~1/g, "/").replace(/~0/g, "~");
}

function resolvePatchTarget(root: JsonValue, path: PathPart[]): { target: PatchTarget; key: PathPart } {
  let target: JsonValue = root;
  for (const part of path.slice(0, -1)) {
    if (!isPlainObject(target) && !Array.isArray(target)) {
      throw new Error("Patch target is not traversable");
    }

    // Array steps go through the same index check as the final one: coercing
    // with Number() would quietly turn "" or "01" into a valid position and
    // patch the wrong element instead of rejecting the path.
    const nextTarget = Array.isArray(target) ? target[parseArrayIndex(part)] : target[String(part)];
    if (nextTarget === undefined) {
      throw new Error("Patch path does not exist");
    }

    target = nextTarget;
  }

  if (!isPlainObject(target) && !Array.isArray(target)) {
    throw new Error("Patch parent is not an object or array");
  }

  const key = path[path.length - 1];
  if (key === undefined) {
    throw new Error("Patch key is missing");
  }

  return { target, key };
}

function setPatchValue(target: PatchTarget, key: PathPart, value: JsonValue, op: PatchOp): void {
  if (!Array.isArray(target)) {
    if (op === "replace" && !hasOwn(target, String(key))) {
      throw new Error("Object replace patch key does not exist");
    }
    target[String(key)] = value;
    return;
  }

  if (key === "-") {
    if (op !== "add") {
      throw new Error("Array '-' patch key is only valid for add");
    }
    target.push(value);
    return;
  }

  const index = parseArrayIndex(key);

  if (op === "add") {
    if (index < 0 || index > target.length) {
      throw new Error("Array add patch index is out of bounds");
    }
    target.splice(index, 0, value);
    return;
  }

  if (index < 0 || index >= target.length) {
    throw new Error("Array replace patch index is out of bounds");
  }
  target[index] = value;
}

function removePatchValue(target: PatchTarget, key: PathPart): void {
  if (Array.isArray(target)) {
    const index = parseArrayIndex(key);
    if (index < 0 || index >= target.length) {
      throw new Error("Array remove patch index is out of bounds");
    }

    target.splice(index, 1);
    return;
  }

  if (!hasOwn(target, String(key))) {
    throw new Error("Object remove patch key does not exist");
  }
  delete target[String(key)];
}

function hasOwn(value: Record<string, JsonValue>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function parseArrayIndex(key: PathPart): number {
  if (typeof key === "number") {
    if (Number.isInteger(key) && key >= 0) {
      return key;
    }
    throw new Error("Array patch key is not a valid index");
  }

  if (/^(0|[1-9]\d*)$/.test(key)) {
    return Number(key);
  }

  throw new Error("Array patch key is not a valid index");
}

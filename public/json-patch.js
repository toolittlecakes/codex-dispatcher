export function applyJsonPatches(base, patches) {
  let next = cloneJson(base);
  for (const patch of patches) {
    if (!isPlainObject(patch) || typeof patch.op !== "string") {
      throw new Error("Invalid patch object");
    }
    validatePatchOp(patch.op);
    validatePatchValue(patch);

    const path = normalizePatchPath(patch.path);
    if (path.length === 0) {
      next = patch.op === "remove" ? null : cloneJson(patch.value);
      continue;
    }

    const { target, key } = resolvePatchTarget(next, path);
    if (patch.op === "remove") {
      removePatchValue(target, key);
      continue;
    }

    setPatchValue(target, key, cloneJson(patch.value), patch.op);
  }
  return next;
}

export function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizePatchPath(path) {
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

function validatePathPart(part) {
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

function validatePatchOp(op) {
  if (op === "add" || op === "replace" || op === "remove") {
    return;
  }

  throw new Error(`Unsupported patch op ${op}`);
}

function validatePatchValue(patch) {
  if ((patch.op === "add" || patch.op === "replace") && !hasOwn(patch, "value")) {
    throw new Error(`Patch op ${patch.op} requires value`);
  }
}

function decodePointerPathPart(part) {
  if (/~(?![01])/u.test(part)) {
    throw new Error("Invalid JSON pointer escape");
  }

  return part.replace(/~1/g, "/").replace(/~0/g, "~");
}

function resolvePatchTarget(root, path) {
  let target = root;
  for (const part of path.slice(0, -1)) {
    if (!isPlainObject(target) && !Array.isArray(target)) {
      throw new Error("Patch target is not traversable");
    }

    const nextTarget = target[part];
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

function setPatchValue(target, key, value, op) {
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

function removePatchValue(target, key) {
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

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function parseArrayIndex(key) {
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

export function applyJsonPatches(base, patches) {
  let next = cloneJson(base);
  for (const patch of patches) {
    if (!isPlainObject(patch) || typeof patch.op !== "string") {
      throw new Error("Invalid patch object");
    }
    validatePatchOp(patch.op);

    const path = normalizePatchPath(patch.path);
    if (path.length === 0) {
      next = patch.op === "remove" ? null : cloneJson(patch.value ?? null);
      continue;
    }

    const { target, key } = resolvePatchTarget(next, path);
    if (patch.op === "remove") {
      removePatchValue(target, key);
      continue;
    }

    setPatchValue(target, key, cloneJson(patch.value ?? null), patch.op);
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

  return path
    .replace(/^\//, "")
    .split("/")
    .map((part) => validatePathPart(part.replace(/~1/g, "/").replace(/~0/g, "~")));
}

function validatePathPart(part) {
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
    target[String(key)] = value;
    return;
  }

  if (key === "-") {
    target.push(value);
    return;
  }

  const index = Number(key);
  if (!Number.isInteger(index)) {
    throw new Error("Array patch key is not an integer");
  }

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
    const index = Number(key);
    if (!Number.isInteger(index)) {
      throw new Error("Array patch key is not an integer");
    }
    if (index < 0 || index >= target.length) {
      throw new Error("Array remove patch index is out of bounds");
    }

    target.splice(index, 1);
    return;
  }

  delete target[String(key)];
}

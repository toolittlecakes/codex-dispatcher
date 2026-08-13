import { parse } from "acorn";
import { readFileSync } from "node:fs";
import type { JsonValue } from "./codex-app-server";

// `get-setting` in the extension answers `stored ?? definition.default`, and the
// webview counts on it: its hook for the *configured* value of a setting reads
// `values[key]` with no fallback of its own, because against a real host that
// value is never missing. So the defaults are the host's to send, and the only
// honest source for them is the table the extension itself reads — which lives
// in the bundle we host, next to the webview we serve. Reading it there instead
// of copying it here keeps the two in step across every version in our range.

export type SettingDefinitions = Map<string, JsonValue | undefined>;

export function readSettingDefinitions(extensionMainPath: string): SettingDefinitions {
  const program = parse(readFileSync(extensionMainPath, "utf8"), { ecmaVersion: "latest", sourceType: "script" });

  const bindings = new Map<string, Node>();
  const tables: Node[] = [];
  walk(program as unknown as Node, (node) => {
    if (node.type === "AssignmentExpression" && node.operator === "=" && node.left?.type === "Identifier") {
      remember(bindings, node.left.name, node.right);
    }
    if (node.type === "VariableDeclarator" && node.id?.type === "Identifier" && node.init) {
      remember(bindings, node.id.name, node.init);
    }
    if (isDefinitionTable(node)) {
      tables.push(node);
    }
  });

  // Minified names change with every extension build, so the table is found by
  // its shape — `[...Object.values(group), ...]` — and a shape that no longer
  // matches exactly one array is a bundle we cannot read, not a bundle to guess
  // about.
  if (tables.length !== 1) {
    throw new Error(`Expected one setting definition table in ${extensionMainPath}, found ${tables.length}`);
  }

  const definitions: SettingDefinitions = new Map();
  for (const group of tables[0]!.elements ?? []) {
    const name = group.argument!.arguments![0]!.name!;
    for (const definition of groupDefinitions(bindings, name)) {
      definitions.set(definition.key, definition.default);
    }
  }
  return definitions;
}

type Node = {
  type: string;
  [key: string]: any;
};

type Definition = { key: string; default: JsonValue | undefined };

function isDefinitionTable(node: Node): boolean {
  const elements: Node[] = node.type === "ArrayExpression" ? node.elements : [];
  // An array of nothing but `Object.values(...)` spreads is a distinctive enough
  // shape that the whole 3 MB bundle holds exactly one of them.
  return elements.length >= 2 && elements.every((element) => objectValuesArgument(element) !== null);
}

function objectValuesArgument(node: Node | null): string | null {
  if (node?.type !== "SpreadElement" || node.argument.type !== "CallExpression") {
    return null;
  }
  const callee = node.argument.callee;
  const isObjectValues = callee.type === "MemberExpression"
    && callee.object.type === "Identifier" && callee.object.name === "Object"
    && callee.property.type === "Identifier" && callee.property.name === "values";
  const argument = node.argument.arguments[0];
  return isObjectValues && node.argument.arguments.length === 1 && argument.type === "Identifier" ? argument.name : null;
}

function groupDefinitions(bindings: Map<string, Node>, name: string): Definition[] {
  const group = binding(bindings, name);
  if (group.type !== "ObjectExpression") {
    throw new Error(`Setting group ${name} is a ${group.type}, not an object`);
  }

  return group.properties.flatMap((property: Node) => {
    if (property.type === "SpreadElement") {
      return spreadDefinitions(bindings, property.argument);
    }
    return [definitionOf(bindings, property.value, new Map())];
  });
}

// One group is not written out setting by setting: it is a definition per
// browser family, mapped over the table of families.
function spreadDefinitions(bindings: Map<string, Node>, spread: Node): Definition[] {
  const source = spread.type === "Identifier" ? binding(bindings, spread.name) : spread;
  if (source.type === "ObjectExpression") {
    return source.properties.map((property: Node) => definitionOf(bindings, property.value, new Map()));
  }
  if (source.type !== "CallExpression") {
    throw new Error(`Spread setting definitions are a ${source.type}, which this reader does not know how to expand`);
  }

  const [mapped, mapper] = source.arguments;
  if (mapper?.type !== "ArrowFunctionExpression" || mapper.params.length !== 2) {
    throw new Error("Expected mapped setting definitions to come from a two-argument mapper");
  }
  const entries = resolve(bindings, mapped, new Map());
  if (!isPlainObject(entries)) {
    throw new Error("Expected mapped setting definitions to be mapped over an object");
  }

  return Object.keys(entries).map((key) => {
    // The mapper names the entry and its key; only the key reaches the setting.
    const locals = new Map<string, unknown>([[mapper.params[1].name, key]]);
    return definitionOf(bindings, mapper.body, locals);
  });
}

function definitionOf(bindings: Map<string, Node>, node: Node, locals: Map<string, unknown>): Definition {
  if (node.type !== "CallExpression" || node.arguments.length !== 1) {
    throw new Error(`Expected a setting definition call, found ${node.type}`);
  }

  const fields = node.arguments[0];
  if (fields.type !== "ObjectExpression") {
    throw new Error("Expected a setting definition to be declared with an object");
  }

  const field = (name: string): Node => {
    const found = fields.properties.find((property: Node) => propertyName(property) === name);
    if (!found) {
      throw new Error(`Setting definition has no ${name}`);
    }
    return found.value;
  };

  const key = resolve(bindings, field("key"), locals);
  if (typeof key !== "string") {
    throw new Error(`Setting key resolved to ${typeof key}, not a string`);
  }
  return { key, default: asJsonValue(resolve(bindings, field("default"), locals), key) };
}

function propertyName(property: Node): string | null {
  if (property.type !== "Property") {
    return null;
  }
  return property.key.type === "Identifier" ? property.key.name : String(property.key.value);
}

// Enough of an evaluator for what a definition is allowed to be: constants,
// references to constants, and the objects and arrays built out of them.
function resolve(bindings: Map<string, Node>, node: Node, locals: Map<string, unknown>): unknown {
  switch (node.type) {
    case "Literal":
      return node.value;
    case "TemplateLiteral":
      return node.quasis
        .map((quasi: Node, index: number) => {
          const expression = node.expressions[index];
          return quasi.value.cooked + (expression ? String(resolve(bindings, expression, locals)) : "");
        })
        .join("");
    case "Identifier":
      if (locals.has(node.name)) {
        return locals.get(node.name);
      }
      if (node.name === "undefined") {
        return undefined;
      }
      return resolve(bindings, binding(bindings, node.name), locals);
    case "UnaryExpression": {
      if (node.operator === "void") {
        return undefined;
      }
      const value = resolve(bindings, node.argument, locals);
      if (node.operator === "!") {
        return !value;
      }
      if (node.operator === "-" && typeof value === "number") {
        return -value;
      }
      throw new Error(`Unsupported operator ${node.operator} in a setting definition`);
    }
    case "ArrayExpression":
      return node.elements.map((element: Node) => resolve(bindings, element, locals));
    case "ObjectExpression":
      return Object.fromEntries(node.properties.map((property: Node) => {
        const name = propertyName(property);
        if (name === null) {
          throw new Error("Unsupported spread inside a setting definition value");
        }
        return [name, resolve(bindings, property.value, locals)];
      }));
    case "MemberExpression": {
      const object = resolve(bindings, node.object, locals);
      if (!isPlainObject(object)) {
        throw new Error("Setting definition reads a property of something that is not an object");
      }
      const name = node.computed ? String(resolve(bindings, node.property, locals)) : node.property.name;
      // A member that is not there reads as `undefined`, which is also a legal
      // default — so a renamed constant would drop a default instead of failing.
      if (!(name in object)) {
        throw new Error(`Setting definition reads ${name}, which its object does not have`);
      }
      return object[name];
    }
    default:
      throw new Error(`Unsupported ${node.type} in a setting definition`);
  }
}

function binding(bindings: Map<string, Node>, name: string): Node {
  const node = bindings.get(name);
  if (!node) {
    throw new Error(`Setting definitions reference ${name}, which the bundle never declares`);
  }
  return node;
}

function remember(bindings: Map<string, Node>, name: string, node: Node): void {
  // A minified bundle reuses short names inside functions; the declaration that
  // the definitions read is the outermost one, which is the one seen first.
  if (!bindings.has(name)) {
    bindings.set(name, node);
  }
}

function asJsonValue(value: unknown, key: string): JsonValue | undefined {
  if (value === undefined) {
    return undefined;
  }
  // A default that JSON cannot carry could never have reached the webview
  // through the real host either.
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new Error(`Default of setting ${key} is not JSON`);
  }
  return JSON.parse(encoded) as JsonValue;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function walk(node: Node, visit: (node: Node) => void): void {
  visit(node);
  for (const key of Object.keys(node)) {
    if (key === "type") {
      continue;
    }
    const child = node[key];
    if (Array.isArray(child)) {
      for (const element of child) {
        if (element && typeof element === "object" && typeof element.type === "string") {
          walk(element, visit);
        }
      }
    } else if (child && typeof child === "object" && typeof child.type === "string") {
      walk(child, visit);
    }
  }
}

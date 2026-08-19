import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readSettingDefinitions } from "../src/extension-settings";
import { parseExtensionVersion, resolveExtensionWebviewRoot } from "../src/extension-webview";

describe("extension setting definitions", () => {
  // The defaults are read out of the bundle instead of copied, so the check that
  // matters is against the bundle itself: a shape this reader no longer
  // understands has to fail here rather than silently answer the webview with
  // nothing.
  test("reads the installed extension's own table", () => {
    const previousRoot = process.env.CODEX_EXTENSION_WEBVIEW_ROOT;
    delete process.env.CODEX_EXTENSION_WEBVIEW_ROOT;
    try {
      // A machine without VS Code (CI, standalone installs) has no bundle to
      // check drift against.
      let entries: string[];
      try {
        entries = readdirSync(join(homedir(), ".vscode", "extensions"));
      } catch {
        return;
      }
      const installed = entries
        .map((entry) => parseExtensionVersion(entry))
        .filter((version): version is number[] => version !== null);
      if (installed.length === 0) {
        return;
      }

      const root = resolveExtensionWebviewRoot();
      const definitions = readSettingDefinitions(join(dirname(root!), "out", "extension.js"));

      expect(definitions.size).toBeGreaterThan(60);
      // Two the webview reads without a fallback of its own, which is why the
      // host has to send them at all.
      expect(definitions.get("open-link-in-target-preference")).toBe("in-app-browser");
      expect(definitions.get("conversationDetailMode")).toBe("STEPS_COMMANDS");
      // One default per browser family, written as a map rather than by hand.
      expect(definitions.get("browser-family-enabled:chrome")).toBe(true);
      expect(definitions.get("enabled-reasoning-efforts")).toEqual(["low", "medium", "high", "xhigh", "ultra"]);
      // A definition can decline to have a default; the key is still a setting.
      expect(definitions.has("appearanceLightChromeTheme")).toBe(true);
      expect(definitions.get("appearanceLightChromeTheme")).toBeUndefined();
    } finally {
      if (previousRoot !== undefined) {
        process.env.CODEX_EXTENSION_WEBVIEW_ROOT = previousRoot;
      }
    }
  });

  test("refuses a bundle whose settings table it cannot find", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-settings-bundle-"));
    const bundle = join(root, "extension.js");
    writeFileSync(bundle, "var a={},b={};var table=[...Object.keys(a),...Object.keys(b)];\n");
    expect(() => readSettingDefinitions(bundle)).toThrow("found 0");
  });

  test("refuses a definition whose default it cannot work out", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-settings-bundle-"));
    const bundle = join(root, "extension.js");
    writeFileSync(
      bundle,
      'var a={one:ot({agentAccess:"read-write",default:whatever(),description:"d",key:"one",schema:s})},'
        + 'b={two:ot({agentAccess:"read-write",default:!0,description:"d",key:"two",schema:s})};'
        + "var table=[...Object.values(a),...Object.values(b)];\n",
    );
    expect(() => readSettingDefinitions(bundle)).toThrow("Unsupported CallExpression");
  });

  test("expands a group written as a map over a table", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-settings-bundle-"));
    const bundle = join(root, "extension.js");
    writeFileSync(
      bundle,
      'var families={chrome:{name:"Chrome"},edge:{name:"Edge"}};'
        + "var mapped=mapValues(families,(family,name)=>Nr({agentAccess:\"hidden\",default:!0,"
        + 'description:`Whether ${family.name} is shown`,key:`browser-family-enabled:${name}`,schema:s}));'
        + 'var a={one:ot({agentAccess:"read-write",default:"x",description:"d",key:"one",schema:s})},'
        + "b={...mapped};"
        + "var table=[...Object.values(a),...Object.values(b)];\n",
    );

    const definitions = readSettingDefinitions(bundle);
    expect([...definitions.entries()].sort()).toEqual([
      ["browser-family-enabled:chrome", true],
      ["browser-family-enabled:edge", true],
      ["one", "x"],
    ]);
  });
});

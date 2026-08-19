import { describe, expect, test } from "bun:test";
import { marketplaceVsixUrl, vsixTargetPlatform } from "../src/extension-install";

describe("extension install", () => {
  test("maps every shipped platform to its marketplace target", () => {
    expect(vsixTargetPlatform("darwin", "arm64")).toBe("darwin-arm64");
    expect(vsixTargetPlatform("darwin", "x64")).toBe("darwin-x64");
    expect(vsixTargetPlatform("linux", "x64")).toBe("linux-x64");
    expect(vsixTargetPlatform("win32", "x64")).toBe("win32-x64");
  });

  test("refuses a platform the extension does not ship for", () => {
    expect(() => vsixTargetPlatform("freebsd", "x64")).toThrow("No Codex extension build");
  });

  test("builds the versioned vspackage URL", () => {
    expect(marketplaceVsixUrl("26.803.61601", "darwin-arm64")).toBe(
      "https://marketplace.visualstudio.com/_apis/public/gallery/publishers/openai/vsextensions/chatgpt/26.803.61601/vspackage?targetPlatform=darwin-arm64",
    );
  });
});

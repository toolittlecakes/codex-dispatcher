import { describe, expect, test } from "bun:test";
import type { JsonObject } from "../src/codex-app-server";
import { ThreadMirrors } from "../src/thread-mirrors";

const snapshot = (revision: number, turns: JsonObject[] = [{ id: "t1" }]): JsonObject => ({
  conversationId: "thread-1",
  change: { type: "snapshot", revision, conversationState: { id: "thread-1", turns } },
});

const patches = (baseRevision: number, revision: number, patches: JsonObject[]): JsonObject => ({
  conversationId: "thread-1",
  change: { type: "patches", baseRevision, revision, patches },
});

const addTurn = (index: number) => [{ op: "add", path: `/turns/${index}`, value: { id: `t${index + 1}` } }];

const mirroring = (revision = 7) => {
  const mirrors = new ThreadMirrors();
  mirrors.apply("thread-1", snapshot(revision), "owner");
  return mirrors;
};

describe("mirroring a thread another client owns", () => {
  test("adopts a snapshot together with the client that sent it", () => {
    const mirrors = new ThreadMirrors();
    expect(mirrors.apply("thread-1", snapshot(7), "owner")).toBe("adopted");
    expect(mirrors.ownerOf("thread-1")).toBe("owner");
    expect(mirrors.threadIds()).toEqual(["thread-1"]);
  });

  test("applies patches that build on the revision it holds", () => {
    const mirrors = mirroring();
    expect(mirrors.apply("thread-1", patches(7, 8, addTurn(1)), "owner")).toBe("patched");
    expect(mirrors.apply("thread-1", patches(8, 9, addTurn(2)), "owner")).toBe("patched");
  });

  test("ignores patches from a client that is not the owner it recorded", () => {
    const mirrors = mirroring();
    expect(mirrors.apply("thread-1", patches(7, 8, addTurn(1)), "someone-else")).toBe("ignored");
    expect(mirrors.ownerOf("thread-1")).toBe("owner");
  });

  test("ignores patches built on a revision it does not hold", () => {
    const mirrors = mirroring();
    expect(mirrors.apply("thread-1", patches(11, 12, addTurn(1)), "owner")).toBe("ignored");
    // Still on revision 7, so the patch that does build on it is next to apply.
    expect(mirrors.apply("thread-1", patches(7, 8, addTurn(1)), "owner")).toBe("patched");
  });

  test("ignores patches for a thread it has no snapshot of", () => {
    expect(new ThreadMirrors().apply("thread-1", patches(7, 8, addTurn(1)), "owner")).toBe("ignored");
  });

  // A patch that cannot be applied used to take the mirror and the owner with
  // it, and every follower request after that — stop above all — was refused
  // with «No IPC owner». The mirror goes stale instead, and stays followable.
  test("keeps the thread and its owner when a patch cannot be applied", () => {
    const mirrors = mirroring();
    const impossible = patches(7, 8, [{ op: "replace", path: "/turns/9/status", value: "done" }]);

    expect(mirrors.apply("thread-1", impossible, "owner")).toBe("patch-failed");

    expect(mirrors.ownerOf("thread-1")).toBe("owner");
    expect(mirrors.has("thread-1")).toBe(true);
    // The revision did not move either, so the owner's next patch still lands.
    expect(mirrors.apply("thread-1", patches(7, 8, addTurn(1)), "owner")).toBe("patched");
  });

  test("forgets the threads of a client that disconnected", () => {
    const mirrors = mirroring();
    mirrors.forgetClient("someone-else");
    expect(mirrors.ownerOf("thread-1")).toBe("owner");

    mirrors.forgetClient("owner");
    expect(mirrors.ownerOf("thread-1")).toBeNull();
    expect(mirrors.has("thread-1")).toBe(false);
    expect(mirrors.threadIds()).toEqual([]);
  });
});

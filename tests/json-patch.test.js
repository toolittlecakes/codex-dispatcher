import { describe, expect, test } from "bun:test";
import { applyJsonPatches } from "../public/json-patch.js";

describe("applyJsonPatches", () => {
  test("applies immer-style array add, replace, and remove patches", () => {
    const base = {
      turns: [
        {
          id: "turn-1",
          items: [{ text: "old" }],
        },
      ],
    };

    const next = applyJsonPatches(base, [
      { op: "replace", path: ["turns", 0, "items", 0, "text"], value: "new" },
      { op: "add", path: ["turns", 1], value: { id: "turn-2", items: [] } },
      { op: "remove", path: ["turns", 0, "items", 0] },
    ]);

    expect(next).toEqual({
      turns: [
        {
          id: "turn-1",
          items: [],
        },
        {
          id: "turn-2",
          items: [],
        },
      ],
    });
    expect(base.turns[0].items).toEqual([{ text: "old" }]);
  });

  test("supports JSON pointer paths and root replacement", () => {
    expect(applyJsonPatches({ a: { "b/c": 1 } }, [{ op: "replace", path: "/a/b~1c", value: 2 }])).toEqual({
      a: { "b/c": 2 },
    });

    expect(applyJsonPatches({ a: 1 }, [{ op: "replace", path: "", value: { b: 2 } }])).toEqual({ b: 2 });
  });

  test("fails visibly on out-of-order patches", () => {
    expect(() => applyJsonPatches({ turns: [] }, [{ op: "replace", path: ["turns", 0, "status"], value: "done" }])).toThrow(
      "Patch path does not exist",
    );
  });
});

import { expect, it } from "vitest";
import { canMoveInto } from "./moveRules";

// Tree: root > A > A1, root > B. Moving A (from root).
const sel = new Set(["A"]);
it("refuses moving a folder into itself", () => expect(canMoveInto("A", ["root"], sel, "root")).toBe(false));
it("refuses moving a folder into its own subfolder", () => expect(canMoveInto("A1", ["root", "A"], sel, "root")).toBe(false));
it("refuses the folder the items are already in", () => expect(canMoveInto("root", [], sel, "root")).toBe(false));
it("allows a sibling folder", () => expect(canMoveInto("B", ["root"], sel, "root")).toBe(true));
it("allows the parent of the current folder", () => expect(canMoveInto("root", [], new Set(["A1"]), "A")).toBe(true));

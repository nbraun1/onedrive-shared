import { beforeEach, describe, expect, it } from "vitest";
import { addShare, loadShares, moveShare, removeShare, renameShare, saveShares, validateLabel, type SavedShare } from "./shares";

class MemStorage {
  data = new Map<string, string>();
  getItem = (k: string) => this.data.get(k) ?? null;
  setItem = (k: string, v: string) => void this.data.set(k, v);
  removeItem = (k: string) => void this.data.delete(k);
}
let store: MemStorage;
const st = () => store as unknown as Storage;
beforeEach(() => (store = new MemStorage()));

const folder = { driveId: "D", itemId: "I", name: "Friend's folder", canEdit: true };

describe("loadShares", () => {
  it.each(["not json", "{}", "null", "42"])("returns [] for %j", (raw) => {
    store.setItem("shares", raw);
    expect(loadShares(st())).toEqual([]);
  });
  it("drops malformed entries", () => {
    store.setItem("shares", JSON.stringify([{ id: "a", label: "x" }, { id: "b", label: "ok", driveId: "D", itemId: "I", name: "n", canEdit: true }, null]));
    expect(loadShares(st()).map((s) => s.id)).toEqual(["b"]);
  });
  it("migrates the v1 single link once", () => {
    store.setItem("share", JSON.stringify(folder));
    const list = loadShares(st());
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ ...folder, label: "Friend's folder" });
    expect(store.getItem("share")).toBeNull();
    expect(loadShares(st())).toHaveLength(1);
  });
  it("ignores a corrupt v1 link", () => {
    store.setItem("share", "{broken");
    expect(loadShares(st())).toEqual([]);
    expect(store.getItem("share")).toBeNull();
  });
});

describe("addShare", () => {
  it("adds with the folder name as default label", () => {
    const r = addShare([], folder, "   ");
    expect(r.existed).toBe(false);
    expect(r.share.id).toBeTruthy();
    expect(r.share.label).toBe("Friend's folder");
    expect(r.list).toEqual([r.share]);
  });
  it("trims the label", () => {
    expect(addShare([], folder, "  Urlaub  ").share.label).toBe("Urlaub");
  });
  it("does not duplicate the same folder", () => {
    const first = addShare([], folder, "Urlaub");
    const again = addShare(first.list, { ...folder, canEdit: false }, "Other");
    expect(again.existed).toBe(true);
    expect(again.list).toHaveLength(1);
    expect(again.share.label).toBe("Urlaub");
  });
});

describe("rename / remove", () => {
  let list: SavedShare[];
  beforeEach(() => {
    list = addShare(addShare([], folder, "A").list, { ...folder, itemId: "J" }, "B").list;
  });
  it("renames by id", () => {
    expect(renameShare(list, list[1].id, " C ").map((s) => s.label)).toEqual(["A", "C"]);
  });
  it("removes by id and keeps the rest", () => {
    expect(removeShare(list, list[0].id, st()).map((s) => s.label)).toEqual(["B"]);
  });
  it("leaves the list unchanged for an unknown id", () => {
    expect(removeShare(list, "nope", st())).toEqual(list);
    expect(renameShare(list, "nope", "X")).toEqual(list);
  });
  it("forgets the last opened link when it is removed", () => {
    store.setItem("lastShare", list[0].id);
    removeShare(list, list[1].id, st());
    expect(store.getItem("lastShare")).toBe(list[0].id);
    removeShare(list, list[0].id, st());
    expect(store.getItem("lastShare")).toBeNull();
  });
  it("persists via saveShares", () => {
    saveShares(list, st());
    expect(loadShares(st())).toEqual(list);
  });
});

describe("validateLabel", () => {
  it("allows empty and 60 chars", () => {
    expect(validateLabel("")).toBeNull();
    expect(validateLabel("x".repeat(60))).toBeNull();
  });
  it("rejects 61 chars", () => {
    expect(validateLabel("x".repeat(61))).toBe("Name is too long (max 60 characters)");
  });
});

describe("review fixes", () => {
  it("re-adding a link refreshes edit access and folder name", () => {
    const first = addShare([], { ...folder, canEdit: false }, "Urlaub");
    const again = addShare(first.list, { ...folder, name: "Renamed", canEdit: true }, "");
    expect(again.existed).toBe(true);
    expect(again.share).toMatchObject({ label: "Urlaub", canEdit: true, name: "Renamed" });
    expect(again.list[0]).toEqual(again.share);
  });
  it("survives a v1 link without a name", () => {
    store.setItem("share", JSON.stringify({ driveId: "a", itemId: "b", name: 42 }));
    const list = loadShares(st());
    expect(list).toHaveLength(1);
    expect(typeof list[0].label).toBe("string");
    expect(store.getItem("share")).toBeNull();
  });
});

describe("moveShare", () => {
  const abc = ["A", "B", "C"].reduce<SavedShare[]>((l, n) => addShare(l, { ...folder, itemId: n }, n).list, []);
  const labels = (l: SavedShare[]) => l.map((s) => s.label);
  it.each([
    [0, 2, ["B", "C", "A"]],
    [2, 0, ["C", "A", "B"]],
    [1, 2, ["A", "C", "B"]],
    [1, 0, ["B", "A", "C"]],
    [1, 1, ["A", "B", "C"]],
    [-1, 0, ["A", "B", "C"]],
    [0, 3, ["A", "B", "C"]],
  ])("moves %i → %i", (from, to, expected) => {
    expect(labels(moveShare(abc, from, to))).toEqual(expected);
    expect(labels(abc)).toEqual(["A", "B", "C"]); // input untouched
  });
  it("keeps the order through save and load", () => {
    saveShares(moveShare(abc, 2, 0), st());
    expect(labels(loadShares(st()))).toEqual(["C", "A", "B"]);
  });
});

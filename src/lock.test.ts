import { beforeEach, describe, expect, it } from "vitest";
import { isDue, loadLock, saveLock } from "./lock";

class MemStorage {
  data = new Map<string, string>();
  getItem = (k: string) => this.data.get(k) ?? null;
  setItem = (k: string, v: string) => void this.data.set(k, v);
  removeItem = (k: string) => void this.data.delete(k);
}
let store: MemStorage;
const st = () => store as unknown as Storage;
beforeEach(() => (store = new MemStorage()));

describe("isDue", () => {
  it("locks when never hidden (cold start)", () => expect(isDue(null, 5, 60_000)).toBe(true));
  it("stays open just before the delay", () => expect(isDue(0, 59_999, 60_000)).toBe(false));
  it("locks at the delay", () => expect(isDue(0, 60_000, 60_000)).toBe(true));
  it("locks at once with delay 0", () => expect(isDue(10, 10, 0)).toBe(true));
  it("locks when the clock went backwards", () => expect(isDue(100, 50, 60_000)).toBe(true));
});

describe("loadLock / saveLock", () => {
  it("is off when nothing is stored", () => expect(loadLock(st())).toBeNull());
  it.each(["{", "null", "42", '{"id":1,"delay":0}', '{"id":"a"}', '{"id":"","delay":0}'])("is off for %j", (raw) => {
    store.setItem("appLock", raw);
    expect(loadLock(st())).toBeNull();
  });
  it("round-trips", () => {
    saveLock({ id: "a", delay: 60_000 }, st());
    expect(loadLock(st())).toEqual({ id: "a", delay: 60_000 });
  });
  it("null turns it off", () => {
    saveLock({ id: "a", delay: 0 }, st());
    saveLock(null, st());
    expect(store.data.has("appLock")).toBe(false);
  });
});

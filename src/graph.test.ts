import { describe, expect, it, vi } from "vitest";
import { createGraph, errorText, GraphError } from "./graph";

const G = "https://graph.microsoft.com/v1.0";
type Call = { url: string; init: RequestInit };
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
const graphError = (status: number, code: string) => json({ error: { code, message: `${code} message` } }, status);

// Replies in order; records every call.
function fakeFetch(...replies: (Response | Error)[]) {
  const calls: Call[] = [];
  const fn = vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    const r = replies.shift();
    if (!r) throw new Error("unexpected call " + url);
    if (r instanceof Error) throw r;
    return r;
  });
  return { fn: fn as unknown as typeof fetch, calls };
}
const header = (c: Call, name: string) => new Headers(c.init.headers).get(name);
const tokens = () => vi.fn(async (force?: boolean) => (force ? "fresh" : "cached"));

describe("resolveShare", () => {
  it("redeems the link and reads edit permission", async () => {
    const f = fakeFetch(
      json({ id: "root", name: "Shared", folder: { childCount: 2 }, parentReference: { driveId: "d1" } }),
      json({ roles: ["write"] }),
    );
    const g = createGraph(tokens(), f.fn);
    const r = await g.resolveShare("https://1drv.ms/f/s!abc");
    expect(r.item.id).toBe("root");
    expect(r.canEdit).toBe(true);
    expect(f.calls[0].url).toBe(`${G}/shares/u!aHR0cHM6Ly8xZHJ2Lm1zL2YvcyFhYmM/driveItem`);
    expect(header(f.calls[0], "Prefer")).toBe("redeemSharingLink");
    expect(header(f.calls[0], "Authorization")).toBe("Bearer cached");
    expect(f.calls[1].url).toBe(`${G}/shares/u!aHR0cHM6Ly8xZHJ2Lm1zL2YvcyFhYmM/permission`);
  });
  it("reports view-only links", async () => {
    const f = fakeFetch(json({ id: "r", name: "S", folder: {}, parentReference: { driveId: "d" } }), json({ roles: ["read"] }));
    expect((await createGraph(tokens(), f.fn).resolveShare("https://1drv.ms/f/s!a")).canEdit).toBe(false);
  });
  it("rejects a link that resolves to a file", async () => {
    const f = fakeFetch(json({ id: "r", name: "a.txt", file: {}, parentReference: { driveId: "d" } }));
    await expect(createGraph(tokens(), f.fn).resolveShare("https://1drv.ms/f/s!a")).rejects.toThrow("not a folder");
  });
  it.each([403, 404])("explains a rejected link (%i)", async (status) => {
    const f = fakeFetch(graphError(status, "itemNotFound"));
    await expect(createGraph(tokens(), f.fn).resolveShare("https://1drv.ms/f/s!a")).rejects.toThrow(
      "OneDrive rejected this link (expired or no access)",
    );
  });
});

describe("listChildren", () => {
  it("follows @odata.nextLink across pages", async () => {
    const f = fakeFetch(
      json({ value: [{ id: "1" }], "@odata.nextLink": `${G}/next?p=2` }),
      json({ value: [{ id: "2" }], "@odata.nextLink": `${G}/next?p=3` }),
      json({ value: [{ id: "3" }] }),
    );
    const items = await createGraph(tokens(), f.fn).listChildren("d1", "f1");
    expect(items.map((i) => i.id)).toEqual(["1", "2", "3"]);
    expect(f.calls[0].url).toBe(`${G}/drives/d1/items/f1/children?$top=200`);
    expect(f.calls[2].url).toBe(`${G}/next?p=3`);
  });
});

describe("item changes", () => {
  it("deletes, renames, moves and creates folders", async () => {
    const f = fakeFetch(new Response(null, { status: 204 }), json({ id: "i" }), json({ id: "i" }), json({ id: "n" }));
    const g = createGraph(tokens(), f.fn);
    await g.deleteItem("d", "i");
    await g.renameItem("d", "i", "  Neu ä  ");
    await g.moveItem("d", "i", "p2");
    await g.createFolder("d", "p", "Ordner");
    expect(f.calls.map((c) => `${c.init.method} ${c.url}`)).toEqual([
      `DELETE ${G}/drives/d/items/i`,
      `PATCH ${G}/drives/d/items/i`,
      `PATCH ${G}/drives/d/items/i`,
      `POST ${G}/drives/d/items/p/children`,
    ]);
    expect(JSON.parse(f.calls[1].init.body as string)).toEqual({ name: "Neu ä" });
    expect(JSON.parse(f.calls[2].init.body as string)).toEqual({ parentReference: { id: "p2" } });
    expect(JSON.parse(f.calls[3].init.body as string)).toEqual({
      name: "Ordner",
      folder: {},
      "@microsoft.graph.conflictBehavior": "fail",
    });
  });
  it("maps a name conflict to GraphError nameAlreadyExists", async () => {
    const f = fakeFetch(graphError(409, "nameAlreadyExists"));
    const err = await createGraph(tokens(), f.fn).createFolder("d", "p", "x").catch((e) => e);
    expect(err).toBeInstanceOf(GraphError);
    expect(err.status).toBe(409);
    expect(err.code).toBe("nameAlreadyExists");
  });
});

describe("uploadFile", () => {
  it("PUTs small files with an encoded name and fail-on-conflict", async () => {
    const f = fakeFetch(json({ id: "new" }, 201));
    const progress = vi.fn();
    const file = new File(["hello"], "Prüfung #1 %.txt");
    const item = await createGraph(tokens(), f.fn).uploadFile("d", "p", file, progress);
    expect(item.id).toBe("new");
    expect(f.calls[0].init.method).toBe("PUT");
    expect(f.calls[0].url).toBe(
      `${G}/drives/d/items/p:/Pr%C3%BCfung%20%231%20%25.txt:/content?@microsoft.graph.conflictBehavior=fail`,
    );
    expect(progress).toHaveBeenLastCalledWith(1);
  });
  it("uses an upload session in 320 KiB-multiple chunks for large files", async () => {
    const size = 5 * 1024 * 1024;
    const chunk = 10 * 320 * 1024;
    const f = fakeFetch(
      json({ uploadUrl: "https://up.example/session" }),
      new Response(null, { status: 202 }),
      json({ id: "big" }, 201),
    );
    const progress = vi.fn();
    const item = await createGraph(tokens(), f.fn).uploadFile("d", "p", new File([new Uint8Array(size)], "big.bin"), progress);
    expect(item.id).toBe("big");
    expect(f.calls[0].url).toBe(`${G}/drives/d/items/p:/big.bin:/createUploadSession`);
    expect(JSON.parse(f.calls[0].init.body as string)).toEqual({ item: { "@microsoft.graph.conflictBehavior": "fail" } });
    expect(f.calls[1].url).toBe("https://up.example/session");
    expect(header(f.calls[1], "Content-Range")).toBe(`bytes 0-${chunk - 1}/${size}`);
    expect(header(f.calls[2], "Content-Range")).toBe(`bytes ${chunk}-${size - 1}/${size}`);
    expect(header(f.calls[1], "Authorization")).toBeNull();
    expect(progress).toHaveBeenCalledWith(chunk / size);
    expect(progress).toHaveBeenLastCalledWith(1);
  });
  it("uploads an empty file with a simple PUT", async () => {
    const f = fakeFetch(json({ id: "e" }, 201));
    await createGraph(tokens(), f.fn).uploadFile("d", "p", new File([], "empty.txt"));
    expect(f.calls[0].init.method).toBe("PUT");
  });
});

describe("request handling", () => {
  it("retries 429 honoring Retry-After", async () => {
    const f = fakeFetch(json({}, 429, { "Retry-After": "0" }), json({ value: [] }));
    expect(await createGraph(tokens(), f.fn).listChildren("d", "i")).toEqual([]);
    expect(f.calls).toHaveLength(2);
  });
  it("gives up after 3 retries", async () => {
    const busy = () => json({}, 503, { "Retry-After": "0" });
    const f = fakeFetch(busy(), busy(), busy(), busy());
    const err = await createGraph(tokens(), f.fn).listChildren("d", "i").catch((e) => e);
    expect(err.status).toBe(503);
    expect(f.calls).toHaveLength(4);
  });
  it("refreshes the token once on 401", async () => {
    const t = tokens();
    const f = fakeFetch(graphError(401, "InvalidAuthenticationToken"), json({ value: [] }));
    await createGraph(t, f.fn).listChildren("d", "i");
    expect(t).toHaveBeenLastCalledWith(true);
    expect(header(f.calls[1], "Authorization")).toBe("Bearer fresh");
  });
  it("does not loop on a second 401", async () => {
    const f = fakeFetch(graphError(401, "a"), graphError(401, "a"));
    const err = await createGraph(tokens(), f.fn).listChildren("d", "i").catch((e) => e);
    expect(err.status).toBe(401);
    expect(f.calls).toHaveLength(2);
  });
  it("reports network failures as No connection", async () => {
    const f = fakeFetch(new TypeError("Failed to fetch"));
    const err = await createGraph(tokens(), f.fn).listChildren("d", "i").catch((e) => e);
    expect(err).toBeInstanceOf(GraphError);
    expect(err.status).toBe(0);
    expect(err.message).toBe("No connection");
  });
  it("uses the Graph error message for other failures", async () => {
    const f = fakeFetch(graphError(500, "generalException"));
    await expect(createGraph(tokens(), f.fn).deleteItem("d", "i")).rejects.toThrow("generalException message");
  });
});

describe("errorText", () => {
  it("names the item on a name conflict", () => {
    expect(errorText(new GraphError(409, "nameAlreadyExists", "x"), "a.txt")).toBe("'a.txt' already exists");
  });
  it("uses the message otherwise", () => {
    expect(errorText(new GraphError(0, "network", "No connection"), "a")).toBe("No connection");
    expect(errorText("boom")).toBe("boom");
  });
});

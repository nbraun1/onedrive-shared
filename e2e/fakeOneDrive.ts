import type { Page, Route } from "@playwright/test";

export const EDIT_LINK = "https://1drv.ms/f/s!EditLink";
export const VIEW_LINK = "https://1drv.ms/f/s!ViewLink";
const token = (link: string) => "u!" + Buffer.from(link).toString("base64url");

type Node = { id: string; name: string; parent?: string; folder: boolean; size?: number };

/** An in-memory OneDrive behind page.route, speaking the Graph calls the app uses. */
export async function fakeOneDrive(page: Page) {
  const nodes = new Map<string, Node>();
  let seq = 0;
  const add = (name: string, parent: string | undefined, folder: boolean) => {
    const n = { id: `n${++seq}`, name, parent, folder, size: folder ? undefined : 1234 };
    nodes.set(n.id, n);
    return n;
  };
  const root = add("Friend's folder", undefined, true);
  const alpha = add("Alpha", root.id, true);
  add("Inner", alpha.id, true);
  add("a.txt", alpha.id, false);
  add("Beta", root.id, true);
  add("readme.txt", root.id, false);

  const state = { failList: false, failUploadName: "", delayMs: 0, slowFolder: "" };
  const children = (id: string) => [...nodes.values()].filter((n) => n.parent === id);
  const exists = (parent: string, name: string, except?: string) =>
    children(parent).some((n) => n.name.toLowerCase() === name.toLowerCase() && n.id !== except);
  const json = (route: Route, body: unknown, status = 200) =>
    route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  const conflict = (route: Route) => json(route, { error: { code: "nameAlreadyExists", message: "exists" } }, 409);
  const dto = (n: Node) => ({
    id: n.id,
    name: n.name,
    size: n.size,
    lastModifiedDateTime: "2026-11-01T10:00:00Z",
    webUrl: `https://onedrive.example/${n.id}`,
    parentReference: { driveId: "D", id: n.parent },
    ...(n.folder ? { folder: { childCount: children(n.id).length } } : { file: {} }),
  });
  const remove = (id: string) => {
    children(id).forEach((c) => remove(c.id));
    nodes.delete(id);
  };

  await page.route("https://graph.microsoft.com/**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = decodeURIComponent(url.pathname.replace("/v1.0", ""));
    const method = req.method();
    if (state.delayMs) await new Promise((r) => setTimeout(r, state.delayMs));
    let m: RegExpMatchArray | null;

    if ((m = path.match(/^\/shares\/([^/]+)\/(driveItem|permission)$/))) {
      const link = m[1] === token(EDIT_LINK) ? "edit" : m[1] === token(VIEW_LINK) ? "view" : null;
      if (!link) return json(route, { error: { code: "itemNotFound", message: "nope" } }, 404);
      return m[2] === "driveItem" ? json(route, dto(root)) : json(route, { roles: [link === "edit" ? "write" : "read"] });
    }
    if ((m = path.match(/^\/drives\/D\/items\/([^/:]+)\/children$/))) {
      if (method === "GET") {
        if (nodes.get(m[1])?.name === state.slowFolder) await new Promise((r) => setTimeout(r, 1500));
        if (state.failList) return json(route, { error: { code: "generalException", message: "Server exploded" } }, 500);
        return json(route, { value: children(m[1]).map(dto) });
      }
      const body = req.postDataJSON();
      if (exists(m[1], body.name)) return conflict(route);
      return json(route, dto(add(body.name, m[1], true)), 201);
    }
    if ((m = path.match(/^\/drives\/D\/items\/([^/:]+):\/(.+):\/content$/))) {
      if (m[2] === state.failUploadName || exists(m[1], m[2])) return conflict(route);
      return json(route, dto(add(m[2], m[1], false)), 201);
    }
    if ((m = path.match(/^\/drives\/D\/items\/([^/:]+)$/))) {
      const n = nodes.get(m[1])!;
      if (method === "DELETE") {
        remove(n.id);
        return route.fulfill({ status: 204 });
      }
      const body = req.postDataJSON();
      if (body.name !== undefined) {
        if (exists(n.parent!, body.name, n.id)) return conflict(route);
        n.name = body.name;
      }
      if (body.parentReference) {
        if (exists(body.parentReference.id, n.name)) return conflict(route);
        n.parent = body.parentReference.id;
      }
      return json(route, dto(n));
    }
    return route.fulfill({ status: 500, body: `unexpected ${method} ${path}` });
  });
  return { nodes, state, names: (parentName: string) => children([...nodes.values()].find((n) => n.name === parentName)!.id).map((n) => n.name).sort() };
}

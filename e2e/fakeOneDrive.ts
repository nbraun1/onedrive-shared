import type { Page, Route } from "@playwright/test";

export const EDIT_LINK = "https://1drv.ms/f/s!EditLink";
export const VIEW_LINK = "https://1drv.ms/f/s!ViewLink";
export const OTHER_LINK = "https://1drv.ms/f/s!OtherLink";
export const THIRD_LINK = "https://1drv.ms/f/s!ThirdLink";
// 1x1 PNG, and one second of silent 8 kHz mono WAV
export const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const WAV = (() => {
  const n = 8000, b = Buffer.alloc(44 + n);
  b.write("RIFF", 0); b.writeUInt32LE(36 + n, 4); b.write("WAVEfmt ", 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(8000, 24); b.writeUInt32LE(8000, 28); b.writeUInt16LE(1, 32); b.writeUInt16LE(8, 34); b.write("data", 36); b.writeUInt32LE(n, 40); b.fill(128, 44);
  return b;
})();
const MIME: Record<string, string> = { jpg: "image/jpeg", png: "image/png", mp4: "video/mp4", txt: "text/plain", pdf: "application/pdf", wav: "audio/wav" };
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
  const gallery = add("Gallery", alpha.id, true);
  for (const f of ["clip.mp4", "doc.pdf", "notes.txt", "photo1.jpg", "photo2.png", "song.wav"]) add(f, gallery.id, false);
  [...nodes.values()].find((n) => n.name === "clip.mp4")!.size = 300 * 1024 * 1024;
  const many = add("Many", alpha.id, true);
  for (let i = 10; i < 50; i++) add(`img${i}.jpg`, many.id, false);
  add("deep.txt", add("Deep", many.id, true).id, false);
  const beta = [...nodes.values()].find((n) => n.name === "Beta")!;

  const state = { failList: false, failUploadName: "", delayMs: 0, slowFolder: "", dlDelayMs: 0, failDownloadUrl: false, dlResponse: null as null | { status: number; body: unknown }, dlCalls: 0, itemGets: 0, listCalls: {} as Record<string, number>, listingUrls: true, noThumbs: false, dlFileDelayMs: 0, failOriginal: "", dlRequests: [] as { url: string; range?: string }[] };
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
    ...(n.folder
      ? { folder: { childCount: children(n.id).length } }
      : {
          file: { mimeType: MIME[n.name.split(".").pop()!] ?? "application/octet-stream" },
          thumbnails:
            n.name === "readme.txt" || state.noThumbs
              ? []
              : [{ small: { url: `https://thumb.example/${n.id}` }, medium: { url: `https://thumb.example/${n.id}?s=medium` }, large: { url: `https://thumb.example/${n.id}?s=large` } }],
          ...(state.listingUrls ? { "@microsoft.graph.downloadUrl": `https://dl.example/${n.id}/${encodeURIComponent(n.name)}?l=1` } : {}),
        }),
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
      const link = m[1] === token(EDIT_LINK) ? "edit" : m[1] === token(VIEW_LINK) ? "view" : m[1] === token(OTHER_LINK) ? "other" : m[1] === token(THIRD_LINK) ? "third" : null;
      if (!link) return json(route, { error: { code: "itemNotFound", message: "nope" } }, 404);
      if (m[2] === "permission") return json(route, { roles: [link === "view" ? "read" : "write"] });
      return json(route, dto(link === "other" ? beta : link === "third" ? alpha : root));
    }
    if ((m = path.match(/^\/drives\/D\/items\/([^/:]+)\/children$/))) {
      if (method === "GET") {
        const folderName = nodes.get(m[1])!.name;
        state.listCalls[folderName] = (state.listCalls[folderName] ?? 0) + 1;
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
    if ((m = path.match(/^\/drives\/D\/items\/([^/:]+)\/thumbnails$/))) {
      return json(route, { value: [{ c2048x2048: { url: `https://thumb.example/${m[1]}?size=2048` } }] });
    }
    if ((m = path.match(/^\/drives\/D\/items\/([^/:]+)$/))) {
      const n = nodes.get(m[1])!;
      if (method === "GET") {
        state.itemGets++;
        if (state.dlDelayMs) await new Promise((r) => setTimeout(r, state.dlDelayMs));
        if (state.failDownloadUrl) return json(route, { error: { code: "generalException", message: "boom" } }, 500);
        if (state.dlResponse) return json(route, state.dlResponse.body, state.dlResponse.status);
        return json(route, { id: n.id, "@microsoft.graph.downloadUrl": `https://dl.example/${n.id}/${encodeURIComponent(n.name)}?v=${++state.dlCalls}` });
      }
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
  await page.route("https://thumb.example/**", (route) => route.fulfill({ contentType: "image/png", body: PNG }));
  await page.route("https://dl.example/**", async (route) => {
    const req = route.request();
    state.dlRequests.push({ url: req.url(), range: req.headers()["range"] });
    const name = decodeURIComponent(new URL(req.url()).pathname.split("/").pop()!);
    const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*" };
    if (state.dlFileDelayMs) await new Promise((r) => setTimeout(r, state.dlFileDelayMs));
    if (name === state.failOriginal) return route.fulfill({ headers, status: 500, body: "nope" });
    if (name.endsWith(".txt")) return route.fulfill({ headers, contentType: "text/plain", body: "Hello from notes" });
    if (name.endsWith(".wav")) return route.fulfill({ headers, contentType: "audio/wav", body: WAV });
    if (name.endsWith(".mp4")) return route.fulfill({ headers, contentType: "video/mp4", body: Buffer.from("not a video") });
    // photo2 is a big portrait image, larger than any test viewport
    if (name === "photo2.png")
      return route.fulfill({ headers, contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="3000" height="4000"><rect width="3000" height="4000" fill="teal"/></svg>' });
    return route.fulfill({ headers, contentType: "image/png", body: PNG });
  });
  return { nodes, state, add, names: (parentName: string) => children([...nodes.values()].find((n) => n.name === parentName)!.id).map((n) => n.name).sort() };
}

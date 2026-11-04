import { encodeShareLink } from "./shareLink";

const BASE = "https://graph.microsoft.com/v1.0";
const SIMPLE_UPLOAD_MAX = 4 * 1024 * 1024;
const CHUNK = 10 * 320 * 1024; // upload session chunks must be multiples of 320 KiB
const MAX_RETRIES = 3;

export type DriveItem = {
  id: string;
  name: string;
  size?: number;
  lastModifiedDateTime?: string;
  webUrl?: string;
  folder?: { childCount?: number };
  file?: object;
  parentReference?: { driveId?: string; id?: string };
};

export class GraphError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

type GetToken = (forceRefresh?: boolean) => Promise<string>;

export function createGraph(getToken: GetToken, fetchFn: typeof fetch = (...a) => fetch(...a)) {
  // auth=false is for upload session URLs, which must not get the bearer token.
  async function send(url: string, init: RequestInit = {}, auth = true): Promise<Response> {
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      const headers = new Headers(init.headers);
      if (auth) headers.set("Authorization", `Bearer ${await getToken(refreshed)}`);
      let res: Response;
      try {
        res = await fetchFn(url, { ...init, headers });
      } catch {
        throw new GraphError(0, "network", "No connection");
      }
      if (res.ok) return res;
      if (res.status === 401 && auth && !refreshed) {
        refreshed = true;
        continue;
      }
      if ((res.status === 429 || res.status === 503) && attempt < MAX_RETRIES) {
        const wait = Number(res.headers.get("Retry-After") ?? 1);
        await new Promise((r) => setTimeout(r, (Number.isFinite(wait) ? wait : 1) * 1000));
        continue;
      }
      const body = await res.json().catch(() => ({}));
      throw new GraphError(res.status, body?.error?.code ?? "unknown", body?.error?.message ?? `Request failed (${res.status})`);
    }
  }

  const call = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
    const res = await send(path.startsWith("https://") ? path : BASE + path, init);
    return res.status === 204 ? (undefined as T) : res.json();
  };
  const jsonInit = (method: string, body: unknown): RequestInit => ({
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const item = (d: string, id: string) => `/drives/${d}/items/${id}`;

  return {
    async resolveShare(link: string): Promise<{ item: DriveItem; canEdit: boolean }> {
      const token = encodeShareLink(link);
      let root: DriveItem;
      try {
        root = await call(`/shares/${token}/driveItem`, { headers: { Prefer: "redeemSharingLink" } });
      } catch (e) {
        if (e instanceof GraphError && (e.status === 403 || e.status === 404))
          throw new GraphError(e.status, e.code, "OneDrive rejected this link (expired or no access)");
        throw e;
      }
      if (!root.folder) throw new GraphError(0, "notFolder", "This link points to a file, not a folder");
      if (!root.parentReference?.driveId) throw new GraphError(0, "noDrive", "OneDrive did not return the folder's drive");
      // If the permission can't be read, assume edit and let Graph reject writes.
      const perm = await call<{ roles?: string[] }>(`/shares/${token}/permission`).catch(() => ({ roles: ["write"] }));
      return { item: root, canEdit: !!perm.roles?.includes("write") };
    },

    async listChildren(driveId: string, id: string): Promise<DriveItem[]> {
      const items: DriveItem[] = [];
      let next: string | undefined = `${item(driveId, id)}/children?$top=200`;
      while (next) {
        const page: { value: DriveItem[]; "@odata.nextLink"?: string } = await call(next);
        items.push(...page.value);
        next = page["@odata.nextLink"];
      }
      return items;
    },

    deleteItem: (driveId: string, id: string): Promise<void> => call(item(driveId, id), { method: "DELETE" }),

    renameItem: (driveId: string, id: string, name: string): Promise<DriveItem> =>
      call(item(driveId, id), jsonInit("PATCH", { name: name.trim() })),

    moveItem: (driveId: string, id: string, parentId: string): Promise<DriveItem> =>
      call(item(driveId, id), jsonInit("PATCH", { parentReference: { id: parentId } })),

    createFolder: (driveId: string, parentId: string, name: string): Promise<DriveItem> =>
      call(
        `${item(driveId, parentId)}/children`,
        jsonInit("POST", { name: name.trim(), folder: {}, "@microsoft.graph.conflictBehavior": "fail" }),
      ),

    async uploadFile(driveId: string, parentId: string, file: File, onProgress?: (fraction: number) => void): Promise<DriveItem> {
      const target = `${item(driveId, parentId)}:/${encodeURIComponent(file.name)}:`;
      if (file.size <= SIMPLE_UPLOAD_MAX) {
        const res = await call<DriveItem>(`${target}/content?@microsoft.graph.conflictBehavior=fail`, {
          method: "PUT",
          headers: { "Content-Type": "application/octet-stream" },
          body: file,
        });
        onProgress?.(1);
        return res;
      }
      const { uploadUrl } = await call<{ uploadUrl: string }>(
        `${target}/createUploadSession`,
        jsonInit("POST", { item: { "@microsoft.graph.conflictBehavior": "fail" } }),
      );
      for (let start = 0; ; start += CHUNK) {
        const end = Math.min(start + CHUNK, file.size);
        const res = await send(
          uploadUrl,
          { method: "PUT", headers: { "Content-Range": `bytes ${start}-${end - 1}/${file.size}` }, body: file.slice(start, end) },
          false,
        );
        onProgress?.(end / file.size);
        if (end === file.size) return res.json();
      }
    },
  };
}

export type Graph = ReturnType<typeof createGraph>;

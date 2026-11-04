import { errorText, type Graph } from "./graph";

export type UploadFailure = { file: File; error: string };

/** Uploads files into parentId; files from a folder picker (webkitRelativePath) recreate their folder tree. */
export async function uploadMany(
  graph: Graph,
  driveId: string,
  parentId: string,
  files: File[],
  onProgress: (file: File, fraction: number) => void,
): Promise<UploadFailure[]> {
  const failures: UploadFailure[] = [];
  // folder path -> id, or the error text if that folder could not be created
  const folders = new Map<string, { id: string } | { error: string }>([["", { id: parentId }]]);

  async function folderFor(path: string): Promise<{ id: string } | { error: string }> {
    const known = folders.get(path);
    if (known) return known;
    const cut = path.lastIndexOf("/");
    const name = path.slice(cut + 1);
    const parent = await folderFor(cut < 0 ? "" : path.slice(0, cut));
    let result: { id: string } | { error: string };
    if ("error" in parent) result = parent;
    else {
      try {
        result = { id: (await graph.createFolder(driveId, parent.id, name)).id };
      } catch (e) {
        result = { error: errorText(e, name) };
      }
    }
    folders.set(path, result);
    return result;
  }

  for (const file of files) {
    const rel = file.webkitRelativePath || file.name;
    const folder = await folderFor(rel.split("/").slice(0, -1).join("/"));
    if ("error" in folder) {
      failures.push({ file, error: folder.error });
      continue;
    }
    try {
      await graph.uploadFile(driveId, folder.id, file, (f) => onProgress(file, f));
    } catch (e) {
      failures.push({ file, error: errorText(e, file.name) });
    }
  }
  return failures;
}

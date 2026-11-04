import type { DriveItem } from "./graph";

export type ViewKind = "image" | "video" | "audio" | "text";

const EXT: Record<string, ViewKind> = {};
for (const [kind, exts] of Object.entries({
  image: "jpg jpeg png gif webp avif bmp svg heic heif",
  video: "mp4 m4v mov webm",
  audio: "mp3 m4a aac wav ogg oga flac opus",
  text: "txt md csv json log xml",
}))
  for (const e of exts.split(" ")) EXT[e] = kind as ViewKind;

/** What the in-app viewer can show for this item, or null to open it in OneDrive. */
export function viewKind(item: DriveItem): ViewKind | null {
  if (!item.file) return null;
  const dot = item.name.lastIndexOf(".");
  const byExt = dot > 0 ? EXT[item.name.slice(dot + 1).toLowerCase()] : undefined;
  if (byExt) return byExt;
  const mime = item.file.mimeType ?? "";
  const top = mime.split("/")[0];
  if (top === "image" || top === "video" || top === "audio") return top;
  return mime === "text/plain" ? "text" : null;
}

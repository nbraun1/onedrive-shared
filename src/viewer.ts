import { dialog, h } from "./dom";
import type { DriveItem, Graph } from "./graph";

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

const TEXT_LIMIT = 1024 * 1024;
const BLOB_LIMIT = 200 * 1024 * 1024; // larger files would exhaust an iPhone's memory as a blob

/** Reads at most `limit` bytes of a text body and cancels the rest of the download. */
export async function readStart(res: Response, limit: number): Promise<{ text: string; cut: boolean }> {
  if (!res.body) return { text: "", cut: false };
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let got = 0;
  let cut = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    got += value.length;
    if (got >= limit) {
      cut = true;
      await reader.cancel();
      break;
    }
  }
  const bytes = new Uint8Array(Math.min(got, limit));
  let at = 0;
  for (const p of parts) {
    const take = p.subarray(0, bytes.length - at);
    bytes.set(take, at);
    at += take.length;
  }
  return { text: new TextDecoder().decode(bytes), cut };
}

/** Full-screen viewer over the viewable files of a folder, starting at files[start]. */
export function openViewer(graph: Graph, driveId: string, files: DriveItem[], start: number) {
  let index = start;
  let seq = 0; // increments per shown file; stale async results compare against it
  let blob: Blob | null = null;

  const title = h("span", { className: "title" });
  const counter = h("span", { className: "counter" });
  const save = h("button", { onclick: () => onSave() }, "Save");
  const openInOneDrive = () => window.open(files[index].webUrl, "_blank", "noopener");
  const stage = h("div", { className: "stage" });
  const prev = h("button", { className: "nav prev", "aria-label": "Previous", onclick: () => go(index - 1) }, "‹");
  const next = h("button", { className: "nav next", "aria-label": "Next", onclick: () => go(index + 1) }, "›");
  const d = dialog(
    h("div", { className: "bar" }, title, counter, save, h("button", { onclick: openInOneDrive }, "Open in OneDrive"), h("button", { onclick: () => d.close() }, "Close")),
    stage,
    prev,
    next,
  );
  d.className = "viewer";
  d.setAttribute("aria-label", "Viewer");
  d.addEventListener("close", clearStage);
  d.addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft") go(index - 1);
    if (e.key === "ArrowRight") go(index + 1);
  });

  let swipe: { x: number; y: number } | null = null;
  stage.addEventListener("pointerdown", (e) => {
    if (!e.isPrimary) {
      swipe = null; // a second finger means pinch-zoom, not a swipe
      return;
    }
    const t = e.target;
    if (t instanceof HTMLMediaElement) {
      const r = t.getBoundingClientRect();
      if (e.clientY > r.top + r.height * 0.75) return; // the controls live at the bottom
    }
    swipe = { x: e.clientX, y: e.clientY };
  });
  stage.addEventListener("pointerup", (e) => {
    if (!swipe || !e.isPrimary) return;
    const dx = e.clientX - swipe.x;
    const dy = e.clientY - swipe.y;
    swipe = null;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) go(index + (dx < 0 ? 1 : -1));
  });
  stage.addEventListener("pointercancel", () => (swipe = null));

  function go(i: number) {
    if (i < 0 || i >= files.length || i === index) return;
    index = i;
    show();
  }

  function clearStage() {
    stage.querySelectorAll("video, audio").forEach((m) => {
      const media = m as HTMLMediaElement;
      media.pause();
      media.removeAttribute("src");
      media.load();
    });
    stage.replaceChildren();
  }

  function fail(my: number) {
    if (my !== seq) return;
    clearStage();
    stage.append(h("div", { className: "hint" }, h("p", {}, "Can't show this file here"), h("button", { onclick: openInOneDrive }, "Open in OneDrive")));
  }

  async function show() {
    const my = ++seq;
    const item = files[index];
    blob = null;
    save.textContent = "Save";
    save.disabled = true; // until the file has loaded
    title.textContent = item.name;
    counter.textContent = `${index + 1} / ${files.length}`;
    prev.disabled = index === 0;
    next.disabled = index === files.length - 1;
    clearStage();
    stage.append(h("p", { className: "hint" }, "Loading…"));
    let src: string;
    try {
      src = await graph.getDownloadUrl(driveId, item.id); // fresh each time: these URLs expire
    } catch {
      return fail(my);
    }
    if (my !== seq) return;
    save.disabled = false;
    const kind = viewKind(item);
    let el: HTMLElement;
    if (kind === "image") el = h("img", { src, alt: item.name, draggable: false, onerror: () => fail(my) });
    else if (kind === "video" || kind === "audio")
      el = h(kind, { src, controls: true, playsInline: true, preload: "metadata", onerror: () => fail(my) });
    else {
      let start: { text: string; cut: boolean };
      try {
        start = await readStart(await fetchStart(src), TEXT_LIMIT);
      } catch {
        return fail(my);
      }
      if (my !== seq) return;
      const cut = start.cut || (item.size ?? 0) > TEXT_LIMIT;
      el = h("div", { className: "text" }, h("pre", {}, start.text), cut && h("p", { className: "hint" }, "Only the first 1 MB is shown."));
    }
    stage.replaceChildren(el);
  }

  async function fetchStart(src: string): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(src, { headers: { Range: `bytes=0-${TEXT_LIMIT - 1}` } });
    } catch {
      res = await fetch(src); // in case the host rejects the Range header's CORS preflight
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res;
  }

  async function onSave() {
    const item = files[index];
    if (blob) return shareBlob(blob, item.name);
    const my = seq;
    if ((item.size ?? 0) > BLOB_LIMIT) {
      // Open the window inside the tap (popup blockers), then point it at a fresh URL.
      const w = window.open("", "_blank");
      try {
        const fresh = await graph.getDownloadUrl(driveId, item.id);
        if (w) w.location.href = fresh;
        else window.location.href = fresh;
      } catch {
        w?.close();
        save.textContent = "Save failed, retry";
      }
      return;
    }
    save.disabled = true;
    try {
      // The URL from when the file was shown may have expired if the app sat open for a while.
      const res = await fetch(await graph.getDownloadUrl(driveId, item.id));
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const total = Number(res.headers.get("Content-Length")) || item.size || 0;
      const chunks: Uint8Array[] = [];
      let got = 0;
      for (const reader = res.body.getReader(); ; ) {
        const { done, value } = await reader.read();
        if (done) break;
        if (my !== seq) return;
        chunks.push(value);
        got += value.length;
        if (total) save.textContent = `Preparing… ${Math.round((got / total) * 100)}%`;
      }
      if (my !== seq) return;
      blob = new Blob(chunks as BlobPart[], { type: res.headers.get("Content-Type") ?? "" });
      save.textContent = "Save / Share"; // iOS only allows share() directly inside a tap, hence the second tap
    } catch {
      if (my === seq) save.textContent = "Save failed, retry";
    } finally {
      if (my === seq) save.disabled = false;
    }
  }

  async function shareBlob(b: Blob, name: string) {
    const file = new File([b], name, { type: b.type });
    if (navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file] });
      } catch (e) {
        if ((e as Error).name !== "AbortError") save.textContent = "Save failed, retry";
      }
      return;
    }
    const a = h("a", { href: URL.createObjectURL(b), download: name });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  }

  show();
}

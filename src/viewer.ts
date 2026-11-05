import { dialog, h } from "./dom";
import { GraphError, type DriveItem, type Graph } from "./graph";

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

const LISTING_URL_TTL = 50 * 60_000; // OneDrive's download URLs live about an hour

/** The download URL that came with the folder listing, while it is still fresh. */
export function listingUrl(item: DriveItem, listedAt: number, now: number): string | null {
  if (now - listedAt >= LISTING_URL_TTL) return null;
  return item["@microsoft.graph.downloadUrl"] ?? item["@content.downloadUrl"] ?? null;
}

/** The biggest thumbnail that came with the listing; shown instantly while the original loads. */
export function previewUrl(item: DriveItem): string | null {
  const t = item.thumbnails?.[0];
  return t?.large?.url ?? t?.medium?.url ?? t?.small?.url ?? null;
}

export function slideWindow(index: number, count: number, radius = 2): number[] {
  const out: number[] = [];
  for (let i = Math.max(0, index - radius); i <= Math.min(count - 1, index + radius); i++) out.push(i);
  return out;
}

const TEXT_LIMIT = 1024 * 1024;
const BLOB_LIMIT = 200 * 1024 * 1024; // larger files would exhaust an iPhone's memory as a blob
const ZOOM_STEP = 1.25;
const MAX_ZOOM = 8;

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

/** Full-screen carousel over the viewable files of a folder, starting at files[start]. */
export function openViewer(graph: Graph, driveId: string, files: DriveItem[], start: number, listedAt: number) {
  let index = start;
  let seq = 0; // increments whenever another file becomes current; stale async results compare against it
  let blob: Blob | null = null;
  let animating: { to: number; timer: number } | null = null;
  const urls = new Map<string, { url: Promise<string>; at: number }>(); // item id -> download URL, resolved once per TTL
  let closed = false;
  const slides = new Map<number, HTMLElement>(); // only index-1..index+1 exist
  const warmed = new Set<number>();
  const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const mouse = window.matchMedia?.("(hover: hover) and (pointer: fine)").matches; // desktop zoom; phones pinch the page
  let zoom = { s: 1, x: 0, y: 0 }; // x/y: pan in px from the centre

  const title = h("span", { className: "title" });
  const counter = h("span", { className: "counter" });
  const save = h("button", { onclick: () => onSave() }, "Save");
  const openInOneDrive = () => window.open(files[index].webUrl, "_blank", "noopener");
  const track = h("div", { className: "track" });
  const stage = h("div", { className: "stage" }, track);
  const prev = h("button", { className: "nav prev", "aria-label": "Previous", onclick: () => step(-1) }, "‹");
  const next = h("button", { className: "nav next", "aria-label": "Next", onclick: () => step(1) }, "›");
  const zoomOut = h("button", { "aria-label": "Zoom out", onclick: () => zoomTo(zoom.s / ZOOM_STEP) }, "−");
  const zoomIn = h("button", { "aria-label": "Zoom in", onclick: () => zoomTo(zoom.s * ZOOM_STEP) }, "+");
  const fit = h("button", { "aria-label": "Fit", onclick: () => zoomTo(1) }, "Fit");
  const d = dialog(
    h("div", { className: "bar" }, title, counter, mouse && zoomOut, mouse && zoomIn, mouse && fit, save, h("button", { onclick: openInOneDrive }, "Open in OneDrive"), h("button", { onclick: () => d.close() }, "Close")),
    stage,
    prev,
    next,
  );
  d.className = "viewer";
  d.setAttribute("aria-label", "Viewer");
  // On window, not the dialog: focus can fall back to <body> when the focused Save button gets disabled.
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowLeft") step(-1);
    if (e.key === "ArrowRight") step(1);
    if (!mouse || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === "+" || e.key === "=") zoomTo(zoom.s * ZOOM_STEP);
    if (e.key === "-") zoomTo(zoom.s / ZOOM_STEP);
    if (e.key === "0") zoomTo(1);
    const video = zoom.s > 1 && slides.get(index)?.querySelector("video");
    if (e.key === " " && video) {
      e.preventDefault(); // a focused video would toggle itself as well
      if (video.paused) void video.play();
      else video.pause();
    }
  };
  window.addEventListener("keydown", onKey);
  // pinch-zoomed on a phone: one finger must pan sideways too, not only up and down (see .zoomed in style.css)
  const onViewport = () => d.classList.toggle("zoomed", (window.visualViewport?.scale ?? 1) > 1);
  onViewport();
  window.visualViewport?.addEventListener("resize", onViewport);
  d.addEventListener("close", () => {
    closed = true;
    seq++; // stops a running Save and late async results
    if (animating) clearTimeout(animating.timer);
    animating = null;
    window.removeEventListener("keydown", onKey);
    window.visualViewport?.removeEventListener("resize", onViewport);
    for (const i of [...slides.keys()]) drop(i);
  });

  const describe = (e: unknown) =>
    e instanceof GraphError && e.status > 0 ? `OneDrive error ${e.status} (${e.code}): ${e.message}` : e instanceof Error ? e.message : String(e);

  function urlFor(item: DriveItem, fresh = false): Promise<string> {
    const cached = urls.get(item.id);
    if (!fresh && cached && Date.now() - cached.at < LISTING_URL_TTL) return cached.url;
    const listed = fresh ? null : listingUrl(item, listedAt, Date.now());
    const url = listed ? Promise.resolve(listed) : graph.getDownloadUrl(driveId, item.id);
    const entry = { url, at: listed ? listedAt : Date.now() };
    url.catch(() => urls.get(item.id) === entry && urls.delete(item.id)); // let a later attempt retry
    urls.set(item.id, entry);
    return url;
  }

  const message = (lines: string[]) =>
    h("div", { className: "hint" }, ...lines.map((l, i) => h("p", { className: i ? "reason" : "" }, l)), h("button", { onclick: openInOneDrive }, "Open in OneDrive"));

  /* ---------- slides ---------- */

  function build(i: number): HTMLElement {
    const item = files[i];
    const kind = viewKind(item);
    const slide = h("div", { className: "slide" });
    const live = () => slides.get(i) === slide; // false once dropped: late URLs must not start downloads
    const poster = previewUrl(item);
    if (kind === "image") {
      const preview = h("img", { className: "preview", alt: "", draggable: false });
      const note = h("p", { className: "note", hidden: true });
      const img = h("img", { className: "original loading", alt: item.name, draggable: false, decoding: "async" });
      slide.append(preview, img, note);
      const showPreview = (src: string) => (preview.src = src);
      if (poster) showPreview(poster);
      const fallback = async (reason: string) => {
        img.remove();
        if (!preview.getAttribute("src")) {
          try {
            showPreview(await graph.getPreviewImageUrl(driveId, item.id));
          } catch (e) {
            return slide.replaceChildren(message(["Can't show this file here", `${reason}; preview: ${describe(e)}`]));
          }
        }
        note.textContent = `Showing preview — original couldn't load (${reason})`;
        note.hidden = false;
      };
      let retried = false;
      img.onload = () => {
        img.classList.remove("loading");
        preview.remove();
      };
      img.onerror = () => {
        // A listing URL may have expired early: try once more with a fresh one.
        if (!retried) {
          retried = true;
          urlFor(item, true).then((u) => live() && (img.src = u), (e) => void (live() && fallback(`Download link: ${describe(e)}`)));
        } else fallback("Image could not be loaded");
      };
      urlFor(item).then((u) => live() && (img.src = u), (e) => void (live() && fallback(`Download link: ${describe(e)}`)));
    } else if (kind === "video" || kind === "audio") {
      const media = h(kind, { controls: true, playsInline: true, preload: "none" });
      if (kind === "video" && poster) media.setAttribute("poster", poster);
      media.onerror = () =>
        slide.replaceChildren(message(["Can't show this file here", `${kind === "video" ? "Video" : "Audio"} could not be played (code ${media.error?.code ?? "?"})`]));
      slide.append(media);
      urlFor(item).then(
        (u) => live() && (media.src = u),
        (e) => live() && slide.replaceChildren(message(["Can't show this file here", `Download link: ${describe(e)}`])),
      );
    } else slide.append(h("p", { className: "hint" }, item.name)); // text loads only when it becomes current
    return slide;
  }

  async function loadText(i: number, slide: HTMLElement) {
    const item = files[i];
    const my = seq;
    slide.replaceChildren(h("p", { className: "hint" }, "Loading…"));
    try {
      const startText = await readStart(await fetchStart(await urlFor(item)), TEXT_LIMIT);
      if (my !== seq) return;
      const cut = startText.cut || (item.size ?? 0) > TEXT_LIMIT;
      slide.replaceChildren(h("div", { className: "text" }, h("pre", {}, startText.text), cut && h("p", { className: "hint" }, "Only the first 1 MB is shown.")));
    } catch (e) {
      if (my === seq) slide.replaceChildren(message(["Can't show this file here", `Text: ${describe(e)}`]));
    }
  }

  function drop(i: number) {
    const slide = slides.get(i);
    if (!slide) return;
    slide.querySelectorAll("video, audio").forEach((m) => {
      const media = m as HTMLMediaElement;
      media.pause();
      media.removeAttribute("src");
      media.load();
    });
    slide.querySelectorAll("img").forEach((img) => img.removeAttribute("src")); // frees decoded memory on iOS
    slide.remove();
    slides.delete(i);
  }

  /** Lays out index-1..index+1, drops everything else and warms the cache for photos at index±2. */
  function render() {
    const keep = new Set(slideWindow(index, files.length, 1));
    for (const i of [...slides.keys()]) if (!keep.has(i)) drop(i);
    for (const i of keep) {
      let slide = slides.get(i);
      if (!slide) {
        slide = build(i);
        slides.set(i, slide);
        track.append(slide);
      }
      slide.style.transform = `translateX(${(i - index) * 100}%)`;
      slide.classList.toggle("current", i === index);
      slide.inert = i !== index;
      slide.querySelectorAll("video, audio").forEach((m) => {
        const media = m as HTMLMediaElement;
        if (i === index) media.preload = "metadata";
        else media.pause();
      });
    }
    for (const i of slideWindow(index, files.length, 2))
      if (!keep.has(i) && !warmed.has(i) && viewKind(files[i]) === "image") {
        warmed.add(i);
        urlFor(files[i]).then((u) => !closed && Math.abs(i - index) <= 2 && (new Image().src = u), () => {});
      }
    const current = slides.get(index)!;
    const item = files[index];
    blob = null;
    save.textContent = "Save";
    save.disabled = true;
    const my = seq;
    const enable = () => my === seq && (save.disabled = false); // Save fetches its own fresh URL anyway
    urlFor(item).then(enable, enable);
    title.textContent = item.name;
    counter.textContent = `${index + 1} / ${files.length}`;
    prev.disabled = index === 0;
    next.disabled = index === files.length - 1;
    if (viewKind(item) === "text" && !current.querySelector("pre, .hint button")) loadText(index, current);
    d.classList.toggle("photo", viewKind(item) === "image"); // photos take every touch: the app pinches and pans them
    applyZoom();
  }

  /* ---------- zoom (desktop buttons/wheel/keys; pinch on photos) ---------- */

  const zoomable = () => [...(slides.get(index)?.querySelectorAll<HTMLElement>("img, video") ?? [])];

  function applyZoom() {
    const els = zoomable();
    if (!els.length) zoom = { s: 1, x: 0, y: 0 }; // e.g. a video that failed and became a message
    // the visible picture, not the element: a photo's <img> fills the stage, its pixels are letterboxed inside
    const W = stage.clientWidth;
    const H = stage.clientHeight;
    let cw = 0;
    let ch = 0;
    for (const el of els) {
      const img = el instanceof HTMLImageElement && el.naturalWidth ? el : null;
      const f = img ? Math.min(W / img.naturalWidth, H / img.naturalHeight) : 1;
      cw = Math.max(cw, img ? img.naturalWidth * f : el.offsetWidth);
      ch = Math.max(ch, img ? img.naturalHeight * f : el.offsetHeight);
    }
    const mx = Math.max(0, (zoom.s * cw - W) / 2);
    const my = Math.max(0, (zoom.s * ch - H) / 2);
    zoom.x = Math.max(-mx, Math.min(mx, zoom.x)); // keep the photo on the stage
    zoom.y = Math.max(-my, Math.min(my, zoom.y));
    const t = zoom.s === 1 ? "" : `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.s})`;
    for (const el of els) {
      el.style.transform = t;
      if (el instanceof HTMLVideoElement) el.controls = zoom.s === 1; // the controls would scale and move away
    }
    zoomOut.disabled = fit.disabled = zoom.s === 1;
    zoomIn.disabled = !els.length || zoom.s >= MAX_ZOOM;
  }

  /** (px, py): the point, relative to the stage centre, that stays where it is. */
  function zoomTo(s: number, px = 0, py = 0) {
    const to = s < 1.01 ? 1 : Math.min(MAX_ZOOM, s);
    const k = to / zoom.s;
    zoom = { s: to, x: px - (px - zoom.x) * k, y: py - (py - zoom.y) * k };
    applyZoom();
  }

  if (mouse)
    stage.addEventListener(
      "wheel",
      (e) => {
        if (e.ctrlKey || !e.deltaY || !zoomable().length) return; // Ctrl+wheel stays the browser's page zoom
        e.preventDefault();
        const r = stage.getBoundingClientRect();
        const dy = e.deltaY * (e.deltaMode === 1 ? 33 : 1); // Firefox reports lines
        // by distance, so a mouse notch (100 px) is one step and a trackpad's many small events add up the same
        zoomTo(zoom.s * ZOOM_STEP ** (-dy / 100), e.clientX - r.left - r.width / 2, e.clientY - r.top - r.height / 2);
      },
      { passive: false },
    );

  /* ---------- moving ---------- */

  const setTrack = (px: number, animate: boolean) => {
    track.style.transition = animate && !reduceMotion ? "transform 200ms ease-out" : "none";
    track.style.transform = `translateX(${px}px)`;
  };

  function finish() {
    if (!animating) return;
    clearTimeout(animating.timer);
    index = animating.to;
    animating = null;
    seq++;
    setTrack(0, false);
    void track.offsetWidth; // flush, so a following animation starts from the new layout
    render();
  }

  /** Relative to where the viewer ends up: a press during an animation completes it first. */
  function step(delta: number) {
    finish();
    const i = index + delta;
    if (i < 0 || i >= files.length || i === index) return setTrack(0, true);
    zoomTo(1); // the next file starts at fit
    const width = stage.clientWidth;
    animating = { to: i, timer: window.setTimeout(finish, reduceMotion ? 0 : 200) };
    setTrack((index - i) * width, true);
  }

  let drag: { id: number; x: number; y: number; dx: number; horizontal: boolean | null; pan?: { x: number; y: number } } | null = null;
  // The app pinches photos itself: iOS page zoom locks one-finger moves to one axis.
  const touches = new Map<number, { x: number; y: number }>();
  let pinch: { dist: number; mid: { x: number; y: number }; z: typeof zoom } | null = null;
  const pair = () => {
    const [a, b] = [...touches.values()];
    const r = stage.getBoundingClientRect();
    return { dist: Math.hypot(a.x - b.x, a.y - b.y), mid: { x: (a.x + b.x) / 2 - r.left - r.width / 2, y: (a.y + b.y) / 2 - r.top - r.height / 2 } };
  };
  /** A finger left: below two, the pinch ends and a remaining finger keeps panning (never a tap or a swipe). */
  const untouch = (id: number) => {
    touches.delete(id);
    if (!pinch || touches.size >= 2) return false;
    pinch = null;
    const [rest] = [...touches.entries()];
    drag = rest && zoom.s > 1 ? { id: rest[0], ...rest[1], dx: 0, horizontal: false, pan: { x: zoom.x, y: zoom.y } } : null;
    return true;
  };
  stage.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "touch") touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (touches.size === 2 && d.classList.contains("photo") && zoomable().length) {
      if (drag?.horizontal) setTrack(0, true);
      drag = null;
      pinch = { ...pair(), z: { ...zoom } };
      return;
    }
    if (!e.isPrimary) {
      drag = null; // a second finger means pinch-zoom, not a swipe
      return;
    }
    if (e.button !== 0) return; // a right-click opens the context menu, its pointerup may never come
    if (zoom.s > 1) {
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY, dx: 0, horizontal: null, pan: { x: zoom.x, y: zoom.y } }; // zoomed: drag pans
      return;
    }
    const t = e.target;
    if (t instanceof HTMLMediaElement) {
      const r = t.getBoundingClientRect();
      if (e.clientY > r.top + r.height * 0.75) return; // the controls live at the bottom
    }
    if ((window.visualViewport?.scale ?? 1) > 1) return; // zoomed in: one finger pans the photo
    finish();
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, dx: 0, horizontal: null };
  });
  stage.addEventListener("pointermove", (e) => {
    if (touches.has(e.pointerId)) touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch) {
      if (touches.size < 2) return;
      const { dist, mid } = pair();
      const raw = (pinch.z.s * dist) / pinch.dist;
      const s = raw < 1.01 ? 1 : Math.min(MAX_ZOOM, raw);
      const k = s / pinch.z.s; // the photo point that was under the fingers' midpoint follows it
      zoom = { s, x: mid.x - (pinch.mid.x - pinch.z.x) * k, y: mid.y - (pinch.mid.y - pinch.z.y) * k };
      return applyZoom();
    }
    if (!drag || e.pointerId !== drag.id) return;
    if (e.pointerType === "mouse" && !e.buttons) {
      // released where the stage didn't see it (e.g. over the bar): don't follow a hovering mouse
      if (drag.horizontal) setTrack(0, true);
      drag = null;
      return;
    }
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (drag.pan) {
      if (drag.horizontal === null && Math.abs(dx) + Math.abs(dy) > 8) {
        drag.horizontal = false; // moved: not a tap, and never a swipe
        stage.setPointerCapture?.(e.pointerId);
      }
      if (drag.horizontal === false) {
        zoom.x = drag.pan.x + dx;
        zoom.y = drag.pan.y + dy;
        applyZoom();
      }
      return;
    }
    if (drag.horizontal === null && Math.abs(dx) + Math.abs(dy) > 8) {
      drag.horizontal = Math.abs(dx) > Math.abs(dy);
      // only now: capturing at pointerdown would steal the click from buttons inside the slide
      if (drag.horizontal) stage.setPointerCapture?.(e.pointerId); // keep getting the release outside the photo
    }
    if (!drag.horizontal) return;
    const edge = (dx > 0 && index === 0) || (dx < 0 && index === files.length - 1);
    drag.dx = edge ? dx / 3 : dx; // resist past the first and last file
    setTrack(drag.dx, false);
  });
  stage.addEventListener("pointerup", (e) => {
    if (untouch(e.pointerId) || !drag || e.pointerId !== drag.id) return;
    const { dx, horizontal } = drag;
    drag = null;
    if (horizontal === null) {
      // a tap on the photo/video toggles focus mode; taps on buttons or text do their own thing
      if (!(e.target as Element).closest("button, a, .text")) d.classList.toggle("immersive");
      return;
    }
    if (!horizontal) return;
    if (Math.abs(dx) > stage.clientWidth * 0.2) step(dx < 0 ? 1 : -1);
    else setTrack(0, true);
  });
  stage.addEventListener("pointercancel", (e) => {
    untouch(e.pointerId);
    drag = null;
    setTrack(0, true);
  });

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
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (my !== seq) return void reader.cancel(); // swiped away or closed: stop downloading
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

  render();
  return d;
}

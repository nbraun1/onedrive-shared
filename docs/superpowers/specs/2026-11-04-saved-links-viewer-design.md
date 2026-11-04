# Saved links + in-app viewer design (2026-11-04)

## Context

v1 is live and works on the user's iPhone (sign-in + link load confirmed). The user wants (1) multiple saved, named links to switch between easily, (2) an in-app viewer for browser-supported files, especially images and videos. Answers: swipe + arrows between files: yes; thumbnails in list: yes; download/"Save to Photos" button: yes.

## Design

- **Saved links** — localStorage key `shares`: `SavedShare[]` where `SavedShare = { id: string; label: string; driveId: string; itemId: string; name: string; canEdit: boolean }`; key `lastShare` = id of the last opened. Old v1 key `share` is migrated once into the list (label = folder name) and removed.
  - App start: open `lastShare` if it exists, else the **Links screen**.
  - **Links screen** (also via ☰ → "Links"): list of saved links (label, folder name below), tap opens; per-row `⋯` → Rename / Remove (confirm "Remove 'X'? Files in OneDrive are not affected."). Form at the bottom: **Name** (optional, defaults to folder name) + **Share link** + "Add".
  - Adding a link that resolves to an already saved `driveId+itemId` → no duplicate; opens it and toasts "Already saved as 'X'".
  - Label: trimmed, 1–60 chars; empty → folder name.
  - Removing the open link → Links screen. ☰ menu: "Links", "Sign out" ("Change link" is replaced by "Links").
  - Header breadcrumb root shows the **label**, not the folder name.
- **Thumbnails** — `listChildren` adds `$expand=thumbnails`; row icon = `<img loading="lazy" alt="">` from `thumbnails[0].small.url` when present, else 📁/📄. Broken thumbnail (`onerror`) → falls back to the emoji.
- **Viewer** — tapping a file:
  - `viewKind(item)` → `"image" | "video" | "audio" | "text" | null` from `item.file.mimeType`, else extension (case-insensitive). image: jpg jpeg png gif webp avif bmp svg heic heif; video: mp4 m4v mov webm; audio: mp3 m4a aac wav ogg oga flac opus; text: txt md csv json log xml. `null` → today's behavior (open `webUrl`).
  - Full-screen `<dialog>`: top bar = name, counter "3 / 12", **Save**, **Open in OneDrive**, **Close**; content area; ‹ › arrow buttons. Swipe left/right (pointer events, |dx| > 50 px and |dx| > |dy|) and keyboard ←/→/Esc.
  - Navigation covers the **viewable files of the current folder** in list order; arrows disabled at the ends (no wrap).
  - Source: `graph.getDownloadUrl(driveId, id)` = `GET /drives/{d}/items/{id}?$select=id,@microsoft.graph.downloadUrl`, fetched when a file is shown (URLs expire after ~1 h). Video/audio use `controls playsinline preload="metadata"`; leaving a file pauses + clears the previous media `src`.
  - Media `error` event (e.g. codec unsupported) / text fetch failure / download-URL failure → message "Can't show this file here" + "Open in OneDrive" button. Text is fetched with `Range: bytes=0-1048575`; if the file is larger than 1 MB a note says only the start is shown.
  - Swipes starting in the bottom 25 % of a `<video>`/`<audio>` element are ignored (that's where the controls/scrubber are).
  - **Save**: fetch the blob from the download URL with a progress label ("Preparing… 45%"), then the button becomes "Save / Share"; tapping it calls `navigator.share({ files: [new File([blob], name, { type })] })` (iOS share sheet → "Save Image/Video"). Two taps because iOS requires `share()` directly in a tap. If `navigator.canShare?.({files})` is false → `<a download>` with an object URL (desktop). Share `AbortError` (user cancelled) is silent. Blob dropped when the file changes or the viewer closes. Files > 200 MB skip the blob (would exhaust iPhone memory): Save opens the download URL directly (`window.open`) and iOS offers its own download.
- **Non-goals:** PDF/Office preview (→ Open in OneDrive), syncing saved links across devices, zoom gestures beyond the browser's own, slideshow.


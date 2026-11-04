# onedrive-shared v2: Saved Links + In-App Viewer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (native, as in v1). Steps use checkbox (`- [ ]`) syntax.

**Goal:** Save several share links under user-chosen names and switch between them; view images, videos, audio and text files inside the app (swipe/arrows between them, save to Photos); show thumbnails in the folder list.

**Architecture:** Same static Vite/TS PWA in `/home/nbraun/git/nbraun1/onedrive-shared`. Saved links live in localStorage (`src/shares.ts`, pure + unit tested). Viewer (`src/viewer.ts`) gets a fresh pre-authenticated `@microsoft.graph.downloadUrl` per file and sets it as `<img>/<video>/<audio>` src (streams, no auth header, Range works); text files are fetched from that URL (Graph documents it as CORS-enabled). Thumbnails via `$expand=thumbnails` on the existing children call.

**Tech Stack:** unchanged (Vite, TypeScript, MSAL, Vitest, Playwright). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-04-saved-links-viewer-design.md` (written in Task 1 from "Design" below).

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

## Global Constraints

- Only Microsoft Graph OneDrive endpoints (+ OneDrive's own pre-authenticated download/thumbnail URLs it returns).
- Names/labels rendered via `textContent` only (`h()` helper).
- No new runtime or dev dependencies.
- Commit and push to `main` at the end (user's standing instruction for this repo); CI deploys.

## Review Focus

1. Corrupt/foreign JSON in `shares` localStorage → app still starts (empty list), unit test in Task 2.
2. Download URL expired between listing and viewing → viewer fetches a fresh URL per view (e2e: URL from fake changes per call, viewer uses newest).
3. Uppercase extensions / missing mimeType (`IMG_0001.HEIC`, `clip.MOV`) → still viewable (unit test Task 3).
4. Fast swiping while a URL request is in flight → shown file matches counter (guard by sequence number, e2e Task 4 with delay).
5. Video file the browser can't decode → message + Open in OneDrive, not a black box (e2e: fake serves garbage bytes as video).

---

### Task 1: Spec + `src/dom.ts` extraction

**Files:** Create `docs/superpowers/specs/2026-11-04-saved-links-viewer-design.md` (Design section above), `docs/superpowers/plans/2026-11-04-saved-links-viewer.md` (this plan); Create `src/dom.ts`; Modify `src/main.ts`.

**Produces:** `src/dom.ts` exports `h` (moved unchanged) and `dialog(...children: Node[]): HTMLDialogElement` (moved unchanged) so `viewer.ts` can use them.

- [ ] Move `h` and `dialog` from `main.ts` to `dom.ts`, import them. Run `npx tsc && npx vitest run && npx playwright test` → all green (pure move, existing 70 + 22 tests are the gate). Commit.

### Task 2: Saved links store (`src/shares.ts`)

**Produces:**
- `type SavedShare = { id; label; driveId; itemId; name; canEdit }`
- `loadShares(storage: Storage = localStorage): SavedShare[]` — parses `shares`; non-array / bad JSON → `[]`; drops entries missing `id/driveId/itemId`; migrates legacy `share` (adds with `label = name`, removes `share`, saves).
- `saveShares(list, storage = localStorage): void`
- `addShare(list, s: Omit<SavedShare,"id"|"label">, label: string): { list: SavedShare[]; share: SavedShare; existed: boolean }` — dedupe on `driveId+itemId`; `label.trim() || s.name`, cut to 60.
- `renameShare(list, id, label): SavedShare[]`, `removeShare(list, id, storage = localStorage): SavedShare[]` (also clears `lastShare` if it pointed at `id`)
- Start logic: `lastShare` id not in the list → Links screen.
- `validateLabel(label: string): string | null` — >60 chars → "Name is too long (max 60 characters)"; else null (empty allowed = folder name).

- [ ] Tests `src/shares.test.ts` (in-memory `Storage` fake): bad JSON → `[]`; `{}` → `[]`; entry without driveId dropped; legacy `share` migrated once and key removed; add new → `existed:false`, id set, label default = folder name; add same driveId+itemId → `existed:true`, list length unchanged; label `"  Urlaub  "` trimmed; 61 chars rejected by `validateLabel`; rename/remove by id; unknown id → list unchanged; removing the `lastShare` id clears `lastShare`.
- [ ] Run → fail; implement (ids via `crypto.randomUUID()`); run → pass; commit.

### Task 3: Graph additions + `viewKind` (`src/graph.ts`, `src/viewer.ts`)

**Produces:**
- `DriveItem` gains `file?: { mimeType?: string }`, `thumbnails?: { small?: { url: string } }[]`.
- `listChildren` URL becomes `/drives/{d}/items/{id}/children?$top=200&$expand=thumbnails`.
- `graph.getDownloadUrl(driveId: string, id: string): Promise<string>` — throws `GraphError(0,"noDownloadUrl","This file can't be downloaded")` if missing.
- `viewKind(item: DriveItem): "image" | "video" | "audio" | "text" | null` in `src/viewer.ts`.

- [ ] Tests: update existing `listChildren` URL assertion; `getDownloadUrl` requests `/drives/d/items/i?$select=id,@microsoft.graph.downloadUrl` and returns the annotation, missing → GraphError; `viewKind`: `IMG_0001.HEIC` (no mimeType) → image, `clip.MOV` → video, `song.m4a` → audio, `notes.MD` → text, mimeType `image/png` with name `x` → image, `report.pdf` → null, folder → null, name without dot → null.
- [ ] Run → fail; implement; run → pass; commit.

### Task 4: UI — Links screen, thumbnails, viewer (`src/main.ts`, `src/viewer.ts`, `src/style.css`, `e2e/*`)

**Consumes:** Tasks 1–3. **Produces:** `openViewer(graph, driveId: string, files: DriveItem[], index: number): void` in `viewer.ts`.

- [ ] Fake (`e2e/fakeOneDrive.ts`): files get `file.mimeType` by extension and `thumbnails` (`https://thumb.example/{id}`); `GET /drives/D/items/{id}?$select=…` returns `@microsoft.graph.downloadUrl: https://dl.example/{id}?v={n}` (n increments per call); `page.route("https://dl.example/**")` serves a tiny PNG for images, text for `.txt`, garbage bytes for `.mp4`; `page.route("https://thumb.example/**")` serves the PNG; seed root with `photo1.jpg`, `photo2.png`, `clip.mp4`, `notes.txt`, `doc.pdf`; second share link `OTHER_LINK` resolving to `Beta` folder. `state.dlDelayMs` delays the download-URL call.
- [ ] e2e tests (write first, watch fail):
  - links: first start → Links screen; add EDIT_LINK with name "Urlaub" → opens, breadcrumb root "Urlaub"; ☰ → Links → add OTHER_LINK without name → label "Beta"; switch back via tap; rename "Urlaub" → "Ferien"; remove "Beta" (confirm text) → gone; add EDIT_LINK again → toast "Already saved as 'Ferien'", still one entry; reload → reopens last link; legacy `share` key pre-seeded via `addInitScript` → appears in list, key removed; 61-char name → inline error.
  - remove the currently open link → Links screen.
  - thumbnails: `photo1.jpg` row has `img[src^="https://thumb.example/"]`; folder row has none.
  - viewer: tap `photo1.jpg` → dialog with `img` whose src is newest `https://dl.example/…`, counter "1 / 4" (pdf excluded); › → `photo2.png` "2 / 4"; ‹ disabled on first, › disabled on last; keyboard ArrowRight works; swipe (pointer down/move/up dx=-120) → next; tap `notes.txt` → text shown in `pre`; `clip.mp4` (garbage) → "Can't show this file here" + Open in OneDrive; tap `doc.pdf` → no viewer (opens webUrl popup); Esc closes.
  - race: `dlDelayMs=800`, press › twice quickly → final shown file/counter consistent ("3 / 4", src of `clip.mp4`'s URL).
  - save: on desktop context (no `navigator.share`) Save → "Save / Share" → click triggers a Playwright `download` named `photo1.jpg`.
  - download-URL call fails (500) → message + Open in OneDrive.
  - big file (fake `size: 300 MB` on `clip.mp4`) → Save opens a popup to the download URL, no blob fetch.
  - swipe starting in the bottom quarter of the video element → stays on the same file.
  - text request carries `Range: bytes=0-1048575`.
- [ ] Implement: Links screen + ☰ menu change + start logic in `main.ts` using `shares.ts`; thumbnail `<img>` in rows; `openViewer` in `viewer.ts` with sequence-number guard; CSS for full-screen dialog (black background, `object-fit: contain`, safe-area), thumbnails 40×40 `object-fit: cover`.
- [ ] Update existing e2e (`start()` helper adds a link via the Links screen; "Change link" test → "Links"). Run all → pass; `npm run build`; commit.

### Task 5: Review, docs, release

- [ ] README: saved links + viewer section; Graph calls table adds `$expand=thumbnails` and download URL.
- [ ] ponytail-review on the diff + fresh code-reviewer subagent (opus) with Review Focus; fix Critical/Important test-first.
- [ ] Full verification (`npx tsc`, `npx vitest run`, `npx playwright test`, build), push to `main`, watch CI green, check live bundle hash in the browser pane.
- [ ] User checks on iPhone: HEIC photo, iPhone `.mov` video, swipe, Save to Photos.

## Verification

- Unit + e2e suites green locally and in Actions.
- Live site loads new bundle; real-device check by the user (iOS share sheet and HEIC/MOV playback can't be tested in Chromium).

# onedrive-shared Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A PWA (installable on iPhone via Safari "Add to Home Screen", no App Store/Mac) that opens a friend's OneDrive folder from its share link and lets the user browse, delete, upload, rename and move folders and files — using only the Microsoft Graph OneDrive API.

**Architecture:** Static Vite + TypeScript app, no framework, no backend. MSAL (redirect flow, personal accounts) gets a Graph token; the share link is resolved once via `/shares/{token}/driveItem` and the resulting `driveId`/`itemId` is stored in localStorage; all further calls go to `/drives/{driveId}/items/...`. GitHub Actions tests, builds and deploys to GitHub Pages on push to `main`.

**Tech Stack:** Vite, TypeScript, `@azure/msal-browser`, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-04-onedrive-shared-design.md` (written in Task 1 from the "Design" section below).

## Context

User (personal MS account) has a folder shared by a friend (personal MS account) via an edit link. They want to manage it from their iPhone. They own only Windows/Linux devices and no Apple developer account, so a native app is out → PWA on GitHub Pages. Graph's `sharedWithMe` is being retired (degraded now, gone after Nov 2026), so the app uses the share link instead.

## Design (becomes the committed spec)

- **Location:** `/home/nbraun/git/nbraun1/onedrive-shared`, public repo `github.com/nbraun1/onedrive-shared`, live at `https://nbraun1.github.io/onedrive-shared/`.
- **Auth:** MSAL `PublicClientApplication`, authority `https://login.microsoftonline.com/consumers`, scopes `["Files.ReadWrite.All"]`, `loginRedirect`/`acquireTokenSilent` (fallback `acquireTokenRedirect` on `InteractionRequiredAuthError`), cache `localStorage`, redirect URI `location.origin + import.meta.env.BASE_URL`. Client ID from build env `VITE_CLIENT_ID` (GitHub Actions variable `CLIENT_ID`). No secrets anywhere.
- **First run:** paste share link → validate → `GET /shares/{u!base64url}/driveItem` with `Prefer: redeemSharingLink` → must be a folder → `GET /shares/{token}/permission` → `canEdit = roles includes "write"` → store `{driveId, itemId, name, canEdit}` under localStorage key `share`. "Change link" button clears it.
- **Link rules:** must be `https://1drv.ms/...` or `https://onedrive.live.com/...`; `1drv.ms/{u,w,x,p,b,i,v}/` → "This is a file link, not a folder link". Anything else → "Not a OneDrive link". Graph 404/403 on resolve → "OneDrive rejected this link (expired or no access)".
- **Browse:** list (folders first, then files, by name, `localeCompare`), icon, name, size, date; breadcrumb from shared root; tap folder opens it, tap file opens `webUrl` in new tab; paging via `@odata.nextLink`.
- **Actions:** per-row `⋯` → Rename / Move / Delete. "Select" mode with checkboxes → Move / Delete for all selected. Bottom bar: New folder, Upload files (multi-select); **Upload folder** (`<input webkitdirectory>`) only when *not* standalone (`matchMedia('(display-mode: standalone)')` / `navigator.standalone`) and the browser supports `webkitdirectory`.
- **Delete:** confirm dialog ("Delete 'X' and everything in it?" / "Delete N items?"); `DELETE` per item (Graph deletes folder contents recursively → owner's recycle bin).
- **Move:** modal folder picker over the shared tree only; target disabled if it is a selected item or inside one (tracked via picker's id stack), or the current folder.
- **Names (rename/new folder):** trimmed, non-empty, ≤255 chars, none of `" * : < > ? / \ |`, no trailing `.` — validated before calling Graph. Conflicts use `@microsoft.graph.conflictBehavior: "fail"` → shown as "'X' already exists".
- **Upload:** ≤4 MiB → `PUT /drives/{d}/items/{parent}:/{encodeURIComponent(name)}:/content?@microsoft.graph.conflictBehavior=fail`; larger → `createUploadSession` + chunks of 10×320 KiB, sent to `uploadUrl` without auth header. Per-file progress. Folder upload creates folders top-down (path→id cache) then uploads files. Failures are collected and reported; the batch continues.
- **Read-only link:** if `!canEdit`, all modify buttons hidden and a banner says "View-only link".
- **Errors:** Graph wrapper retries 429/503 up to 3× honoring `Retry-After`; maps to `GraphError(status, code, message)`; network failure → "No connection". Toast shows the message.
- **PWA:** `manifest.webmanifest` (name "Shared Drive", `display: standalone`, start_url/scope `./`), `apple-touch-icon` 180×180 PNG, `apple-mobile-web-app-capable`. No service worker (app needs network anyway).
- **Non-goals:** offline mode, multiple shares, file preview/editing, `$batch`, App Store.

## Global Constraints

- Only Microsoft Graph OneDrive endpoints (`graph.microsoft.com/v1.0`) plus MSAL login. No `sharedWithMe`, no other storage API.
- No backend, no secrets committed. Client ID only via `VITE_CLIENT_ID`.
- Vite `base: "/onedrive-shared/"`.
- Push directly to `main` (user request).

## Review Focus

1. Unicode / special chars in names (`Prüfung #1 %.txt`) → upload/rename URL-encode correctly (test in Task 2).
2. Folder with >200 children → all pages loaded (test in Task 2).
3. Move folder into its own subfolder → target disabled (test in Task 4).
4. One upload in a batch fails (409 exists) → others still uploaded, failure listed (test in Task 3).
5. Expired token / 401 mid-session → silent re-acquire, not a blank screen (test in Task 2: 401 → token provider called again once).

---

### Task 1: Scaffold, spec, README, CI/Pages

**Files:** Create `package.json`, `tsconfig.json`, `vite.config.ts`, `index.html`, `src/main.ts` (placeholder), `src/style.css`, `public/manifest.webmanifest`, `public/icon-180.png`, `.github/workflows/deploy.yml`, `.gitignore`, `README.md`, `docs/superpowers/specs/2026-11-04-onedrive-shared-design.md`.

- [ ] `npm create vite@latest` (vanilla-ts) equivalent by hand; add `@azure/msal-browser`, dev `vitest`, `@playwright/test`, `typescript`. Scripts: `dev`, `build` (`tsc && vite build`), `test` (`vitest run`), `e2e` (`playwright test`).
- [ ] Icon: 180×180 PNG generated with ImageMagick if present, else a tiny Node zlib script (dev-only, not committed as a tool).
- [ ] Workflow: on push to `main` → `npm ci`, `npm test`, `npx playwright install --with-deps chromium`, `npm run e2e`, `npm run build` with `VITE_CLIENT_ID: ${{ vars.CLIENT_ID }}`, `actions/upload-pages-artifact@v3` (`dist`), `actions/deploy-pages@v4`; permissions `pages: write`, `id-token: write`.
- [ ] README: what it is; **Azure registration steps** (portal.azure.com → App registrations → New → "Personal Microsoft accounts only" → Platform **Single-page application**, redirect URIs `https://nbraun1.github.io/onedrive-shared/` and `http://localhost:5173/onedrive-shared/` → copy Application (client) ID; consent to `Files.ReadWrite.All` happens at first sign-in); `gh variable set CLIENT_ID`; **how to get the link** + example shapes (`https://1drv.ms/f/c/<cid>/<token>`, `https://1drv.ms/f/s!...`, `https://onedrive.live.com/?redeem=...`), folder `/f/` vs file links, must allow editing; iPhone install steps (Safari → Share → Add to Home Screen); security notes (no secrets, enable GitHub 2FA).
- [ ] `git init -b main`, commit, `gh repo create nbraun1/onedrive-shared --public --source .` (no push), `gh api -X POST repos/nbraun1/onedrive-shared/pages -f build_type=workflow`, then `git push -u origin main` (Pages must exist before the first workflow run).
- [ ] `main.ts`: if `import.meta.env.VITE_CLIENT_ID` is empty, render "Not configured: set the CLIENT_ID repository variable" (e2e test in Task 5).

### Task 2: Share link + Graph client + auth (`src/shareLink.ts`, `src/graph.ts`, `src/auth.ts`)

**Interfaces – Produces:**
- `encodeShareLink(url: string): string` → `"u!" + base64url(utf8(url))` without `=`.
- `validateShareLink(url: string): string | null` → error message or null (rules above).
- `type DriveItem = { id; name; size?; lastModifiedDateTime; webUrl; folder?: { childCount: number }; file?: object; parentReference?: { driveId: string; id: string } }`
- `class GraphError extends Error { status: number; code: string }`
- `getToken(forceRefresh?: boolean): Promise<string>` in `auth.ts` (MSAL as in Design, `handleRedirectPromise` on load; `forceRefresh` passed to `acquireTokenSilent`; in `import.meta.env.DEV` only, `window.__TEST_TOKEN__` short-circuits it for Playwright).
- `createGraph(getToken: (forceRefresh?: boolean) => Promise<string>, fetchFn = fetch)` returning `{ resolveShare(link): Promise<{ item: DriveItem; canEdit: boolean }>, listChildren(driveId, id): Promise<DriveItem[]>, deleteItem(driveId, id), renameItem(driveId, id, name): Promise<DriveItem>, moveItem(driveId, id, parentId): Promise<DriveItem>, createFolder(driveId, parentId, name): Promise<DriveItem>, uploadFile(driveId, parentId, file: File, onProgress?: (fraction: number) => void): Promise<DriveItem> }`.
- `validateName(name: string): string | null`.

- [ ] Tests (`src/shareLink.test.ts`, `src/graph.test.ts`, fake `fetchFn`): encode known vector (`https://1drv.ms/f/s!abc` → `u!aHR0cHM6Ly8xZHJ2Lm1zL2YvcyFhYmM`); validate rejects `""`, `https://google.com`, `https://1drv.ms/u/s!x` (file), accepts the three folder shapes; `validateName` rejects `""`, `"  "`, `"a:b"`, `"a."`, 256 chars, accepts `"Prüfung #1 %"`; `resolveShare` sends `Prefer: redeemSharingLink`, throws on non-folder, `canEdit` from roles; `listChildren` follows `@odata.nextLink` across 3 pages; upload ≤4 MiB uses PUT with `Pr%C3%BCfung%20%231%20%25.txt` and conflictBehavior=fail; upload 5 MiB creates session and sends chunk `Content-Range` headers with no `Authorization` on uploadUrl; 429 with `Retry-After: 0` retried then succeeds; 401 → getToken called a second time with `forceRefresh=true`, then succeeds; second 401 → `GraphError` 401 (no loop); 409 → `GraphError` with code `nameAlreadyExists`; `fetch` reject → `GraphError` status 0 "No connection".
- [ ] Run → fail. Implement. Run → pass. Commit.
- [ ] Minimal `main.ts` flow: sign in → paste link (validated) → show resolved folder name + child count + `canEdit`; stored under `share`. Task 5 extends this file.
- [ ] **Manual checkpoint (user):** user does the Azure registration (README), puts the ID in `.env.local` (`VITE_CLIENT_ID=…`, gitignored), runs `npm run dev`, signs in at `http://localhost:5173/onedrive-shared/`, pastes the real link. If the `1drv.ms/f/c/` link does not resolve, fallback: user adds a shortcut to "My files" and the app resolves it via `GET /me/drive/root/children` `remoteItem` — only implemented if needed.

### Task 3: Uploads of many files and folder trees (`src/upload.ts`)

**Interfaces – Consumes:** `createGraph` API. **Produces:** `uploadMany(graph, driveId, parentId, files: File[], onProgress: (file: File, fraction: number) => void): Promise<{ file: File; error: string }[]>` — uses `file.webkitRelativePath` (if present) to create folders top-down, cached by path; returns failures.

- [ ] Tests: tree `a/x.txt, a/b/y.txt, z.txt` → createFolder called for `a` then `b` (parent = a's id) once each, files uploaded to the right parents; one upload rejects 409 → others still uploaded, one failure returned; folder creation fails → its files reported as failed, siblings continue.
- [ ] Run → fail, implement, pass, commit.

### Task 4: Move target rules (`src/moveRules.ts`)

**Produces:** `canMoveInto(targetId: string, pickerPath: string[], selectedIds: Set<string>, currentFolderId: string): boolean` — false if target or any id in `pickerPath` is selected, or target is current folder.

- [ ] Tests: into itself false, into own descendant false, into current folder false, into sibling true. Run, implement, pass, commit.

### Task 5: UI (`src/main.ts`, `src/style.css`, `index.html`)

**Consumes:** everything above. **Produces:** the app.

- `main.ts` (extends Task 2's flow): screens — sign-in, paste-link, browser (breadcrumb, list, row `⋯` menu, Select mode, bottom bar, modals for rename/new folder/confirm delete/move picker, upload progress list, toast, view-only banner, Change link). Upload folder button rule from Design. Mobile-first CSS, 44px tap targets, safe-area insets.
- [ ] Playwright (`e2e/app.spec.ts`, `playwright.config.ts` starting `vite` dev server, mobile viewport iPhone 13), Graph mocked with `page.route('https://graph.microsoft.com/**')` over an in-memory tree: paste invalid link → error shown; paste file link → error; valid link → root listed; open subfolder, breadcrumb back; rename with `a:b` → validation error, valid rename updates list; rename to existing → "already exists"; new folder; delete folder → confirm dialog text, removed; select 2 → delete both; move into sibling works, own subfolder disabled; upload 2 files with one 409 → one failure shown; Upload folder visible on desktop context, hidden when `display-mode: standalone` emulated (add `<meta>`-independent check via `page.emulateMedia`? → instead stub `matchMedia` in `addInitScript`); view-only link → modify buttons hidden; Graph 500 on list → toast, no blank screen; empty `VITE_CLIENT_ID` → "Not configured" message.
- [ ] Run → fail, implement, pass. `npm run build` passes. Commit.

### Task 6: Release

- [ ] User completes Azure registration and gives the client ID → `gh variable set CLIENT_ID -R nbraun1/onedrive-shared`.
- [ ] Push to `main`, watch workflow green (`gh run watch`), open `https://nbraun1.github.io/onedrive-shared/` in built-in browser → sign-in screen renders, manifest loads.
- [ ] User: install on iPhone, sign in, paste link, try each action once (sign-in redirect inside standalone PWA is the riskiest bit on iOS).

## Execution

Native (superpowers:executing-plans), recommended: 6 tightly coupled tasks sharing one Graph interface, small codebase; one whole-branch review at the end.

## Verification

- `npm test` and `npm run e2e` green locally and in Actions.
- Pages URL serves the app; manifest + icon fetched (check network in browser pane).
- Real-world check by the user on iPhone with the friend's link (I cannot sign in for them).

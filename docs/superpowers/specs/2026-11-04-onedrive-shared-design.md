# onedrive-shared design (2026-11-04)

## Context

User (personal MS account) has a folder shared by a friend (personal MS account) via an edit link. They want to manage it from their iPhone. They own only Windows/Linux devices and no Apple developer account, so a native app is out → PWA on GitHub Pages. Graph's `sharedWithMe` is being retired (degraded now, gone after Nov 2026), so the app uses the share link instead.

## Design

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


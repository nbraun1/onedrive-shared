# onedrive-shared

A small web app (PWA) to manage a OneDrive folder a friend shared with you, from your iPhone, without the App Store and without a Mac.

- Browse the shared folder, its subfolders and files
- Delete files and folders (a folder is deleted with everything in it, into the owner's OneDrive recycle bin)
- Create folders, upload several files at once, upload whole folders (website on a desktop browser only)
- Rename and move files and folders, one at a time or several selected at once
- Save several share links under your own names and switch between them
- View images, videos, audio and text files in the app (swipe or arrows to the next file, Save to Photos); thumbnails in the list
- Optional app lock with Face ID, fingerprint or the device passcode (menu → App lock; off by default, locks immediately, after 1 or 5 minutes away). It hides the app from someone holding your unlocked phone; it does not encrypt anything. Needs iOS 16+. If the unlock stops working, Sign out on the lock screen resets the app.

It only talks to the Microsoft Graph OneDrive API, directly from your device. There is no server and no secret.

Live: <https://nbraun1.github.io/onedrive-shared/>

## One-time setup

### 1. Register the app with Microsoft (free, ~5 minutes)

1. Open <https://portal.azure.com> → **App registrations** → **New registration**. Sign in with your personal Microsoft account.
2. Name: `Shared Drive`. Supported account types: **Personal Microsoft accounts only**.
3. Redirect URI: platform **Single-page application (SPA)**, URI `https://nbraun1.github.io/onedrive-shared/`. Click **Register**.
4. Under **Authentication** → **Single-page application**, add a second redirect URI for local development: `http://localhost:5173/onedrive-shared/`.
5. Copy the **Application (client) ID** from the overview page. It is not a secret.

You don't need to add API permissions. The app asks for `Files.ReadWrite.All` when you first sign in, and you confirm it once. That permission is needed to reach files others shared with you.

### 2. Give the client ID to the build

```bash
gh variable set CLIENT_ID -R nbraun1/onedrive-shared --body "<application-client-id>"
gh workflow run deploy.yml -R nbraun1/onedrive-shared
```

Until this is set, the site shows "Not configured".

### 3. Install it on the iPhone

1. Open <https://nbraun1.github.io/onedrive-shared/> in **Safari**.
2. Tap **Share** → **Add to Home Screen** → **Add**.
3. Open **Shared Drive** from the home screen, sign in with Microsoft, and paste the share link.

## The share link

The app opens a folder through the link someone shared with you. On the **Links** screen, give the link a name (optional; the folder name is used otherwise) and paste it. The app saves it on this device and reopens the last used link on the next start. Use **☰ → Links** to switch, add, rename (`⋯` → Rename) or remove (`⋯` → Remove: only forgets the link, nothing in OneDrive changes). Drag a link by its **≡** handle to change the order. **☰ → Sign out** signs out of Microsoft on this device.

**How to get it**

- Use the link your friend sent you, or
- onedrive.live.com → **Shared** → right-click the folder → **Share** → **Copy link**, or
- the OneDrive iPhone app → **Shared** → `…` next to the folder → **Share** → **Copy link**.

**What it looks like** (made-up examples)

```
https://1drv.ms/f/c/1a2b3c4d5e6f7a8b/EkTqXyZ12AbCdEfGhIjKlMnB4xY1yQ2wE3rT5uI7oP9aSd
https://1drv.ms/f/s!AmBcDeFgHiJkLmNoPq1234567
https://onedrive.live.com/?redeem=aHR0cHM6Ly8xZHJ2Lm1zL2YvcyFBbUJjRGVGZ2g&id=...
```

- The `/f/` means a **folder**. Links with `/u/`, `/w/`, `/x/`, `/p/` and similar point to a single file and are rejected.
- The link must allow **editing**. With a view-only link the app only lets you browse and shows "View-only link".
- Paste the full link exactly as copied.

## Navigating

The browser's Back button, a mouse's back button and the iPhone's swipe from the left edge all go **up one level**: from a photo back to its folder, from a folder to its parent, from the top folder to the Links screen. Back never leaves the app. Folders you've already seen appear instantly when you go back (the app checks OneDrive for changes in the background).

## Viewing files

Tap a file to open it full screen. Images (including iPhone HEIC photos), videos (MP4/MOV), audio and text files open in the app, as far as the browser can play them. Swipe left/right or use ‹ › to go through the folder. Tap the photo or video to hide all buttons; tap again to show them. On a desktop browser, zoom photos and videos with **− / + / Fit**, the mouse wheel or the keys `+` `-` `0`, and drag to move around; while a video is zoomed, Space plays and pauses it. On the iPhone, pinch to zoom. Anything else (PDF, Office, …) opens in OneDrive. If a file can't be shown, the viewer says why (for example the OneDrive error), with a button to open it in OneDrive.

**Save** prepares the file and then shows **Save / Share**: tap it to open the iOS share sheet ("Save Image" / "Save Video"). Files larger than 200 MB open the download directly instead, to keep the app from running out of memory.

## Security

- Your password is only typed on Microsoft's sign-in page. The app gets a token back (OAuth with PKCE) and keeps it, and the share link, only in the app's storage on your phone.
- GitHub only serves the static files. It never sees your data or tokens.
- The code is public. Whoever controls this GitHub repo controls the code your phone runs, so keep 2FA on your GitHub account.

## Development

```bash
npm install
echo "VITE_CLIENT_ID=<application-client-id>" > .env.local   # gitignored
npm run dev        # http://localhost:5173/onedrive-shared/
npm test           # unit tests (Vitest)
npm run e2e        # UI tests (Playwright, against a fake OneDrive)
npm run build
```

Every push to `main` runs both test suites, builds, and deploys to GitHub Pages (`.github/workflows/deploy.yml`).

### Graph calls used

| Action | Call |
|---|---|
| Open share link | `GET /shares/{u!base64url(link)}/driveItem` (`Prefer: redeemSharingLink`), `GET /shares/{token}/permission` |
| List folder | `GET /drives/{driveId}/items/{id}/children?$expand=thumbnails` (follows `@odata.nextLink`) |
| View / save a file | `GET /drives/{driveId}/items/{id}?$select=id,@microsoft.graph.downloadUrl`, then the short-lived download URL directly |
| Delete | `DELETE /drives/{driveId}/items/{id}` |
| Rename / move | `PATCH /drives/{driveId}/items/{id}` with `name` / `parentReference.id` |
| New folder | `POST /drives/{driveId}/items/{parentId}/children` |
| Upload ≤ 4 MiB | `PUT /drives/{driveId}/items/{parentId}:/{name}:/content` |
| Upload > 4 MiB | `POST …:/{name}:/createUploadSession`, then chunked `PUT`s to the upload URL |

The `sharedWithMe` endpoint is deliberately not used: Microsoft is retiring it for personal accounts.

import "./style.css";
import { getToken, hasTestToken, initAuth, signIn, signOut } from "./auth";
import { createGraph, errorText, type DriveItem } from "./graph";
import { canMoveInto } from "./moveRules";
import { validateName, validateShareLink } from "./shareLink";
import { uploadMany } from "./upload";
import { dialog, h } from "./dom";
import { addShare, loadShares, moveShare, removeShare, renameShare, saveShares, validateLabel, type SavedShare } from "./shares";
import { openViewer, viewKind } from "./viewer";

type Crumb = { id: string; name: string };

const app = document.getElementById("app")!;
const graph = createGraph(getToken);
let shares = loadShares();
let share: SavedShare | null = null; // the link being browsed
let path: Crumb[] = [];
let items: DriveItem[] = [];
let selected: Set<string> | null = null; // null = not in select mode
let status: "loading" | "failed" | "ready" = "loading";
let busy = false; // a batch move/delete is running
let listedAt = 0; // when `items` was fetched; download URLs in it expire
// Folders already seen, shown at once when going back and then checked in the background.
const cache = new Map<string, { items: DriveItem[]; listedAt: number }>();
const cacheKey = (folderId: string) => `${share!.driveId}:${folderId}`;
const signature = (list: DriveItem[]) =>
  JSON.stringify(list.map((i) => [i.id, i.name, i.size, i.lastModifiedDateTime, i.folder?.childCount]));

// Kept across re-renders so upload failures stay visible after the list refreshes.
const uploads = h("section", { className: "uploads", "aria-label": "Uploads", role: "region" });

let toastTimer: number | undefined;
function toast(message: string) {
  const el = document.getElementById("toast")!;
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (el.hidden = true), 6000);
}

const current = () => path[path.length - 1];
const isFolder = (i: DriveItem) => !!i.folder;
const sortItems = (list: DriveItem[]) =>
  list.sort((a, b) => Number(isFolder(b)) - Number(isFolder(a)) || a.name.localeCompare(b.name, undefined, { numeric: true }));

function formatSize(bytes = 0) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (bytes >= 1024 && i < units.length - 1) (bytes /= 1024), i++;
  return `${i ? bytes.toFixed(1) : bytes} ${units[i]}`;
}

// The installed iPhone app cannot pick folders; only the website offers it.
function canUploadFolder() {
  const standalone = window.matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;
  return !standalone && !/iPhone|iPad|iPod/.test(navigator.userAgent) && "webkitdirectory" in document.createElement("input");
}

/* ---------- dialogs ---------- */

function askName(title: string, initial = "", validate: (name: string) => string | null = validateName): Promise<string | null> {
  return new Promise((resolve) => {
    const input = h("input", { type: "text", value: initial, "aria-label": "Name", autocomplete: "off" });
    const error = h("p", { className: "error", role: "alert" });
    const form = h(
      "form",
      { method: "dialog" },
      h("h2", {}, title),
      input,
      error,
      h("div", { className: "buttons" }, h("button", { type: "button", value: "cancel" }, "Cancel"), h("button", { type: "submit", className: "primary" }, "Save")),
    );
    const d = dialog(form);
    let result: string | null = null;
    form.querySelector<HTMLButtonElement>("[value=cancel]")!.onclick = () => d.close();
    form.onsubmit = (e) => {
      const problem = validate(input.value);
      if (problem) {
        e.preventDefault();
        error.textContent = problem;
        return;
      }
      result = input.value.trim();
    };
    d.addEventListener("close", () => resolve(result));
    const dot = initial.lastIndexOf(".");
    input.setSelectionRange(0, dot > 0 ? dot : initial.length);
  });
}

function confirmDelete(text: string, action = "Delete"): Promise<boolean> {
  return new Promise((resolve) => {
    let ok = false;
    const d = dialog(
      h("p", {}, text),
      h(
        "div",
        { className: "buttons" },
        h("button", { onclick: () => d.close() }, "Cancel"),
        h("button", { className: "danger", onclick: () => ((ok = true), d.close()) }, action),
      ),
    );
    d.addEventListener("close", () => resolve(ok));
  });
}

function actionSheet(item: DriveItem) {
  const act = (label: string, fn: () => void, cls = "") =>
    h("button", { className: cls, onclick: () => (d.close(), fn()) }, label);
  const d = dialog(
    h("h2", {}, item.name),
    h(
      "div",
      { className: "sheet" },
      act("Rename", () => rename(item)),
      act("Move", () => move([item])),
      act("Delete", () => remove([item]), "danger"),
      h("button", { onclick: () => d.close() }, "Cancel"),
    ),
  );
}

/** Folder picker over the shared tree; resolves with the target folder id or null. */
function pickFolder(moving: DriveItem[]): Promise<string | null> {
  const ids = new Set(moving.map((i) => i.id));
  const from = current().id;
  return new Promise((resolve) => {
    let result: string | null = null;
    let at: Crumb[] = [path[0]];
    const body = h("div", { className: "picker" });
    const d = dialog(h("h2", {}, "Move to"), body);
    d.addEventListener("close", () => resolve(result));

    async function show() {
      const here = at[at.length - 1];
      const moveHere = h(
        "button",
        { className: "primary", disabled: !canMoveInto(here.id, at.slice(0, -1).map((c) => c.id), ids, from), onclick: () => ((result = here.id), d.close()) },
        "Move here",
      );
      const list = h("ul", { "aria-label": "Folders" });
      body.replaceChildren(
        h("nav", { className: "crumbs" }, ...at.map((c, i) => h("button", { onclick: () => ((at = at.slice(0, i + 1)), show()) }, c.name))),
        list,
        h("div", { className: "buttons" }, h("button", { onclick: () => d.close() }, "Cancel"), moveHere),
      );
      try {
        const folders = sortItems((await graph.listChildren(share!.driveId, here.id)).filter(isFolder));
        if (!folders.length) list.append(h("li", { className: "empty" }, "No subfolders"));
        for (const f of folders)
          list.append(
            h("li", {}, h("button", { "aria-label": f.name, disabled: ids.has(f.id), onclick: () => (at.push({ id: f.id, name: f.name }), show()) }, `📁 ${f.name}`)),
          );
      } catch (e) {
        list.append(h("li", { className: "error" }, errorText(e)));
      }
    }
    show();
  });
}

/* ---------- actions ---------- */

async function rename(item: DriveItem) {
  const name = await askName("Rename", item.name);
  if (!name || name === item.name) return;
  try {
    await graph.renameItem(share!.driveId, item.id, name);
  } catch (e) {
    toast(errorText(e, name));
  }
  cache.clear(); // something changed in OneDrive: no cached folder may hide it
  await refresh();
}

async function newFolder() {
  const name = await askName("New folder");
  if (!name) return;
  try {
    await graph.createFolder(share!.driveId, current().id, name);
  } catch (e) {
    toast(errorText(e, name));
  }
  cache.clear(); // something changed in OneDrive: no cached folder may hide it
  await refresh();
}

/** Runs op on each item; one failure does not stop the rest. */
async function each(list: DriveItem[], op: (i: DriveItem) => Promise<unknown>) {
  const failed: string[] = [];
  busy = true;
  renderBrowser();
  for (const i of list) {
    try {
      await op(i);
    } catch (e) {
      failed.push(`${i.name}: ${errorText(e, i.name)}`);
    }
  }
  if (failed.length) toast(`Failed: ${failed.join("; ")}`);
  busy = false;
  selected = null;
  cache.clear(); // something changed in OneDrive: no cached folder may hide it
  await refresh();
}

async function remove(list: DriveItem[]) {
  const text = list.length === 1 ? `Delete '${list[0].name}'${isFolder(list[0]) ? " and everything in it" : ""}?` : `Delete ${list.length} items?`;
  if (await confirmDelete(text)) await each(list, (i) => graph.deleteItem(share!.driveId, i.id));
}

async function move(list: DriveItem[]) {
  const target = await pickFolder(list);
  if (target) await each(list, (i) => graph.moveItem(share!.driveId, i.id, target));
}

async function upload(files: File[]) {
  if (!files.length) return;
  const bars = new Map(files.map((f) => [f, h("progress", { max: 1, value: 0 })]));
  uploads.replaceChildren(...files.map((f) => h("div", { className: "upload" }, h("span", {}, f.webkitRelativePath || f.name), bars.get(f)!)));
  const failures = await uploadMany(graph, share!.driveId, current().id, files, (f, x) => (bars.get(f)!.value = x));
  uploads.replaceChildren(...failures.map((f) => h("p", { className: "error" }, `${f.file.webkitRelativePath || f.file.name}: ${f.error}`)));
  cache.clear(); // something changed in OneDrive: no cached folder may hide it
  await refresh();
}

/* ---------- screens ---------- */

/** quiet: a cached list is already on screen, so only re-render if OneDrive's answer differs. */
let refreshSeq = 0;
async function refresh(quiet = false) {
  const folder = current();
  const my = ++refreshSeq;
  try {
    const list = sortItems(await graph.listChildren(share!.driveId, folder.id));
    if (my !== refreshSeq) return; // a newer refresh (or another folder) took over while this loaded
    const same = quiet && signature(list) === signature(items);
    items = list;
    listedAt = Date.now();
    status = "ready";
    cache.set(cacheKey(folder.id), { items, listedAt });
    if (same) return; // keep the DOM: no thumbnail flicker, scroll stays
  } catch (e) {
    if (my !== refreshSeq) return;
    if (quiet) return toast(errorText(e)); // keep showing the cached list
    status = "failed";
    toast(errorText(e));
  }
  renderBrowser();
}

function menu() {
  const d = dialog(
    h(
      "div",
      { className: "sheet" },
      h("button", { onclick: () => (d.close(), goUp(path.length)) }, "Links"),
      h("button", { onclick: async () => (d.close(), await signOut(), goUp(path.length)) }, "Sign out"),
      h("button", { onclick: () => d.close() }, "Cancel"),
    ),
  );
}

function openShare(s: SavedShare) {
  share = s;
  localStorage.setItem("lastShare", s.id);
  const root = [{ id: s.itemId, name: s.label }];
  history.pushState(folderState(root), "");
  return open(root);
}

/* ---------- history: every folder level and an open viewer is one entry, so Back means "up one level" ---------- */

type Nav = { app: 1; screen: "guard" | "links" | "folder"; shareId?: string; path?: Crumb[]; viewer?: boolean };
const folderState = (p: Crumb[]): Nav => ({ app: 1, screen: "folder", shareId: share!.id, path: p });

function goDown(crumbs: Crumb[]) {
  history.pushState(folderState(crumbs), "");
  open(crumbs);
  scrollTo(0, 0); // a newly opened folder starts at the top; Back restores the old position
}

/** Up `levels` folders (path.length = to the Links screen); popstate renders the result. */
function goUp(levels: number) {
  if (levels > 0) history.go(-levels);
}

function showState(st: Nav | null) {
  if (!st?.app || st.screen === "guard") {
    // Back reached the bottom of the app: stay instead of returning to the Microsoft sign-in pages.
    history.pushState({ app: 1, screen: "links" } satisfies Nav, "");
    return renderLinks();
  }
  if (st.viewer && !document.querySelector("dialog.viewer[open]")) {
    // a viewer step without a viewer (reload, Forward after closing): step back onto its folder's own step
    st = { ...st, viewer: undefined };
    history.back();
  }
  if (st.screen === "links") return renderLinks();
  const s = shares.find((x) => x.id === st.shareId);
  if (!s || !st.path?.length) {
    history.replaceState({ app: 1, screen: "links" } satisfies Nav, "");
    return renderLinks();
  }
  const same = share?.id === s.id && path.length === st.path.length && path.every((c, i) => c.id === st.path![i].id);
  share = s;
  if (!same || !app.querySelector("nav.crumbs")) open(st.path); // e.g. closing the viewer stays put
}

window.addEventListener("popstate", (e) => {
  document.querySelectorAll<HTMLDialogElement>("dialog[open]").forEach((d) => d.close());
  showState(e.state as Nav | null);
});

function updateShares(list: SavedShare[]) {
  shares = list;
  saveShares(shares);
}

function linkActions(s: SavedShare) {
  const d = dialog(
    h("h2", {}, s.label),
    h(
      "div",
      { className: "sheet" },
      h("button", {
        onclick: async () => {
          d.close();
          const label = await askName("Rename link", s.label, (v) => (v.trim() ? validateLabel(v) : "Name must not be empty"));
          if (label) updateShares(renameShare(shares, s.id, label));
          renderLinks();
        },
      }, "Rename"),
      h("button", {
        className: "danger",
        onclick: async () => {
          d.close();
          if (await confirmDelete(`Remove '${s.label}'? Files in OneDrive are not affected.`, "Remove")) updateShares(removeShare(shares, s.id));
          renderLinks();
        },
      }, "Remove"),
      h("button", { onclick: () => d.close() }, "Cancel"),
    ),
  );
}

async function open(crumbs: Crumb[]) {
  path = crumbs;
  selected = null;
  const hit = cache.get(cacheKey(current().id));
  if (hit) {
    items = hit.items;
    listedAt = hit.listedAt;
    status = "ready";
    renderBrowser();
    return refresh(true);
  }
  items = [];
  status = "loading";
  renderBrowser();
  await refresh();
}

function view(item: DriveItem) {
  const viewable = items.filter((i) => viewKind(i));
  if (!viewKind(item)) return void window.open(item.webUrl, "_blank", "noopener");
  history.pushState({ ...folderState(path), viewer: true } satisfies Nav, "");
  // by id: a background check may have replaced the item objects behind the rows on screen
  const d = openViewer(graph, share!.driveId, viewable, viewable.findIndex((i) => i.id === item.id), listedAt);
  // Closed by Close/Esc: drop its history entry. Closed by Back: the entry is already gone.
  d.addEventListener("close", () => (history.state as Nav | null)?.viewer && history.back());
}

function renderBrowser() {
  const edit = share!.canEdit;
  const crumbs = h(
    "nav",
    { className: "crumbs", "aria-label": "Path" },
    ...path.map((c, i) => h("button", { onclick: () => goUp(path.length - 1 - i) }, c.name)),
  );
  const list = h("ul", { className: "items", "aria-label": "Items" });
  for (const item of items) {
    const meta = `${isFolder(item) ? `${item.folder!.childCount ?? 0} items` : formatSize(item.size)} · ${new Date(item.lastModifiedDateTime ?? "").toLocaleDateString()}`;
    const icon = h("span", { className: "icon" }, isFolder(item) ? "📁" : "📄");
    const thumb = item.thumbnails?.[0]?.small?.url;
    if (thumb) icon.replaceChildren(h("img", { src: thumb, alt: "", loading: "lazy", onerror: () => icon.replaceChildren("📄") }));
    const main = h(
      "button",
      {
        className: "open",
        "aria-label": item.name,
        onclick: () => (isFolder(item) ? goDown([...path, { id: item.id, name: item.name }]) : view(item)),
      },
      icon,
      h("span", { className: "name" }, item.name, h("small", {}, meta)),
    );
    const sel = selected;
    const lead = sel
      ? h("input", {
          type: "checkbox",
          "aria-label": item.name,
          checked: sel.has(item.id),
          onchange: (e: Event) => ((e.target as HTMLInputElement).checked ? sel.add(item.id) : sel.delete(item.id), renderBrowser()),
        })
      : null;
    const more = edit && !sel ? h("button", { className: "more", "aria-label": `Actions for ${item.name}`, onclick: () => actionSheet(item) }, "⋯") : null;
    list.append(h("li", {}, lead, main, more));
  }
  if (!items.length && status !== "failed")
    list.append(h("li", { className: "empty" }, status === "loading" ? "Loading…" : "This folder is empty"));

  const filePicker = (label: string, folder: boolean) => {
    const input = h("input", { type: "file", multiple: true, hidden: true, onchange: () => upload([...(input.files ?? [])]) });
    if (folder) input.webkitdirectory = true;
    return h("label", { className: "button" }, label, input);
  };
  const chosen = items.filter((i) => selected?.has(i.id));
  const bar = !edit
    ? null
    : selected
      ? h(
          "footer",
          {},
          h("button", { disabled: busy || !chosen.length, onclick: () => move(chosen) }, `Move (${chosen.length})`),
          h("button", { className: "danger", disabled: busy || !chosen.length, onclick: () => remove(chosen) }, `Delete (${chosen.length})`),
        )
      : h(
          "footer",
          {},
          h("button", { onclick: newFolder }, "New folder"),
          filePicker("Upload files", false),
          canUploadFolder() && filePicker("Upload folder", true),
        );

  app.replaceChildren(
    h(
      "header",
      {},
      crumbs,
      edit && h("button", { onclick: () => ((selected = selected ? null : new Set()), renderBrowser()) }, selected ? "Done" : "Select"),
      h("button", { "aria-label": "Menu", onclick: menu }, "☰"),
    ),
    edit ? "" : h("p", { className: "banner" }, "View-only link: you can browse but not change anything."),
    list,
    uploads,
    bar ?? "",
  );
}

/** Drag the handle up or down; on release the link moves to where its row's middle ended up. */
// shortcut: no auto-scroll while dragging, add it if the list grows beyond one screen
function dragToReorder(handle: HTMLElement, row: HTMLElement, list: HTMLElement, index: number) {
  handle.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    const mids = [...list.children].map((r) => {
      const b = r.getBoundingClientRect();
      return b.top + b.height / 2;
    });
    const startY = e.clientY;
    let to = index;
    row.classList.add("dragging");
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return;
      const dy = ev.clientY - startY;
      row.style.transform = `translateY(${dy}px)`;
      to = mids.filter((m, i) => i !== index && m < mids[index] + dy).length;
    };
    const end = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return;
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
      row.classList.remove("dragging");
      row.style.transform = "";
      // Re-render only on a real move, so the add-link form keeps what was typed.
      if (ev.type === "pointerup" && to !== index) {
        updateShares(moveShare(shares, index, to));
        renderLinks();
      }
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  });
}

function renderLinks() {
  share = null;
  const list = h("ul", { className: "items", "aria-label": "Saved links" });
  shares.forEach((s, index) => {
    const handle = h("button", { className: "handle", "aria-label": `Reorder ${s.label}` }, "≡");
    const row = h(
      "li",
      {},
      handle,
      h("button", { className: "open", "aria-label": s.label, onclick: () => openShare(s) }, h("span", { className: "icon" }, "🔗"), h("span", { className: "name" }, s.label, h("small", {}, s.name))),
      h("button", { className: "more", "aria-label": `Actions for ${s.label}`, onclick: () => linkActions(s) }, "⋯"),
    );
    dragToReorder(handle, row, list, index);
    list.append(row);
  });
  if (!shares.length) list.append(h("li", { className: "empty" }, "No saved links yet"));

  const label = h("input", { type: "text", "aria-label": "Link name", placeholder: "Name (optional)", autocomplete: "off" });
  const input = h("input", { type: "url", "aria-label": "Share link", placeholder: "https://1drv.ms/f/…", autocomplete: "off" });
  const error = h("p", { className: "error", role: "alert" });
  const button = h("button", { type: "submit", className: "primary" }, "Add");
  const form = h(
    "form",
    { className: "add-link" },
    h("p", {}, "Add a OneDrive folder link someone shared with you (it contains /f/)."),
    label,
    input,
    error,
    button,
  );
  form.onsubmit = async (e) => {
    e.preventDefault();
    error.textContent = validateLabel(label.value) ?? validateShareLink(input.value) ?? "";
    if (error.textContent) return;
    button.disabled = true;
    try {
      const { item, canEdit } = await graph.resolveShare(input.value);
      const added = addShare(shares, { driveId: item.parentReference!.driveId!, itemId: item.id, name: item.name, canEdit }, label.value);
      updateShares(added.list);
      await openShare(added.share);
      if (added.existed) toast(`Already saved as '${added.share.label}'`);
    } catch (err) {
      error.textContent = errorText(err);
      button.disabled = false;
    }
  };
  app.replaceChildren(
    h("header", {}, h("h1", {}, "Links"), h("button", { onclick: async () => (await signOut(), renderLinks()) }, "Sign out")),
    list,
    form,
  );
}

async function main() {
  const clientId = import.meta.env.VITE_CLIENT_ID;
  if (!clientId && !hasTestToken()) {
    app.replaceChildren(h("p", { className: "center" }, "Not configured: set the CLIENT_ID repository variable (see README)."));
    return;
  }
  try {
    if (!(await initAuth(clientId))) {
      app.replaceChildren(
        h("div", { className: "center" }, h("h1", {}, "Shared Drive"), h("button", { className: "primary", onclick: () => signIn() }, "Sign in with Microsoft")),
      );
      return;
    }
  } catch (e) {
    app.replaceChildren(h("p", { className: "center error" }, `Sign-in failed: ${errorText(e)}`));
    return;
  }
  const restored = history.state as Nav | null;
  if (restored?.app && restored.screen !== "guard") return showState(restored); // reload: the steps below still exist
  history.replaceState({ app: 1, screen: "guard" } satisfies Nav, "");
  history.pushState({ app: 1, screen: "links" } satisfies Nav, "");
  const last = shares.find((s) => s.id === localStorage.getItem("lastShare"));
  if (last) await openShare(last);
  else renderLinks();
}

document.body.append(h("div", { id: "toast", role: "status", hidden: true }));
main();

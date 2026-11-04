import "./style.css";
import { getToken, hasTestToken, initAuth, signIn, signOut } from "./auth";
import { createGraph, errorText, type DriveItem } from "./graph";
import { canMoveInto } from "./moveRules";
import { validateName, validateShareLink } from "./shareLink";
import { uploadMany } from "./upload";

type Share = { driveId: string; itemId: string; name: string; canEdit: boolean };
type Crumb = { id: string; name: string };

const app = document.getElementById("app")!;
const graph = createGraph(getToken);
let share: Share | null = load();
let path: Crumb[] = [];
let items: DriveItem[] = [];
let selected: Set<string> | null = null; // null = not in select mode
let status: "loading" | "failed" | "ready" = "loading";
let busy = false; // a batch move/delete is running

// Small DOM builder: names always go through textContent, never innerHTML.
function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & Record<string, unknown> = {},
  ...children: (Node | string | false | null | undefined)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k.startsWith("aria-") || k === "role") el.setAttribute(k, String(v));
    else (el as unknown as Record<string, unknown>)[k] = v;
  }
  for (const c of children) if (c) el.append(c);
  return el;
}

// Kept across re-renders so upload failures stay visible after the list refreshes.
const uploads = h("section", { className: "uploads", "aria-label": "Uploads", role: "region" });

function load(): Share | null {
  try {
    return JSON.parse(localStorage.getItem("share") ?? "null");
  } catch {
    return null;
  }
}

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

function dialog(...children: Node[]): HTMLDialogElement {
  const d = h("dialog", {}, ...children);
  d.addEventListener("close", () => d.remove());
  document.body.append(d);
  d.showModal();
  return d;
}

function askName(title: string, initial = ""): Promise<string | null> {
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
      const problem = validateName(input.value);
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

function confirmDelete(text: string): Promise<boolean> {
  return new Promise((resolve) => {
    let ok = false;
    const d = dialog(
      h("p", {}, text),
      h(
        "div",
        { className: "buttons" },
        h("button", { onclick: () => d.close() }, "Cancel"),
        h("button", { className: "danger", onclick: () => ((ok = true), d.close()) }, "Delete"),
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
  await refresh();
}

/* ---------- screens ---------- */

async function refresh() {
  const folder = current();
  try {
    const list = sortItems(await graph.listChildren(share!.driveId, folder.id));
    if (folder !== current()) return; // the user moved on while this loaded
    items = list;
    status = "ready";
  } catch (e) {
    if (folder !== current()) return;
    status = "failed";
    toast(errorText(e));
  }
  renderBrowser();
}

function forgetShare() {
  localStorage.removeItem("share");
  share = null;
}

function menu() {
  const d = dialog(
    h(
      "div",
      { className: "sheet" },
      h("button", { onclick: () => (d.close(), forgetShare(), renderLink()) }, "Change link"),
      h("button", { onclick: async () => (d.close(), forgetShare(), await signOut(), renderLink()) }, "Sign out"),
      h("button", { onclick: () => d.close() }, "Cancel"),
    ),
  );
}

async function open(crumbs: Crumb[]) {
  path = crumbs;
  selected = null;
  items = [];
  status = "loading";
  renderBrowser();
  await refresh();
}

function renderBrowser() {
  const edit = share!.canEdit;
  const crumbs = h(
    "nav",
    { className: "crumbs", "aria-label": "Path" },
    ...path.map((c, i) => h("button", { onclick: () => open(path.slice(0, i + 1)) }, c.name)),
  );
  const list = h("ul", { className: "items", "aria-label": "Items" });
  for (const item of items) {
    const meta = `${isFolder(item) ? `${item.folder!.childCount ?? 0} items` : formatSize(item.size)} · ${new Date(item.lastModifiedDateTime ?? "").toLocaleDateString()}`;
    const main = h(
      "button",
      {
        className: "open",
        "aria-label": item.name,
        onclick: () => (isFolder(item) ? open([...path, { id: item.id, name: item.name }]) : window.open(item.webUrl, "_blank", "noopener")),
      },
      h("span", { className: "icon" }, isFolder(item) ? "📁" : "📄"),
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

function renderLink() {
  const input = h("input", { type: "url", "aria-label": "Share link", placeholder: "https://1drv.ms/f/…", autocomplete: "off" });
  const error = h("p", { className: "error", role: "alert" });
  const button = h("button", { type: "submit", className: "primary" }, "Open");
  const form = h(
    "form",
    { className: "center" },
    h("h1", {}, "Shared Drive"),
    h("p", {}, "Paste the OneDrive link your friend shared with you (a folder link containing /f/)."),
    input,
    error,
    button,
  );
  form.onsubmit = async (e) => {
    e.preventDefault();
    error.textContent = validateShareLink(input.value) ?? "";
    if (error.textContent) return;
    button.disabled = true;
    try {
      const { item, canEdit } = await graph.resolveShare(input.value);
      share = { driveId: item.parentReference!.driveId!, itemId: item.id, name: item.name, canEdit };
      localStorage.setItem("share", JSON.stringify(share));
      await open([{ id: item.id, name: item.name }]);
    } catch (err) {
      error.textContent = errorText(err);
      button.disabled = false;
    }
  };
  app.replaceChildren(form);
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
  if (share) await open([{ id: share.itemId, name: share.name }]);
  else renderLink();
}

document.body.append(h("div", { id: "toast", role: "status", hidden: true }));
main();

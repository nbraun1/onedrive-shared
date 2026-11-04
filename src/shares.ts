export type SavedShare = { id: string; label: string; driveId: string; itemId: string; name: string; canEdit: boolean };
type Folder = Omit<SavedShare, "id" | "label">;

const MAX_LABEL = 60;

const parse = (raw: string | null): unknown => {
  try {
    return JSON.parse(raw ?? "null");
  } catch {
    return null;
  }
};
const isShare = (s: unknown): s is SavedShare =>
  !!s && typeof s === "object" && ["id", "driveId", "itemId"].every((k) => typeof (s as Record<string, unknown>)[k] === "string");

export function saveShares(list: SavedShare[], storage: Storage = localStorage) {
  storage.setItem("shares", JSON.stringify(list));
}

export function loadShares(storage: Storage = localStorage): SavedShare[] {
  const raw = parse(storage.getItem("shares"));
  let list = Array.isArray(raw) ? raw.filter(isShare) : [];
  const legacy = storage.getItem("share"); // v1 kept a single link here
  if (legacy !== null) {
    const old = parse(legacy) as Partial<Folder> | null;
    if (typeof old?.driveId === "string" && typeof old.itemId === "string") {
      const name = typeof old.name === "string" ? old.name : "Shared folder";
      list = addShare(list, { driveId: old.driveId, itemId: old.itemId, name, canEdit: old.canEdit !== false }, name).list;
    }
    storage.removeItem("share");
    saveShares(list, storage);
  }
  return list;
}

const cleanLabel = (label: string, fallback: string) => (label.trim() || fallback).slice(0, MAX_LABEL);

export function addShare(list: SavedShare[], folder: Folder, label: string) {
  const found = list.find((s) => s.driveId === folder.driveId && s.itemId === folder.itemId);
  if (found) {
    // The same folder may come back through a link with different rights, e.g. an edit link after a view-only one.
    const share = { ...found, name: folder.name, canEdit: folder.canEdit };
    return { list: list.map((s) => (s === found ? share : s)), share, existed: true };
  }
  const share = { ...folder, id: crypto.randomUUID(), label: cleanLabel(label, folder.name) };
  return { list: [...list, share], share, existed: false };
}

export const renameShare = (list: SavedShare[], id: string, label: string) =>
  list.map((s) => (s.id === id ? { ...s, label: cleanLabel(label, s.name) } : s));

export function removeShare(list: SavedShare[], id: string, storage: Storage = localStorage) {
  if (storage.getItem("lastShare") === id) storage.removeItem("lastShare");
  return list.filter((s) => s.id !== id);
}

export const validateLabel = (label: string) => (label.trim().length > MAX_LABEL ? `Name is too long (max ${MAX_LABEL} characters)` : null);

export function moveShare(list: SavedShare[], from: number, to: number): SavedShare[] {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return list;
  const next = [...list];
  next.splice(to, 0, ...next.splice(from, 1));
  return next;
}

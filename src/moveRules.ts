/** pickerPath: ids of the folders above targetId, from the shared root down. */
export function canMoveInto(targetId: string, pickerPath: string[], selectedIds: Set<string>, currentFolderId: string): boolean {
  return targetId !== currentFolderId && ![...pickerPath, targetId].some((id) => selectedIds.has(id));
}

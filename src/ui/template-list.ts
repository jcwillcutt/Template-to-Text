// The order of the template list: pure, so it is unit-tested.
import type { TemplateData, TemplateFolder } from '../domain/types';
import { sanitizeExtension } from '../format/helpers';

// Folder membership: a template can be in any number of folders.
export const isInFolder = (t: TemplateData, folderId: string): boolean => (t.folderIds || []).includes(folderId);

// Whether a template is listed on the main page. One in no (existing) folder always is; one in folders is only when it
// was explicitly put there too.
export const isInMainList = (t: TemplateData, folders: TemplateFolder[]): boolean =>
  !folders.some((f) => isInFolder(t, f.id)) || t.onMain === true;

// Adding a template to a folder takes it off the main page unless it was explicitly kept there.
export function withFolder(t: TemplateData, folderId: string): TemplateData {
  return isInFolder(t, folderId) ? t : { ...t, folderIds: [...(t.folderIds || []), folderId], onMain: t.onMain ?? false };
}

// Taking it out of its last folder puts it back on the main page.
export function withoutFolder(t: TemplateData, folderId: string): TemplateData {
  if (!isInFolder(t, folderId)) return t;
  const { folderIds, onMain: _onMain, ...rest } = t;
  const left = (folderIds || []).filter((id) => id !== folderId);
  return left.length > 0 ? { ...rest, folderIds: left, ...(typeof t.onMain === 'boolean' ? { onMain: t.onMain } : {}) } : rest;
}

// Put a template on, or take it off, the main page. (Off only sticks while it is in some folder.)
export function withMain(t: TemplateData, on: boolean): TemplateData {
  return { ...t, onMain: on };
}

export type TemplateSortMode = 'new-old' | 'old-new' | 'a-z' | 'z-a';

export type TemplateListItem =
  | { kind: 'template'; tpl: TemplateData }
  | { kind: 'folder'; folder: TemplateFolder; list: TemplateData[] };

// Rows of the template list, in order: pinned templates and pinned folders together (most recently pinned first),
// then the unpinned folders, then the unpinned templates not in a folder. A folder's own templates (shown when it is
// open) are pinned ones first, then the rest in the chosen sort. While a search term is active the matches are one
// flat list, ignoring pinning and folders.
export function orderTemplateList(
  templates: TemplateData[],
  folders: TemplateFolder[],
  search: string,
  sort: TemplateSortMode,
): TemplateListItem[] {
  const term = search.trim().toLowerCase();
  const matched = !term
    ? templates
    : templates.filter(
        (t) => t.title.toLowerCase().includes(term) || sanitizeExtension(t.extension).toLowerCase().includes(term),
      );
  // Templates are stored in creation order (oldest first, newest appended last).
  const applySelectedSort = (list: TemplateData[]): TemplateData[] => {
    const sorted = [...list];
    if (sort === 'new-old') sorted.reverse();
    else if (sort === 'a-z') sorted.sort((a, b) => a.title.localeCompare(b.title));
    else if (sort === 'z-a') sorted.sort((a, b) => b.title.localeCompare(a.title));
    return sorted;
  };
  const asTemplates = (list: TemplateData[]): TemplateListItem[] => list.map((tpl) => ({ kind: 'template', tpl }));
  if (term) {
    // A search shows every folder whose name matches (with all its templates) and every folder holding a matching
    // template (with just those); a matching template in no folder is listed on its own after them.
    const members = (folder: TemplateFolder, from: TemplateData[]): TemplateData[] => {
      const inside = from.filter((t) => isInFolder(t, folder.id));
      const pinned = inside.filter((t) => t.pinned === true).sort((a, b) => (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0));
      return [...pinned, ...applySelectedSort(inside.filter((t) => t.pinned !== true))];
    };
    const folderItems: TemplateListItem[] = [];
    const shown = new Set<string>();
    for (const folder of folders) {
      const nameHit = folder.name.toLowerCase().includes(term);
      const list = members(folder, nameHit ? templates : matched);
      if (!nameHit && list.length === 0) continue;
      folderItems.push({ kind: 'folder', folder, list });
      for (const t of list) shown.add(t.id);
    }
    const rest = matched.filter((t) => !shown.has(t.id) && isInMainList(t, folders));
    return [...folderItems, ...asTemplates(applySelectedSort(rest))];
  }

  const byPinTime = (a: { pinnedAt?: number | null }, b: { pinnedAt?: number | null }): number =>
    (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0);
  // A template is listed in each of its folders, and on the main page when it is in no folder or was kept there.
  const rootTemplates = matched.filter((t) => isInMainList(t, folders));
  const folderItem = (folder: TemplateFolder): TemplateListItem => {
    const members = matched.filter((t) => isInFolder(t, folder.id));
    const pinned = members.filter((t) => t.pinned === true).sort(byPinTime);
    return { kind: 'folder', folder, list: [...pinned, ...applySelectedSort(members.filter((t) => t.pinned !== true))] };
  };
  const pinnedItems: { at: number | null | undefined; item: TemplateListItem }[] = [
    ...rootTemplates
      .filter((t) => t.pinned === true)
      .map((tpl) => ({ at: tpl.pinnedAt, item: { kind: 'template', tpl } as TemplateListItem })),
    ...folders.filter((f) => f.pinned === true).map((f) => ({ at: f.pinnedAt, item: folderItem(f) })),
  ].sort((a, b) => byPinTime({ pinnedAt: a.at }, { pinnedAt: b.at }));
  return [
    ...pinnedItems.map((p) => p.item),
    ...folders.filter((f) => f.pinned !== true).map(folderItem),
    ...asTemplates(applySelectedSort(rootTemplates.filter((t) => t.pinned !== true))),
  ];
}

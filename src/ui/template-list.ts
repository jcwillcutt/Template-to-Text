// The order of the template list: pure, so it is unit-tested.
import type { TemplateData, TemplateFolder } from '../domain/types';
import { sanitizeExtension } from '../format/helpers';

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
  if (term) return asTemplates(applySelectedSort(matched));

  const byPinTime = (a: { pinnedAt?: number | null }, b: { pinnedAt?: number | null }): number =>
    (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0);
  const folderIds = new Set(folders.map((f) => f.id));
  // A template pointing at a folder that no longer exists is shown in the main list.
  const rootTemplates = matched.filter((t) => !t.folderId || !folderIds.has(t.folderId));
  const folderItem = (folder: TemplateFolder): TemplateListItem => {
    const members = matched.filter((t) => t.folderId === folder.id);
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

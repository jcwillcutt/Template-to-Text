// What the main page remembers across a reload (clicking through to a product page and back unloads the
// extension): the search text, the selected products with their variant picks and notes, free-standing notes,
// the selected templates and which folders are open. Pure, so it is unit-tested; written to `shopify.storage`.
import type { SelectionEntry } from '../domain/types';

export interface ViewState {
  v: 1;
  search: string;
  productIds: string[];
  variantIds: Record<string, string[]>;
  notes: Record<string, string>;
  noteObjects: SelectionEntry[];
  order: Record<string, number>;
  templateIds: string[];
  expandedFolderIds: string[];
}

export const VIEW_STATE_KEY = 'view_state';

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : [];

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

// Anything unreadable gives null (start fresh); partly damaged data keeps whatever parts are valid.
export function parseViewState(raw: unknown): ViewState | null {
  const data = record(raw);
  if (data.v !== 1) return null;
  const variantIds: Record<string, string[]> = {};
  for (const [id, ids] of Object.entries(record(data.variantIds))) variantIds[id] = strings(ids);
  const notes: Record<string, string> = {};
  for (const [id, text] of Object.entries(record(data.notes))) if (typeof text === 'string') notes[id] = text;
  const order: Record<string, number> = {};
  for (const [id, n] of Object.entries(record(data.order))) if (typeof n === 'number' && Number.isFinite(n)) order[id] = n;
  const noteObjects: SelectionEntry[] = [];
  if (Array.isArray(data.noteObjects)) {
    for (const entry of data.noteObjects) {
      const e = record(entry);
      if (typeof e.id === 'string' && typeof e.note === 'string') noteObjects.push({ id: e.id, note: e.note });
    }
  }
  return {
    v: 1,
    search: typeof data.search === 'string' ? data.search : '',
    productIds: strings(data.productIds),
    variantIds,
    notes,
    noteObjects,
    order,
    templateIds: strings(data.templateIds),
    expandedFolderIds: strings(data.expandedFolderIds),
  };
}

// Only entries for products that are still selected are kept, so the stored value never grows with old picks.
export function buildViewState(input: Omit<ViewState, 'v'>): ViewState {
  const keep = new Set(input.productIds);
  const pick = <T,>(map: Record<string, T>): Record<string, T> => {
    const out: Record<string, T> = {};
    for (const id of Object.keys(map)) if (keep.has(id)) out[id] = map[id];
    return out;
  };
  return {
    v: 1,
    search: input.search,
    productIds: input.productIds,
    variantIds: pick(input.variantIds),
    notes: pick(input.notes),
    noteObjects: input.noteObjects,
    order: input.order,
    templateIds: input.templateIds,
    expandedFolderIds: input.expandedFolderIds,
  };
}

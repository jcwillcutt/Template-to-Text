// ----------------------------------------------------------------------------------------------
// MISC UI FORMATTING HELPERS
// ----------------------------------------------------------------------------------------------
// A menu `s-button` renders a plain-text label with no style props, so the only way to make a
// subtitle look italic is to swap its letters for the Unicode Mathematical Italic characters
// (A = U+1D434, a = U+1D44E). U+1D455 (italic small h) is unassigned in Unicode, so the Planck
// constant character U+210E is substituted for 'h'. Digits, spaces, and punctuation have no italic
// form and pass through unchanged.
const ITALIC_UPPER_BASE = 0x1d434;
const ITALIC_LOWER_BASE = 0x1d44e;
const ITALIC_SMALL_H = 0x210e;

function toItalic(str: string): string {
  let result = '';
  for (const char of str) {
    const code = char.codePointAt(0);
    if (code == null) continue;
    if (code >= 0x41 && code <= 0x5a) {
      result += String.fromCodePoint(ITALIC_UPPER_BASE + (code - 0x41));
    } else if (char === 'h') {
      result += String.fromCodePoint(ITALIC_SMALL_H);
    } else if (code >= 0x61 && code <= 0x7a) {
      result += String.fromCodePoint(ITALIC_LOWER_BASE + (code - 0x61));
    } else {
      result += char;
    }
  }
  return result;
}

// A stable signature of a selection draft (product ids and notes, plus free-standing note entries,
// in order) used to detect unsaved changes.
function selectionSignature(list: ProductData[], notes: SelectionEntry[] = []): string {
  return (
    list.map((p) => `${p.id}::${p.note || ''}`).join('|') +
    '#' +
    notes.map((n) => `${n.id}::${n.note}`).join('|')
  );
}

// One row of a combined product+note selection table (session 8) -- a discriminated union so the
// Selection view can render one table interleaving both kinds instead of two separate ones,
// ordered by orderIndex (see currentSelectionOrderIndex's comment for why order lives in a separate
// per-id map rather than on the item itself).
type SelectionRow =
  | { kind: 'product'; id: string; product: ProductData }
  | { kind: 'note'; id: string; note: SelectionEntry };

// Merge a product list and a note-entry list into one array of SelectionRow, sorted by orderIndex
// (an id with no entry sorts LAST, stably preserving its existing relative position among other
// unordered ids -- see currentSelectionOrderIndex's comment on why that degradation is preferable to
// an item going missing).
function combineSelectionRows(
  products: ProductData[],
  notes: SelectionEntry[],
  orderIndex: Record<string, number>,
): SelectionRow[] {
  const rows: SelectionRow[] = [
    ...products.map((product): SelectionRow => ({ kind: 'product', id: product.id, product })),
    ...notes.map((note): SelectionRow => ({ kind: 'note', id: note.id, note })),
  ];
  return rows
    .map((row, index) => ({ row, index, order: orderIndex[row.id] ?? Infinity }))
    .sort((a, b) => a.order - b.order || a.index - b.index)
    .map((entry) => entry.row);
}


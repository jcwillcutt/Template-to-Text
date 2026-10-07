// ----------------------------------------------------------------------------------------------
// DOMAIN TYPES
// ----------------------------------------------------------------------------------------------
export interface VariantData {
  id: string;
  title: string;
  sku: string | null;
  price: string | null;
  // The variant's "compare at" price, exposed as {{ variant.compareAtPrice }} / {{ product.compareAtPrice }}.
  compareAtPrice: string | null;
  // The variant's cost per item (inventoryItem.unitCost.amount), exposed as {{ variant.costPerItem }}
  // / {{ product.costPerItem }}. Null when no cost is recorded.
  costPerItem: string | null;
  barcode: string | null;
  inventoryQuantity: number | null;
  selectedOptions: { name: string; value: string }[];
}

export interface MetafieldData {
  namespace: string;
  key: string;
  value: string;
}

export interface ProductData {
  id: string;
  title: string;
  handle: string;
  vendor: string;
  productType: string;
  tags: string[];
  status: string;
  description: string;
  totalInventory: number | null;
  imageUrl: string | null;
  priceMin: string;
  priceMax: string;
  currencyCode: string;
  createdAt: string;
  updatedAt: string;
  // The active variant list for this render row (a row clone holds exactly one variant).
  variants: VariantData[];
  // The product's COMPLETE variant list, preserved through row expansion so `{{ product.length }}`
  // and the variant foreach can always see every variant.
  allVariants: VariantData[];
  metafields: MetafieldData[];
  // A free-text note the merchant typed for this product INSIDE a selection. It is never written to
  // the product itself: it lives in memory for the current selection and inside a public selection's
  // own metafield. Exposed to templates as {{ product.note }} (aliases: {{ product.notes }},
  // {{ products.note }}, {{ products.notes }} -- 'note' is the canonical spelling as of session 7).
  note: string;
}

// Which unit of the selection each render produces one output file for:
//  - 'selection': one file for everything (today's COMBINED mode -- a body with
//    {{ #selection.foreach }} loops over every object inline; without one, all tokens resolve
//    against the first selected object, same as {{ selection.first.* }}).
//  - 'object': one file per selection entry, product or note, in selection order (every selected
//    product first, in the order they were added, then every free-standing note, in the order they
//    were added).
//  - 'product': one file per product, regardless of variant count.
//  - 'note': one file per free-standing note.
//  - 'variant': one file per variant (this is the long-standing default behavior for a template with
//    no selection.foreach -- despite "PER-PRODUCT" being the name used for it in the architecture
//    docs, it has always produced one file per VARIANT row, not one per product).
// Stored per template so file-splitting is an explicit, editable setting rather than inferred from
// what happens to be in the body. As of session 7, per explicit direction, an UNSET fileBreak is no
// longer inferred from the body at all -- see mapStoredTemplate/TemplateData.fileBreak below.
export type FileBreak = 'selection' | 'object' | 'product' | 'note' | 'variant';

export interface TemplateData {
  id: string;
  title: string;
  body: string;
  extension: string;
  // Pinned templates are listed above unpinned ones when no template search term is entered.
  // Stored in the same shop metafield shards as the rest of the template, so the pinned state is
  // shared by every staff member of the shop rather than being per-user.
  pinned: boolean;
  // Milliseconds since epoch recording WHEN the template was pinned, used to sort the pinned group
  // most-recently-pinned first. Null whenever the template is unpinned, and also null for a
  // template that was pinned before this timestamp was recorded.
  pinnedAt: number | null;
  // `null` means "never explicitly chosen" -- a template saved before this field existed (session 4),
  // or one saved since without ever touching the File break dropdown. As of session 7, per explicit
  // direction ("this now must be user specified"), a null fileBreak is NEVER inferred from the body;
  // it must be set in the editor before the template can be downloaded or previewed (see
  // planOutputFiles, which returns a zero-file plan with a clear, actionable error for a null
  // fileBreak rather than guessing one).
  fileBreak: FileBreak | null;
  // Session 9. A boolean condition (same grammar as an `{{ #if=... }}` condition) evaluated between
  // each pair of ADJACENT output units -- variant/product/note/object rows for the four per-unit
  // fileBreak modes, or the first selection-scope foreach block's iterated items for 'selection'
  // mode -- to decide whether to MERGE the next unit's rendered output into the current file instead
  // of starting a new one. TRUE means merge/append; an empty string (the default for every new and
  // every pre-session-9 template) means "never merge," reproducing today's exact per-unit-mode/
  // single-or-uncounted-'selection'-mode behavior with zero required action. See
  // `partitionByMergeCondition` and the `selection.next`/`selection.prev`/`selection.curr` tokens it
  // makes meaningful. This REPLACES the old `i=0<N` chunk-size sub-syntax on
  // `selection.foreach`/`products.foreach` (deprecated, see `expandForeachBlocks`) -- a template that
  // relied on that syntax needs an explicit Merge IF condition to keep producing multiple files; see
  // the session 9 migration notes in roadmap.md.
  mergeCondition: string;
}

// Which bulk-select button is active: every product shown, or only those with inventory above 0.
export type BulkSelectMode = 'shown' | 'in-stock';

export interface PageInfo {
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  startCursor: string | null;
  endCursor: string | null;
}

// Templates are stored sharded across up to 10 shop metafields in the `template_to_text` namespace
// (keys template_0..template_9). Each shard holds up to ~120KB of JSON to stay safely under the
// 131,072 byte platform metafield value limit, giving a combined effective cap of ~1.2MB.

// One entry in a selection: EITHER a product reference (id is the product's real Shopify gid) with
// an optional note, OR a free-standing note with no backing product (id is a generated placeholder
// -- see generateNoteId -- never a real gid). Both are the exact same shape; a selection is simply a
// list of these, stored and passed around together (see e.g. saveSelectionDraft's
// `[...entries, ...selectionNoteDraft]`). This single type replaces what used to be two separate
// types (SelectionEntry for products, NoteObject for standalone notes) that carried the same
// information -- an id plus a note's text -- but under different field names, plus a `type`
// discriminator, `createdAt`, and `source` that nothing in the app actually branched on. The only
// thing that ever distinguished a "note object" from a product entry was whether it had a
// resolvable product id, which isStandaloneNote below now answers directly. This also generalizes
// for free to any other resource kind a selection might reference later (e.g. a specific variant
// could use its own gid as `id`), since the discriminator is "any real gid" rather than
// "specifically a product".
export interface SelectionEntry {
  id: string;
  note: string;
  // Which of the product's variants are selected, by variant gid. Absent or empty means "every
  // variant" -- the same meaning a stored entry with no `variantIds` field already has, so no
  // existing stored selection needs migrating. Meaningless (and always omitted) for a standalone
  // note entry.
  variantIds?: string[];
}

// Whether a selection entry is a free-standing note with no backing product, i.e. its `id` is a
// generated placeholder rather than a real Shopify resource gid (which always starts with
// `gid://`).
export function isStandaloneNote(entry: SelectionEntry): boolean {
  return !entry.id.startsWith('gid://');
}

// t2t.tsx -- reorganized edition of template-to-text.tsx.
//
// Session 1 was a structural pass over the original, not a rewrite: the same code, in the same
// relative order, grouped under named section banners; the three inline `if (view === X) return
// (<JSX>)` blocks at the bottom of the Extension component extracted into named closures (still
// closing over the same component state); a handful of duplicated GraphQL error-handling /
// read-mutate-write blocks consolidated into two shared helpers (formatGraphQLErrors,
// mutateTemplateList).
//
// Session 2 made targeted, individually-reasoned fixes against a specific review-point list: the
// SelectionEntry/NoteObject data model was unified, the product/variant field token catalogs were
// generated from one source instead of two, several duplicated brace-depth-scanning primitives were
// consolidated, the variable-name grammar was de-restricted, and the bulk-select buttons were
// re-scoped to the current page.
//
// Session 3 closed out the remaining safe/contained logged items: packTemplatesIntoShards' O(n^2)
// shard-packing is now O(n) (verified against the old algorithm via a 500-trial randomized Python
// simulation before porting), allLoadedProducts/loadedProductsRef is now a bounded, FIFO-evicting
// cache instead of growing forever, PublicSelectionSlotId gives the public-vs-current selection
// split a real compile-time guarantee, and RESERVED_ASSIGNMENT_NAMES drift now fails loudly at
// module load instead of silently. Two items were deliberately left open rather than attempted
// blind -- the two boolean-expression grammars, and the deeper per-file block-finding re-scan --
// since each touches the highest-blast-radius code in this file with no compiler/test harness
// available to verify a change against; see "Pending a green light" in the
// doc below.
//
// See Documentation/Claude Docs/architecture-notes.md for the full study this file is based on,
// including the remaining known duplication/inefficiencies and why each one was or wasn't touched.

import { render } from 'preact';
import { useState, useEffect, useMemo, useRef } from 'preact/hooks';

// ----------------------------------------------------------------------------------------------
// DOMAIN TYPES
// ----------------------------------------------------------------------------------------------
interface VariantData {
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

interface MetafieldData {
  namespace: string;
  key: string;
  value: string;
}

interface ProductData {
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
type FileBreak = 'selection' | 'object' | 'product' | 'note' | 'variant';

interface TemplateData {
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
type BulkSelectMode = 'shown' | 'in-stock';

interface PageInfo {
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  startCursor: string | null;
  endCursor: string | null;
}

// Templates are stored sharded across up to 10 shop metafields in the `template_to_text` namespace
// (keys template_0..template_9). Each shard holds up to ~120KB of JSON to stay safely under the
// 131,072 byte platform metafield value limit, giving a combined effective cap of ~1.2MB.
// ----------------------------------------------------------------------------------------------
// TEMPLATE STORAGE -- constants & GraphQL queries
// Templates are sharded across up to 10 shop metafields (see SHARD_* below); saved product
// selections are six more shop metafields, defined further down under their own banner.
// ----------------------------------------------------------------------------------------------
const TEMPLATE_NAMESPACE = 'template_to_text';
const SHARD_COUNT = 10;
const SHARD_KEYS = [
  'template_0',
  'template_1',
  'template_2',
  'template_3',
  'template_4',
  'template_5',
  'template_6',
  'template_7',
  'template_8',
  'template_9',
];
// Max serialized JSON bytes per shard. Kept under the 131,072 byte platform limit with headroom.
const SHARD_MAX_BYTES = 122880;
// Legacy single-metafield location, read once for migration into the new shards. Never written to.
const LEGACY_NAMESPACE = 'sidekick';
const LEGACY_KEY = 'templates';
const STORAGE_FULL_MESSAGE = 'Template storage is full. Delete some templates before saving.';
// Bytes in one kilobyte, used to report how much extra storage a too-large template list would need.
const BYTES_PER_KB = 1024;
const PAGE_SIZE = 25;
// Hard cap on how many products the session-lifetime client-side search cache
// (allLoadedProducts/loadedProductsRef, see the Extension component) will hold. Without a cap that
// cache -- deliberately never cleared, since it's what powers client-side metafield/advanced-boolean
// search across every page and search the merchant has run this session -- grows without bound for
// a long-lived session. FIFO eviction (oldest-LOADED product dropped first, not oldest-selected or
// least-recently-searched) is used once this cap is exceeded: simple to reason about, and a
// SELECTED product's own data is never affected by eviction (selectedProducts holds its own
// independent full copy) -- the only consequence is that loadProductsByIds may need one extra,
// harmless network fetch if an evicted product is later referenced by id again.
const LOADED_PRODUCTS_CACHE_LIMIT = 3000;

const PRODUCTS_QUERY = `query SearchProducts($first: Int, $after: String, $last: Int, $before: String, $query: String) {
  products(first: $first, after: $after, last: $last, before: $before, sortKey: CREATED_AT, reverse: true, query: $query) {
    edges {
      node {
        id
        title
        handle
        vendor
        productType
        tags
        status
        description
        totalInventory
        featuredMedia { ... on MediaImage { image { url } } }
        priceRangeV2 {
          minVariantPrice { amount currencyCode }
          maxVariantPrice { amount currencyCode }
        }
        createdAt
        updatedAt
        variants(first: 100) {
          edges {
            node {
              id
              title
              sku
              price
              compareAtPrice
              inventoryItem { unitCost { amount } }
              barcode
              inventoryQuantity
              selectedOptions { name value }
            }
          }
        }
        metafields(first: 50) {
          edges {
            node { namespace key value }
          }
        }
      }
    }
    pageInfo { hasNextPage hasPreviousPage endCursor startCursor }
  }
}`;

// Reads the shop's own gid (used as the metafield ownerId), the shop primary domain, all four shard
// metafields (aliased shard0..shard3), and the legacy metafield (aliased `legacy`) used for one-time
// migration. Stored as unstructured shop metafields (no definition), so access is governed purely by
// the app's API scopes and shared across all staff who use the app.
const TEMPLATES_READ_QUERY = `query ReadTemplates {
  shop {
    id
    primaryDomain {
      host
    }
    ${SHARD_KEYS.map(
      (key, index) =>
        `shard${index}: metafield(namespace: "${TEMPLATE_NAMESPACE}", key: "${key}") { value }`,
    ).join('\n    ')}
    legacy: metafield(namespace: "${LEGACY_NAMESPACE}", key: "${LEGACY_KEY}") { value }
  }
}`;

const TEMPLATES_WRITE_MUTATION = `mutation WriteTemplates($metafields: [MetafieldsSetInput!]!) {
  metafieldsSet(metafields: $metafields) {
    metafields { id value }
    userErrors { field message code }
  }
}`;

// --- Saved product selections ------------------------------------------------------------------
// Six PUBLIC selections are shared by everyone on the shop. Each selection is one unstructured shop
// metafield of type `json` holding an array of product GIDs, so it persists across logins, devices,
// and staff members. No user identity is required to read or write them.
const SELECTION_MAX_PRODUCTS = 4000;
// Product ids are re-fetched in chunks so one `nodes` call never asks for too much nested data.
const SELECTION_FETCH_CHUNK = 50;

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
interface SelectionEntry {
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
function isStandaloneNote(entry: SelectionEntry): boolean {
  return !entry.id.startsWith('gid://');
}

// Maximum length of a public selection's subtitle, shown under its name in the Selections menu.
const SUBTITLE_MAX_LENGTH = 16;
// Single shop metafield holding every public selection's subtitle, keyed by slot id.
const SUBTITLES_KEY = 'sel_subtitles';

type SelectionSlotId =
  | 'current'
  | 'public_1'
  | 'public_2'
  | 'public_3'
  | 'public_4'
  | 'public_5'
  | 'public_6';

// The 6 saved/shared slots, excluding 'current' -- used to type the state maps that are only ever
// keyed by a public slot (selectionEntries, selectionNotes below), so a future accidental
// `selectionEntries['current']` read is a compile error instead of silently resolving to
// `undefined`/`[]`. Previously those maps were typed `Record<string, ...>`, which accepted any
// string key including 'current', so this invariant was enforced only by one early-return inside
// openSelectionView, not by the type checker.
type PublicSelectionSlotId = Exclude<SelectionSlotId, 'current'>;

const PUBLIC_SLOTS: PublicSelectionSlotId[] = [
  'public_1',
  'public_2',
  'public_3',
  'public_4',
  'public_5',
  'public_6',
];
// (Selecting from a public slot uses PUBLIC_SLOTS directly -- there used to be a second constant,
// SAVED_SLOTS, defined as a literal copy of this array with no behavioral difference from it.)

function selectionSlotLabel(slot: SelectionSlotId): string {
  if (slot === 'current') return 'Current Selection';
  return `Public Selection ${slot.slice(-1)}`;
}

// The metafield key for a saved slot. Every saved slot uses a fixed key shared by the whole shop.
function selectionMetafieldKey(slot: SelectionSlotId): string | null {
  if (slot === 'current') return null;
  return `sel_public_${slot.slice(-1)}`;
}

const SELECTIONS_READ_QUERY = `query ReadSelections($ns: String!, $pub1: String!, $pub2: String!, $pub3: String!, $pub4: String!, $pub5: String!, $pub6: String!, $subs: String!) {
  shop {
    id
    pub1: metafield(namespace: $ns, key: $pub1) { value }
    pub2: metafield(namespace: $ns, key: $pub2) { value }
    pub3: metafield(namespace: $ns, key: $pub3) { value }
    pub4: metafield(namespace: $ns, key: $pub4) { value }
    pub5: metafield(namespace: $ns, key: $pub5) { value }
    pub6: metafield(namespace: $ns, key: $pub6) { value }
    subs: metafield(namespace: $ns, key: $subs) { value }
  }
}`;

const PRODUCTS_BY_IDS_QUERY = `query ProductsByIds($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on Product {
      id
      title
      handle
      vendor
      productType
      tags
      status
      description
      totalInventory
      featuredMedia { ... on MediaImage { image { url } } }
      priceRangeV2 {
        minVariantPrice { amount currencyCode }
        maxVariantPrice { amount currencyCode }
      }
      createdAt
      updatedAt
      variants(first: 100) {
        edges {
          node {
            id
            title
            sku
            price
            compareAtPrice
            inventoryItem { unitCost { amount } }
            barcode
            inventoryQuantity
            selectedOptions { name value }
          }
        }
      }
      metafields(first: 50) {
        edges {
          node { namespace key value }
        }
      }
    }
  }
}`;

// ----------------------------------------------------------------------------------------------
// STORAGE PARSING -- turn raw metafield JSON / GraphQL nodes into typed data
// Covers selections, notes, subtitles, products (mapProduct), and templates (mapStoredTemplate,
// serialize/parse/pack-into-shards).
// ----------------------------------------------------------------------------------------------

// Generate a placeholder id for a new free-standing note entry. Guaranteed to never collide with a
// real Shopify gid (which always starts with `gid://`), which is what isStandaloneNote checks for.
function generateNoteId(): string {
  return `note-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// Build a new free-standing note entry from typed text.
function createNoteEntry(note: string): SelectionEntry {
  return { id: generateNoteId(), note };
}

// Parse a stored selection metafield value into its ordered list of entries -- product references
// and free-standing notes together, exactly as stored (see the SelectionEntry comment above for why
// they're the same shape). Accepts the current `{id, note, variantIds?}` shape, the legacy plain
// array of gid strings (loaded with an empty note and every variant), and the legacy `{type:'note',
// id, content, createdAt, source}` note-object shape still sitting in already-saved selections
// (`content` maps to `note`; `type`/`createdAt`/`source` are no longer tracked, since nothing ever
// read them back). A missing, empty, or unparseable value yields an empty list.
function parseSelectionItems(rawValue: any): SelectionEntry[] {
  if (rawValue == null || rawValue === '') return [];
  try {
    const parsed = JSON.parse(rawValue);
    if (!Array.isArray(parsed)) return [];
    const items: SelectionEntry[] = [];
    for (const item of parsed) {
      if (typeof item === 'string') {
        items.push({ id: item, note: '' });
      } else if (item && item.type === 'note' && typeof item.content === 'string') {
        items.push({
          id: typeof item.id === 'string' && item.id ? item.id : generateNoteId(),
          note: item.content,
        });
      } else if (item && typeof item.id === 'string') {
        const variantIds =
          Array.isArray(item.variantIds) && item.variantIds.every((v: any) => typeof v === 'string')
            ? (item.variantIds as string[])
            : undefined;
        items.push({
          id: item.id,
          note: typeof item.note === 'string' ? item.note : '',
          ...(variantIds && variantIds.length > 0 ? { variantIds } : {}),
        });
      }
    }
    return items;
  } catch {
    return [];
  }
}

// Whether a free-standing note entry's text matches a search term (case-insensitive substring).
function noteMatchesQuery(entry: SelectionEntry, rawQuery: string): boolean {
  const query = rawQuery.trim().toLowerCase();
  if (query === '') return true;
  return (entry.note || '').toLowerCase().includes(query);
}

// Parse the stored subtitles metafield value into a slot -> subtitle map. A missing, empty, or
// unparseable value yields an empty map, so no subtitle line is rendered.
function parseSubtitles(rawValue: any): Record<string, string> {
  if (rawValue == null || rawValue === '') return {};
  try {
    const parsed = JSON.parse(rawValue);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const map: Record<string, string> = {};
    for (const slot of PUBLIC_SLOTS) {
      const value = (parsed as any)[slot];
      if (typeof value === 'string' && value !== '') {
        map[slot] = value.slice(0, SUBTITLE_MAX_LENGTH);
      }
    }
    return map;
  } catch {
    return {};
  }
}

function mapProduct(node: any): ProductData {
  const priceMinObj = node.priceRangeV2?.minVariantPrice;
  const priceMaxObj = node.priceRangeV2?.maxVariantPrice;
  const variantList: VariantData[] = (node.variants?.edges || []).map((e: any) => ({
    id: e.node.id,
    title: e.node.title || '',
    sku: e.node.sku ?? null,
    price: e.node.price ?? null,
    compareAtPrice: e.node.compareAtPrice ?? null,
    costPerItem: e.node.inventoryItem?.unitCost?.amount ?? null,
    barcode: e.node.barcode ?? null,
    inventoryQuantity: e.node.inventoryQuantity ?? null,
    selectedOptions: e.node.selectedOptions || [],
  }));
  return {
    id: node.id,
    title: node.title || '',
    handle: node.handle || '',
    vendor: node.vendor || '',
    productType: node.productType || '',
    tags: Array.isArray(node.tags) ? node.tags : [],
    status: node.status || '',
    description: node.description || '',
    totalInventory: node.totalInventory ?? null,
    imageUrl: node.featuredMedia?.image?.url || null,
    priceMin: priceMinObj?.amount || '',
    priceMax: priceMaxObj?.amount || '',
    currencyCode: priceMinObj?.currencyCode || priceMaxObj?.currencyCode || '',
    createdAt: node.createdAt || '',
    updatedAt: node.updatedAt || '',
    variants: variantList,
    allVariants: variantList,
    metafields: (node.metafields?.edges || []).map((e: any) => ({
      namespace: e.node.namespace,
      key: e.node.key,
      value: e.node.value,
    })),
    // Notes are attached from the current selection / a loaded selection, never from the API.
    note: '',
  };
}

// Narrow a product's `.variants` to a chosen subset of variant ids (out of `.allVariants`), for
// partial variant selection. `variantIds` absent, empty, matching nothing, or matching every variant
// all mean "no narrowing" -- the product's full variant list is used unchanged -- so a stale id (a
// variant deleted after being selected) degrades to "every variant" rather than an empty product.
// Shared by the main page's selectedProductList memo and by openSelectionView's hydration of a saved
// selection's stored variantIds.
function narrowToSelectedVariants(
  product: ProductData,
  variantIds: string[] | undefined,
): ProductData {
  if (!variantIds || variantIds.length === 0) {
    return product;
  }
  const idSet = new Set(variantIds);
  const narrowed = product.allVariants.filter((v) => idSet.has(v.id));
  if (narrowed.length === 0 || narrowed.length === product.allVariants.length) {
    return product;
  }
  return { ...product, variants: narrowed };
}

// Generate a stable id for a template from its title plus a time/random suffix. Used as the React
// key and selection id, and to match templates within the stored JSON array. Never changes once set.
function generateTemplateId(title: string): string {
  const random = Math.random().toString(36).slice(2, 8);
  return `${slugify(title)}-${Date.now().toString(36)}-${random}`;
}

const FILE_BREAK_VALUES: FileBreak[] = ['selection', 'object', 'product', 'note', 'variant'];

// Labels for the "File break" menu in the template editor.
const FILE_BREAK_LABELS: Record<FileBreak, string> = {
  selection: 'Selection (one file)',
  object: 'Object (product or note)',
  product: 'Product',
  note: 'Note',
  variant: 'Variant',
};

// RETIRED as of session 7, per explicit direction ("depreciate inferred file type -- this now must
// be user specified"): a template saved before `fileBreak` existed (session 4) used to have a value
// GUESSED for it from what the body happened to contain (an untied variant foreach -> 'variant'; a
// selection.foreach -> 'selection'; otherwise -> 'variant', the long-standing default). That
// inference is gone. `mapStoredTemplate` below now leaves `fileBreak` as `null` for any such
// template instead of guessing -- explicit, and visibly unset in the editor, until a merchant opens
// it and chooses one. `planOutputFiles` refuses to build any file for a null fileBreak (a clear,
// actionable error, not a guess) rather than silently defaulting to something that might not match
// what a merchant actually wants for that specific template.

// Map one raw entry from the stored JSON array into a TemplateData, defaulting missing fields and
// generating an id when absent. JSON parsing already yields real newline characters, so no extra
// newline unescaping is needed.
function mapStoredTemplate(entry: any): TemplateData {
  const title = typeof entry?.title === 'string' ? entry.title : '';
  const body = typeof entry?.body === 'string' ? entry.body : '';
  const fileBreak: FileBreak | null =
    typeof entry?.fileBreak === 'string' &&
    (FILE_BREAK_VALUES as string[]).includes(entry.fileBreak)
      ? (entry.fileBreak as FileBreak)
      : null;
  return {
    id: typeof entry?.id === 'string' && entry.id ? entry.id : generateTemplateId(title),
    title,
    body,
    extension: typeof entry?.extension === 'string' ? entry.extension : '',
    pinned: entry?.pinned === true,
    pinnedAt:
      typeof entry?.pinnedAt === 'number' && Number.isFinite(entry.pinnedAt)
        ? entry.pinnedAt
        : null,
    fileBreak,
    mergeCondition: typeof entry?.mergeCondition === 'string' ? entry.mergeCondition : '',
  };
}

// Serialize ONE template into the JSON representation it has inside a shard's array. Shared by
// serializeTemplates (which just brackets+joins many of these -- verified below to produce a
// byte-identical string to a plain JSON.stringify(list.map(...)) call) and by
// packTemplatesIntoShards' incremental byte-length tracking.
function serializeTemplateEntry(t: TemplateData): string {
  return JSON.stringify({
    id: t.id,
    title: t.title,
    body: t.body,
    extension: t.extension,
    pinned: t.pinned === true,
    // An unpinned template never carries a stale timestamp.
    pinnedAt: t.pinned === true ? (t.pinnedAt ?? null) : null,
    fileBreak: t.fileBreak,
    mergeCondition: t.mergeCondition,
  });
}

// Serialize a template list into the JSON string stored in a shard metafield. `JSON.stringify` of an
// array with no `space` argument is always exactly `[` + each element's own JSON.stringify output,
// comma-joined + `]` -- so building it this way (bracket + join) is byte-for-byte identical to
// `JSON.stringify(list.map(...))`, which is what makes packTemplatesIntoShards' incremental
// byte-length tracking below exact rather than approximate.
function serializeTemplates(list: TemplateData[]): string {
  return `[${list.map(serializeTemplateEntry).join(',')}]`;
}

// Byte length of a UTF-8 encoded string, used to measure serialized shard sizes against the cap.
function byteLength(str: string): number {
  let bytes = 0;
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      i += 1;
    } else bytes += 3;
  }
  return bytes;
}

// Parse one shard/legacy metafield value into a template list. Returns { list, unparseable } so the
// caller can surface a non-blocking error when a stored value exists but cannot be read.
function parseShardValue(rawValue: any): { list: TemplateData[]; unparseable: boolean } {
  if (rawValue == null || rawValue === '') {
    return { list: [], unparseable: false };
  }
  let parsed: any;
  try {
    parsed = JSON.parse(rawValue);
  } catch {
    return { list: [], unparseable: true };
  }
  if (!Array.isArray(parsed)) {
    return { list: [], unparseable: true };
  }
  return { list: parsed.map((entry) => mapStoredTemplate(entry)), unparseable: false };
}

// Greedily pack a template list into up to SHARD_COUNT shards by serialized JSON byte size: fill
// shard 0 until adding the next template would exceed SHARD_MAX_BYTES, then overflow into the next
// shard, and so on. Always returns exactly SHARD_COUNT arrays (empty arrays for unused shards) so
// every shard is (re)written on save, clearing stale data in higher shards. Returns overflow=true
// when the list does not fit within SHARD_COUNT shards.
//
// Tracks each shard's running CONTENT byte length incrementally (every already-packed template's
// own serialized size, plus one byte per comma between them) instead of re-serializing and
// re-measuring the whole growing shard array for every template considered. The old approach
// (`byteLength(serializeTemplates([...shard, template]))` on every attempt) cost O(k) work to add
// the k-th template to a shard, i.e. O(n^2) total for n templates landing in one shard.
// `shardContentBytes[i] + 2` (for the wrapping `[` `]`) is exactly
// `byteLength(serializeTemplates(shards[i]))` -- see serializeTemplates' comment for why the two
// serialization strategies agree byte-for-byte.
function packTemplatesIntoShards(list: TemplateData[]): {
  shards: TemplateData[][];
  overflow: boolean;
} {
  const shards: TemplateData[][] = [];
  const shardContentBytes: number[] = [];
  for (let s = 0; s < SHARD_COUNT; s++) {
    shards.push([]);
    shardContentBytes.push(0);
  }
  let shardIndex = 0;
  let overflow = false;
  for (const template of list) {
    const entryBytes = byteLength(serializeTemplateEntry(template));
    while (shardIndex < SHARD_COUNT) {
      const isFirstInShard = shards[shardIndex].length === 0;
      // +1 for the comma that joins this element to the shard's existing ones, when there are any.
      const candidateContentBytes =
        shardContentBytes[shardIndex] + entryBytes + (isFirstInShard ? 0 : 1);
      if (candidateContentBytes + 2 <= SHARD_MAX_BYTES) {
        shards[shardIndex].push(template);
        shardContentBytes[shardIndex] = candidateContentBytes;
        break;
      }
      // This template doesn't fit in the current shard. If the shard is empty, the single template
      // itself exceeds the cap and can never fit -- treat as overflow. Otherwise move to next shard.
      if (isFirstInShard) {
        overflow = true;
        break;
      }
      shardIndex += 1;
    }
    if (shardIndex >= SHARD_COUNT || overflow) {
      overflow = true;
      break;
    }
  }
  return { shards, overflow };
}

// How much MORE storage (in whole kilobytes) would be needed to save this template list. The raw
// serialized size is compared against the combined capacity of all shards; because packing is greedy,
// a list can overflow before its raw total exceeds the cap, in which case one shard's worth of extra
// storage is reported as the shortfall.
function storageShortfallKb(list: TemplateData[]): number {
  const capacity = SHARD_COUNT * SHARD_MAX_BYTES;
  const shortfall = byteLength(serializeTemplates(list)) - capacity;
  if (shortfall > 0) {
    return Math.ceil(shortfall / BYTES_PER_KB);
  }
  return Math.ceil(SHARD_MAX_BYTES / BYTES_PER_KB);
}

// The storage-full message shown when a write is aborted, including how much storage to add.
function storageFullMessage(list: TemplateData[]): string {
  return `${STORAGE_FULL_MESSAGE} Add ${storageShortfallKb(list)} KB of storage.`;
}

// Compact display of a product's total inventory for the Qty table column. A product with no
// inventory tracking (null totalInventory) shows an em dash instead of a number.
// ----------------------------------------------------------------------------------------------
// FORMATTING HELPERS -- small pure display/string utilities
// ----------------------------------------------------------------------------------------------
function formatQty(totalInventory: number | null): string {
  return totalInventory == null ? '—' : String(totalInventory);
}

function slugify(input: string): string {
  const s = input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || 'template';
}

function sanitizeExtension(ext: string): string {
  const cleaned = (ext || '').replace(/^\.+/, '').replace(/[^a-zA-Z0-9]/g, '');
  return cleaned || 'txt';
}

// ----------------------------------------------------------------------------------------------
// TEMPLATE ENGINE -- snippet catalog, date tokens, comment & whitespace passes
// The literal strings inserted by the editor's "Insert variable" / "Insert special" menus, plus
// the two pre-processing passes (stripComments, applyWhitespaceTokens/restoreWhitespaceTokens)
// that run before and after the token substitution pipeline further down.
// ----------------------------------------------------------------------------------------------
// Single source of truth for every plain (non-metafield) product field: its resolver key (matched
// in `{{ product.KEY }}`), the "Insert variable" menu label, any accepted alias key, and the
// resolver itself. PRODUCT_FIELD_TOKENS (the menu) and productFieldValue (the actual `{{
// product.* }}` resolver, further down) are both generated from this one list below, so a field can
// never exist in the menu without being resolvable, or be resolvable without appearing in the menu.
interface ProductFieldDef {
  key: string;
  label: string;
  aliases?: string[];
  resolve: (product: ProductData) => string;
}

const PRODUCT_FIELD_DEFS: ProductFieldDef[] = [
  { key: 'title', label: 'Product title', resolve: (p) => p.title },
  { key: 'handle', label: 'Product handle', resolve: (p) => p.handle },
  { key: 'vendor', label: 'Product vendor', resolve: (p) => p.vendor },
  {
    key: 'productType',
    label: 'Product type',
    aliases: ['product_type'],
    resolve: (p) => p.productType,
  },
  { key: 'status', label: 'Product status', resolve: (p) => p.status },
  { key: 'description', label: 'Product description', resolve: (p) => p.description },
  { key: 'tags', label: 'Product tags', resolve: (p) => p.tags.join(', ') },
  {
    key: 'totalInventory',
    label: 'Total inventory',
    resolve: (p) => (p.totalInventory == null ? '' : String(p.totalInventory)),
  },
  { key: 'priceMin', label: 'Min price', resolve: (p) => p.priceMin },
  { key: 'priceMax', label: 'Max price', resolve: (p) => p.priceMax },
  // Compare at price and cost per item live on the variant; at product level they resolve against
  // the row's ACTIVE variant (the product's first variant outside a variant loop).
  {
    key: 'compareAtPrice',
    label: 'Compare at price',
    resolve: (p) => p.variants[0]?.compareAtPrice || '',
  },
  { key: 'costPerItem', label: 'Cost per item', resolve: (p) => p.variants[0]?.costPerItem || '' },
  { key: 'currencyCode', label: 'Currency code', resolve: (p) => p.currencyCode },
  { key: 'createdAt', label: 'Created at', resolve: (p) => p.createdAt },
  { key: 'updatedAt', label: 'Updated at', resolve: (p) => p.updatedAt },
  // 'note' (singular) is the canonical key as of session 7, per explicit direction ("everything
  // should be note, like {{ product.note }}") -- 'notes' kept as an alias so any already-saved
  // template using the old {{ product.notes }} spelling keeps rendering unchanged.
  { key: 'note', label: 'Product note', aliases: ['notes'], resolve: (p) => p.note || '' },
];

const PRODUCT_FIELD_TOKENS: { token: string; label: string }[] = PRODUCT_FIELD_DEFS.map((f) => ({
  token: `{{ product.${f.key} }}`,
  label: f.label,
}));

// Same idea for variant fields: VARIANT_FIELD_TOKENS and variantFieldValue are both generated from
// this one list.
interface VariantFieldDef {
  key: string;
  label: string;
  resolve: (variant: VariantData) => string;
}

const VARIANT_FIELD_DEFS: VariantFieldDef[] = [
  { key: 'title', label: 'Variant title', resolve: (v) => v.title },
  { key: 'sku', label: 'Variant SKU', resolve: (v) => v.sku || '' },
  { key: 'price', label: 'Variant price', resolve: (v) => v.price || '' },
  {
    key: 'compareAtPrice',
    label: 'Variant compare at price',
    resolve: (v) => v.compareAtPrice || '',
  },
  { key: 'costPerItem', label: 'Variant cost per item', resolve: (v) => v.costPerItem || '' },
  { key: 'barcode', label: 'Variant barcode', resolve: (v) => v.barcode || '' },
  {
    key: 'inventoryQuantity',
    label: 'Variant inventory',
    resolve: (v) => (v.inventoryQuantity == null ? '' : String(v.inventoryQuantity)),
  },
];

const VARIANT_FIELD_TOKENS: { token: string; label: string }[] = VARIANT_FIELD_DEFS.map((f) => ({
  token: `{{ variant.${f.key} }}`,
  label: f.label,
}));

const FOREACH_BLOCK =
  '{{#selection.foreach product, i=0}}\n{{ product.title }} , {{ product.handle }}\n{{/selection.foreach product}}';

// Snippet inserted by the "If block" menu option. The condition defaults to {{ =0 }} (which resolves
// to the number 0, i.e. FALSE) so the author can replace it with their own boolean expression.
const IF_BLOCK = '{{ #if={{ =0 }} }}\n{{ /if }}';

// Snippet inserted by the "Chop block" menu option. Keeps the characters iterated over BEFORE the
// condition first becomes true; `direction` picks which end the walk starts from and `j` is the
// starting value of the step counter exposed as {{ j }} inside the condition.
const CHOP_BLOCK = '{{ #chop={{ {{j}}==3 }}, direction=L, j=1 }}\n{{/chop}}';

// Snippet inserted by the "String length" menu option: renders the character count of its content.
// Block form (session 10) -- see LENGTH_OPEN_SOURCE's comment for why this replaced {{ length=... }}.
const LENGTH_TOKEN = '{{ #length }}{{ product.title }}{{/length}}';

// Snippets inserted by the date/time menu options (session 9) -- see formatDateTime's comment for
// the full JungleDocs-style token table these format strings are written in.
const DATE_TOKEN = '{{ time=MM/dd/yyyy }}';
const TIME_TOKEN = '{{ time=h:mm tt }}';
const DATE_TIME_TOKEN = '{{ time=MM/dd/yyyy h:mm tt }}';
const WEEKDAY_DATE_TOKEN = '{{ time=dddd, MMMM d, yyyy }}';

// Snippet inserted by the "Repeat block" menu option: outputs its inner content N times, joined by
// the delineator (empty by default).
const REPEAT_BLOCK = '{{ #repeat=2, delineator= }}\n{{/repeat}}';

// Snippet inserted by the "Replace" menu option (session 13): replaces every occurrence of the
// search text in its inner content with the replacement text. Both values are left blank in the
// inserted snippet so the author fills them in -- see parseReplaceParams/applyReplace.
const REPLACE_BLOCK = '{{ #replace=, replacement= }}\n{{/replace}}';

// Snippet inserted by the "While loop" menu option: a loop that re-tests a boolean condition every
// step (up to a hard MAX_WHILE_ITERATIONS safety cap) and does not step through the product
// selection. It MUST be closed with {{/while}}. This is the new, recommended `{{ #while=BOOL }}`
// form (session 6) -- no counter is bound by the tag itself; the example below declares and steps
// its own ordinary variable, exactly as any other counter would be. (The old
// `{{ while=BOOL, {{ k }} = MIN<MAX }}` form, with a tag-bound counter, still works for any
// already-saved template -- see WHILE_OPEN_SOURCE's comment.)
const WHILE_BLOCK = '{{ x = 1 }}\n{{ #while={{x}}<5 }}\n{{ x = {{ ={{x}}+1 }} }}\n{{/while}}';

// Snippet inserted by the "Index" menu option: returns a single character of its inner content.
const INDEX_BLOCK = '{{ #index=0 }}\n{{/index}}';

// Snippet inserted by the "Insert block" menu option: splices its inner content into the surrounding
// rendered output at a character position relative to the block.
const INSERT_BLOCK = '{{ #insert=0, drop=FALSE }}\n{{/insert}}';

// Snippet inserted by the "Variant foreach" menu option: steps through the current product/row's
// variants. `variants.foreach` is the new, recommended spelling (session 6) -- the old
// `product.foreach` spelling (no label slot) still works forever as a plain alias. The label after
// `variants.foreach` (here `v`) is purely cosmetic, like `selection.foreach`'s trailing word -- the
// loop item is always read via the existing `{{ variant.* }}` tokens, not the label.
const VARIANT_LOOP_BLOCK =
  '{{ #variants.foreach v, l=0 }}\n{{ variant.title }}\n{{/variants.foreach}}';

// Snippet inserted by the "Notes foreach" menu option (new, session 6): steps through the
// selection's free-standing notes. Every {{ product.* }}/{{ variant.* }} token except
// {{ product.note }} resolves to '' for a note, same rule as every other per-unit render of a note
// (see noteToPseudoProduct).
const NOTES_LOOP_BLOCK = '{{ #notes.foreach note, i=0 }}\n{{ product.note }}\n{{/notes.foreach}}';

// Snippet inserted by the "Tags foreach" menu option (new, session 6): steps through the current
// product/row's tags. Each iteration's tag text is read via the fixed {{ tag }} token (not the
// label after `tags.foreach`, which is cosmetic, same as every other foreach source).
const TAGS_LOOP_BLOCK = '{{ #tags.foreach tag, i=0 }}\n{{ tag }}\n{{/tags.foreach}}';

// Snippet inserted by the "Metafields foreach" menu option (new, session 10): steps through the
// current product/row's metafields. Each iteration's namespace/key/value are read via the fixed
// {{ mf.namespace }}/{{ mf.key }}/{{ mf.value }} tokens (not the label after `metafields.foreach`,
// which is cosmetic, same as every other foreach source).
const METAFIELDS_LOOP_BLOCK =
  '{{ #metafields.foreach mf, i=0 }}\n{{ mf.namespace }}.{{ mf.key }}: {{ mf.value }}\n{{/metafields.foreach}}';

// Snippet inserted by the "Boolean equation" menu option.
const BOOLEAN_TOKEN = '{{ TRUE != FALSE }}';

// Snippets inserted by the "Break" / "Skip" menu options (new, session 6) -- see BREAK_SENTINEL's
// comment for the full mechanism. Almost always used inside an if-block's branch, so the inserted
// snippet wraps one to be immediately useful rather than a bare token the author must wrap
// themselves.
const BREAK_TOKEN_BLOCK = '{{ #if={{ =0 }} }}\n{{ break }}\n{{ /if }}';
const SKIP_TOKEN_BLOCK = '{{ #if={{ =0 }} }}\n{{ skip }}\n{{ /if }}';

// Hard safety cap on while-loop iterations, on top of the required MIN/MAX bounds.
const MAX_WHILE_ITERATIONS = 10000;

// Weekday/month names for {{ time=FORMAT }} (session 9), spelled the standard way (Jan, not this
// file's own old irregular 'june'/'july'/'sept' abbreviations -- see formatDateTime's comment for
// why standard spelling was chosen deliberately over reusing this file's pre-existing convention).
const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tues', 'Wed', 'Thurs', 'Fri', 'Sat'];
const WEEKDAY_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_SHORT = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];
const MONTH_FULL = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

// Format one run of the SAME format-letter (e.g. "MMMM", "hh") against a Date, following the
// JungleDocs / .NET custom date-format token table -- see formatDateTime's comment for the full
// list. Returns the run itself, unchanged, for any letter not in that table (defensive; every
// caller only ever invokes this on a run whose first letter was already checked to be recognized).
function formatDateToken(date: Date, run: string): string {
  const letter = run[0];
  const len = run.length;
  const pad = (n: number, width: number): string => String(Math.abs(n)).padStart(width, '0');
  switch (letter) {
    case 'd':
      if (len >= 4) return WEEKDAY_FULL[date.getDay()];
      if (len === 3) return WEEKDAY_SHORT[date.getDay()];
      if (len === 2) return pad(date.getDate(), 2);
      return String(date.getDate());
    case 'M':
      if (len >= 4) return MONTH_FULL[date.getMonth()];
      if (len === 3) return MONTH_SHORT[date.getMonth()];
      if (len === 2) return pad(date.getMonth() + 1, 2);
      return String(date.getMonth() + 1);
    case 'y': {
      const fullYear = date.getFullYear();
      if (len >= 3) return String(fullYear);
      const twoDigit = ((fullYear % 100) + 100) % 100;
      return len === 2 ? pad(twoDigit, 2) : String(twoDigit);
    }
    case 'h': {
      const hour24 = date.getHours();
      const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
      return len >= 2 ? pad(hour12, 2) : String(hour12);
    }
    case 'H':
      return len >= 2 ? pad(date.getHours(), 2) : String(date.getHours());
    case 'm':
      return len >= 2 ? pad(date.getMinutes(), 2) : String(date.getMinutes());
    case 's':
      return len >= 2 ? pad(date.getSeconds(), 2) : String(date.getSeconds());
    case 't': {
      const isPM = date.getHours() >= 12;
      return len >= 2 ? (isPM ? 'PM' : 'AM') : isPM ? 'P' : 'A';
    }
    case 'f':
    case 'F': {
      // Real precision stops at milliseconds (3 digits); padded with zeros out to `len` (max 7,
      // matching the table's f..fffffff range). 'F' additionally drops trailing zero digits.
      const msDigits = (pad(date.getMilliseconds(), 3) + '0000').slice(0, len);
      return letter === 'F' ? msDigits.replace(/0+$/, '') : msDigits;
    }
    case 'K':
    case 'z': {
      // JS reports getTimezoneOffset() as minutes BEHIND UTC (positive west of UTC) -- inverted
      // from the conventional +HH:mm offset notation, so the sign is flipped here.
      const offsetMinutes = -date.getTimezoneOffset();
      const sign = offsetMinutes < 0 ? '-' : '+';
      const absMinutes = Math.abs(offsetMinutes);
      const offsetHours = Math.floor(absMinutes / 60);
      const remainderMinutes = absMinutes % 60;
      if (letter === 'K' || len >= 3) {
        return `${sign}${pad(offsetHours, 2)}:${pad(remainderMinutes, 2)}`;
      }
      return len === 2 ? `${sign}${pad(offsetHours, 2)}` : `${sign}${offsetHours}`;
    }
    default:
      return run;
  }
}

// {{ time=FORMAT }} (session 9): format the current render's captured date/time using JungleDocs-
// style custom date-format patterns (https://help-jungledocs.enovapoint.com/article/714-date-
// formatting-formulas -- itself the .NET custom date/time format string grammar). Recognized
// letters, each read as a RUN of repeated occurrences (so "MM" and "MMMM" are different tokens,
// not "M" twice):
//   d/dd            day of month, no/with leading zero          M/MM      month, no/with leading zero
//   ddd/dddd        weekday name, abbreviated/full                MMM/MMMM  month name, abbreviated/full
//   h/hh            12-hour hour, no/with leading zero            H/HH      24-hour hour, no/with leading zero
//   m/mm            minutes, no/with leading zero                 s/ss      seconds, no/with leading zero
//   t/tt            AM/PM, abbreviated (A/P) / full (AM/PM)        y/yy/yyy(y) year: unpadded 2-digit /
//                                                                             padded 2-digit / full 4-digit
//   f..fffffff      fractional seconds, zero-padded (real precision stops at milliseconds)
//   F..FFFFFFF      same, with trailing zero digits dropped
//   K, z/zz/zzz     time zone offset (K and zzz are always +HH:mm; z/zz are +H / +HH)
// Any other character (including `:` and `/`) passes through literally. Wrap literal text that
// would otherwise be misread as a token in single or double quotes: 'at' or "at".
// Example: {{ time=dddd, MMMM d, yyyy }}  ->  Tuesday, March 3, 2026
function formatDateTime(date: Date, format: string): string {
  const isTokenLetter = (ch: string): boolean => 'dMyHhmstKzfF'.includes(ch);
  let result = '';
  let i = 0;
  while (i < format.length) {
    const ch = format[i];
    if (ch === "'" || ch === '"') {
      const closeIndex = format.indexOf(ch, i + 1);
      if (closeIndex === -1) {
        result += format.slice(i + 1);
        i = format.length;
      } else {
        result += format.slice(i + 1, closeIndex);
        i = closeIndex + 1;
      }
      continue;
    }
    if (isTokenLetter(ch)) {
      let run = ch;
      let j = i + 1;
      while (format[j] === ch) {
        run += ch;
        j += 1;
      }
      result += formatDateToken(date, run);
      i = j;
      continue;
    }
    result += ch;
    i += 1;
  }
  return result;
}

const WRAP_BLOCK = '{{#wrap=80, min_wraps=0, max_wraps=0, hard=FALSE, delineator=}}\n{{/wrap}}';

const COMMENT_BLOCK = '{{ #comment }}\n\n{{ /comment }}';

// Remove every {{ #comment }} ... {{ /comment }} block (tags and inner content, across newlines) so
// comments never appear in generated output. Applied as the FIRST evaluation step. Uses a global,
// non-greedy regex so multiple comment blocks are all removed and an unclosed opening tag is left inert.
// RESERVED KEYWORD: 'comment' -- must stay listed in RESERVED_ASSIGNMENT_NAMES / RESERVED_KEYWORDS_IN_USE.
const COMMENT_REGEX = /\{\{\s*#comment\s*\}\}[\s\S]*?\{\{\s*\/comment\s*\}\}/g;

function stripComments(body: string): string {
  return body.replace(COMMENT_REGEX, '');
}

// Whitespace tokens: `{{ /return }}` resolves to a real newline and `{{ /space }}` resolves to a
// single space character. Both are leading/trailing whitespace agnostic between the braces. This
// runs as the FIRST compiler pass so the resulting whitespace is present for every later pass and
// survives trimming that would otherwise strip surrounding whitespace (e.g. inside a wrap
// `delineator=` value).
// The single backslash character, built via char code so it survives source formatting untouched --
// still needed below to DETECT (and flag as deprecated) the old backslash-letter spelling.
const BACKSLASH = String.fromCharCode(92);
// `WS` matches optional whitespace between braces so tokens are leading/trailing whitespace agnostic
// (e.g. `{{ /return }}`, `{{/return}}`, `{{  /return  }}`).
const WS = BACKSLASH + 's*';
const OPEN = BACKSLASH + '{' + BACKSLASH + '{';
const CLOSE = BACKSLASH + '}' + BACKSLASH + '}';
// `{{ /return }}` / `{{ /space }}` are the only supported spellings as of session 7 (see
// applyWhitespaceTokens for why the old `{{ \n }}` / `{{ \t }}` spelling is deprecated, not removed
// outright).
const RETURN_TOKEN_PATTERN = OPEN + WS + '/return' + WS + CLOSE;
const SPACE_ALIAS_TOKEN_PATTERN = OPEN + WS + '/space' + WS + CLOSE;
// RETIRED (session 7), per explicit direction -- kept only so applyWhitespaceTokens can still
// DETECT the old spelling and flag it as deprecated, rather than letting it fall through to the
// generic pass-through and render silently wrong (an unrecognized `\n`/`\t` two-character token
// resolves to '', same silent-failure shape the session-6 regex bug had).
const NEWLINE_TOKEN_PATTERN = OPEN + WS + BACKSLASH + BACKSLASH + 'n' + WS + CLOSE;
const SPACE_TOKEN_PATTERN = OPEN + WS + BACKSLASH + BACKSLASH + 't' + WS + CLOSE;

// The literal menu snippets inserted for the New line / Space options: `{{ /return }}` and
// `{{ /space }}`, the canonical spellings as of session 7.
const NEWLINE_TOKEN_SNIPPET = '{{ /return }}';
const SPACE_TOKEN_SNIPPET = '{{ /space }}';

// Non-whitespace, non-brace placeholder characters that stand in for a token-produced newline / space
// during compilation. Control chars (U+0001 / U+0002) never appear in real templates or product data,
// and crucially they are NOT matched by \s, so they survive every whitespace trim (including the wrap
// tag's `delineator=` trimming) and are only turned into real whitespace at the very end.
const NEWLINE_SENTINEL = String.fromCharCode(1);
const SPACE_SENTINEL = String.fromCharCode(2);

// `{{ break }}` / `{{ skip }}` (added session 6, loop redesign) -- like the whitespace sentinels
// above, these are non-printable control characters (U+0003 / U+0004) that can never appear in a
// real template or in product data, embedded in a loop iteration's rendered text by
// renderTokenContent's bare-token check (see below) and detected+stripped ONLY by the loop-driving
// code (expandForeachBlocks, applyVariantLoop, the tags loop, applyWhileLoop) -- every other caller
// of renderTokens/renderTemplateText never inspects for them, so a `{{ break }}`/`{{ skip }}` typed
// outside any loop simply renders as an invisible, inert character (effectively nothing), exactly
// the same "outside its context, harmlessly does nothing" behavior every other loop-scoped token in
// this file already has (e.g. `{{ variant.* }}` outside a variant loop). This mirrors the marker
// pattern already proven out for the unresolved-variable fix (session 5): an in-band sentinel,
// substring-detected at one specific call site, needs no new return type threaded through the whole
// render pipeline -- far less invasive than changing every function's signature to carry a separate
// out-of-band signal.
// Both discard the current iteration's ENTIRE rendered output (not just the text from the token
// onward -- text before AND after `{{ break }}`/`{{ skip }}` in that same iteration still renders
// normally, in the usual left-to-right token order, but the iteration's combined result is thrown
// away rather than appended once either sentinel is found in it); `{{ break }}` additionally stops
// the loop from running any further iterations, `{{ skip }}` only discards the current one and
// continues. Both are almost always reached conditionally, inside an `{{ #if=... }}` branch -- no
// new conditional grammar is needed for that, it composes with the existing one for free.
const BREAK_SENTINEL = String.fromCharCode(3);
const SKIP_SENTINEL = String.fromCharCode(4);

// Whether a loop iteration's rendered text carries a `{{ break }}` and/or `{{ skip }}` signal.
function loopControlSignal(text: string): { discard: boolean; stop: boolean } {
  const stop = text.indexOf(BREAK_SENTINEL) !== -1;
  const discard = stop || text.indexOf(SKIP_SENTINEL) !== -1;
  return { discard, stop };
}

function applyWhitespaceTokens(body: string): string {
  // Encode `{{ /return }}` / `{{ /space }}` as sentinels. Runs as the FIRST compiler pass so the
  // sentinels are present for every later pass. Because sentinels are not whitespace, token-produced
  // whitespace is never eaten by trimming -- so the tokens work anywhere, including at the edge of a
  // wrap delineator, while genuinely typed whitespace stays trim-able (agnostic).
  // The OLD `{{ \n }}` / `{{ \t }}` spelling is retired (session 7): matched here ONLY so it can be
  // replaced with a visible deprecatedSyntaxMarker instead of silently doing nothing (see
  // NEWLINE_TOKEN_PATTERN's comment) -- this must run BEFORE the sentinel replacements below, since
  // the marker text itself is plain prose (no braces), so it cannot be mistaken for a whitespace
  // token by a later pass.
  const deprecatedNewline = deprecatedSyntaxMarker(
    'the backslash-n whitespace token is retired -- use the /return token instead',
  );
  const deprecatedSpace = deprecatedSyntaxMarker(
    'the backslash-t whitespace token is retired -- use the /space token instead',
  );
  const withDeprecatedFlagged = body
    .replace(new RegExp(NEWLINE_TOKEN_PATTERN, 'g'), deprecatedNewline)
    .replace(new RegExp(SPACE_TOKEN_PATTERN, 'g'), deprecatedSpace);
  const returnToken = new RegExp(RETURN_TOKEN_PATTERN, 'g');
  const spaceAliasToken = new RegExp(SPACE_ALIAS_TOKEN_PATTERN, 'g');
  return withDeprecatedFlagged
    .replace(returnToken, NEWLINE_SENTINEL)
    .replace(spaceAliasToken, SPACE_SENTINEL);
}

function restoreWhitespaceTokens(text: string): string {
  // Turn the whitespace sentinels back into real characters. Runs as the LAST step, after wrapping,
  // so nothing downstream can strip them.
  return text.split(NEWLINE_SENTINEL).join(String.fromCharCode(10)).split(SPACE_SENTINEL).join(' ');
}

// ----------------------------------------------------------------------------------------------
// TEMPLATE ENGINE -- field/variable resolution
// productFieldValue / variantFieldValue / metafieldValue resolve a dotted token path against one
// product; EvalContext carries the per-render variable store, selection length, primary domain,
// and precomputed date parts that every render pass below reads from.
// ----------------------------------------------------------------------------------------------
// Built once from PRODUCT_FIELD_DEFS/VARIANT_FIELD_DEFS (declared above, alongside the menu token
// lists they also drive), including every alias, so each resolver is a single map lookup instead of
// a hand-written switch that had to be kept in sync with the menu list by hand.
const PRODUCT_FIELD_RESOLVERS: Record<string, (product: ProductData) => string> = (() => {
  const map: Record<string, (product: ProductData) => string> = {};
  for (const def of PRODUCT_FIELD_DEFS) {
    map[def.key] = def.resolve;
    for (const alias of def.aliases || []) {
      map[alias] = def.resolve;
    }
  }
  return map;
})();

const VARIANT_FIELD_RESOLVERS: Record<string, (variant: VariantData) => string> =
  Object.fromEntries(VARIANT_FIELD_DEFS.map((f) => [f.key, f.resolve]));

function productFieldValue(product: ProductData, field: string): string {
  const resolve = PRODUCT_FIELD_RESOLVERS[field];
  return resolve ? resolve(product) : '';
}

function variantFieldValue(variant: VariantData | undefined, field: string): string {
  if (!variant) return '';
  const resolve = VARIANT_FIELD_RESOLVERS[field];
  return resolve ? resolve(variant) : '';
}

function metafieldValue(product: ProductData, namespace: string, key: string): string {
  const mf = product.metafields.find((m) => m.namespace === namespace && m.key === key);
  return mf ? mf.value || '' : '';
}

// What kind of thing a rendered row/unit actually is -- exposed via `{{ selection.curr.type }}` /
// `{{ selection.next.type }}` / `{{ selection.prev.type }}` (session 9). 'variant' is a single
// variant-row (one product, one variant -- what `expandSelectionToRows`/'variant' fileBreak mode
// produce); 'product' is a whole product, all/narrowed variants intact (what 'product'/'object'
// fileBreak mode's per-product units are, and NOT what a `selection.foreach` loop ever iterates,
// since that always variant-expands first); 'note' is a free-standing note, always represented via
// `noteToPseudoProduct`. Not derivable from a `ProductData`'s own shape (a genuinely single-variant
// product looks identical to a variant-expanded row), so it's threaded alongside the row rather than
// inferred from it.
type RowKind = 'product' | 'variant' | 'note';

// A row/unit paired with its own kind -- what `selection.next`/`selection.prev` (session 9) resolve
// against. See RowKind's comment and `partitionByMergeCondition` below.
interface KindedRow {
  row: ProductData;
  kind: RowKind;
}

// Per-render evaluation context: the current loop counter value (`i`), the total number of products
// the merchant selected (`selectionLength`), the shop's primary domain host (`primaryDomain`), and
// the single Date captured for this download (`now`, formatted on demand by {{ time=FORMAT }} --
// session 9; was a precomputed `DateParts` struct before this session, when the only date tokens
// were the fixed set now deprecated in resolveOnProduct). Threaded through token substitution and
// math evaluation so `{{ i }}`, `{{ selection.length }}`, `{{ primaryDomain }}`, `{{ time=... }}`,
// and equations can all read these values.
interface EvalContext {
  selectionLength: number;
  primaryDomain: string;
  now: Date;
  // The shared, MUTABLE variable store for this file render. Every variable (i, j, k, l, x, y, z plus
  // any counter name bound by a while loop) lives here as a string and defaults to EMPTY. Loops and
  // `{{ x = ... }}` assignments write to this same object, so a value written inside a nested loop
  // stays visible to the enclosing loop's next iteration.
  vars: Record<string, string>;
  // Session 9: what `{{ selection.curr.type }}`/`{{ selection.next.* }}`/`{{ selection.prev.* }}`
  // resolve against. Set ONCE per top-level render unit (a 'selection'-mode foreach iteration, or a
  // per-unit fileBreak mode's one unit) and left UNCHANGED for the rest of that render, including
  // inside any nested variant/tag/while loop within it -- these describe the current render's
  // position in the overall output sequence, not "whatever the innermost loop happens to be
  // iterating right now." `next`/`prev` are null when there is no neighboring unit (first/last
  // position), which is what makes the tokens resolve to '' rather than erroring.
  currKind: RowKind;
  prev: KindedRow | null;
  next: KindedRow | null;
  // Session 10: the metafield currently being iterated by a `{{ #metafields.foreach }}` block, read
  // via the fixed `{{ mf.namespace }}`/`{{ mf.key }}`/`{{ mf.value }}` tokens (see
  // resolveOnProduct) -- the same "fixed token name, cosmetic label" convention `{{ tag }}` inside
  // `tags.foreach` already established. OPTIONAL, unlike currKind/prev/next above: this is a much
  // more narrowly-scoped feature, so rather than touch every EvalContext construction site in the
  // file, this is simply left `undefined` everywhere except applyMetafieldsLoop, which is exactly
  // when `{{ mf.* }}` should resolve to '' anyway (there's no current metafield to report).
  currentMetafield?: MetafieldData | null;
}

// The variable names offered in the Variables menu, as convenient shortcuts -- variables are NOT
// limited to these seven. Any name that (a) contains no whitespace, (b) contains none of the
// characters listed above IDENTIFIER_REGEX (they're reserved by the surrounding token grammar), and
// (c) is not a protected tag keyword (RESERVED_ASSIGNMENT_NAMES) can be read with `{{ name }}`,
// written with `{{ name = VALUE }}`, and used as the counter of a foreach / variant foreach / chop /
// while block.
const VARIABLE_NAMES = ['i', 'j', 'k', 'l', 'x', 'y', 'z'];
// Snippet inserted by the "Assign variable" menu option.
const ASSIGN_TOKEN = '{{ x = }}';

// A fresh variable store for one output file: every variable starts empty.
function createVarStore(): Record<string, string> {
  const store: Record<string, string> = {};
  for (const name of VARIABLE_NAMES) {
    store[name] = '';
  }
  return store;
}

// Read a variable as a number for counter arithmetic. An empty / non-numeric value counts as 0.
function readVarNumber(vars: Record<string, string>, name: string): number {
  const num = parseFloat(vars[name] == null ? '' : vars[name]);
  return Number.isFinite(num) ? num : 0;
}

// Resolve a `product.x` / `product.metafield.ns.key` / `variant.x` / `i` / `selection.length` /
// `primaryDomain` / date token against a specific product and evaluation context.
function resolveOnProduct(product: ProductData, parts: string[], ctx: EvalContext): string {
  // Variables (i, j, k, l, x, y, z and any while-loop counter) resolve to their current stored value,
  // which is the empty string until something writes to them.
  if (parts.length === 1 && Object.prototype.hasOwnProperty.call(ctx.vars, parts[0])) {
    const stored = ctx.vars[parts[0]];
    return stored == null ? '' : stored;
  }
  // {{ mf.namespace }} / {{ mf.key }} / {{ mf.value }} (session 10): the metafield currently being
  // iterated by a {{ #metafields.foreach }} block -- see EvalContext.currentMetafield's comment.
  // Resolves to '' outside such a loop (ctx.currentMetafield is undefined/null there).
  if (parts.length === 2 && parts[0] === 'mf') {
    if (!ctx.currentMetafield) return '';
    if (parts[1] === 'namespace') return ctx.currentMetafield.namespace;
    if (parts[1] === 'key') return ctx.currentMetafield.key;
    if (parts[1] === 'value') return ctx.currentMetafield.value;
    return '';
  }
  // Number of variants on the product (always the FULL variant list, even inside a row clone).
  if (parts.length === 2 && parts[0] === 'product' && parts[1] === 'length') {
    const list =
      product.allVariants && product.allVariants.length > 0
        ? product.allVariants
        : product.variants;
    return String(list ? list.length : 0);
  }
  // Backward-compatible aliases {{ products.note }} / {{ products.notes }} for the canonical
  // {{ product.note }} token (handled by productFieldValue below, along with the {{ product.notes }}
  // alias) -- productFieldValue's dispatch is scoped to `product.*` only, so the PLURAL object name
  // "products" needs its own small special case here for full note/notes x product/products
  // coverage. Session 7: 'note' is the canonical field spelling; 'notes' stays supported for any
  // already-saved template.
  if (
    parts.length === 2 &&
    parts[0] === 'products' &&
    (parts[1] === 'note' || parts[1] === 'notes')
  ) {
    return product.note || '';
  }
  if (parts.length === 1 && parts[0] === 'primaryDomain') {
    return ctx.primaryDomain;
  }
  // RETIRED (session 9), per explicit direction: these six fixed date tokens are replaced by the
  // single, far more versatile {{ time=FORMAT }} token (see formatDateTime) -- still detected here
  // so a template using one renders a visible deprecatedSyntaxMarker instead of silently going blank
  // (the DateParts/computeDateParts values these used to read no longer exist at all -- EvalContext
  // now carries the raw `now: Date` that {{ time=FORMAT }} formats on demand instead).
  if (parts.length === 1 && parts[0] === 'day') {
    return deprecatedSyntaxMarker('the bare day token is retired -- use the time=dd token instead');
  }
  if (parts.length === 2 && parts[0] === 'day' && parts[1] === 'week') {
    return deprecatedSyntaxMarker(
      'the day.week token is retired -- use the time=ddd token instead',
    );
  }
  if (parts.length === 1 && parts[0] === 'month') {
    return deprecatedSyntaxMarker(
      'the bare month token is retired -- use the time=MM token instead',
    );
  }
  if (parts.length === 2 && parts[0] === 'month' && parts[1] === 'name') {
    return deprecatedSyntaxMarker(
      'the month.name token is retired -- use the time=MMM token instead',
    );
  }
  if (parts.length === 1 && parts[0] === 'year') {
    return deprecatedSyntaxMarker(
      'the bare year token is retired -- use the time=yyyy token instead',
    );
  }
  if (parts.length === 2 && parts[0] === 'year' && parts[1] === 'short') {
    return deprecatedSyntaxMarker(
      'the year.short token is retired -- use the time=yy token instead',
    );
  }
  if (parts.length === 2 && parts[0] === 'selection' && parts[1] === 'length') {
    return String(ctx.selectionLength);
  }
  // Metafield: {{ product.metafield.<namespace>.<key> }}
  if (parts[0] === 'product' && parts[1] === 'metafield' && parts.length >= 4) {
    const ns = parts[2];
    const key = parts.slice(3).join('.');
    return metafieldValue(product, ns, key);
  }
  if (parts[0] === 'product' && parts.length === 2) {
    return productFieldValue(product, parts[1]);
  }
  if (parts[0] === 'variant' && parts.length === 2) {
    return variantFieldValue(product.variants[0], parts[1]);
  }
  return '';
}

// Expand a single product into one "row" per variant: a shallow product clone whose `variants` array
// contains only that one variant, so `{{ variant.* }}` resolves to that variant. A product with no
// variants yields a single row (the product unchanged, variant tokens resolve to empty).
function expandProductToRows(product: ProductData): ProductData[] {
  if (!product.variants || product.variants.length <= 1) {
    return [product];
  }
  return product.variants.map((variant) => ({ ...product, variants: [variant] }));
}

// Expand a list of selected products into rows (one entry per variant), preserving product order.
function expandSelectionToRows(products: ProductData[]): ProductData[] {
  const rows: ProductData[] = [];
  for (const product of products) {
    for (const row of expandProductToRows(product)) {
      rows.push(row);
    }
  }
  return rows;
}

// Resolve a single trimmed token expression (the text between {{ and }}, without surrounding braces)
// to its string value, honoring `selection.first.*` / `selection.last.*` prefixes plus
// product/variant/metafield/i/selection.length. `selection.first`/`selection.last` resolve the field
// path that follows against the first/last product in the selection; `selection.length` (and all
// other tokens) fall through to resolveOnProduct.
function resolveTokenExpr(
  expr: string,
  product: ProductData,
  list: ProductData[],
  ctx: EvalContext,
): string {
  const trimmed = expr.trim();
  const parts = trimmed.split('.');
  if (parts[0] === 'selection' && parts[1] === 'first') {
    return resolveOnProduct(list[0], parts.slice(2), ctx);
  }
  if (parts[0] === 'selection' && parts[1] === 'last') {
    return resolveOnProduct(list[list.length - 1], parts.slice(2), ctx);
  }
  // Session 9: `{{ selection.curr/next/prev.type }}` and `{{ selection.curr/next/prev.product/
  // variant.FIELD }}` -- the current render's position in the overall output sequence (see
  // EvalContext.currKind/prev/next's comment). `curr` is always defined (it's just `product`/
  // `ctx.currKind`, the row already being rendered); `next`/`prev` are null at the last/first
  // position, which is exactly when these resolve to '' -- no neighbor to describe.
  if (
    parts[0] === 'selection' &&
    (parts[1] === 'curr' || parts[1] === 'next' || parts[1] === 'prev')
  ) {
    const slot = parts[1];
    const neighbor =
      slot === 'curr'
        ? { row: product, kind: ctx.currKind }
        : slot === 'next'
          ? ctx.next
          : ctx.prev;
    if (!neighbor) return '';
    if (parts[2] === 'type' && parts.length === 3) {
      return neighbor.kind;
    }
    return resolveOnProduct(neighbor.row, parts.slice(2), ctx);
  }
  return resolveOnProduct(product, parts, ctx);
}

// ----------------------------------------------------------------------------------------------
// TEMPLATE ENGINE -- token scanning primitives (brace-depth-aware parsing)
// Small hand-rolled scanners (topLevelEqualsIndex, topLevelLessThanIndex, hasBooleanOperator, and
// renderTokenContent/renderTemplateText, the single left-to-right token scanner every render pass
// goes through) that all share the same "count {{ / }} depth while scanning" shape as the block
// finders and findMatchingClose below -- see architecture-notes.md for the dedup opportunity.
// ----------------------------------------------------------------------------------------------
// Tag keywords that may never be used as a variable name, so tokens such as `{{ length=... }}` keep
// their own meaning instead of being read as an assignment.
//
// THIS LIST IS HAND-MAINTAINED and is NOT derived from the individual block-tag regexes
// (CHOP_OPEN_SOURCE, REPEAT_OPEN_SOURCE, LENGTH_PREFIX_REGEX, the parameter-name checks inside
// parseChopParams/parseWrapParams/etc., ...) scattered through the rest of this file -- adding a new
// block type or tag parameter there and forgetting to add its keyword HERE means that keyword would
// silently be readable/writable as a plain variable (`{{ myNewKeyword = 5 }}`) instead of being
// recognized as the new tag. Every site below that introduces a new reserved keyword is marked with
// a `// RESERVED KEYWORD:` comment as a reminder; RESERVED_KEYWORDS_IN_USE right below cross-checks
// against those sites at module load, so a forgotten entry fails loudly (a thrown error) instead of
// silently. Fully deriving this set from the regex sources themselves was considered and rejected as
// riskier than it's worth: the sources have inconsistent shapes (`while=` has no leading `#`; `else`
// and the parameter names have no dedicated regex constant at all, just inline literals), so an
// automated extractor would itself be a second thing that could quietly drift or break.
const RESERVED_ASSIGNMENT_NAMES = new Set([
  'length',
  'while',
  'insert',
  'if',
  'else',
  'comment',
  'wrap',
  'repeat',
  'index',
  'chop',
  'trim',
  'delineator',
  'direction',
  'drop',
  'tied',
  'hard',
  'min_wraps',
  'max_wraps',
  'skip_first',
  'skip_last',
  // Added session 6, with the loop redesign:
  'break',
  'skip',
  'tag',
  // Added session 9, with the {{ time=FORMAT }} token:
  'time',
  // Added session 13, with the replace block:
  'replace',
  'replacement',
]);

// Cross-check list for the reminder above: every keyword actually introduced by a
// `// RESERVED KEYWORD:` comment elsewhere in this file, kept immediately next to
// RESERVED_ASSIGNMENT_NAMES so the two are as hard as possible to edit out of sync. Throws
// immediately at module load if the two ever disagree, rather than failing silently at render time.
const RESERVED_KEYWORDS_IN_USE = [
  'length',
  'while',
  'insert',
  'if',
  'else',
  'comment',
  'wrap',
  'repeat',
  'index',
  'chop',
  'trim',
  'delineator',
  'direction',
  'drop',
  'tied',
  'hard',
  'min_wraps',
  'max_wraps',
  'skip_first',
  'skip_last',
  'break',
  'skip',
  'tag',
  'time',
  'replace',
  'replacement',
];
for (const keyword of RESERVED_KEYWORDS_IN_USE) {
  if (!RESERVED_ASSIGNMENT_NAMES.has(keyword)) {
    throw new Error(
      `"${keyword}" is marked as a RESERVED KEYWORD in use elsewhere in this file but is missing ` +
        'from RESERVED_ASSIGNMENT_NAMES -- it could silently be read/written as a plain variable.',
    );
  }
}

// A variable/counter name is NOT restricted to a conventional identifier shape (letters/digits/
// underscore, no leading digit) -- it can be any non-empty run of non-whitespace characters, as
// long as it (a) isn't a protected tag keyword (RESERVED_ASSIGNMENT_NAMES above) and (b) doesn't
// contain any character that is itself structurally meaningful inside a token, which would make the
// name ambiguous with the surrounding grammar:
//   {  }        block delimiters
//   .           field-path separator (`product.title`, `day.week`, ...)
//   =           assignment / comparison
//   < > ! & |   comparison and boolean operators
//   ,           tag-parameter separator
//   ( )         boolean-expression grouping
// Anything else -- letters, digits, punctuation like `-`, `'`, `?`, non-ASCII characters, a name
// that starts with a digit, etc. -- is a valid variable name.
// None of `{ } . = < > ! & | , ( )` need escaping inside a `[...]` character class.
const IDENTIFIER_REGEX = /^[^\s{}.=<>!&|,()]+$/;
const ASSIGNMENT_REGEX = /^([^\s{}.=<>!&|,()]+)\s*=(?!=)/;
// RESERVED KEYWORD: 'length' -- must stay listed in RESERVED_ASSIGNMENT_NAMES / RESERVED_KEYWORDS_IN_USE.
const LENGTH_PREFIX_REGEX = /^length\s*=/;
// RESERVED KEYWORD: 'time' -- must stay listed in RESERVED_ASSIGNMENT_NAMES / RESERVED_KEYWORDS_IN_USE.
const TIME_PREFIX_REGEX = /^time\s*=/;

// Shared brace-depth scanner underlying topLevelEqualsIndex, topLevelLessThanIndex,
// hasBooleanOperator, and splitTopLevelCommas below -- previously each of the four hand-rolled its
// own copy of this exact loop. Walks `text` from the start, treating `{{`/`}}` as nesting depth
// in/out markers (an unbalanced `}}` is clamped at depth 0, since callers scan arbitrary
// sub-expressions that are not themselves guaranteed to be balanced). `onChar(i, depth)` is called
// for every character that is not itself part of a `{{`/`}}` pair; returning true stops the scan
// and that index is returned, otherwise the scan runs to the end of `text` and -1 is returned.
function scanTopLevel(text: string, onChar: (i: number, depth: number) => boolean): number {
  let depth = 0;
  let i = 0;
  while (i < text.length) {
    if (text[i] === '{' && text[i + 1] === '{') {
      depth += 1;
      i += 2;
      continue;
    }
    if (text[i] === '}' && text[i + 1] === '}') {
      if (depth > 0) depth -= 1;
      i += 2;
      continue;
    }
    if (onChar(i, depth)) {
      return i;
    }
    i += 1;
  }
  return -1;
}

// Index of the first `=` that sits outside any {{ }} group and is not part of a comparison operator
// (==, !=, <=, >=). Returns -1 when there is none.
function topLevelEqualsIndex(text: string): number {
  return scanTopLevel(text, (i, depth) => {
    if (depth !== 0 || text[i] !== '=') return false;
    const prev = i > 0 ? text[i - 1] : '';
    const next = text[i + 1] || '';
    return next !== '=' && prev !== '=' && prev !== '!' && prev !== '<' && prev !== '>';
  });
}

// Index of the first `<` that sits outside any {{ }} group, used to split a loop counter value into
// its START and MAX (chunk size) parts. Returns -1 when there is none.
function topLevelLessThanIndex(text: string): number {
  return scanTopLevel(text, (i, depth) => depth === 0 && text[i] === '<');
}

// Whether the token text contains a comparison or logical operator at brace depth 0, which makes it
// a BOOLEAN expression token (rendered as TRUE / FALSE) rather than a plain field token.
function hasBooleanOperator(text: string): boolean {
  return (
    scanTopLevel(text, (i, depth) => {
      if (depth !== 0) return false;
      const two = text.slice(i, i + 2);
      return (
        two === '==' ||
        two === '!=' ||
        two === '<=' ||
        two === '>=' ||
        two === '&&' ||
        two === '||' ||
        text[i] === '<' ||
        text[i] === '>'
      );
    }) !== -1
  );
}

// Render ONE token's inner text (the text between {{ and }}, braces excluded).
// Recognition order: block delimiters -> math equation -> length token -> variable assignment ->
// boolean expression -> plain field/variable token. `numeric` is true when the caller needs a
// number, in which case an empty or non-numeric result renders as `0`.
function renderTokenContent(
  inner: string,
  product: ProductData,
  allProducts: ProductData[],
  ctx: EvalContext,
  numeric: boolean,
): string {
  const trimmed = inner.trim();
  if (trimmed === '') {
    return numeric ? '0' : '';
  }
  // Block delimiters are handled by their own passes; leave them exactly as written.
  if (trimmed[0] === '#' || trimmed[0] === '/') {
    return '{{' + inner + '}}';
  }
  // RESERVED KEYWORD: 'break', 'skip' -- must stay listed in RESERVED_ASSIGNMENT_NAMES /
  // RESERVED_KEYWORDS_IN_USE. Bare loop-control tokens (session 6) -- see BREAK_SENTINEL's comment
  // for the full mechanism. Checked early (same tier as the block-delimiter pass-through above) so
  // they're recognized regardless of numeric context; a loop-driving caller strips/reacts to the
  // sentinel, every other caller just carries it through inertly.
  if (trimmed === 'break') return BREAK_SENTINEL;
  if (trimmed === 'skip') return SKIP_SENTINEL;
  // Math equation {{ =EXPR }}.
  if (trimmed[0] === '=') {
    const expression = renderNested(trimmed.slice(1), product, allProducts, ctx, true);
    try {
      const value = evaluateMathExpression(expression);
      if (Number.isFinite(value)) {
        return String(value);
      }
    } catch (err: any) {
      // A bare (forgotten-braces) variable reference inside the equation is surfaced as a visible
      // marker instead of silently rendering nothing, so the mistake is obvious in the output
      // rather than looking like a data problem. Only safe when plain text can appear here --
      // inside a NUMERIC context (a chop counter, a foreach chunk size, an insert position, ...)
      // this still falls back to '0' below, since inserting text there would break whatever numeric
      // parsing comes next; applyIfBlocks additionally checks for this marker in a condition's
      // resolved text (numeric=false there too) so a malformed condition doesn't silently pick a
      // branch based on a broken string comparison.
      const message = err && typeof err.message === 'string' ? err.message : '';
      if (!numeric && message.indexOf(UNRESOLVED_VARIABLE_ERROR_PREFIX) === 0) {
        return unresolvedVariableMarker(message.slice(UNRESOLVED_VARIABLE_ERROR_PREFIX.length));
      }
      // Fall through to the empty / zero result below for every other parse failure.
    }
    return numeric ? '0' : '';
  }
  // RETIRED (session 10), per explicit direction: {{ length=STRING }} is replaced by the block form
  // {{ #length }}STRING{{/length}} (see the 'length' case in renderTokens' dispatch), for consistency
  // with every other text tool (chop/repeat/index/insert/wrap), which are all block-shaped rather
  // than a bare `tag=value` token. Still DETECTED here so a template using the old form renders a
  // visible deprecatedSyntaxMarker instead of a length count.
  const lengthMatch = trimmed.match(LENGTH_PREFIX_REGEX);
  if (lengthMatch) {
    return deprecatedSyntaxMarker(
      'the length=STRING token is retired -- use {{ #length }}STRING{{ /length }} instead',
    );
  }
  // Formatted date/time {{ time=FORMAT }} (session 9). Replaces the old bare {{ day }}/{{ month }}/
  // {{ year }}/{{ day.week }}/{{ month.name }}/{{ year.short }} tokens (now deprecated, see
  // resolveOnProduct) with one far more versatile token using JungleDocs-style date-format patterns
  // -- see formatDateTime's own comment for the full token table.
  const timeMatch = trimmed.match(TIME_PREFIX_REGEX);
  if (timeMatch) {
    const format = renderNested(
      trimmed.slice(timeMatch[0].length),
      product,
      allProducts,
      ctx,
      false,
    );
    return formatDateTime(ctx.now, format);
  }
  // Variable assignment {{ name = VALUE }}: writes the shared store and renders nothing.
  const assignmentMatch = trimmed.match(ASSIGNMENT_REGEX);
  if (assignmentMatch && !RESERVED_ASSIGNMENT_NAMES.has(assignmentMatch[1].toLowerCase())) {
    const value = renderNested(
      trimmed.slice(assignmentMatch[0].length),
      product,
      allProducts,
      ctx,
      false,
    ).trim();
    ctx.vars[assignmentMatch[1]] = value;
    return '';
  }
  // Boolean expression token, e.g. {{ TRUE != FALSE }} or {{ {{=({{x}}+{{i}})%4}} == 0 }}.
  if (hasBooleanOperator(trimmed)) {
    const resolved = renderNested(trimmed, product, allProducts, ctx, false);
    try {
      const result = evaluateBooleanExpression(resolved);
      if (numeric) {
        return result ? '1' : '0';
      }
      return result ? 'TRUE' : 'FALSE';
    } catch {
      return numeric ? '0' : '';
    }
  }
  // Plain field / variable token.
  const list = allProducts.length > 0 ? allProducts : [product];
  const raw = resolveTokenExpr(trimmed, product, list, ctx);
  if (numeric) {
    const parsed = parseFloat(raw);
    return Number.isFinite(parsed) ? String(parsed) : '0';
  }
  return raw;
}

// Render every {{ ... }} token in `text` with ONE left-to-right, brace-depth-aware scan, so tokens
// are evaluated in document order. This is what makes variable assignments predictable:
// `{{ x = 5 }}{{ x }}` renders `5`, while `{{ x }}{{ x = 5 }}` renders the previous value of x.
function renderTemplateText(
  text: string,
  product: ProductData,
  allProducts: ProductData[],
  ctx: EvalContext,
  numeric: boolean,
): string {
  let result = '';
  let i = 0;
  while (i < text.length) {
    if (text[i] === '{' && text[i + 1] === '{') {
      const closeEnd = findMatchingClose(text, i);
      if (closeEnd !== -1) {
        const inner = text.slice(i + 2, closeEnd - 2);
        result += renderTokenContent(inner, product, allProducts, ctx, numeric);
        i = closeEnd;
        continue;
      }
    }
    result += text[i];
    i += 1;
  }
  return result;
}

// Whether a tag parameter key names a VARIABLE (a loop counter) rather than one of the fixed tag
// options such as `tied`, `direction`, or `skip_first`.
function isVariableName(key: string): boolean {
  return IDENTIFIER_REGEX.test(key) && !RESERVED_ASSIGNMENT_NAMES.has(key.toLowerCase());
}

// ----------------------------------------------------------------------------------------------
// TEMPLATE ENGINE -- arithmetic expression evaluator ({{ =EXPR }})
// ----------------------------------------------------------------------------------------------
// --- Arithmetic expression evaluator ---------------------------------------------------------
// A self-contained tokenizer + recursive-descent parser used for {{ =EXPR }} equations. It supports
// + - * / % ^ (exponentiation, right-associative), unary minus, and parentheses. JavaScript `eval`
// is intentionally NOT used so that `^` means exponentiation rather than bitwise XOR. Throws on any
// malformed input so callers can catch and render an empty string.
//
// A variable is ALWAYS referenced with its own {{ }} inside an equation (e.g. `{{ = {{i}}%4 }}`) --
// never bare (`{{ = i%4 }}` is invalid). tokenizeMath below specifically detects a bare identifier
// and throws an error prefixed with UNRESOLVED_VARIABLE_ERROR_PREFIX, naming the identifier; this is
// caught in exactly two places -- renderTokenContent's math branch and applyIfBlocks -- to surface a
// visible marker (see unresolvedVariableMarker) in the rendered output instead of silently rendering
// nothing or (worse, inside an {{ #if=EXPR }} condition) silently always taking whichever branch a
// broken string comparison happens to land on.
const UNRESOLVED_VARIABLE_ERROR_PREFIX = 'UNRESOLVED_VARIABLE:';

// The visible marker rendered in place of a failed equation/condition when the failure was
// specifically an unresolved bare variable reference (see UNRESOLVED_VARIABLE_ERROR_PREFIX above).
// Deliberately contains NO literal `{{`/`}}` characters: this text can end up back inside a larger
// string that gets fed through another render pass (applyIfBlocks' own output is re-scanned by
// renderTokens right after it runs) -- a `{{ name }}` written INTO the marker as a "here's the fix"
// example would itself be resolved on that second pass and silently replaced by name's actual
// value, corrupting the very message meant to explain the mistake. Spelling the fix out in words
// instead avoids that trap entirely.
function unresolvedVariableMarker(name: string): string {
  return `[[ unresolved variable "${name}" in equation -- wrap it in double curly braces ]]`;
}

// Whether an already-rendered string contains an unresolvedVariableMarker (used by applyIfBlocks to
// detect that part of a condition never actually evaluated, rather than proceeding to compare a
// broken string and silently picking a branch).
function containsUnresolvedVariableMarker(text: string): boolean {
  return text.includes('unresolved variable "');
}

// Session 7: a general-purpose "this old syntax is retired" marker, same shape and same reasoning as
// unresolvedVariableMarker above -- rendered in place of running the OLD behavior for a construct
// whose old form was deliberately removed (see the while/tied/whitespace-token deprecations below),
// so an already-saved template that used the old form fails LOUDLY and ACTIONABLY (naming exactly
// what changed) instead of silently rendering wrong or empty output the way the regex bug and the
// bare-variable bug both did before they were caught. Deliberately contains NO literal `{{`/`}}`
// characters, for the same reason unresolvedVariableMarker doesn't: this text can end up back inside
// a string that gets fed through another render pass, and a literal `{{ ... }}` written into it as a
// "here's the fix" example would itself be resolved on that pass, corrupting the message.
function deprecatedSyntaxMarker(description: string): string {
  return `[[ deprecated syntax removed -- ${description} ]]`;
}

type MathToken = { type: 'num'; value: number } | { type: 'op'; value: string };

function tokenizeMath(input: string): MathToken[] {
  const tokens: MathToken[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i += 1;
      continue;
    }
    if ((ch >= '0' && ch <= '9') || ch === '.') {
      let num = '';
      while (i < input.length && ((input[i] >= '0' && input[i] <= '9') || input[i] === '.')) {
        num += input[i];
        i += 1;
      }
      const value = parseFloat(num);
      if (!Number.isFinite(value)) {
        throw new Error('Invalid number in equation');
      }
      tokens.push({ type: 'num', value });
      continue;
    }
    if ('+-*/%^()'.indexOf(ch) !== -1) {
      tokens.push({ type: 'op', value: ch });
      i += 1;
      continue;
    }
    // A run of letters/digits/underscore that isn't a valid number is almost always a variable
    // reference the author forgot to wrap in its own {{ }} -- e.g. `{{ = i%4 }}` instead of the
    // correct `{{ = {{i}}%4 }}`. A genuine variable's VALUE is always substituted to a plain number
    // by renderTemplateText before this tokenizer ever runs (see renderTokenContent's math branch),
    // so an identifier can only reach here by mistake. Thrown with a distinctive, parseable message
    // (UNRESOLVED_VARIABLE_ERROR_PREFIX) so callers can surface a specific, actionable error instead
    // of silently rendering nothing -- see renderTokenContent and applyIfBlocks.
    if (/[A-Za-z_]/.test(ch)) {
      let ident = '';
      while (i < input.length && /[A-Za-z0-9_]/.test(input[i])) {
        ident += input[i];
        i += 1;
      }
      throw new Error(UNRESOLVED_VARIABLE_ERROR_PREFIX + ident);
    }
    throw new Error('Unexpected character in equation');
  }
  return tokens;
}

// Recursive-descent parser/evaluator over the token stream.
function evaluateMathExpression(input: string): number {
  const tokens = tokenizeMath(input);
  let pos = 0;

  const peek = (): MathToken | undefined => tokens[pos];

  // primary := number | '(' expr ')' | ('+'|'-') primary
  const parsePrimary = (): number => {
    const tok = peek();
    if (!tok) throw new Error('Unexpected end of equation');
    if (tok.type === 'op' && (tok.value === '+' || tok.value === '-')) {
      pos += 1;
      const operand = parsePrimary();
      return tok.value === '-' ? -operand : operand;
    }
    if (tok.type === 'op' && tok.value === '(') {
      pos += 1;
      const value = parseAddSub();
      const close = peek();
      if (!close || close.type !== 'op' || close.value !== ')') {
        throw new Error('Missing closing parenthesis');
      }
      pos += 1;
      return value;
    }
    if (tok.type === 'num') {
      pos += 1;
      return tok.value;
    }
    throw new Error('Unexpected token in equation');
  };

  // power := primary ('^' power)?  (right-associative)
  const parsePower = (): number => {
    const base = parsePrimary();
    const tok = peek();
    if (tok && tok.type === 'op' && tok.value === '^') {
      pos += 1;
      const exponent = parsePower();
      return Math.pow(base, exponent);
    }
    return base;
  };

  // mulDiv := power (('*'|'/'|'%') power)*
  const parseMulDiv = (): number => {
    let value = parsePower();
    let tok = peek();
    while (
      tok &&
      tok.type === 'op' &&
      (tok.value === '*' || tok.value === '/' || tok.value === '%')
    ) {
      pos += 1;
      const right = parsePower();
      if (tok.value === '*') value = value * right;
      else if (tok.value === '/') value = value / right;
      else value = value % right;
      tok = peek();
    }
    return value;
  };

  // addSub := mulDiv (('+'|'-') mulDiv)*
  const parseAddSub = (): number => {
    let value = parseMulDiv();
    let tok = peek();
    while (tok && tok.type === 'op' && (tok.value === '+' || tok.value === '-')) {
      pos += 1;
      const right = parseMulDiv();
      value = tok.value === '+' ? value + right : value - right;
      tok = peek();
    }
    return value;
  };

  const result = parseAddSub();
  if (pos !== tokens.length) {
    throw new Error('Unexpected trailing tokens in equation');
  }
  return result;
}

// Find matching closing `}}` for an opening `{{` at openIndex, counting nested `{{`/`}}` pairs so an
// equation body may itself contain `{{ ... }}` tokens. Returns the index just past the closing `}}`,
// or -1 if unbalanced.
function findMatchingClose(text: string, openIndex: number): number {
  let depth = 0;
  let i = openIndex;
  while (i < text.length - 1) {
    if (text[i] === '{' && text[i + 1] === '{') {
      depth += 1;
      i += 2;
      continue;
    }
    if (text[i] === '}' && text[i + 1] === '}') {
      depth -= 1;
      i += 2;
      if (depth === 0) {
        return i;
      }
      continue;
    }
    i += 1;
  }
  return -1;
}

// --- Chop blocks -----------------------------------------------------------------------------
// {{ #chop=BOOLEAN, direction=L|R, j=START }} ... {{/chop}} keeps the characters iterated over
// BEFORE the condition first becomes true and discards the rest. `trim` is accepted as an alias for
// `chop` in both the opening and closing tag.
// A chop block has exactly the open/close-tag shape findTaggedBlock (declared further down, next to
// the repeat/while/index/insert/variant-foreach blocks that already share it) is built for, so it
// delegates there directly instead of re-implementing the same open->depth-scan->close matching by
// hand. ChopMatch keeps its own narrower type (the two extra TaggedBlock fields, innerStart/
// innerEnd, aren't meaningful for a chop block -- see the RenderBlock construction in
// findNextRenderBlock below, which fills them with the outer block bounds instead).
interface ChopMatch {
  params: string;
  inner: string;
  blockStart: number;
  blockEnd: number;
}

// RESERVED KEYWORD: 'chop', 'trim' -- must stay listed in RESERVED_ASSIGNMENT_NAMES / RESERVED_KEYWORDS_IN_USE.
// Built from a REAL regex literal's `.source`, not a plain string literal (see the long comment on
// IF_OPEN_SOURCE below for why that distinction is critical here -- a plain string literal like
// '\{\{\s*#(?:chop|trim)=' silently loses its `\s` to plain 's', breaking this exact regex the same
// way IF_OPEN_SOURCE was broken).
const CHOP_OPEN_SOURCE = /\{\{\s*#(?:chop|trim)=/.source;
const CHOP_CLOSE_SOURCE = /\{\{\s*\/(?:chop|trim)\s*\}\}/.source;

function findChopBlock(body: string, fromIndex: number): ChopMatch | null {
  return findTaggedBlock(body, fromIndex, CHOP_OPEN_SOURCE, CHOP_CLOSE_SOURCE);
}

// Split a chop parameter string on commas that sit outside any {{ }} group, so a condition may
// contain commas inside nested tokens.
function splitTopLevelCommas(text: string): string[] {
  const parts: string[] = [];
  let last = 0;
  scanTopLevel(text, (i, depth) => {
    if (depth === 0 && text[i] === ',') {
      parts.push(text.slice(last, i));
      last = i + 1;
    }
    return false;
  });
  parts.push(text.slice(last));
  return parts;
}

// Strip an outer {{ ... }} wrapper from a chop condition when the wrapper is just grouping (its
// inner text contains a nested token or a boolean/comparison operator), e.g. `{{ {{j}}==3 }}` or
// `{{{{j}} == 0}}`. A lone token such as `{{ product.title }}` is left intact so it still resolves.
function unwrapChopCondition(rawCondition: string): string {
  let expr = rawCondition.trim();
  for (let guard = 0; guard < 5; guard++) {
    if (expr.slice(0, 2) !== '{{' || expr.slice(-2) !== '}}') break;
    if (findMatchingClose(expr, 0) !== expr.length) break;
    const inner = expr.slice(2, -2).trim();
    const isGroup =
      inner.includes('{{') ||
      inner.includes('==') ||
      inner.includes('!=') ||
      inner.includes('<') ||
      inner.includes('>') ||
      inner.includes('&&') ||
      inner.includes('||') ||
      inner.includes('!');
    if (!isGroup) break;
    expr = inner;
  }
  return expr;
}

function parseChopParams(
  rawParams: string,
  product: ProductData,
  allProducts: ProductData[],
  ctx: EvalContext,
): { condition: string; direction: 'L' | 'R'; counterName: string; jStart: number } {
  const segments = splitTopLevelCommas(rawParams);
  const condition = unwrapChopCondition(segments[0] || '');
  let direction: 'L' | 'R' = 'L';
  let counterName = 'j';
  let jStart = 0;
  for (let k = 1; k < segments.length; k++) {
    const eqIndex = segments[k].indexOf('=');
    if (eqIndex === -1) continue;
    const key = segments[k].slice(0, eqIndex).trim();
    const rawValue = segments[k].slice(eqIndex + 1).trim();
    // RESERVED KEYWORD: 'direction' -- must stay listed in RESERVED_ASSIGNMENT_NAMES / RESERVED_KEYWORDS_IN_USE.
    if (key.toLowerCase() === 'direction') {
      direction = rawValue.toUpperCase() === 'R' ? 'R' : 'L';
    } else if (isVariableName(key)) {
      // Any of the interchangeable variables may be the chop step counter; `j` is the default.
      counterName = key;
      const resolved = resolveExprToNumber(rawValue, product, allProducts, ctx);
      jStart = resolved == null ? 0 : Math.round(resolved);
    }
  }
  return { condition, direction, counterName, jStart };
}

// Evaluate a chop condition for one step value of the counter j. Length tokens are resolved first,
// then math equations, then remaining plain tokens (including {{ j }}), then the boolean grammar.
// A malformed condition is treated as FALSE so iteration simply continues.
function chopConditionTrue(
  condition: string,
  counterName: string,
  jValue: number,
  product: ProductData,
  allProducts: ProductData[],
  ctx: EvalContext,
): boolean {
  ctx.vars[counterName] = String(jValue);
  return conditionIsTrue(condition, product, allProducts, ctx);
}

// Evaluate a boolean condition string against a product and evaluation context: length tokens first,
// then math equations, then remaining plain tokens (including loop counters), then the boolean
// grammar. An empty or malformed condition is FALSE.
function conditionIsTrue(
  condition: string,
  product: ProductData,
  allProducts: ProductData[],
  ctx: EvalContext,
): boolean {
  if (condition.trim() === '') return false;
  const resolved = renderNested(condition, product, allProducts, ctx, false);
  try {
    return evaluateBooleanExpression(resolved);
  } catch {
    return false;
  }
}

// Walk the (already rendered) string one character at a time from the left (direction L) or right
// (direction R), with j = jStart + step. Everything iterated over BEFORE the condition first becomes
// true is kept; the rest is discarded. If the condition is never true, the whole string is returned.
function applyChop(
  text: string,
  condition: string,
  direction: 'L' | 'R',
  counterName: string,
  jStart: number,
  product: ProductData,
  allProducts: ProductData[],
  ctx: EvalContext,
): string {
  const chars = Array.from(text);
  let kept = 0;
  while (kept < chars.length) {
    if (chopConditionTrue(condition, counterName, jStart + kept, product, allProducts, ctx)) {
      break;
    }
    kept += 1;
  }
  if (kept >= chars.length) {
    return text;
  }
  if (direction === 'R') {
    return chars.slice(chars.length - kept).join('');
  }
  return chars.slice(0, kept).join('');
}

// --- Repeat and for blocks ---------------------------------------------------------------------
// Generic brace-aware block finder used by the repeat and for blocks. `openSource`/`closeSource` are
// regex source strings for the opening and closing tags; nesting of the same block type is tracked so
// the matching closing tag is found. Returns the opening tag's parameter text, the inner content, and
// the block bounds.
interface TaggedBlock {
  params: string;
  inner: string;
  blockStart: number;
  blockEnd: number;
  // Bounds of the inner content, used when a pass needs to rewrite only what is between the tags.
  innerStart: number;
  innerEnd: number;
}

// Shared first step of every "{{ #tag=... }} ... {{/tag}}" block finder (findTaggedBlock below, and
// findIfBlock further down, which can't fully delegate to findTaggedBlock because it also has to
// track an optional {{ #else }} marker): locate the tag's OPENING delimiter at or after fromIndex,
// find its matching closing `}}` (which may itself contain nested {{ }} tokens, e.g.
// `{{ #if={{ x }}==1 }}`), and slice out the parameter text between them. Returns null when there's
// no complete opening tag from here on.
function findBlockOpen(
  body: string,
  fromIndex: number,
  openSource: string,
): { blockStart: number; openTagEnd: number; params: string } | null {
  const openRegex = new RegExp(openSource, 'g');
  openRegex.lastIndex = fromIndex;
  const openMatch = openRegex.exec(body);
  if (!openMatch) return null;
  const blockStart = openMatch.index;
  const openTagEnd = findMatchingClose(body, blockStart);
  if (openTagEnd === -1) return null;
  const params = body.slice(blockStart + openMatch[0].length, openTagEnd - 2);
  return { blockStart, openTagEnd, params };
}

function findTaggedBlock(
  body: string,
  fromIndex: number,
  openSource: string,
  closeSource: string,
): TaggedBlock | null {
  const open = findBlockOpen(body, fromIndex, openSource);
  if (!open) return null;
  const { blockStart, openTagEnd, params } = open;
  const scanRegex = new RegExp('(' + openSource + ')|(' + closeSource + ')', 'g');
  scanRegex.lastIndex = openTagEnd;
  let depth = 0;
  let scan: RegExpExecArray | null;
  while ((scan = scanRegex.exec(body)) !== null) {
    if (scan[1] !== undefined) {
      depth += 1;
      continue;
    }
    if (depth === 0) {
      return {
        params,
        inner: body.slice(openTagEnd, scan.index),
        blockStart,
        blockEnd: scan.index + scan[0].length,
        innerStart: openTagEnd,
        innerEnd: scan.index,
      };
    }
    depth -= 1;
  }
  return null;
}

// RESERVED KEYWORD: 'repeat' -- must stay listed in RESERVED_ASSIGNMENT_NAMES / RESERVED_KEYWORDS_IN_USE.
// See IF_OPEN_SOURCE's comment further down: these are `.source` of real regex literals, NOT plain
// string literals, because a plain string literal like '\{\{\s*#repeat=' silently loses its `\s` to
// a literal 's' character (JS drops the backslash before any character that isn't a recognized
// string escape), which broke every one of these tag-open/close matches for a merchant's very
// common `{{ #repeat=... }}`-with-a-space style -- found and fixed session 6.
const REPEAT_OPEN_SOURCE = /\{\{\s*#repeat=/.source;
const REPEAT_CLOSE_SOURCE = /\{\{\s*\/repeat\s*\}\}/.source;
// A while loop MUST open with `while=` (with or without a leading `#` -- see below) and close with
// `{{/while}}`; `{{/for}}` is not accepted.
// RESERVED KEYWORD: 'while' -- must stay listed in RESERVED_ASSIGNMENT_NAMES / RESERVED_KEYWORDS_IN_USE.
// The leading `#` is still accepted as OPTIONAL purely for open-tag DETECTION (`while` used to be the
// only block tag written without one; every other opener has always had it -- found session 6) --
// this is unrelated to the counter-binding deprecation below, just leniency in finding the tag at
// all. `{{ #while=BOOL }}` is the only supported/canonical form as of session 7 (see WHILE_BLOCK
// below). The OLD `{{ while=BOOL, {{ k }} = MIN<MAX }}` shape (a tag-bound counter, told apart from
// the new form by a top-level comma in the params -- see parseWhileParams) is RETIRED, per explicit
// direction: it is still recognized (so the tag is found rather than falling through to a raw-tag
// echo, the session-6 regex bug's exact failure shape) but no longer RUN -- a template using it now
// renders a visible deprecatedSyntaxMarker instead of the old bounded loop. No inference, no silent
// fallback: an old template using this form needs to be opened and updated.
const WHILE_OPEN_SOURCE = /\{\{\s*#?while=/.source;
const WHILE_CLOSE_SOURCE = /\{\{\s*\/while\s*\}\}/.source;
// RESERVED KEYWORD: 'replace', plus its parameter 'replacement' -- must stay listed in
// RESERVED_ASSIGNMENT_NAMES / RESERVED_KEYWORDS_IN_USE. (See IF_OPEN_SOURCE's comment for why these
// are real-regex-literal `.source`, not plain string literals.)
const REPLACE_OPEN_SOURCE = /\{\{\s*#replace=/.source;
const REPLACE_CLOSE_SOURCE = /\{\{\s*\/replace\s*\}\}/.source;
// RESERVED KEYWORD: 'index' -- must stay listed in RESERVED_ASSIGNMENT_NAMES / RESERVED_KEYWORDS_IN_USE.
const INDEX_OPEN_SOURCE = /\{\{\s*#index=/.source;
const INDEX_CLOSE_SOURCE = /\{\{\s*\/index\s*\}\}/.source;

function findRepeatBlock(body: string, fromIndex: number): TaggedBlock | null {
  return findTaggedBlock(body, fromIndex, REPEAT_OPEN_SOURCE, REPEAT_CLOSE_SOURCE);
}

function findWhileBlock(body: string, fromIndex: number): TaggedBlock | null {
  return findTaggedBlock(body, fromIndex, WHILE_OPEN_SOURCE, WHILE_CLOSE_SOURCE);
}

function findIndexBlock(body: string, fromIndex: number): TaggedBlock | null {
  return findTaggedBlock(body, fromIndex, INDEX_OPEN_SOURCE, INDEX_CLOSE_SOURCE);
}

function findReplaceBlock(body: string, fromIndex: number): TaggedBlock | null {
  return findTaggedBlock(body, fromIndex, REPLACE_OPEN_SOURCE, REPLACE_CLOSE_SOURCE);
}

// RESERVED KEYWORD: 'insert' -- must stay listed in RESERVED_ASSIGNMENT_NAMES / RESERVED_KEYWORDS_IN_USE.
// (See IF_OPEN_SOURCE's comment further down for why these are real-regex-literal `.source`, not
// plain string literals.)
const INSERT_OPEN_SOURCE = /\{\{\s*#insert=/.source;
const INSERT_CLOSE_SOURCE = /\{\{\s*\/insert\s*\}\}/.source;
// `{{ #variants.foreach [LABEL], l=0 }}` is the new, recommended spelling of this loop (iterates the
// CURRENT product/row's variants) -- `variant.foreach`/`variants.foreach` -- found session 6:
// `product.foreach` (the original, still-supported spelling) reused the word "product" to mean the
// loop's OWNER rather than the thing being iterated, which directly clashed with
// `selection.foreach product`'s use of the SAME word to mean the loop's ITEM -- confusing when read
// side by side. `product.foreach` (with no label slot at all -- its exact original shape) is kept
// working forever as a plain alias; no existing template needs to change. The optional LABEL after
// `variant(s).foreach` (like `selection.foreach`'s trailing word) is purely cosmetic/for readability
// -- it is not bound to anything; the loop item is always read via the existing `{{ variant.* }}`
// tokens, same as before.
const VARIANT_LOOP_OPEN_SOURCE = /\{\{\s*#(?:variants?\.foreach(?:\s+[^\s,{}]+)?|product\.foreach)/
  .source;
const VARIANT_LOOP_CLOSE_SOURCE = /\{\{\s*\/(?:variants?\.foreach|product\.foreach)\s*\}\}/.source;
// `{{ #tags.foreach [LABEL], i=0 }}` (new, session 6): steps through the CURRENT product/row's tags.
// The optional LABEL is purely cosmetic, same as every other foreach source's trailing word -- the
// loop item is always read via the fixed `{{ tag }}` token (see applyTagsLoop), not the label.
// RESERVED KEYWORD: 'tag' -- must stay listed in RESERVED_ASSIGNMENT_NAMES / RESERVED_KEYWORDS_IN_USE.
const TAGS_LOOP_OPEN_SOURCE = /\{\{\s*#tags\.foreach(?:\s+[^\s,{}]+)?/.source;
const TAGS_LOOP_CLOSE_SOURCE = /\{\{\s*\/tags\.foreach\s*\}\}/.source;
// `{{ #metafields.foreach [LABEL], i=0 }}` (session 10): steps through the CURRENT product/row's
// metafields -- product-level only (a variant's own metafields, if it has any, are a separate,
// deliberately NOT-built tier; see roadmap.md item 7). Same cosmetic-LABEL convention as every other
// foreach source: the LABEL is not bound to anything. The loop item is read via three FIXED tokens,
// `{{ mf.namespace }}`/`{{ mf.key }}`/`{{ mf.value }}` (see EvalContext.currentMetafield), the same
// "fixed token name, cosmetic label" shape `{{ tag }}` inside `tags.foreach` already established --
// this also resolves the notation question roadmap.md item 7 left open (explicit
// `product.metafields.foreach` vs. inferred `metafields.foreach`) by following that same precedent:
// inferred/bare, consistent with `tags.foreach`/`variants.foreach` already meaning "of the current
// product" with no explicit prefix.
const METAFIELDS_LOOP_OPEN_SOURCE = /\{\{\s*#metafields\.foreach(?:\s+[^\s,{}]+)?/.source;
const METAFIELDS_LOOP_CLOSE_SOURCE = /\{\{\s*\/metafields\.foreach\s*\}\}/.source;
// `{{ #length }}STRING{{/length}}` (session 10): block form of the character-count tool, replacing
// `{{ length=STRING }}` (now deprecated -- see renderTokenContent) for consistency with every other
// text tool (chop/repeat/index/insert/wrap), which are all `{{ #tag=... }} ... {{/tag}}` blocks, not
// a bare `tag=value` token. No `=` and no parameters at all -- `findBlockOpen`'s `params` capture
// (whatever sits between "#length" and the tag's own closing `}}`) is always just whitespace here,
// and is intentionally never read. `\b` (word boundary) after "length" prevents a hypothetical future
// tag whose name merely starts with "length" from being misread as this one.
// RESERVED KEYWORD: 'length' -- must stay listed in RESERVED_ASSIGNMENT_NAMES / RESERVED_KEYWORDS_IN_USE.
const LENGTH_OPEN_SOURCE = /\{\{\s*#length\b/.source;
const LENGTH_CLOSE_SOURCE = /\{\{\s*\/length\s*\}\}/.source;

function findInsertBlock(body: string, fromIndex: number): TaggedBlock | null {
  return findTaggedBlock(body, fromIndex, INSERT_OPEN_SOURCE, INSERT_CLOSE_SOURCE);
}

function findVariantLoopBlock(body: string, fromIndex: number): TaggedBlock | null {
  return findTaggedBlock(body, fromIndex, VARIANT_LOOP_OPEN_SOURCE, VARIANT_LOOP_CLOSE_SOURCE);
}

function findTagsLoopBlock(body: string, fromIndex: number): TaggedBlock | null {
  return findTaggedBlock(body, fromIndex, TAGS_LOOP_OPEN_SOURCE, TAGS_LOOP_CLOSE_SOURCE);
}

function findMetafieldsLoopBlock(body: string, fromIndex: number): TaggedBlock | null {
  return findTaggedBlock(
    body,
    fromIndex,
    METAFIELDS_LOOP_OPEN_SOURCE,
    METAFIELDS_LOOP_CLOSE_SOURCE,
  );
}

function findLengthBlock(body: string, fromIndex: number): TaggedBlock | null {
  return findTaggedBlock(body, fromIndex, LENGTH_OPEN_SOURCE, LENGTH_CLOSE_SOURCE);
}

// Parse the insert tag parameters: the character position N (first top-level comma segment) and the
// optional `drop` flag (TRUE discards out-of-range content instead of clamping).
function parseInsertParams(
  rawParams: string,
  product: ProductData,
  allProducts: ProductData[],
  ctx: EvalContext,
): { position: number | null; drop: boolean } {
  const segments = splitTopLevelCommas(rawParams);
  const position = resolveExprToNumber(segments[0] || '', product, allProducts, ctx);
  let drop = false;
  for (let k = 1; k < segments.length; k++) {
    const eqIndex = segments[k].indexOf('=');
    if (eqIndex === -1) continue;
    const key = segments[k].slice(0, eqIndex).trim().toLowerCase();
    const value = segments[k].slice(eqIndex + 1).trim();
    // RESERVED KEYWORD: 'drop' -- must stay listed in RESERVED_ASSIGNMENT_NAMES / RESERVED_KEYWORDS_IN_USE.
    if (key === 'drop') {
      drop = value.toUpperCase() === 'TRUE';
    }
  }
  return { position, drop };
}

// Splice `inner` into the surrounding rendered output. For a position >= 0 the split point is N
// characters INTO the text that follows the block; for a negative position it is |N| characters back
// from the end of the text that precedes the block. An out-of-range position is dropped when
// `drop` is true and clamped to the end / start otherwise. A missing or non-integer position drops
// the inner content.
function applyInsert(
  before: string,
  after: string,
  inner: string,
  position: number | null,
  drop: boolean,
): string {
  if (position == null || !Number.isInteger(position)) {
    return before + after;
  }
  const afterChars = Array.from(after);
  if (position >= 0) {
    if (position > afterChars.length) {
      return drop ? before + after : before + after + inner;
    }
    return (
      before + afterChars.slice(0, position).join('') + inner + afterChars.slice(position).join('')
    );
  }
  const beforeChars = Array.from(before);
  const splitAt = beforeChars.length + position;
  if (splitAt < 0) {
    return drop ? before + after : inner + before + after;
  }
  return (
    beforeChars.slice(0, splitAt).join('') + inner + beforeChars.slice(splitAt).join('') + after
  );
}

// Parse the variant foreach parameters: `l=<START>` (counter start, default 0). `tied=TRUE|FALSE` is
// RETIRED as of session 7, per explicit direction -- it is still DETECTED (`deprecatedTied`) so a
// template that wrote it can be told it no longer does anything, but no longer read for behavior: a
// variant loop now ALWAYS iterates the current row's in-scope variant set (see applyVariantLoop),
// matching what "untied" used to mean. The tied/untied split existed to let a variant loop show every
// variant inline (tied) while ALSO letting file-splitting infer "one file per variant" from an
// untied loop, before fileBreak was an explicit, stored setting (session 4) -- with fileBreak now
// always explicit, the split no longer serves a purpose, and standardizing on "always respect the
// current variant scope" is a straightforward, low-risk change: the two behaviors only ever diverged
// for a product whose variants were manually narrowed via the variant-selection checklist (also
// session 4) -- for any product with every variant still selected (the default, and the only
// possible state before session 4 existed), `product.variants` already equals `product.allVariants`
// in content, so this generalization does not change rendered output for the overwhelming majority
// of already-saved templates.
function parseVariantLoopParams(
  rawParams: string,
  product: ProductData,
  allProducts: ProductData[],
  ctx: EvalContext,
): { start: number; name: string; deprecatedTied: boolean } {
  const segments = splitTopLevelCommas(rawParams);
  let start = 0;
  let name = 'l';
  let deprecatedTied = false;
  for (const segment of segments) {
    const eqIndex = segment.indexOf('=');
    if (eqIndex === -1) continue;
    const key = segment.slice(0, eqIndex).trim();
    const value = segment.slice(eqIndex + 1).trim();
    // RESERVED KEYWORD: 'tied' -- must stay listed in RESERVED_ASSIGNMENT_NAMES / RESERVED_KEYWORDS_IN_USE.
    // Retired (session 7): detected only so it can be flagged as deprecated, no longer read for
    // behavior -- see this function's own comment above.
    if (key.toLowerCase() === 'tied') {
      deprecatedTied = true;
    } else if (isVariableName(key)) {
      // Any variable may be the variant counter; `l` is only the default name.
      name = key;
      const resolved = resolveExprToNumber(value, product, allProducts, ctx);
      start = resolved == null ? 0 : Math.round(resolved);
    }
  }
  return { start, name, deprecatedTied };
}

// Render a variant foreach block: always iterates the current row's in-scope variant set
// (`product.variants`, falling back to the product's full variant list only if that's somehow
// empty -- the same fallback convention `productUnits` already uses elsewhere in this file). Each
// iteration renders the inner content against a product clone whose active variant is the iterated
// one, with `{{ l }}` (or whichever name was chosen) bound to the counter.
function applyVariantLoop(
  inner: string,
  params: { start: number; name: string; deprecatedTied: boolean },
  product: ProductData,
  allProducts: ProductData[],
  ctx: EvalContext,
): string {
  const iterated =
    product.variants && product.variants.length > 0 ? product.variants : product.allVariants;
  const deprecationPrefix = params.deprecatedTied
    ? deprecatedSyntaxMarker(
        'the tied parameter no longer does anything -- a variant loop always follows the current ' +
          'variant selection now; remove it',
      )
    : '';
  if (!iterated || iterated.length === 0) {
    ctx.vars[params.name] = String(params.start);
    return deprecationPrefix + renderTokens(inner, product, allProducts, ctx);
  }
  // A plain imperative loop (not .map().join()) so a `{{ break }}` in the inner content can stop
  // iterating early -- see BREAK_SENTINEL's comment. `{{ skip }}` discards just the current
  // iteration's rendered text and continues.
  let output = deprecationPrefix;
  for (let index = 0; index < iterated.length; index++) {
    // First iteration takes the declared start value; every later iteration performs
    // `name = name + 1` against the CURRENT stored value, so counts carry across nested loops.
    const value = index === 0 ? params.start : readVarNumber(ctx.vars, params.name) + 1;
    ctx.vars[params.name] = String(value);
    const rendered = renderTokens(
      inner,
      { ...product, variants: [iterated[index]] },
      allProducts,
      ctx,
    );
    const signal = loopControlSignal(rendered);
    if (!signal.discard) output += rendered;
    if (signal.stop) break;
  }
  return output;
}

// Parse the metafields-loop tag parameters: just an optional counter (`i=START`), same shape as the
// tags loop -- see parseTagsLoopParams' comment (identical reasoning, one word substituted).
function parseMetafieldsLoopParams(
  rawParams: string,
  product: ProductData,
  allProducts: ProductData[],
  ctx: EvalContext,
): { start: number; name: string } {
  const segments = splitTopLevelCommas(rawParams);
  let start = 0;
  let name = 'i';
  for (const segment of segments) {
    const eqIndex = segment.indexOf('=');
    if (eqIndex === -1) continue;
    const key = segment.slice(0, eqIndex).trim();
    const value = segment.slice(eqIndex + 1).trim();
    if (isVariableName(key)) {
      name = key;
      const resolved = resolveExprToNumber(value, product, allProducts, ctx);
      start = resolved == null ? 0 : Math.round(resolved);
    }
  }
  return { start, name };
}

// Render a metafields-loop block: steps through the CURRENT product/row's metafields
// (product.metafields), binding each one into `ctx.currentMetafield` (read via the fixed
// `{{ mf.namespace }}`/`{{ mf.key }}`/`{{ mf.value }}` tokens -- see EvalContext.currentMetafield's
// comment) for the duration of that one iteration, plus an optional counter (`{{ i }}` by default).
// A product with no metafields renders the inner content zero times. Supports `{{ break }}`/
// `{{ skip }}` like every other loop -- see BREAK_SENTINEL's comment. Saves/restores
// `ctx.currentMetafield` around its own iterations (same reasoning as expandForeachBlocks' save/
// restore of currKind/prev/next): a NESTED metafields loop, or a plain `{{ mf.* }}` token written
// after this block in the same body, must not see a stale value left over from this loop's last
// iteration.
function applyMetafieldsLoop(
  inner: string,
  params: { start: number; name: string },
  product: ProductData,
  allProducts: ProductData[],
  ctx: EvalContext,
): string {
  const metafields = product.metafields || [];
  const savedMetafield = ctx.currentMetafield;
  let output = '';
  for (let index = 0; index < metafields.length; index++) {
    const counterValue = index === 0 ? params.start : readVarNumber(ctx.vars, params.name) + 1;
    ctx.vars[params.name] = String(counterValue);
    ctx.currentMetafield = metafields[index];
    const rendered = renderTokens(inner, product, allProducts, ctx);
    const signal = loopControlSignal(rendered);
    if (!signal.discard) output += rendered;
    if (signal.stop) break;
  }
  ctx.currentMetafield = savedMetafield;
  return output;
}

// Parse the tags-loop tag parameters: just an optional counter (`i=START`), same shape as the
// variant loop minus `tied` (tags have no analogous concept). The LABEL slot the open tag itself
// may carry (see TAGS_LOOP_OPEN_SOURCE) is not parsed here at all -- it is consumed by the open
// regex and is purely cosmetic, exactly like every other foreach source's trailing word.
function parseTagsLoopParams(
  rawParams: string,
  product: ProductData,
  allProducts: ProductData[],
  ctx: EvalContext,
): { start: number; name: string } {
  const segments = splitTopLevelCommas(rawParams);
  let start = 0;
  let name = 'i';
  for (const segment of segments) {
    const eqIndex = segment.indexOf('=');
    if (eqIndex === -1) continue;
    const key = segment.slice(0, eqIndex).trim();
    const value = segment.slice(eqIndex + 1).trim();
    if (isVariableName(key)) {
      name = key;
      const resolved = resolveExprToNumber(value, product, allProducts, ctx);
      start = resolved == null ? 0 : Math.round(resolved);
    }
  }
  return { start, name };
}

// Render a tags-loop block: steps through the CURRENT product/row's tags (product.tags), binding
// each tag's text into the fixed `{{ tag }}` token (via ctx.vars, the SAME mechanism a numeric
// counter already uses -- resolveOnProduct's vars-store lookup doesn't care whether the stored value
// looks like a number or arbitrary text) for the duration of that one iteration, plus an optional
// counter (`{{ i }}` by default) exactly like every other foreach source. A product with no tags
// renders the inner content zero times (there is nothing to bind `{{ tag }}` to). Supports
// `{{ break }}`/`{{ skip }}` like every other loop -- see BREAK_SENTINEL's comment.
function applyTagsLoop(
  inner: string,
  params: { start: number; name: string },
  product: ProductData,
  allProducts: ProductData[],
  ctx: EvalContext,
): string {
  const tags = product.tags || [];
  let output = '';
  for (let index = 0; index < tags.length; index++) {
    const counterValue = index === 0 ? params.start : readVarNumber(ctx.vars, params.name) + 1;
    ctx.vars[params.name] = String(counterValue);
    ctx.vars.tag = tags[index];
    const rendered = renderTokens(inner, product, allProducts, ctx);
    const signal = loopControlSignal(rendered);
    if (!signal.discard) output += rendered;
    if (signal.stop) break;
  }
  return output;
}

// Return the single character at 0-based position `index` of the rendered inner content. A negative
// index counts back from the end (-1 is the last character). A non-integer or out-of-range index
// renders the empty string.
function applyIndex(innerRendered: string, index: number | null): string {
  if (index == null || !Number.isInteger(index)) {
    return '';
  }
  const chars = Array.from(innerRendered);
  const position = index < 0 ? chars.length + index : index;
  if (position < 0 || position >= chars.length) {
    return '';
  }
  return chars[position];
}

// Parse the repeat tag parameters: the count (everything before `delineator=`, trailing comma
// stripped) and the delineator (everything after the FIRST `delineator=` up to the closing `}}`, so
// it may contain commas). The delineator is trimmed of typed whitespace; whitespace produced by the
// {{ /space }} / {{ /return }} / {{ \t }} / {{ \n }} tokens survives as sentinels.
function parseRepeatParams(
  rawParams: string,
  product: ProductData,
  allProducts: ProductData[],
  ctx: EvalContext,
): { count: number | null; delineator: string } {
  const raw = String(rawParams);
  // RESERVED KEYWORD: 'delineator' -- must stay listed in RESERVED_ASSIGNMENT_NAMES / RESERVED_KEYWORDS_IN_USE.
  const delineatorMatch = raw.match(/delineator\s*=/);
  let countPart = raw;
  let delineator = '';
  if (delineatorMatch && delineatorMatch.index != null) {
    countPart = raw.slice(0, delineatorMatch.index);
    delineator = raw.slice(delineatorMatch.index + delineatorMatch[0].length).trim();
  }
  const countExpr = countPart.replace(/,\s*$/, '').trim();
  const count = resolveExprToNumber(countExpr, product, allProducts, ctx);
  return { count, delineator };
}

// Output the rendered inner content `count` times joined by the delineator. A count that is missing,
// non-integer, or less than 1 renders nothing; a count of exactly 1 returns the content unchanged.
function applyRepeat(innerRendered: string, count: number | null, delineator: string): string {
  if (count == null || !Number.isInteger(count) || count < 1) {
    return '';
  }
  if (count === 1) {
    return innerRendered;
  }
  const copies: string[] = [];
  for (let n = 0; n < count; n++) {
    copies.push(innerRendered);
  }
  return copies.join(delineator);
}

// Parse the replace tag parameters: the SEARCH text (everything before the first `replacement=`,
// trailing comma stripped) and the REPLACEMENT text (everything after that `replacement=` up to the
// tag's closing `}}`, so it may itself contain commas) -- the same split shape parseRepeatParams
// already uses for its `delineator=` value. Both sides may contain nested `{{ }}` tokens, which are
// resolved here before the replacement runs, and both are trimmed of TYPED whitespace only:
// whitespace produced by the {{ /space }} / {{ /return }} tokens is carried as sentinels (which are
// not whitespace) and therefore survives the trim at any position, so token whitespace can be both
// searched for and inserted.
function parseReplaceParams(
  rawParams: string,
  product: ProductData,
  allProducts: ProductData[],
  ctx: EvalContext,
): { search: string; replacement: string } {
  const raw = String(rawParams);
  const replacementMatch = raw.match(/replacement\s*=/);
  let searchPart = raw;
  let replacementPart = '';
  if (replacementMatch && replacementMatch.index != null) {
    searchPart = raw.slice(0, replacementMatch.index);
    replacementPart = raw.slice(replacementMatch.index + replacementMatch[0].length);
  }
  const search = renderTemplateText(
    searchPart.replace(/,\s*$/, ''),
    product,
    allProducts,
    ctx,
    false,
  ).trim();
  const replacement = renderTemplateText(replacementPart, product, allProducts, ctx, false).trim();
  return { search, replacement };
}

// Replace EVERY occurrence of `search` in the (already rendered) text with `replacement`. Plain,
// case-sensitive, non-overlapping substring replacement scanning left to right -- the same rule
// .NET's String.Replace uses, which is what split/join gives for free: once a match is consumed the
// scan resumes AFTER it, so a second match that overlapped the first is not itself replaced. An
// empty search matches nothing (returning the text unchanged) rather than splitting between every
// character; an empty replacement simply deletes each occurrence.
function applyReplace(text: string, search: string, replacement: string): string {
  if (search === '') {
    return text;
  }
  return text.split(search).join(replacement);
}

// Parsed while-tag parameters. Only ONE form is now run: 'unbounded' (`{{ #while=BOOL }}`) -- just a
// condition, no bound counter. Iterates up to MAX_WHILE_ITERATIONS times, re-testing the condition
// before every step; a counter, if wanted, is the author's own ordinary variable, declared/
// incremented in the body like any other assignment -- the while tag itself does not bind or step
// one. The OLD bounded form (`{{ while=BOOL, {{ k }} = MIN<MAX }}`, with a tag-bound counter) is
// RETIRED as of session 7 -- see WHILE_OPEN_SOURCE's comment. It is still DETECTED (a top-level comma
// in the params is the tell) so a template that used it can be told exactly what to change, via
// 'deprecated', rather than either running the old semantics forever or falling through to the
// generic pass-through and rendering completely raw tags (the same silent-failure shape the session-6
// regex bug had).
type WhileParams = { form: 'unbounded'; condition: string } | { form: 'deprecated' };

// Parse the while tag parameters. A rawParams string with no top-level comma is the (only supported)
// unbounded form -- the whole thing is the condition. One WITH a top-level comma is the old
// bounded form's shape (`BOOLEAN, {{ k }} = MIN<MAX`); it is recognized ONLY so it can be flagged as
// deprecated, not parsed further or run.
function parseWhileParams(rawParams: string): WhileParams {
  const segments = splitTopLevelCommas(rawParams);
  if (segments.length < 2) {
    return { form: 'unbounded', condition: unwrapChopCondition(segments[0] || '') };
  }
  return { form: 'deprecated' };
}

// Run a while loop (unbounded form only -- see WhileParams' comment). Runs up to
// MAX_WHILE_ITERATIONS steps (the hard safety backstop), re-testing the condition before every step,
// binding no counter at all. The condition is re-evaluated before each step (an empty condition is
// treated as TRUE); a FALSE condition means that step does not run and the loop ends. Each iteration
// renders the inner content through the full pipeline. The loop never steps through the product
// selection, so the same product/context is used every iteration.
function applyWhileLoop(
  inner: string,
  params: { form: 'unbounded'; condition: string },
  product: ProductData,
  allProducts: ProductData[],
  ctx: EvalContext,
): string {
  let output = '';
  for (let step = 0; step < MAX_WHILE_ITERATIONS; step++) {
    if (
      params.condition.trim() !== '' &&
      !conditionIsTrue(params.condition, product, allProducts, ctx)
    ) {
      break;
    }
    const rendered = renderTokens(inner, product, allProducts, ctx);
    const signal = loopControlSignal(rendered);
    if (!signal.discard) output += rendered;
    if (signal.stop) break;
  }
  return output;
}

// Locate the next chop / repeat / replace / index / insert / variants / tags / metafields / length /
// while block at or after `fromIndex`, whichever starts earliest.
type RenderBlockKind =
  | 'chop'
  | 'repeat'
  | 'replace'
  | 'index'
  | 'insert'
  | 'variants'
  | 'tags'
  | 'metafields'
  | 'length'
  | 'while';

interface RenderBlock extends TaggedBlock {
  kind: RenderBlockKind;
}

function findNextRenderBlock(body: string, fromIndex: number): RenderBlock | null {
  const candidates: RenderBlock[] = [];
  const chop = findChopBlock(body, fromIndex);
  if (chop)
    candidates.push({
      ...chop,
      kind: 'chop',
      innerStart: chop.blockStart,
      innerEnd: chop.blockEnd,
    });
  const repeat = findRepeatBlock(body, fromIndex);
  if (repeat) candidates.push({ ...repeat, kind: 'repeat' });
  const replaceBlock = findReplaceBlock(body, fromIndex);
  if (replaceBlock) candidates.push({ ...replaceBlock, kind: 'replace' });
  const indexBlock = findIndexBlock(body, fromIndex);
  if (indexBlock) candidates.push({ ...indexBlock, kind: 'index' });
  const insertBlock = findInsertBlock(body, fromIndex);
  if (insertBlock) candidates.push({ ...insertBlock, kind: 'insert' });
  const variantLoop = findVariantLoopBlock(body, fromIndex);
  if (variantLoop) candidates.push({ ...variantLoop, kind: 'variants' });
  const tagsLoop = findTagsLoopBlock(body, fromIndex);
  if (tagsLoop) candidates.push({ ...tagsLoop, kind: 'tags' });
  const metafieldsLoop = findMetafieldsLoopBlock(body, fromIndex);
  if (metafieldsLoop) candidates.push({ ...metafieldsLoop, kind: 'metafields' });
  const lengthBlock = findLengthBlock(body, fromIndex);
  if (lengthBlock) candidates.push({ ...lengthBlock, kind: 'length' });
  const loop = findWhileBlock(body, fromIndex);
  if (loop) candidates.push({ ...loop, kind: 'while' });
  if (candidates.length === 0) return null;
  return candidates.reduce((earliest, candidate) =>
    candidate.blockStart < earliest.blockStart ? candidate : earliest,
  );
}

// Index just past the `{{ ... }}` token that ENCLOSES `innerIndex`, or -1 when `innerIndex` is not
// inside any token. `scanFrom` must itself sit at token depth 0 (every caller passes the render
// loop's current cursor, which always does). Session 13: this is what lets a BLOCK written inside
// another token -- most usefully an assignment value, e.g.
// `{{ x = {{ #replace=&, replacement=&amp; }}{{ product.title }}{{ /replace }} }}` -- be recognized
// as part of that token instead of being torn out of it. Before this, the block scanners matched a
// block tag anywhere in the raw text, so the surrounding token was split into "literal text before
// the block" + "the block" + "literal text after it": the assignment never happened and the raw
// `{{ x =` / `}}` fragments were printed into the output.
function enclosingTokenEnd(text: string, scanFrom: number, innerIndex: number): number {
  let i = scanFrom;
  while (i < innerIndex) {
    if (text[i] === '{' && text[i + 1] === '{') {
      const end = findMatchingClose(text, i);
      // An unbalanced `{{` has no token bounds to be inside of; treat what follows as top level.
      if (end === -1) return -1;
      if (innerIndex < end) return end;
      i = end;
      continue;
    }
    i += 1;
  }
  return -1;
}

// The next render block that is genuinely at the TOP level of `text` (not nested inside a
// `{{ ... }}` token -- see enclosingTokenEnd). A candidate found inside a token is skipped by
// resuming the search just past that whole token, which leaves the token intact for the plain-token
// pass to render through renderTokenContent.
function findNextTopLevelRenderBlock(text: string, fromIndex: number): RenderBlock | null {
  let from = fromIndex;
  while (from < text.length) {
    const candidate = findNextRenderBlock(text, from);
    if (!candidate) return null;
    const enclosing = enclosingTokenEnd(text, from, candidate.blockStart);
    if (enclosing === -1) return candidate;
    from = enclosing;
  }
  return null;
}

// Whether `text` contains a complete block of any kind (if / chop / repeat / replace / index /
// insert / variants / tags / metafields / length / while).
function containsRenderBlock(text: string): boolean {
  return findNextRenderBlock(text, 0) !== null || findIfBlock(text, 0) !== null;
}

// Resolve the text held INSIDE one token (an assignment's value, a math equation's body, a boolean
// expression, a `time=` format, an if/chop condition). When that text contains a complete block, it
// is first run through the full block pipeline (renderTokens) so the block actually executes, and
// the resulting text is then resolved as ordinary tokens. Text with no block behaves exactly as it
// always did -- a single renderTemplateText pass -- so numeric contexts (where an empty value must
// coerce to `0`) are unaffected for every template written before this existed.
function renderNested(
  text: string,
  product: ProductData,
  allProducts: ProductData[],
  ctx: EvalContext,
  numeric: boolean,
): string {
  const expanded = containsRenderBlock(text) ? renderTokens(text, product, allProducts, ctx) : text;
  return renderTemplateText(expanded, product, allProducts, ctx, numeric);
}

// --- Boolean expression evaluator (for {{ #if=EXPR }} conditions) ----------------------------
// Evaluates a boolean expression string that has already had its nested {{ ... }} tokens resolved to
// their string values. Supports || && ! , comparison operators (< > <= >= == !=), and parentheses.
// Each side of a comparison is a full arithmetic expression (evaluated via evaluateMathExpression) or
// a resolved literal string. For == / != , when BOTH sides are non-numeric strings they are compared
// as case-sensitive strings; otherwise they are compared numerically. Throws on malformed input so
// callers can catch and treat the condition as false.

// Split `expr` on a top-level (paren-depth 0) two-character operator (e.g. '||' or '&&'), returning
// the list of segments. Comparison/other operators inside segments are left intact.
function splitTopLevel(expr: string, op: string): string[] {
  const segments: string[] = [];
  let depth = 0;
  let last = 0;
  let i = 0;
  while (i < expr.length) {
    const ch = expr[i];
    if (ch === '(') {
      depth += 1;
      i += 1;
      continue;
    }
    if (ch === ')') {
      if (depth > 0) depth -= 1;
      i += 1;
      continue;
    }
    if (depth === 0 && expr.slice(i, i + op.length) === op) {
      segments.push(expr.slice(last, i));
      i += op.length;
      last = i;
      continue;
    }
    i += 1;
  }
  segments.push(expr.slice(last));
  return segments;
}

// Whether `expr` (trimmed) is entirely wrapped in one matching pair of parentheses.
function isFullyParenthesized(expr: string): boolean {
  const trimmed = expr.trim();
  if (trimmed[0] !== '(' || trimmed[trimmed.length - 1] !== ')') return false;
  let depth = 0;
  for (let i = 0; i < trimmed.length; i++) {
    if (trimmed[i] === '(') depth += 1;
    else if (trimmed[i] === ')') {
      depth -= 1;
      // If we return to depth 0 before the last char, the outer parens are not a single wrap.
      if (depth === 0 && i < trimmed.length - 1) return false;
    }
  }
  return depth === 0;
}

// Find a top-level (paren-depth 0) comparison operator in `expr`. Returns the operator and the left/
// right operand strings, or null when there is no top-level comparison. Two-character operators
// (<=, >=, ==, !=) are checked before single-character (<, >).
function findComparison(expr: string): { op: string; left: string; right: string } | null {
  let depth = 0;
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];
    if (ch === '(') {
      depth += 1;
      continue;
    }
    if (ch === ')') {
      if (depth > 0) depth -= 1;
      continue;
    }
    if (depth !== 0) continue;
    const two = expr.slice(i, i + 2);
    if (two === '<=' || two === '>=' || two === '==' || two === '!=') {
      return { op: two, left: expr.slice(0, i), right: expr.slice(i + 2) };
    }
    if (ch === '<' || ch === '>') {
      return { op: ch, left: expr.slice(0, i), right: expr.slice(i + 1) };
    }
  }
  return null;
}

// Evaluate a single comparison operand: returns { num } when it parses as arithmetic, plus the raw
// trimmed string for string comparison fallback.
function evalOperand(operand: string): { num: number | null; str: string } {
  const str = operand.trim();
  try {
    const num = evaluateMathExpression(str);
    return { num: Number.isFinite(num) ? num : null, str };
  } catch {
    return { num: null, str };
  }
}

// Evaluate a boolean expression string (tokens already resolved to strings). Throws on malformed input.
function evaluateBooleanExpression(expr: string): boolean {
  const trimmed = expr.trim();
  if (trimmed === '') {
    throw new Error('Empty boolean expression');
  }

  // Logical OR (lowest precedence).
  const orParts = splitTopLevel(trimmed, '||');
  if (orParts.length > 1) {
    return orParts.some((part) => evaluateBooleanExpression(part));
  }

  // Logical AND.
  const andParts = splitTopLevel(trimmed, '&&');
  if (andParts.length > 1) {
    return andParts.every((part) => evaluateBooleanExpression(part));
  }

  // Unary NOT.
  if (trimmed[0] === '!' && trimmed.slice(0, 2) !== '!=') {
    return !evaluateBooleanExpression(trimmed.slice(1));
  }

  // Parenthesized boolean group.
  if (isFullyParenthesized(trimmed)) {
    return evaluateBooleanExpression(trimmed.slice(1, -1));
  }

  // Comparison.
  const comparison = findComparison(trimmed);
  if (comparison) {
    const left = evalOperand(comparison.left);
    const right = evalOperand(comparison.right);
    const bothNumeric = left.num != null && right.num != null;
    switch (comparison.op) {
      case '==':
        return bothNumeric ? left.num === right.num : left.str === right.str;
      case '!=':
        return bothNumeric ? left.num !== right.num : left.str !== right.str;
      case '<':
        return bothNumeric ? (left.num as number) < (right.num as number) : false;
      case '>':
        return bothNumeric ? (left.num as number) > (right.num as number) : false;
      case '<=':
        return bothNumeric ? (left.num as number) <= (right.num as number) : false;
      case '>=':
        return bothNumeric ? (left.num as number) >= (right.num as number) : false;
      default:
        return false;
    }
  }

  // No comparator: treat the operand as truthy. Numeric -> nonzero; string -> nonempty and not
  // "false"/"0" (case-insensitive).
  const operand = evalOperand(trimmed);
  if (operand.num != null) {
    return operand.num !== 0;
  }
  const lower = operand.str.toLowerCase();
  return operand.str !== '' && lower !== 'false' && lower !== '0';
}

// ----------------------------------------------------------------------------------------------
// TEMPLATE ENGINE -- if/else blocks ({{ #if=EXPR }} ... {{ #else }} ... {{ /if }})
// ----------------------------------------------------------------------------------------------
// Locate the first {{ #if=EXPR }} ... [ {{ #else }} ... ] {{ /if }} block, tracking #if/#else/#if
// nesting so nested if blocks are matched correctly. Uses brace-depth-aware matching for the opening
// tag so the condition may contain nested {{ }} tokens. Returns the condition string, the then/else
// inner content, and the block bounds. Returns null when no complete if block is found.
interface IfMatch {
  condition: string;
  thenInner: string;
  elseInner: string | null;
  blockStart: number;
  blockEnd: number;
}

// Regex source for an if-block's opening tag, shared with findBlockOpen (the same "find open tag,
// find its matching close, slice out the params" first step that findTaggedBlock's callers use --
// if-blocks can't fully delegate to findTaggedBlock itself, since they also need to track an
// optional top-level {{ #else }} marker, which the generic close-scan doesn't support).
// RESERVED KEYWORD: 'if', 'else' -- must stay listed in RESERVED_ASSIGNMENT_NAMES / RESERVED_KEYWORDS_IN_USE.
//
// THIS MUST BE `.source` OF A REAL REGEX LITERAL, NOT A PLAIN STRING LITERAL -- found and fixed
// session 6, after it caused every `{{ #if=... }}` with a space after `{{` (the app's own inserted
// If-block snippet included) to silently fail to be recognized as a block at all. A plain string
// literal such as '\{\{\s*#if=' does NOT mean what it looks like: JavaScript string literals drop
// the backslash before any character that isn't one of a fixed set of recognized escapes (\n \t \\
// \' \" ... ), so `\{` becomes plain `{` and, critically, `\s` becomes plain `s` -- the string
// actually held by that constant is `{{s*#if=`, whose meaning AS A REGEX is "literal `{{`, then zero
// or more literal lowercase `s` characters, then literal `#if=`". That matches `{{#if=` (zero `s`s)
// by coincidence, but NOT `{{ #if=` (a space is not an `s`), so any if-block written with the
// conventional space -- exactly what `IF_BLOCK` below inserts -- silently vanished from the parser's
// view entirely: `findBlockOpen`'s `new RegExp(IF_OPEN_SOURCE, 'g')` never matched, `findIfBlock`
// returned null, and the ENTIRE `{{ #if=... }} ... {{ /if }}` span (condition, `{{ #else }}`,
// closing tag, all of it) fell through unprocessed to the generic per-token scanner, which -- via
// the separate, correctly brace-depth-aware `findMatchingClose` -- still delimited it as one valid
// token and echoed it back completely verbatim (see renderTokenContent's `#`/`/` pass-through). This
// was verified directly against a real JS engine (not just reasoned about), including a byte-for-
// byte reproduction of the exact broken output a merchant reported.
// `/PATTERN/.source` sidesteps the whole class of bug: a regex LITERAL's contents are parsed by the
// regex grammar, not the string-escape grammar, so `\{` and `\s` inside `/.../ ` keep their intended
// meaning, and `.source` hands back that exact pattern text as a string, safe to feed into
// `new RegExp(...)` or to concatenate with other such sources (as findTaggedBlock does). Every other
// tag-open/close source constant in this file (CHOP_*, REPEAT_*, WHILE_*, INDEX_*, INSERT_*,
// VARIANT_LOOP_*) had exactly this same bug and was fixed the same way in the same pass.
const IF_OPEN_SOURCE = /\{\{\s*#if=/.source;

function findIfBlock(body: string, fromIndex: number): IfMatch | null {
  const open = findBlockOpen(body, fromIndex, IF_OPEN_SOURCE);
  if (!open) return null;
  // Condition = text after `#if=` up to the closing `}}` (exclusive), trimming trailing space.
  const { blockStart, openTagEnd, params: condition } = open;

  // Walk forward from the end of the opening tag, tracking nested #if depth, to find this block's
  // matching {{ /if }} and its top-level {{ #else }} (if any).
  const scanRegex = /\{\{\s*#if=|\{\{\s*#else\s*\}\}|\{\{\s*\/if\s*\}\}/g;
  scanRegex.lastIndex = openTagEnd;
  let depth = 0;
  let elseIndex = -1;
  let elseTagLength = 0;
  let m: RegExpExecArray | null;
  while ((m = scanRegex.exec(body)) !== null) {
    const token = m[0];
    if (/^\{\{\s*#if=/.test(token)) {
      depth += 1;
      continue;
    }
    if (/^\{\{\s*#else\s*\}\}/.test(token)) {
      if (depth === 0 && elseIndex === -1) {
        elseIndex = m.index;
        elseTagLength = token.length;
      }
      continue;
    }
    // Closing {{ /if }}.
    if (depth === 0) {
      const blockEnd = m.index + token.length;
      if (elseIndex !== -1) {
        return {
          condition,
          thenInner: body.slice(openTagEnd, elseIndex),
          elseInner: body.slice(elseIndex + elseTagLength, m.index),
          blockStart,
          blockEnd,
        };
      }
      return {
        condition,
        thenInner: body.slice(openTagEnd, m.index),
        elseInner: null,
        blockStart,
        blockEnd,
      };
    }
    depth -= 1;
  }
  return null;
}

// Resolve every {{ #if=EXPR }} ... {{ /if }} (with optional {{ #else }}) block in the text: the
// condition's nested {{ ... }} tokens are resolved to their string values, the boolean expression is
// evaluated, and the appropriate branch's inner content is kept (the other branch and all tags are
// removed). A malformed/failing condition is treated as FALSE. Branch content is left for later
// passes (math/plain-token substitution) to process. Processes nested blocks left-to-right by
// re-scanning from just after each chosen branch's inserted content.
function applyIfBlocks(
  text: string,
  product: ProductData,
  allProducts: ProductData[],
  ctx: EvalContext,
): string {
  const list = allProducts.length > 0 ? allProducts : [product];
  let result = '';
  let cursor = 0;
  while (cursor < text.length) {
    const match = findIfBlock(text, cursor);
    if (!match) {
      result += text.slice(cursor);
      break;
    }
    const enclosing = enclosingTokenEnd(text, cursor, match.blockStart);
    if (enclosing !== -1) {
      // This if-block sits INSIDE a {{ ... }} token (for example an assignment value). Copy the
      // whole token through untouched: renderTokenContent renders that token's own content through
      // the full pipeline (see renderNested), which is what runs the nested block.
      result += text.slice(cursor, enclosing);
      cursor = enclosing;
      continue;
    }
    result += text.slice(cursor, match.blockStart);
    // Resolve nested tokens in the condition before evaluating. First collapse any {{ =... }} math
    // equations to their numeric results (so equations work inside conditions), then resolve any
    // remaining plain {{ ... }} tokens to their raw string values.
    const resolvedCondition = renderNested(match.condition, product, list, ctx, false);
    // A resolved condition that still carries an unresolvedVariableMarker means part of the
    // condition never actually evaluated (a forgotten-braces variable reference inside a nested
    // equation -- see renderTokenContent's math branch). Rendering that marker directly, instead of
    // proceeding to a boolean comparison that would silently succeed against the marker text as a
    // plain string, makes the failure visible right where the if-block's output would have gone.
    if (containsUnresolvedVariableMarker(resolvedCondition)) {
      result += resolvedCondition;
      cursor = match.blockEnd;
      continue;
    }
    let branch = '';
    try {
      branch = evaluateBooleanExpression(resolvedCondition)
        ? match.thenInner
        : (match.elseInner ?? '');
    } catch {
      branch = match.elseInner ?? '';
    }
    // Recursively process the chosen branch so nested if blocks inside it are handled too.
    result += applyIfBlocks(branch, product, list, ctx);
    cursor = match.blockEnd;
  }
  return result;
}

// ----------------------------------------------------------------------------------------------
// TEMPLATE ENGINE -- render pipeline
// renderTokens is the entry point every block applier (chop/repeat/index/insert/variants/while)
// recurses back into for its own inner content, which is what makes nested blocks work.
// ----------------------------------------------------------------------------------------------
// Render the non-block portion of a template. Every token kind (math equation, length token,
// variable assignment, boolean expression, plain field token) is handled by the single ordered
// scanner, so assignments and reads always happen in document order.
function renderPlainTokens(
  text: string,
  product: ProductData,
  allProducts: ProductData[],
  ctx: EvalContext,
): string {
  return renderTemplateText(text, product, allProducts, ctx, false);
}

// Run the full per-product/iteration substitution pipeline for a single product with a given
// evaluation context: if blocks first, then chop blocks (whose inner content is rendered recursively
// through this same pipeline before being chopped), then length tokens, math equations, and plain
// tokens for everything outside a chop block. (Foreach expansion happens before this in
// expandForeachBlocks.)
function renderTokens(
  text: string,
  product: ProductData,
  allProducts: ProductData[],
  ctx: EvalContext,
): string {
  const withIf = applyIfBlocks(text, product, allProducts, ctx);
  const list = allProducts.length > 0 ? allProducts : [product];
  let result = '';
  let cursor = 0;
  while (cursor < withIf.length) {
    const match = findNextTopLevelRenderBlock(withIf, cursor);
    if (!match) {
      result += renderPlainTokens(withIf.slice(cursor), product, allProducts, ctx);
      break;
    }
    result += renderPlainTokens(withIf.slice(cursor, match.blockStart), product, allProducts, ctx);
    if (match.kind === 'chop') {
      const { condition, direction, counterName, jStart } = parseChopParams(
        match.params,
        product,
        list,
        ctx,
      );
      const innerRendered = renderTokens(match.inner, product, allProducts, ctx);
      result += applyChop(
        innerRendered,
        condition,
        direction,
        counterName,
        jStart,
        product,
        list,
        ctx,
      );
    } else if (match.kind === 'repeat') {
      const { count, delineator } = parseRepeatParams(match.params, product, list, ctx);
      const innerRendered = renderTokens(match.inner, product, allProducts, ctx);
      result += applyRepeat(innerRendered, count, delineator);
    } else if (match.kind === 'replace') {
      const { search, replacement } = parseReplaceParams(match.params, product, list, ctx);
      const innerRendered = renderTokens(match.inner, product, allProducts, ctx);
      result += applyReplace(innerRendered, search, replacement);
    } else if (match.kind === 'index') {
      const position = resolveExprToNumber(match.params, product, list, ctx);
      const innerRendered = renderTokens(match.inner, product, allProducts, ctx);
      result += applyIndex(innerRendered, position);
    } else if (match.kind === 'insert') {
      // `result` is everything rendered before this block; render the remainder and the inner
      // content, then splice the content into the combined output at the requested position.
      const insertParams = parseInsertParams(match.params, product, list, ctx);
      const innerRendered = renderTokens(match.inner, product, allProducts, ctx);
      const afterRendered = renderTokens(withIf.slice(match.blockEnd), product, allProducts, ctx);
      return applyInsert(
        result,
        afterRendered,
        innerRendered,
        insertParams.position,
        insertParams.drop,
      );
    } else if (match.kind === 'variants') {
      const variantParams = parseVariantLoopParams(match.params, product, list, ctx);
      result += applyVariantLoop(match.inner, variantParams, product, allProducts, ctx);
    } else if (match.kind === 'tags') {
      const tagsParams = parseTagsLoopParams(match.params, product, list, ctx);
      result += applyTagsLoop(match.inner, tagsParams, product, allProducts, ctx);
    } else if (match.kind === 'metafields') {
      const metafieldsParams = parseMetafieldsLoopParams(match.params, product, list, ctx);
      result += applyMetafieldsLoop(match.inner, metafieldsParams, product, allProducts, ctx);
    } else if (match.kind === 'length') {
      const innerRendered = renderTokens(match.inner, product, allProducts, ctx);
      result += String(Array.from(innerRendered.trim()).length);
    } else {
      const loopParams = parseWhileParams(match.params);
      if (loopParams.form === 'deprecated') {
        result += deprecatedSyntaxMarker(
          'the old while form with a tag-bound counter (condition, comma, counter assignment) is ' +
            'retired -- write a hash-while token with just the boolean condition, and declare/' +
            'increment your own counter variable in the body instead',
        );
      } else {
        result += applyWhileLoop(match.inner, loopParams, product, allProducts, ctx);
      }
    }
    cursor = match.blockEnd;
  }
  return result;
}

// Resolve a foreach `i=` START/MAX expression to a number. The expression may contain nested
// `{{ ... }}` tokens (resolved against the given product/context) and/or arithmetic; both are
// evaluated with the same rules as `{{ =... }}` equations. Returns null when the expression is empty
// or evaluates to a non-finite value.
function resolveExprToNumber(
  expr: string,
  product: ProductData,
  allProducts: ProductData[],
  ctx: EvalContext,
): number | null {
  const trimmed = expr.trim();
  if (trimmed === '') return null;
  const list = allProducts.length > 0 ? allProducts : [product];
  const resolved = renderTemplateText(trimmed, product, list, ctx, true);
  try {
    const value = evaluateMathExpression(resolved);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

// ----------------------------------------------------------------------------------------------
// TEMPLATE ENGINE -- word wrap ({{ #wrap=... }})
// ----------------------------------------------------------------------------------------------
// Break a single line into rows of no more than maxChars characters, splitting on spaces. Once maxWraps
// rows have been produced (maxWraps > 0), all remaining words are appended to the final row without
// further breaking. maxWraps <= 0 means unlimited rows.
function breakLineIntoRows(line: string, maxChars: number, maxWraps: number): string[] {
  if (line.length <= maxChars) {
    return [line];
  }
  const words = line.split(' ');
  const rows: string[] = [];
  let current = '';
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    // If we've hit the row cap, dump this and all remaining words onto the last row.
    if (maxWraps > 0 && rows.length === maxWraps - 1) {
      const remaining = words.slice(i).join(' ');
      current = current === '' ? remaining : current + ' ' + remaining;
      break;
    }
    if (current === '') {
      current = word;
    } else if ((current + ' ' + word).length > maxChars) {
      rows.push(current);
      current = word;
    } else {
      current = current + ' ' + word;
    }
  }
  if (current !== '') {
    rows.push(current);
  }
  return rows;
}

// SOFT wrap helper: break a single line into fixed-width CHUNKS strictly on the nth character,
// ignoring word boundaries. No characters are removed or replaced; the caller joins the chunks with
// the delineator, so the delineator is effectively inserted after every maxChars characters. Once
// maxWraps chunks have been produced (maxWraps > 0), all remaining characters are appended to the
// final chunk without further breaking. maxWraps <= 0 means unlimited chunks.
function breakLineIntoHardChunks(line: string, maxChars: number, maxWraps: number): string[] {
  if (line.length <= maxChars) {
    return [line];
  }
  const chunks: string[] = [];
  let pos = 0;
  while (pos < line.length) {
    // If we've hit the chunk cap, append everything remaining to the last chunk.
    if (maxWraps > 0 && chunks.length === maxWraps - 1) {
      chunks.push(line.slice(pos));
      break;
    }
    chunks.push(line.slice(pos, pos + maxChars));
    pos += maxChars;
  }
  return chunks;
}

// Wrap text so no row exceeds maxChars characters. maxWraps caps the number of rows (<= 0 = unlimited);
// once the cap is reached, remaining text is placed on the last row. minWraps sets a floor (<= 0 = none):
// if fewer than minWraps rows result, empty-string rows are appended until minWraps is reached.
// Rows are joined with delineator. When `hard` is true, breaking happens strictly on the nth character
// (ignoring word boundaries, preserving all characters); when false, breaking happens on spaces.
function applyWordWrap(
  text: string,
  maxChars: number,
  minWraps: number,
  maxWraps: number,
  delineator: string,
  hard: boolean,
): string {
  if (!Number.isInteger(maxChars) || maxChars <= 0) {
    return text;
  }
  const inputLines = text.split('\n');
  const allRows: string[] = [];
  for (const line of inputLines) {
    const rows = hard
      ? breakLineIntoHardChunks(line, maxChars, maxWraps)
      : breakLineIntoRows(line, maxChars, maxWraps);
    for (const row of rows) {
      allRows.push(row);
    }
  }
  if (minWraps > 0) {
    while (allRows.length < minWraps) {
      allRows.push('');
    }
  }
  return allRows.join(delineator);
}

// RESERVED KEYWORD: 'wrap', plus its parameters ('delineator'/'min_wraps'/'max_wraps'/'hard' below)
// -- must stay listed in RESERVED_ASSIGNMENT_NAMES / RESERVED_KEYWORDS_IN_USE.
const WRAP_REGEX = /\{\{\s*#wrap=([^}]*?)\s*\}\}([\s\S]*?)\{\{\s*\/wrap\s*\}\}/g;

// Parse the wrap tag parameter string into maxChars, minWraps, maxWraps, and delineator.
// Format: `max_chars, min_wraps=N, max_wraps=N, delineator=STR`. The delineator value is captured as
// everything after the FIRST `delineator=` occurrence (so it may itself contain commas, e.g.
// `delineator=,`); only the portion before `delineator=` is split on commas to read the numeric params.
// The delineator is trimmed of genuinely typed leading/trailing whitespace (so padding you type is
// ignored -- "agnostic"); whitespace produced by the {{ \n }} / {{ \t }} tokens is carried as sentinels
// that are NOT whitespace, so it survives this trim at any position. A missing or empty delineator
// defaults to the empty string (no separator).
function parseWrapParams(rawParams: string): {
  maxChars: number;
  minWraps: number;
  maxWraps: number;
  delineator: string;
  hard: boolean;
} {
  const raw = String(rawParams);
  // Split the delineator off first so its value can contain commas. The canonical tag order places
  // `hard=...` BEFORE `delineator=`, so `hard` lives entirely within the comma-split section that is
  // parsed below; the delineator value is everything after the first `delineator=` up to the closing
  // `}}`.
  const delineatorMatch = raw.match(/delineator\s*=/);
  let numericPart = raw;
  let delineator = '';
  if (delineatorMatch && delineatorMatch.index != null) {
    numericPart = raw.slice(0, delineatorMatch.index);
    const valueStart = delineatorMatch.index + delineatorMatch[0].length;
    // Trim typed whitespace only; sentinels (token-produced whitespace) are not whitespace and remain.
    delineator = raw.slice(valueStart).trim();
  }
  const segments = numericPart.split(',');
  const maxChars = parseInt((segments[0] || '').trim(), 10);
  let minWraps = 0;
  let maxWraps = 0;
  let hard = false;
  for (let i = 1; i < segments.length; i++) {
    const eqIndex = segments[i].indexOf('=');
    if (eqIndex === -1) continue;
    const key = segments[i].slice(0, eqIndex).trim();
    const rawVal = segments[i].slice(eqIndex + 1);
    // RESERVED KEYWORD: 'min_wraps', 'max_wraps', 'hard' -- must stay listed in
    // RESERVED_ASSIGNMENT_NAMES / RESERVED_KEYWORDS_IN_USE.
    if (key === 'min_wraps') {
      const parsed = parseInt(rawVal.trim(), 10);
      minWraps = Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
    } else if (key === 'max_wraps') {
      const parsed = parseInt(rawVal.trim(), 10);
      maxWraps = Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
    } else if (key === 'hard') {
      hard = rawVal.trim() === 'TRUE';
    }
  }
  return { maxChars, minWraps, maxWraps, delineator, hard };
}

// Apply all {{#wrap=...}}...{{/wrap}} blocks in the text. Invalid maxChars leaves the inner text unchanged.
// Whitespace sentinels in the inner text and the delineator are restored to real characters here, so
// that a token newline inside the wrapped text acts as a real line break and the delineator joins rows
// with real whitespace. Any sentinels outside wrap blocks are restored by restoreWhitespaceTokens later.
function applyWrapBlocks(text: string): string {
  return text.replace(WRAP_REGEX, (_m, rawParams: string, inner: string) => {
    const { maxChars, minWraps, maxWraps, delineator, hard } = parseWrapParams(rawParams);
    const firstSegment = String(rawParams).split(',')[0].trim();
    if (!Number.isInteger(maxChars) || maxChars <= 0 || firstSegment !== String(maxChars)) {
      return inner;
    }
    return applyWordWrap(
      restoreWhitespaceTokens(inner),
      maxChars,
      minWraps,
      maxWraps,
      restoreWhitespaceTokens(delineator),
      hard,
    );
  });
}

// ----------------------------------------------------------------------------------------------
// TEMPLATE ENGINE -- selection.foreach blocks & Merge IF file-grouping
// Includes firstForeachIteratedItems/partitionByMergeCondition (session 9), used by planCombined
// below to decide whether one template body must become multiple output files.
// ----------------------------------------------------------------------------------------------
// Remove every complete foreach block's TAGS from `text`, keeping the inner content (recursively).
function unwrapForeachBlocks(text: string): string {
  let result = '';
  let cursor = 0;
  while (cursor < text.length) {
    const block = findSelectionScopeForeachBlock(text, cursor);
    if (!block) {
      result += text.slice(cursor);
      break;
    }
    result += text.slice(cursor, block.blockStart);
    result += unwrapForeachBlocks(block.inner);
    cursor = block.blockEnd;
  }
  return result;
}

// A `selection.foreach` loop may NOT be nested inside a while loop (a while loop never steps through
// the product selection). Before foreach expansion and before foreach detection, strip the foreach
// tags that appear INSIDE any while block, keeping their inner content, so the enclosed text simply
// renders against the current product on each while iteration and the template is not classed as a
// looped/combined file because of that foreach. Foreach blocks outside while blocks are untouched.
function flattenForeachInsideWhile(body: string): string {
  let result = '';
  let cursor = 0;
  while (cursor < body.length) {
    const block = findWhileBlock(body, cursor);
    if (!block) {
      result += body.slice(cursor);
      break;
    }
    result += body.slice(cursor, block.innerStart);
    result += flattenForeachInsideWhile(unwrapForeachBlocks(block.inner));
    result += body.slice(block.innerEnd, block.blockEnd);
    cursor = block.blockEnd;
  }
  return result;
}

// Parse skip_first / skip_last / i options from the selection.foreach parameter string
// (e.g. ", skip_first=TRUE, skip_last=FALSE, i=0<5"). The `i` value is captured as raw expression
// text and split once on the first `<` into `startExpr` and optional `maxExpr`; these are resolved to
// numbers later (they may be equations or contain {{ }} tokens). Splitting the param string on commas
// is safe for the numeric portion because any {{ }} tokens live inside the i= expressions which are
// re-joined below.
function parseForeachOptions(paramString: string | undefined): {
  skipFirst: boolean;
  skipLast: boolean;
  name: string;
  startExpr: string;
  maxExpr: string;
} {
  let skipFirst = false;
  let skipLast = false;
  // `i` is only the DEFAULT counter name; any variable may drive the loop (e.g. `z=0<5`).
  let name = 'i';
  let startExpr = '0';
  let maxExpr = '';
  if (paramString) {
    const segments = splitTopLevelCommas(paramString.replace(/^\s*,/, ''));
    for (const segment of segments) {
      const eqIndex = topLevelEqualsIndex(segment);
      if (eqIndex === -1) continue;
      const key = segment.slice(0, eqIndex).trim();
      const value = segment.slice(eqIndex + 1).trim();
      // RESERVED KEYWORD: 'skip_first', 'skip_last' -- must stay listed in RESERVED_ASSIGNMENT_NAMES /
      // RESERVED_KEYWORDS_IN_USE.
      if (key === 'skip_first') {
        skipFirst = value === 'TRUE';
      } else if (key === 'skip_last') {
        skipLast = value === 'TRUE';
      } else if (isVariableName(key)) {
        name = key;
        // The counter value may declare a chunk size after a `<` that sits outside any {{ }} token.
        const ltIndex = topLevelLessThanIndex(value);
        if (ltIndex === -1) {
          startExpr = value;
        } else {
          startExpr = value.slice(0, ltIndex);
          maxExpr = value.slice(ltIndex + 1);
        }
      }
    }
  }
  return { skipFirst, skipLast, name, startExpr, maxExpr };
}

// Regex sources for the three selection-scope foreach spellings (session 6). All three accept an
// OPTIONAL free-form label after `.foreach` (e.g. `{{ #selection.foreach product, i=0 }}`) that is
// purely cosmetic, exactly like every other foreach source's trailing word -- previously
// `selection.foreach` REQUIRED that word to be the literal `product`/`products`, which meant nothing
// (it was never bound to anything) and directly clashed with `product.foreach`'s unrelated use of
// the same word to mean the loop's OWNER rather than its item (found session 6). The closing tag's
// trailing word is likewise now optional/free-form (previously also required to literally be
// `product`/`products`).
//  - `selection.foreach KEYWORD` dispatches on KEYWORD (session 7, per explicit direction), read
//    from the SAME label slot described above (still optional and still free-form for any other
//    word, which keeps meaning "products only" for backward compatibility -- see below):
//      * `product` / `products` / no keyword at all -- PRODUCTS ONLY (variant-expanded rows).
//        Exactly the behavior `selection.foreach` has always had, deliberately UNCHANGED so no
//        existing template's rendered output is affected by this generalization.
//      * `object` / `objects` -- PRODUCTS THEN NOTES, combined, in that order (mirroring the
//        'object' fileBreak mode's own ordering) -- new, and the only way any selection-scope loop
//        includes both in one pass.
//      * `note` / `notes` -- NOTES ONLY (each rendered as a pseudo-product via noteToPseudoProduct).
//  - `products.foreach` / `notes.foreach` are separate, independent tags with the SAME two
//    behaviors (products-only / notes-only respectively) available as their own top-level spelling
//    -- kept from session 6 alongside the KEYWORD dispatch above rather than retired by it; the two
//    are simply two ways to write the same thing (`products.foreach` == `selection.foreach
//    product`), consistent with this file's general pattern of accepting more than one spelling for
//    the same concept.
// RESERVED KEYWORD: none of 'selection'/'products'/'notes'/'object' need to be in
// RESERVED_ASSIGNMENT_NAMES -- they are only special immediately followed by `.foreach` (or, for
// product/products/object/objects/note/notes, only inside a `selection.foreach` label slot), so
// e.g. `{{ products = X }}` (no `.foreach`) is unaffected and remains an ordinary variable
// assignment.
const SELECTION_FOREACH_OPEN_SOURCE = /\{\{\s*#selection\.foreach(?:\s+[^\s,{}]+)?/.source;
const SELECTION_FOREACH_CLOSE_SOURCE = /\{\{\s*\/selection\.foreach(?:\s+[^\s,{}]+)?\s*\}\}/.source;
const PRODUCTS_FOREACH_OPEN_SOURCE = /\{\{\s*#products\.foreach(?:\s+[^\s,{}]+)?/.source;
const PRODUCTS_FOREACH_CLOSE_SOURCE = /\{\{\s*\/products\.foreach(?:\s+[^\s,{}]+)?\s*\}\}/.source;
const NOTES_FOREACH_OPEN_SOURCE = /\{\{\s*#notes\.foreach(?:\s+[^\s,{}]+)?/.source;
const NOTES_FOREACH_CLOSE_SOURCE = /\{\{\s*\/notes\.foreach(?:\s+[^\s,{}]+)?\s*\}\}/.source;
// Recognizes exactly the six dispatch keywords in `selection.foreach KEYWORD`'s label slot -- used
// to read back what findTaggedBlock's own open-tag match already consumed (see
// findSelectionScopeForeachBlock), since findTaggedBlock's generic shape does not itself expose
// capture groups from the open-tag regex it was given.
const SELECTION_FOREACH_KEYWORD_REGEX =
  /^\{\{\s*#selection\.foreach(?:\s+(product|products|object|objects|note|notes))?/i;

// Which item list a matched selection-scope foreach block iterates: 'rows' for
// `selection.foreach`/`selection.foreach product(s)`/`products.foreach` (the selection's products,
// variant-expanded -- unchanged from always-existing behavior), 'notes' for
// `notes.foreach`/`selection.foreach note(s)`, 'object' (new) for `selection.foreach object(s)`
// (products then notes, combined).
type SelectionScopeForeachKind = 'rows' | 'notes' | 'object';

interface SelectionScopeForeachMatch extends TaggedBlock {
  kind: SelectionScopeForeachKind;
}

// Locate the first selection-scope foreach opening tag (of any of the three top-level spellings
// above) in the (comment-stripped) body at or after `fromIndex`, whichever starts earliest --
// mirroring findNextRenderBlock's earliest-candidate-wins pattern below. Each spelling is routed
// through findTaggedBlock independently, which (unlike the single-hand-rolled-close-match this
// replaces) DOES correctly track same-tag nesting depth -- so a `selection.foreach` nested inside
// another `selection.foreach` now closes against its OWN matching close tag instead of the first
// `{{/selection.foreach}}` found anywhere after it, which previously closed the OUTER block
// prematurely with no error, silently producing wrong output (found session 6, alongside the
// notation cleanup -- this bug existed independently of it and is fixed the same way regardless).
function findSelectionScopeForeachBlock(
  body: string,
  fromIndex: number,
): SelectionScopeForeachMatch | null {
  const candidates: SelectionScopeForeachMatch[] = [];
  const selectionBlock = findTaggedBlock(
    body,
    fromIndex,
    SELECTION_FOREACH_OPEN_SOURCE,
    SELECTION_FOREACH_CLOSE_SOURCE,
  );
  if (selectionBlock) {
    // Read back the label slot's keyword (see SELECTION_FOREACH_KEYWORD_REGEX) to dispatch kind --
    // any word other than the six recognized ones (or no word at all) keeps today's meaning:
    // products only.
    const openTagText = body.slice(selectionBlock.blockStart, selectionBlock.innerStart);
    const keyword = openTagText.match(SELECTION_FOREACH_KEYWORD_REGEX)?.[1]?.toLowerCase();
    const kind: SelectionScopeForeachKind =
      keyword === 'object' || keyword === 'objects'
        ? 'object'
        : keyword === 'note' || keyword === 'notes'
          ? 'notes'
          : 'rows';
    candidates.push({ ...selectionBlock, kind });
  }
  const productsBlock = findTaggedBlock(
    body,
    fromIndex,
    PRODUCTS_FOREACH_OPEN_SOURCE,
    PRODUCTS_FOREACH_CLOSE_SOURCE,
  );
  if (productsBlock) candidates.push({ ...productsBlock, kind: 'rows' });
  const notesBlock = findTaggedBlock(
    body,
    fromIndex,
    NOTES_FOREACH_OPEN_SOURCE,
    NOTES_FOREACH_CLOSE_SOURCE,
  );
  if (notesBlock) candidates.push({ ...notesBlock, kind: 'notes' });
  if (candidates.length === 0) return null;
  return candidates.reduce((earliest, candidate) =>
    candidate.blockStart < earliest.blockStart ? candidate : earliest,
  );
}

// Determine which rows a foreach block should iterate over given skip options. Operates on the
// variant-expanded row list (one entry per variant), so skip_first/skip_last drop the first/last ROW.
// Generic (T, not hardcoded ProductData) since session 9 calls this with KindedRow[] as well.
function foreachSelection<T>(rows: T[], skipFirst: boolean, skipLast: boolean): T[] {
  if (rows.length === 1) {
    return skipFirst || skipLast ? [] : rows;
  }
  let start = 0;
  let end = rows.length;
  if (skipFirst) start += 1;
  if (skipLast) end -= 1;
  if (start >= end) return [];
  return rows.slice(start, end);
}

// Expand every selection-scope foreach block (`selection.foreach` / `products.foreach` /
// `notes.foreach`) in `body`. `contextRows` (products, variant-expanded) drives the first two
// spellings, unchanged from always-existing behavior; `notes` (each wrapped via
// noteToPseudoProduct) drives the new `notes.foreach` spelling -- see
// findSelectionScopeForeachBlock's comment for why these are three separate tag pairs rather than
// one. `chunkFirstBlock`, when set, slices the FIRST selection-scope block found (of EITHER item
// list) to the given chunk window (used when a chunked file continues counting from a previous
// file); every other block renders its full iterated list. Returns the body with all matched blocks
// replaced by their rendered iterations. Uses a brace-depth-aware scanner so foreach tag params may
// contain {{ }} tokens. A plain imperative loop (not .map().join()) so `{{ break }}` in a block's
// inner content can stop that block's iteration early -- see BREAK_SENTINEL's comment; `{{ skip }}`
// discards just the current iteration and continues.
// The item list a selection-scope foreach match actually iterates, per its dispatched kind (see
// SelectionScopeForeachKind's comment): 'rows' -- the selection's products (variant-expanded,
// unchanged from always-existing behavior), tagged `kind: contextRowKind` (always 'variant' for
// every real call site -- `contextRows` here is only ever `planCombined`'s already-variant-expanded
// list); 'notes' -- the selection's free-standing notes, each wrapped via noteToPseudoProduct, tagged
// 'note'; 'object' (session 7) -- products THEN notes, combined, in that order (mirroring the
// 'object' fileBreak mode's own ordering). Shared by expandForeachBlocks and
// firstForeachIteratedItems so the two stay in agreement. `contextRowKind` exists as its own
// parameter, rather than being hardcoded, purely so this signature stays honest about not assuming
// what `contextRows` contains -- session 9's `selection.curr/next/prev.type` tokens are the reason
// a row's kind needs to be tracked at all now.
function itemListForForeachKind(
  kind: SelectionScopeForeachKind,
  contextRows: ProductData[],
  contextRowKind: RowKind,
  notes: SelectionEntry[],
): KindedRow[] {
  const notesAsRows = (): KindedRow[] =>
    notes.map((n) => ({ row: noteToPseudoProduct(n), kind: 'note' }));
  const rowsAsKinded = (): KindedRow[] => contextRows.map((row) => ({ row, kind: contextRowKind }));
  if (kind === 'notes') return notesAsRows();
  if (kind === 'object') return [...rowsAsKinded(), ...notesAsRows()];
  return rowsAsKinded();
}

function expandForeachBlocks(
  body: string,
  contextRows: ProductData[],
  contextRowKind: RowKind,
  notes: SelectionEntry[],
  baseCtx: EvalContext,
  // A CONTIGUOUS index range, into the (skip-filtered) iterated item list, to render for THIS file --
  // used when the template's Merge IF condition (session 9) has split that list into more than one
  // group; every group is contiguous by construction (partitionByMergeCondition only ever merges
  // ADJACENT items), so a simple [from, to) range is always sufficient. `null` renders every item.
  chunkFirstBlock: { from: number; to: number } | null,
): string {
  let result = '';
  let cursor = 0;
  let seenFirstBlock = false;
  while (cursor < body.length) {
    const match = findSelectionScopeForeachBlock(body, cursor);
    if (!match) {
      result += body.slice(cursor);
      break;
    }
    result += body.slice(cursor, match.blockStart);
    const opts = parseForeachOptions(match.params);
    const fullItemList = itemListForForeachKind(match.kind, contextRows, contextRowKind, notes);
    const resolveContext = fullItemList[0]?.row ?? contextRows[0];
    const startBase =
      resolveExprToNumber(opts.startExpr, resolveContext, contextRows, baseCtx) ?? 0;
    const startIndex = Math.round(startBase);
    const filteredFull = foreachSelection(fullItemList, opts.skipFirst, opts.skipLast);
    // DEPRECATED (session 9): the old `i=START<MAX` chunk-size sub-syntax is retired -- the
    // template's Merge IF setting now controls how this list is split into files (see
    // partitionByMergeCondition / planCombined). Still DETECTED, so a template that used it renders a
    // visible marker instead of silently losing its old chunking with no explanation, but the value
    // itself is never read for anything -- the loop below always runs its full (skip-filtered) item
    // list, or whatever window `chunkFirstBlock` (now driven by Merge IF grouping) supplies.
    const deprecationPrefix =
      opts.maxExpr.trim() !== ''
        ? deprecatedSyntaxMarker(
            'the i=START<MAX chunk-size syntax on a foreach tag is retired -- use this template’s ' +
              'Merge IF setting instead to control how objects are grouped into files',
          )
        : '';
    const isFirstBlock = !seenFirstBlock;
    seenFirstBlock = true;
    // Window only the first selection-scope block found, and only when a window is active; every
    // other block (or this one outside a window) renders its full filtered list. `prev`/`next` below
    // always look up TRUE neighbors in `filteredFull` by absolute index, even inside a window -- a
    // unit's neighbor may belong to a DIFFERENT output file when Merge IF split this list, and
    // `selection.next`/`selection.prev` describe the overall selection, not "the rest of this file."
    const windowFrom = isFirstBlock && chunkFirstBlock ? chunkFirstBlock.from : 0;
    const windowTo = isFirstBlock && chunkFirstBlock ? chunkFirstBlock.to : filteredFull.length;
    // Save/restore currKind/prev/next around this block's own iterations (the same save/restore
    // shape a stack scope would use): each iteration below mutates these on the shared `baseCtx` --
    // necessary so a NESTED selection-scope foreach's own position is what a token inside it sees --
    // but unlike a loop counter (which deliberately carries forward after a loop ends, see the
    // existing counterValue comment below), a foreach block's OWN position in a list must NOT leak
    // into whatever text follows it in the body: a plain `{{ selection.next.* }}` token written AFTER
    // this foreach block should still describe the ENCLOSING scope's neighbor (the top-level unit
    // this whole render is for, or an outer foreach iteration), not this block's last iteration's.
    const savedCurrKind = baseCtx.currKind;
    const savedPrev = baseCtx.prev;
    const savedNext = baseCtx.next;
    let rendered = deprecationPrefix;
    for (let idx = windowFrom, withinFileIndex = 0; idx < windowTo; idx++, withinFileIndex++) {
      // First iteration WITHIN THIS FILE'S WINDOW takes the declared start value; every later
      // iteration performs `name = name + 1` against the CURRENT stored value, so a nested loop that
      // writes the same variable carries its count forward into this loop's next iteration. The
      // counter RESETS to the START value at the start of every new window/file (unchanged from the
      // old size-based chunking's own counter-reset behavior).
      const counterValue =
        withinFileIndex === 0 ? startIndex : readVarNumber(baseCtx.vars, opts.name) + 1;
      baseCtx.vars[opts.name] = String(counterValue);
      baseCtx.currKind = filteredFull[idx].kind;
      baseCtx.prev = idx > 0 ? filteredFull[idx - 1] : null;
      baseCtx.next = idx < filteredFull.length - 1 ? filteredFull[idx + 1] : null;
      // Recursively expand any NESTED selection-scope foreach block within THIS block's own inner
      // text (against the same contextRows/notes -- a nested loop over "the selection" still means
      // the same top-level selection, not something row-scoped) before rendering it for this
      // iteration. Done INSIDE the loop, not hoisted above it, so a nested block's own start/max
      // params can correctly reference the outer loop's just-set counter for THIS iteration. Fixing
      // findSelectionScopeForeachBlock's nesting-depth tracking (see its comment) alone was not
      // sufficient to make e.g. `selection.foreach` nested inside `selection.foreach` actually
      // iterate -- it only got the OUTER block's bounds right; verified via real-JS end-to-end
      // testing that a self-nested foreach silently rendered its inner block's tags completely raw
      // (same symptom class as the session-6 regex bug) until this recursive expansion was added.
      // A no-op scan (cheap) for the overwhelmingly common non-nested case, since
      // findSelectionScopeForeachBlock finds nothing and returns match.inner unchanged.
      const expandedInner = expandForeachBlocks(
        match.inner,
        contextRows,
        contextRowKind,
        notes,
        baseCtx,
        null,
      );
      const iterationText = renderTokens(
        expandedInner,
        filteredFull[idx].row,
        contextRows,
        baseCtx,
      );
      const signal = loopControlSignal(iterationText);
      if (!signal.discard) rendered += iterationText;
      if (signal.stop) break;
    }
    baseCtx.currKind = savedCurrKind;
    baseCtx.prev = savedPrev;
    baseCtx.next = savedNext;
    result += rendered;
    cursor = match.blockEnd;
  }
  return result;
}

// Locate the FIRST selection-scope foreach block and return its (skip-filtered) iterated item list,
// tagged by kind -- or null when there is no such block. This is what 'selection' fileBreak mode
// partitions into files via the template's Merge IF condition (see planCombined/
// partitionByMergeCondition). Reads only structured row/note data already in hand (never rendered
// template output), which is what lets the file count still be known before any file is built --
// the same property the old firstForeachChunkSize/firstForeachIteratedCount pair (retired, session 9)
// relied on. `contextRows` here is always variant-expanded (this is only ever called from
// planCombined, 'selection' mode's own planner), so 'variant' is hardcoded as its kind.
function firstForeachIteratedItems(
  body: string,
  contextRows: ProductData[],
  notes: SelectionEntry[],
): KindedRow[] | null {
  const match = findSelectionScopeForeachBlock(body, 0);
  if (!match) return null;
  const opts = parseForeachOptions(match.params);
  const itemList = itemListForForeachKind(match.kind, contextRows, 'variant', notes);
  return foreachSelection(itemList, opts.skipFirst, opts.skipLast);
}

// Partition an ordered list of kinded rows into contiguous groups (session 9) by evaluating the
// template's Merge IF condition between every adjacent pair: TRUE means "merge" (the next item joins
// the current group and its rendered output is appended, no new file); FALSE, an unparseable
// condition, or an empty condition string all mean "don't merge" (the next item starts a new group/
// file). An empty condition therefore never merges -- every item is its own group, exactly
// reproducing the pre-session-9 default for both callers: one file per unit in the four per-unit
// fileBreak modes, and a single, ungrouped file in 'selection' mode (what the now-retired i=0<N
// syntax used to optionally split). Each evaluation gets its own fresh, throwaway variable store --
// this is a PLANNING-phase decision, entirely separate from any real render pass's own variable
// store, and (like firstForeachIteratedItems above) reads only structured data, never rendered
// output, so file counts stay knowable before any file is built.
function partitionByMergeCondition(
  items: KindedRow[],
  mergeCondition: string,
  selectionLength: number,
  primaryDomain: string,
  now: Date,
): number[][] {
  const groups: number[][] = [];
  if (items.length === 0) return groups;
  const condition = mergeCondition.trim();
  let current: number[] = [0];
  for (let i = 0; i < items.length - 1; i++) {
    let merge = false;
    if (condition !== '') {
      const probeCtx: EvalContext = {
        selectionLength,
        primaryDomain,
        now,
        vars: createVarStore(),
        currKind: items[i].kind,
        prev: i > 0 ? items[i - 1] : null,
        next: items[i + 1],
      };
      merge = conditionIsTrue(
        condition,
        items[i].row,
        items.map((it) => it.row),
        probeCtx,
      );
    }
    if (merge) {
      current.push(i + 1);
    } else {
      groups.push(current);
      current = [i + 1];
    }
  }
  groups.push(current);
  return groups;
}

// ----------------------------------------------------------------------------------------------
// TEMPLATE ENGINE -- top-level evaluators (COMBINED vs. PER-PRODUCT modes)
// ----------------------------------------------------------------------------------------------
// COMBINED mode planner: works out HOW MANY files the body produces (one normally, or one per chunk
// when a foreach declares a `max` chunk size and the iterated row count exceeds it) and returns a
// `render` function that renders ONE of those files on demand. Rendering one file at a time is what
// lets the download be prepared asynchronously with progress reporting.
// `selectionLength` is the true number of products the merchant selected, exposed via {{ selection.length }}.
function planCombined(
  body: string,
  products: ProductData[],
  notes: SelectionEntry[],
  mergeCondition: string,
  selectionLength: number,
  primaryDomain: string,
  now: Date,
): { fileCount: number; render: (fileIndex: number | null) => string } {
  const rows = expandSelectionToRows(products);
  const first = rows[0];
  const withoutComments = flattenForeachInsideWhile(stripComments(applyWhitespaceTokens(body)));

  // Session 9: the first selection-scope foreach's iterated item list, partitioned into groups by
  // the template's Merge IF condition -- replaces the old size-based i=0<N chunking (see
  // expandForeachBlocks' deprecation of that syntax). No foreach block at all -> always exactly 1
  // file, same as before.
  //
  // BUG FIXED (session 12): an EMPTY Merge IF must still mean exactly 1 file for 'selection' mode --
  // matching the pre-session-9 default of "chunking is off unless you opt in." partitionByMergeCondition
  // itself is correct and shared: an empty condition makes it put every item in its own group (which
  // IS the right default for the four per-unit fileBreak modes, where "no merging" means "one file
  // per unit"). But for 'selection' mode, one file per ITERATED ITEM is never the right default -- a
  // selection with, say, 12 products and an untouched (empty) Merge IF was being split into a 12-file
  // ZIP instead of the single combined file it always used to produce, because `grouped` below never
  // checked whether Merge IF was actually SET before trusting `groups.length`. The fix is this
  // `mergeCondition.trim() !== ''` guard -- mirroring the guard `planOutputFiles`' per-unit branch
  // already had correctly (`merging = mergeCondition.trim() !== ''`), which this call site was
  // missing.
  const iteratedItems = firstForeachIteratedItems(withoutComments, rows, notes);
  const groups = iteratedItems
    ? partitionByMergeCondition(iteratedItems, mergeCondition, selectionLength, primaryDomain, now)
    : null;
  const grouped = mergeCondition.trim() !== '' && groups != null && groups.length > 1;
  const fileCount = grouped ? (groups as number[][]).length : 1;

  // No neighbor/position is defined OUTSIDE a selection-scope foreach loop at the top level of
  // 'selection' mode -- only a plain body token (resolving against `first`, matching how
  // `selection.first.*` already works with no loop present) could read `selection.curr/next/prev.*`
  // there, and there's no natural "next selection object" to report for a bare top-level token.
  // Inside a loop, expandForeachBlocks sets these correctly per iteration (and restores them after).
  const topLevelCtx = (): Pick<EvalContext, 'currKind' | 'prev' | 'next'> => ({
    currKind: 'variant',
    prev: null,
    next: null,
  });

  const render = (fileIndex: number | null): string => {
    // Every output file starts from a FRESH variable store, so one group/file never leaks values
    // into the next.
    const baseCtx: EvalContext = {
      selectionLength,
      primaryDomain,
      now,
      vars: createVarStore(),
      ...topLevelCtx(),
    };
    const group = grouped && fileIndex != null ? (groups as number[][])[fileIndex] : null;
    const chunk = group ? { from: group[0], to: group[group.length - 1] + 1 } : null;
    const expanded = expandForeachBlocks(withoutComments, rows, 'variant', notes, baseCtx, chunk);
    const substituted = renderTokens(expanded, first, rows, baseCtx);
    // restoreWhitespaceTokens is the LAST step: turn any remaining whitespace sentinels (outside wrap
    // blocks) into real newlines / spaces.
    return restoreWhitespaceTokens(applyWrapBlocks(substituted));
  };

  return { fileCount, render };
}

// PER-PRODUCT mode: evaluate the template against a single row/unit (one product + one variant, a
// whole product, or a note). Any selection-scope foreach block iterates just that single unit.
// `selectionLength` is the true number of products the merchant selected (not 1), exposed via
// {{ selection.length }}. `prev`/`next` (session 9) are this unit's TRUE neighbors in the overall
// per-unit output sequence -- computed by the caller (planOutputFiles) from the full ordered units
// list, null at the first/last position -- and are what `{{ selection.prev/next.* }}` resolve
// against for the whole render, not re-scoped by anything inside the body (see expandForeachBlocks'
// save/restore comment for why a NESTED selection-scope foreach inside this unit's body still
// re-scopes correctly to ITS OWN items, without disturbing these).
//
// `preparedBody` must already have been through applyWhitespaceTokens -> stripComments ->
// flattenForeachInsideWhile (see planOutputFiles' PER-PRODUCT branch, which does this ONCE and
// reuses the result for every row). That preprocessing is a pure function of the raw template body
// alone -- it does not depend on `row` -- so doing it once instead of once per output file removes
// real, easily-avoidable redundant work for a large selection. This does NOT remove the deeper
// redundancy of the block-finding/rendering pass itself still re-scanning the (now-preprocessed)
// body from scratch for every row; see architecture-notes.md for why that part was left alone.
function evaluateSingle(
  preparedBody: string,
  current: KindedRow,
  prev: KindedRow | null,
  next: KindedRow | null,
  selectionLength: number,
  primaryDomain: string,
  now: Date,
): string {
  const baseCtx: EvalContext = {
    selectionLength,
    primaryDomain,
    now,
    vars: createVarStore(),
    currKind: current.kind,
    prev,
    next,
  };
  // Selection-scope loops iterate the WHOLE selection, which a single-row per-unit render doesn't
  // have (see planOutputFiles' non-'selection' branches -- each output file here IS one row). A
  // stray `selection.foreach`/`products.foreach` in a per-unit template iterates just that one row,
  // unchanged from always-existing behavior; `notes.foreach` has nothing to iterate here (there is
  // no selection-wide notes list threaded into per-unit rendering) and simply renders zero times --
  // not a regression, since this combination was never possible before this session either.
  const expanded = expandForeachBlocks(
    preparedBody,
    [current.row],
    current.kind,
    [],
    baseCtx,
    null,
  );
  const substituted = renderTokens(expanded, current.row, [current.row], baseCtx);
  // restoreWhitespaceTokens is the LAST step: turn any remaining whitespace sentinels (outside wrap
  // blocks) into real newlines / spaces.
  return restoreWhitespaceTokens(applyWrapBlocks(substituted));
}

// ----------------------------------------------------------------------------------------------
// OUTPUT FILE PLANNING + ZIP ARCHIVE BUILDER
// mediaTypeForExtension, the hand-rolled CRC32/UTF-8/base64/ZIP (STORE only, no compression)
// builder, and the FilePlan machinery (planOutputFiles/buildOutputFiles) that both the download
// button and the editor preview render from, so they can never disagree about the output.
// ----------------------------------------------------------------------------------------------
function mediaTypeForExtension(ext: string): string {
  const e = ext.toLowerCase();
  if (e === 'json') return 'application/json';
  if (e === 'csv') return 'text/csv';
  if (e === 'html' || e === 'htm') return 'text/html';
  if (e === 'xml') return 'application/xml';
  return 'text/plain';
}

// CRC32 for ZIP entries.
const CRC_TABLE: number[] = (() => {
  const table: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// UTF-8 encode a string into bytes without TextEncoder dependency.
function utf8Bytes(str: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < str.length; i++) {
    let code = str.charCodeAt(i);
    if (code < 0x80) {
      out.push(code);
    } else if (code < 0x800) {
      out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < str.length) {
      const hi = code;
      const lo = str.charCodeAt(i + 1);
      code = 0x10000 + ((hi - 0xd800) << 10) + (lo - 0xdc00);
      i++;
      out.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    } else {
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    }
  }
  return new Uint8Array(out);
}

function base64FromBytes(bytes: Uint8Array): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let result = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    result += chars[(n >> 18) & 63] + chars[(n >> 12) & 63] + chars[(n >> 6) & 63] + chars[n & 63];
  }
  const rem = bytes.length - i;
  if (rem === 1) {
    const n = bytes[i] << 16;
    result += chars[(n >> 18) & 63] + chars[(n >> 12) & 63] + '==';
  } else if (rem === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    result += chars[(n >> 18) & 63] + chars[(n >> 12) & 63] + chars[(n >> 6) & 63] + '=';
  }
  return result;
}

interface ZipEntry {
  name: string;
  content: string;
}

// Build an uncompressed (STORE) ZIP archive and return base64 string.
function buildZipBase64(entries: ZipEntry[]): string {
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;

  const pushUint16 = (arr: number[], v: number): void => {
    arr.push(v & 0xff, (v >> 8) & 0xff);
  };
  const pushUint32 = (arr: number[], v: number): void => {
    arr.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff);
  };

  for (const entry of entries) {
    const nameBytes = utf8Bytes(entry.name);
    const dataBytes = utf8Bytes(entry.content);
    const crc = crc32(dataBytes);
    const size = dataBytes.length;

    const localHeader: number[] = [];
    pushUint32(localHeader, 0x04034b50);
    pushUint16(localHeader, 20); // version needed
    pushUint16(localHeader, 0x0800); // UTF-8 flag
    pushUint16(localHeader, 0); // no compression
    pushUint16(localHeader, 0); // mod time
    pushUint16(localHeader, 0); // mod date
    pushUint32(localHeader, crc);
    pushUint32(localHeader, size);
    pushUint32(localHeader, size);
    pushUint16(localHeader, nameBytes.length);
    pushUint16(localHeader, 0); // extra length

    const localHeaderBytes = new Uint8Array(localHeader);
    localParts.push(localHeaderBytes, nameBytes, dataBytes);

    const centralHeader: number[] = [];
    pushUint32(centralHeader, 0x02014b50);
    pushUint16(centralHeader, 20); // version made by
    pushUint16(centralHeader, 20); // version needed
    pushUint16(centralHeader, 0x0800);
    pushUint16(centralHeader, 0);
    pushUint16(centralHeader, 0);
    pushUint16(centralHeader, 0);
    pushUint32(centralHeader, crc);
    pushUint32(centralHeader, size);
    pushUint32(centralHeader, size);
    pushUint16(centralHeader, nameBytes.length);
    pushUint16(centralHeader, 0); // extra
    pushUint16(centralHeader, 0); // comment
    pushUint16(centralHeader, 0); // disk number
    pushUint16(centralHeader, 0); // internal attrs
    pushUint32(centralHeader, 0); // external attrs
    pushUint32(centralHeader, offset); // local header offset

    const centralHeaderBytes = new Uint8Array(centralHeader);
    const centralEntry = new Uint8Array(centralHeaderBytes.length + nameBytes.length);
    centralEntry.set(centralHeaderBytes, 0);
    centralEntry.set(nameBytes, centralHeaderBytes.length);
    centralParts.push(centralEntry);

    offset += localHeaderBytes.length + nameBytes.length + dataBytes.length;
  }

  const centralSize = centralParts.reduce((sum, p) => sum + p.length, 0);
  const centralOffset = offset;

  const end: number[] = [];
  pushUint32(end, 0x06054b50);
  pushUint16(end, 0); // disk number
  pushUint16(end, 0); // disk with central dir
  pushUint16(end, entries.length);
  pushUint16(end, entries.length);
  pushUint32(end, centralSize);
  pushUint32(end, centralOffset);
  pushUint16(end, 0); // comment length
  const endBytes = new Uint8Array(end);

  let totalLength = 0;
  for (const p of localParts) totalLength += p.length;
  totalLength += centralSize + endBytes.length;

  const full = new Uint8Array(totalLength);
  let pos = 0;
  for (const p of localParts) {
    full.set(p, pos);
    pos += p.length;
  }
  for (const p of centralParts) {
    full.set(p, pos);
    pos += p.length;
  }
  full.set(endBytes, pos);

  return base64FromBytes(full);
}

function formatTimestamp(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    pad(date.getMonth() + 1) +
    '-' +
    pad(date.getDate()) +
    '-' +
    date.getFullYear() +
    '-' +
    pad(date.getHours()) +
    '-' +
    pad(date.getMinutes()) +
    '-' +
    pad(date.getSeconds())
  );
}

// The full set of output files for a template + product selection. `zipName` is null when the output
// is a single file, otherwise it is the name of the ZIP archive that packages the files.
interface OutputFiles {
  files: ZipEntry[];
  zipName: string | null;
}

// A LAZY plan of the output files: how many files the template + selection produces, the ZIP name (or
// null for a single file), and a builder that renders exactly ONE file on demand. This is the single
// shared planner used by the download link and the editor preview, so a preview always matches what a
// download would produce (combined vs per-product mode, variant rows, foreach chunking, filenames).
// Building one file at a time is what allows the download to be prepared asynchronously, yielding to
// the browser between files so progress can be shown and the UI stays responsive. The work itself
// cannot be parallelized: the sandbox is single-threaded with no Web Workers.
interface FilePlan {
  count: number;
  zipName: string | null;
  build: (index: number) => ZipEntry;
}

// Wrap a free-standing note entry (a SelectionEntry where isStandaloneNote is true) as a ProductData
// so it can be rendered through the exact same pipeline as a real product/variant row. Every
// product/variant-level field resolves to '' (matching the rule that a product/variant-level detail
// queried on a note returns an empty string), except `.note`, which carries the note's own text --
// so a template reads a note's content through the EXISTING {{ product.note }} token with no new
// template syntax, and every other {{ product.* }}/{{ variant.* }} token resolves to '' the same way
// it already does for any unset field.
function noteToPseudoProduct(entry: SelectionEntry): ProductData {
  return {
    id: entry.id,
    title: '',
    handle: '',
    vendor: '',
    productType: '',
    tags: [],
    status: '',
    description: '',
    totalInventory: null,
    imageUrl: null,
    priceMin: '',
    priceMax: '',
    currencyCode: '',
    createdAt: '',
    updatedAt: '',
    variants: [],
    allVariants: [],
    metafields: [],
    note: entry.note,
  };
}

// Filename-safe identifier for a note's own output file: a note has no product handle to name a file
// after, so this slugs the note's own text instead (matching how a product file is already named
// after its handle). Falls back to slugify's own 'template' default for an empty note.
function noteFileSlug(entry: SelectionEntry): string {
  return slugify(entry.note.slice(0, 40));
}

// Give each base name (extension-less) in order a de-duplicated version, appending `_1`, `_2`, ...
// on collision -- computed up front so de-duplication is deterministic no matter which order the
// files are actually built in. Shared by every fileBreak mode that produces one file per unit
// (variant / product / note / object).
function dedupeNames(baseNames: string[]): string[] {
  const usedNames = new Set<string>();
  return baseNames.map((base) => {
    if (!usedNames.has(base)) {
      usedNames.add(base);
      return base;
    }
    let counter = 1;
    let candidate = `${base}_${counter}`;
    while (usedNames.has(candidate)) {
      counter += 1;
      candidate = `${base}_${counter}`;
    }
    usedNames.add(candidate);
    return candidate;
  });
}

// One renderable unit for a per-unit fileBreak mode ('variant' / 'product' / 'note' / 'object'): the
// ProductData to render against (a real row for 'variant'/'product', or a note wrapped via
// noteToPseudoProduct for 'note'/'object'), its RowKind (session 9 -- see RowKind's comment; what
// `{{ selection.curr/next/prev.type }}` reports for this unit), and its extension-less base filename
// before de-duplication.
interface RenderUnit {
  row: ProductData;
  kind: RowKind;
  baseName: string;
}

// One unit per PRODUCT (not per variant): `.variants` is left exactly as the caller already resolved
// it -- the merchant's chosen variant subset (see narrowToSelectedVariants), or every variant when
// nothing was narrowed -- so `{{ product.* }}` resolves against the first SELECTED variant and an
// in-file untied variant foreach enumerates only the selected variants; a TIED variant foreach still
// always enumerates every variant regardless (applyVariantLoop reads `.allVariants` for that, which
// is untouched here), matching how TIED already behaved before variant-level selection existed.
// Unlike 'variant' mode, there is no per-row narrowing to a single variant here -- one file covers
// however many variants are currently selected for that product.
function productUnits(products: ProductData[], titleSlug: string): RenderUnit[] {
  return products.map((p) => ({
    row: { ...p, variants: p.variants.length > 0 ? p.variants : p.allVariants },
    kind: 'product',
    baseName: `${p.handle}_${titleSlug}`,
  }));
}

function noteUnits(notes: SelectionEntry[], titleSlug: string): RenderUnit[] {
  return notes.map((n) => ({
    row: noteToPseudoProduct(n),
    kind: 'note',
    baseName: `${noteFileSlug(n)}_${titleSlug}`,
  }));
}

function planOutputFiles(
  templateTitle: string,
  templateBody: string,
  templateExtension: string,
  products: ProductData[],
  notes: SelectionEntry[],
  fileBreak: FileBreak | null,
  mergeCondition: string,
  primaryDomain: string,
  now: Date,
): FilePlan {
  // Session 7, per explicit direction: a template whose fileBreak was never explicitly chosen (a
  // template saved before session 4, never opened and resaved since) is no longer guessed -- see
  // mapStoredTemplate. Refuse clearly rather than silently picking one. `count: 1` (not 0) is
  // deliberate: both the download-preparation effect and the preview memo treat a plan with no
  // files as "nothing to build, do nothing" (the same shape an empty selection already produces) and
  // would otherwise silently show neither a file nor an error -- count:1 guarantees `build` actually
  // gets called once, so the throw reaches their existing try/catch and surfaces the usual "could
  // not be generated" banner instead of nothing happening at all.
  if (fileBreak === null) {
    return {
      count: 1,
      zipName: null,
      build: () => {
        throw new Error(
          'This template has no file break selected. Open it in the editor and choose one under ' +
            'File break before downloading or previewing it.',
        );
      },
    };
  }
  const ext = sanitizeExtension(templateExtension);
  const titleSlug = slugify(templateTitle);
  const timestamp = formatTimestamp(now);
  // {{ selection.length }} has always meant the number of PRODUCTS selected; that meaning is
  // unchanged by fileBreak, and by notes being selected alongside them.
  const selectionLength = products.length;

  if (fileBreak === 'selection') {
    // One file normally, or one file per group when the template's Merge IF condition (session 9)
    // splits the first selection-scope foreach's iterated list into more than one group -- see
    // planCombined/partitionByMergeCondition. Replaces the old i=0<N chunk-size sub-syntax, now
    // deprecated (see expandForeachBlocks).
    const combined = planCombined(
      templateBody,
      products,
      notes,
      mergeCondition,
      selectionLength,
      primaryDomain,
      now,
    );
    if (combined.fileCount <= 1) {
      const name =
        products.length === 1
          ? `${products[0].handle}_${titleSlug}.${ext}`
          : `${timestamp}_looped_${titleSlug}.${ext}`;
      return {
        count: 1,
        zipName: null,
        build: () => ({ name, content: combined.render(null) }),
      };
    }
    return {
      count: combined.fileCount,
      // Unified ZIP naming (see dedup branch below): template name, then "zipped", then timestamp,
      // regardless of which mode produced the multiple files.
      zipName: `${titleSlug}_zipped_${timestamp}.zip`,
      build: (index: number) => ({
        name: `${timestamp}_looped_${titleSlug}_${index}.${ext}`,
        content: combined.render(index),
      }),
    };
  }

  // Every other mode renders one unit -- a variant row, a whole product, a note, or a mix of
  // products then notes -- through evaluateSingle against a shared preprocessed body (see
  // evaluateSingle's comment for why that's computed once here rather than once per unit).
  const preparedBody = flattenForeachInsideWhile(
    stripComments(applyWhitespaceTokens(templateBody)),
  );
  let units: RenderUnit[];
  if (fileBreak === 'variant') {
    // One file per variant row -- the long-standing default behavior.
    units = expandSelectionToRows(products).map((row) => {
      const rowVariant = row.variants[0];
      const variantSuffix = rowVariant ? `_${slugify(rowVariant.title)}` : '';
      return {
        row,
        kind: 'variant' as RowKind,
        baseName: `${row.handle}${variantSuffix}_${titleSlug}`,
      };
    });
  } else if (fileBreak === 'product') {
    units = productUnits(products, titleSlug);
  } else if (fileBreak === 'note') {
    units = noteUnits(notes, titleSlug);
  } else {
    // 'object': every product (in selection order), then every note (in selection order). Not a
    // true chronological interleave of when each was added -- products and notes are tracked as two
    // separate lists with no shared "added at" ordering -- but matches how the Selection view already
    // displays them (a Products table, then a Notes table).
    units = [...productUnits(products, titleSlug), ...noteUnits(notes, titleSlug)];
  }

  if (units.length === 0) {
    return {
      count: 0,
      zipName: null,
      build: () => {
        throw new Error('No files to build for this selection and file-break mode.');
      },
    };
  }

  // Session 9: partition units into groups via the template's Merge IF condition. An empty condition
  // (the default for every new and every pre-session-9 template) puts every unit in its own group,
  // one-to-one -- the exact pre-session-9 behavior, using the pre-existing per-unit naming below. A
  // non-empty condition switches ALL naming for this template to the chunked-file convention (even
  // for a group that never actually merges with a neighbor), so a template's own naming scheme can't
  // silently flip-flop between conventions depending on what a runtime merge decision happens to do
  // -- see TemplateData.mergeCondition's comment.
  const kindedUnits: KindedRow[] = units.map((u) => ({ row: u.row, kind: u.kind }));
  const groups = partitionByMergeCondition(
    kindedUnits,
    mergeCondition,
    selectionLength,
    primaryDomain,
    now,
  );
  const merging = mergeCondition.trim() !== '';
  const renderGroup = (group: number[]): string =>
    group
      .map((unitIndex) =>
        evaluateSingle(
          preparedBody,
          kindedUnits[unitIndex],
          unitIndex > 0 ? kindedUnits[unitIndex - 1] : null,
          unitIndex < kindedUnits.length - 1 ? kindedUnits[unitIndex + 1] : null,
          selectionLength,
          primaryDomain,
          now,
        ),
      )
      .join('');

  if (!merging) {
    if (units.length === 1) {
      const { baseName } = units[0];
      return {
        count: 1,
        zipName: null,
        build: () => ({ name: `${baseName}.${ext}`, content: renderGroup([0]) }),
      };
    }
    const names = dedupeNames(units.map((u) => u.baseName)).map((base) => `${base}.${ext}`);
    return {
      count: units.length,
      zipName: `${titleSlug}_zipped_${timestamp}.zip`,
      build: (index: number) => ({ name: names[index], content: renderGroup([index]) }),
    };
  }
  if (groups.length === 1) {
    const name = `${timestamp}_looped_${titleSlug}.${ext}`;
    return {
      count: 1,
      zipName: null,
      build: () => ({ name, content: renderGroup(groups[0]) }),
    };
  }
  return {
    count: groups.length,
    zipName: `${titleSlug}_zipped_${timestamp}.zip`,
    build: (index: number) => ({
      name: `${timestamp}_looped_${titleSlug}_${index}.${ext}`,
      content: renderGroup(groups[index]),
    }),
  };
}

// Build every planned file at once. Used by the editor preview, where the file count is bounded by
// the current selection and the merchant is already waiting on a modal.
function buildOutputFiles(
  templateTitle: string,
  templateBody: string,
  templateExtension: string,
  products: ProductData[],
  notes: SelectionEntry[],
  fileBreak: FileBreak | null,
  mergeCondition: string,
  primaryDomain: string,
  now: Date,
): OutputFiles {
  const plan = planOutputFiles(
    templateTitle,
    templateBody,
    templateExtension,
    products,
    notes,
    fileBreak,
    mergeCondition,
    primaryDomain,
    now,
  );
  const files: ZipEntry[] = [];
  for (let index = 0; index < plan.count; index++) {
    files.push(plan.build(index));
  }
  return { files, zipName: plan.zipName };
}

// Yield control back to the browser so it can paint between generated files. The sandbox has no Web
// Workers, so this is how generation stays responsive and reports progress.
function yieldToBrowser(): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

// ----------------------------------------------------------------------------------------------
// CLIENT-SIDE PRODUCT SEARCH -- simple substring matching, including metafields
// RETIRED (session 9), per explicit direction: this used to also offer an advanced boolean query
// language (`{{ }}`, `&&`, `||`, `!` -- an OR/AND/NOT grammar over double-brace-delimited groups,
// structurally the same shape as the template if/boolean grammar above but a separate
// implementation with different leaves: substring match vs. numeric/string comparison). It's gone,
// not just hidden: on top of adding real complexity to the search UI, it turned out not to deliver
// what it was actually built for -- combined AND/OR/NOT queries across several metafields at once.
// The reason is architectural, not a parser bug: this app has no server-side full-text index over
// metafield values, so ANY client-side query (boolean or plain) can only match against
// `allLoadedProducts` -- whatever has already been paged/searched into the session cache (see
// LOADED_PRODUCTS_CACHE_LIMIT) -- never the shop's full catalog. A plain substring term still
// degrades usefully in that situation, since the server's own indexed search (`serverQueryFor`,
// also removed) handles the common case and the client-side union only supplements it. A boolean
// expression has no such fallback: `isAdvancedSearch` detects it and sends `query: null` to the
// server outright (there's no Shopify search syntax for arbitrary metafield AND/OR/NOT), so it
// depended ENTIRELY on the product already being in the local cache -- which, for a rare
// metafield combination on a product the merchant hadn't already scrolled past, it usually wasn't.
// What remains (`productMatchesQuery` below) still does everything the plain/simple search path
// always did, including checking every metafield value -- partial string matches on metafields are
// unaffected by this removal; only the `&&`/`||`/`!` combinator syntax is gone.
// ----------------------------------------------------------------------------------------------
// Case-insensitive substring test of a single query term against one product's searchable
// fields: title, handle, vendor, productType, every tag, every variant SKU, and EVERY metafield
// value (which covers the custom location metafields regardless of their stored namespace/key).
function productMatchesQuery(product: ProductData, rawQuery: string): boolean {
  const query = rawQuery.trim().toLowerCase();
  if (query === '') return true;
  const haystacks: string[] = [
    product.title,
    product.handle,
    product.vendor,
    product.productType,
    // The note typed for this product inside a selection is searchable too.
    product.note || '',
    ...product.tags,
  ];
  for (const variant of product.variants) {
    if (variant.sku) haystacks.push(variant.sku);
  }
  for (const mf of product.metafields) {
    if (mf.value) haystacks.push(mf.value);
  }
  return haystacks.some((h) => (h || '').toLowerCase().includes(query));
}

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

// ----------------------------------------------------------------------------------------------
// GRAPHQL RESPONSE HELPERS
// ----------------------------------------------------------------------------------------------

// Formats a GraphQL response's top-level `errors` and/or mutation `userErrors` into one display
// string, or null when there are none. Top-level errors are reported in preference to userErrors,
// matching how every call site in this file already prioritized them before this was extracted.
function formatGraphQLErrors(
  errors: any[] | null | undefined,
  userErrors: any[] | null | undefined,
): string | null {
  if (errors && errors.length) {
    return errors.map((e: any) => e.message).join(', ');
  }
  if (userErrors && userErrors.length) {
    return userErrors
      .map((e: any) => (e.field ? `${e.field}: ${e.message}` : e.message))
      .join(', ');
  }
  return null;
}

// ----------------------------------------------------------------------------------------------
// EXTENSION COMPONENT
// State, the data layer (Shopify GraphQL reads/writes), event handlers, and view rendering all
// live in this one component -- see architecture-notes.md for why that stayed a single component
// in this pass (most state is read across view boundaries, e.g. selections and the main product
// list share the same product cache and note map) rather than being split into custom hooks.
// ----------------------------------------------------------------------------------------------
function Extension() {
  const [view, setView] = useState<'main' | 'editor' | 'selection'>('main');
  // The shop's own gid, used as the metafield ownerId on writes. Loaded on app start.
  const shopIdRef = useRef<string | null>(null);
  // The shop's primary domain host (e.g. "myshop.myshopify.com"), exposed via {{ primaryDomain }}.
  const [primaryDomain, setPrimaryDomain] = useState<string>('');

  // Products
  const [products, setProducts] = useState<ProductData[]>([]);
  const [productSearch, setProductSearch] = useState('');
  const [appliedSearch, setAppliedSearch] = useState('');
  const [productPageInfo, setProductPageInfo] = useState<PageInfo | null>(null);
  const [productsLoading, setProductsLoading] = useState(false);
  const [productError, setProductError] = useState<string | null>(null);
  const [selectedProducts, setSelectedProducts] = useState<Record<string, ProductData>>({});
  // Notes typed for selected products on the main page, keyed by product id. In-memory only: a note
  // is never written to the product, and only persists when saved into a public selection.
  const [productNotes, setProductNotes] = useState<Record<string, string>>({});
  // Which of a product's variants are checked, keyed by product id, for a product with more than one
  // variant. Absent (or an array covering every variant id) means "every variant" -- the same
  // meaning an absent/empty SelectionEntry.variantIds already has, so this maps directly onto that
  // stored field with no extra translation. In-memory only, like productNotes.
  const [selectedVariantIds, setSelectedVariantIds] = useState<Record<string, string[]>>({});
  // The Current Selection's combined product+note add-order, by id -- session 8, per explicit
  // direction ("show objects in the order added to the selection"). Neither `selectedProducts` (a
  // map) nor `noteObjects` (its own array) individually carries this, since a product and a note
  // added interleaved in time live in two separate collections with no shared ordering signal
  // between them. Deliberately a per-id SEQUENCE NUMBER map, not an order array that would need
  // splicing kept in sync on every add/remove: a forgotten update site here just leaves that id's
  // number unset, and unset sorts LAST alongside everything else unset (still visible, only
  // possibly mis-positioned) -- an order array's equivalent failure (forgetting to append on some
  // add path) would make that item invisible from the combined view entirely, a much worse
  // degradation for a value with several separate call sites that all need to stay in sync.
  // `currentSelectionOrderCounter` is a ref (not state) since bumping it must never itself trigger a
  // re-render -- only the map assignments that read it do.
  const currentSelectionOrderCounter = useRef<number>(0);
  const [currentSelectionOrderIndex, setCurrentSelectionOrderIndex] = useState<
    Record<string, number>
  >({});
  const nextSelectionOrderIndex = (): number => {
    currentSelectionOrderCounter.current += 1;
    return currentSelectionOrderCounter.current;
  };
  // Which bulk-select button is currently active, if any. Only one can be active at a time.
  const [bulkMode, setBulkMode] = useState<BulkSelectMode | null>(null);
  // Persistent map of EVERY product returned by any products query this session (initial load, each
  // search, each pagination page), keyed by product id. This is the corpus the client-side metafield
  // filter and advanced boolean search evaluate against. It only grows and is never cleared.
  const [allLoadedProducts, setAllLoadedProducts] = useState<Record<string, ProductData>>({});

  // Saved product selections (6 shared/public slots). `selectionIds` holds the stored product GIDs of
  // each saved slot; the currently open slot's working copy lives in `selectionDraft`.
  const [selectionEntries, setSelectionEntries] = useState<
    Record<PublicSelectionSlotId, SelectionEntry[]>
  >({
    public_1: [],
    public_2: [],
    public_3: [],
    public_4: [],
    public_5: [],
    public_6: [],
  });
  // Subtitles of the six public selections, shown as a gray second line in the Selections menu.
  // Free-standing note entries stored in each saved slot, read from the same metafield array as its
  // products (split out by isStandaloneNote in loadSelections).
  const [selectionNotes, setSelectionNotes] = useState<
    Record<PublicSelectionSlotId, SelectionEntry[]>
  >({
    public_1: [],
    public_2: [],
    public_3: [],
    public_4: [],
    public_5: [],
    public_6: [],
  });
  // Each public slot's stored combined product+note order, by id (session 8) -- see
  // currentSelectionOrderIndex's comment for why this is a per-id sequence-number map rather than an
  // order array. Populated in loadSelections from the stored array's own order (which already
  // interleaves products and notes exactly as they were last saved), consumed by openSelectionView
  // to seed the selection view's combined ordering for a public slot.
  const [selectionSlotOrderIndex, setSelectionSlotOrderIndex] = useState<
    Record<PublicSelectionSlotId, Record<string, number>>
  >({
    public_1: {},
    public_2: {},
    public_3: {},
    public_4: {},
    public_5: {},
    public_6: {},
  });
  // Free-standing note entries belonging to the Current Selection (in memory only until saved into
  // a slot). "noteObjects" is a holdover name from when these were a distinct NoteObject type --
  // they are plain SelectionEntry values now (id is a generated placeholder, not a product id).
  const [noteObjects, setNoteObjects] = useState<SelectionEntry[]>([]);
  // Free-standing note entries in the open selection view's working draft.
  const [selectionNoteDraft, setSelectionNoteDraft] = useState<SelectionEntry[]>([]);
  // Subset checkboxes in a PUBLIC selection view: which draft products / note objects are ticked.
  // They always start empty (nothing checked) each time a selection is opened and are never stored.
  const [checkedSelectionProducts, setCheckedSelectionProducts] = useState<Record<string, boolean>>(
    {},
  );
  const [checkedSelectionNotes, setCheckedSelectionNotes] = useState<Record<string, boolean>>({});
  // Text typed in the note modal before it is saved as a free-standing note entry.
  const [noteDraftText, setNoteDraftText] = useState<string>('');
  // True while the Refresh Page button is re-reading templates, selections, and products.
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [selectionSubtitles, setSelectionSubtitles] = useState<Record<string, string>>({});
  // The subtitle being edited in the open public selection view.
  const [subtitleDraft, setSubtitleDraft] = useState<string>('');
  const [subtitleBaseline, setSubtitleBaseline] = useState<string>('');
  const [selectionsError, setSelectionsError] = useState<string | null>(null);
  const [selectionSlot, setSelectionSlot] = useState<SelectionSlotId | null>(null);
  const [selectionDraft, setSelectionDraft] = useState<ProductData[]>([]);
  // The OPEN selection's own combined product+note order, by id -- seeded on openSelectionView from
  // currentSelectionOrderIndex ('current') or selectionSlotOrderIndex[slot] (a public slot), and
  // extended (via nextSelectionOrderIndex) whenever addMainSelectionToDraft merges more items in.
  // Session 8 -- see currentSelectionOrderIndex's comment for the map-not-array reasoning.
  const [selectionViewOrderIndex, setSelectionViewOrderIndex] = useState<Record<string, number>>(
    {},
  );
  const [selectionBaseline, setSelectionBaseline] = useState<string>('');
  const [selectionSearch, setSelectionSearch] = useState('');
  const [selectionLoading, setSelectionLoading] = useState(false);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const [selectionSaving, setSelectionSaving] = useState(false);
  const [selectionMissing, setSelectionMissing] = useState(false);
  // Mirror of `allLoadedProducts` kept in a ref so async loaders can read the latest cache without
  // depending on a stale state closure. `order` tracks insertion order (oldest first) so
  // rememberProducts can evict the oldest entries once LOADED_PRODUCTS_CACHE_LIMIT is exceeded.
  const loadedProductsRef = useRef<{ byId: Record<string, ProductData>; order: string[] }>({
    byId: {},
    order: [],
  });
  // Tracks the product request currently in flight. `pendingKey` identifies that exact request
  // (direction + cursor + query) so an identical request cannot be started again while it is still
  // running, and `token` lets a response from an older request be discarded. Without this, a change
  // event re-emitted by the search field during a re-render could restart the same search over and
  // over and lock the app up.
  const productRequestRef = useRef<{ token: number; pendingKey: string | null }>({
    token: 0,
    pendingKey: null,
  });

  // Templates
  const [templates, setTemplates] = useState<TemplateData[]>([]);
  const [templatesLoading, setTemplatesLoading] = useState(false);
  const [templateError, setTemplateError] = useState<string | null>(null);
  const [templateSearch, setTemplateSearch] = useState('');
  const [templateSort, setTemplateSort] = useState<'new-old' | 'old-new' | 'a-z' | 'z-a'>(
    'new-old',
  );
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [pinError, setPinError] = useState<string | null>(null);
  const [pinningId, setPinningId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Editor
  const [editingTemplate, setEditingTemplate] = useState<TemplateData | null>(null);
  const [editorTitle, setEditorTitle] = useState('');
  const [editorBody, setEditorBody] = useState('');
  const [editorExtension, setEditorExtension] = useState('txt');
  // `null` means "not yet chosen" -- for a BRAND NEW template this is just the initial value of a UI
  // control (not inference; the merchant is free to change it before Save, same as any other
  // dropdown default), defaulted to 'variant' below in openNewTemplate. Opening an EXISTING template
  // whose stored fileBreak is null (never explicitly chosen -- see TemplateData.fileBreak) leaves it
  // null here too, so the dropdown visibly shows "not set" rather than silently substituting a
  // guess; saveTemplate refuses to save while this is null (see editorFileBreakError), same
  // enforcement as the Title field.
  const [editorFileBreak, setEditorFileBreak] = useState<FileBreak | null>('variant');
  // Session 9: "Merge IF" -- a boolean condition (same grammar as an {{ #if=... }} condition, using
  // `{{ selection.curr/next/prev.* }}` tokens) deciding whether to merge the next unit's rendered
  // output into the current file instead of starting a new one. Empty string (the default for a new
  // template) means "never merge" -- see TemplateData.mergeCondition's comment for the full design.
  const [editorMergeCondition, setEditorMergeCondition] = useState('');
  const [editorTitleError, setEditorTitleError] = useState<string | null>(null);
  const [editorFileBreakError, setEditorFileBreakError] = useState<string | null>(null);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Placeholder token that authors type into the body to mark where a variable should go.
  // Selecting a variable from the Insert variable menu replaces all occurrences of this token.
  // Both `{{ insert }}` and the spaceless `{{insert}}` are recognized as the placeholder.
  const INSERT_PLACEHOLDER = '{{ insert }}';
  const INSERT_PLACEHOLDER_REGEX = /\{\{\s*insert\s*\}\}/g;
  // Original editor values captured when the editor was opened, used to detect unsaved changes.
  const originalEditorRef = useRef<{
    title: string;
    body: string;
    extension: string;
    fileBreak: FileBreak | null;
    mergeCondition: string;
  }>({
    title: '',
    body: '',
    extension: '',
    fileBreak: 'variant',
    mergeCondition: '',
  });

  // Download: filename shown in the confirmation popup after the merchant clicks the download link.
  const [confirmedName, setConfirmedName] = useState<string>('');
  // The prepared download (data URL + filename), built asynchronously whenever the selection changes.
  const [download, setDownload] = useState<{ href: string; name: string; isZip: boolean } | null>(
    null,
  );
  // Progress of the asynchronous download preparation: how many files are done out of the total, and
  // whether the ZIP archive is currently being packaged. Null when nothing is being prepared.
  const [downloadProgress, setDownloadProgress] = useState<{
    done: number;
    total: number;
    packaging: boolean;
  } | null>(null);
  const [downloadFailed, setDownloadFailed] = useState<boolean>(false);
  // Monotonically increasing id of the newest preparation run, so an outdated in-flight build stops
  // as soon as the selection or template changes again.
  const downloadBuildRef = useRef<number>(0);
  // Preview: which generated file the preview modal is currently showing (0-based).
  const [previewIndex, setPreviewIndex] = useState<number>(0);

  // The selected products with their current notes attached, so {{ product.note }} resolves during
  // download and preview generation and notes travel with a product into any selection, and with
  // `.variants` narrowed to whichever subset is checked in selectedVariantIds (see
  // narrowToSelectedVariants -- absent/full-coverage entries are a no-op, so this list is unaffected
  // for every product whose variants were never individually narrowed).
  const selectedProductList = useMemo(
    () =>
      Object.values<ProductData>(selectedProducts).map((p) =>
        narrowToSelectedVariants(
          { ...p, note: productNotes[p.id] || '' },
          selectedVariantIds[p.id],
        ),
      ),
    [selectedProducts, productNotes, selectedVariantIds],
  );
  const selectedTemplate = useMemo(
    () => templates.find((t) => t.id === selectedTemplateId) || null,
    [templates, selectedTemplateId],
  );

  // The products shown in the table. Combines the server-side page results with client-side matches:
  //  - No applied search term: just the server page results.
  //  - Non-empty term: UNION of the server page results and any loaded product whose metafield
  //    (or other searchable field) values contain the term (case-insensitive), de-duplicated by id
  //    with server results first.
  const displayedProducts = useMemo<ProductData[]>(() => {
    const term = appliedSearch.trim();
    if (term === '') {
      return products;
    }
    const loadedList = Object.values(allLoadedProducts);
    const result: ProductData[] = [...products];
    const seen = new Set(result.map((p) => p.id));
    for (const p of loadedList) {
      if (!seen.has(p.id) && productMatchesQuery(p, term)) {
        seen.add(p.id);
        result.push(p);
      }
    }
    return result;
  }, [products, allLoadedProducts, appliedSearch]);

  // --------------------------------------------------------------------------------------------
  // Data layer: template metafield read/write helpers
  // --------------------------------------------------------------------------------------------
  // Read the shop gid and the raw templates metafield value in one call. Records the shop id in a ref
  // for use as ownerId on writes. Returns the parsed template list plus any read error message.
  const readTemplatesFromShop = async (): Promise<{
    list: TemplateData[];
    error: string | null;
  }> => {
    const { data, errors } = await shopify.query(TEMPLATES_READ_QUERY);
    if (errors?.length) {
      return { list: [], error: errors.map((e: any) => e.message).join(', ') };
    }
    const shop = data?.shop;
    if (shop?.id) {
      shopIdRef.current = shop.id;
    }
    if (typeof shop?.primaryDomain?.host === 'string') {
      setPrimaryDomain(shop.primaryDomain.host);
    }
    // Parse every shard and merge them in order (shard0 first) to reconstruct the full list.
    const shardValues = SHARD_KEYS.map((_key, index) => shop?.[`shard${index}`]?.value);
    let anyUnparseable = false;
    const merged: TemplateData[] = [];
    for (const value of shardValues) {
      const { list, unparseable } = parseShardValue(value);
      if (unparseable) anyUnparseable = true;
      for (const t of list) merged.push(t);
    }

    // Migration: if the first shard is empty/null and the legacy metafield has data, treat the parsed
    // legacy value as the full list. It is packed into the new shards on the next save/delete; the
    // legacy metafield is left in place and never written to again.
    const firstShardEmpty = shardValues[0] == null || shardValues[0] === '' || merged.length === 0;
    if (firstShardEmpty) {
      const legacyValue = shop?.legacy?.value;
      if (legacyValue != null && legacyValue !== '') {
        const { list, unparseable } = parseShardValue(legacyValue);
        if (unparseable) anyUnparseable = true;
        if (list.length > 0) {
          return {
            list,
            error: anyUnparseable ? 'Stored templates could not be read.' : null,
          };
        }
      }
    }

    return {
      list: merged,
      error: anyUnparseable ? 'Stored templates could not be read.' : null,
    };
  };

  // Ensure the shop gid is available (needed as ownerId for writes). Re-reads if not yet loaded.
  // Returns the gid or null, setting an error message via the provided setter when it cannot be read.
  const ensureShopId = async (setError: (msg: string) => void): Promise<string | null> => {
    if (shopIdRef.current) {
      return shopIdRef.current;
    }
    const { error } = await readTemplatesFromShop();
    if (!shopIdRef.current) {
      setError(error || 'Could not determine the shop to save to.');
      return null;
    }
    return shopIdRef.current;
  };

  // Persist the full template list to the shop metafield. Returns raw errors/userErrors for handling.
  // Pack the full list into shards and write ALL shards in one metafieldsSet call so stale data in
  // higher shards is cleared when templates are removed. Returns an `overflow` flag when the list
  // exceeds the ten-shard (~1.2MB) cap, in which case no write is attempted.
  const writeTemplates = async (
    ownerId: string,
    list: TemplateData[],
  ): Promise<{ errors: any[]; userErrors: any[]; overflow: boolean }> => {
    const { shards, overflow } = packTemplatesIntoShards(list);
    if (overflow) {
      return { errors: [], userErrors: [], overflow: true };
    }
    const metafields = SHARD_KEYS.map((key, index) => ({
      ownerId,
      namespace: TEMPLATE_NAMESPACE,
      key,
      type: 'json',
      value: serializeTemplates(shards[index]),
    }));
    const { data, errors } = await shopify.query(TEMPLATES_WRITE_MUTATION, {
      variables: { metafields },
    });
    return {
      errors: errors || [],
      userErrors: data?.metafieldsSet?.userErrors || [],
      overflow: false,
    };
  };

  // Shared read-mutate-write flow for a template-list change: re-reads the stored list
  // immediately before writing (so a concurrent edit by another staff member is preserved),
  // applies `mutate` to it, writes the result, and reports one formatted error through
  // `setError` on any failure (storage overflow, transport errors, or userErrors, in that
  // priority order -- matching what saveTemplate/togglePin/confirmDelete each did inline before
  // this was extracted). Returns the written list on success, or null once `setError` has
  // already been called.
  const mutateTemplateList = async (
    mutate: (currentList: TemplateData[]) => TemplateData[],
    setError: (msg: string) => void,
  ): Promise<TemplateData[] | null> => {
    const ownerId = await ensureShopId(setError);
    if (!ownerId) {
      return null;
    }
    const { list: currentList, error: readError } = await readTemplatesFromShop();
    if (readError) {
      setError(readError);
      return null;
    }
    const nextList = mutate(currentList);
    const { errors, userErrors, overflow } = await writeTemplates(ownerId, nextList);
    if (overflow) {
      setError(storageFullMessage(nextList));
      return null;
    }
    const message = formatGraphQLErrors(errors, userErrors);
    if (message) {
      setError(message);
      return null;
    }
    return nextList;
  };

  // --------------------------------------------------------------------------------------------
  // Data layer: product fetching & caching
  // --------------------------------------------------------------------------------------------
  // Merge freshly loaded products into both the ref cache and the state map used by client-side
  // search, capped at LOADED_PRODUCTS_CACHE_LIMIT (evicting the oldest-loaded products first) so the
  // cache doesn't grow without bound across a very long session.
  const rememberProducts = (list: ProductData[]): void => {
    if (list.length === 0) return;
    // Work out which products are genuinely new BEFORE the ref is updated. Re-visiting a page the
    // app has already loaded (for example clearing the search to return to the newest arrivals)
    // brings back the same ids, and replacing the state map in that case would hand every consumer
    // a brand-new object for no reason and churn the whole page.
    const { byId, order } = loadedProductsRef.current;
    const freshProducts = list.filter((p) => !byId[p.id]);
    const nextById = { ...byId };
    const nextOrder = [...order];
    for (const p of list) {
      if (!nextById[p.id]) {
        nextOrder.push(p.id);
      }
      nextById[p.id] = p;
    }
    const evictedIds: string[] = [];
    while (nextOrder.length > LOADED_PRODUCTS_CACHE_LIMIT) {
      const oldestId = nextOrder.shift();
      if (oldestId == null) break;
      delete nextById[oldestId];
      evictedIds.push(oldestId);
    }
    loadedProductsRef.current = { byId: nextById, order: nextOrder };
    if (freshProducts.length === 0 && evictedIds.length === 0) return;
    setAllLoadedProducts((prev) => {
      const next = { ...prev };
      for (const p of freshProducts) {
        next[p.id] = p;
      }
      for (const id of evictedIds) {
        delete next[id];
      }
      return next;
    });
  };

  const fetchProducts = async (
    cursor: string | null,
    direction: 'forward' | 'backward',
    query: string,
  ): Promise<void> => {
    // Ignore a repeat of the request that is already running (same direction, cursor, and query).
    const requestKey = `${direction}|${cursor ?? ''}|${query.trim()}`;
    if (productRequestRef.current.pendingKey === requestKey) {
      return;
    }
    const requestToken = productRequestRef.current.token + 1;
    productRequestRef.current = { token: requestToken, pendingKey: requestKey };
    setProductsLoading(true);
    setProductError(null);
    try {
      const { data, errors } = await shopify.query(PRODUCTS_QUERY, {
        variables: {
          first: direction === 'forward' ? PAGE_SIZE : null,
          after: direction === 'forward' ? cursor : null,
          last: direction === 'backward' ? PAGE_SIZE : null,
          before: direction === 'backward' ? cursor : null,
          query: query.trim() || null,
        },
      });
      // A newer request has started since this one; drop this response so pages cannot fight.
      if (productRequestRef.current.token !== requestToken) {
        return;
      }
      if (errors?.length) {
        setProductError(errors.map((e: any) => e.message).join(', '));
        return;
      }
      if (data?.products) {
        const pageProducts: ProductData[] = data.products.edges.map((e: any) => mapProduct(e.node));
        setProducts(pageProducts);
        setProductPageInfo(data.products.pageInfo);
        // Merge this page into the persistent loaded-products map for client-side search.
        rememberProducts(pageProducts);
      }
    } catch (err: any) {
      if (productRequestRef.current.token === requestToken) {
        setProductError(err?.message || 'Failed to load products.');
      }
    } finally {
      if (productRequestRef.current.token === requestToken) {
        productRequestRef.current = { token: requestToken, pendingKey: null };
        setProductsLoading(false);
      }
    }
  };

  const fetchTemplates = async (): Promise<void> => {
    setTemplatesLoading(true);
    setTemplateError(null);
    try {
      const { list, error } = await readTemplatesFromShop();
      if (error) {
        setTemplateError(error);
      }
      // Display templates in creation order (the order they appear in the stored JSON array, newest
      // appended last). No alphabetical sort is applied.
      setTemplates(list);
    } catch (err: any) {
      setTemplateError(err?.message || 'Failed to load templates.');
    } finally {
      setTemplatesLoading(false);
    }
  };

  // Read all six shared saved selections. Every key is fixed, so no user identity is needed.
  const loadSelections = async (): Promise<void> => {
    setSelectionsError(null);
    try {
      const { data, errors } = await shopify.query(SELECTIONS_READ_QUERY, {
        variables: {
          ns: TEMPLATE_NAMESPACE,
          pub1: 'sel_public_1',
          pub2: 'sel_public_2',
          pub3: 'sel_public_3',
          pub4: 'sel_public_4',
          pub5: 'sel_public_5',
          pub6: 'sel_public_6',
          subs: SUBTITLES_KEY,
        },
      });
      if (errors?.length) {
        setSelectionsError(errors.map((e: any) => e.message).join(', '));
        return;
      }
      const shop = data?.shop;
      if (shop?.id) {
        shopIdRef.current = shop.id;
      }
      // Each slot's metafield holds ONE array mixing product entries and free-standing notes (see
      // SelectionEntry); parse it once per slot, then split by isStandaloneNote into the two
      // separate pieces of state the rest of the app reads (selectionEntries: products only,
      // selectionNotes: standalone notes only), since a product entry needs to be fetched by id
      // (loadProductsByIds) while a note entry never does.
      const bySlot: Record<string, SelectionEntry[]> = {
        public_1: parseSelectionItems(shop?.pub1?.value),
        public_2: parseSelectionItems(shop?.pub2?.value),
        public_3: parseSelectionItems(shop?.pub3?.value),
        public_4: parseSelectionItems(shop?.pub4?.value),
        public_5: parseSelectionItems(shop?.pub5?.value),
        public_6: parseSelectionItems(shop?.pub6?.value),
      };
      const productEntries: Record<string, SelectionEntry[]> = {};
      const noteEntries: Record<string, SelectionEntry[]> = {};
      // The stored array's own order (bySlot[slot]) already interleaves products and notes exactly
      // as they were last saved -- captured here, per id, so the selection view can render/reorder
      // them combined instead of two always-products-then-notes tables (session 8). This does NOT
      // change productEntries/noteEntries themselves (still split, same as before, since a product
      // entry needs to be fetched by id while a note entry never does) -- it's purely additional
      // ordering information alongside the existing split.
      const slotOrderIndex: Record<string, Record<string, number>> = {};
      for (const slot of PUBLIC_SLOTS) {
        productEntries[slot] = bySlot[slot].filter((e) => !isStandaloneNote(e));
        noteEntries[slot] = bySlot[slot].filter(isStandaloneNote);
        const orderIndex: Record<string, number> = {};
        bySlot[slot].forEach((e, i) => {
          orderIndex[e.id] = i;
        });
        slotOrderIndex[slot] = orderIndex;
      }
      setSelectionEntries(productEntries);
      setSelectionNotes(noteEntries);
      setSelectionSlotOrderIndex(
        slotOrderIndex as Record<PublicSelectionSlotId, Record<string, number>>,
      );
      setSelectionSubtitles(parseSubtitles(shop?.subs?.value));
    } catch (err: any) {
      setSelectionsError(err?.message || 'Failed to load saved selections.');
    }
  };

  useEffect(() => {
    const init = async (): Promise<void> => {
      await fetchTemplates();
      await fetchProducts(null, 'forward', '');
      await loadSelections();
    };
    init();
  }, []);

  const runSearch = (): void => {
    setAppliedSearch(productSearch);
    fetchProducts(null, 'forward', productSearch);
  };

  const handleNextProducts = (): void => {
    if (productPageInfo?.hasNextPage) {
      fetchProducts(productPageInfo.endCursor, 'forward', appliedSearch);
    }
  };

  const handlePrevProducts = (): void => {
    if (productPageInfo?.hasPreviousPage) {
      fetchProducts(productPageInfo.startCursor, 'backward', appliedSearch);
    }
  };

  // Re-read everything the app shows from Shopify: templates, saved selections and their subtitles,
  // and the current page of products for the applied search term. Selections made in the app are
  // preserved; only the loaded data is refreshed.
  const refreshAll = async (): Promise<void> => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await fetchTemplates();
      await loadSelections();
      await fetchProducts(null, 'forward', appliedSearch);
    } finally {
      setRefreshing(false);
    }
  };

  // --------------------------------------------------------------------------------------------
  // Handlers: notes (current selection, in-memory)
  // --------------------------------------------------------------------------------------------
  // Open the note modal, pre-filling the text when opened from the search box.
  const openNoteModal = (initialText: string): void => {
    setNoteDraftText(initialText);
  };

  // Append the current product search text to the note being typed. The modal stays open, so the
  // merchant can keep editing; an empty search box changes nothing.
  const appendSearchToNote = (): void => {
    const searchText = productSearch.trim();
    if (searchText === '') return;
    setNoteDraftText((prev) => (prev.trim() === '' ? searchText : `${prev}\n${searchText}`));
  };

  // Save the typed text as a free-standing note entry on the Current Selection. Empty text creates
  // nothing.
  const saveNoteEntry = (): void => {
    const note = noteDraftText.trim();
    if (note === '') {
      setNoteDraftText('');
      return;
    }
    const entry = createNoteEntry(note);
    setNoteObjects((prev) => [...prev, entry]);
    setCurrentSelectionOrderIndex((prev: Record<string, number>) => ({
      ...prev,
      [entry.id]: nextSelectionOrderIndex(),
    }));
    setNoteDraftText('');
  };

  const discardNoteDraft = (): void => {
    setNoteDraftText('');
  };

  // --------------------------------------------------------------------------------------------
  // Handlers: product selection & bulk-select
  // --------------------------------------------------------------------------------------------
  const toggleProduct = (product: ProductData, checked: boolean): void => {
    // Ignore a change event that reports the state the row is already in. A checkbox can re-emit
    // its change event when its checked property is re-applied during a re-render (which happens
    // when the table swaps to a page whose products are already selected), and reacting to that
    // echo would write state, re-render, and echo again in an endless loop.
    if (Boolean(selectedProducts[product.id]) === checked) {
      return;
    }
    // A manual row change means the selection no longer matches either bulk button.
    setBulkMode(null);
    setSelectedProducts((prev) => {
      const next = { ...prev };
      if (checked) {
        next[product.id] = product;
      } else {
        delete next[product.id];
      }
      return next;
    });
    if (checked) {
      setCurrentSelectionOrderIndex((prev: Record<string, number>) => ({
        ...prev,
        [product.id]: nextSelectionOrderIndex(),
      }));
    }
    // Unchecking a product on the main page deletes its note and its variant subset from the
    // current selection: neither exists once the product is no longer selected. A note or variant
    // subset already saved into a public selection is stored separately and is not affected.
    if (!checked) {
      setProductNotes((prev) => {
        const next = { ...prev };
        delete next[product.id];
        return next;
      });
      setSelectedVariantIds((prev: Record<string, string[]>) => {
        if (!(product.id in prev)) return prev;
        const next = { ...prev };
        delete next[product.id];
        return next;
      });
    }
  };

  // Store the note typed in a product's note bar. The note is never written to the product.
  const setProductNote = (productId: string, note: string): void => {
    setProductNotes((prev) => {
      // Re-applying the same text must not create a new map: an unchanged value would still be a
      // new object identity and would re-run every memo and effect that reads the notes.
      if ((prev[productId] || '') === note) {
        return prev;
      }
      return { ...prev, [productId]: note };
    });
  };

  // Toggle one variant of a selected product in/out of its checked subset. Unchecking the LAST
  // remaining checked variant is refused -- there would be nothing left to render for that product --
  // so at least one variant always stays selected.
  const toggleVariantChecked = (
    productId: string,
    allVariantIds: string[],
    variantId: string,
    checked: boolean,
  ): void => {
    setSelectedVariantIds((prev: Record<string, string[]>) => {
      const current =
        prev[productId] && prev[productId].length > 0 ? prev[productId] : allVariantIds;
      let next: string[];
      if (checked) {
        if (current.includes(variantId)) return prev;
        next = [...current, variantId];
      } else {
        next = current.filter((id: string) => id !== variantId);
        if (next.length === 0) return prev;
      }
      return { ...prev, [productId]: next };
    });
  };

  // The products each bulk-select button targets: the CURRENT SERVER PAGE only (`products`), never
  // products that only show up in the table via the client-side metafield search union (see
  // displayedProducts above) -- so a button can never silently select something the merchant hasn't
  // scrolled to.
  const bulkTargets = (mode: BulkSelectMode): ProductData[] =>
    mode === 'shown' ? products : products.filter((p: ProductData) => (p.totalInventory ?? 0) > 0);

  const inStockDisplayedCount = bulkTargets('in-stock').length;

  // A bulk-select button LOOKS active whenever every product it currently targets is selected, no
  // matter how that happened: pressing the button, or ticking each row by hand. Paging or searching
  // brings up products that are not selected, so the button falls back to its default gray
  // appearance there and pressing it selects the new page's targets instead of deselecting them.
  const bulkActive = (mode: BulkSelectMode): boolean => {
    const targets = bulkTargets(mode);
    return targets.length > 0 && targets.every((p) => Boolean(selectedProducts[p.id]));
  };

  // Add or remove a list of products from the current selection.
  const setProductsSelected = (list: ProductData[], selected: boolean): void => {
    setSelectedProducts((prev) => {
      const next = { ...prev };
      let changed = false;
      for (const p of list) {
        if (selected) {
          if (!next[p.id]) {
            next[p.id] = p;
            changed = true;
          }
        } else if (next[p.id]) {
          delete next[p.id];
          changed = true;
        }
      }
      // Nothing actually changed: keep the previous object so downstream memos and the download
      // preparation effect are not restarted for no reason.
      return changed ? next : prev;
    });
    if (selected) {
      setCurrentSelectionOrderIndex((prev: Record<string, number>) => {
        const additions = list.filter((p) => !(p.id in prev));
        if (additions.length === 0) return prev;
        const next = { ...prev };
        for (const p of additions) next[p.id] = nextSelectionOrderIndex();
        return next;
      });
    }
  };

  // Toggle one of the two bulk-select buttons. Pressing the active button again clears exactly the
  // products it selected; pressing the other button first clears the active button's products, so
  // only one button is ever active.
  const toggleBulkSelect = (mode: BulkSelectMode): void => {
    if (bulkActive(mode)) {
      setProductsSelected(bulkTargets(mode), false);
      setBulkMode(null);
      return;
    }
    if (bulkMode && bulkMode !== mode && bulkActive(bulkMode)) {
      setProductsSelected(bulkTargets(bulkMode), false);
    }
    setProductsSelected(bulkTargets(mode), true);
    setBulkMode(mode);
  };

  const clearProductSelection = (): void => {
    setBulkMode(null);
    setSelectedProducts({});
    setProductNotes({});
    setSelectedVariantIds({});
    // No need to touch currentSelectionOrderIndex: it's only ever consulted for ids that are
    // actually present in selectedProducts/noteObjects (the real source of truth for what's
    // selected), so a now-cleared product's leftover entry there is inert, not stale-and-wrong.
  };

  // --------------------------------------------------------------------------------------------
  // Handlers: template list & editor navigation
  // --------------------------------------------------------------------------------------------
  const clearTemplateSelection = (): void => {
    setSelectedTemplateId(null);
  };

  const openNewTemplate = (): void => {
    setEditingTemplate(null);
    setEditorTitle('');
    setEditorBody('');
    setEditorExtension('txt');
    setEditorFileBreak('variant');
    setEditorMergeCondition('');
    setEditorTitleError(null);
    setEditorFileBreakError(null);
    setEditorError(null);
    originalEditorRef.current = {
      title: '',
      body: '',
      extension: 'txt',
      fileBreak: 'variant',
      mergeCondition: '',
    };
    setView('editor');
  };

  const openEditTemplate = (tpl: TemplateData): void => {
    setEditingTemplate(tpl);
    setEditorTitle(tpl.title);
    setEditorBody(tpl.body);
    setEditorExtension(tpl.extension || 'txt');
    // `tpl.fileBreak` may be null (never explicitly chosen -- see TemplateData.fileBreak); left as
    // null here rather than substituted with a guess, so the dropdown visibly shows "not set".
    setEditorFileBreak(tpl.fileBreak);
    setEditorMergeCondition(tpl.mergeCondition);
    setEditorTitleError(null);
    setEditorFileBreakError(null);
    setEditorError(null);
    originalEditorRef.current = {
      title: tpl.title,
      body: tpl.body,
      extension: tpl.extension || 'txt',
      fileBreak: tpl.fileBreak,
      mergeCondition: tpl.mergeCondition,
    };
    setView('editor');
  };

  // Insert a chosen variable token into the body by replacing ALL occurrences of the
  // `{{ insert }}` placeholder with the token. If the body contains no placeholder, the token is
  // appended to the end of the body instead.
  const insertVariable = (token: string): void => {
    setEditorBody((prev) => {
      if (INSERT_PLACEHOLDER_REGEX.test(prev)) {
        return prev.replace(INSERT_PLACEHOLDER_REGEX, () => token);
      }
      return prev.length > 0 ? prev + token : token;
    });
  };

  const backToMain = (): void => {
    setView('main');
    setEditorError(null);
  };

  // Whether the editor has unsaved changes compared to the values when it was opened.
  const hasUnsavedChanges = (): boolean => {
    const orig = originalEditorRef.current;
    return (
      editorTitle !== orig.title ||
      editorBody !== orig.body ||
      editorExtension !== orig.extension ||
      editorFileBreak !== orig.fileBreak ||
      editorMergeCondition !== orig.mergeCondition
    );
  };

  // Confirm leaving from the unsaved-changes modal: navigate back to the main view.
  const confirmLeave = (): void => {
    backToMain();
  };

  const saveTemplate = async (): Promise<void> => {
    if (!editorTitle.trim()) {
      setEditorTitleError('Title is required');
      return;
    }
    // Session 7, per explicit direction: fileBreak must be explicitly chosen -- a null value is
    // never inferred or silently defaulted at save time, same enforcement as the Title field above.
    if (editorFileBreak === null) {
      setEditorFileBreakError('Choose a file break before saving');
      return;
    }
    setEditorTitleError(null);
    setEditorFileBreakError(null);
    setEditorError(null);
    setSaving(true);
    try {
      const savedId = editingTemplate ? editingTemplate.id : generateTemplateId(editorTitle);
      const nextList = await mutateTemplateList((currentList) => {
        const existingIndex = currentList.findIndex((t) => t.id === savedId);
        const savedTemplate: TemplateData = {
          id: savedId,
          title: editorTitle,
          body: editorBody,
          extension: sanitizeExtension(editorExtension),
          // Editing a template never changes its pinned state or when it was pinned.
          pinned: existingIndex >= 0 ? currentList[existingIndex].pinned === true : false,
          pinnedAt: existingIndex >= 0 ? (currentList[existingIndex].pinnedAt ?? null) : null,
          fileBreak: editorFileBreak,
          mergeCondition: editorMergeCondition,
        };
        return existingIndex >= 0
          ? currentList.map((t) => (t.id === savedTemplate.id ? savedTemplate : t))
          : [...currentList, savedTemplate];
      }, setEditorError);
      if (!nextList) {
        return;
      }
      await fetchTemplates();
      originalEditorRef.current = {
        title: editorTitle,
        body: editorBody,
        extension: editorExtension,
        fileBreak: editorFileBreak,
        mergeCondition: editorMergeCondition,
      };
      setView('main');
    } catch (err: any) {
      setEditorError(err?.message || 'Failed to save template.');
    } finally {
      setSaving(false);
    }
  };

  // Flip the pinned flag of one template and persist the whole list. The stored list is re-read
  // immediately before writing so a concurrent edit by another staff member is preserved.
  const togglePin = async (template: TemplateData): Promise<void> => {
    setPinError(null);
    setPinningId(template.id);
    try {
      // Pinning records the current time so the pinned group can sort most-recently-pinned first;
      // unpinning clears it.
      const pinnedNow = Date.now();
      const nextList = await mutateTemplateList(
        (currentList) =>
          currentList.map((t) => {
            if (t.id !== template.id) {
              return t;
            }
            const nextPinned = !(t.pinned === true);
            return { ...t, pinned: nextPinned, pinnedAt: nextPinned ? pinnedNow : null };
          }),
        setPinError,
      );
      if (!nextList) {
        return;
      }
      await fetchTemplates();
    } catch (err: any) {
      setPinError(err?.message || 'Failed to update the pinned template.');
    } finally {
      setPinningId(null);
    }
  };

  // --------------------------------------------------------------------------------------------
  // Handlers: delete-template modal
  // --------------------------------------------------------------------------------------------
  const openDeleteModal = (id: string): void => {
    setPendingDeleteId(id);
    setDeleteError(null);
  };

  const cancelDelete = (): void => {
    setPendingDeleteId(null);
    setDeleteError(null);
  };

  const confirmDelete = async (): Promise<void> => {
    if (!pendingDeleteId) return;
    setDeleteError(null);
    setDeleting(true);
    try {
      const deleteId = pendingDeleteId;
      const nextList = await mutateTemplateList(
        (currentList) => currentList.filter((t) => t.id !== deleteId),
        setDeleteError,
      );
      if (!nextList) {
        return;
      }
      if (selectedTemplateId === pendingDeleteId) {
        setSelectedTemplateId(null);
      }
      setPendingDeleteId(null);
      setDeleteError(null);
      await fetchTemplates();
    } catch (err: any) {
      setDeleteError(err?.message || 'Failed to delete template.');
    } finally {
      setDeleting(false);
    }
  };

  // --------------------------------------------------------------------------------------------
  // Derived view data: template list grouping, metafield tokens, storage label
  // --------------------------------------------------------------------------------------------
  // The ordered template list to render, plus the index of the row that the pinned / unpinned
  // separator is drawn immediately above (-1 when no separator should appear).
  const templateGroups = useMemo<{ list: TemplateData[]; dividerIndex: number }>(() => {
    const term = templateSearch.trim().toLowerCase();
    const matched = !term
      ? templates
      : templates.filter(
          (t) =>
            t.title.toLowerCase().includes(term) ||
            sanitizeExtension(t.extension).toLowerCase().includes(term),
        );
    // Templates are stored in creation order (oldest first, newest appended last), so 'old-new'
    // keeps that order as-is and 'new-old' reverses it.
    const applySelectedSort = (list: TemplateData[]): TemplateData[] => {
      const sorted = [...list];
      if (templateSort === 'new-old') {
        sorted.reverse();
      } else if (templateSort === 'a-z') {
        sorted.sort((a, b) => a.title.localeCompare(b.title));
      } else if (templateSort === 'z-a') {
        sorted.sort((a, b) => b.title.localeCompare(a.title));
      }
      return sorted;
    };
    // While a search term is active, pinning is ignored so a pinned template behaves exactly like
    // any other template, and no separator is drawn.
    if (term) {
      return { list: applySelectedSort(matched), dividerIndex: -1 };
    }
    // Pinned templates ALWAYS sort by when they were pinned, most recent first, regardless of the
    // selected sort order. A template pinned before the timestamp was recorded has no `pinnedAt`
    // and sorts to the bottom of the pinned group.
    const pinned = matched
      .filter((t) => t.pinned === true)
      .sort((a, b) => (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0));
    // The selected sort order applies to the unpinned templates only.
    const unpinned = applySelectedSort(matched.filter((t) => t.pinned !== true));
    return {
      list: [...pinned, ...unpinned],
      dividerIndex: pinned.length > 0 && unpinned.length > 0 ? pinned.length : -1,
    };
  }, [templates, templateSearch, templateSort]);

  // Always show the union of metafields across ALL currently loaded products, regardless of selection,
  // so every known metafield key is available to insert.
  const metafieldTokens = useMemo(() => {
    const seen = new Set<string>();
    const list: { token: string; label: string }[] = [];
    for (const p of products) {
      for (const mf of p.metafields) {
        const id = `${mf.namespace}.${mf.key}`;
        if (!seen.has(id)) {
          seen.add(id);
          list.push({
            token: `{{ product.metafield.${mf.namespace}.${mf.key} }}`,
            label: `${mf.namespace}.${mf.key}`,
          });
        }
      }
    }
    return list;
  }, [products]);

  // Storage indicator shown next to the Templates heading. It packs the CURRENT template list into
  // shards exactly the way a save would, counts how many of the SHARD_COUNT shards hold data, and
  // reports the share of shards still completely free. Because it is derived from `templates`, it
  // recomputes automatically whenever a template is added, edited, or deleted.
  const storageLabel = useMemo(() => {
    const { shards, overflow } = packTemplatesIntoShards(templates);
    const usedShards = overflow ? SHARD_COUNT : shards.filter((shard) => shard.length > 0).length;
    const freeShards = SHARD_COUNT - usedShards;
    const stepPercent = Math.round(100 / SHARD_COUNT);
    if (usedShards === 0) {
      return '( 100 % Template Storage Free )';
    }
    if (freeShards === 0) {
      return `( 0-${stepPercent}% Templates Free )`;
    }
    return `( ${freeShards * stepPercent}-${(freeShards + 1) * stepPercent}% Templates Free )`;
  }, [templates]);

  // --------------------------------------------------------------------------------------------
  // Download preparation
  // --------------------------------------------------------------------------------------------
  const canDownload =
    (selectedProductList.length > 0 || noteObjects.length > 0) && selectedTemplate !== null;

  // Reactively compute the download href + filename from the current selection so a single click on
  // the download link downloads the file(s) directly (browser-native), with no separate generate step.
  // The sandbox cannot programmatically trigger a download, so the merchant's own click on the link
  // fires the download; the same click also opens a confirmation popup. If building the content
  // throws, the error is captured here and surfaced via a critical banner, and no link is rendered.
  useEffect(() => {
    const buildId = downloadBuildRef.current + 1;
    downloadBuildRef.current = buildId;
    setDownload(null);
    setDownloadFailed(false);
    if (!selectedTemplate || (selectedProductList.length === 0 && noteObjects.length === 0)) {
      setDownloadProgress(null);
      return;
    }
    const tpl = selectedTemplate;
    const prepare = async (): Promise<void> => {
      try {
        // A single Date captured once for this download, so every generated file shares the same date.
        const plan = planOutputFiles(
          tpl.title,
          tpl.body,
          tpl.extension,
          selectedProductList,
          noteObjects,
          tpl.fileBreak,
          tpl.mergeCondition,
          primaryDomain,
          new Date(),
        );
        setDownloadProgress({ done: 0, total: plan.count, packaging: false });
        const files: ZipEntry[] = [];
        for (let index = 0; index < plan.count; index++) {
          files.push(plan.build(index));
          if (downloadBuildRef.current !== buildId) return;
          setDownloadProgress({ done: index + 1, total: plan.count, packaging: false });
          // Give the browser a chance to paint the progress banner between files.
          await yieldToBrowser();
          if (downloadBuildRef.current !== buildId) return;
        }
        if (files.length === 0) {
          setDownloadProgress(null);
          return;
        }
        if (plan.zipName == null) {
          const single = files[0];
          const mediaType = mediaTypeForExtension(sanitizeExtension(tpl.extension));
          setDownload({
            href: `data:${mediaType};charset=utf-8,${encodeURIComponent(single.content)}`,
            name: single.name,
            isZip: false,
          });
          setDownloadProgress(null);
          return;
        }
        setDownloadProgress({ done: plan.count, total: plan.count, packaging: true });
        await yieldToBrowser();
        if (downloadBuildRef.current !== buildId) return;
        const base64 = buildZipBase64(files);
        if (downloadBuildRef.current !== buildId) return;
        setDownload({
          href: `data:application/zip;base64,${base64}`,
          name: plan.zipName,
          isZip: true,
        });
        setDownloadProgress(null);
      } catch {
        if (downloadBuildRef.current !== buildId) return;
        setDownloadFailed(true);
        setDownloadProgress(null);
      }
    };
    prepare();
  }, [selectedTemplate, selectedProductList, noteObjects, primaryDomain]);

  // Whether the current selection is valid but the content could not be built.
  const downloadBuildFailed = canDownload && downloadFailed;
  const preparingDownload = downloadProgress !== null;

  // Called on the same click that fires the browser download: record the filename for the
  // confirmation popup so the modal can confirm exactly what was downloaded.
  const onDownloadClick = (): void => {
    if (!download) return;
    setConfirmedName(download.name);
  };

  // --------------------------------------------------------------------------------------------
  // Preview
  // --------------------------------------------------------------------------------------------
  // Preview: build the same file set the download would produce, but from the CURRENT (possibly
  // unsaved) editor values, so a template can be checked before it is saved.
  const preview = useMemo<{ files: ZipEntry[]; failed: boolean }>(() => {
    if (selectedProductList.length === 0 && noteObjects.length === 0) {
      return { files: [], failed: false };
    }
    try {
      const output = buildOutputFiles(
        editorTitle,
        editorBody,
        editorExtension,
        selectedProductList,
        noteObjects,
        editorFileBreak,
        editorMergeCondition,
        primaryDomain,
        new Date(),
      );
      return { files: output.files, failed: false };
    } catch {
      return { files: [], failed: true };
    }
  }, [
    editorTitle,
    editorBody,
    editorExtension,
    editorFileBreak,
    editorMergeCondition,
    selectedProductList,
    noteObjects,
    primaryDomain,
  ]);

  // Clamp the page index so a changed selection can never point past the last generated file.
  const previewPage =
    preview.files.length === 0 ? 0 : Math.min(previewIndex, preview.files.length - 1);
  const canPreview = selectedProductList.length > 0 || noteObjects.length > 0;

  const openPreview = (): void => {
    setPreviewIndex(0);
  };

  const showPreviousPreviewFile = (): void => {
    setPreviewIndex(previewPage > 0 ? previewPage - 1 : 0);
  };

  const showNextPreviewFile = (): void => {
    setPreviewIndex(previewPage < preview.files.length - 1 ? previewPage + 1 : previewPage);
  };

  // --- Saved selections ------------------------------------------------------------------------
  // Fetch full product data for a list of stored product GIDs, reusing anything already loaded this
  // session and fetching the rest with `nodes` in chunks. Ids that no longer resolve to a product
  // (deleted products) are reported through the `missing` flag.
  const loadProductsByIds = async (
    ids: string[],
  ): Promise<{ products: ProductData[]; missing: boolean; error: string | null }> => {
    const found: Record<string, ProductData> = {};
    const toFetch: string[] = [];
    for (const id of ids) {
      const cached = loadedProductsRef.current.byId[id];
      if (cached) {
        found[id] = cached;
      } else {
        toFetch.push(id);
      }
    }
    for (let start = 0; start < toFetch.length; start += SELECTION_FETCH_CHUNK) {
      const chunk = toFetch.slice(start, start + SELECTION_FETCH_CHUNK);
      const { data, errors } = await shopify.query(PRODUCTS_BY_IDS_QUERY, {
        variables: { ids: chunk },
      });
      if (errors?.length) {
        return {
          products: [],
          missing: false,
          error: errors.map((e: any) => e.message).join(', '),
        };
      }
      const fetched: ProductData[] = (data?.nodes || [])
        .filter((node: any) => node && node.id)
        .map((node: any) => mapProduct(node));
      rememberProducts(fetched);
      for (const p of fetched) {
        found[p.id] = p;
      }
    }
    const products: ProductData[] = [];
    for (const id of ids) {
      if (found[id]) products.push(found[id]);
    }
    return { products, missing: products.length < ids.length, error: null };
  };

  // Open a selection's full-page view. "Current Selection" starts from the live product selection;
  // a saved slot loads its stored product ids.
  const openSelectionView = async (slot: SelectionSlotId): Promise<void> => {
    setSelectionSlot(slot);
    setSelectionSearch('');
    setSelectionError(null);
    setSelectionMissing(false);
    // Subset checkboxes always start empty: opening a selection selects nothing by default.
    setCheckedSelectionProducts({});
    setCheckedSelectionNotes({});
    setView('selection');
    if (slot === 'current') {
      setSelectionDraft(selectedProductList);
      setSelectionNoteDraft(noteObjects);
      setSelectionViewOrderIndex(currentSelectionOrderIndex);
      setSelectionBaseline(selectionSignature(selectedProductList, noteObjects));
      setSubtitleDraft('');
      setSubtitleBaseline('');
      return;
    }
    const storedEntries = selectionEntries[slot] || [];
    const storedNotes = selectionNotes[slot] || [];
    setSelectionNoteDraft(storedNotes);
    setSelectionViewOrderIndex(selectionSlotOrderIndex[slot] || {});
    const storedSubtitle = selectionSubtitles[slot] || '';
    setSubtitleDraft(storedSubtitle);
    setSubtitleBaseline(storedSubtitle);
    setSelectionLoading(true);
    try {
      const { products, missing, error } = await loadProductsByIds(storedEntries.map((e) => e.id));
      if (error) {
        setSelectionError(error);
        setSelectionDraft([]);
        setSelectionBaseline('');
        return;
      }
      // Attach each product's stored note and variant subset so the selection carries its own notes
      // and its own narrowed variant selection.
      const noteById: Record<string, string> = {};
      const variantIdsById: Record<string, string[] | undefined> = {};
      for (const entry of storedEntries) {
        noteById[entry.id] = entry.note;
        variantIdsById[entry.id] = entry.variantIds;
      }
      const withNotes = products.map((p) =>
        narrowToSelectedVariants({ ...p, note: noteById[p.id] || '' }, variantIdsById[p.id]),
      );
      setSelectionDraft(withNotes);
      // The baseline is what actually loaded, so skipped (deleted) products do not look like an
      // unsaved edit; saving simply prunes them.
      setSelectionBaseline(selectionSignature(withNotes, storedNotes));
      setSelectionMissing(missing);
    } catch (err: any) {
      setSelectionError(err?.message || 'Failed to load this selection.');
    } finally {
      setSelectionLoading(false);
    }
  };

  const selectionDraftSignature = useMemo(
    () => selectionSignature(selectionDraft, selectionNoteDraft),
    [selectionDraft, selectionNoteDraft],
  );

  // Edit one free-standing note entry's text inside the open selection's working draft.
  const setSelectionDraftNoteContent = (noteId: string, note: string): void => {
    setSelectionNoteDraft((prev) => {
      const current = prev.find((n) => n.id === noteId);
      if (!current || current.note === note) {
        return prev;
      }
      return prev.map((n) => (n.id === noteId ? { ...n, note } : n));
    });
  };

  // Remove ONE note object from the open selection's working draft.
  const removeNoteFromDraft = (noteId: string): void => {
    setSelectionError(null);
    setSelectionNoteDraft((prev) => prev.filter((n) => n.id !== noteId));
  };

  // Whether the open selection is one of the saved public slots (the subset checkboxes and the
  // Select All control are only offered there, not in the in-memory Current Selection).
  const isPublicSelection = selectionSlot !== null && selectionSlot !== 'current';

  const checkedDraftProducts = selectionDraft.filter((p) => checkedSelectionProducts[p.id]);
  const checkedDraftNotes = selectionNoteDraft.filter((n) => checkedSelectionNotes[n.id]);
  const checkedItemCount = checkedDraftProducts.length + checkedDraftNotes.length;
  const allSelectionItemsChecked =
    selectionDraft.length + selectionNoteDraft.length > 0 &&
    checkedItemCount === selectionDraft.length + selectionNoteDraft.length;

  const setSelectionProductChecked = (productId: string, checked: boolean): void => {
    setCheckedSelectionProducts((prev) => {
      if (Boolean(prev[productId]) === checked) return prev;
      const next = { ...prev };
      if (checked) {
        next[productId] = true;
      } else {
        delete next[productId];
      }
      return next;
    });
  };

  const setSelectionNoteChecked = (noteId: string, checked: boolean): void => {
    setCheckedSelectionNotes((prev) => {
      if (Boolean(prev[noteId]) === checked) return prev;
      const next = { ...prev };
      if (checked) {
        next[noteId] = true;
      } else {
        delete next[noteId];
      }
      return next;
    });
  };

  // Check EVERY item in the full draft (products and note objects), regardless of any active search
  // filter. When everything is already checked, the same control clears all the checkboxes.
  const toggleSelectAllInSelection = (): void => {
    if (allSelectionItemsChecked) {
      setCheckedSelectionProducts({});
      setCheckedSelectionNotes({});
      return;
    }
    const nextProducts: Record<string, boolean> = {};
    for (const p of selectionDraft) {
      nextProducts[p.id] = true;
    }
    const nextNotes: Record<string, boolean> = {};
    for (const n of selectionNoteDraft) {
      nextNotes[n.id] = true;
    }
    setCheckedSelectionProducts(nextProducts);
    setCheckedSelectionNotes(nextNotes);
  };

  const hasSelectionUnsavedChanges = (): boolean =>
    selectionDraftSignature !== selectionBaseline || subtitleDraft !== subtitleBaseline;

  // Edit one product's note inside the open selection's working draft.
  const setSelectionDraftNote = (productId: string, note: string): void => {
    setSelectionDraft((prev) => {
      const current = prev.find((p) => p.id === productId);
      if (!current || (current.note || '') === note) {
        return prev;
      }
      return prev.map((p) => (p.id === productId ? { ...p, note } : p));
    });
  };

  // Merge the products selected on the main page into this selection's draft, de-duplicated by id.
  // The main page's own selection is left untouched.
  const addMainSelectionToDraft = (): void => {
    setSelectionError(null);
    const existing = new Set(selectionDraft.map((p) => p.id));
    const additions = selectedProductList.filter((p) => !existing.has(p.id));
    const existingNotes = new Set(selectionNoteDraft.map((n) => n.id));
    const noteAdditions = noteObjects.filter((n) => !existingNotes.has(n.id));
    if (additions.length === 0 && noteAdditions.length === 0) return;
    if (selectionDraft.length + additions.length > SELECTION_MAX_PRODUCTS) {
      setSelectionError(`A selection can hold at most ${SELECTION_MAX_PRODUCTS} products.`);
      return;
    }
    if (additions.length > 0) {
      setSelectionDraft([...selectionDraft, ...additions]);
    }
    if (noteAdditions.length > 0) {
      setSelectionNoteDraft([...selectionNoteDraft, ...noteAdditions]);
    }
    // Newly-merged items join the END of this view's combined order -- "added to the selection"
    // (session 8), same as any other add.
    if (additions.length > 0 || noteAdditions.length > 0) {
      setSelectionViewOrderIndex((prev: Record<string, number>) => {
        const next = { ...prev };
        for (const p of additions) next[p.id] = nextSelectionOrderIndex();
        for (const n of noteAdditions) next[n.id] = nextSelectionOrderIndex();
        return next;
      });
    }
  };

  const clearSelectionDraft = (): void => {
    setSelectionError(null);
    setSelectionDraft([]);
    setSelectionNoteDraft([]);
    setSelectionViewOrderIndex({});
  };

  const selectionSubtitleFor = (slot: PublicSelectionSlotId): string =>
    selectionSubtitles[slot] || '';

  // Label shown for a public selection in the Selections menu. A menu `s-button` renders a single
  // plain-text label with no color or style props, so when a slot has a subtitle the subtitle
  // REPLACES the default name, rendered through `toItalic` so it appears italic, and is followed by
  // the slot's product count: "<italic subtitle> (N)". Only ever called for a public slot (see the
  // PUBLIC_SLOTS.map call site below) -- "Current Selection" has its own literal label in the menu.
  const selectionMenuLabel = (slot: PublicSelectionSlotId): string => {
    const count = (selectionEntries[slot] || []).length + (selectionNotes[slot] || []).length;
    const subtitle = selectionSubtitleFor(slot);
    if (subtitle) {
      return `${toItalic(subtitle)} (${count})`;
    }
    return `${selectionSlotLabel(slot)} (${count})`;
  };

  // Move ONE row (product OR note) up or down by a single position in the open selection's combined
  // order, so the merchant can reorder the selection. Polaris has no drag-and-drop component and the
  // sandbox has no HTML5 drag events, so reordering uses these move controls. Operates on the FULL
  // (unfiltered) combined row list, then renumbers every row's order index sequentially from that
  // result -- simpler and more robust than swapping the two moved rows' existing values in place,
  // since it also concretely resolves any never-explicitly-ordered ("unset", sorts last) row it
  // touches into a real position, rather than juggling Infinity. The change is a draft edit; it is
  // only persisted when the merchant uses Save.
  const moveSelectionRow = (id: string, offset: number): void => {
    setSelectionError(null);
    const combined = combineSelectionRows(
      selectionDraft,
      selectionNoteDraft,
      selectionViewOrderIndex,
    );
    const index = combined.findIndex((row) => row.id === id);
    const target = index + offset;
    if (index === -1 || target < 0 || target >= combined.length) {
      return;
    }
    const reordered = [...combined];
    const [moved] = reordered.splice(index, 1);
    reordered.splice(target, 0, moved);
    const renumbered: Record<string, number> = {};
    reordered.forEach((row, i) => {
      renumbered[row.id] = i;
    });
    setSelectionViewOrderIndex(renumbered);
  };

  // Remove ONE product from the open selection's working draft. The change is a draft edit; it is
  // only persisted when the merchant uses Save.
  const removeFromSelectionDraft = (productId: string): void => {
    setSelectionError(null);
    setSelectionDraft((prev) => prev.filter((p) => p.id !== productId));
  };

  // Load this selection into the main page. In a PUBLIC selection only the CHECKED products and
  // note objects are loaded (nothing is checked by default); "Current Selection" loads its whole
  // draft. Products are unioned by id and note objects are merged by id.
  const loadSelectionIntoCurrent = (): void => {
    const productsToLoad = isPublicSelection ? checkedDraftProducts : selectionDraft;
    const notesToLoad = isPublicSelection ? checkedDraftNotes : selectionNoteDraft;
    if (productsToLoad.length === 0 && notesToLoad.length === 0) return;
    setSelectedProducts((prev) => {
      const next = { ...prev };
      for (const p of productsToLoad) {
        next[p.id] = p;
      }
      return next;
    });
    // The loaded selection's note always wins: any differing note already held for that product in
    // the current selection is overwritten to match the loaded selection (including an empty note).
    setProductNotes((prev) => {
      const next = { ...prev };
      for (const p of productsToLoad) {
        next[p.id] = p.note || '';
      }
      return next;
    });
    // Likewise seed the main page's variant checklist state from each loaded product's own narrowed
    // `.variants` -- without this, a product loaded with only some variants selected would still
    // render/download correctly (selectedProductList reads `.variants` directly), but the main
    // table's checklist would misleadingly show every variant checked until the merchant opens it.
    setSelectedVariantIds((prev: Record<string, string[]>) => {
      const next = { ...prev };
      for (const p of productsToLoad) {
        if (p.variants.length > 0 && p.variants.length < p.allVariants.length) {
          next[p.id] = p.variants.map((v: VariantData) => v.id);
        } else {
          delete next[p.id];
        }
      }
      return next;
    });
    // Note objects in the loaded selection join the Current Selection's note list (union by id).
    setNoteObjects((prev) => {
      const existing = new Set(prev.map((n) => n.id));
      const additions = notesToLoad.filter((n) => !existing.has(n.id));
      return additions.length === 0 ? prev : [...prev, ...additions];
    });
    // Newly-loaded ids join the end of the Current Selection's combined order; an id already present
    // keeps its existing position rather than jumping to the end (this loads/refreshes a product or
    // note's DATA, not necessarily a fresh "add").
    setCurrentSelectionOrderIndex((prev: Record<string, number>) => {
      const next = { ...prev };
      let changed = false;
      for (const p of productsToLoad) {
        if (!(p.id in next)) {
          next[p.id] = nextSelectionOrderIndex();
          changed = true;
        }
      }
      for (const n of notesToLoad) {
        if (!(n.id in next)) {
          next[n.id] = nextSelectionOrderIndex();
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  };

  // Persist the draft. A saved slot writes its product ids to its shop metafield; "Current Selection"
  // simply applies the draft to the in-memory product selection (nothing is persisted).
  const saveSelectionDraft = async (): Promise<void> => {
    if (!selectionSlot) return;
    setSelectionError(null);
    if (selectionSlot === 'current') {
      const next: Record<string, ProductData> = {};
      const nextNotes: Record<string, string> = {};
      const nextVariantIds: Record<string, string[]> = {};
      for (const p of selectionDraft) {
        next[p.id] = p;
        nextNotes[p.id] = p.note || '';
        if (p.variants.length > 0 && p.variants.length < p.allVariants.length) {
          nextVariantIds[p.id] = p.variants.map((v: VariantData) => v.id);
        }
      }
      setSelectedProducts(next);
      setProductNotes(nextNotes);
      setSelectedVariantIds(nextVariantIds);
      setNoteObjects(selectionNoteDraft);
      // selectionDraft/selectionNoteDraft together become the new selectedProducts/noteObjects
      // exactly, so the view's own (possibly reordered/edited) order becomes the new Current
      // Selection order in full, replacing whatever it was before.
      setCurrentSelectionOrderIndex(selectionViewOrderIndex);
      setSelectionBaseline(selectionSignature(selectionDraft, selectionNoteDraft));
      return;
    }
    const key = selectionMetafieldKey(selectionSlot);
    if (!key) {
      setSelectionError('This selection could not be saved.');
      return;
    }
    setSelectionSaving(true);
    try {
      const ownerId = await ensureShopId(setSelectionError);
      if (!ownerId) {
        return;
      }
      const entries: SelectionEntry[] = selectionDraft.map((p) => ({
        id: p.id,
        note: p.note || '',
        // Only store variantIds when the product's variants are genuinely narrowed (fewer than its
        // full list) -- an entry with every variant selected is stored exactly like a legacy entry
        // (no variantIds field at all), which is what "every variant" already means on read.
        ...(p.variants.length > 0 && p.variants.length < p.allVariants.length
          ? { variantIds: p.variants.map((v: VariantData) => v.id) }
          : {}),
      }));
      // Interleave products and notes in the view's own combined order (session 8) instead of
      // always products-then-notes, so the STORED array finally preserves true add/display order
      // for the next time this selection is loaded, not just this session's in-memory view.
      const entriesById = new Map(entries.map((e) => [e.id, e]));
      const combinedForStorage: SelectionEntry[] = combineSelectionRows(
        selectionDraft,
        selectionNoteDraft,
        selectionViewOrderIndex,
      ).map((row) => (row.kind === 'product' ? entriesById.get(row.id)! : row.note));
      const trimmedSubtitle = subtitleDraft.slice(0, SUBTITLE_MAX_LENGTH);
      const nextSubtitles: Record<string, string> = { ...selectionSubtitles };
      if (trimmedSubtitle === '') {
        delete nextSubtitles[selectionSlot];
      } else {
        nextSubtitles[selectionSlot] = trimmedSubtitle;
      }
      const { data, errors } = await shopify.query(TEMPLATES_WRITE_MUTATION, {
        variables: {
          metafields: [
            {
              ownerId,
              namespace: TEMPLATE_NAMESPACE,
              key,
              type: 'json',
              value: JSON.stringify(combinedForStorage),
            },
            {
              ownerId,
              namespace: TEMPLATE_NAMESPACE,
              key: SUBTITLES_KEY,
              type: 'json',
              value: JSON.stringify(nextSubtitles),
            },
          ],
        },
      });
      const message = formatGraphQLErrors(errors, data?.metafieldsSet?.userErrors);
      if (message) {
        setSelectionError(message);
        return;
      }
      setSelectionEntries((prev) => ({ ...prev, [selectionSlot]: entries }));
      setSelectionNotes((prev) => ({ ...prev, [selectionSlot]: selectionNoteDraft }));
      // Keep this slot's stored-order cache in step with what was just written, from the SAVED
      // array's own order (recomputed the same way parseSelectionItems would derive it on the next
      // load, so re-opening this slot without an intervening full reload shows the same order).
      const savedOrderIndex: Record<string, number> = {};
      combinedForStorage.forEach((entry, i) => {
        savedOrderIndex[entry.id] = i;
      });
      setSelectionSlotOrderIndex((prev: Record<PublicSelectionSlotId, Record<string, number>>) => ({
        ...prev,
        [selectionSlot]: savedOrderIndex,
      }));
      setSelectionSubtitles(nextSubtitles);
      setSubtitleDraft(trimmedSubtitle);
      setSubtitleBaseline(trimmedSubtitle);
      setSelectionBaseline(selectionSignature(selectionDraft, selectionNoteDraft));
      setSelectionMissing(false);
    } catch (err: any) {
      setSelectionError(err?.message || 'Failed to save this selection.');
    } finally {
      setSelectionSaving(false);
    }
  };

  const backFromSelection = (): void => {
    setView('main');
    setSelectionSlot(null);
    setSelectionError(null);
  };

  // The open selection's products and notes, combined into ONE ordered list (session 8, per
  // explicit direction: "show objects in the order added to the selection"). Unfiltered -- used to
  // find a row's true first/last position (for disabling the move-up/move-down controls) regardless
  // of any active search term.
  const selectionCombinedAll = useMemo<SelectionRow[]>(
    () => combineSelectionRows(selectionDraft, selectionNoteDraft, selectionViewOrderIndex),
    [selectionDraft, selectionNoteDraft, selectionViewOrderIndex],
  );

  // The same combined list, filtered by the in-selection search term (matches a product's usual
  // searchable fields or a note's text) -- what the table actually renders.
  const selectionRowsFiltered = useMemo<SelectionRow[]>(() => {
    const term = selectionSearch.trim();
    if (term === '') return selectionCombinedAll;
    return selectionCombinedAll.filter((row: SelectionRow) =>
      row.kind === 'product'
        ? productMatchesQuery(row.product, term)
        : noteMatchesQuery(row.note, term),
    );
  }, [selectionCombinedAll, selectionSearch]);

  // --------------------------------------------------------------------------------------------
  // View rendering
  // One closure per top-level view, dispatched by `view` in the final return below. Each closure
  // is a straight extraction of the JSX that used to live inline in an
  // `if (view === X) { return (...); }` block; it still closes over every piece of state and every
  // handler declared above, so nothing about how they resolve values changed.
  // --------------------------------------------------------------------------------------------
  const renderEditorView = () => (
    <s-page heading={editingTemplate ? 'Edit template' : 'New template'}>
      {hasUnsavedChanges() ? (
        <s-button slot="header-actions" icon="arrow-left" commandFor="leave-confirm-modal">
          Back
        </s-button>
      ) : (
        <s-button slot="header-actions" icon="arrow-left" onClick={backToMain}>
          Back
        </s-button>
      )}

      {editorError ? (
        <s-banner tone="critical" heading="Could not save template">
          <s-text>{editorError}</s-text>
        </s-banner>
      ) : null}

      <s-section>
        <s-stack gap="base">
          <s-text-field
            label="Title"
            value={editorTitle}
            error={editorTitleError || undefined}
            onInput={(e: any) => setEditorTitle(e.currentTarget.value)}
          />

          <s-stack direction="inline" gap="base" justifyContent="space-between" alignItems="center">
            <s-stack direction="inline" gap="small" alignItems="center">
              <s-text type="strong">Body</s-text>
              <s-text color="subdued">File break:</s-text>
              <s-button
                commandFor="file-break-menu"
                tone={editorFileBreak === null ? 'critical' : undefined}
              >
                {editorFileBreak ? FILE_BREAK_LABELS[editorFileBreak] : 'Not set — choose one'}
              </s-button>
              <s-menu id="file-break-menu" accessibilityLabel="File break">
                {FILE_BREAK_VALUES.map((value: FileBreak) => (
                  <s-button
                    key={value}
                    icon={editorFileBreak === value ? 'check' : undefined}
                    onClick={() => {
                      setEditorFileBreak(value);
                      setEditorFileBreakError(null);
                    }}
                  >
                    {FILE_BREAK_LABELS[value]}
                  </s-button>
                ))}
              </s-menu>
              {editorFileBreakError ? (
                <s-text tone="critical">{editorFileBreakError}</s-text>
              ) : null}
            </s-stack>
            <s-stack direction="inline" gap="small" alignItems="center">
              <s-button icon="plus" commandFor="insert-variable-menu">
                Insert variable
              </s-button>
              <s-button icon="plus" commandFor="insert-special-menu">
                Insert special
              </s-button>
            </s-stack>
            <s-menu id="insert-variable-menu" accessibilityLabel="Insert variable">
              <s-text color="subdued">
                Selected variable replaces all instances of {INSERT_PLACEHOLDER}
              </s-text>
              <s-section heading="Product fields">
                {PRODUCT_FIELD_TOKENS.map((t) => (
                  <s-button key={t.token} onClick={() => insertVariable(t.token)}>
                    {t.label}
                  </s-button>
                ))}
              </s-section>
              <s-section heading="Variant fields">
                {VARIANT_FIELD_TOKENS.map((t) => (
                  <s-button key={t.token} onClick={() => insertVariable(t.token)}>
                    {t.label}
                  </s-button>
                ))}
              </s-section>
              {metafieldTokens.length > 0 ? (
                <s-section heading="Metafields">
                  {metafieldTokens.map((t) => (
                    <s-button key={t.token} onClick={() => insertVariable(t.token)}>
                      {t.label}
                    </s-button>
                  ))}
                </s-section>
              ) : null}
            </s-menu>
            <s-menu id="insert-special-menu" accessibilityLabel="Insert special">
              <s-text color="subdued">
                Selected variable replaces all instances of {INSERT_PLACEHOLDER}
              </s-text>
              <s-section heading="Selection">
                <s-button onClick={() => insertVariable(FOREACH_BLOCK)}>For each loop</s-button>
                <s-button onClick={() => insertVariable(NOTES_LOOP_BLOCK)}>Notes foreach</s-button>
                <s-button onClick={() => insertVariable('{{ selection.length }}')}>
                  Number of products selected
                </s-button>
                <s-button onClick={() => insertVariable('{{ selection.first.product.handle }}')}>
                  First product handle
                </s-button>
                <s-button onClick={() => insertVariable('{{ selection.last.product.handle }}')}>
                  Last product handle
                </s-button>
                <s-button onClick={() => insertVariable('{{ product.length }}')}>
                  Number of variants
                </s-button>
                <s-button onClick={() => insertVariable(VARIANT_LOOP_BLOCK)}>
                  Variant foreach
                </s-button>
                <s-button onClick={() => insertVariable(TAGS_LOOP_BLOCK)}>Tags foreach</s-button>
                <s-button onClick={() => insertVariable(METAFIELDS_LOOP_BLOCK)}>
                  Metafields foreach
                </s-button>
                <s-button onClick={() => insertVariable('{{ selection.next.product.title }}')}>
                  Next object's field
                </s-button>
                <s-button onClick={() => insertVariable('{{ selection.prev.product.title }}')}>
                  Previous object's field
                </s-button>
                <s-button onClick={() => insertVariable('{{ selection.next.type }}')}>
                  Next object's type
                </s-button>
                <s-button onClick={() => insertVariable('{{ selection.prev.type }}')}>
                  Previous object's type
                </s-button>
                <s-button onClick={() => insertVariable('{{ selection.curr.type }}')}>
                  Current object's type
                </s-button>
              </s-section>
              <s-section heading="Variables">
                <s-button onClick={() => insertVariable(ASSIGN_TOKEN)}>Assign variable</s-button>
                {VARIABLE_NAMES.map((name) => (
                  <s-button key={name} onClick={() => insertVariable(`{{ ${name} }}`)}>
                    Variable {name}
                  </s-button>
                ))}
              </s-section>
              <s-section heading="Functions">
                <s-button onClick={() => insertVariable(WHILE_BLOCK)}>While loop</s-button>
                <s-button onClick={() => insertVariable(CHOP_BLOCK)}>Chop block</s-button>
                <s-button onClick={() => insertVariable(WRAP_BLOCK)}>Word wrap</s-button>
                <s-button onClick={() => insertVariable(REPEAT_BLOCK)}>Repeat</s-button>
                <s-button onClick={() => insertVariable(INDEX_BLOCK)}>Index</s-button>
                <s-button onClick={() => insertVariable(INSERT_BLOCK)}>Insert block</s-button>
                <s-button onClick={() => insertVariable(IF_BLOCK)}>If block</s-button>
                <s-button onClick={() => insertVariable(REPLACE_BLOCK)}>Replace</s-button>
                <s-button onClick={() => insertVariable(COMMENT_BLOCK)}>Comment block</s-button>
                <s-button onClick={() => insertVariable(BREAK_TOKEN_BLOCK)}>Break</s-button>
                <s-button onClick={() => insertVariable(SKIP_TOKEN_BLOCK)}>Skip</s-button>
              </s-section>
              <s-section heading="Functional tokens">
                <s-button onClick={() => insertVariable('{{ =0 }}')}>Math equation</s-button>
                <s-button onClick={() => insertVariable(BOOLEAN_TOKEN)}>Boolean equation</s-button>
                <s-button onClick={() => insertVariable(LENGTH_TOKEN)}>String length</s-button>
              </s-section>
              <s-section heading="Special tokens">
                <s-button onClick={() => insertVariable(NEWLINE_TOKEN_SNIPPET)}>New line</s-button>
                <s-button onClick={() => insertVariable(SPACE_TOKEN_SNIPPET)}>Space</s-button>
                <s-button onClick={() => insertVariable(DATE_TOKEN)}>Date</s-button>
                <s-button onClick={() => insertVariable(TIME_TOKEN)}>Time</s-button>
                <s-button onClick={() => insertVariable(DATE_TIME_TOKEN)}>Date and time</s-button>
                <s-button onClick={() => insertVariable(WEEKDAY_DATE_TOKEN)}>
                  Weekday, month day, year
                </s-button>
                <s-button onClick={() => insertVariable('{{ primaryDomain }}')}>
                  Shop primary domain
                </s-button>
              </s-section>
            </s-menu>
          </s-stack>

          <s-text-area
            label="Body"
            labelAccessibilityVisibility="exclusive"
            value={editorBody}
            rows={16}
            maxLength={1000000}
            placeholder="Write your template. Place {{ insert }} where you want to insert a variable, then select it from the menu above."
            autocomplete="off"
            onInput={(e: any) => setEditorBody(e.currentTarget.value)}
          />

          <s-text-field
            label="Merge IF:"
            value={editorMergeCondition}
            details="Can be used to modify the file break behavior.  If evaluates to TRUE, the next file's text will be appended to the current file's text. If Empty or FALSE, the files do not merge. Can use variables, functions, and selection references in the selection using commands."
            onInput={(e: any) => setEditorMergeCondition(e.currentTarget.value)}
          />

          <s-text-field
            label="Extension"
            value={editorExtension}
            details="File extension for generated files, e.g. txt, csv, json, html."
            onInput={(e: any) => setEditorExtension(e.currentTarget.value)}
          />
        </s-stack>
      </s-section>

      <s-stack direction="inline" gap="base" justifyContent="space-between">
        <s-button variant="primary" loading={saving} onClick={saveTemplate}>
          Save
        </s-button>
        <s-button
          disabled={!canPreview}
          commandFor="preview-modal"
          command="--show"
          onClick={openPreview}
        >
          Preview
        </s-button>
      </s-stack>

      <s-modal id="preview-modal" heading="Preview" size="large">
        <s-stack gap="base">
          {preview.failed ? (
            <s-banner tone="critical" heading="Could not build preview">
              <s-text>
                The preview could not be generated from this template and the selected products.
              </s-text>
            </s-banner>
          ) : preview.files.length === 0 ? (
            <s-text color="subdued">Select at least one product to preview this template.</s-text>
          ) : (
            <s-stack gap="base">
              {preview.files.length > 1 ? (
                <s-stack
                  direction="inline"
                  gap="small"
                  alignItems="center"
                  justifyContent="space-between"
                >
                  <s-button
                    icon="chevron-left"
                    accessibilityLabel="Previous file"
                    disabled={previewPage === 0}
                    onClick={showPreviousPreviewFile}
                  />
                  <s-text color="subdued">
                    File {previewPage + 1} of {preview.files.length}:{' '}
                    {preview.files[previewPage].name}
                  </s-text>
                  <s-button
                    icon="chevron-right"
                    accessibilityLabel="Next file"
                    disabled={previewPage === preview.files.length - 1}
                    onClick={showNextPreviewFile}
                  />
                </s-stack>
              ) : (
                <s-text color="subdued">{preview.files[previewPage].name}</s-text>
              )}
              <s-text-area
                label="Preview content"
                labelAccessibilityVisibility="exclusive"
                value={preview.files[previewPage].content}
                rows={18}
                readOnly
              />
            </s-stack>
          )}
        </s-stack>
        <s-button
          slot="primary-action"
          variant="primary"
          commandFor="preview-modal"
          command="--hide"
        >
          Close
        </s-button>
      </s-modal>

      <s-modal id="leave-confirm-modal" heading="Unsaved changes">
        <s-text>You have unsaved changes. Leave without saving?</s-text>
        <s-button
          slot="primary-action"
          variant="primary"
          tone="critical"
          commandFor="leave-confirm-modal"
          command="--hide"
          onClick={confirmLeave}
        >
          Leave without saving
        </s-button>
        <s-button
          slot="secondary-actions"
          variant="secondary"
          commandFor="leave-confirm-modal"
          command="--hide"
        >
          Stay
        </s-button>
      </s-modal>
    </s-page>
  );

  const renderSelectionView = () => (
    <s-page heading={selectionSlotLabel(selectionSlot!)} inlineSize="large">
      <s-stack slot="header-actions" direction="inline" gap="base">
        {hasSelectionUnsavedChanges() ? (
          <s-button icon="arrow-left" commandFor="selection-leave-modal">
            Back
          </s-button>
        ) : (
          <s-button icon="arrow-left" onClick={backFromSelection}>
            Back
          </s-button>
        )}
        <s-button onClick={clearSelectionDraft} disabled={selectionDraft.length === 0}>
          Clear Selection
        </s-button>
        <s-button
          onClick={loadSelectionIntoCurrent}
          disabled={
            isPublicSelection
              ? checkedItemCount === 0
              : selectionDraft.length === 0 && selectionNoteDraft.length === 0
          }
        >
          Load Selection
        </s-button>
        <s-button
          variant="primary"
          disabled={selectedProductList.length === 0 && noteObjects.length === 0}
          onClick={addMainSelectionToDraft}
        >
          Add to Selection
        </s-button>
        <s-button loading={selectionSaving} onClick={saveSelectionDraft}>
          Save
        </s-button>
      </s-stack>

      {selectionError ? (
        <s-banner tone="critical" heading="Selection error">
          <s-text>{selectionError}</s-text>
        </s-banner>
      ) : null}

      {selectionMissing ? (
        <s-banner tone="info" heading="Some products were skipped">
          <s-text>Some products in this selection no longer exist and were skipped.</s-text>
        </s-banner>
      ) : null}

      <s-section padding="none">
        <s-box padding="base">
          <s-stack gap="base">
            <s-stack
              direction="inline"
              gap="base"
              justifyContent="space-between"
              alignItems="center"
            >
              <s-heading>Items in this selection</s-heading>
              <s-text color="subdued">
                {selectionDraft.length} products · {selectionNoteDraft.length} notes
              </s-text>
            </s-stack>
            {selectionSlot !== 'current' ? (
              <s-text-field
                label="Subtitle"
                value={subtitleDraft}
                maxLength={SUBTITLE_MAX_LENGTH}
                details="Up to 16 characters. Shown under this selection in the Selections menu."
                onInput={(e: any) => setSubtitleDraft(e.currentTarget.value)}
              />
            ) : null}
            <s-search-field
              label="Search this selection"
              labelAccessibilityVisibility="exclusive"
              placeholder="Search products in this selection…"
              value={selectionSearch}
              onInput={(e: any) => setSelectionSearch(e.currentTarget.value)}
            />
            {isPublicSelection ? (
              <s-stack direction="inline" gap="small" alignItems="center">
                <s-button
                  onClick={toggleSelectAllInSelection}
                  disabled={selectionDraft.length + selectionNoteDraft.length === 0}
                >
                  {allSelectionItemsChecked ? 'Deselect All' : 'Select All'}
                </s-button>
                <s-text color="subdued">{checkedItemCount} selected</s-text>
              </s-stack>
            ) : null}
          </s-stack>
        </s-box>

        {/* ONE combined table interleaving products and notes, ordered by when each was added to
              the selection (session 8, per explicit direction) -- replaces the old two separate
              "Products"/"Notes" tables, which always showed every product before every note
              regardless of actual add order. */}
        <s-table loading={selectionLoading}>
          <s-table-header-row>
            {isPublicSelection ? <s-table-header>Use</s-table-header> : null}
            <s-table-header listSlot="primary">Item</s-table-header>
            <s-table-header>Handle</s-table-header>
            <s-table-header>Qty</s-table-header>
            <s-table-header>Note</s-table-header>
            <s-table-header>Order</s-table-header>
            <s-table-header>Remove</s-table-header>
          </s-table-header-row>
          <s-table-body>
            {selectionRowsFiltered.length === 0 && !selectionLoading ? (
              <s-table-row>
                <s-table-cell>
                  <s-text color="subdued">
                    {selectionDraft.length === 0 && selectionNoteDraft.length === 0
                      ? 'No products or notes in this selection.'
                      : 'No items found.'}
                  </s-text>
                </s-table-cell>
                <s-table-cell />
                <s-table-cell />
                <s-table-cell />
                <s-table-cell />
                <s-table-cell />
                {isPublicSelection ? <s-table-cell /> : null}
              </s-table-row>
            ) : (
              selectionRowsFiltered.map((row: SelectionRow) => {
                const isFirst = selectionCombinedAll[0]?.id === row.id;
                const isLast = selectionCombinedAll[selectionCombinedAll.length - 1]?.id === row.id;
                const label = row.kind === 'product' ? row.product.title : 'Note';
                return (
                  <s-table-row key={row.id}>
                    {isPublicSelection ? (
                      <s-table-cell>
                        <s-checkbox
                          accessibilityLabel={`Include ${label} when loading`}
                          checked={Boolean(
                            row.kind === 'product'
                              ? checkedSelectionProducts[row.id]
                              : checkedSelectionNotes[row.id],
                          )}
                          onChange={(e: any) =>
                            row.kind === 'product'
                              ? setSelectionProductChecked(row.id, e.currentTarget.checked)
                              : setSelectionNoteChecked(row.id, e.currentTarget.checked)
                          }
                        />
                      </s-table-cell>
                    ) : null}
                    <s-table-cell>
                      {row.kind === 'product' ? (
                        <s-stack direction="inline" gap="small" alignItems="center">
                          {row.product.imageUrl ? (
                            <s-thumbnail
                              size="small"
                              src={row.product.imageUrl}
                              alt={row.product.title}
                            />
                          ) : null}
                          <s-text type="strong">{row.product.title}</s-text>
                        </s-stack>
                      ) : (
                        <s-text type="strong">📝 Note</s-text>
                      )}
                    </s-table-cell>
                    <s-table-cell>
                      <s-text color="subdued">
                        {row.kind === 'product' ? row.product.handle : '—'}
                      </s-text>
                    </s-table-cell>
                    <s-table-cell>
                      <s-text color="subdued">
                        {row.kind === 'product' ? formatQty(row.product.totalInventory) : '—'}
                      </s-text>
                    </s-table-cell>
                    <s-table-cell>
                      <s-text-field
                        label={
                          row.kind === 'product' ? `Note for ${row.product.title}` : 'Note text'
                        }
                        labelAccessibilityVisibility="exclusive"
                        placeholder={row.kind === 'product' ? 'Add a note…' : undefined}
                        value={row.kind === 'product' ? row.product.note || '' : row.note.note}
                        onInput={(e: any) =>
                          row.kind === 'product'
                            ? setSelectionDraftNote(row.id, e.currentTarget.value)
                            : setSelectionDraftNoteContent(row.id, e.currentTarget.value)
                        }
                      />
                    </s-table-cell>
                    <s-table-cell>
                      {/* Reordering uses move controls because Polaris has no drag-and-drop
                            component and the sandbox exposes no HTML5 drag events. Moves are
                            disabled while a search filters the list, so positions always reflect
                            true combined order. */}
                      <s-stack direction="inline" gap="small-400" alignItems="center">
                        <s-button
                          icon="chevron-up"
                          variant="tertiary"
                          accessibilityLabel={`Move ${label} up`}
                          disabled={selectionSearch.trim() !== '' || isFirst}
                          onClick={() => moveSelectionRow(row.id, -1)}
                        />
                        <s-button
                          icon="chevron-down"
                          variant="tertiary"
                          accessibilityLabel={`Move ${label} down`}
                          disabled={selectionSearch.trim() !== '' || isLast}
                          onClick={() => moveSelectionRow(row.id, 1)}
                        />
                      </s-stack>
                    </s-table-cell>
                    <s-table-cell>
                      <s-button
                        icon="x"
                        variant="tertiary"
                        accessibilityLabel={`Remove ${label}`}
                        onClick={() =>
                          row.kind === 'product'
                            ? removeFromSelectionDraft(row.id)
                            : removeNoteFromDraft(row.id)
                        }
                      />
                    </s-table-cell>
                  </s-table-row>
                );
              })
            )}
          </s-table-body>
        </s-table>
      </s-section>

      <s-modal id="selection-leave-modal" heading="Unsaved changes">
        <s-text>You have unsaved changes. Leave without saving?</s-text>
        <s-button
          slot="primary-action"
          variant="primary"
          tone="critical"
          commandFor="selection-leave-modal"
          command="--hide"
          onClick={backFromSelection}
        >
          Leave without saving
        </s-button>
        <s-button
          slot="secondary-actions"
          variant="secondary"
          commandFor="selection-leave-modal"
          command="--hide"
        >
          Stay
        </s-button>
      </s-modal>
    </s-page>
  );

  const renderMainView = () => (
    <s-page heading="Template to File" inlineSize="large">
      <s-stack slot="header-actions" direction="inline" gap="base">
        <s-button onClick={clearProductSelection}>Clear Product Selection</s-button>
        <s-button onClick={clearTemplateSelection}>Clear Template Selection</s-button>
        <s-button loading={refreshing} disabled={refreshing} onClick={refreshAll}>
          Refresh Page
        </s-button>
        {canDownload && download ? (
          <s-link
            href={download.href}
            download={download.name}
            commandFor="download-confirm-modal"
            command="--show"
            onClick={onDownloadClick}
          >
            <s-button variant="primary">Download Files</s-button>
          </s-link>
        ) : (
          <s-button variant="primary" disabled loading={preparingDownload}>
            Download Files
          </s-button>
        )}
      </s-stack>

      {downloadProgress ? (
        <s-banner tone="info" heading="Preparing your download">
          <s-stack direction="inline" gap="small" alignItems="center">
            <s-spinner accessibilityLabel="Preparing download" />
            <s-text>
              {downloadProgress.packaging
                ? 'Packaging ZIP file…'
                : `Generating file ${downloadProgress.done} of ${downloadProgress.total}…`}
            </s-text>
          </s-stack>
        </s-banner>
      ) : null}

      {downloadBuildFailed ? (
        <s-banner tone="critical" heading="Could not generate files">
          <s-text>
            The file could not be generated from the selected products and template. Try a different
            selection or template.
          </s-text>
        </s-banner>
      ) : null}

      <s-grid gridTemplateColumns="2fr 1fr" gap="base">
        <s-section padding="none">
          <s-box padding="base">
            <s-stack gap="base">
              <s-stack
                direction="inline"
                gap="base"
                justifyContent="space-between"
                alignItems="center"
              >
                <s-heading>Products</s-heading>
                <s-stack direction="inline" gap="small" alignItems="center">
                  <s-text color="subdued">{selectedProductList.length} selected</s-text>
                  <s-button icon="caret-down" commandFor="selections-menu">
                    Selections
                  </s-button>
                  {/* The Selections menu. An `s-menu` renders each button's label as a single line
                      of plain text, so a slot with a subtitle shows the subtitle as its label. */}
                  <s-menu id="selections-menu" accessibilityLabel="Product selections">
                    <s-section heading="Current">
                      <s-button onClick={() => openSelectionView('current')}>
                        Current Selection ({selectedProductList.length})
                      </s-button>
                    </s-section>
                    <s-section heading="Public">
                      {PUBLIC_SLOTS.map((slot) => (
                        <s-button key={slot} onClick={() => openSelectionView(slot)}>
                          {selectionMenuLabel(slot)}
                        </s-button>
                      ))}
                    </s-section>
                  </s-menu>
                </s-stack>
              </s-stack>
              {/* A plain text field (not a search field) is used here so long queries scroll and
                  keep the caret at the end on mobile. Autocomplete is off and the merchant can
                  submit explicitly with the Search button instead of relying on the change event. */}
              <s-grid gridTemplateColumns="1fr auto" gap="small" alignItems="end">
                <s-text-field
                  label="Search products"
                  labelAccessibilityVisibility="exclusive"
                  icon="search"
                  autocomplete="off"
                  placeholder="Search title, handle, tag, SKU, metafield…"
                  value={productSearch}
                  onInput={(e: any) => setProductSearch(e.currentTarget.value)}
                  onChange={runSearch}
                />
                <s-button onClick={runSearch}>Search</s-button>
              </s-grid>
              <s-stack
                direction="inline"
                gap="base"
                alignItems="center"
                justifyContent="space-between"
              >
                <s-stack direction="inline" gap="small" alignItems="center">
                  <s-button
                    variant={bulkActive('shown') ? 'primary' : undefined}
                    disabled={displayedProducts.length === 0}
                    onClick={() => toggleBulkSelect('shown')}
                  >
                    Select all shown
                  </s-button>
                  <s-button
                    variant={bulkActive('in-stock') ? 'primary' : undefined}
                    disabled={inStockDisplayedCount === 0}
                    onClick={() => toggleBulkSelect('in-stock')}
                  >
                    Select all in stock
                  </s-button>
                </s-stack>
                <s-stack direction="inline" gap="small" alignItems="center">
                  <s-text color="subdued">{noteObjects.length} notes</s-text>
                  <s-button
                    commandFor="note-modal"
                    command="--show"
                    onClick={() => openNoteModal('')}
                  >
                    Add Blank Note
                  </s-button>
                </s-stack>
              </s-stack>
            </s-stack>
          </s-box>

          {productError ? (
            <s-box padding="base">
              <s-banner tone="critical" heading="Could not load products">
                <s-text>{productError}</s-text>
              </s-banner>
            </s-box>
          ) : null}

          {selectionsError ? (
            <s-box padding="base">
              <s-banner tone="critical" heading="Selections">
                <s-text>{selectionsError}</s-text>
              </s-banner>
            </s-box>
          ) : null}

          {/* Thin grey pagination bar directly above the table header, so the merchant can page
              through products without scrolling to the bottom of the table. */}
          <s-box background="subdued" paddingBlock="small-300" paddingInline="small-200">
            <s-stack direction="inline" gap="small-200" alignItems="center" justifyContent="end">
              <s-button
                icon="chevron-left"
                accessibilityLabel="Previous page of products"
                disabled={!productPageInfo?.hasPreviousPage}
                onClick={handlePrevProducts}
              />
              <s-button
                icon="chevron-right"
                accessibilityLabel="Next page of products"
                disabled={!productPageInfo?.hasNextPage}
                onClick={handleNextProducts}
              />
            </s-stack>
          </s-box>

          <s-table
            paginate={Boolean(productPageInfo?.hasNextPage || productPageInfo?.hasPreviousPage)}
            loading={productsLoading}
            hasNextPage={productPageInfo?.hasNextPage || false}
            hasPreviousPage={productPageInfo?.hasPreviousPage || false}
            onNextPage={handleNextProducts}
            onPreviousPage={handlePrevProducts}
          >
            <s-table-header-row>
              <s-table-header>Select</s-table-header>
              <s-table-header listSlot="primary">Product</s-table-header>
              <s-table-header>Handle</s-table-header>
              <s-table-header>Qty</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {displayedProducts.length === 0 && !productsLoading ? (
                <s-table-row>
                  <s-table-cell>
                    <s-text color="subdued">No products found.</s-text>
                  </s-table-cell>
                  <s-table-cell />
                  <s-table-cell />
                  <s-table-cell />
                </s-table-row>
              ) : (
                displayedProducts.map((p) => {
                  // All-variant-ids fallback is computed once per row: an absent/empty
                  // selectedVariantIds entry means "every variant" (see narrowToSelectedVariants).
                  const allVariantIds = p.allVariants.map((v: VariantData) => v.id);
                  const checkedVariantIds =
                    selectedVariantIds[p.id] && selectedVariantIds[p.id].length > 0
                      ? selectedVariantIds[p.id]
                      : allVariantIds;
                  return (
                    <s-table-row key={p.id}>
                      <s-table-cell>
                        <s-checkbox
                          accessibilityLabel={`Select ${p.title}`}
                          checked={Boolean(selectedProducts[p.id])}
                          onChange={(e: any) => toggleProduct(p, e.currentTarget.checked)}
                        />
                      </s-table-cell>
                      <s-table-cell>
                        <s-stack gap="small-400">
                          <s-stack direction="inline" gap="small" alignItems="center">
                            {p.imageUrl ? (
                              <s-thumbnail size="small" src={p.imageUrl} alt={p.title} />
                            ) : null}
                            <s-text type="strong">{p.title}</s-text>
                          </s-stack>
                          {selectedProducts[p.id] ? (
                            <s-text-field
                              label={`Note for ${p.title}`}
                              labelAccessibilityVisibility="exclusive"
                              placeholder="Add a note to the selection..."
                              value={productNotes[p.id] || ''}
                              onInput={(e: any) => setProductNote(p.id, e.currentTarget.value)}
                            />
                          ) : null}
                          {selectedProducts[p.id] && p.allVariants.length > 1 ? (
                            <s-stack gap="small-200">
                              <s-text color="subdued">
                                Variants ({checkedVariantIds.length} of {p.allVariants.length}{' '}
                                selected)
                              </s-text>
                              {p.allVariants.map((v: VariantData) => (
                                <s-checkbox
                                  key={v.id}
                                  label={v.title}
                                  checked={checkedVariantIds.includes(v.id)}
                                  onChange={(e: any) =>
                                    toggleVariantChecked(
                                      p.id,
                                      allVariantIds,
                                      v.id,
                                      e.currentTarget.checked,
                                    )
                                  }
                                />
                              ))}
                            </s-stack>
                          ) : null}
                        </s-stack>
                      </s-table-cell>
                      <s-table-cell>
                        <s-text color="subdued">{p.handle}</s-text>
                      </s-table-cell>
                      <s-table-cell>
                        <s-text color="subdued">{formatQty(p.totalInventory)}</s-text>
                      </s-table-cell>
                    </s-table-row>
                  );
                })
              )}
            </s-table-body>
          </s-table>
        </s-section>

        <s-section padding="none">
          <s-box padding="base">
            <s-stack gap="base">
              <s-stack
                direction="inline"
                gap="base"
                justifyContent="space-between"
                alignItems="center"
              >
                <s-stack direction="inline" gap="small-100" alignItems="center">
                  <s-heading>Templates</s-heading>
                  <s-text color="subdued">{storageLabel}</s-text>
                </s-stack>
                <s-stack direction="inline" gap="small" alignItems="center">
                  <s-button icon="plus" accessibilityLabel="Add template" onClick={openNewTemplate}>
                    Add
                  </s-button>
                  <s-button
                    icon="sort"
                    accessibilityLabel="Sort templates"
                    commandFor="template-sort-menu"
                  >
                    Sort
                  </s-button>
                  <s-menu id="template-sort-menu" accessibilityLabel="Sort templates">
                    <s-button
                      icon={templateSort === 'new-old' ? 'check' : undefined}
                      onClick={() => setTemplateSort('new-old')}
                    >
                      New to Old
                    </s-button>
                    <s-button
                      icon={templateSort === 'old-new' ? 'check' : undefined}
                      onClick={() => setTemplateSort('old-new')}
                    >
                      Old to New
                    </s-button>
                    <s-button
                      icon={templateSort === 'a-z' ? 'check' : undefined}
                      onClick={() => setTemplateSort('a-z')}
                    >
                      A-Z
                    </s-button>
                    <s-button
                      icon={templateSort === 'z-a' ? 'check' : undefined}
                      onClick={() => setTemplateSort('z-a')}
                    >
                      Z-A
                    </s-button>
                  </s-menu>
                </s-stack>
              </s-stack>
              <s-search-field
                label="Search templates"
                labelAccessibilityVisibility="exclusive"
                placeholder="Search by title…"
                value={templateSearch}
                onInput={(e: any) => setTemplateSearch(e.currentTarget.value)}
              />
            </s-stack>
          </s-box>

          {templateError ? (
            <s-box padding="base">
              <s-banner tone="critical" heading="Template error">
                <s-text>{templateError}</s-text>
              </s-banner>
            </s-box>
          ) : null}

          {pinError ? (
            <s-box padding="base">
              <s-banner tone="critical" heading="Could not update pinned template">
                <s-text>{pinError}</s-text>
              </s-banner>
            </s-box>
          ) : null}

          <s-box padding="base">
            <s-stack gap="none">
              {templatesLoading ? (
                <s-spinner accessibilityLabel="Loading templates" />
              ) : templateGroups.list.length === 0 ? (
                <s-text color="subdued">
                  {templates.length === 0
                    ? 'No templates yet. Use Add to create one.'
                    : 'No templates match your search.'}
                </s-text>
              ) : (
                templateGroups.list.map((tpl, index) => {
                  const isSelected = tpl.id === selectedTemplateId;
                  // The separator is rendered immediately above the first unpinned template, and
                  // only when both a pinned and an unpinned group are present.
                  const showDivider = index === templateGroups.dividerIndex;
                  return [
                    showDivider ? (
                      <s-box key={`divider-${tpl.id}`} paddingBlock="small-200">
                        <s-divider />
                      </s-box>
                    ) : null,
                    <s-box
                      key={tpl.id}
                      paddingBlock="small-400"
                      paddingInline="small-200"
                      borderRadius="base"
                      background={isSelected ? 'subdued' : undefined}
                    >
                      <s-grid gridTemplateColumns="1fr auto" gap="small" alignItems="center">
                        <s-clickable
                          inlineSize="100%"
                          onClick={() => setSelectedTemplateId(tpl.id)}
                        >
                          <s-stack direction="inline" gap="small" alignItems="center">
                            <s-text type={isSelected ? 'strong' : undefined}>
                              {tpl.title || 'Untitled'}
                            </s-text>
                            <s-text color="subdued">.{sanitizeExtension(tpl.extension)}</s-text>
                          </s-stack>
                        </s-clickable>
                        <s-button
                          icon="menu-horizontal"
                          variant={tpl.pinned ? 'primary' : undefined}
                          loading={pinningId === tpl.id}
                          accessibilityLabel={`Actions for ${tpl.title}${tpl.pinned ? ' (pinned)' : ''}`}
                          commandFor={`tpl-menu-${tpl.id}`}
                        />
                        <s-menu id={`tpl-menu-${tpl.id}`} accessibilityLabel="Template actions">
                          <s-button icon="edit" onClick={() => openEditTemplate(tpl)}>
                            Edit template
                          </s-button>
                          <s-button
                            icon={tpl.pinned ? 'pin-remove' : 'pin'}
                            onClick={() => togglePin(tpl)}
                          >
                            {tpl.pinned ? 'Unpin template' : 'Pin template'}
                          </s-button>
                          <s-button
                            icon="delete"
                            tone="critical"
                            commandFor="delete-template-modal"
                            onClick={() => openDeleteModal(tpl.id)}
                          >
                            Delete template
                          </s-button>
                        </s-menu>
                      </s-grid>
                    </s-box>,
                  ];
                })
              )}
            </s-stack>
          </s-box>
        </s-section>
      </s-grid>

      <s-modal id="note-modal" heading="New note">
        <s-stack gap="small">
          <s-text-area
            label="Note"
            value={noteDraftText}
            rows={6}
            placeholder="Type your note…"
            onInput={(e: any) => setNoteDraftText(e.currentTarget.value)}
          />
          {/* Lives in the modal BODY, not the secondary-actions footer slot: that slot only
              accepts button components with variant "secondary" or "auto" (per the s-modal
              reference), so a third, lower-emphasis "tertiary" button placed there was an
              invalid child -- and, being slotted ahead of Discard, prevented Discard from
              rendering at all. Clearing the draft without closing the modal doesn't need to be
              a footer action anyway. */}
          <s-button variant="tertiary" onClick={discardNoteDraft}>
            Clear note
          </s-button>
        </s-stack>
        <s-button
          slot="primary-action"
          variant="primary"
          commandFor="note-modal"
          command="--hide"
          onClick={saveNoteEntry}
        >
          Save
        </s-button>
        <s-button
          slot="secondary-actions"
          variant="secondary"
          disabled={productSearch.trim() === ''}
          onClick={appendSearchToNote}
        >
          Add search query
        </s-button>
        <s-button
          slot="secondary-actions"
          variant="secondary"
          commandFor="note-modal"
          command="--hide"
          onClick={discardNoteDraft}
        >
          Discard
        </s-button>
      </s-modal>

      <s-modal id="download-confirm-modal" heading="Download started">
        <s-text>{confirmedName} has been downloaded to your computer.</s-text>
        <s-button
          slot="primary-action"
          variant="primary"
          commandFor="download-confirm-modal"
          command="--hide"
        >
          Close
        </s-button>
      </s-modal>

      <s-modal id="delete-template-modal" heading="Delete template?">
        <s-stack gap="base">
          {deleteError ? (
            <s-banner tone="critical" heading="Could not delete template">
              <s-text>{deleteError}</s-text>
            </s-banner>
          ) : null}
          <s-text>This template will be permanently removed and cannot be recovered.</s-text>
        </s-stack>
        <s-button
          slot="primary-action"
          variant="primary"
          tone="critical"
          loading={deleting}
          onClick={confirmDelete}
        >
          Delete template
        </s-button>
        <s-button
          slot="secondary-actions"
          variant="secondary"
          commandFor="delete-template-modal"
          command="--hide"
          onClick={cancelDelete}
        >
          Cancel
        </s-button>
      </s-modal>
    </s-page>
  );
  if (view === 'editor') return renderEditorView();
  if (view === 'selection' && selectionSlot) return renderSelectionView();
  return renderMainView();
}

export default (): void => render(<Extension />, document.body);

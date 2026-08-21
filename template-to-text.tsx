import { render } from 'preact';
import { useState, useEffect, useMemo, useRef } from 'preact/hooks';

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

// A free-text note that lives INSIDE a selection alongside its products. It is not a Shopify
// resource and is never written to a product. The `type` discriminator, stable `id`, and metadata
// are stored so note objects can later be iterated in template logic (foreach loops, expressions)
// without migrating any stored data.
interface NoteObject {
  type: 'note';
  id: string;
  content: string;
  createdAt: number;
  source: 'manual' | 'search';
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
  // own metafield. Exposed to templates as {{ product.notes }} (alias: {{ products.notes }}).
  note: string;
}

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
    ).join('\n    ')}
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

// One stored entry of a saved selection: the product gid plus the note typed for it in that
// selection. A legacy stored value that is a plain array of gid strings loads with an empty note.
interface SelectionEntry {
  id: string;
  note: string;
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

const PUBLIC_SLOTS: SelectionSlotId[] = [
  'public_1',
  'public_2',
  'public_3',
  'public_4',
  'public_5',
  'public_6',
];
const SAVED_SLOTS: SelectionSlotId[] = [...PUBLIC_SLOTS];

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

// Parse a stored selection metafield value into an ordered list of { id, note } PRODUCT entries.
// Both the current object format and the legacy plain array of gid strings are accepted; a legacy
// value loads with an empty note for every product. Note-object entries (type === 'note') are
// skipped here and read by parseSelectionNotes instead. A missing, empty, or unparseable value
// yields an empty list.
function parseSelectionEntries(rawValue: any): SelectionEntry[] {
  if (rawValue == null || rawValue === '') return [];
  try {
    const parsed = JSON.parse(rawValue);
    if (!Array.isArray(parsed)) return [];
    const entries: SelectionEntry[] = [];
    for (const item of parsed) {
      if (typeof item === 'string') {
        entries.push({ id: item, note: '' });
      } else if (item && item.type === 'note') {
        continue;
      } else if (item && typeof item.id === 'string') {
        entries.push({ id: item.id, note: typeof item.note === 'string' ? item.note : '' });
      }
    }
    return entries;
  } catch {
    return [];
  }
}

// Generate a stable id for a new note object.
function generateNoteId(): string {
  return `note-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// Build a new note object from typed text. `source` records whether the note was typed from scratch
// or pre-filled from the product search box.
function createNoteObject(content: string, source: 'manual' | 'search'): NoteObject {
  return { type: 'note', id: generateNoteId(), content, createdAt: Date.now(), source };
}

// Parse the NOTE-OBJECT entries out of a stored selection metafield value. An entry is a note when
// it carries `type: "note"` and a string `content`; anything else (including a corrupt note entry)
// is skipped so it can never break the selection.
function parseSelectionNotes(rawValue: any): NoteObject[] {
  if (rawValue == null || rawValue === '') return [];
  try {
    const parsed = JSON.parse(rawValue);
    if (!Array.isArray(parsed)) return [];
    const notes: NoteObject[] = [];
    for (const item of parsed) {
      if (!item || item.type !== 'note' || typeof item.content !== 'string') continue;
      notes.push({
        type: 'note',
        id: typeof item.id === 'string' && item.id ? item.id : generateNoteId(),
        content: item.content,
        createdAt:
          typeof item.createdAt === 'number' && Number.isFinite(item.createdAt)
            ? item.createdAt
            : Date.now(),
        source: item.source === 'search' ? 'search' : 'manual',
      });
    }
    return notes;
  } catch {
    return [];
  }
}

// Whether a note object's text matches a search term (case-insensitive substring).
function noteMatchesQuery(note: NoteObject, rawQuery: string): boolean {
  const query = rawQuery.trim().toLowerCase();
  if (query === '') return true;
  return (note.content || '').toLowerCase().includes(query);
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

// Generate a stable id for a template from its title plus a time/random suffix. Used as the React
// key and selection id, and to match templates within the stored JSON array. Never changes once set.
function generateTemplateId(title: string): string {
  const random = Math.random().toString(36).slice(2, 8);
  return `${slugify(title)}-${Date.now().toString(36)}-${random}`;
}

// Map one raw entry from the stored JSON array into a TemplateData, defaulting missing fields and
// generating an id when absent. JSON parsing already yields real newline characters, so no extra
// newline unescaping is needed.
function mapStoredTemplate(entry: any): TemplateData {
  const title = typeof entry?.title === 'string' ? entry.title : '';
  return {
    id: typeof entry?.id === 'string' && entry.id ? entry.id : generateTemplateId(title),
    title,
    body: typeof entry?.body === 'string' ? entry.body : '',
    extension: typeof entry?.extension === 'string' ? entry.extension : '',
    pinned: entry?.pinned === true,
    pinnedAt:
      typeof entry?.pinnedAt === 'number' && Number.isFinite(entry.pinnedAt)
        ? entry.pinnedAt
        : null,
  };
}

// Serialize a template list into the JSON string stored in a shard metafield.
function serializeTemplates(list: TemplateData[]): string {
  return JSON.stringify(
    list.map((t) => ({
      id: t.id,
      title: t.title,
      body: t.body,
      extension: t.extension,
      pinned: t.pinned === true,
      // An unpinned template never carries a stale timestamp.
      pinnedAt: t.pinned === true ? (t.pinnedAt ?? null) : null,
    })),
  );
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
function packTemplatesIntoShards(list: TemplateData[]): {
  shards: TemplateData[][];
  overflow: boolean;
} {
  const shards: TemplateData[][] = [];
  for (let s = 0; s < SHARD_COUNT; s++) {
    shards.push([]);
  }
  let shardIndex = 0;
  let overflow = false;
  for (const template of list) {
    while (shardIndex < SHARD_COUNT) {
      const candidate = [...shards[shardIndex], template];
      if (byteLength(serializeTemplates(candidate)) <= SHARD_MAX_BYTES) {
        shards[shardIndex] = candidate;
        break;
      }
      // This template doesn't fit in the current shard. If the shard is empty, the single template
      // itself exceeds the cap and can never fit -- treat as overflow. Otherwise move to next shard.
      if (shards[shardIndex].length === 0) {
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

const PRODUCT_FIELD_TOKENS: { token: string; label: string }[] = [
  { token: '{{ product.title }}', label: 'Product title' },
  { token: '{{ product.handle }}', label: 'Product handle' },
  { token: '{{ product.vendor }}', label: 'Product vendor' },
  { token: '{{ product.productType }}', label: 'Product type' },
  { token: '{{ product.status }}', label: 'Product status' },
  { token: '{{ product.description }}', label: 'Product description' },
  { token: '{{ product.tags }}', label: 'Product tags' },
  { token: '{{ product.totalInventory }}', label: 'Total inventory' },
  { token: '{{ product.priceMin }}', label: 'Min price' },
  { token: '{{ product.priceMax }}', label: 'Max price' },
  { token: '{{ product.compareAtPrice }}', label: 'Compare at price' },
  { token: '{{ product.costPerItem }}', label: 'Cost per item' },
  { token: '{{ product.currencyCode }}', label: 'Currency code' },
  { token: '{{ product.createdAt }}', label: 'Created at' },
  { token: '{{ product.updatedAt }}', label: 'Updated at' },
  { token: '{{ product.notes }}', label: 'Product note' },
];

const VARIANT_FIELD_TOKENS: { token: string; label: string }[] = [
  { token: '{{ variant.title }}', label: 'Variant title' },
  { token: '{{ variant.sku }}', label: 'Variant SKU' },
  { token: '{{ variant.price }}', label: 'Variant price' },
  { token: '{{ variant.compareAtPrice }}', label: 'Variant compare at price' },
  { token: '{{ variant.costPerItem }}', label: 'Variant cost per item' },
  { token: '{{ variant.barcode }}', label: 'Variant barcode' },
  { token: '{{ variant.inventoryQuantity }}', label: 'Variant inventory' },
];

const FOREACH_BLOCK =
  '{{#selection.foreach product, i=0}}\n{{ product.title }} , {{ product.handle }}\n{{/selection.foreach product}}';

// Snippet inserted by the "If block" menu option. The condition defaults to {{ =0 }} (which resolves
// to the number 0, i.e. FALSE) so the author can replace it with their own boolean expression.
const IF_BLOCK = '{{ #if={{ =0 }} }}\n{{ /if }}';

// Snippet inserted by the "Chop block" menu option. Keeps the characters iterated over BEFORE the
// condition first becomes true; `direction` picks which end the walk starts from and `j` is the
// starting value of the step counter exposed as {{ j }} inside the condition.
const CHOP_BLOCK = '{{ #chop={{ {{j}}==3 }}, direction=L, j=1 }}\n{{/chop}}';

// Snippet inserted by the "String length" menu option: renders the character count of its argument.
const LENGTH_TOKEN = '{{ length={{ product.title }} }}';

// Snippet inserted by the "Repeat block" menu option: outputs its inner content N times, joined by
// the delineator (empty by default).
const REPEAT_BLOCK = '{{ #repeat=2, delineator= }}\n{{/repeat}}';

// Snippet inserted by the "While loop" menu option: a bounded counting loop that does not step
// through the product selection. It MUST be closed with {{/while}}.
const WHILE_BLOCK = '{{ while=TRUE, {{ k }} = 1<5 }}\n{{/while}}';

// Snippet inserted by the "Index" menu option: returns a single character of its inner content.
const INDEX_BLOCK = '{{ #index=0 }}\n{{/index}}';

// Snippet inserted by the "Insert block" menu option: splices its inner content into the surrounding
// rendered output at a character position relative to the block.
const INSERT_BLOCK = '{{ #insert=0, drop=FALSE }}\n{{/insert}}';

// Snippet inserted by the "Variant foreach" menu option: steps through the current product's variants.
const VARIANT_LOOP_BLOCK =
  '{{ #product.foreach, l=0, tied=TRUE }}\n{{ variant.title }}\n{{/product.foreach}}';

// Snippet inserted by the "Boolean equation" menu option.
const BOOLEAN_TOKEN = '{{ TRUE != FALSE }}';

// Hard safety cap on while-loop iterations, on top of the required MIN/MAX bounds.
const MAX_WHILE_ITERATIONS = 10000;

// Abbreviated weekday names indexed by Date.getDay() (0 = Sunday).
const WEEKDAY_ABBR = ['sun', 'mon', 'tues', 'wed', 'thurs', 'fri', 'sat'];
// Abbreviated month names indexed by Date.getMonth() (0 = January).
const MONTH_ABBR = [
  'jan',
  'feb',
  'mar',
  'apr',
  'may',
  'june',
  'july',
  'aug',
  'sept',
  'oct',
  'nov',
  'dec',
];

// Precomputed date-token string values, derived once per download from a single Date so every file
// in one download shares the same date. `day`/`month` are zero-padded to two digits.
interface DateParts {
  day: string;
  dayWeek: string;
  month: string;
  monthName: string;
  year: string;
  yearShort: string;
}

function computeDateParts(date: Date): DateParts {
  const pad = (n: number): string => String(n).padStart(2, '0');
  const fullYear = date.getFullYear();
  return {
    day: pad(date.getDate()),
    dayWeek: WEEKDAY_ABBR[date.getDay()],
    month: pad(date.getMonth() + 1),
    monthName: MONTH_ABBR[date.getMonth()],
    year: String(fullYear),
    yearShort: String(fullYear).slice(-2),
  };
}

const WRAP_BLOCK = '{{#wrap=80, min_wraps=0, max_wraps=0, hard=FALSE, delineator=}}\n{{/wrap}}';

const COMMENT_BLOCK = '{{ #comment }}\n\n{{ /comment }}';

// Remove every {{ #comment }} ... {{ /comment }} block (tags and inner content, across newlines) so
// comments never appear in generated output. Applied as the FIRST evaluation step. Uses a global,
// non-greedy regex so multiple comment blocks are all removed and an unclosed opening tag is left inert.
const COMMENT_REGEX = /\{\{\s*#comment\s*\}\}[\s\S]*?\{\{\s*\/comment\s*\}\}/g;

function stripComments(body: string): string {
  return body.replace(COMMENT_REGEX, '');
}

// Whitespace tokens: `{{ \n }}` (literal backslash-n between the braces) resolves to a real newline
// and `{{ \t }}` (literal backslash-t) resolves to a single space character. Both are leading/
// trailing whitespace agnostic between the braces. This runs as the FIRST compiler pass so the
// resulting whitespace is present for every later pass and survives trimming that would otherwise
// strip surrounding whitespace (e.g. inside a wrap `delineator=` value).
// The single backslash character, built via char code so it survives source formatting untouched.
const BACKSLASH = String.fromCharCode(92);
// Regex pattern strings for the literal tokens `{{ \n }}` and `{{ \t }}`. Built from BACKSLASH so no
// literal backslash escapes appear in the source. `WS` matches optional whitespace between braces so
// the tokens are leading/trailing whitespace agnostic (e.g. `{{ \n }}`, `{{\n}}`, `{{  \n  }}`).
const WS = BACKSLASH + 's*';
const OPEN = BACKSLASH + '{' + BACKSLASH + '{';
const CLOSE = BACKSLASH + '}' + BACKSLASH + '}';
const NEWLINE_TOKEN_PATTERN = OPEN + WS + BACKSLASH + BACKSLASH + 'n' + WS + CLOSE;
const SPACE_TOKEN_PATTERN = OPEN + WS + BACKSLASH + BACKSLASH + 't' + WS + CLOSE;
// Interchangeable aliases: `{{ /return }}` behaves exactly like `{{ \n }}` and `{{ /space }}` behaves
// exactly like `{{ \t }}`. Both are leading/trailing whitespace agnostic between the braces.
const RETURN_TOKEN_PATTERN = OPEN + WS + '/return' + WS + CLOSE;
const SPACE_ALIAS_TOKEN_PATTERN = OPEN + WS + '/space' + WS + CLOSE;

// The literal menu snippets inserted for the New line / Space options: the text `{{ \n }}` and
// `{{ \t }}` with a real backslash. Built from BACKSLASH so source formatting cannot alter them.
const NEWLINE_TOKEN_SNIPPET = '{{ ' + BACKSLASH + 'n }}';
const SPACE_TOKEN_SNIPPET = '{{ ' + BACKSLASH + 't }}';

// Non-whitespace, non-brace placeholder characters that stand in for a token-produced newline / space
// during compilation. Control chars (U+0001 / U+0002) never appear in real templates or product data,
// and crucially they are NOT matched by \s, so they survive every whitespace trim (including the wrap
// tag's `delineator=` trimming) and are only turned into real whitespace at the very end.
const NEWLINE_SENTINEL = String.fromCharCode(1);
const SPACE_SENTINEL = String.fromCharCode(2);

function applyWhitespaceTokens(body: string): string {
  // Encode `{{ \n }}` / `{{ \t }}` as sentinels. Runs as the FIRST compiler pass so the sentinels are
  // present for every later pass. Because sentinels are not whitespace, token-produced whitespace is
  // never eaten by trimming -- so the tokens work anywhere, including at the edge of a wrap delineator,
  // while genuinely typed whitespace stays trim-able (agnostic). The tokens themselves are
  // leading/trailing whitespace agnostic inside the braces (`{{ \n }}`, `{{\n}}`, `{{  \n  }}`).
  const newlineToken = new RegExp(NEWLINE_TOKEN_PATTERN, 'g');
  const returnToken = new RegExp(RETURN_TOKEN_PATTERN, 'g');
  const spaceToken = new RegExp(SPACE_TOKEN_PATTERN, 'g');
  const spaceAliasToken = new RegExp(SPACE_ALIAS_TOKEN_PATTERN, 'g');
  return body
    .replace(newlineToken, NEWLINE_SENTINEL)
    .replace(returnToken, NEWLINE_SENTINEL)
    .replace(spaceToken, SPACE_SENTINEL)
    .replace(spaceAliasToken, SPACE_SENTINEL);
}

function restoreWhitespaceTokens(text: string): string {
  // Turn the whitespace sentinels back into real characters. Runs as the LAST step, after wrapping,
  // so nothing downstream can strip them.
  return text.split(NEWLINE_SENTINEL).join(String.fromCharCode(10)).split(SPACE_SENTINEL).join(' ');
}

function productFieldValue(product: ProductData, field: string): string {
  switch (field) {
    case 'title':
      return product.title;
    case 'handle':
      return product.handle;
    case 'vendor':
      return product.vendor;
    case 'productType':
    case 'product_type':
      return product.productType;
    case 'status':
      return product.status;
    case 'description':
      return product.description;
    case 'tags':
      return product.tags.join(', ');
    case 'totalInventory':
      return product.totalInventory == null ? '' : String(product.totalInventory);
    case 'priceMin':
      return product.priceMin;
    case 'priceMax':
      return product.priceMax;
    // Compare at price and cost per item live on the variant; at product level they resolve against
    // the row's ACTIVE variant (the product's first variant outside a variant loop).
    case 'compareAtPrice':
      return product.variants[0]?.compareAtPrice || '';
    case 'costPerItem':
      return product.variants[0]?.costPerItem || '';
    case 'currencyCode':
      return product.currencyCode;
    case 'createdAt':
      return product.createdAt;
    case 'updatedAt':
      return product.updatedAt;
    case 'note':
    case 'notes':
      return product.note || '';
    default:
      return '';
  }
}

function variantFieldValue(variant: VariantData | undefined, field: string): string {
  if (!variant) return '';
  switch (field) {
    case 'title':
      return variant.title;
    case 'sku':
      return variant.sku || '';
    case 'price':
      return variant.price || '';
    case 'compareAtPrice':
      return variant.compareAtPrice || '';
    case 'costPerItem':
      return variant.costPerItem || '';
    case 'barcode':
      return variant.barcode || '';
    case 'inventoryQuantity':
      return variant.inventoryQuantity == null ? '' : String(variant.inventoryQuantity);
    default:
      return '';
  }
}

function metafieldValue(product: ProductData, namespace: string, key: string): string {
  const mf = product.metafields.find((m) => m.namespace === namespace && m.key === key);
  return mf ? mf.value || '' : '';
}

// Per-render evaluation context: the current loop counter value (`i`), the total number of products
// the merchant selected (`selectionLength`), the shop's primary domain host (`primaryDomain`), and
// the precomputed date-token values (`date`). Threaded through token substitution and math evaluation
// so `{{ i }}`, `{{ selection.length }}`, `{{ primaryDomain }}`, date tokens, and equations can all
// read these values.
interface EvalContext {
  selectionLength: number;
  primaryDomain: string;
  date: DateParts;
  // The shared, MUTABLE variable store for this file render. Every variable (i, j, k, l, x, y, z plus
  // any counter name bound by a while loop) lives here as a string and defaults to EMPTY. Loops and
  // `{{ x = ... }}` assignments write to this same object, so a value written inside a nested loop
  // stays visible to the enclosing loop's next iteration.
  vars: Record<string, string>;
}

// The variable names offered in the Variables menu. Variables are NOT limited to these seven: any
// identifier that is not a reserved tag keyword can be read with `{{ name }}`, written with
// `{{ name = VALUE }}`, and used as the counter of a foreach / variant foreach / chop / while block.
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
  // Number of variants on the product (always the FULL variant list, even inside a row clone).
  if (parts.length === 2 && parts[0] === 'product' && parts[1] === 'length') {
    const list =
      product.allVariants && product.allVariants.length > 0
        ? product.allVariants
        : product.variants;
    return String(list ? list.length : 0);
  }
  // Backward-compatible alias {{ products.notes }} for the primary token {{ product.notes }} (the
  // primary form, plus {{ product.note }}, is handled by productFieldValue below).
  if (parts.length === 2 && parts[0] === 'products' && parts[1] === 'notes') {
    return product.note || '';
  }
  if (parts.length === 1 && parts[0] === 'primaryDomain') {
    return ctx.primaryDomain;
  }
  if (parts.length === 1 && parts[0] === 'day') {
    return ctx.date.day;
  }
  if (parts.length === 2 && parts[0] === 'day' && parts[1] === 'week') {
    return ctx.date.dayWeek;
  }
  if (parts.length === 1 && parts[0] === 'month') {
    return ctx.date.month;
  }
  if (parts.length === 2 && parts[0] === 'month' && parts[1] === 'name') {
    return ctx.date.monthName;
  }
  if (parts.length === 1 && parts[0] === 'year') {
    return ctx.date.year;
  }
  if (parts.length === 2 && parts[0] === 'year' && parts[1] === 'short') {
    return ctx.date.yearShort;
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
  return resolveOnProduct(product, parts, ctx);
}

// Tag keywords that may never be used as a variable name, so tokens such as `{{ length=... }}` keep
// their own meaning instead of being read as an assignment.
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
]);

const IDENTIFIER_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ASSIGNMENT_REGEX = /^([A-Za-z_][A-Za-z0-9_]*)\s*=(?!=)/;
const LENGTH_PREFIX_REGEX = /^length\s*=/;

// Index of the first `=` that sits outside any {{ }} group and is not part of a comparison operator
// (==, !=, <=, >=). Returns -1 when there is none.
function topLevelEqualsIndex(text: string): number {
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
    if (depth === 0 && text[i] === '=') {
      const prev = i > 0 ? text[i - 1] : '';
      const next = text[i + 1] || '';
      if (next !== '=' && prev !== '=' && prev !== '!' && prev !== '<' && prev !== '>') {
        return i;
      }
    }
    i += 1;
  }
  return -1;
}

// Index of the first `<` that sits outside any {{ }} group, used to split a loop counter value into
// its START and MAX (chunk size) parts. Returns -1 when there is none.
function topLevelLessThanIndex(text: string): number {
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
    if (depth === 0 && text[i] === '<') {
      return i;
    }
    i += 1;
  }
  return -1;
}

// Whether the token text contains a comparison or logical operator at brace depth 0, which makes it
// a BOOLEAN expression token (rendered as TRUE / FALSE) rather than a plain field token.
function hasBooleanOperator(text: string): boolean {
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
    if (depth === 0) {
      const two = text.slice(i, i + 2);
      if (
        two === '==' ||
        two === '!=' ||
        two === '<=' ||
        two === '>=' ||
        two === '&&' ||
        two === '||'
      ) {
        return true;
      }
      if (text[i] === '<' || text[i] === '>') {
        return true;
      }
    }
    i += 1;
  }
  return false;
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
  // Math equation {{ =EXPR }}.
  if (trimmed[0] === '=') {
    const expression = renderTemplateText(trimmed.slice(1), product, allProducts, ctx, true);
    try {
      const value = evaluateMathExpression(expression);
      if (Number.isFinite(value)) {
        return String(value);
      }
    } catch {
      // Fall through to the empty / zero result below.
    }
    return numeric ? '0' : '';
  }
  // Character count {{ length=STRING }}.
  const lengthMatch = trimmed.match(LENGTH_PREFIX_REGEX);
  if (lengthMatch) {
    const argument = renderTemplateText(
      trimmed.slice(lengthMatch[0].length),
      product,
      allProducts,
      ctx,
      false,
    );
    return String(Array.from(argument.trim()).length);
  }
  // Variable assignment {{ name = VALUE }}: writes the shared store and renders nothing.
  const assignmentMatch = trimmed.match(ASSIGNMENT_REGEX);
  if (assignmentMatch && !RESERVED_ASSIGNMENT_NAMES.has(assignmentMatch[1].toLowerCase())) {
    const value = renderTemplateText(
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
    const resolved = renderTemplateText(trimmed, product, allProducts, ctx, false);
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

// --- Arithmetic expression evaluator ---------------------------------------------------------
// A self-contained tokenizer + recursive-descent parser used for {{ =EXPR }} equations. It supports
// + - * / % ^ (exponentiation, right-associative), unary minus, and parentheses. JavaScript `eval`
// is intentionally NOT used so that `^` means exponentiation rather than bitwise XOR. Throws on any
// malformed input so callers can catch and render an empty string.
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

  // power := primary ('^' power)?  (right-associative)
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
interface ChopMatch {
  params: string;
  inner: string;
  blockStart: number;
  blockEnd: number;
}

function findChopBlock(body: string, fromIndex: number): ChopMatch | null {
  const openRegex = /\{\{\s*#(?:chop|trim)=/g;
  openRegex.lastIndex = fromIndex;
  const openMatch = openRegex.exec(body);
  if (!openMatch) return null;
  const blockStart = openMatch.index;
  const openTagEnd = findMatchingClose(body, blockStart);
  if (openTagEnd === -1) return null;
  const params = body.slice(openMatch.index + openMatch[0].length, openTagEnd - 2);
  const scanRegex = /\{\{\s*#(?:chop|trim)=|\{\{\s*\/(?:chop|trim)\s*\}\}/g;
  scanRegex.lastIndex = openTagEnd;
  let depth = 0;
  let scan: RegExpExecArray | null;
  while ((scan = scanRegex.exec(body)) !== null) {
    const isOpen = scan[0].indexOf('#') !== -1;
    if (isOpen) {
      depth += 1;
      continue;
    }
    if (depth === 0) {
      return {
        params,
        inner: body.slice(openTagEnd, scan.index),
        blockStart,
        blockEnd: scan.index + scan[0].length,
      };
    }
    depth -= 1;
  }
  return null;
}

// Split a chop parameter string on commas that sit outside any {{ }} group, so a condition may
// contain commas inside nested tokens.
function splitTopLevelCommas(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let last = 0;
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
    if (text[i] === ',' && depth === 0) {
      parts.push(text.slice(last, i));
      i += 1;
      last = i;
      continue;
    }
    i += 1;
  }
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
    if (matchBraceGroup(expr, 0) !== expr.length) break;
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
  const resolved = renderTemplateText(condition, product, allProducts, ctx, false);
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

function findTaggedBlock(
  body: string,
  fromIndex: number,
  openSource: string,
  closeSource: string,
): TaggedBlock | null {
  const openRegex = new RegExp(openSource, 'g');
  openRegex.lastIndex = fromIndex;
  const openMatch = openRegex.exec(body);
  if (!openMatch) return null;
  const blockStart = openMatch.index;
  const openTagEnd = findMatchingClose(body, blockStart);
  if (openTagEnd === -1) return null;
  const params = body.slice(blockStart + openMatch[0].length, openTagEnd - 2);
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

const REPEAT_OPEN_SOURCE = '\{\{\s*#repeat=';
const REPEAT_CLOSE_SOURCE = '\{\{\s*\/repeat\s*\}\}';
// A while loop MUST open with `while=` and close with `{{/while}}`; `{{/for}}` is not accepted.
const WHILE_OPEN_SOURCE = '\{\{\s*while=';
const WHILE_CLOSE_SOURCE = '\{\{\s*\/while\s*\}\}';
const INDEX_OPEN_SOURCE = '\{\{\s*#index=';
const INDEX_CLOSE_SOURCE = '\{\{\s*\/index\s*\}\}';

function findRepeatBlock(body: string, fromIndex: number): TaggedBlock | null {
  return findTaggedBlock(body, fromIndex, REPEAT_OPEN_SOURCE, REPEAT_CLOSE_SOURCE);
}

function findWhileBlock(body: string, fromIndex: number): TaggedBlock | null {
  return findTaggedBlock(body, fromIndex, WHILE_OPEN_SOURCE, WHILE_CLOSE_SOURCE);
}

function findIndexBlock(body: string, fromIndex: number): TaggedBlock | null {
  return findTaggedBlock(body, fromIndex, INDEX_OPEN_SOURCE, INDEX_CLOSE_SOURCE);
}

const INSERT_OPEN_SOURCE = '\{\{\s*#insert=';
const INSERT_CLOSE_SOURCE = '\{\{\s*\/insert\s*\}\}';
const VARIANT_LOOP_OPEN_SOURCE = '\{\{\s*#product\.foreach';
const VARIANT_LOOP_CLOSE_SOURCE = '\{\{\s*\/product\.foreach\s*\}\}';

function findInsertBlock(body: string, fromIndex: number): TaggedBlock | null {
  return findTaggedBlock(body, fromIndex, INSERT_OPEN_SOURCE, INSERT_CLOSE_SOURCE);
}

function findVariantLoopBlock(body: string, fromIndex: number): TaggedBlock | null {
  return findTaggedBlock(body, fromIndex, VARIANT_LOOP_OPEN_SOURCE, VARIANT_LOOP_CLOSE_SOURCE);
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

// Parse the variant foreach parameters: `l=<START>` (counter start, default 0) and `tied=TRUE|FALSE`
// (TRUE unless the literal FALSE is given).
function parseVariantLoopParams(
  rawParams: string,
  product: ProductData,
  allProducts: ProductData[],
  ctx: EvalContext,
): { start: number; tied: boolean; name: string } {
  const segments = splitTopLevelCommas(rawParams);
  let start = 0;
  let tied = true;
  let name = 'l';
  for (const segment of segments) {
    const eqIndex = segment.indexOf('=');
    if (eqIndex === -1) continue;
    const key = segment.slice(0, eqIndex).trim();
    const value = segment.slice(eqIndex + 1).trim();
    if (key.toLowerCase() === 'tied') {
      tied = value.toUpperCase() !== 'FALSE';
    } else if (isVariableName(key)) {
      // Any variable may be the variant counter; `l` is only the default name.
      name = key;
      const resolved = resolveExprToNumber(value, product, allProducts, ctx);
      start = resolved == null ? 0 : Math.round(resolved);
    }
  }
  return { start, tied, name };
}

// Render a variant foreach block. A TIED loop iterates the product's FULL variant list inline; an
// UNTIED loop renders only the current row's variant, because untied output is split into one file
// per variant by buildOutputFiles. Each iteration renders the inner content against a product clone
// whose active variant is the iterated one, with `{{ l }}` bound to the counter.
function applyVariantLoop(
  inner: string,
  params: { start: number; tied: boolean; name: string },
  product: ProductData,
  allProducts: ProductData[],
  ctx: EvalContext,
): string {
  const fullList =
    product.allVariants && product.allVariants.length > 0 ? product.allVariants : product.variants;
  const iterated = params.tied ? fullList : product.variants;
  if (!iterated || iterated.length === 0) {
    ctx.vars[params.name] = String(params.start);
    return renderTokens(inner, product, allProducts, ctx);
  }
  return iterated
    .map((variant, index) => {
      // First iteration takes the declared start value; every later iteration performs
      // `name = name + 1` against the CURRENT stored value, so counts carry across nested loops.
      const value = index === 0 ? params.start : readVarNumber(ctx.vars, params.name) + 1;
      ctx.vars[params.name] = String(value);
      return renderTokens(inner, { ...product, variants: [variant] }, allProducts, ctx);
    })
    .join('');
}

// Whether the body contains a variant foreach declared with `tied=FALSE`, which forces one output
// file per variant.
function hasUntiedVariantLoop(body: string): boolean {
  const cleaned = stripComments(body);
  let cursor = 0;
  while (cursor < cleaned.length) {
    const block = findVariantLoopBlock(cleaned, cursor);
    if (!block) return false;
    if (/tied\s*=\s*FALSE/i.test(block.params)) return true;
    cursor = block.blockEnd;
  }
  return false;
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

// Parse the while tag parameters: `BOOLEAN, {{ k }} = MIN<MAX`. The condition is the first top-level
// comma segment (outer grouping braces stripped); the rest is the counter assignment. Returns null
// when the counter name or either bound is missing/unparseable, or when MIN > MAX.
function parseWhileParams(
  rawParams: string,
  product: ProductData,
  allProducts: ProductData[],
  ctx: EvalContext,
): { condition: string; name: string; min: number; max: number } | null {
  const segments = splitTopLevelCommas(rawParams);
  if (segments.length < 2) return null;
  const condition = unwrapChopCondition(segments[0] || '');
  const assignment = segments.slice(1).join(',');
  // Find the assignment `=` that sits outside any {{ }} group.
  let depth = 0;
  let eqIndex = -1;
  for (let i = 0; i < assignment.length; i++) {
    if (assignment[i] === '{' && assignment[i + 1] === '{') {
      depth += 1;
      i += 1;
      continue;
    }
    if (assignment[i] === '}' && assignment[i + 1] === '}') {
      if (depth > 0) depth -= 1;
      i += 1;
      continue;
    }
    if (assignment[i] === '=' && depth === 0) {
      eqIndex = i;
      break;
    }
  }
  if (eqIndex === -1) return null;
  const nameRaw = assignment.slice(0, eqIndex).trim().replace(/^\{\{/, '').replace(/\}\}$/, '');
  const name = nameRaw.trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return null;
  const boundsRaw = assignment.slice(eqIndex + 1);
  const ltIndex = boundsRaw.indexOf('<');
  if (ltIndex === -1) return null;
  const minValue = resolveExprToNumber(boundsRaw.slice(0, ltIndex), product, allProducts, ctx);
  const maxValue = resolveExprToNumber(boundsRaw.slice(ltIndex + 1), product, allProducts, ctx);
  if (minValue == null || maxValue == null) return null;
  const min = Math.round(minValue);
  const max = Math.round(maxValue);
  if (min > max) return null;
  return { condition, name, min, max };
}

// Run a while loop: the counter starts at min and a step runs only while the counter is STRICTLY
// less than max (capped at MAX_WHILE_ITERATIONS) AND the condition is TRUE. The condition is
// re-evaluated before each step with the counter bound (an empty condition is treated as TRUE); a
// FALSE condition means that step does not evaluate and the loop ends. Each iteration renders the
// inner content through the full pipeline. The loop never steps through the product selection, so
// the same product/context is used every iteration.
function applyWhileLoop(
  inner: string,
  params: { condition: string; name: string; min: number; max: number },
  product: ProductData,
  allProducts: ProductData[],
  ctx: EvalContext,
): string {
  const steps = Math.min(params.max - params.min, MAX_WHILE_ITERATIONS);
  let output = '';
  for (let step = 0; step < steps; step++) {
    ctx.vars[params.name] = String(params.min + step);
    if (
      params.condition.trim() !== '' &&
      !conditionIsTrue(params.condition, product, allProducts, ctx)
    ) {
      break;
    }
    output += renderTokens(inner, product, allProducts, ctx);
  }
  return output;
}

// Locate the next chop / repeat / index / while block at or after `fromIndex`, whichever starts
// earliest.
type RenderBlockKind = 'chop' | 'repeat' | 'index' | 'insert' | 'variants' | 'while';

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
  const indexBlock = findIndexBlock(body, fromIndex);
  if (indexBlock) candidates.push({ ...indexBlock, kind: 'index' });
  const insertBlock = findInsertBlock(body, fromIndex);
  if (insertBlock) candidates.push({ ...insertBlock, kind: 'insert' });
  const variantLoop = findVariantLoopBlock(body, fromIndex);
  if (variantLoop) candidates.push({ ...variantLoop, kind: 'variants' });
  const loop = findWhileBlock(body, fromIndex);
  if (loop) candidates.push({ ...loop, kind: 'while' });
  if (candidates.length === 0) return null;
  return candidates.reduce((earliest, candidate) =>
    candidate.blockStart < earliest.blockStart ? candidate : earliest,
  );
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

function findIfBlock(body: string, fromIndex: number): IfMatch | null {
  const openRegex = /\{\{\s*#if=/g;
  openRegex.lastIndex = fromIndex;
  const openMatch = openRegex.exec(body);
  if (!openMatch) return null;
  const blockStart = openMatch.index;
  const openTagEnd = findMatchingClose(body, blockStart);
  if (openTagEnd === -1) return null;
  // Condition = text after `#if=` up to the closing `}}` (exclusive), trimming trailing space.
  const condition = body.slice(openMatch.index + openMatch[0].length, openTagEnd - 2);

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
    result += text.slice(cursor, match.blockStart);
    // Resolve nested tokens in the condition before evaluating. First collapse any {{ =... }} math
    // equations to their numeric results (so equations work inside conditions), then resolve any
    // remaining plain {{ ... }} tokens to their raw string values.
    const resolvedCondition = renderTemplateText(match.condition, product, list, ctx, false);
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
    const match = findNextRenderBlock(withIf, cursor);
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
    } else {
      const loopParams = parseWhileParams(match.params, product, list, ctx);
      if (loopParams) {
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

// A foreach loop is present if there is an opening `{{#selection.foreach product ...}}` tag and a
// matching `{{/selection.foreach product}}` closing tag. Detected on the comment-stripped body so a
// foreach that lives only inside a comment block is not counted. Uses the brace-aware block finder so
// tag params containing {{ }} tokens are matched correctly.
function hasForeach(body: string): boolean {
  return findForeachBlock(flattenForeachInsideWhile(stripComments(body)), 0) !== null;
}

// Remove every complete foreach block's TAGS from `text`, keeping the inner content (recursively).
function unwrapForeachBlocks(text: string): string {
  let result = '';
  let cursor = 0;
  while (cursor < text.length) {
    const block = findForeachBlock(text, cursor);
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

// Locate the first foreach opening tag in the (comment-stripped) body using a brace-depth-aware scan
// so the tag's parameters may themselves contain {{ }} tokens. Returns the tag's parameter string
// (the text after `#selection.foreach product` up to the tag's closing `}}`), the inner content
// between the opening and its matching closing `{{/selection.foreach product}}`, and the start/end
// indices of the whole block. Returns null when no complete foreach block is found.
interface ForeachMatch {
  params: string;
  inner: string;
  blockStart: number;
  blockEnd: number;
}

function findForeachBlock(body: string, fromIndex: number): ForeachMatch | null {
  // Accept both the singular `product` and plural `products` keyword so templates written with
  // either form (including older templates or hand-typed loops) are detected. The `s?` makes the
  // trailing `s` optional; `\b` ensures we don't match e.g. `productX`.
  const openRegex = /\{\{\s*#selection\.foreach\s+products?\b/g;
  openRegex.lastIndex = fromIndex;
  const openMatch = openRegex.exec(body);
  if (!openMatch) return null;
  const blockStart = openMatch.index;
  // The opening tag ends at its matching `}}` (params may contain nested {{ }}).
  const openTagEnd = findMatchingClose(body, blockStart);
  if (openTagEnd === -1) return null;
  // params = text after the `#selection.foreach product(s)` keyword up to the closing `}}` (exclusive).
  const params = body.slice(openMatch.index + openMatch[0].length, openTagEnd - 2);
  // Find the matching closing tag after the opening tag. The closing keyword may also be singular or
  // plural, and does not need to match the opening tag's form.
  const closeRegex = /\{\{\s*\/selection\.foreach\s+products?\s*\}\}/g;
  closeRegex.lastIndex = openTagEnd;
  const closeMatch = closeRegex.exec(body);
  if (!closeMatch) return null;
  const inner = body.slice(openTagEnd, closeMatch.index);
  const blockEnd = closeMatch.index + closeMatch[0].length;
  return { params, inner, blockStart, blockEnd };
}

// Determine which rows a foreach block should iterate over given skip options. Operates on the
// variant-expanded row list (one entry per variant), so skip_first/skip_last drop the first/last ROW.
function foreachSelection(
  rows: ProductData[],
  skipFirst: boolean,
  skipLast: boolean,
): ProductData[] {
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

// Expand every foreach block in `body` against `iterationRows`, offsetting the loop counter by
// `counterOffset` (used when a chunked file continues counting from a previous file). `rowSlicer`,
// when provided, maps a block's full iterated rows to the subset this file should render (used for
// chunking the FIRST foreach block only); other blocks render all their iterated rows. Returns the
// body with all foreach blocks replaced by their rendered iterations. Uses a brace-depth-aware
// scanner so foreach tag params may contain {{ }} tokens.
function expandForeachBlocks(
  body: string,
  contextRows: ProductData[],
  baseCtx: EvalContext,
  chunkFirstBlock: { size: number; fileIndex: number } | null,
): string {
  let result = '';
  let cursor = 0;
  let seenFirstBlock = false;
  while (cursor < body.length) {
    const match = findForeachBlock(body, cursor);
    if (!match) {
      result += body.slice(cursor);
      break;
    }
    result += body.slice(cursor, match.blockStart);
    const opts = parseForeachOptions(match.params);
    const firstRow = contextRows[0];
    const startBase = resolveExprToNumber(opts.startExpr, firstRow, contextRows, baseCtx) ?? 0;
    const startIndex = Math.round(startBase);
    let iterated = foreachSelection(contextRows, opts.skipFirst, opts.skipLast);
    let counterBase = startIndex;
    const isFirstBlock = !seenFirstBlock;
    seenFirstBlock = true;
    // Chunk only the first foreach block, and only when chunking is active for this render.
    if (isFirstBlock && chunkFirstBlock) {
      const from = chunkFirstBlock.fileIndex * chunkFirstBlock.size;
      const to = from + chunkFirstBlock.size;
      iterated = iterated.slice(from, to);
      // The counter RESETS to the START value at the beginning of every chunk file (it does NOT
      // continue globally across files). So within each file `{{ i }}` runs START, START+1, ...
      // up to at most START + size - 1 -- effectively `i` mod the chunk size within each file.
      counterBase = startIndex;
    }
    const rendered = iterated
      .map((row, iterationIndex) => {
        // First iteration takes the declared start value; every later iteration performs
        // `name = name + 1` against the CURRENT stored value, so a nested loop that writes the same
        // variable carries its count forward into this loop's next iteration.
        const counterValue =
          iterationIndex === 0 ? counterBase : readVarNumber(baseCtx.vars, opts.name) + 1;
        baseCtx.vars[opts.name] = String(counterValue);
        return renderTokens(match.inner, row, contextRows, baseCtx);
      })
      .join('');
    result += rendered;
    cursor = match.blockEnd;
  }
  return result;
}

// Read the chunk size (max) declared on the FIRST foreach block that declares one, resolving its
// maxExpr against the given rows/context. Returns a positive integer chunk size, or null when no
// foreach declares a valid (> 0) max.
function firstForeachChunkSize(
  body: string,
  contextRows: ProductData[],
  baseCtx: EvalContext,
): number | null {
  let cursor = 0;
  while (cursor < body.length) {
    const match = findForeachBlock(body, cursor);
    if (!match) return null;
    const opts = parseForeachOptions(match.params);
    if (opts.maxExpr.trim() !== '') {
      const firstRow = contextRows[0];
      const maxVal = resolveExprToNumber(opts.maxExpr, firstRow, contextRows, baseCtx);
      if (maxVal != null) {
        const size = Math.round(maxVal);
        return size > 0 ? size : null;
      }
      return null;
    }
    cursor = match.blockEnd;
  }
  return null;
}

// Count how many rows the FIRST foreach block iterates over (after skip filtering), used to decide
// whether the row count exceeds the chunk size. Returns 0 when there is no foreach block.
function firstForeachIteratedCount(body: string, contextRows: ProductData[]): number {
  const match = findForeachBlock(body, 0);
  if (!match) return 0;
  const opts = parseForeachOptions(match.params);
  return foreachSelection(contextRows, opts.skipFirst, opts.skipLast).length;
}

// COMBINED mode planner: works out HOW MANY files the body produces (one normally, or one per chunk
// when a foreach declares a `max` chunk size and the iterated row count exceeds it) and returns a
// `render` function that renders ONE of those files on demand. Rendering one file at a time is what
// lets the download be prepared asynchronously with progress reporting.
// `selectionLength` is the true number of products the merchant selected, exposed via {{ selection.length }}.
function planCombined(
  body: string,
  products: ProductData[],
  selectionLength: number,
  primaryDomain: string,
  date: DateParts,
): { fileCount: number; render: (fileIndex: number | null) => string } {
  const rows = expandSelectionToRows(products);
  const first = rows[0];
  const withoutComments = flattenForeachInsideWhile(stripComments(applyWhitespaceTokens(body)));
  const probeCtx: EvalContext = {
    selectionLength,
    primaryDomain,
    date,
    vars: createVarStore(),
  };

  const chunkSize = firstForeachChunkSize(withoutComments, rows, probeCtx);
  const iteratedCount = firstForeachIteratedCount(withoutComments, rows);
  const chunked = chunkSize != null && iteratedCount > chunkSize;
  const fileCount = chunked ? Math.ceil(iteratedCount / (chunkSize as number)) : 1;

  const render = (fileIndex: number | null): string => {
    // Every output file starts from a FRESH variable store, so one chunk never leaks values into
    // the next.
    const baseCtx: EvalContext = {
      selectionLength,
      primaryDomain,
      date,
      vars: createVarStore(),
    };
    const chunk = chunked && fileIndex != null ? { size: chunkSize as number, fileIndex } : null;
    const expanded = expandForeachBlocks(withoutComments, rows, baseCtx, chunk);
    const substituted = renderTokens(expanded, first, rows, baseCtx);
    // restoreWhitespaceTokens is the LAST step: turn any remaining whitespace sentinels (outside wrap
    // blocks) into real newlines / spaces.
    return restoreWhitespaceTokens(applyWrapBlocks(substituted));
  };

  return { fileCount, render };
}

// PER-PRODUCT mode: evaluate the template against a single row (one product + one variant). Any
// foreach block iterates just that single row. `selectionLength` is the true number of products the
// merchant selected (not 1), exposed via {{ selection.length }}.
function evaluateSingle(
  body: string,
  row: ProductData,
  selectionLength: number,
  primaryDomain: string,
  date: DateParts,
): string {
  const withoutComments = flattenForeachInsideWhile(stripComments(applyWhitespaceTokens(body)));
  const baseCtx: EvalContext = {
    selectionLength,
    primaryDomain,
    date,
    vars: createVarStore(),
  };
  const expanded = expandForeachBlocks(withoutComments, [row], baseCtx, null);
  const substituted = renderTokens(expanded, row, [row], baseCtx);
  // restoreWhitespaceTokens is the LAST step: turn any remaining whitespace sentinels (outside wrap
  // blocks) into real newlines / spaces.
  return restoreWhitespaceTokens(applyWrapBlocks(substituted));
}

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

function planOutputFiles(
  templateTitle: string,
  templateBody: string,
  templateExtension: string,
  products: ProductData[],
  primaryDomain: string,
  now: Date,
): FilePlan {
  const ext = sanitizeExtension(templateExtension);
  const titleSlug = slugify(templateTitle);
  const dateParts = computeDateParts(now);
  const timestamp = formatTimestamp(now);
  const selectionLength = products.length;

  // A variant foreach declared with tied=FALSE always produces one file per variant, even when the
  // body also contains a selection foreach, so the per-variant-row path below is used instead.
  const untiedVariants = hasUntiedVariantLoop(templateBody);

  if (hasForeach(templateBody) && !untiedVariants) {
    // COMBINED mode: one file normally, or one file per chunk when a foreach declares a max size.
    const combined = planCombined(
      templateBody,
      products,
      selectionLength,
      primaryDomain,
      dateParts,
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
      zipName: `${timestamp}_looped_zip_${titleSlug}.zip`,
      build: (index: number) => ({
        name: `${timestamp}_looped_${titleSlug}_${index}.${ext}`,
        content: combined.render(index),
      }),
    };
  }

  // PER-PRODUCT mode: one file per variant row.
  const rows = expandSelectionToRows(products);
  if (rows.length === 1) {
    return {
      count: 1,
      zipName: null,
      build: () => ({
        name: `${rows[0].handle}_${titleSlug}.${ext}`,
        content: evaluateSingle(templateBody, rows[0], selectionLength, primaryDomain, dateParts),
      }),
    };
  }
  // Entry names are computed up front so de-duplication is deterministic no matter which order the
  // files are built in.
  const usedNames = new Set<string>();
  const rowNames: string[] = rows.map((row) => {
    const rowVariant = row.variants[0];
    const variantSuffix = rowVariant ? `_${slugify(rowVariant.title)}` : '';
    let name = `${row.handle}${variantSuffix}_${titleSlug}.${ext}`;
    if (usedNames.has(name)) {
      let counter = 1;
      let candidate = `${row.handle}${variantSuffix}_${titleSlug}_${counter}.${ext}`;
      while (usedNames.has(candidate)) {
        counter += 1;
        candidate = `${row.handle}${variantSuffix}_${titleSlug}_${counter}.${ext}`;
      }
      name = candidate;
    }
    usedNames.add(name);
    return name;
  });
  return {
    count: rows.length,
    zipName: `${timestamp}_zipped_${titleSlug}.zip`,
    build: (index: number) => ({
      name: rowNames[index],
      content: evaluateSingle(templateBody, rows[index], selectionLength, primaryDomain, dateParts),
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
  primaryDomain: string,
  now: Date,
): OutputFiles {
  const plan = planOutputFiles(
    templateTitle,
    templateBody,
    templateExtension,
    products,
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

// --- Client-side product search (metafield filter + advanced boolean mode) -------------------
// Detect whether a search string should use the advanced boolean parser. Triggered by any of the
// operators/grouping tokens `{{`, `}}`, `&&`, `||`, or `!`. Otherwise the simple Shopify search (with
// client-side metafield augmentation) is used.
function isAdvancedSearch(term: string): boolean {
  return (
    term.includes('{{') ||
    term.includes('}}') ||
    term.includes('&&') ||
    term.includes('||') ||
    term.includes('!')
  );
}

// Case-insensitive substring test of a single leaf query term against one product's searchable
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

// --- Boolean search expression parser --------------------------------------------------------
// Grammar (lowest to highest precedence): OR (`||`), AND (`&&`), NOT (`!` prefix), a double-brace
// group `{{ ... }}` (nested sub-expression when its inner text contains an operator or nested `{{`,
// otherwise a leaf query term), and a bare leaf term. The parser produces a node tree; leaves carry
// the trimmed query string. On any parse failure the caller falls back to a single implicit leaf.
type SearchNode =
  | { type: 'leaf'; query: string }
  | { type: 'not'; child: SearchNode }
  | { type: 'and'; left: SearchNode; right: SearchNode }
  | { type: 'or'; left: SearchNode; right: SearchNode };

// Find the index just past the `}}` that matches the `{{` at openIndex, counting nested `{{`/`}}`
// pairs. Returns -1 when unbalanced.
function matchBraceGroup(text: string, openIndex: number): number {
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
      if (depth === 0) return i;
      continue;
    }
    i += 1;
  }
  return -1;
}

// Split an expression on a top-level (brace-depth 0) operator (`||` or `&&`), returning the list of
// segment strings. Operators inside `{{ }}` groups are left intact.
function splitSearchTopLevel(expr: string, op: string): string[] {
  const segments: string[] = [];
  let depth = 0;
  let last = 0;
  let i = 0;
  while (i < expr.length) {
    if (expr[i] === '{' && expr[i + 1] === '{') {
      depth += 1;
      i += 2;
      continue;
    }
    if (expr[i] === '}' && expr[i + 1] === '}') {
      if (depth > 0) depth -= 1;
      i += 2;
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

// Whether `expr` (trimmed) is exactly one double-brace group wrapping the entire string.
function isSingleBraceGroup(expr: string): boolean {
  const trimmed = expr.trim();
  if (trimmed.slice(0, 2) !== '{{' || trimmed.slice(-2) !== '}}') return false;
  const end = matchBraceGroup(trimmed, 0);
  return end === trimmed.length;
}

// Parse a boolean search expression into a SearchNode tree. Throws on malformed input so the caller
// can fall back to a single implicit leaf.
function parseSearchExpression(rawExpr: string): SearchNode {
  const expr = rawExpr.trim();
  if (expr === '') {
    throw new Error('Empty search expression');
  }

  // OR (lowest precedence).
  const orParts = splitSearchTopLevel(expr, '||');
  if (orParts.length > 1) {
    return orParts
      .map((part) => parseSearchExpression(part))
      .reduce((left, right) => ({ type: 'or', left, right }));
  }

  // AND.
  const andParts = splitSearchTopLevel(expr, '&&');
  if (andParts.length > 1) {
    return andParts
      .map((part) => parseSearchExpression(part))
      .reduce((left, right) => ({ type: 'and', left, right }));
  }

  // NOT (unary prefix).
  if (expr[0] === '!') {
    return { type: 'not', child: parseSearchExpression(expr.slice(1)) };
  }

  // A single double-brace group wrapping the whole expression.
  if (isSingleBraceGroup(expr)) {
    const inner = expr.slice(2, -2).trim();
    // If the inner text itself contains an operator or a nested group, recurse into it as a
    // sub-expression; otherwise it is a leaf query term (a phrase that may contain spaces).
    if (isAdvancedSearch(inner)) {
      return parseSearchExpression(inner);
    }
    if (inner === '') {
      throw new Error('Empty brace group');
    }
    return { type: 'leaf', query: inner };
  }

  // Any leftover brace characters at this point mean the expression is malformed.
  if (expr.includes('{{') || expr.includes('}}')) {
    throw new Error('Unbalanced braces in search expression');
  }

  // Bare leaf term.
  return { type: 'leaf', query: expr };
}

// Evaluate a parsed search tree against one product.
function evaluateSearchNode(node: SearchNode, product: ProductData): boolean {
  switch (node.type) {
    case 'leaf':
      return productMatchesQuery(product, node.query);
    case 'not':
      return !evaluateSearchNode(node.child, product);
    case 'and':
      return evaluateSearchNode(node.left, product) && evaluateSearchNode(node.right, product);
    case 'or':
      return evaluateSearchNode(node.left, product) || evaluateSearchNode(node.right, product);
    default:
      return false;
  }
}

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

// A stable signature of a selection draft (product ids and notes, plus note objects, in order) used
// to detect unsaved changes.
function selectionSignature(list: ProductData[], notes: NoteObject[] = []): string {
  return (
    list.map((p) => `${p.id}::${p.note || ''}`).join('|') +
    '#' +
    notes.map((n) => `${n.id}::${n.content}`).join('|')
  );
}

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
  // Which bulk-select button is currently active, if any. Only one can be active at a time.
  const [bulkMode, setBulkMode] = useState<BulkSelectMode | null>(null);
  // Persistent map of EVERY product returned by any products query this session (initial load, each
  // search, each pagination page), keyed by product id. This is the corpus the client-side metafield
  // filter and advanced boolean search evaluate against. It only grows and is never cleared.
  const [allLoadedProducts, setAllLoadedProducts] = useState<Record<string, ProductData>>({});

  // Saved product selections (6 shared/public slots). `selectionIds` holds the stored product GIDs of
  // each saved slot; the currently open slot's working copy lives in `selectionDraft`.
  const [selectionEntries, setSelectionEntries] = useState<Record<string, SelectionEntry[]>>({
    public_1: [],
    public_2: [],
    public_3: [],
    public_4: [],
    public_5: [],
    public_6: [],
  });
  // Subtitles of the six public selections, shown as a gray second line in the Selections menu.
  // Note objects stored in each saved slot, read from the same metafield array as its products.
  const [selectionNotes, setSelectionNotes] = useState<Record<string, NoteObject[]>>({
    public_1: [],
    public_2: [],
    public_3: [],
    public_4: [],
    public_5: [],
    public_6: [],
  });
  // Note objects belonging to the Current Selection (in memory only until saved into a slot).
  const [noteObjects, setNoteObjects] = useState<NoteObject[]>([]);
  // Note objects in the open selection view's working draft.
  const [selectionNoteDraft, setSelectionNoteDraft] = useState<NoteObject[]>([]);
  // Subset checkboxes in a PUBLIC selection view: which draft products / note objects are ticked.
  // They always start empty (nothing checked) each time a selection is opened and are never stored.
  const [checkedSelectionProducts, setCheckedSelectionProducts] = useState<Record<string, boolean>>(
    {},
  );
  const [checkedSelectionNotes, setCheckedSelectionNotes] = useState<Record<string, boolean>>({});
  // Text typed in the note modal before it is saved as a note object.
  const [noteDraftText, setNoteDraftText] = useState<string>('');
  const [noteDraftSource, setNoteDraftSource] = useState<'manual' | 'search'>('manual');
  // True while the Refresh Page button is re-reading templates, selections, and products.
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [selectionSubtitles, setSelectionSubtitles] = useState<Record<string, string>>({});
  // The subtitle being edited in the open public selection view.
  const [subtitleDraft, setSubtitleDraft] = useState<string>('');
  const [subtitleBaseline, setSubtitleBaseline] = useState<string>('');
  const [selectionsError, setSelectionsError] = useState<string | null>(null);
  const [selectionSlot, setSelectionSlot] = useState<SelectionSlotId | null>(null);
  const [selectionDraft, setSelectionDraft] = useState<ProductData[]>([]);
  const [selectionBaseline, setSelectionBaseline] = useState<string>('');
  const [selectionSearch, setSelectionSearch] = useState('');
  const [selectionLoading, setSelectionLoading] = useState(false);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const [selectionSaving, setSelectionSaving] = useState(false);
  const [selectionMissing, setSelectionMissing] = useState(false);
  // Mirror of `allLoadedProducts` kept in a ref so async loaders can read the latest cache without
  // depending on a stale state closure.
  const loadedProductsRef = useRef<Record<string, ProductData>>({});
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
  const [editorTitleError, setEditorTitleError] = useState<string | null>(null);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Placeholder token that authors type into the body to mark where a variable should go.
  // Selecting a variable from the Insert variable menu replaces all occurrences of this token.
  // Both `{{ insert }}` and the spaceless `{{insert}}` are recognized as the placeholder.
  const INSERT_PLACEHOLDER = '{{ insert }}';
  const INSERT_PLACEHOLDER_REGEX = /\{\{\s*insert\s*\}\}/g;
  // Original editor values captured when the editor was opened, used to detect unsaved changes.
  const originalEditorRef = useRef<{ title: string; body: string; extension: string }>({
    title: '',
    body: '',
    extension: '',
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

  // The selected products with their current notes attached, so {{ product.notes }} resolves during
  // download and preview generation and notes travel with a product into any selection.
  const selectedProductList = useMemo(
    () => Object.values(selectedProducts).map((p) => ({ ...p, note: productNotes[p.id] || '' })),
    [selectedProducts, productNotes],
  );
  const selectedTemplate = useMemo(
    () => templates.find((t) => t.id === selectedTemplateId) || null,
    [templates, selectedTemplateId],
  );

  // The products shown in the table. Combines the server-side page results with client-side matches:
  //  - No applied search term: just the server page results.
  //  - Advanced boolean term (contains {{ }} && || !): parse the expression and evaluate it against
  //    every loaded product; on a parse error, fall back to a single implicit leaf query. Server
  //    results are not used for filtering in this mode.
  //  - Simple non-empty term: UNION of the server page results and any loaded product whose metafield
  //    (or other searchable field) values contain the term (case-insensitive), de-duplicated by id
  //    with server results first.
  const displayedProducts = useMemo<ProductData[]>(() => {
    const term = appliedSearch.trim();
    if (term === '') {
      return products;
    }
    const loadedList = Object.values(allLoadedProducts);
    if (isAdvancedSearch(term)) {
      let tree: SearchNode;
      try {
        tree = parseSearchExpression(term);
      } catch {
        tree = { type: 'leaf', query: term };
      }
      return loadedList.filter((p) => evaluateSearchNode(tree, p));
    }
    // Simple term: union of server results + client-side field/metafield matches from loaded set.
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

  // Merge freshly loaded products into both the ref cache and the state map used by client-side
  // search, so every product the app has ever seen this session stays available.
  const rememberProducts = (list: ProductData[]): void => {
    if (list.length === 0) return;
    // Work out which products are genuinely new BEFORE the ref is updated. Re-visiting a page the
    // app has already loaded (for example clearing the search to return to the newest arrivals)
    // brings back the same ids, and replacing the state map in that case would hand every consumer
    // a brand-new object for no reason and churn the whole page.
    const freshProducts = list.filter((p) => !loadedProductsRef.current[p.id]);
    const nextRef = { ...loadedProductsRef.current };
    for (const p of list) {
      nextRef[p.id] = p;
    }
    loadedProductsRef.current = nextRef;
    if (freshProducts.length === 0) return;
    setAllLoadedProducts((prev) => {
      const next = { ...prev };
      for (const p of freshProducts) {
        next[p.id] = p;
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
      setSelectionEntries({
        public_1: parseSelectionEntries(shop?.pub1?.value),
        public_2: parseSelectionEntries(shop?.pub2?.value),
        public_3: parseSelectionEntries(shop?.pub3?.value),
        public_4: parseSelectionEntries(shop?.pub4?.value),
        public_5: parseSelectionEntries(shop?.pub5?.value),
        public_6: parseSelectionEntries(shop?.pub6?.value),
      });
      setSelectionNotes({
        public_1: parseSelectionNotes(shop?.pub1?.value),
        public_2: parseSelectionNotes(shop?.pub2?.value),
        public_3: parseSelectionNotes(shop?.pub3?.value),
        public_4: parseSelectionNotes(shop?.pub4?.value),
        public_5: parseSelectionNotes(shop?.pub5?.value),
        public_6: parseSelectionNotes(shop?.pub6?.value),
      });
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

  // Map an applied search term to the query string sent to the Shopify `products` query. Advanced
  // boolean expressions are NOT valid Shopify search syntax, so in advanced mode we send an empty
  // server query (the server returns the default newest-first page, which still grows the loaded set
  // that the client-side boolean filter evaluates against). Simple terms are passed through so the
  // server does its normal indexed search; the client-side metafield augmentation adds to that.
  const serverQueryFor = (term: string): string => (isAdvancedSearch(term) ? '' : term);

  const runSearch = (): void => {
    setAppliedSearch(productSearch);
    fetchProducts(null, 'forward', serverQueryFor(productSearch));
  };

  const handleNextProducts = (): void => {
    if (productPageInfo?.hasNextPage) {
      fetchProducts(productPageInfo.endCursor, 'forward', serverQueryFor(appliedSearch));
    }
  };

  const handlePrevProducts = (): void => {
    if (productPageInfo?.hasPreviousPage) {
      fetchProducts(productPageInfo.startCursor, 'backward', serverQueryFor(appliedSearch));
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
      await fetchProducts(null, 'forward', serverQueryFor(appliedSearch));
    } finally {
      setRefreshing(false);
    }
  };

  // Open the note modal, pre-filling the text when the note is created from the search box.
  const openNoteModal = (initialText: string, source: 'manual' | 'search'): void => {
    setNoteDraftText(initialText);
    setNoteDraftSource(source);
  };

  // Append the current product search text to the note being typed. The modal stays open, so the
  // merchant can keep editing; an empty search box changes nothing.
  const appendSearchToNote = (): void => {
    const searchText = productSearch.trim();
    if (searchText === '') return;
    setNoteDraftText((prev) => (prev.trim() === '' ? searchText : `${prev}\n${searchText}`));
    setNoteDraftSource('search');
  };

  // Save the typed text as a note object on the Current Selection. Empty text creates nothing.
  const saveNoteObject = (): void => {
    const content = noteDraftText.trim();
    if (content === '') {
      setNoteDraftText('');
      return;
    }
    setNoteObjects((prev) => [...prev, createNoteObject(content, noteDraftSource)]);
    setNoteDraftText('');
  };

  const discardNoteDraft = (): void => {
    setNoteDraftText('');
  };

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
    // Unchecking a product on the main page deletes its note from the current selection: the note
    // only exists for as long as the product is selected. A note already saved into a public
    // selection is stored separately and is not affected.
    if (!checked) {
      setProductNotes((prev) => {
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

  // The products each bulk-select button targets: every displayed product, or only the displayed
  // products whose total inventory is greater than 0.
  const bulkTargets = (mode: BulkSelectMode): ProductData[] =>
    mode === 'shown'
      ? displayedProducts
      : displayedProducts.filter((p) => (p.totalInventory ?? 0) > 0);

  const inStockDisplayedCount = displayedProducts.filter((p) => (p.totalInventory ?? 0) > 0).length;

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
  };

  const clearTemplateSelection = (): void => {
    setSelectedTemplateId(null);
  };

  const openNewTemplate = (): void => {
    setEditingTemplate(null);
    setEditorTitle('');
    setEditorBody('');
    setEditorExtension('txt');
    setEditorTitleError(null);
    setEditorError(null);
    originalEditorRef.current = { title: '', body: '', extension: 'txt' };
    setView('editor');
  };

  const openEditTemplate = (tpl: TemplateData): void => {
    setEditingTemplate(tpl);
    setEditorTitle(tpl.title);
    setEditorBody(tpl.body);
    setEditorExtension(tpl.extension || 'txt');
    setEditorTitleError(null);
    setEditorError(null);
    originalEditorRef.current = {
      title: tpl.title,
      body: tpl.body,
      extension: tpl.extension || 'txt',
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
      editorTitle !== orig.title || editorBody !== orig.body || editorExtension !== orig.extension
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
    setEditorTitleError(null);
    setEditorError(null);
    setSaving(true);
    try {
      const ownerId = await ensureShopId(setEditorError);
      if (!ownerId) {
        return;
      }
      // Re-read the current stored list immediately before writing so a concurrent edit by another
      // staff member is preserved, then merge this single template (matched by id) into it.
      const { list: currentList, error: readError } = await readTemplatesFromShop();
      if (readError) {
        setEditorError(readError);
        return;
      }
      const savedId = editingTemplate ? editingTemplate.id : generateTemplateId(editorTitle);
      const existingIndex = currentList.findIndex((t) => t.id === savedId);
      const savedTemplate: TemplateData = {
        id: savedId,
        title: editorTitle,
        body: editorBody,
        extension: sanitizeExtension(editorExtension),
        // Editing a template never changes its pinned state or when it was pinned.
        pinned: existingIndex >= 0 ? currentList[existingIndex].pinned === true : false,
        pinnedAt: existingIndex >= 0 ? (currentList[existingIndex].pinnedAt ?? null) : null,
      };
      const mergedList =
        existingIndex >= 0
          ? currentList.map((t) => (t.id === savedTemplate.id ? savedTemplate : t))
          : [...currentList, savedTemplate];
      const { errors, userErrors, overflow } = await writeTemplates(ownerId, mergedList);
      if (overflow) {
        setEditorError(storageFullMessage(mergedList));
        return;
      }
      if (errors.length) {
        setEditorError(errors.map((e: any) => e.message).join(', '));
        return;
      }
      if (userErrors.length) {
        setEditorError(
          userErrors.map((e: any) => (e.field ? `${e.field}: ${e.message}` : e.message)).join(', '),
        );
        return;
      }
      await fetchTemplates();
      originalEditorRef.current = {
        title: editorTitle,
        body: editorBody,
        extension: editorExtension,
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
      const ownerId = await ensureShopId(setPinError);
      if (!ownerId) {
        return;
      }
      const { list: currentList, error: readError } = await readTemplatesFromShop();
      if (readError) {
        setPinError(readError);
        return;
      }
      // Pinning records the current time so the pinned group can sort most-recently-pinned first;
      // unpinning clears it.
      const pinnedNow = Date.now();
      const updatedList = currentList.map((t) => {
        if (t.id !== template.id) {
          return t;
        }
        const nextPinned = !(t.pinned === true);
        return { ...t, pinned: nextPinned, pinnedAt: nextPinned ? pinnedNow : null };
      });
      const { errors, userErrors, overflow } = await writeTemplates(ownerId, updatedList);
      if (overflow) {
        setPinError(storageFullMessage(updatedList));
        return;
      }
      if (errors.length) {
        setPinError(errors.map((e: any) => e.message).join(', '));
        return;
      }
      if (userErrors.length) {
        setPinError(
          userErrors.map((e: any) => (e.field ? `${e.field}: ${e.message}` : e.message)).join(', '),
        );
        return;
      }
      await fetchTemplates();
    } catch (err: any) {
      setPinError(err?.message || 'Failed to update the pinned template.');
    } finally {
      setPinningId(null);
    }
  };

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
      const ownerId = await ensureShopId(setDeleteError);
      if (!ownerId) {
        return;
      }
      // Re-read the current stored list before writing so concurrent edits by other staff are kept,
      // then remove the template with the matching id.
      const { list: currentList, error: readError } = await readTemplatesFromShop();
      if (readError) {
        setDeleteError(readError);
        return;
      }
      const reducedList = currentList.filter((t) => t.id !== pendingDeleteId);
      const { errors, userErrors, overflow } = await writeTemplates(ownerId, reducedList);
      if (overflow) {
        setDeleteError(storageFullMessage(reducedList));
        return;
      }
      if (errors.length) {
        setDeleteError(errors.map((e: any) => e.message).join(', '));
        return;
      }
      if (userErrors.length) {
        setDeleteError(
          userErrors.map((e: any) => (e.field ? `${e.field}: ${e.message}` : e.message)).join(', '),
        );
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

  const canDownload = selectedProductList.length > 0 && selectedTemplate !== null;

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
    if (!selectedTemplate || selectedProductList.length === 0) {
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
  }, [selectedTemplate, selectedProductList, primaryDomain]);

  // Whether the current selection is valid but the content could not be built.
  const downloadBuildFailed = canDownload && downloadFailed;
  const preparingDownload = downloadProgress !== null;

  // Called on the same click that fires the browser download: record the filename for the
  // confirmation popup so the modal can confirm exactly what was downloaded.
  const onDownloadClick = (): void => {
    if (!download) return;
    setConfirmedName(download.name);
  };

  // Preview: build the same file set the download would produce, but from the CURRENT (possibly
  // unsaved) editor values, so a template can be checked before it is saved.
  const preview = useMemo<{ files: ZipEntry[]; failed: boolean }>(() => {
    if (selectedProductList.length === 0) {
      return { files: [], failed: false };
    }
    try {
      const output = buildOutputFiles(
        editorTitle,
        editorBody,
        editorExtension,
        selectedProductList,
        primaryDomain,
        new Date(),
      );
      return { files: output.files, failed: false };
    } catch {
      return { files: [], failed: true };
    }
  }, [editorTitle, editorBody, editorExtension, selectedProductList, primaryDomain]);

  // Clamp the page index so a changed selection can never point past the last generated file.
  const previewPage =
    preview.files.length === 0 ? 0 : Math.min(previewIndex, preview.files.length - 1);
  const canPreview = selectedProductList.length > 0;

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
      const cached = loadedProductsRef.current[id];
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
      setSelectionBaseline(selectionSignature(selectedProductList, noteObjects));
      setSubtitleDraft('');
      setSubtitleBaseline('');
      return;
    }
    const storedEntries = selectionEntries[slot] || [];
    const storedNotes = selectionNotes[slot] || [];
    setSelectionNoteDraft(storedNotes);
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
      // Attach each product's stored note so the selection carries its own notes.
      const noteById: Record<string, string> = {};
      for (const entry of storedEntries) {
        noteById[entry.id] = entry.note;
      }
      const withNotes = products.map((p) => ({ ...p, note: noteById[p.id] || '' }));
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

  // Edit one note object's text inside the open selection's working draft.
  const setSelectionDraftNoteContent = (noteId: string, content: string): void => {
    setSelectionNoteDraft((prev) => {
      const current = prev.find((n) => n.id === noteId);
      if (!current || current.content === content) {
        return prev;
      }
      return prev.map((n) => (n.id === noteId ? { ...n, content } : n));
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
  };

  const clearSelectionDraft = (): void => {
    setSelectionError(null);
    setSelectionDraft([]);
    setSelectionNoteDraft([]);
  };

  const selectionSubtitleFor = (slot: SelectionSlotId): string => selectionSubtitles[slot] || '';

  // Label shown for a public selection in the Selections menu. A menu `s-button` renders a single
  // plain-text label with no color or style props, so when a slot has a subtitle the subtitle
  // REPLACES the default name, rendered through `toItalic` so it appears italic, and is followed by
  // the slot's product count: "<italic subtitle> (N)".
  const selectionMenuLabel = (slot: SelectionSlotId): string => {
    const count = (selectionEntries[slot] || []).length + (selectionNotes[slot] || []).length;
    const subtitle = selectionSubtitleFor(slot);
    if (subtitle) {
      return `${toItalic(subtitle)} (${count})`;
    }
    return `${selectionSlotLabel(slot)} (${count})`;
  };

  // Move ONE product up or down by a single position in the open selection's working draft, so the
  // merchant can reorder the selection. Polaris has no drag-and-drop component and the sandbox has no
  // HTML5 drag events, so reordering uses these move controls. The change is a draft edit; it is only
  // persisted when the merchant uses Save.
  const moveInSelectionDraft = (productId: string, offset: number): void => {
    setSelectionError(null);
    setSelectionDraft((prev) => {
      const index = prev.findIndex((p) => p.id === productId);
      const target = index + offset;
      if (index === -1 || target < 0 || target >= prev.length) {
        return prev;
      }
      const next = [...prev];
      const [moved] = next.splice(index, 1);
      next.splice(target, 0, moved);
      return next;
    });
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
    // Note objects in the loaded selection join the Current Selection's note list (union by id).
    setNoteObjects((prev) => {
      const existing = new Set(prev.map((n) => n.id));
      const additions = notesToLoad.filter((n) => !existing.has(n.id));
      return additions.length === 0 ? prev : [...prev, ...additions];
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
      for (const p of selectionDraft) {
        next[p.id] = p;
        nextNotes[p.id] = p.note || '';
      }
      setSelectedProducts(next);
      setProductNotes(nextNotes);
      setNoteObjects(selectionNoteDraft);
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
      }));
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
              value: JSON.stringify([...entries, ...selectionNoteDraft]),
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
      if (errors?.length) {
        setSelectionError(errors.map((e: any) => e.message).join(', '));
        return;
      }
      const userErrors = data?.metafieldsSet?.userErrors || [];
      if (userErrors.length) {
        setSelectionError(
          userErrors.map((e: any) => (e.field ? `${e.field}: ${e.message}` : e.message)).join(', '),
        );
        return;
      }
      setSelectionEntries((prev) => ({ ...prev, [selectionSlot]: entries }));
      setSelectionNotes((prev) => ({ ...prev, [selectionSlot]: selectionNoteDraft }));
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

  // Search inside a selection only looks at the products the selection already holds.
  const selectionFiltered = useMemo<ProductData[]>(() => {
    const term = selectionSearch.trim();
    if (term === '') return selectionDraft;
    return selectionDraft.filter((p) => productMatchesQuery(p, term));
  }, [selectionDraft, selectionSearch]);

  // Searching inside a selection also matches note objects by their text.
  const selectionNotesFiltered = useMemo<NoteObject[]>(() => {
    const term = selectionSearch.trim();
    if (term === '') return selectionNoteDraft;
    return selectionNoteDraft.filter((n) => noteMatchesQuery(n, term));
  }, [selectionNoteDraft, selectionSearch]);

  if (view === 'editor') {
    return (
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

            <s-stack
              direction="inline"
              gap="base"
              justifyContent="space-between"
              alignItems="center"
            >
              <s-text type="strong">Body</s-text>
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
                  <s-button onClick={() => insertVariable(COMMENT_BLOCK)}>Comment block</s-button>
                </s-section>
                <s-section heading="Functional tokens">
                  <s-button onClick={() => insertVariable('{{ =0 }}')}>Math equation</s-button>
                  <s-button onClick={() => insertVariable(BOOLEAN_TOKEN)}>
                    Boolean equation
                  </s-button>
                  <s-button onClick={() => insertVariable(LENGTH_TOKEN)}>String length</s-button>
                </s-section>
                <s-section heading="Special tokens">
                  <s-button onClick={() => insertVariable(NEWLINE_TOKEN_SNIPPET)}>
                    New line
                  </s-button>
                  <s-button onClick={() => insertVariable(SPACE_TOKEN_SNIPPET)}>Space</s-button>
                  <s-button onClick={() => insertVariable('{{ day }}')}>Day (2-digit)</s-button>
                  <s-button onClick={() => insertVariable('{{ month }}')}>Month (2-digit)</s-button>
                  <s-button onClick={() => insertVariable('{{ year }}')}>Year (4-digit)</s-button>
                  <s-button onClick={() => insertVariable('{{ day.week }}')}>Day of week</s-button>
                  <s-button onClick={() => insertVariable('{{ month.name }}')}>Month name</s-button>
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
  }

  if (view === 'selection' && selectionSlot) {
    return (
      <s-page heading={selectionSlotLabel(selectionSlot)} inlineSize="large">
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
            disabled={selectedProductList.length === 0}
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
                <s-heading>Products in this selection</s-heading>
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

          <s-table loading={selectionLoading}>
            <s-table-header-row>
              {isPublicSelection ? <s-table-header>Use</s-table-header> : null}
              <s-table-header listSlot="primary">Product</s-table-header>
              <s-table-header>Handle</s-table-header>
              <s-table-header>Qty</s-table-header>
              <s-table-header>Note</s-table-header>
              <s-table-header>Order</s-table-header>
              <s-table-header>Remove</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {selectionFiltered.length === 0 && !selectionLoading ? (
                <s-table-row>
                  <s-table-cell>
                    <s-text color="subdued">
                      {selectionDraft.length === 0
                        ? 'No products in this selection.'
                        : 'No products found.'}
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
                selectionFiltered.map((p) => (
                  <s-table-row key={p.id}>
                    {isPublicSelection ? (
                      <s-table-cell>
                        <s-checkbox
                          accessibilityLabel={`Include ${p.title} when loading`}
                          checked={Boolean(checkedSelectionProducts[p.id])}
                          onChange={(e: any) =>
                            setSelectionProductChecked(p.id, e.currentTarget.checked)
                          }
                        />
                      </s-table-cell>
                    ) : null}
                    <s-table-cell>
                      <s-stack direction="inline" gap="small" alignItems="center">
                        {p.imageUrl ? (
                          <s-thumbnail size="small" src={p.imageUrl} alt={p.title} />
                        ) : null}
                        <s-text type="strong">{p.title}</s-text>
                      </s-stack>
                    </s-table-cell>
                    <s-table-cell>
                      <s-text color="subdued">{p.handle}</s-text>
                    </s-table-cell>
                    <s-table-cell>
                      <s-text color="subdued">{formatQty(p.totalInventory)}</s-text>
                    </s-table-cell>
                    <s-table-cell>
                      <s-text-field
                        label={`Note for ${p.title}`}
                        labelAccessibilityVisibility="exclusive"
                        placeholder="Add a note…"
                        value={p.note || ''}
                        onInput={(e: any) => setSelectionDraftNote(p.id, e.currentTarget.value)}
                      />
                    </s-table-cell>
                    <s-table-cell>
                      {/* Reordering uses move controls because Polaris has no drag-and-drop
                          component and the sandbox exposes no HTML5 drag events. Moves are disabled
                          while a search filters the list, so positions always reflect true order. */}
                      <s-stack direction="inline" gap="small-400" alignItems="center">
                        <s-button
                          icon="chevron-up"
                          variant="tertiary"
                          accessibilityLabel={`Move ${p.title} up`}
                          disabled={selectionSearch.trim() !== '' || selectionDraft[0]?.id === p.id}
                          onClick={() => moveInSelectionDraft(p.id, -1)}
                        />
                        <s-button
                          icon="chevron-down"
                          variant="tertiary"
                          accessibilityLabel={`Move ${p.title} down`}
                          disabled={
                            selectionSearch.trim() !== '' ||
                            selectionDraft[selectionDraft.length - 1]?.id === p.id
                          }
                          onClick={() => moveInSelectionDraft(p.id, 1)}
                        />
                      </s-stack>
                    </s-table-cell>
                    <s-table-cell>
                      <s-button
                        icon="x"
                        variant="tertiary"
                        accessibilityLabel={`Remove ${p.title}`}
                        onClick={() => removeFromSelectionDraft(p.id)}
                      />
                    </s-table-cell>
                  </s-table-row>
                ))
              )}
            </s-table-body>
          </s-table>

          <s-box padding="base">
            <s-heading>Notes in this selection</s-heading>
          </s-box>

          <s-table>
            <s-table-header-row>
              {isPublicSelection ? <s-table-header>Use</s-table-header> : null}
              <s-table-header listSlot="primary">Note</s-table-header>
              <s-table-header>Created</s-table-header>
              <s-table-header>Remove</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {selectionNotesFiltered.length === 0 ? (
                <s-table-row>
                  <s-table-cell>
                    <s-text color="subdued">
                      {selectionNoteDraft.length === 0
                        ? 'No notes in this selection.'
                        : 'No notes found.'}
                    </s-text>
                  </s-table-cell>
                  <s-table-cell />
                  <s-table-cell />
                  {isPublicSelection ? <s-table-cell /> : null}
                </s-table-row>
              ) : (
                selectionNotesFiltered.map((n) => (
                  <s-table-row key={n.id}>
                    {isPublicSelection ? (
                      <s-table-cell>
                        <s-checkbox
                          accessibilityLabel="Include this note when loading"
                          checked={Boolean(checkedSelectionNotes[n.id])}
                          onChange={(e: any) =>
                            setSelectionNoteChecked(n.id, e.currentTarget.checked)
                          }
                        />
                      </s-table-cell>
                    ) : null}
                    <s-table-cell>
                      <s-text-field
                        label="Note text"
                        labelAccessibilityVisibility="exclusive"
                        value={n.content}
                        onInput={(e: any) =>
                          setSelectionDraftNoteContent(n.id, e.currentTarget.value)
                        }
                      />
                    </s-table-cell>
                    <s-table-cell>
                      <s-text color="subdued">{new Date(n.createdAt).toLocaleDateString()}</s-text>
                    </s-table-cell>
                    <s-table-cell>
                      <s-button
                        icon="x"
                        variant="tertiary"
                        accessibilityLabel="Remove note"
                        onClick={() => removeNoteFromDraft(n.id)}
                      />
                    </s-table-cell>
                  </s-table-row>
                ))
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
  }

  return (
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
                      {SAVED_SLOTS.map((slot) => (
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
                  placeholder="Search title, handle, tag, SKU, metafield… or use {{ }} && || ! for advanced search"
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
                    onClick={() => openNoteModal('', 'manual')}
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
                displayedProducts.map((p) => (
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
                      </s-stack>
                    </s-table-cell>
                    <s-table-cell>
                      <s-text color="subdued">{p.handle}</s-text>
                    </s-table-cell>
                    <s-table-cell>
                      <s-text color="subdued">{formatQty(p.totalInventory)}</s-text>
                    </s-table-cell>
                  </s-table-row>
                ))
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
        <s-text-area
          label="Note"
          value={noteDraftText}
          rows={6}
          placeholder="Type your note…"
          onInput={(e: any) => setNoteDraftText(e.currentTarget.value)}
        />
        <s-button
          slot="primary-action"
          variant="primary"
          commandFor="note-modal"
          command="--hide"
          onClick={saveNoteObject}
        >
          Save
        </s-button>
        <s-button
          slot="secondary-actions"
          variant="tertiary"
          disabled={productSearch.trim() === ''}
          onClick={appendSearchToNote}
        >
          Add search to note
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
}

export default (): void => render(<Extension />, document.body);

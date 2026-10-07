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

// Session 24: total variant count across a (possibly unopened) public selection's stored product
// entries, for the "(v/n)" count shown in the Selections menu (see formatSelectionCount). An entry's
// own `variantIds` is authoritative when present (an explicit narrowed count, no product hydration
// needed). Otherwise it means "every variant," so the count falls back to the product's cached full
// variant list in `allLoadedProducts` (the same session-wide cache productMatchesQuery already
// searches) -- best-effort only: a product this session has never loaded (never browsed/searched)
// isn't in that cache yet, and its true variant count can't be known without fetching it, so it
// counts as 1 rather than blocking the menu label on a network round trip.
function selectionEntriesVariantCount(
  entries: SelectionEntry[],
  allLoadedProducts: Record<string, ProductData>,
): number {
  return entries.reduce((sum, entry) => {
    if (entry.variantIds && entry.variantIds.length > 0) {
      return sum + entry.variantIds.length;
    }
    const product = allLoadedProducts[entry.id];
    if (product && product.allVariants && product.allVariants.length > 0) {
      return sum + product.allVariants.length;
    }
    return sum + 1;
  }, 0);
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


import { render } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
interface VariantData {
  id: string;
  title: string;
  sku: string | null;
  price: string | null;
  compareAtPrice: string | null;
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
  variants: VariantData[];
  allVariants: VariantData[];
  metafields: MetafieldData[];
  note: string;
}
type FileBreak = 'selection' | 'object' | 'product' | 'note' | 'variant';
interface TemplateData {
  id: string;
  title: string;
  body: string;
  extension: string;
  pinned: boolean;
  pinnedAt: number | null;
  fileBreak: FileBreak | null;
  mergeCondition: string;
}
type BulkSelectMode = 'shown' | 'in-stock';
interface PageInfo {
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  startCursor: string | null;
  endCursor: string | null;
}
interface SelectionEntry {
  id: string;
  note: string;
  variantIds?: string[];
}
function isStandaloneNote(entry: SelectionEntry): boolean {
  return !entry.id.startsWith('gid://');
}
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
const SHARD_MAX_BYTES = 122880;
const LEGACY_NAMESPACE = 'sidekick';
const LEGACY_KEY = 'templates';
const STORAGE_FULL_MESSAGE = 'Template storage is full. Delete some templates before saving.';
const BYTES_PER_KB = 1024;
const PAGE_SIZE = 25;
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
const SELECTION_MAX_PRODUCTS = 4000;
const SELECTION_FETCH_CHUNK = 50;
interface GlobalVarEntry {
  id: string;
  title: string;
  body: string;
}
function generateGlobalVarId(): string {
  return `global-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
function parseGlobalVars(rawValue: any): GlobalVarEntry[] {
  if (rawValue == null || rawValue === '') return [];
  try {
    const parsed = JSON.parse(rawValue);
    if (!Array.isArray(parsed)) return [];
    const list: GlobalVarEntry[] = [];
    for (const item of parsed) {
      if (item && typeof item.title === 'string') {
        list.push({
          id: typeof item.id === 'string' && item.id ? item.id : generateGlobalVarId(),
          title: item.title,
          body: typeof item.body === 'string' ? item.body : '',
        });
      }
    }
    return list;
  } catch {
    return [];
  }
}
const GLOBALS_KEY = 'globals';
const GLOBALS_READ_QUERY = `query ReadGlobals($ns: String!, $key: String!) {
  shop {
    id
    globals: metafield(namespace: $ns, key: $key) { value }
  }
}`;
const HISTORY_KEY = 'history_log';
const HISTORY_SAFE_BYTES = 122880;
const HISTORY_MAX_ENTRIES = 4000;
const HISTORY_MAX_TAGS_PER_ENTRY = 20;
const HISTORY_TAG_REGEX = /\{\{[^{}]*\}\}/g;
function historyDate(date: Date): string {
  return formatDateTime(date, 'MM/dd/yyyy HH:mm:ss');
}
function appendHistoryTag(note: string, tag: string): string {
  return note ? `${note} ${tag}` : tag;
}
function capHistoryTags(note: string, maxTags: number): string {
  const tags = note.match(HISTORY_TAG_REGEX);
  if (!tags || tags.length <= maxTags) return note;
  let result = note;
  for (let i = 0; i < tags.length - maxTags; i++) {
    result = result.replace(tags[i], '');
  }
  return result.replace(/ {2,}/g, ' ').trim();
}
function enforceHistoryCap(entries: SelectionEntry[]): SelectionEntry[] {
  let next = entries;
  while (next.length > 0 && JSON.stringify(next).length > HISTORY_SAFE_BYTES) {
    next = next.slice(1);
  }
  if (next.length > HISTORY_MAX_ENTRIES) {
    next = next.slice(next.length - HISTORY_MAX_ENTRIES);
  }
  return next;
}
interface HistoryTouch {
  id: string;
  baseNote: string;
  tag: string;
}
function applyHistoryTouches(current: SelectionEntry[], touches: HistoryTouch[]): SelectionEntry[] {
  const byId = new Map(current.map((e): [string, SelectionEntry] => [e.id, e]));
  const order = current.map((e) => e.id);
  for (const touch of touches) {
    const existing = byId.get(touch.id);
    const baseNote = existing ? existing.note : touch.baseNote;
    byId.set(touch.id, {
      id: touch.id,
      note: capHistoryTags(appendHistoryTag(baseNote, touch.tag), HISTORY_MAX_TAGS_PER_ENTRY),
    });
    if (!existing) order.push(touch.id);
  }
  return enforceHistoryCap(order.map((id) => byId.get(id)!));
}
function appendHistoryLogNote(current: SelectionEntry[], text: string): SelectionEntry[] {
  return enforceHistoryCap([...current, createNoteEntry(text)]);
}
const SUBTITLE_MAX_LENGTH = 16;
const SUBTITLES_KEY = 'sel_subtitles';
type SelectionSlotId =
  | 'current'
  | 'public_1'
  | 'public_2'
  | 'public_3'
  | 'public_4'
  | 'public_5'
  | 'public_6';
type PublicSelectionSlotId = Exclude<SelectionSlotId, 'current'>;
const PUBLIC_SLOTS: PublicSelectionSlotId[] = [
  'public_1',
  'public_2',
  'public_3',
  'public_4',
  'public_5',
  'public_6',
];
function selectionSlotLabel(slot: SelectionSlotId): string {
  if (slot === 'current') return 'Current Selection';
  return `Public Selection ${slot.slice(-1)}`;
}
function selectionMetafieldKey(slot: SelectionSlotId): string | null {
  if (slot === 'current') return null;
  return `sel_public_${slot.slice(-1)}`;
}
const SELECTIONS_READ_QUERY = `query ReadSelections($ns: String!, $pub1: String!, $pub2: String!, $pub3: String!, $pub4: String!, $pub5: String!, $pub6: String!, $subs: String!, $hist: String!, $globals: String!) {
  shop {
    id
    pub1: metafield(namespace: $ns, key: $pub1) { value }
    pub2: metafield(namespace: $ns, key: $pub2) { value }
    pub3: metafield(namespace: $ns, key: $pub3) { value }
    pub4: metafield(namespace: $ns, key: $pub4) { value }
    pub5: metafield(namespace: $ns, key: $pub5) { value }
    pub6: metafield(namespace: $ns, key: $pub6) { value }
    subs: metafield(namespace: $ns, key: $subs) { value }
    hist: metafield(namespace: $ns, key: $hist) { value }
    globals: metafield(namespace: $ns, key: $globals) { value }
  }
}`;
const HISTORY_READ_QUERY = `query ReadHistory($ns: String!, $key: String!) {
  shop {
    id
    hist: metafield(namespace: $ns, key: $key) { value }
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
function generateNoteId(): string {
  return `note-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
function createNoteEntry(note: string): SelectionEntry {
  return { id: generateNoteId(), note };
}
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
function noteMatchesQuery(entry: SelectionEntry, rawQuery: string): boolean {
  const query = rawQuery.trim().toLowerCase();
  if (query === '') return true;
  return (entry.note || '').toLowerCase().includes(query);
}
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
    note: '',
  };
}
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
function generateTemplateId(title: string): string {
  const random = Math.random().toString(36).slice(2, 8);
  return `${slugify(title)}-${Date.now().toString(36)}-${random}`;
}
const FILE_BREAK_VALUES: FileBreak[] = ['selection', 'object', 'product', 'note', 'variant'];
const FILE_BREAK_LABELS: Record<FileBreak, string> = {
  selection: 'Selection (one file)',
  object: 'Object (product or note)',
  product: 'Product',
  note: 'Note',
  variant: 'Variant',
};
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
function serializeTemplateEntry(t: TemplateData): string {
  return JSON.stringify({
    id: t.id,
    title: t.title,
    body: t.body,
    extension: t.extension,
    pinned: t.pinned === true,
    pinnedAt: t.pinned === true ? (t.pinnedAt ?? null) : null,
    fileBreak: t.fileBreak,
    mergeCondition: t.mergeCondition,
  });
}
function serializeTemplates(list: TemplateData[]): string {
  return `[${list.map(serializeTemplateEntry).join(',')}]`;
}
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
      const candidateContentBytes =
        shardContentBytes[shardIndex] + entryBytes + (isFirstInShard ? 0 : 1);
      if (candidateContentBytes + 2 <= SHARD_MAX_BYTES) {
        shards[shardIndex].push(template);
        shardContentBytes[shardIndex] = candidateContentBytes;
        break;
      }
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
function storageShortfallKb(list: TemplateData[]): number {
  const capacity = SHARD_COUNT * SHARD_MAX_BYTES;
  const shortfall = byteLength(serializeTemplates(list)) - capacity;
  if (shortfall > 0) {
    return Math.ceil(shortfall / BYTES_PER_KB);
  }
  return Math.ceil(SHARD_MAX_BYTES / BYTES_PER_KB);
}
function storageFullMessage(list: TemplateData[]): string {
  return `${STORAGE_FULL_MESSAGE} Add ${storageShortfallKb(list)} KB of storage.`;
}
function formatQty(totalInventory: number | null): string {
  return totalInventory == null ? '—' : String(totalInventory);
}
function globalVarBodyPreview(body: string): string {
  const collapsed = body.replace(/\s+/g, ' ').trim();
  return collapsed.length > 80 ? `${collapsed.slice(0, 80)}…` : collapsed;
}
function formatSelectionCount(variantCount: number, noteCount: number): string {
  return noteCount === 0 ? `(${variantCount})` : `(${variantCount}/${noteCount})`;
}
function adminProductUrl(productId: string, primaryDomain: string): string | null {
  if (!primaryDomain) return null;
  const match = /\/Product\/(\d+)$/.exec(productId);
  if (!match) return null;
  return `https://${primaryDomain}/admin/products/${match[1]}`;
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
const UNRESOLVED_VARIABLE_ERROR_PREFIX = 'UNRESOLVED_VARIABLE:';
function unresolvedVariableMarker(name: string): string {
  return `[[ unresolved variable "${name}" in equation -- wrap it in double curly braces ]]`;
}
function containsUnresolvedVariableMarker(text: string): boolean {
  return text.includes('unresolved variable "');
}
function deprecatedSyntaxMarker(description: string): string {
  return `[[ deprecated syntax removed -- ${description} ]]`;
}
function globalReadOnlyMarker(name: string): string {
  return `[[ global variable "${name}" is read-only in a template -- change its value in Settings under Global Vars instead ]]`;
}
function globalUndefinedMarker(name: string): string {
  return `[[ no global variable named "${name}" is defined -- add one in Settings under Global Vars ]]`;
}
function globalNotExpandedMarker(name: string): string {
  return `[[ global variable "${name}" was not expanded here -- a global cannot reference another global yet ]]`;
}
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
  'break',
  'skip',
  'tag',
  'time',
  'replace',
  'replacement',
]);
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
const IDENTIFIER_REGEX = /^[^\s{}.=<>!&|,()]+$/;
const ASSIGNMENT_REGEX = /^([^\s{}.=<>!&|,()]+)\s*=(?!=)/;
const LENGTH_PREFIX_REGEX = /^length\s*=/;
const TIME_PREFIX_REGEX = /^time\s*=/;
function isVariableName(key: string): boolean {
  return IDENTIFIER_REGEX.test(key) && !RESERVED_ASSIGNMENT_NAMES.has(key.toLowerCase());
}
const COMMENT_REGEX = /\{\{\s*#comment\s*\}\}[\s\S]*?\{\{\s*\/comment\s*\}\}/g;
function stripComments(body: string): string {
  return body.replace(COMMENT_REGEX, '');
}
const SELECTION_OBJECT_REFERENCE_MARKERS = [
  'product.',
  'products.',
  'variant.',
  'variants.',
  'mf.',
  'notes.foreach',
  'selection.foreach',
  'tags.foreach',
  'metafields.foreach',
  'selection.first',
  'selection.last',
  'selection.curr',
  'selection.next',
  'selection.prev',
];
function templateNeedsSelectionObjects(body: string): boolean {
  const stripped = stripComments(body);
  return SELECTION_OBJECT_REFERENCE_MARKERS.some((marker) => stripped.includes(marker));
}
const GLOBAL_PREFIX = '$global:';
const GLOBAL_READ_REGEX = /\{\{\s*\$global:([^\s{}.=<>!&|,()]+)\s*\}\}/g;
function spliceGlobalVariables(body: string, globalBodiesByTitle: Record<string, string>): string {
  return body.replace(GLOBAL_READ_REGEX, (_match: string, name: string) =>
    Object.prototype.hasOwnProperty.call(globalBodiesByTitle, name)
      ? globalBodiesByTitle[name]
      : globalUndefinedMarker(name),
  );
}
const BACKSLASH = String.fromCharCode(92);
const WS = BACKSLASH + 's*';
const OPEN = BACKSLASH + '{' + BACKSLASH + '{';
const CLOSE = BACKSLASH + '}' + BACKSLASH + '}';
const RETURN_TOKEN_PATTERN = OPEN + WS + '/return' + WS + CLOSE;
const SPACE_ALIAS_TOKEN_PATTERN = OPEN + WS + '/space' + WS + CLOSE;
const NEWLINE_TOKEN_PATTERN = OPEN + WS + BACKSLASH + BACKSLASH + 'n' + WS + CLOSE;
const SPACE_TOKEN_PATTERN = OPEN + WS + BACKSLASH + BACKSLASH + 't' + WS + CLOSE;
const NEWLINE_SENTINEL = String.fromCharCode(1);
const SPACE_SENTINEL = String.fromCharCode(2);
const BREAK_SENTINEL = String.fromCharCode(3);
const SKIP_SENTINEL = String.fromCharCode(4);
function applyWhitespaceTokens(body: string): string {
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
  return text.split(NEWLINE_SENTINEL).join(String.fromCharCode(10)).split(SPACE_SENTINEL).join(' ');
}
function applyWhitespaceControl(body: string): string {
  if (body.indexOf('{-{') === -1 && body.indexOf('}-}') === -1) return body;
  return body
    .replace(/(?:\r\n|\n|\r)[ \t]*\{-\{/g, '{{')
    .replace(/\{-\{/g, '{{')
    .replace(/\}-\}[ \t]*(?:\r\n|\n|\r)/g, '}}')
    .replace(/\}-\}/g, '}}');
}
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
function topLevelEqualsIndex(text: string): number {
  return scanTopLevel(text, (i, depth) => {
    if (depth !== 0 || text[i] !== '=') return false;
    const prev = i > 0 ? text[i - 1] : '';
    const next = text[i + 1] || '';
    return next !== '=' && prev !== '=' && prev !== '!' && prev !== '<' && prev !== '>';
  });
}
function topLevelLessThanIndex(text: string): number {
  return scanTopLevel(text, (i, depth) => depth === 0 && text[i] === '<');
}
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
function evaluateMathExpression(input: string): number {
  const tokens = tokenizeMath(input);
  let pos = 0;
  const peek = (): MathToken | undefined => tokens[pos];
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
      const msDigits = (pad(date.getMilliseconds(), 3) + '0000').slice(0, len);
      return letter === 'F' ? msDigits.replace(/0+$/, '') : msDigits;
    }
    case 'K':
    case 'z': {
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
function applyReplace(text: string, search: string, replacement: string): string {
  if (search === '') return text;
  return text.split(search).join(replacement);
}
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
function breakLineIntoRows(line: string, maxChars: number, maxWraps: number): string[] {
  if (line.length <= maxChars) {
    return [line];
  }
  const words = line.split(' ');
  const rows: string[] = [];
  let current = '';
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
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
function breakLineIntoHardChunks(line: string, maxChars: number, maxWraps: number): string[] {
  if (line.length <= maxChars) {
    return [line];
  }
  const chunks: string[] = [];
  let pos = 0;
  while (pos < line.length) {
    if (maxWraps > 0 && chunks.length === maxWraps - 1) {
      chunks.push(line.slice(pos));
      break;
    }
    chunks.push(line.slice(pos, pos + maxChars));
    pos += maxChars;
  }
  return chunks;
}
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
function parseWrapParams(rawParams: string): {
  maxChars: number;
  minWraps: number;
  maxWraps: number;
  delineator: string;
  hard: boolean;
} {
  const raw = String(rawParams);
  const delineatorMatch = raw.match(/delineator\s*=/);
  let numericPart = raw;
  let delineator = '';
  if (delineatorMatch && delineatorMatch.index != null) {
    numericPart = raw.slice(0, delineatorMatch.index);
    const valueStart = delineatorMatch.index + delineatorMatch[0].length;
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
function mediaTypeForExtension(ext: string): string {
  const e = ext.toLowerCase();
  if (e === 'json') return 'application/json';
  if (e === 'csv') return 'text/csv';
  if (e === 'html' || e === 'htm') return 'text/html';
  if (e === 'xml') return 'application/xml';
  return 'text/plain';
}
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
    pushUint16(localHeader, 20);
    pushUint16(localHeader, 0x0800);
    pushUint16(localHeader, 0);
    pushUint16(localHeader, 0);
    pushUint16(localHeader, 0);
    pushUint32(localHeader, crc);
    pushUint32(localHeader, size);
    pushUint32(localHeader, size);
    pushUint16(localHeader, nameBytes.length);
    pushUint16(localHeader, 0);
    const localHeaderBytes = new Uint8Array(localHeader);
    localParts.push(localHeaderBytes, nameBytes, dataBytes);
    const centralHeader: number[] = [];
    pushUint32(centralHeader, 0x02014b50);
    pushUint16(centralHeader, 20);
    pushUint16(centralHeader, 20);
    pushUint16(centralHeader, 0x0800);
    pushUint16(centralHeader, 0);
    pushUint16(centralHeader, 0);
    pushUint16(centralHeader, 0);
    pushUint32(centralHeader, crc);
    pushUint32(centralHeader, size);
    pushUint32(centralHeader, size);
    pushUint16(centralHeader, nameBytes.length);
    pushUint16(centralHeader, 0);
    pushUint16(centralHeader, 0);
    pushUint16(centralHeader, 0);
    pushUint16(centralHeader, 0);
    pushUint32(centralHeader, 0);
    pushUint32(centralHeader, offset);
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
  pushUint16(end, 0);
  pushUint16(end, 0);
  pushUint16(end, entries.length);
  pushUint16(end, entries.length);
  pushUint32(end, centralSize);
  pushUint32(end, centralOffset);
  pushUint16(end, 0);
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
function expandProductToRows(product: ProductData): ProductData[] {
  if (!product.variants || product.variants.length <= 1) {
    return [product];
  }
  return product.variants.map((variant) => ({ ...product, variants: [variant] }));
}
function expandSelectionToRows(products: ProductData[]): ProductData[] {
  const rows: ProductData[] = [];
  for (const product of products) {
    for (const row of expandProductToRows(product)) {
      rows.push(row);
    }
  }
  return rows;
}
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
function noteFileSlug(entry: SelectionEntry): string {
  return slugify(entry.note.slice(0, 40));
}
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
  {
    key: 'compareAtPrice',
    label: 'Compare at price',
    resolve: (p) => p.variants[0]?.compareAtPrice || '',
  },
  { key: 'costPerItem', label: 'Cost per item', resolve: (p) => p.variants[0]?.costPerItem || '' },
  { key: 'currencyCode', label: 'Currency code', resolve: (p) => p.currencyCode },
  { key: 'createdAt', label: 'Created at', resolve: (p) => p.createdAt },
  { key: 'updatedAt', label: 'Updated at', resolve: (p) => p.updatedAt },
  { key: 'note', label: 'Product note', aliases: ['notes'], resolve: (p) => p.note || '' },
];
const PRODUCT_FIELD_TOKENS: { token: string; label: string }[] = PRODUCT_FIELD_DEFS.map((f) => ({
  token: `{{ product.${f.key} }}`,
  label: f.label,
}));
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
const IF_BLOCK = '{{ #if={{ =0 }} }}\n{{ /if }}';
const CHOP_BLOCK = '{{ #chop={{ {{j}}==3 }}, direction=L, j=1 }}\n{{/chop}}';
const LENGTH_TOKEN = '{{ #length }}{{ product.title }}{{/length}}';
const DATE_TOKEN = '{{ time=MM/dd/yyyy }}';
const TIME_TOKEN = '{{ time=h:mm tt }}';
const DATE_TIME_TOKEN = '{{ time=MM/dd/yyyy h:mm tt }}';
const WEEKDAY_DATE_TOKEN = '{{ time=dddd, MMMM d, yyyy }}';
const REPEAT_BLOCK = '{{ #repeat=2, delineator= }}\n{{/repeat}}';
const REPLACE_BLOCK = '{{ #replace=SEARCH, replacement=REPLACEMENT }}\n{{/replace}}';
const WHILE_BLOCK = '{{ x = 1 }}\n{{ #while={{x}}<5 }}\n{{ x = {{ ={{x}}+1 }} }}\n{{/while}}';
const INDEX_BLOCK = '{{ #index=0 }}\n{{/index}}';
const INSERT_BLOCK = '{{ #insert=0, drop=FALSE }}\n{{/insert}}';
const VARIANT_LOOP_BLOCK =
  '{{ #variants.foreach v, l=0 }}\n{{ variant.title }}\n{{/variants.foreach}}';
const NOTES_LOOP_BLOCK = '{{ #notes.foreach note, i=0 }}\n{{ product.note }}\n{{/notes.foreach}}';
const TAGS_LOOP_BLOCK = '{{ #tags.foreach tag, i=0 }}\n{{ tag }}\n{{/tags.foreach}}';
const METAFIELDS_LOOP_BLOCK =
  '{{ #metafields.foreach mf, i=0 }}\n{{ mf.namespace }}.{{ mf.key }}: {{ mf.value }}\n{{/metafields.foreach}}';
const BOOLEAN_TOKEN = '{{ TRUE != FALSE }}';
const BREAK_TOKEN_BLOCK = '{{ #if={{ =0 }} }}\n{{ break }}\n{{ /if }}';
const SKIP_TOKEN_BLOCK = '{{ #if={{ =0 }} }}\n{{ skip }}\n{{ /if }}';
const WRAP_BLOCK = '{{#wrap=80, min_wraps=0, max_wraps=0, hard=FALSE, delineator=}}\n{{/wrap}}';
const COMMENT_BLOCK = '{{ #comment }}\n\n{{ /comment }}';
const NEWLINE_TOKEN_SNIPPET = '{{ /return }}';
const SPACE_TOKEN_SNIPPET = '{{ /space }}';
const VARIABLE_NAMES = ['i', 'j', 'k', 'l', 'x', 'y', 'z'];
const ASSIGN_TOKEN = '{{ x = }}';
const ASSIGN_TOKEN_DOLLAR = '{{ $x = }}';
const TRIM_BEFORE_SNIPPET = '{-{ product.title }}';
const TRIM_AFTER_SNIPPET = '{{ product.title }-}';
type RowKind = 'product' | 'variant' | 'note';
interface KindedRow {
  row: ProductData;
  kind: RowKind;
}
interface Scope {
  row: ProductData;
  variants: VariantData[];
}
const scopeOf = (row: ProductData): Scope => ({ row, variants: row.variants });
interface Operand {
  nodes: Node[];
  constant: string | null;
  pre?: { num: number | null; str: string };
}
type Cond =
  | { c: 'or' | 'and'; parts: Cond[] }
  | { c: 'not'; x: Cond }
  | { c: 'cmp'; op: '==' | '!=' | '<' | '>' | '<=' | '>='; l: Operand; r: Operand }
  | { c: 'truthy'; x: Operand }
  | { c: 'bad' };
interface FieldNode {
  k: 'field';
  resolve: (ctx: Ctx, sc: Scope) => string;
}
interface IfNode {
  k: 'if';
  cond: Cond;
  condText: string;
  then: Node[];
  otherwise: Node[] | null;
}
interface ChopNode {
  k: 'chop';
  cond: Cond | null;
  direction: 'L' | 'R';
  counter: string;
  start: Node[] | null;
  body: Node[];
}
interface RepeatNode {
  k: 'repeat';
  count: Node[];
  delineator: string;
  body: Node[];
}
interface ReplaceNode {
  k: 'replace';
  search: Node[];
  replacement: Node[];
  body: Node[];
}
interface IndexNode {
  k: 'index';
  position: Node[];
  body: Node[];
}
interface InsertNode {
  k: 'insert';
  position: Node[];
  drop: boolean;
  body: Node[];
}
interface WhileNode {
  k: 'while';
  cond: Cond | null;
  deprecated: boolean;
  body: Node[];
}
interface VariantLoopNode {
  k: 'variants';
  name: string;
  start: Node[] | null;
  deprecatedTied: boolean;
  body: Node[];
}
interface TagsLoopNode {
  k: 'tags';
  name: string;
  start: Node[] | null;
  body: Node[];
}
interface MetafieldsLoopNode {
  k: 'metafields';
  name: string;
  start: Node[] | null;
  body: Node[];
}
interface LengthNode {
  k: 'length';
  body: Node[];
}
interface WrapNode {
  k: 'wrap';
  valid: boolean;
  maxChars: number;
  minWraps: number;
  maxWraps: number;
  delineator: string;
  hard: boolean;
  body: Node[];
}
type ForeachKind = 'rows' | 'notes' | 'object';
interface ForeachNode {
  k: 'foreach';
  kind: ForeachKind;
  skipFirst: boolean;
  skipLast: boolean;
  name: string;
  start: Node[] | null;
  deprecatedChunk: boolean;
  body: Node[];
}
type Node =
  | { k: 'text'; s: string }
  | { k: 'empty' }
  | { k: 'math'; expr: Node[] }
  | { k: 'time'; fmt: Node[] }
  | { k: 'assign'; name: string; value: Node[] }
  | { k: 'bool'; cond: Cond }
  | FieldNode
  | { k: 'ctl'; v: 1 | 2 }
  | IfNode
  | ChopNode
  | RepeatNode
  | ReplaceNode
  | IndexNode
  | InsertNode
  | WhileNode
  | VariantLoopNode
  | TagsLoopNode
  | MetafieldsLoopNode
  | LengthNode
  | WrapNode
  | ForeachNode;
interface Compiled {
  root: Node[];
  firstForeach: ForeachNode | null;
}
interface RenderEnv {
  rows: ProductData[];
  rowKind: RowKind;
  notes: SelectionEntry[];
  items: Map<ForeachKind, KindedRow[]>;
  filtered: Map<ForeachNode, KindedRow[]>;
}
interface Ctx {
  env: RenderEnv;
  vars: Map<string, string>;
  now: Date;
  primaryDomain: string;
  selectionLength: number;
  currKind: RowKind;
  prev: KindedRow | null;
  next: KindedRow | null;
  currentMetafield: MetafieldData | null;
  ctl: 0 | 1 | 2;
  sawMarker: boolean;
  steps: number;
  window: { node: ForeachNode; from: number; to: number } | null;
}
const PRODUCT_FIELD_RESOLVERS: Record<string, (product: ProductData) => string> = (() => {
  const map: Record<string, (product: ProductData) => string> = Object.create(null);
  for (const def of PRODUCT_FIELD_DEFS) {
    map[def.key] = def.resolve;
    for (const alias of def.aliases || []) map[alias] = def.resolve;
  }
  return map;
})();
const VARIANT_FIELD_RESOLVERS: Record<string, (variant: VariantData) => string> = (() => {
  const map: Record<string, (variant: VariantData) => string> = Object.create(null);
  for (const def of VARIANT_FIELD_DEFS) map[def.key] = def.resolve;
  return map;
})();
function productField(sc: Scope, field: string): string {
  if (field === 'compareAtPrice') return sc.variants[0]?.compareAtPrice || '';
  if (field === 'costPerItem') return sc.variants[0]?.costPerItem || '';
  const resolve = PRODUCT_FIELD_RESOLVERS[field];
  return resolve ? resolve(sc.row) : '';
}
function variantField(variant: VariantData | undefined, field: string): string {
  if (!variant) return '';
  const resolve = VARIANT_FIELD_RESOLVERS[field];
  return resolve ? resolve(variant) : '';
}
function metafieldValue(product: ProductData, namespace: string, key: string): string {
  const list: MetafieldData[] = product.metafields;
  for (let i = 0; i < list.length; i++) {
    const m = list[i];
    if (m.key === key && m.namespace === namespace) return m.value || '';
  }
  return '';
}
function retiredDate(parts: string[]): string | null {
  if (parts.length === 1) {
    if (parts[0] === 'day') return deprecatedSyntaxMarker('the bare day token is retired -- use the time=dd token instead');
    if (parts[0] === 'month') return deprecatedSyntaxMarker('the bare month token is retired -- use the time=MM token instead');
    if (parts[0] === 'year') return deprecatedSyntaxMarker('the bare year token is retired -- use the time=yyyy token instead');
    return null;
  }
  if (parts.length === 2) {
    if (parts[0] === 'day' && parts[1] === 'week') return deprecatedSyntaxMarker('the day.week token is retired -- use the time=ddd token instead');
    if (parts[0] === 'month' && parts[1] === 'name') return deprecatedSyntaxMarker('the month.name token is retired -- use the time=MMM token instead');
    if (parts[0] === 'year' && parts[1] === 'short') return deprecatedSyntaxMarker('the year.short token is retired -- use the time=yy token instead');
  }
  return null;
}
function resolveParts(sc: Scope, parts: string[], ctx: Ctx): string {
  if (parts.length === 1) {
    const stored = ctx.vars.get(parts[0]);
    if (stored !== undefined) return stored;
    if (parts[0].indexOf(GLOBAL_PREFIX) === 0) return globalNotExpandedMarker(parts[0].slice(GLOBAL_PREFIX.length));
  }
  if (parts.length === 2 && parts[0] === 'mf') {
    const mf = ctx.currentMetafield;
    if (!mf) return '';
    if (parts[1] === 'namespace') return mf.namespace;
    if (parts[1] === 'key') return mf.key;
    if (parts[1] === 'value') return mf.value;
    return '';
  }
  if (parts.length === 2 && parts[0] === 'product' && parts[1] === 'length') {
    const list = sc.row.allVariants && sc.row.allVariants.length > 0 ? sc.row.allVariants : sc.variants;
    return String(list ? list.length : 0);
  }
  if (parts.length === 2 && parts[0] === 'products' && (parts[1] === 'note' || parts[1] === 'notes')) {
    return sc.row.note || '';
  }
  if (parts.length === 1 && parts[0] === 'primaryDomain') return ctx.primaryDomain;
  const retired = retiredDate(parts);
  if (retired !== null) return retired;
  if (parts.length === 2 && parts[0] === 'selection' && parts[1] === 'length') return String(ctx.selectionLength);
  if (parts[0] === 'product' && parts[1] === 'metafield' && parts.length >= 4) {
    return metafieldValue(sc.row, parts[2], parts.slice(3).join('.'));
  }
  if (parts[0] === 'product' && parts.length === 2) return productField(sc, parts[1]);
  if (parts[0] === 'variant' && parts.length === 2) return variantField(sc.variants[0], parts[1]);
  return '';
}
function resolveSelection(parts: string[], ctx: Ctx, sc: Scope): string {
  const slot = parts[1];
  const rows = ctx.env.rows;
  let target: Scope;
  if (slot === 'first' || slot === 'last') {
    const list = rows.length > 0 ? rows : [sc.row];
    target = scopeOf(slot === 'first' ? list[0] : list[list.length - 1]);
  } else {
    let kind;
    if (slot === 'curr') {
      target = sc;
      kind = ctx.currKind;
    } else {
      const neighbor = slot === 'next' ? ctx.next : ctx.prev;
      if (!neighbor) return '';
      target = scopeOf(neighbor.row);
      kind = neighbor.kind;
    }
    if (parts[2] === 'type' && parts.length === 3) return kind;
  }
  const rest = parts.slice(2);
  if (rest.length === 1 && rest[0] === 'note') return target.row.note || '';
  return resolveParts(target, rest, ctx);
}
function compileField(trimmed: string): (ctx: Ctx, sc: Scope) => string {
  const parts = trimmed.split('.');
  const head = parts[0];
  if (head === 'selection' && (parts[1] === 'first' || parts[1] === 'last' || parts[1] === 'curr' || parts[1] === 'next' || parts[1] === 'prev')) {
    return (ctx, sc) => resolveSelection(parts, ctx, sc);
  }
  if (parts.length === 1) {
    return (ctx, sc) => {
      const stored = ctx.vars.get(head);
      return stored !== undefined ? stored : resolveParts(sc, parts, ctx);
    };
  }
  if (parts.length === 2 && head === 'product' && parts[1] !== 'length') {
    const field = parts[1];
    if (field === 'compareAtPrice' || field === 'costPerItem') return (_ctx, sc) => productField(sc, field);
    const resolve = PRODUCT_FIELD_RESOLVERS[field];
    return resolve ? (_ctx, sc) => resolve(sc.row) : () => '';
  }
  if (parts.length === 2 && head === 'variant') {
    const resolve = VARIANT_FIELD_RESOLVERS[parts[1]];
    return resolve ? (_ctx, sc) => (sc.variants[0] ? resolve(sc.variants[0]) : '') : () => '';
  }
  if (head === 'product' && parts[1] === 'metafield' && parts.length >= 4) {
    const ns = parts[2];
    const key = parts.slice(3).join('.');
    return (_ctx, sc) => metafieldValue(sc.row, ns, key);
  }
  return (ctx, sc) => resolveParts(sc, parts, ctx);
}
type LexItem = { text: string } | { inner: string };
function lex(text: string): LexItem[] {
  const items: LexItem[] = [];
  let i = 0;
  let last = 0;
  while (i < text.length) {
    const open = text.indexOf('{{', i);
    if (open === -1) break;
    const close = findMatchingClose(text, open);
    if (close === -1) {
      i = open + 1;
      continue;
    }
    if (open > last) items.push({ text: text.slice(last, open) });
    items.push({ inner: text.slice(open + 2, close - 2) });
    i = close;
    last = close;
  }
  if (last < text.length) items.push({ text: text.slice(last) });
  return items;
}
function pushNode(seq: Node[], node: Node): void {
  const prev = seq[seq.length - 1];
  if (node.k === 'text' && prev && prev.k === 'text') {
    seq[seq.length - 1] = { k: 'text', s: prev.s + node.s };
  } else if (node.k !== 'text' || node.s !== '') {
    seq.push(node);
  }
}
function parseInline(text: string): Node[] {
  const out: Node[] = [];
  for (const item of lex(text)) {
    if ('text' in item) pushNode(out, { k: 'text', s: item.text });
    else pushNode(out, makeToken(item.inner));
  }
  return out;
}
function numeric(expr: string): Node[] | null {
  const trimmed = expr.trim();
  return trimmed === '' ? null : parseInline(trimmed);
}
function operand(text: string): Operand {
  const nodes = parseInline(text);
  const constant = nodes.every((n) => n.k === 'text') ? nodes.map((n) => (n as { s: string }).s).join('') : null;
  return { nodes, constant };
}
const BAD: Cond = { c: 'bad' };
function scanStatic(text: string, visit: (i: number, depth: number) => boolean): number {
  let depth = 0;
  let i = 0;
  while (i < text.length) {
    if (text[i] === '{' && text[i + 1] === '{') {
      const end = findMatchingClose(text, i);
      if (end !== -1) {
        i = end;
        continue;
      }
    }
    const ch = text[i];
    if (ch === '(') {
      depth += 1;
    } else if (ch === ')') {
      if (depth > 0) depth -= 1;
    } else if (visit(i, depth)) {
      return i;
    }
    i += 1;
  }
  return -1;
}
function splitStatic(expr: string, op: string): string[] {
  const parts: string[] = [];
  let last = 0;
  let skipUntil = -1;
  scanStatic(expr, (i, depth) => {
    if (i < skipUntil) return false;
    if (depth === 0 && expr.startsWith(op, i)) {
      parts.push(expr.slice(last, i));
      last = i + op.length;
      skipUntil = last;
    }
    return false;
  });
  parts.push(expr.slice(last));
  return parts;
}
function isFullyParenthesized(expr: string): boolean {
  if (expr[0] !== '(' || expr[expr.length - 1] !== ')') return false;
  let depth = 0;
  let i = 0;
  while (i < expr.length) {
    if (expr[i] === '{' && expr[i + 1] === '{') {
      const end = findMatchingClose(expr, i);
      if (end !== -1) {
        i = end;
        continue;
      }
    }
    if (expr[i] === '(') depth += 1;
    else if (expr[i] === ')') {
      depth -= 1;
      if (depth === 0 && i < expr.length - 1) return false;
    }
    i += 1;
  }
  return depth === 0;
}
function findComparison(expr: string): { op: '==' | '!=' | '<' | '>' | '<=' | '>='; at: number; len: number } | null {
  let found: { op: '==' | '!=' | '<' | '>' | '<=' | '>='; at: number; len: number } | null = null;
  scanStatic(expr, (i, depth) => {
    if (depth !== 0) return false;
    const two = expr.slice(i, i + 2);
    if (two === '<=' || two === '>=' || two === '==' || two === '!=') {
      found = { op: two, at: i, len: 2 };
      return true;
    }
    if (expr[i] === '<' || expr[i] === '>') {
      found = { op: expr[i] as '<' | '>', at: i, len: 1 };
      return true;
    }
    return false;
  });
  return found;
}
function parseCond(raw: string): Cond {
  const t = raw.trim();
  if (t === '') return BAD;
  const or = splitStatic(t, '||');
  if (or.length > 1) return { c: 'or', parts: or.map(parseCond) };
  const and = splitStatic(t, '&&');
  if (and.length > 1) return { c: 'and', parts: and.map(parseCond) };
  if (t[0] === '!' && t.slice(0, 2) !== '!=') return { c: 'not', x: parseCond(t.slice(1)) };
  if (isFullyParenthesized(t)) return parseCond(t.slice(1, -1));
  const cmp = findComparison(t);
  if (cmp) {
    return { c: 'cmp', op: cmp.op, l: operand(t.slice(0, cmp.at)), r: operand(t.slice(cmp.at + cmp.len)) };
  }
  return { c: 'truthy', x: operand(t) };
}
function textNode(s: string): Node {
  return { k: 'text', s };
}
function makeToken(inner: string): Node {
  const trimmed = inner.trim();
  if (trimmed === '') return { k: 'empty' };
  if (trimmed[0] === '#' || trimmed[0] === '/') return textNode('{{' + inner + '}}');
  if (trimmed === 'break') return { k: 'ctl', v: 2 };
  if (trimmed === 'skip') return { k: 'ctl', v: 1 };
  if (trimmed[0] === '=') return { k: 'math', expr: parseInline(trimmed.slice(1)) };
  if (LENGTH_PREFIX_REGEX.test(trimmed)) {
    return textNode(deprecatedSyntaxMarker('the length=STRING token is retired -- use {{ #length }}STRING{{ /length }} instead'));
  }
  const timeMatch = TIME_PREFIX_REGEX.exec(trimmed);
  if (timeMatch) return { k: 'time', fmt: parseInline(trimmed.slice(timeMatch[0].length)) };
  const assign = ASSIGNMENT_REGEX.exec(trimmed);
  if (assign) {
    if (assign[1].indexOf(GLOBAL_PREFIX) === 0) return textNode(globalReadOnlyMarker(assign[1].slice(GLOBAL_PREFIX.length)));
    if (!RESERVED_ASSIGNMENT_NAMES.has(assign[1].toLowerCase())) {
      return { k: 'assign', name: assign[1], value: parseFull(trimmed.slice(assign[0].length)).root };
    }
  }
  if (hasBooleanOperator(trimmed)) return { k: 'bool', cond: parseCond(trimmed) };
  return { k: 'field', resolve: compileField(trimmed) };
}
type Family =
  | 'if'
  | 'chop'
  | 'repeat'
  | 'replace'
  | 'while'
  | 'index'
  | 'insert'
  | 'wrap'
  | 'variants'
  | 'tags'
  | 'metafields'
  | 'length'
  | 'selection'
  | 'products'
  | 'notes';
const OPENERS: { re: RegExp; fam: Family }[] = [
  { re: /^#if=/, fam: 'if' },
  { re: /^#(?:chop|trim)=/, fam: 'chop' },
  { re: /^#repeat=/, fam: 'repeat' },
  { re: /^#replace=/, fam: 'replace' },
  { re: /^#?while=/, fam: 'while' },
  { re: /^#index=/, fam: 'index' },
  { re: /^#insert=/, fam: 'insert' },
  { re: /^#wrap=/, fam: 'wrap' },
  { re: /^#(?:variants?\.foreach(?:\s+[^\s,{}]+)?|product\.foreach)/, fam: 'variants' },
  { re: /^#tags\.foreach(?:\s+[^\s,{}]+)?/, fam: 'tags' },
  { re: /^#metafields\.foreach(?:\s+[^\s,{}]+)?/, fam: 'metafields' },
  { re: /^#length\b/, fam: 'length' },
  { re: /^#selection\.foreach(?:\s+[^\s,{}]+)?/, fam: 'selection' },
  { re: /^#products\.foreach(?:\s+[^\s,{}]+)?/, fam: 'products' },
  { re: /^#notes\.foreach(?:\s+[^\s,{}]+)?/, fam: 'notes' },
];
const CLOSERS: { re: RegExp; fam: Family }[] = [
  { re: /^\/if$/, fam: 'if' },
  { re: /^\/(?:chop|trim)$/, fam: 'chop' },
  { re: /^\/repeat$/, fam: 'repeat' },
  { re: /^\/replace$/, fam: 'replace' },
  { re: /^\/while$/, fam: 'while' },
  { re: /^\/index$/, fam: 'index' },
  { re: /^\/insert$/, fam: 'insert' },
  { re: /^\/wrap$/, fam: 'wrap' },
  { re: /^\/(?:variants?\.foreach|product\.foreach)$/, fam: 'variants' },
  { re: /^\/tags\.foreach$/, fam: 'tags' },
  { re: /^\/metafields\.foreach$/, fam: 'metafields' },
  { re: /^\/length$/, fam: 'length' },
  { re: /^\/selection\.foreach(?:\s+[^\s,{}]+)?$/, fam: 'selection' },
  { re: /^\/products\.foreach(?:\s+[^\s,{}]+)?$/, fam: 'products' },
  { re: /^\/notes\.foreach(?:\s+[^\s,{}]+)?$/, fam: 'notes' },
];
const SELECTION_FOREACH_KEYWORD = /^#selection\.foreach(?:\s+(product|products|object|objects|note|notes))?/i;
interface Frame {
  fam: Family;
  openInner: string;
  params: string;
  head: string;
  kids: Node[];
  elseInner: string | null;
  elseKids: Node[] | null;
}
function segmentsKV(raw: string, from = 0): { key: string; value: string }[] {
  const out: { key: string; value: string }[] = [];
  const segments = splitTopLevelCommas(raw);
  for (let k = from; k < segments.length; k++) {
    const eq = segments[k].indexOf('=');
    if (eq === -1) continue;
    out.push({ key: segments[k].slice(0, eq).trim(), value: segments[k].slice(eq + 1).trim() });
  }
  return out;
}
function counterParams(raw: string, defaultName: string): { name: string; start: Node[] | null; deprecatedTied: boolean } {
  let name = defaultName;
  let start: Node[] | null = null;
  let deprecatedTied = false;
  for (const { key, value } of segmentsKV(raw)) {
    if (key.toLowerCase() === 'tied') deprecatedTied = true;
    else if (isVariableName(key)) {
      name = key;
      start = numeric(value);
    }
  }
  return { name, start, deprecatedTied };
}
function buildChop(params: string, body: Node[]): ChopNode {
  const segments = splitTopLevelCommas(params);
  const condition = unwrapChopCondition(segments[0] || '');
  let direction: 'L' | 'R' = 'L';
  let counter = 'j';
  let start: Node[] | null = null;
  for (let k = 1; k < segments.length; k++) {
    const eq = segments[k].indexOf('=');
    if (eq === -1) continue;
    const key = segments[k].slice(0, eq).trim();
    const rawValue = segments[k].slice(eq + 1).trim();
    if (key.toLowerCase() === 'direction') direction = rawValue.toUpperCase() === 'R' ? 'R' : 'L';
    else if (isVariableName(key)) {
      counter = key;
      start = numeric(rawValue);
    }
  }
  return { k: 'chop', cond: condition.trim() === '' ? null : parseCond(condition), direction, counter, start, body };
}
function buildForeach(fam: Family, head: string, params: string, body: Node[]): ForeachNode {
  let kind: ForeachKind = 'rows';
  if (fam === 'notes') kind = 'notes';
  else if (fam === 'selection') {
    const keyword = head.match(SELECTION_FOREACH_KEYWORD)?.[1]?.toLowerCase();
    kind = keyword === 'object' || keyword === 'objects' ? 'object' : keyword === 'note' || keyword === 'notes' ? 'notes' : 'rows';
  }
  let skipFirst = false;
  let skipLast = false;
  let name = 'i';
  let startExpr = '0';
  let maxExpr = '';
  for (const segment of splitTopLevelCommas(params.replace(/^\s*,/, ''))) {
    const eq = topLevelEqualsIndex(segment);
    if (eq === -1) continue;
    const key = segment.slice(0, eq).trim();
    const value = segment.slice(eq + 1).trim();
    if (key === 'skip_first') skipFirst = value === 'TRUE';
    else if (key === 'skip_last') skipLast = value === 'TRUE';
    else if (isVariableName(key)) {
      name = key;
      const lt = topLevelLessThanIndex(value);
      if (lt === -1) startExpr = value;
      else {
        startExpr = value.slice(0, lt);
        maxExpr = value.slice(lt + 1);
      }
    }
  }
  return { k: 'foreach', kind, skipFirst, skipLast, name, start: numeric(startExpr), deprecatedChunk: maxExpr.trim() !== '', body };
}
function buildBlock(frame: Frame): Node {
  const { fam, params, kids } = frame;
  switch (fam) {
    case 'if': {
      const node: IfNode = { k: 'if', cond: parseCond(params), condText: params, then: kids, otherwise: frame.elseKids };
      return node;
    }
    case 'chop':
      return buildChop(params, kids);
    case 'repeat': {
      const delineatorMatch = params.match(/delineator\s*=/);
      let countPart = params;
      let delineator = '';
      if (delineatorMatch && delineatorMatch.index != null) {
        countPart = params.slice(0, delineatorMatch.index);
        delineator = params.slice(delineatorMatch.index + delineatorMatch[0].length).trim();
      }
      return { k: 'repeat', count: parseInline(countPart.replace(/,\s*$/, '').trim()), delineator, body: kids };
    }
    case 'replace': {
      const replacementMatch = params.match(/replacement\s*=/);
      let searchPart = params;
      let replacementPart = '';
      if (replacementMatch && replacementMatch.index != null) {
        searchPart = params.slice(0, replacementMatch.index);
        replacementPart = params.slice(replacementMatch.index + replacementMatch[0].length);
      }
      return {
        k: 'replace',
        search: parseInline(searchPart.replace(/,\s*$/, '').trim()),
        replacement: parseInline(replacementPart),
        body: kids,
      };
    }
    case 'index':
      return { k: 'index', position: parseInline(params.trim()), body: kids };
    case 'insert': {
      const segments = splitTopLevelCommas(params);
      let drop = false;
      for (let k = 1; k < segments.length; k++) {
        const eq = segments[k].indexOf('=');
        if (eq === -1) continue;
        if (segments[k].slice(0, eq).trim().toLowerCase() === 'drop') drop = segments[k].slice(eq + 1).trim().toUpperCase() === 'TRUE';
      }
      return { k: 'insert', position: parseInline((segments[0] || '').trim()), drop, body: kids };
    }
    case 'while': {
      const segments = splitTopLevelCommas(params);
      if (segments.length >= 2) return { k: 'while', cond: null, deprecated: true, body: kids };
      const condition = unwrapChopCondition(segments[0] || '');
      return { k: 'while', cond: condition.trim() === '' ? null : parseCond(condition), deprecated: false, body: kids };
    }
    case 'variants': {
      const { name, start, deprecatedTied } = counterParams(params, 'l');
      return { k: 'variants', name, start, deprecatedTied, body: kids };
    }
    case 'tags': {
      const { name, start } = counterParams(params, 'i');
      return { k: 'tags', name, start, body: kids };
    }
    case 'metafields': {
      const { name, start } = counterParams(params, 'i');
      return { k: 'metafields', name, start, body: kids };
    }
    case 'length':
      return { k: 'length', body: kids };
    case 'wrap': {
      const { maxChars, minWraps, maxWraps, delineator, hard } = parseWrapParams(params);
      const firstSegment = String(params).split(',')[0].trim();
      const valid = Number.isInteger(maxChars) && maxChars > 0 && firstSegment === String(maxChars);
      return { k: 'wrap', valid, maxChars, minWraps, maxWraps, delineator, hard, body: kids };
    }
    default:
      return buildForeach(fam, frame.head, params, kids);
  }
}
function parseFull(text: string): Compiled {
  const root: Node[] = [];
  const stack: Frame[] = [];
  const target = (): Node[] => {
    const top = stack[stack.length - 1];
    return top ? (top.elseKids ?? top.kids) : root;
  };
  const targetOf = (idx: number): Node[] => {
    const f = stack[idx - 1];
    return f ? (f.elseKids ?? f.kids) : root;
  };
  const unwind = (idx: number): void => {
    const frame = stack[idx];
    const into = targetOf(idx);
    pushNode(into, textNode('{{' + frame.openInner + '}}'));
    for (const n of frame.kids) pushNode(into, n);
    if (frame.elseKids) {
      pushNode(into, textNode('{{' + frame.elseInner + '}}'));
      for (const n of frame.elseKids) pushNode(into, n);
    }
  };
  for (const item of lex(text)) {
    if ('text' in item) {
      pushNode(target(), textNode(item.text));
      continue;
    }
    const inner = item.inner;
    const head = inner.replace(/^\s+/, '');
    const trimmed = inner.trim();
    if (head[0] === '#' || head.startsWith('while=')) {
      if (trimmed === '#else') {
        const top = stack[stack.length - 1];
        if (top && top.fam === 'if' && top.elseKids === null) {
          top.elseKids = [];
          top.elseInner = inner;
        } else {
          pushNode(target(), textNode('{{' + inner + '}}'));
        }
        continue;
      }
      const opener = OPENERS.find((o) => o.re.test(head));
      if (opener) {
        const m = head.match(opener.re) as RegExpMatchArray;
        const params = head.slice(m[0].length);
        if (opener.fam === 'wrap' && params.includes('}')) {
          pushNode(target(), textNode('{{' + inner + '}}'));
        } else {
          stack.push({ fam: opener.fam, openInner: inner, params, head, kids: [], elseInner: null, elseKids: null });
        }
        continue;
      }
    } else if (trimmed[0] === '/') {
      const closer = CLOSERS.find((c) => c.re.test(trimmed));
      if (closer) {
        let idx = stack.length - 1;
        while (idx >= 0 && stack[idx].fam !== closer.fam) idx -= 1;
        if (idx < 0) {
          pushNode(target(), textNode('{{' + inner + '}}'));
        } else {
          for (let u = stack.length - 1; u > idx; u--) unwind(u);
          stack.length = idx + 1;
          const frame = stack.pop() as Frame;
          pushNode(target(), buildBlock(frame));
        }
        continue;
      }
    }
    pushNode(target(), makeToken(inner));
  }
  for (let u = stack.length - 1; u >= 0; u--) unwind(u);
  const flat = flattenForeachInsideWhile(root, false);
  return { root: flat, firstForeach: findFirstForeach(flat) };
}
function childSeqs(node: Node): Node[][] {
  switch (node.k) {
    case 'if':
      return node.otherwise ? [node.then, node.otherwise] : [node.then];
    case 'assign':
      return [node.value];
    case 'chop':
    case 'repeat':
    case 'replace':
    case 'index':
    case 'insert':
    case 'while':
    case 'variants':
    case 'tags':
    case 'metafields':
    case 'length':
    case 'wrap':
    case 'foreach':
      return [node.body];
    default:
      return [];
  }
}
function flattenForeachInsideWhile(seq: Node[], inWhile: boolean): Node[] {
  const out: Node[] = [];
  for (const node of seq) {
    if (node.k === 'foreach' && inWhile) {
      for (const n of flattenForeachInsideWhile(node.body, true)) pushNode(out, n);
      continue;
    }
    const nextInWhile = inWhile || node.k === 'while';
    switch (node.k) {
      case 'if':
        node.then = flattenForeachInsideWhile(node.then, inWhile);
        if (node.otherwise) node.otherwise = flattenForeachInsideWhile(node.otherwise, inWhile);
        break;
      case 'assign':
        node.value = flattenForeachInsideWhile(node.value, inWhile);
        break;
      case 'chop':
      case 'repeat':
      case 'replace':
      case 'index':
      case 'insert':
      case 'while':
      case 'variants':
      case 'tags':
      case 'metafields':
      case 'length':
      case 'wrap':
      case 'foreach':
        node.body = flattenForeachInsideWhile(node.body, nextInWhile);
        break;
      default:
        break;
    }
    pushNode(out, node);
  }
  return out;
}
function findFirstForeach(seq: Node[]): ForeachNode | null {
  for (const node of seq) {
    if (node.k === 'foreach') return node;
    for (const kids of childSeqs(node)) {
      const found = findFirstForeach(kids);
      if (found) return found;
    }
  }
  return null;
}
const CACHE_LIMIT = 24;
const cache = new Map<string, Compiled>();
function compileTemplate(body: string, globalBodiesByTitle: Record<string, string>): Compiled {
  const referenced: [string, string][] = [];
  if (body.indexOf('$global:') !== -1) {
    for (const name of Object.keys(globalBodiesByTitle)) {
      if (body.indexOf(GLOBAL_PREFIX + name) !== -1) referenced.push([name, globalBodiesByTitle[name]]);
    }
  }
  const key = referenced.length === 0 ? body : body + '\u0000' + JSON.stringify(referenced);
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const globals: Record<string, string> = {};
  for (const [name] of referenced) globals[name] = applyWhitespaceControl(globalBodiesByTitle[name]);
  const prepared = spliceGlobalVariables(
    stripComments(applyWhitespaceTokens(applyWhitespaceControl(body))),
    referenced.length > 0 ? globals : globalBodiesByTitle,
  );
  const compiled = parseFull(prepared);
  cache.set(key, compiled);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
  return compiled;
}
const MAX_WHILE_ITERATIONS = 10000;
const signalOf = (ctx: Ctx): number => ctx.ctl;
const MAX_STEPS = 3000000;
const MAX_REPEAT_OUTPUT = 50000000;
function templateLimitError(what: string): Error {
  const err = new Error(
    `This template is too large or loops too long to run (${what}). Check your loop conditions and repeat counts.`,
  );
  err.name = 'TemplateLimitError';
  return err;
}
const isTemplateLimitError = (e: unknown): boolean => e instanceof Error && e.name === 'TemplateLimitError';
const tick = (ctx: Ctx): void => {
  if (++ctx.steps > MAX_STEPS) throw templateLimitError('more than ' + String(MAX_STEPS) + ' loop steps');
};
const MARKER_SNIPPET = 'unresolved variable "';
const EMPTY_ROW: ProductData = noteToPseudoProduct({ id: 'empty', note: '' });
function createVarStore(): Map<string, string> {
  const store = new Map<string, string>();
  for (const name of ['i', 'j', 'k', 'l', 'x', 'y', 'z']) store.set(name, '');
  return store;
}
function createEnv(rows: ProductData[], rowKind: RowKind, notes: { id: string; note: string }[]): RenderEnv {
  return { rows, rowKind, notes, items: new Map(), filtered: new Map() };
}
function createCtx(
  env: RenderEnv,
  base: { now: Date; primaryDomain: string; selectionLength: number; currKind: RowKind; prev: KindedRow | null; next: KindedRow | null },
): Ctx {
  return {
    env,
    vars: createVarStore(),
    now: base.now,
    primaryDomain: base.primaryDomain,
    selectionLength: base.selectionLength,
    currKind: base.currKind,
    prev: base.prev,
    next: base.next,
    currentMetafield: null,
    ctl: 0,
    sawMarker: false,
    steps: 0,
    window: null,
  };
}
function renderRoot(root: Node[], ctx: Ctx, sc: Scope): string {
  return restoreWhitespaceTokens(evalNodes(root, 0, ctx, sc, false));
}
function readVarNumber(vars: Map<string, string>, name: string): number {
  const num = parseFloat(vars.get(name) ?? '');
  return Number.isFinite(num) ? num : 0;
}
function evalNumber(expr: Node[] | null, ctx: Ctx, sc: Scope): number | null {
  if (expr === null) return null;
  const resolved = evalNodes(expr, 0, ctx, sc, true);
  try {
    const value = evaluateMathExpression(resolved);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}
const counterStart = (expr: Node[] | null, ctx: Ctx, sc: Scope): number => {
  const v = evalNumber(expr, ctx, sc);
  return v == null ? 0 : Math.round(v);
};
interface Reading {
  num: number | null;
  str: string;
}
function readString(str: string): Reading {
  const trimmed = str.trim();
  try {
    const num = evaluateMathExpression(trimmed);
    return { num: Number.isFinite(num) ? num : null, str: trimmed };
  } catch {
    return { num: null, str: trimmed };
  }
}
function readOperand(o: Operand, ctx: Ctx, sc: Scope): Reading {
  if (o.constant !== null) return o.pre ?? (o.pre = readString(o.constant));
  const s = evalNodes(o.nodes, 0, ctx, sc, false);
  if (s.indexOf(MARKER_SNIPPET) !== -1) ctx.sawMarker = true;
  return readString(s);
}
function evalCond(c: Cond, ctx: Ctx, sc: Scope): boolean {
  switch (c.c) {
    case 'or':
      for (const p of c.parts) if (evalCond(p, ctx, sc)) return true;
      return false;
    case 'and':
      for (const p of c.parts) if (!evalCond(p, ctx, sc)) return false;
      return true;
    case 'not':
      return !evalCond(c.x, ctx, sc);
    case 'cmp': {
      const l = readOperand(c.l, ctx, sc);
      const r = readOperand(c.r, ctx, sc);
      const both = l.num != null && r.num != null;
      switch (c.op) {
        case '==':
          return both ? l.num === r.num : l.str === r.str;
        case '!=':
          return both ? l.num !== r.num : l.str !== r.str;
        case '<':
          return both ? (l.num as number) < (r.num as number) : false;
        case '>':
          return both ? (l.num as number) > (r.num as number) : false;
        case '<=':
          return both ? (l.num as number) <= (r.num as number) : false;
        default:
          return both ? (l.num as number) >= (r.num as number) : false;
      }
    }
    case 'truthy': {
      const v = readOperand(c.x, ctx, sc);
      if (v.num != null) return v.num !== 0;
      const lower = v.str.toLowerCase();
      return v.str !== '' && lower !== 'false' && lower !== '0';
    }
    default:
      throw new Error('Empty boolean expression');
  }
}
function condTrue(c: Cond | null, ctx: Ctx, sc: Scope): boolean {
  if (c === null) return false;
  try {
    return evalCond(c, ctx, sc);
  } catch {
    return false;
  }
}
const codePointLength = (s: string): number => {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) i++;
    }
    n++;
  }
  return n;
};
function evalNodes(nodes: Node[], from: number, ctx: Ctx, sc: Scope, numeric: boolean): string {
  const lv: Level = { out: '' };
  runSeq(nodes, from, ctx, sc, numeric, lv, null);
  return lv.out;
}
interface Level {
  out: string;
}
interface Cont {
  nodes: Node[];
  next: number;
  up: Cont | null;
}
function runSeq(nodes: Node[], from: number, ctx: Ctx, sc: Scope, numeric: boolean, lv: Level, up: Cont | null): boolean {
  for (let n = from; n < nodes.length; n++) {
    const node = nodes[n];
    switch (node.k) {
      case 'text':
        lv.out += node.s;
        break;
      case 'empty':
        if (numeric) lv.out += '0';
        break;
      case 'field': {
        const raw = node.resolve(ctx, sc);
        if (numeric) {
          const parsed = parseFloat(raw);
          lv.out += Number.isFinite(parsed) ? String(parsed) : '0';
        } else {
          lv.out += raw;
        }
        break;
      }
      case 'math':
        lv.out += evalMath(node.expr, ctx, sc, numeric);
        break;
      case 'time':
        lv.out += formatDateTime(ctx.now, evalNodes(node.fmt, 0, ctx, sc, false));
        break;
      case 'assign':
        ctx.vars.set(node.name, evalNodes(node.value, 0, ctx, sc, false).trim());
        break;
      case 'bool': {
        let result: boolean | null = null;
        try {
          result = evalCond(node.cond, ctx, sc);
        } catch {
        }
        if (result === null) lv.out += numeric ? '0' : '';
        else lv.out += numeric ? (result ? '1' : '0') : result ? 'TRUE' : 'FALSE';
        break;
      }
      case 'ctl':
        if (node.v > ctx.ctl) ctx.ctl = node.v;
        break;
      case 'if': {
        ctx.sawMarker = false;
        let result = false;
        try {
          result = evalCond(node.cond, ctx, sc);
        } catch {
          result = false;
        }
        if (ctx.sawMarker) {
          ctx.sawMarker = false;
          lv.out += evalNodes(parseInline(node.condText), 0, ctx, sc, false);
        } else if (result) {
          if (runSeq(node.then, 0, ctx, sc, false, lv, { nodes, next: n + 1, up })) return true;
        } else if (node.otherwise) {
          if (runSeq(node.otherwise, 0, ctx, sc, false, lv, { nodes, next: n + 1, up })) return true;
        }
        break;
      }
      case 'chop': {
        const jStart = counterStart(node.start, ctx, sc);
        const inner = evalNodes(node.body, 0, ctx, sc, false);
        const chars = Array.from(inner);
        let kept = 0;
        while (kept < chars.length) {
          tick(ctx);
          ctx.vars.set(node.counter, String(jStart + kept));
          if (condTrue(node.cond, ctx, sc)) break;
          kept += 1;
        }
        if (kept >= chars.length) lv.out += inner;
        else if (node.direction === 'R') lv.out += chars.slice(chars.length - kept).join('');
        else lv.out += chars.slice(0, kept).join('');
        break;
      }
      case 'repeat': {
        const count = evalNumber(node.count.length ? node.count : null, ctx, sc);
        const body = evalNodes(node.body, 0, ctx, sc, false);
        if (count != null && count * (body.length + node.delineator.length) > MAX_REPEAT_OUTPUT) throw templateLimitError('repeat count ' + count);
        lv.out += applyRepeat(body, count, node.delineator);
        break;
      }
      case 'replace': {
        const search = evalNodes(node.search, 0, ctx, sc, false).trim();
        const replacement = evalNodes(node.replacement, 0, ctx, sc, false).trim();
        lv.out += applyReplace(evalNodes(node.body, 0, ctx, sc, false), search, replacement);
        break;
      }
      case 'index': {
        const position = evalNumber(node.position.length ? node.position : null, ctx, sc);
        lv.out += applyIndex(evalNodes(node.body, 0, ctx, sc, false), position);
        break;
      }
      case 'insert': {
        const position = evalNumber(node.position.length ? node.position : null, ctx, sc);
        const inner = evalNodes(node.body, 0, ctx, sc, false);
        const rest: Level = { out: '' };
        let consumed = runSeq(nodes, n + 1, ctx, sc, false, rest, up);
        for (let c = up; c && !consumed; c = c.up) consumed = runSeq(c.nodes, c.next, ctx, sc, false, rest, c.up);
        lv.out = applyInsert(lv.out, rest.out, inner, position, node.drop);
        return true;
      }
      case 'length':
        lv.out += String(codePointLength(evalNodes(node.body, 0, ctx, sc, false).trim()));
        break;
      case 'wrap': {
        const inner = evalNodes(node.body, 0, ctx, sc, false);
        lv.out += node.valid
          ? applyWordWrap(
              restoreWhitespaceTokens(inner),
              node.maxChars,
              node.minWraps,
              node.maxWraps,
              restoreWhitespaceTokens(node.delineator),
              node.hard,
            )
          : inner;
        break;
      }
      case 'while':
        lv.out += evalWhile(node, ctx, sc);
        break;
      case 'variants':
        lv.out += evalVariants(node, ctx, sc);
        break;
      case 'tags':
        lv.out += evalTags(node, ctx, sc);
        break;
      case 'metafields':
        lv.out += evalMetafields(node, ctx, sc);
        break;
      case 'foreach':
        lv.out += evalForeach(node, ctx, sc);
        break;
    }
  }
  return false;
}
function evalMath(expr: Node[], ctx: Ctx, sc: Scope, numeric: boolean): string {
  const expression = evalNodes(expr, 0, ctx, sc, true);
  try {
    const value = evaluateMathExpression(expression);
    if (Number.isFinite(value)) return String(value);
  } catch (err: unknown) {
    const message = err && typeof (err as Error).message === 'string' ? (err as Error).message : '';
    if (!numeric && message.indexOf(UNRESOLVED_VARIABLE_ERROR_PREFIX) === 0) {
      return unresolvedVariableMarker(message.slice(UNRESOLVED_VARIABLE_ERROR_PREFIX.length));
    }
  }
  return numeric ? '0' : '';
}
function evalWhile(node: WhileNode, ctx: Ctx, sc: Scope): string {
  if (node.deprecated) {
    return deprecatedSyntaxMarker(
      'the old while form with a tag-bound counter (condition, comma, counter assignment) is ' +
        'retired -- write a hash-while token with just the boolean condition, and declare/' +
        'increment your own counter variable in the body instead',
    );
  }
  const saved = ctx.ctl;
  let out = '';
  for (let step = 0; step < MAX_WHILE_ITERATIONS; step++) {
    tick(ctx);
    if (node.cond !== null && !condTrue(node.cond, ctx, sc)) break;
    ctx.ctl = 0;
    const rendered = evalNodes(node.body, 0, ctx, sc, false);
    const signal = signalOf(ctx);
    if (signal === 0) out += rendered;
    if (signal === 2) break;
  }
  ctx.ctl = saved;
  return out;
}
function evalVariants(node: VariantLoopNode, ctx: Ctx, sc: Scope): string {
  const start = counterStart(node.start, ctx, sc);
  const prefix = node.deprecatedTied
    ? deprecatedSyntaxMarker(
        'the tied parameter no longer does anything -- a variant loop always follows the current ' +
          'variant selection now; remove it',
      )
    : '';
  const iterated = sc.variants && sc.variants.length > 0 ? sc.variants : sc.row.allVariants;
  if (!iterated || iterated.length === 0) {
    ctx.vars.set(node.name, String(start));
    return prefix + evalNodes(node.body, 0, ctx, sc, false);
  }
  const saved = ctx.ctl;
  let out = prefix;
  for (let index = 0; index < iterated.length; index++) {
    tick(ctx);
    ctx.vars.set(node.name, String(index === 0 ? start : readVarNumber(ctx.vars, node.name) + 1));
    ctx.ctl = 0;
    const rendered = evalNodes(node.body, 0, ctx, { row: sc.row, variants: [iterated[index]] }, false);
    const signal = signalOf(ctx);
    if (signal === 0) out += rendered;
    if (signal === 2) break;
  }
  ctx.ctl = saved;
  return out;
}
function evalTags(node: TagsLoopNode, ctx: Ctx, sc: Scope): string {
  const start = counterStart(node.start, ctx, sc);
  const tags = sc.row.tags || [];
  const saved = ctx.ctl;
  let out = '';
  for (let index = 0; index < tags.length; index++) {
    tick(ctx);
    ctx.vars.set(node.name, String(index === 0 ? start : readVarNumber(ctx.vars, node.name) + 1));
    ctx.vars.set('tag', tags[index]);
    ctx.ctl = 0;
    const rendered = evalNodes(node.body, 0, ctx, sc, false);
    const signal = signalOf(ctx);
    if (signal === 0) out += rendered;
    if (signal === 2) break;
  }
  ctx.ctl = saved;
  return out;
}
function evalMetafields(node: MetafieldsLoopNode, ctx: Ctx, sc: Scope): string {
  const start = counterStart(node.start, ctx, sc);
  const metafields = sc.row.metafields || [];
  const savedMetafield = ctx.currentMetafield;
  const saved = ctx.ctl;
  let out = '';
  for (let index = 0; index < metafields.length; index++) {
    tick(ctx);
    ctx.vars.set(node.name, String(index === 0 ? start : readVarNumber(ctx.vars, node.name) + 1));
    ctx.currentMetafield = metafields[index];
    ctx.ctl = 0;
    const rendered = evalNodes(node.body, 0, ctx, sc, false);
    const signal = signalOf(ctx);
    if (signal === 0) out += rendered;
    if (signal === 2) break;
  }
  ctx.currentMetafield = savedMetafield;
  ctx.ctl = saved;
  return out;
}
function foreachFullItems(kind: ForeachNode['kind'], env: RenderEnv): KindedRow[] {
  let list = env.items.get(kind);
  if (!list) {
    const notes = (): KindedRow[] => env.notes.map((n) => ({ row: noteToPseudoProduct(n), kind: 'note' as RowKind }));
    const rows = (): KindedRow[] => env.rows.map((row) => ({ row, kind: env.rowKind }));
    list = kind === 'notes' ? notes() : kind === 'object' ? [...rows(), ...notes()] : rows();
    env.items.set(kind, list);
  }
  return list;
}
function foreachFilteredItems(node: ForeachNode, env: RenderEnv): KindedRow[] {
  let filtered = env.filtered.get(node);
  if (!filtered) {
    filtered = foreachSelection(foreachFullItems(node.kind, env), node.skipFirst, node.skipLast);
    env.filtered.set(node, filtered);
  }
  return filtered;
}
function evalForeach(node: ForeachNode, ctx: Ctx, sc: Scope): string {
  const env = ctx.env;
  const full = foreachFullItems(node.kind, env);
  const resolveRow = full[0]?.row ?? env.rows[0] ?? EMPTY_ROW;
  const startIndex = counterStart(node.start, ctx, scopeOf(resolveRow));
  const filtered = foreachFilteredItems(node, env);
  const win = ctx.window && ctx.window.node === node ? ctx.window : null;
  const from = win ? win.from : 0;
  const to = win ? win.to : filtered.length;
  const savedKind = ctx.currKind;
  const savedPrev = ctx.prev;
  const savedNext = ctx.next;
  const savedCtl = ctx.ctl;
  let out = node.deprecatedChunk
    ? deprecatedSyntaxMarker(
        'the i=START<MAX chunk-size syntax on a foreach tag is retired -- use this template’s ' +
          'Merge IF setting instead to control how objects are grouped into files',
      )
    : '';
  for (let idx = from, within = 0; idx < to; idx++, within++) {
    tick(ctx);
    ctx.vars.set(node.name, String(within === 0 ? startIndex : readVarNumber(ctx.vars, node.name) + 1));
    const item = filtered[idx];
    ctx.currKind = item.kind;
    ctx.prev = idx > 0 ? filtered[idx - 1] : null;
    ctx.next = idx < filtered.length - 1 ? filtered[idx + 1] : null;
    ctx.ctl = 0;
    const rendered = evalNodes(node.body, 0, ctx, scopeOf(item.row), false);
    const signal = signalOf(ctx);
    if (signal === 0) out += rendered;
    if (signal === 2) break;
  }
  ctx.currKind = savedKind;
  ctx.prev = savedPrev;
  ctx.next = savedNext;
  ctx.ctl = savedCtl;
  return out;
}
function evalConditionTrue(cond: Cond | null, ctx: Ctx, sc: Scope): boolean {
  return condTrue(cond, ctx, sc);
}
interface OutputFiles {
  files: ZipEntry[];
  zipName: string | null;
}
interface FilePlan {
  count: number;
  zipName: string | null;
  build: (index: number) => ZipEntry;
  sourceIdsByIndex: string[][];
}
interface RenderUnit {
  row: ProductData;
  kind: RowKind;
  baseName: string;
}
function productUnits(products: ProductData[], titleSlug: string): RenderUnit[] {
  return products.map((p) => ({
    row: { ...p, variants: p.variants.length > 0 ? p.variants : p.allVariants },
    kind: 'product' as RowKind,
    baseName: `${p.handle}_${titleSlug}`,
  }));
}
function noteUnits(notes: SelectionEntry[], titleSlug: string): RenderUnit[] {
  return notes.map((n) => ({
    row: noteToPseudoProduct(n),
    kind: 'note' as RowKind,
    baseName: `${noteFileSlug(n)}_${titleSlug}`,
  }));
}
function partitionByMergeCondition(
  items: KindedRow[],
  mergeCondition: string,
  selectionLength: number,
  primaryDomain: string,
  now: Date,
): number[][] {
  const groups: number[][] = [];
  if (items.length === 0) return groups;
  const text = mergeCondition.trim();
  const cond: Cond | null = text === '' ? null : parseCond(text);
  const env = createEnv(
    items.map((it) => it.row),
    'variant',
    [],
  );
  let current: number[] = [0];
  for (let i = 0; i < items.length - 1; i++) {
    let merge = false;
    if (cond !== null) {
      const ctx = createCtx(env, {
        now,
        primaryDomain,
        selectionLength,
        currKind: items[i].kind,
        prev: i > 0 ? items[i - 1] : null,
        next: items[i + 1],
      });
      merge = evalConditionTrue(cond, ctx, scopeOf(items[i].row));
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
function planCombined(
  body: string,
  products: ProductData[],
  notes: SelectionEntry[],
  mergeCondition: string,
  selectionLength: number,
  primaryDomain: string,
  now: Date,
  globalBodiesByTitle: Record<string, string>,
): { fileCount: number; render: (fileIndex: number | null) => string; sourceIdsByIndex: string[][] } {
  const rows = expandSelectionToRows(products);
  const first = rows[0] ?? EMPTY_ROW;
  const compiled = compileTemplate(body, globalBodiesByTitle);
  const env = createEnv(rows, 'variant', notes);
  const iteratedItems = compiled.firstForeach ? foreachFilteredItems(compiled.firstForeach, env) : null;
  const groups = iteratedItems
    ? partitionByMergeCondition(iteratedItems, mergeCondition, selectionLength, primaryDomain, now)
    : null;
  const grouped = mergeCondition.trim() !== '' && groups != null && groups.length > 1;
  const fileCount = grouped ? (groups as number[][]).length : 1;
  const sourceIdsByIndex: string[][] = grouped
    ? (groups as number[][]).map((g) => g.map((i) => (iteratedItems as KindedRow[])[i].row.id))
    : [iteratedItems ? iteratedItems.map((item) => item.row.id) : first !== EMPTY_ROW ? [first.id] : []];
  const render = (fileIndex: number | null): string => {
    const ctx = createCtx(env, { now, primaryDomain, selectionLength, currKind: 'variant', prev: null, next: null });
    const group = grouped && fileIndex != null ? (groups as number[][])[fileIndex] : null;
    if (group && compiled.firstForeach) {
      ctx.window = { node: compiled.firstForeach, from: group[0], to: group[group.length - 1] + 1 };
    }
    return renderRoot(compiled.root, ctx, scopeOf(first));
  };
  return { fileCount, render, sourceIdsByIndex };
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
  globalBodiesByTitle: Record<string, string>,
): FilePlan {
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
      sourceIdsByIndex: [],
    };
  }
  const ext = sanitizeExtension(templateExtension);
  const titleSlug = slugify(templateTitle);
  const timestamp = formatTimestamp(now);
  const selectionLength = products.length;
  if (fileBreak === 'selection') {
    const combined = planCombined(
      templateBody,
      products,
      notes,
      mergeCondition,
      selectionLength,
      primaryDomain,
      now,
      globalBodiesByTitle,
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
        sourceIdsByIndex: combined.sourceIdsByIndex,
      };
    }
    return {
      count: combined.fileCount,
      zipName: `${titleSlug}_zipped_${timestamp}.zip`,
      build: (index: number) => ({
        name: `${timestamp}_looped_${titleSlug}_${index}.${ext}`,
        content: combined.render(index),
      }),
      sourceIdsByIndex: combined.sourceIdsByIndex,
    };
  }
  const compiled = compileTemplate(templateBody, globalBodiesByTitle);
  let units: RenderUnit[];
  if (fileBreak === 'variant') {
    units = expandSelectionToRows(products).map((row) => {
      const rowVariant = row.variants[0];
      const variantSuffix = rowVariant ? `_${slugify(rowVariant.title)}` : '';
      return { row, kind: 'variant' as RowKind, baseName: `${row.handle}${variantSuffix}_${titleSlug}` };
    });
  } else if (fileBreak === 'product') {
    units = productUnits(products, titleSlug);
  } else if (fileBreak === 'note') {
    units = noteUnits(notes, titleSlug);
  } else {
    units = [...productUnits(products, titleSlug), ...noteUnits(notes, titleSlug)];
  }
  if (units.length === 0) {
    return {
      count: 0,
      zipName: null,
      build: () => {
        throw new Error('No files to build for this selection and file-break mode.');
      },
      sourceIdsByIndex: [],
    };
  }
  const kindedUnits: KindedRow[] = units.map((u) => ({ row: u.row, kind: u.kind }));
  const merging = mergeCondition.trim() !== '';
  const groups = partitionByMergeCondition(kindedUnits, mergeCondition, selectionLength, primaryDomain, now);
  const renderUnit = (unitIndex: number): string => {
    const current = kindedUnits[unitIndex];
    const ctx = createCtx(createEnv([current.row], current.kind, []), {
      now,
      primaryDomain,
      selectionLength,
      currKind: current.kind,
      prev: unitIndex > 0 ? kindedUnits[unitIndex - 1] : null,
      next: unitIndex < kindedUnits.length - 1 ? kindedUnits[unitIndex + 1] : null,
    });
    return renderRoot(compiled.root, ctx, scopeOf(current.row));
  };
  const renderGroup = (group: number[]): string => {
    let out = '';
    for (const unitIndex of group) out += renderUnit(unitIndex);
    return out;
  };
  if (!merging) {
    if (units.length === 1) {
      const { baseName } = units[0];
      return {
        count: 1,
        zipName: null,
        build: () => ({ name: `${baseName}.${ext}`, content: renderGroup([0]) }),
        sourceIdsByIndex: [[units[0].row.id]],
      };
    }
    const names = dedupeNames(units.map((u) => u.baseName)).map((base) => `${base}.${ext}`);
    return {
      count: units.length,
      zipName: `${titleSlug}_zipped_${timestamp}.zip`,
      build: (index: number) => ({ name: names[index], content: renderGroup([index]) }),
      sourceIdsByIndex: units.map((u) => [u.row.id]),
    };
  }
  if (groups.length === 1) {
    const name = `${timestamp}_looped_${titleSlug}.${ext}`;
    return {
      count: 1,
      zipName: null,
      build: () => ({ name, content: renderGroup(groups[0]) }),
      sourceIdsByIndex: [groups[0].map((i) => kindedUnits[i].row.id)],
    };
  }
  return {
    count: groups.length,
    zipName: `${titleSlug}_zipped_${timestamp}.zip`,
    build: (index: number) => ({
      name: `${timestamp}_looped_${titleSlug}_${index}.${ext}`,
      content: renderGroup(groups[index]),
    }),
    sourceIdsByIndex: groups.map((g) => g.map((i) => kindedUnits[i].row.id)),
  };
}
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
  globalBodiesByTitle: Record<string, string>,
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
    globalBodiesByTitle,
  );
  const files: ZipEntry[] = [];
  for (let index = 0; index < plan.count; index++) files.push(plan.build(index));
  return { files, zipName: plan.zipName };
}
function yieldToBrowser(): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}
const INSERT_PLACEHOLDER_TEXT = '{{ insert }}';
function insertIntoText(prev: string, token: string): string {
  const placeholder = /\{\{\s*insert\s*\}\}/g;
  if (placeholder.test(prev)) {
    return prev.replace(/\{\{\s*insert\s*\}\}/g, () => token);
  }
  return prev.length > 0 ? prev + token : token;
}
const DOUBLE_CLICK_MS = 400;
interface ClickRecord {
  id: string;
  at: number;
}
function registerClick(
  last: ClickRecord | null,
  id: string,
  now: number,
  windowMs: number = DOUBLE_CLICK_MS,
): { isDouble: boolean; next: ClickRecord | null } {
  if (last && last.id === id && now - last.at <= windowMs) {
    return { isDouble: true, next: null };
  }
  return { isDouble: false, next: { id, at: now } };
}
const INTERACTIVE_SELECTOR =
  's-link, s-button, s-checkbox, s-text-field, s-text-area, s-search-field, s-menu, s-select, a, button, input, textarea, select, label';
function isInteractiveTarget(target: unknown, selector: string = INTERACTIVE_SELECTOR): boolean {
  const el = target as { closest?: (s: string) => unknown } | null;
  return Boolean(el && typeof el.closest === 'function' && el.closest(selector));
}
function productMatchesQuery(product: ProductData, rawQuery: string): boolean {
  const query = rawQuery.trim().toLowerCase();
  if (query === '') return true;
  const haystacks: string[] = [
    product.title,
    product.handle,
    product.vendor,
    product.productType,
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
function selectionSignature(list: ProductData[], notes: SelectionEntry[] = []): string {
  return (
    list.map((p) => `${p.id}::${p.note || ''}`).join('|') +
    '#' +
    notes.map((n) => `${n.id}::${n.note}`).join('|')
  );
}
type SelectionRow =
  | { kind: 'product'; id: string; product: ProductData }
  | { kind: 'note'; id: string; note: SelectionEntry };
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
const SYNTAX_GUIDE_TEXT = `TEMPLATE TO TEXT -- SYNTAX GUIDE
=================================

This is a reference for the {{ }} template language used to turn your selected products
and notes into text files. Write your template body once, and it runs once per output
file -- how many files that is depends on the File Break setting (see section 12).

Every token is written inside double curly braces: {{ product.title }}
Spacing inside the braces doesn't matter: {{product.title}} works the same way.


1. PRODUCT AND VARIANT FIELDS
------------------------------
{{ product.title }}            Product title
{{ product.handle }}           Product handle (URL slug)
{{ product.vendor }}           Vendor
{{ product.productType }}      Product type
{{ product.status }}           Status (active, draft, archived)
{{ product.description }}      Description
{{ product.tags }}             Tags, comma-separated
{{ product.totalInventory }}   Total inventory across all variants
{{ product.priceMin }}         Lowest variant price
{{ product.priceMax }}         Highest variant price
{{ product.currencyCode }}     Currency code (e.g. USD)
{{ product.createdAt }}        Created date/time
{{ product.updatedAt }}        Last updated date/time
{{ product.note }}             The note you typed for this product (blank if none)
{{ product.length }}           How many variants this product has

{{ variant.title }}            Variant title
{{ variant.sku }}              SKU
{{ variant.price }}            Price
{{ variant.compareAtPrice }}   Compare-at price
{{ variant.costPerItem }}      Cost per item
{{ variant.barcode }}          Barcode
{{ variant.inventoryQuantity }} Inventory for this specific variant

{{ product.compareAtPrice }} and {{ product.costPerItem }} also work -- outside a
variant loop they report the first variant's values.

Example:
  {{ product.title }} ({{ product.vendor }}) -- {{ variant.sku }}, \${{ variant.price }}
  -->  Blue Mug (Acme Co) -- MUG-BLU-01, $12.00


2. METAFIELDS
-------------
{{ product.metafield.NAMESPACE.KEY }}

Example:
  {{ product.metafield.custom.material }}
  -->  Ceramic

Use "Insert variable" in the editor to pick from every metafield your loaded products
actually have -- it fills in the namespace and key for you.

Don't know which metafields a product has, or want every one of them? Loop over them
instead -- see the metafields loop in section 8.


3. DATE, TIME, AND SHOP TOKENS
--------------------------------
{{ time=FORMAT }}     Formats the date/time this download was made, however you like.
{{ primaryDomain }}   Your shop's domain -> myshop.myshopify.com

Build FORMAT out of these letters (repeat a letter to change how it's shown):
  d / dd            day of month              -> 3 / 03
  ddd / dddd        weekday name              -> Tues / Tuesday
  M / MM            month number              -> 3 / 03
  MMM / MMMM        month name                -> Mar / March
  y / yy / yyyy     year                      -> 26 / 26 / 2026
  h / hh            hour, 12-hour clock       -> 6 / 06
  H / HH            hour, 24-hour clock       -> 6 / 06
  m / mm            minutes                   -> 5 / 05
  s / ss            seconds                   -> 7 / 07
  t / tt            AM or PM                  -> A / AM

Anything else in FORMAT (spaces, commas, dashes, slashes, colons) is printed as-is. Put text
in quotes if it happens to clash with one of the letters above, e.g. {{ time='at' h:mm tt }}.

Examples:
  {{ time=MM/dd/yyyy }}                    -->  03/03/2026
  {{ time=h:mm tt }}                       -->  6:30 AM
  {{ time=dddd, MMMM d, yyyy }}            -->  Tuesday, March 3, 2026

All files generated in one download share the same date/time.

The older {{ day }} / {{ month }} / {{ year }} / {{ day.week }} / {{ month.name }} /
{{ year.short }} tokens are retired -- use {{ time=FORMAT }} instead (see the table above for
the equivalent letters: dd, MM, yyyy, ddd, MMM, yy).


4. WHITESPACE TOKENS
---------------------
{{ /return }}   A real line break
{{ /space }}    A single space

Use these when you need whitespace somewhere that would otherwise get trimmed, such as
inside a wrap block's delineator (see section 12).

Trimming newlines around a tag -- like Liquid's {%- -%}:
{-{ ... }}   Removes the newline just BEFORE the tag (plus any indentation in front of it)
{{ ... }-}   Removes the newline just AFTER the tag (plus any spaces before that newline)
Use {-{ at the start and }-} at the end of any token or block tag -- variables, #if, loops,
comments -- so a tag that sits on its own line leaves no blank line behind. Both can be used
on the same tag: {-{ x }-}. Only ONE newline is removed on each side, and only when it is
directly next to the tag.
  {{ #tags.foreach t, i=0 }-}
  {{ tag }}
  {-{ /tags.foreach }}
  -->  abc   (instead of a blank line before and after every tag)


5. VARIABLES AND MATH
----------------------
Any word can be a variable. Seven short names (i, j, k, l, x, y, z) are offered as
shortcuts, but any name works as long as it isn't one of the reserved words used by
the tags below (if, while, wrap, repeat, replace, chop, index, insert, comment, length,
time, tag, break, skip, and a few tag-parameter names like direction/delineator/drop/
replacement).

Assign:      {{ x = 5 }}          (writes nothing to the output)
Read:        {{ x }}              (outputs the current value)
Equation:    {{ = {{x}} + 1 }}    Always start an equation with =, and always wrap a
                                   variable being used in an equation in its own {{ }}.

Supported operators: + - * / % ^ (and parentheses).

Example:
  {{ x = 3 }}
  {{ x = {{ ={{x}}*2 }} }}
  Total: {{ x }}
  -->  Total: 6

A variable's value can also be a whole text-tool block (Replace, Chop, an If block, ...), which
lets you "clean up" a string in one place at the top of your template and reuse the cleaned
version everywhere else. Reassigning the SAME variable from its own current value chains multiple
tools together:
  {{ title = {{ #replace=&, replacement=and }}{{ product.title }}{{/replace}} }}
  {{ title = {{ #replace=/, replacement=- }}{{ title }}{{/replace}} }}
  ... use {{ title }} anywhere below, with both replacements already applied ...

Want a variable name that's GUARANTEED never to clash with a reserved word (now or in any future
update)? Start it with $:
  {{ $title = 5 }}     Assign
  {{ $title }}         Read
A name starting with $ is never checked against the reserved-word list at all -- it can't collide
with "length", "time", or any word a future tool might reserve. This is entirely optional: bare
names ({{ x }}) work exactly as before and always will. Use "Assign variable ($, collision-safe)"
in the editor's Insert menu to insert one.


6. BOOLEAN CONDITIONS
-----------------------
{{ TRUE != FALSE }}   ->  TRUE
{{ 3 > 2 }}            ->  TRUE
{{ {{ product.vendor }} == Acme Co }}
{{ {{x}} >= 10 && {{y}} < 5 }}

Operators: == != < > <= >= && || !   Group with parentheses: {{ (A || B) && C }}
A condition with no comparison at all is just checked for "truthy" (non-empty,
non-zero, and not literally FALSE or 0).

Inside a condition (or an equation), a field or variable must be wrapped in its own
{{ }}. Block tools such as {{ #length }}...{{/length}} are NOT run inside a condition:
assign the result to a variable first, then test the variable.
  {{ n = {{ #length }}{{ product.handle }}{{/length}} }}
  {{ #if={{ n }} < 100 }}short{{ /if }}


7. IF / ELSE
-------------
{{ #if=CONDITION }}
  ...shown when TRUE...
{{ #else }}
  ...shown when FALSE...
{{ /if }}

  -if (bool expr, required): tested once; TRUE shows the first branch, FALSE shows {{ #else }}'s
   branch (or nothing, if there is no {{ #else }})
  !if: a malformed or empty condition counts as FALSE

Example:
  {{ #if={{ product.totalInventory }} > 0 }}
  In stock
  {{ #else }}
  Out of stock
  {{ /if }}

{{ #else }} is optional. If blocks can be nested inside each other and inside loops.


8. LOOPS
---------

8a. Variant loop -- steps through the current product's in-scope variants:
  -l (var name = start int, optional): which variable holds the step counter, and its
   starting value. Default: l=0
  !l: a product with no variants renders the inner content zero times
  -LABEL (word right after ".foreach", optional): purely cosmetic, not bound to anything --
   the loop item is always read via {{ variant.* }} no matter what LABEL you use, or omit it
  Ex:
  {{ #variants.foreach v, l=0 }}
  {{ variant.title }}: {{ variant.price }}
  {{/variants.foreach}}

8b. Tags loop -- steps through the current product's tags:
  -i (var name = start int, optional): which variable holds the step counter, and its
   starting value. Default: i=0
  !i: a product with no tags renders the inner content zero times
  -LABEL (word right after ".foreach", optional): purely cosmetic, same as the variant loop's
  Ex:
  {{ #tags.foreach tag, i=0 }}
  #{{ tag }}
  {{/tags.foreach}}

8c. Selection loops -- step through your whole selection (used with File Break set to
    "Selection", see section 12).
  -selection.foreach (product / note / object, optional word right after the tag): what to
   iterate. Default (or "product"/"products"): products only. "note"/"notes": notes only.
   "object"/"objects": products, then notes
  -i (var name = start int, optional): which variable holds the step counter, and its
   starting value. Default: i=0
  -skip_first (bool, optional): TRUE skips rendering the first iteration's content (still
   counts it toward the counter). Default: FALSE
  -skip_last (bool, optional): TRUE skips rendering the last iteration's content. Default: FALSE
  Ex:
    {{ #selection.foreach product, i=0 }}
    {{ i }}. {{ product.title }} -- {{ product.handle }}
    {{/selection.foreach}}
    -->  0. Blue Mug -- blue-mug
         1. Red Mug -- red-mug

8d. Metafields loop -- steps through the current product's metafields:
  -i (var name = start int, optional): which variable holds the step counter, and its
   starting value. Default: i=0
  !i: a product with no metafields renders the inner content zero times
  -LABEL (word right after ".foreach", optional): purely cosmetic, same as the variant loop's
  Ex:
  {{ #metafields.foreach mf, i=0 }}
  {{ mf.namespace }}.{{ mf.key }}: {{ mf.value }}
  {{/metafields.foreach}}
  -->  custom.material: Ceramic
       custom.color: Blue

8e. While loop -- repeats while a condition is true; you control your own counter:
  -while (bool expr, required): re-tested before every step; the loop stops the first time
   this is FALSE
  !while: runs up to a hard safety cap of 10,000 steps even if the condition never becomes
   FALSE, so a mistyped condition can't hang a render forever
  Ex:
  {{ x = 1 }}
  {{ #while={{x}}<5 }}
  {{ x }},
  {{ x = {{ ={{x}}+1 }} }}
  {{/while}}
  -->  1,2,3,4,

Every loop supports {{ break }} (stop the loop now) and {{ skip }} (skip just this
one iteration) -- almost always used inside an {{ #if=... }} check.


9. TEXT TOOLS
--------------
Below, each argument is listed as -argument (type): what it means, followed by a ! line
noting what happens if it's left out or given something invalid. Args with no default shown
are required; everything else is optional.

Length -- character count of the (fully rendered) inner content:
  No arguments.
  Ex:
  {{ #length }}{{ product.title }}{{/length}}
  -->  8   (for "Blue Mug")

Chop -- keep everything up to where a condition first becomes true, walking one
character at a time:
  -chop (bool expr, required): tested at each step, with the step counter (j by default)
   bound to the current position
  !chop: if the condition never becomes true, the whole (unchopped) content is returned; a
   malformed condition counts as FALSE at every step
  -direction (L or R): L (default) walks left-to-right, keeping the FRONT of the text; R
   walks right-to-left, keeping the BACK
  -j (var name = start int): which variable holds the step counter, and its starting value.
   Default: j=0
  Ex:
  {{ #chop={{ {{j}}==3 }}, direction=L, j=0 }}{{ product.title }}{{/chop}}
  -->  "Blu"  (first 3 characters; direction=R walks from the right instead)

Repeat -- output the inner content N times:
  -repeat (positive int, required): number of times to repeat the inner content
  !repeat: a missing, non-integer, or less-than-1 count renders nothing; a count of exactly
   1 renders the content once, unchanged
  -delineator (str): string inserted between repeated copies. Default: none
  Ex:
  {{ #repeat=3, delineator=; }}{{ product.sku }}{{/repeat}}
  -->  SKU1;SKU1;SKU1

Replace -- substitute every occurrence of a substring in the inner content with another:
  -replace (str, required): the exact text to find (a literal substring match, never a
   pattern/regex)
  !replace: an empty or missing SEARCH is a no-op -- the inner content is returned unchanged
  -replacement (str): the text to put in its place. Default: none (deletes SEARCH)
  Ex:
  {{ #replace=$, replacement=&dollar; }}Was \${{ product.price }} now \${{ product.compareAtPrice }}!{{/replace}}
  --> Was &dollar;10.00 now &dollar;8.00!
  {{ #replace=aba, replacement=y }}ababab{{/replace}}
  --> ybab

Index -- one character of the inner content, by position:
  -index (int, required): 0-based position; negative counts back from the end (-1 is the
   last character)
  !index: a missing, non-numeric, or out-of-range position renders nothing
  Ex:
  {{ #index=-1 }}{{ product.title }}{{/index}}
  -->  "g"  (last letter of "Blue Mug")

Insert -- splice the inner content into the SURROUNDING output at a character position:
  -insert (int, required): the splice point. N >= 0 counts characters INTO the text that
   follows this block; N < 0 counts characters back from the end of the text that precedes it
  !insert: a missing or non-integer position leaves the surrounding text unchanged and
   discards the inner content
  -drop (bool): what happens when N falls outside the surrounding text's range. FALSE
   (default) clamps to the nearest end and still inserts the content; TRUE discards the
   inner content instead
  Ex:
  {{ #insert=0, drop=FALSE }}>> {{/insert}}Blue Mug
  -->  >> Blue Mug

Wrap -- break long text into fixed-width lines:
  -wrap (positive int, required): max characters per line (the first, unnamed argument)
  !wrap: a missing, non-integer, or non-positive value leaves the inner content completely
   unwrapped
  -min_wraps (int): pad with extra empty lines until at least this many lines exist. 0 or
   omitted = no minimum
  -max_wraps (int): stop wrapping after this many lines -- any remaining text is appended,
   unwrapped, onto the last line. 0 or omitted = no maximum
  -hard (bool): FALSE (default) breaks only at word boundaries (a word longer than the line
   width overflows it); TRUE breaks at the exact character width, mid-word if needed
  -delineator (str): string inserted between lines. Default: none -- use {{ /return }} for a
   real line break
  Ex:
  {{#wrap=10, min_wraps=0, max_wraps=0, hard=FALSE, delineator={{ /return }}}}{{ product.description }}{{/wrap}}
  --> The Best New
      Product
  {{#wrap=10, min_wraps=4, max_wraps=0, hard=FALSE, delineator= / }}{{ product.description }}{{/wrap}}
  --> The Best /New /Product//
  {{#wrap=10, min_wraps=0, max_wraps=1, hard=FALSE, delineator= / }}{{ product.description }}{{/wrap}}
  --> The Best /New Product
  {{#wrap=3, max_wraps=0, hard=TRUE, delineator=, }}{{ product.description }}{{/wrap}}
  --> The, Be,st ,New, Pr,odu,ct

10. COMMENTS
-------------
{{ #comment }}
This text is stripped out before the template runs. Use it for notes to yourself.
{{ /comment }}


11. SELECTION-WIDE TOKENS
---------------------------
{{ selection.length }}                     Number of products selected
{{ selection.first.product.handle }}       A field from the FIRST product/variant
{{ selection.last.product.handle }}        A field from the LAST product/variant

{{ selection.curr.type }}                  What the object currently rendering is:
{{ selection.next.type }}                  "product", "variant", or "note"
{{ selection.prev.type }}
{{ selection.next.product.title }}         A field from the NEXT object in sequence
{{ selection.prev.product.title }}         A field from the PREVIOUS object
{{ selection.curr.note }}                  That object's own note, whatever kind of
{{ selection.next.note }}                  object it is -- product, variant, or a
{{ selection.prev.note }}                  free-standing note -- with no need for a
{{ selection.first.note }}                 .product. or .variant. in between
{{ selection.last.note }}

selection.next / selection.prev resolve to nothing when there is no next/previous
object (the first or last item). These are especially useful with Merge IF (section
13) to decide whether the next object belongs in this file or a new one.


12. FILE BREAK -- HOW MANY FILES YOU GET
-------------------------------------------
Every template has a File Break setting, chosen in the editor:

  Variant     One file per variant (the default)
  Product     One file per product, regardless of variant count
  Note        One file per note
  Object      One file per product AND per note, in the order you added them
  Selection   One file total, with a {{ #selection.foreach }} looping over everyone
              inside it

Pick the mode that matches what you're building: a packing slip per variant, a
product sheet per product, a single combined order sheet, etc.


13. MERGE IF -- COMBINING FILES CONDITIONALLY
------------------------------------------------
Below the File Break setting is a "Merge IF:" condition. Can be used to modify the file
break behavior. If evaluates to TRUE, the next file's text will be appended to the
current file's text. If Empty or FALSE, the files do not merge. Can use variables,
functions, and other objects in the selection using commands.

Example -- keep appending products to the same file as long as the next one has the
same vendor, only starting a new file when the vendor changes:
  {{ selection.next.product.vendor }} == {{ selection.curr.product.vendor }}

Leave this blank for the ordinary one-file-per-object behavior described above.


14. GLOBAL VARIABLES
---------------------
{{ $global:NAME }}

A global variable is defined once, shop-wide, in Settings under "Global Vars" -- not inside any
one template. Give it a Title (the NAME you'll reference) and a Value (the text/template snippet
it should evaluate to), then reference it from any template with {{ $global:NAME }}. It's replaced
with that global's own text right there, evaluated the same way the rest of your template is -- so
a global's value can itself contain other tokens, loops, if-blocks, anything a template body can.

Global variables are READ-ONLY inside a template: {{ $global:NAME = VALUE }} does nothing but show
an error marker. Change a global's value on its own Settings page, not from inside a template.

A global's own Value cannot reference another global (no global-to-global chaining, yet) -- doing
so shows an error marker rather than expanding. A NAME that doesn't match any defined global also
shows an error marker rather than silently rendering nothing, so a typo is easy to spot.

Example: a global titled "signature" with value "Thanks for shopping with us!" -- referencing
{{ $global:signature }} in any template outputs "Thanks for shopping with us!" wherever it's placed.


QUICK REFERENCE
-----------------
{{ product.FIELD }}                     {{ variant.FIELD }}
{{ product.metafield.NS.KEY }}          {{ product.note }}
{{ time=MM/dd/yyyy }}  {{ time=h:mm tt }}  {{ time=dddd, MMMM d, yyyy }}
{{ primaryDomain }}                     {{ /return }} {{ /space }}
{{ x = VALUE }}  {{ x }}                {{ = EXPR }}
{{ $x = VALUE }}  {{ $x }}              (collision-safe variable form)
{{ $global:NAME }}                      (read-only, defined in Settings > Global Vars)
{{ #if=COND }} ... {{ #else }} ... {{ /if }}
{{ #variants.foreach v, l=0 }} ... {{/variants.foreach}}
{{ #tags.foreach tag, i=0 }} ... {{/tags.foreach}}
{{ #metafields.foreach mf, i=0 }} ... {{/metafields.foreach}}
{{ #selection.foreach product/object/note, i=0 }} ... {{/selection.foreach}}
{{ #while=COND }} ... {{/while}}          {{ break }}  {{ skip }}
{{ #length }}TEXT{{/length}}
{{ #chop=COND, direction=L, j=0 }} ... {{/chop}}
{{ #repeat=N, delineator=X }} ... {{/repeat}}
{{ #replace=SEARCH, replacement=REPLACEMENT }} ... {{/replace}}
{{ #index=N }} ... {{/index}}
{{ #insert=N, drop=FALSE }} ... {{/insert}}
{{ #wrap=N, min_wraps=0, max_wraps=0, hard=FALSE, delineator=X}} ... {{/wrap}}
{{ #comment }} ... {{ /comment }}
{{ selection.length }}  {{ selection.first.* }}  {{ selection.last.* }}
{{ selection.curr/next/prev.type }}  {{ selection.curr/next/prev.product/variant.FIELD }}
`;
function Extension() {
  const [view, setView] = useState<'main' | 'editor' | 'selection' | 'settings' | 'globals'>(
    'main',
  );
  const shopIdRef = useRef<string | null>(null);
  const [primaryDomain, setPrimaryDomain] = useState<string>('');
  const [products, setProducts] = useState<ProductData[]>([]);
  const [productSearch, setProductSearch] = useState('');
  const [appliedSearch, setAppliedSearch] = useState('');
  const [productPageInfo, setProductPageInfo] = useState<PageInfo | null>(null);
  const [productsLoading, setProductsLoading] = useState(false);
  const [productError, setProductError] = useState<string | null>(null);
  const [selectedProducts, setSelectedProducts] = useState<Record<string, ProductData>>({});
  const [productNotes, setProductNotes] = useState<Record<string, string>>({});
  const [selectedVariantIds, setSelectedVariantIds] = useState<Record<string, string[]>>({});
  const currentSelectionOrderCounter = useRef<number>(0);
  const [currentSelectionOrderIndex, setCurrentSelectionOrderIndex] = useState<
    Record<string, number>
  >({});
  const nextSelectionOrderIndex = (): number => {
    currentSelectionOrderCounter.current += 1;
    return currentSelectionOrderCounter.current;
  };
  const [bulkMode, setBulkMode] = useState<BulkSelectMode | null>(null);
  const [allLoadedProducts, setAllLoadedProducts] = useState<Record<string, ProductData>>({});
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
  const [noteObjects, setNoteObjects] = useState<SelectionEntry[]>([]);
  const [selectionNoteDraft, setSelectionNoteDraft] = useState<SelectionEntry[]>([]);
  const [checkedSelectionProducts, setCheckedSelectionProducts] = useState<Record<string, boolean>>(
    {},
  );
  const [checkedSelectionNotes, setCheckedSelectionNotes] = useState<Record<string, boolean>>({});
  const [noteDraftText, setNoteDraftText] = useState<string>('');
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [selectionSubtitles, setSelectionSubtitles] = useState<Record<string, string>>({});
  const [subtitleDraft, setSubtitleDraft] = useState<string>('');
  const [subtitleBaseline, setSubtitleBaseline] = useState<string>('');
  const [selectionsError, setSelectionsError] = useState<string | null>(null);
  const [historyEntries, setHistoryEntries] = useState<SelectionEntry[]>([]);
  const [historyProducts, setHistoryProducts] = useState<ProductData[]>([]);
  const [historyLoading, setHistoryLoading] = useState<boolean>(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historySearch, setHistorySearch] = useState<string>('');
  const [globalVars, setGlobalVars] = useState<GlobalVarEntry[]>([]);
  const [globalVarSearch, setGlobalVarSearch] = useState<string>('');
  const [globalVarError, setGlobalVarError] = useState<string | null>(null);
  const [editingGlobalVarId, setEditingGlobalVarId] = useState<string | null>(null);
  const [globalVarTitleDraft, setGlobalVarTitleDraft] = useState<string>('');
  const [globalVarBodyDraft, setGlobalVarBodyDraft] = useState<string>('');
  const [globalVarTitleError, setGlobalVarTitleError] = useState<string | null>(null);
  const [globalVarSaving, setGlobalVarSaving] = useState<boolean>(false);
  const [selectionSlot, setSelectionSlot] = useState<SelectionSlotId | null>(null);
  const [selectionDraft, setSelectionDraft] = useState<ProductData[]>([]);
  const [selectionViewOrderIndex, setSelectionViewOrderIndex] = useState<Record<string, number>>(
    {},
  );
  const [selectionBaseline, setSelectionBaseline] = useState<string>('');
  const [selectionSearch, setSelectionSearch] = useState('');
  const [selectionLoading, setSelectionLoading] = useState(false);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const [selectionSaving, setSelectionSaving] = useState(false);
  const [selectionMissing, setSelectionMissing] = useState(false);
  const loadedProductsRef = useRef<{ byId: Record<string, ProductData>; order: string[] }>({
    byId: {},
    order: [],
  });
  const productRequestRef = useRef<{ token: number; pendingKey: string | null }>({
    token: 0,
    pendingKey: null,
  });
  const [templates, setTemplates] = useState<TemplateData[]>([]);
  const [templatesLoading, setTemplatesLoading] = useState(false);
  const [templateError, setTemplateError] = useState<string | null>(null);
  const [templateSearch, setTemplateSearch] = useState('');
  const [templateSort, setTemplateSort] = useState<'new-old' | 'old-new' | 'a-z' | 'z-a'>(
    'new-old',
  );
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);
  const [hoveredProductId, setHoveredProductId] = useState<string | null>(null);
  const [hoveredTemplateId, setHoveredTemplateId] = useState<string | null>(null);
  const lastTemplateClickRef = useRef<ClickRecord | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [pinError, setPinError] = useState<string | null>(null);
  const [pinningId, setPinningId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<TemplateData | null>(null);
  const [editorTitle, setEditorTitle] = useState('');
  const [editorBody, setEditorBody] = useState('');
  const [editorExtension, setEditorExtension] = useState('txt');
  const [editorFileBreak, setEditorFileBreak] = useState<FileBreak | null>('variant');
  const [editorMergeCondition, setEditorMergeCondition] = useState('');
  const [editorTitleError, setEditorTitleError] = useState<string | null>(null);
  const [editorFileBreakError, setEditorFileBreakError] = useState<string | null>(null);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const INSERT_PLACEHOLDER = '{{ insert }}';
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
  const [confirmedName, setConfirmedName] = useState<string>('');
  const [download, setDownload] = useState<{ href: string; name: string; isZip: boolean } | null>(
    null,
  );
  const [downloadProgress, setDownloadProgress] = useState<{
    done: number;
    total: number;
    packaging: boolean;
  } | null>(null);
  const [downloadFailed, setDownloadFailed] = useState<boolean>(false);
  const downloadBuildRef = useRef<number>(0);
  const pendingDownloadTouchesRef = useRef<HistoryTouch[]>([]);
  const [previewIndex, setPreviewIndex] = useState<number>(0);
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
  const currentSelectionVariantCount = useMemo(
    () => selectedProductList.reduce((sum: number, p: ProductData) => sum + p.variants.length, 0),
    [selectedProductList],
  );
  const selectedTemplate = useMemo(
    () => templates.find((t) => t.id === selectedTemplateId) || null,
    [templates, selectedTemplateId],
  );
  const pendingDeleteTemplate = useMemo(
    () => templates.find((t: TemplateData) => t.id === pendingDeleteId) || null,
    [templates, pendingDeleteId],
  );
  const globalBodiesByTitle = useMemo(() => {
    const map: Record<string, string> = {};
    for (const g of globalVars) {
      map[g.title] = stripComments(g.body);
    }
    return map;
  }, [globalVars]);
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
    const shardValues = SHARD_KEYS.map((_key, index) => shop?.[`shard${index}`]?.value);
    let anyUnparseable = false;
    const merged: TemplateData[] = [];
    for (const value of shardValues) {
      const { list, unparseable } = parseShardValue(value);
      if (unparseable) anyUnparseable = true;
      for (const t of list) merged.push(t);
    }
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
  const mutateHistory = async (
    mutate: (current: SelectionEntry[]) => SelectionEntry[],
  ): Promise<void> => {
    try {
      const ownerId = await ensureShopId(() => {});
      if (!ownerId) return;
      const { data } = await shopify.query(HISTORY_READ_QUERY, {
        variables: { ns: TEMPLATE_NAMESPACE, key: HISTORY_KEY },
      });
      const current = parseSelectionItems(data?.shop?.hist?.value);
      const next = mutate(current);
      const { errors } = await shopify.query(TEMPLATES_WRITE_MUTATION, {
        variables: {
          metafields: [
            {
              ownerId,
              namespace: TEMPLATE_NAMESPACE,
              key: HISTORY_KEY,
              type: 'json',
              value: JSON.stringify(next),
            },
          ],
        },
      });
      if (errors?.length) return;
      setHistoryEntries(next);
    } catch {
    }
  };
  const mutateGlobalVars = async (
    mutate: (current: GlobalVarEntry[]) => GlobalVarEntry[],
    setError: (msg: string) => void,
  ): Promise<GlobalVarEntry[] | null> => {
    const ownerId = await ensureShopId(setError);
    if (!ownerId) return null;
    try {
      const { data, errors: readErrors } = await shopify.query(GLOBALS_READ_QUERY, {
        variables: { ns: TEMPLATE_NAMESPACE, key: GLOBALS_KEY },
      });
      if (readErrors?.length) {
        setError(readErrors.map((e: any) => e.message).join(', '));
        return null;
      }
      const current = parseGlobalVars(data?.shop?.globals?.value);
      const next = mutate(current);
      const { data: writeData, errors: writeErrors } = await shopify.query(
        TEMPLATES_WRITE_MUTATION,
        {
          variables: {
            metafields: [
              {
                ownerId,
                namespace: TEMPLATE_NAMESPACE,
                key: GLOBALS_KEY,
                type: 'json',
                value: JSON.stringify(next),
              },
            ],
          },
        },
      );
      const message = formatGraphQLErrors(writeErrors, writeData?.metafieldsSet?.userErrors);
      if (message) {
        setError(message);
        return null;
      }
      setGlobalVars(next);
      return next;
    } catch (err: any) {
      setError(err?.message || 'Failed to save global variables.');
      return null;
    }
  };
  const rememberProducts = (list: ProductData[]): void => {
    if (list.length === 0) return;
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
      setTemplates(list);
    } catch (err: any) {
      setTemplateError(err?.message || 'Failed to load templates.');
    } finally {
      setTemplatesLoading(false);
    }
  };
  const loadSelections = async (): Promise<{
    productEntries: Record<PublicSelectionSlotId, SelectionEntry[]>;
    noteEntries: Record<PublicSelectionSlotId, SelectionEntry[]>;
    slotOrderIndex: Record<PublicSelectionSlotId, Record<string, number>>;
    subtitles: Record<string, string>;
  } | null> => {
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
          hist: HISTORY_KEY,
          globals: GLOBALS_KEY,
        },
      });
      if (errors?.length) {
        setSelectionsError(errors.map((e: any) => e.message).join(', '));
        return null;
      }
      const shop = data?.shop;
      if (shop?.id) {
        shopIdRef.current = shop.id;
      }
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
      const typedProductEntries = productEntries as Record<PublicSelectionSlotId, SelectionEntry[]>;
      const typedNoteEntries = noteEntries as Record<PublicSelectionSlotId, SelectionEntry[]>;
      const typedSlotOrderIndex = slotOrderIndex as Record<
        PublicSelectionSlotId,
        Record<string, number>
      >;
      const subtitles = parseSubtitles(shop?.subs?.value);
      setSelectionEntries(typedProductEntries);
      setSelectionNotes(typedNoteEntries);
      setSelectionSlotOrderIndex(typedSlotOrderIndex);
      setSelectionSubtitles(subtitles);
      setHistoryEntries(parseSelectionItems(shop?.hist?.value));
      setGlobalVars(parseGlobalVars(shop?.globals?.value));
      return {
        productEntries: typedProductEntries,
        noteEntries: typedNoteEntries,
        slotOrderIndex: typedSlotOrderIndex,
        subtitles,
      };
    } catch (err: any) {
      setSelectionsError(err?.message || 'Failed to load saved selections.');
      return null;
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
  const openNoteModal = (initialText: string): void => {
    setNoteDraftText(initialText);
  };
  const appendSearchToNote = (): void => {
    const searchText = productSearch.trim();
    if (searchText === '') return;
    setNoteDraftText((prev) => (prev.trim() === '' ? searchText : `${prev}\n${searchText}`));
  };
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
  const toggleProduct = (product: ProductData, checked: boolean): void => {
    if (Boolean(selectedProducts[product.id]) === checked) {
      return;
    }
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
  const setProductNote = (productId: string, note: string): void => {
    setProductNotes((prev) => {
      if ((prev[productId] || '') === note) {
        return prev;
      }
      return { ...prev, [productId]: note };
    });
  };
  const toggleVariantChecked = (
    productId: string,
    allVariantIds: string[],
    variantId: string,
    checked: boolean,
  ): void => {
    setSelectedVariantIds((prev: Record<string, string[]>) => {
      const current =
        prev[productId] && prev[productId].length > 0 ? prev[productId] : allVariantIds;
      if (current.includes(variantId) === checked) return prev;
      const next = checked
        ? [...current, variantId]
        : current.filter((id: string) => id !== variantId);
      if (next.length === 0) return prev;
      return { ...prev, [productId]: next };
    });
  };
  const bulkTargets = (mode: BulkSelectMode): ProductData[] =>
    mode === 'shown' ? products : products.filter((p: ProductData) => (p.totalInventory ?? 0) > 0);
  const inStockDisplayedCount = bulkTargets('in-stock').length;
  const bulkActive = (mode: BulkSelectMode): boolean => {
    const targets = bulkTargets(mode);
    return targets.length > 0 && targets.every((p) => Boolean(selectedProducts[p.id]));
  };
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
    setNoteObjects([]);
  };
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
  const renderInsertButtons = (prefix: string) => (
            <s-stack direction="inline" gap="small" alignItems="center">
              <s-button icon="plus" commandFor={`${prefix}insert-variable-menu`}>
                Insert variable
              </s-button>
              <s-button icon="plus" commandFor={`${prefix}insert-special-menu`}>
                Insert special
              </s-button>
            </s-stack>
  );
  const renderInsertMenus = (prefix: string, onInsert: (token: string) => void, withGlobals: boolean) => (
    <>
            <s-menu id={`${prefix}insert-variable-menu`} accessibilityLabel="Insert variable">
              <s-text color="subdued">
                Selected variable replaces all instances of {INSERT_PLACEHOLDER}
              </s-text>
              <s-section heading="Product fields">
                {PRODUCT_FIELD_TOKENS.map((t) => (
                  <s-button key={t.token} onClick={() => onInsert(t.token)}>
                    {t.label}
                  </s-button>
                ))}
              </s-section>
              <s-section heading="Variant fields">
                {VARIANT_FIELD_TOKENS.map((t) => (
                  <s-button key={t.token} onClick={() => onInsert(t.token)}>
                    {t.label}
                  </s-button>
                ))}
              </s-section>
              {metafieldTokens.length > 0 ? (
                <s-section heading="Metafields">
                  {metafieldTokens.map((t) => (
                    <s-button key={t.token} onClick={() => onInsert(t.token)}>
                      {t.label}
                    </s-button>
                  ))}
                </s-section>
              ) : null}
              {withGlobals && globalVars.length > 0 ? (
                <s-section heading="Global variables">
                  {globalVars.map((g: GlobalVarEntry) => (
                    <s-button key={g.id} onClick={() => onInsert(`{{ $global:${g.title} }}`)}>
                      {g.title}
                    </s-button>
                  ))}
                </s-section>
              ) : null}
            </s-menu>
            <s-menu id={`${prefix}insert-special-menu`} accessibilityLabel="Insert special">
              <s-text color="subdued">
                Selected variable replaces all instances of {INSERT_PLACEHOLDER}
              </s-text>
              <s-section heading="Selection">
                <s-button onClick={() => onInsert(FOREACH_BLOCK)}>For each loop</s-button>
                <s-button onClick={() => onInsert(NOTES_LOOP_BLOCK)}>Notes foreach</s-button>
                <s-button onClick={() => onInsert('{{ selection.length }}')}>
                  Number of products selected
                </s-button>
                <s-button onClick={() => onInsert('{{ selection.first.product.handle }}')}>
                  First product handle
                </s-button>
                <s-button onClick={() => onInsert('{{ selection.last.product.handle }}')}>
                  Last product handle
                </s-button>
                <s-button onClick={() => onInsert('{{ product.length }}')}>
                  Number of variants
                </s-button>
                <s-button onClick={() => onInsert(VARIANT_LOOP_BLOCK)}>
                  Variant foreach
                </s-button>
                <s-button onClick={() => onInsert(TAGS_LOOP_BLOCK)}>Tags foreach</s-button>
                <s-button onClick={() => onInsert(METAFIELDS_LOOP_BLOCK)}>
                  Metafields foreach
                </s-button>
                <s-button onClick={() => onInsert('{{ selection.next.product.title }}')}>
                  Next object's field
                </s-button>
                <s-button onClick={() => onInsert('{{ selection.prev.product.title }}')}>
                  Previous object's field
                </s-button>
                <s-button onClick={() => onInsert('{{ selection.next.type }}')}>
                  Next object's type
                </s-button>
                <s-button onClick={() => onInsert('{{ selection.prev.type }}')}>
                  Previous object's type
                </s-button>
                <s-button onClick={() => onInsert('{{ selection.curr.type }}')}>
                  Current object's type
                </s-button>
              </s-section>
              <s-section heading="Variables">
                <s-button onClick={() => onInsert(ASSIGN_TOKEN)}>Assign variable</s-button>
                <s-button onClick={() => onInsert(ASSIGN_TOKEN_DOLLAR)}>
                  Assign variable ($, collision-safe)
                </s-button>
                {VARIABLE_NAMES.map((name) => (
                  <s-button key={name} onClick={() => onInsert(`{{ ${name} }}`)}>
                    Variable {name}
                  </s-button>
                ))}
              </s-section>
              <s-section heading="Functions">
                <s-button onClick={() => onInsert(WHILE_BLOCK)}>While loop</s-button>
                <s-button onClick={() => onInsert(CHOP_BLOCK)}>Chop block</s-button>
                <s-button onClick={() => onInsert(WRAP_BLOCK)}>Word wrap</s-button>
                <s-button onClick={() => onInsert(REPEAT_BLOCK)}>Repeat</s-button>
                <s-button onClick={() => onInsert(REPLACE_BLOCK)}>Replace</s-button>
                <s-button onClick={() => onInsert(INDEX_BLOCK)}>Index</s-button>
                <s-button onClick={() => onInsert(INSERT_BLOCK)}>Insert block</s-button>
                <s-button onClick={() => onInsert(IF_BLOCK)}>If block</s-button>
                <s-button onClick={() => onInsert(COMMENT_BLOCK)}>Comment block</s-button>
                <s-button onClick={() => onInsert(BREAK_TOKEN_BLOCK)}>Break</s-button>
                <s-button onClick={() => onInsert(SKIP_TOKEN_BLOCK)}>Skip</s-button>
              </s-section>
              <s-section heading="Functional tokens">
                <s-button onClick={() => onInsert('{{ =0 }}')}>Math equation</s-button>
                <s-button onClick={() => onInsert(BOOLEAN_TOKEN)}>Boolean equation</s-button>
                <s-button onClick={() => onInsert(LENGTH_TOKEN)}>String length</s-button>
              </s-section>
              <s-section heading="Special tokens">
                <s-button onClick={() => onInsert(NEWLINE_TOKEN_SNIPPET)}>New line</s-button>
                <s-button onClick={() => onInsert(SPACE_TOKEN_SNIPPET)}>Space</s-button>
                <s-button onClick={() => onInsert(TRIM_BEFORE_SNIPPET)}>
                  Trim newline before a tag
                </s-button>
                <s-button onClick={() => onInsert(TRIM_AFTER_SNIPPET)}>
                  Trim newline after a tag
                </s-button>
                <s-button onClick={() => onInsert(DATE_TOKEN)}>Date</s-button>
                <s-button onClick={() => onInsert(TIME_TOKEN)}>Time</s-button>
                <s-button onClick={() => onInsert(DATE_TIME_TOKEN)}>Date and time</s-button>
                <s-button onClick={() => onInsert(WEEKDAY_DATE_TOKEN)}>
                  Weekday, month day, year
                </s-button>
                <s-button onClick={() => onInsert('{{ primaryDomain }}')}>
                  Shop primary domain
                </s-button>
              </s-section>
            </s-menu>
    </>
  );
  const renderProductPager = () => (
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
  );
  const renderProductRow = (p: ProductData) => {
    const allVariantIds = p.allVariants.map((v: VariantData) => v.id);
    const checkedVariantIds =
      selectedVariantIds[p.id] && selectedVariantIds[p.id].length > 0 ? selectedVariantIds[p.id] : allVariantIds;
    const isSelected = Boolean(selectedProducts[p.id]);
    const url = adminProductUrl(p.id, primaryDomain);
    return (
      <s-box
        key={p.id}
        paddingBlock="small-300"
        paddingInline="small-200"
        borderRadius="base"
        background={hoveredProductId === p.id ? 'subdued' : undefined}
        onMouseEnter={() => setHoveredProductId(p.id)}
        onMouseLeave={() => setHoveredProductId((cur) => (cur === p.id ? null : cur))}
        onClick={(e: any) => {
          if (isInteractiveTarget(e.target)) return;
          toggleProduct(p, !isSelected);
        }}
      >
        <s-grid gridTemplateColumns="auto 1fr auto" gap="base" alignItems="start">
          <s-checkbox
            accessibilityLabel={`Select ${p.title}`}
            checked={isSelected}
            onChange={(e: any) => toggleProduct(p, e.currentTarget.checked)}
          />
          <s-stack gap="small-400">
            <s-stack direction="inline" gap="small" alignItems="center">
              {p.imageUrl ? <s-thumbnail size="small" src={p.imageUrl} alt={p.title} /> : null}
              {url ? (
                <s-link href={url} target="_blank">
                  <s-text type="strong">{p.title}</s-text>
                </s-link>
              ) : (
                <s-text type="strong">{p.title}</s-text>
              )}
            </s-stack>
            <s-text color="subdued">{p.handle}</s-text>
            {isSelected ? (
              <s-text-field
                label={`Note for ${p.title}`}
                labelAccessibilityVisibility="exclusive"
                placeholder="Add a note to the selection..."
                value={productNotes[p.id] || ''}
                onInput={(e: any) => setProductNote(p.id, e.currentTarget.value)}
              />
            ) : null}
            {isSelected && p.allVariants.length > 1 ? (
              <s-stack gap="small-200">
                <s-text color="subdued">
                  Variants ({checkedVariantIds.length} of {p.allVariants.length} selected)
                </s-text>
                {p.allVariants.map((v: VariantData) => (
                  <s-checkbox
                    key={v.id}
                    label={`${v.title} · ${formatQty(v.inventoryQuantity)}`}
                    accessibilityLabel={`Include variant ${v.title} of ${p.title}`}
                    checked={checkedVariantIds.includes(v.id)}
                    onChange={() =>
                      toggleVariantChecked(p.id, allVariantIds, v.id, !checkedVariantIds.includes(v.id))
                    }
                  />
                ))}
              </s-stack>
            ) : null}
          </s-stack>
          <s-text color="subdued">{formatQty(p.totalInventory)}</s-text>
        </s-grid>
      </s-box>
    );
  };
  const handleTemplateRowClick = (e: any, tpl: TemplateData): void => {
    if (isInteractiveTarget(e.target, 's-button, s-menu, a')) return;
    const click = registerClick(lastTemplateClickRef.current, tpl.id, Date.now());
    lastTemplateClickRef.current = click.next;
    if (click.isDouble) {
      openEditTemplate(tpl);
      return;
    }
    setSelectedTemplateId(tpl.id);
  };
  const openEditTemplate = (tpl: TemplateData): void => {
    setEditingTemplate(tpl);
    setEditorTitle(tpl.title);
    setEditorBody(tpl.body);
    setEditorExtension(tpl.extension || 'txt');
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
  const insertVariable = (token: string): void => {
    setEditorBody((prev) => insertIntoText(prev, token));
  };
  const insertIntoGlobalBody = (token: string): void => {
    setGlobalVarBodyDraft((prev) => insertIntoText(prev, token));
  };
  const refreshTemplatesAndProducts = (): void => {
    fetchTemplates();
    fetchProducts(null, 'forward', appliedSearch);
  };
  const backToMain = (): void => {
    setView('main');
    setEditorError(null);
    refreshTemplatesAndProducts();
  };
  const openSettings = async (): Promise<void> => {
    setView('settings');
    setHistorySearch('');
    setHistoryError(null);
    const productIds = historyEntries
      .filter((e: SelectionEntry) => !isStandaloneNote(e))
      .map((e: SelectionEntry) => e.id);
    if (productIds.length === 0) {
      setHistoryProducts([]);
      return;
    }
    setHistoryLoading(true);
    try {
      const { products, error } = await loadProductsByIds(productIds);
      if (error) {
        setHistoryError(error);
        setHistoryProducts([]);
        return;
      }
      setHistoryProducts(products);
    } catch (err: any) {
      setHistoryError(err?.message || 'Failed to load history.');
    } finally {
      setHistoryLoading(false);
    }
  };
  const openGlobalVarsPage = (): void => {
    setView('globals');
    setGlobalVarSearch('');
    setGlobalVarError(null);
  };
  const backFromGlobalVars = (): void => {
    setView('settings');
    refreshTemplatesAndProducts();
  };
  const openGlobalVarModal = (entry: GlobalVarEntry | null): void => {
    setEditingGlobalVarId(entry ? entry.id : null);
    setGlobalVarTitleDraft(entry ? entry.title : '');
    setGlobalVarBodyDraft(entry ? entry.body : '');
    setGlobalVarTitleError(null);
  };
  const clearGlobalVarDraft = (): void => {
    setGlobalVarTitleDraft('');
    setGlobalVarBodyDraft('');
    setGlobalVarTitleError(null);
  };
  const saveGlobalVarEntry = async (): Promise<void> => {
    const title = globalVarTitleDraft.trim();
    if (title === '') {
      setGlobalVarTitleError('Title is required');
      return;
    }
    if (!IDENTIFIER_REGEX.test(title)) {
      setGlobalVarTitleError(
        'Title can’t contain spaces or the characters { } . = < > ! & | , ( )',
      );
      return;
    }
    const duplicate = globalVars.some(
      (g: GlobalVarEntry) => g.title === title && g.id !== editingGlobalVarId,
    );
    if (duplicate) {
      setGlobalVarTitleError('A global variable with this title already exists');
      return;
    }
    setGlobalVarTitleError(null);
    setGlobalVarError(null);
    setGlobalVarSaving(true);
    try {
      const savedId = editingGlobalVarId || generateGlobalVarId();
      const body = globalVarBodyDraft;
      await mutateGlobalVars((current: GlobalVarEntry[]) => {
        const existingIndex = current.findIndex((g: GlobalVarEntry) => g.id === savedId);
        const savedEntry: GlobalVarEntry = { id: savedId, title, body };
        return existingIndex >= 0
          ? current.map((g: GlobalVarEntry) => (g.id === savedId ? savedEntry : g))
          : [...current, savedEntry];
      }, setGlobalVarError);
      setEditingGlobalVarId(null);
      setGlobalVarTitleDraft('');
      setGlobalVarBodyDraft('');
    } finally {
      setGlobalVarSaving(false);
    }
  };
  const deleteGlobalVar = (id: string): void => {
    setGlobalVarError(null);
    mutateGlobalVars(
      (current: GlobalVarEntry[]) => current.filter((g: GlobalVarEntry) => g.id !== id),
      setGlobalVarError,
    );
  };
  const moveGlobalVar = (id: string, offset: number): void => {
    setGlobalVarError(null);
    mutateGlobalVars((current: GlobalVarEntry[]) => {
      const index = current.findIndex((g: GlobalVarEntry) => g.id === id);
      const target = index + offset;
      if (index === -1 || target < 0 || target >= current.length) {
        return current;
      }
      const reordered = [...current];
      const [moved] = reordered.splice(index, 1);
      reordered.splice(target, 0, moved);
      return reordered;
    }, setGlobalVarError);
  };
  const globalVarsFiltered = useMemo<GlobalVarEntry[]>(() => {
    const term = globalVarSearch.trim().toLowerCase();
    if (term === '') return globalVars;
    return globalVars.filter(
      (g: GlobalVarEntry) =>
        g.title.toLowerCase().includes(term) || g.body.toLowerCase().includes(term),
    );
  }, [globalVars, globalVarSearch]);
  const isNewGlobalVar = editingGlobalVarId === null;
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
  const confirmLeave = (): void => {
    backToMain();
  };
  const saveTemplate = async (): Promise<void> => {
    if (!editorTitle.trim()) {
      setEditorTitleError('Title is required');
      return;
    }
    if (editorFileBreak === null) {
      setEditorFileBreakError('Choose a file break before saving');
      return;
    }
    setEditorTitleError(null);
    setEditorFileBreakError(null);
    setEditorError(null);
    setSaving(true);
    const isNewTemplate = !editingTemplate;
    try {
      const savedId = editingTemplate ? editingTemplate.id : generateTemplateId(editorTitle);
      const nextList = await mutateTemplateList((currentList) => {
        const existingIndex = currentList.findIndex((t) => t.id === savedId);
        const savedTemplate: TemplateData = {
          id: savedId,
          title: editorTitle,
          body: editorBody,
          extension: sanitizeExtension(editorExtension),
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
      if (isNewTemplate) {
        const text = `Template {{ template_title=${editorTitle}, action=created, date=${historyDate(new Date())} }}`;
        mutateHistory((current) => appendHistoryLogNote(current, text));
      }
      setView('main');
    } catch (err: any) {
      setEditorError(err?.message || 'Failed to save template.');
    } finally {
      setSaving(false);
    }
  };
  const togglePin = async (template: TemplateData): Promise<void> => {
    setPinError(null);
    setPinningId(template.id);
    try {
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
      const deletedTitle =
        templates.find((t: TemplateData) => t.id === deleteId)?.title || deleteId;
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
      if (view === 'editor' && editingTemplate?.id === pendingDeleteId) {
        backToMain();
      }
      setPendingDeleteId(null);
      setDeleteError(null);
      const text = `Template {{ template_title=${deletedTitle}, action=destroyed, date=${historyDate(new Date())} }}`;
      mutateHistory((current) => appendHistoryLogNote(current, text));
      await fetchTemplates();
    } catch (err: any) {
      setDeleteError(err?.message || 'Failed to delete template.');
    } finally {
      setDeleting(false);
    }
  };
  const templateGroups = useMemo<{ list: TemplateData[]; dividerIndex: number }>(() => {
    const term = templateSearch.trim().toLowerCase();
    const matched = !term
      ? templates
      : templates.filter(
          (t) =>
            t.title.toLowerCase().includes(term) ||
            sanitizeExtension(t.extension).toLowerCase().includes(term),
        );
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
    if (term) {
      return { list: applySelectedSort(matched), dividerIndex: -1 };
    }
    const pinned = matched
      .filter((t) => t.pinned === true)
      .sort((a, b) => (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0));
    const unpinned = applySelectedSort(matched.filter((t) => t.pinned !== true));
    return {
      list: [...pinned, ...unpinned],
      dividerIndex: pinned.length > 0 && unpinned.length > 0 ? pinned.length : -1,
    };
  }, [templates, templateSearch, templateSort]);
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
  const emptySelectionDownloadable =
    selectedTemplate?.fileBreak === 'selection' &&
    !templateNeedsSelectionObjects(selectedTemplate.body);
  const canDownload =
    (selectedProductList.length > 0 || noteObjects.length > 0 || emptySelectionDownloadable) &&
    selectedTemplate !== null;
  useEffect(() => {
    const buildId = downloadBuildRef.current + 1;
    downloadBuildRef.current = buildId;
    setDownload(null);
    setDownloadFailed(false);
    if (
      !selectedTemplate ||
      (selectedProductList.length === 0 && noteObjects.length === 0 && !emptySelectionDownloadable)
    ) {
      setDownloadProgress(null);
      return;
    }
    const tpl = selectedTemplate;
    const prepare = async (): Promise<void> => {
      try {
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
          globalBodiesByTitle,
        );
        setDownloadProgress({ done: 0, total: plan.count, packaging: false });
        const files: ZipEntry[] = [];
        for (let index = 0; index < plan.count; index++) {
          files.push(plan.build(index));
          if (downloadBuildRef.current !== buildId) return;
          setDownloadProgress({ done: index + 1, total: plan.count, packaging: false });
          await yieldToBrowser();
          if (downloadBuildRef.current !== buildId) return;
        }
        if (files.length === 0) {
          setDownloadProgress(null);
          return;
        }
        if (downloadBuildRef.current === buildId) {
          const folderName = plan.zipName ? plan.zipName.replace(/\.zip$/i, '') : '';
          const fileNameByObjectId = new Map<string, string>();
          for (let index = 0; index < files.length; index++) {
            const ids = new Set(plan.sourceIdsByIndex[index] || []);
            for (const id of ids) fileNameByObjectId.set(id, files[index].name);
          }
          const noteById = new Map<string, string>();
          for (const p of selectedProductList) noteById.set(p.id, p.note || '');
          for (const n of noteObjects) noteById.set(n.id, n.note);
          pendingDownloadTouchesRef.current = Array.from(fileNameByObjectId.entries()).map(
            ([id, fileName]): HistoryTouch => ({
              id,
              baseNote: noteById.get(id) || '',
              tag: `{{ file=${fileName}, folder=${folderName} }}`,
            }),
          );
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
  }, [selectedTemplate, selectedProductList, noteObjects, primaryDomain, globalBodiesByTitle]);
  const downloadBuildFailed = canDownload && downloadFailed;
  const preparingDownload = downloadProgress !== null;
  const onDownloadClick = (): void => {
    if (!download) return;
    setConfirmedName(download.name);
    if (pendingDownloadTouchesRef.current.length > 0) {
      const touches = pendingDownloadTouchesRef.current;
      mutateHistory((current) => applyHistoryTouches(current, touches));
    }
  };
  const previewEmptySelectionDownloadable =
    editorFileBreak === 'selection' && !templateNeedsSelectionObjects(editorBody);
  const preview = useMemo<{ files: ZipEntry[]; failed: boolean }>(() => {
    if (
      selectedProductList.length === 0 &&
      noteObjects.length === 0 &&
      !previewEmptySelectionDownloadable
    ) {
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
        globalBodiesByTitle,
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
    globalBodiesByTitle,
  ]);
  const previewPage =
    preview.files.length === 0 ? 0 : Math.min(previewIndex, preview.files.length - 1);
  const canPreview =
    selectedProductList.length > 0 || noteObjects.length > 0 || previewEmptySelectionDownloadable;
  const openPreview = (): void => {
    setPreviewIndex(0);
  };
  const showPreviousPreviewFile = (): void => {
    setPreviewIndex(previewPage > 0 ? previewPage - 1 : 0);
  };
  const showNextPreviewFile = (): void => {
    setPreviewIndex(previewPage < preview.files.length - 1 ? previewPage + 1 : previewPage);
  };
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
  const openSelectionView = async (slot: SelectionSlotId): Promise<void> => {
    setSelectionSlot(slot);
    setSelectionSearch('');
    setSelectionError(null);
    setSelectionMissing(false);
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
    setSelectionLoading(true);
    try {
      const fresh = await loadSelections();
      const storedEntries = fresh ? fresh.productEntries[slot] || [] : selectionEntries[slot] || [];
      const storedNotes = fresh ? fresh.noteEntries[slot] || [] : selectionNotes[slot] || [];
      setSelectionNoteDraft(storedNotes);
      setSelectionViewOrderIndex(
        fresh ? fresh.slotOrderIndex[slot] || {} : selectionSlotOrderIndex[slot] || {},
      );
      const storedSubtitle = fresh ? fresh.subtitles[slot] || '' : selectionSubtitles[slot] || '';
      setSubtitleDraft(storedSubtitle);
      setSubtitleBaseline(storedSubtitle);
      const { products, missing, error } = await loadProductsByIds(storedEntries.map((e) => e.id));
      if (error) {
        setSelectionError(error);
        setSelectionDraft([]);
        setSelectionBaseline('');
        return;
      }
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
      setSelectionBaseline(selectionSignature(withNotes, storedNotes));
      setSelectionMissing(missing);
    } catch (err: any) {
      setSelectionError(err?.message || 'Failed to load this selection.');
    } finally {
      setSelectionLoading(false);
    }
  };
  const refreshSelectionView = (): void => {
    if (selectionSlot) {
      openSelectionView(selectionSlot);
    }
  };
  const selectionDraftSignature = useMemo(
    () => selectionSignature(selectionDraft, selectionNoteDraft),
    [selectionDraft, selectionNoteDraft],
  );
  const setSelectionDraftNoteContent = (noteId: string, note: string): void => {
    setSelectionNoteDraft((prev) => {
      const current = prev.find((n) => n.id === noteId);
      if (!current || current.note === note) {
        return prev;
      }
      return prev.map((n) => (n.id === noteId ? { ...n, note } : n));
    });
  };
  const removeNoteFromDraft = (noteId: string): void => {
    setSelectionError(null);
    setSelectionNoteDraft((prev) => prev.filter((n) => n.id !== noteId));
  };
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
  const setSelectionDraftNote = (productId: string, note: string): void => {
    setSelectionDraft((prev) => {
      const current = prev.find((p) => p.id === productId);
      if (!current || (current.note || '') === note) {
        return prev;
      }
      return prev.map((p) => (p.id === productId ? { ...p, note } : p));
    });
  };
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
  const selectionMenuLabel = (slot: PublicSelectionSlotId): string => {
    const variantCount = selectionEntriesVariantCount(
      selectionEntries[slot] || [],
      allLoadedProducts,
    );
    const noteCount = (selectionNotes[slot] || []).length;
    const countLabel = formatSelectionCount(variantCount, noteCount);
    const subtitle = selectionSubtitleFor(slot);
    if (subtitle) {
      return `${toItalic(subtitle)} ${countLabel}`;
    }
    return `${selectionSlotLabel(slot)} ${countLabel}`;
  };
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
  const removeFromSelectionDraft = (productId: string): void => {
    setSelectionError(null);
    setSelectionDraft((prev) => prev.filter((p) => p.id !== productId));
  };
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
    setProductNotes((prev) => {
      const next = { ...prev };
      for (const p of productsToLoad) {
        next[p.id] = p.note || '';
      }
      return next;
    });
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
    setNoteObjects((prev) => {
      const existing = new Set(prev.map((n) => n.id));
      const additions = notesToLoad.filter((n) => !existing.has(n.id));
      return additions.length === 0 ? prev : [...prev, ...additions];
    });
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
    if (isPublicSelection && selectionSlot) {
      const tag = `{{ selection_number=${selectionSlot.slice(-1)}, selection_sub_title=${subtitleDraft}, date=${historyDate(new Date())} }}`;
      const touches: HistoryTouch[] = [
        ...productsToLoad.map(
          (p: ProductData): HistoryTouch => ({ id: p.id, baseNote: p.note || '', tag }),
        ),
        ...notesToLoad.map(
          (n: SelectionEntry): HistoryTouch => ({ id: n.id, baseNote: n.note, tag }),
        ),
      ];
      mutateHistory((current) => applyHistoryTouches(current, touches));
    }
  };
  const saveSelectionDraft = async (): Promise<boolean> => {
    if (!selectionSlot) return false;
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
      setCurrentSelectionOrderIndex(selectionViewOrderIndex);
      setSelectionBaseline(selectionSignature(selectionDraft, selectionNoteDraft));
      return true;
    }
    const key = selectionMetafieldKey(selectionSlot);
    if (!key) {
      setSelectionError('This selection could not be saved.');
      return false;
    }
    setSelectionSaving(true);
    try {
      const ownerId = await ensureShopId(setSelectionError);
      if (!ownerId) {
        return false;
      }
      const entries: SelectionEntry[] = selectionDraft.map((p) => ({
        id: p.id,
        note: p.note || '',
        ...(p.variants.length > 0 && p.variants.length < p.allVariants.length
          ? { variantIds: p.variants.map((v: VariantData) => v.id) }
          : {}),
      }));
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
        return false;
      }
      const numberLabel = selectionSlot.slice(-1);
      const oldIds = new Set([
        ...(selectionEntries[selectionSlot] || []).map((e: SelectionEntry) => e.id),
        ...(selectionNotes[selectionSlot] || []).map((e: SelectionEntry) => e.id),
      ]);
      const addedTouches: HistoryTouch[] = [
        ...entries
          .filter((e: SelectionEntry) => !oldIds.has(e.id))
          .map(
            (e: SelectionEntry): HistoryTouch => ({
              id: e.id,
              baseNote: e.note,
              tag: `{{ selection_number=${numberLabel}, selection_sub_title=${trimmedSubtitle}, action=added, date=${historyDate(new Date())} }}`,
            }),
          ),
        ...selectionNoteDraft
          .filter((n: SelectionEntry) => !oldIds.has(n.id))
          .map(
            (n: SelectionEntry): HistoryTouch => ({
              id: n.id,
              baseNote: n.note,
              tag: `{{ selection_number=${numberLabel}, selection_sub_title=${trimmedSubtitle}, action=added, date=${historyDate(new Date())} }}`,
            }),
          ),
      ];
      const oldSubtitle = selectionSubtitles[selectionSlot] || '';
      const resubtitled = oldSubtitle !== trimmedSubtitle;
      const cleared = oldIds.size > 0 && entries.length === 0 && selectionNoteDraft.length === 0;
      if (addedTouches.length > 0 || resubtitled || cleared) {
        mutateHistory((current) => {
          let next = current;
          if (addedTouches.length > 0) {
            next = applyHistoryTouches(next, addedTouches);
          }
          if (resubtitled) {
            const text = `Selection {{ selection_number=${numberLabel}, old_sub_title=${oldSubtitle}, new_sub_title=${trimmedSubtitle}, date=${historyDate(new Date())} }}`;
            next = appendHistoryLogNote(next, text);
          }
          if (cleared) {
            const text = `Selection {{ selection_number=${numberLabel}, selection_sub_title=${trimmedSubtitle}, action=cleared, date=${historyDate(new Date())} }}`;
            next = appendHistoryLogNote(next, text);
          }
          return next;
        });
      }
      setSelectionEntries((prev) => ({ ...prev, [selectionSlot]: entries }));
      setSelectionNotes((prev) => ({ ...prev, [selectionSlot]: selectionNoteDraft }));
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
      return true;
    } catch (err: any) {
      setSelectionError(err?.message || 'Failed to save this selection.');
      return false;
    } finally {
      setSelectionSaving(false);
    }
  };
  const backFromSelection = (): void => {
    setView('main');
    setSelectionSlot(null);
    setSelectionError(null);
    refreshTemplatesAndProducts();
  };
  const saveSelectionDraftAndLeave = async (): Promise<void> => {
    const saved = await saveSelectionDraft();
    if (saved) {
      backFromSelection();
    }
  };
  const selectionCombinedAll = useMemo<SelectionRow[]>(
    () => combineSelectionRows(selectionDraft, selectionNoteDraft, selectionViewOrderIndex),
    [selectionDraft, selectionNoteDraft, selectionViewOrderIndex],
  );
  const selectionRowsFiltered = useMemo<SelectionRow[]>(() => {
    const term = selectionSearch.trim();
    if (term === '') return selectionCombinedAll;
    return selectionCombinedAll.filter((row: SelectionRow) =>
      row.kind === 'product'
        ? productMatchesQuery(row.product, term)
        : noteMatchesQuery(row.note, term),
    );
  }, [selectionCombinedAll, selectionSearch]);
  const renderEditorView = () => (
    <s-page heading={editingTemplate ? 'Edit template' : 'New template'}>
      <s-stack slot="header-actions" direction="inline" gap="base" justifyContent="space-between">
        <s-stack direction="inline" gap="base">
          {hasUnsavedChanges() ? (
            <s-button icon="arrow-left" commandFor="leave-confirm-modal">
              Back
            </s-button>
          ) : (
            <s-button icon="arrow-left" onClick={backToMain}>
              Back
            </s-button>
          )}
        </s-stack>
        
        {editingTemplate ? (
          <s-button
            icon="delete"
            tone="critical"
            commandFor="delete-template-modal"
            onClick={() => openDeleteModal(editingTemplate.id)}
          >
            Delete template
          </s-button>
        ) : null}
      </s-stack>

      {editorError ? (
        <s-banner tone="critical" heading="Could not save template">
          <s-text>{editorError}</s-text>
        </s-banner>
      ) : null}

      
      {deleteError ? (
        <s-banner tone="critical" heading="Could not delete template">
          <s-text>{deleteError}</s-text>
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
            {renderInsertButtons('')}
            {renderInsertMenus('', insertVariable, true)}
          </s-stack>

          <s-text-area
            label="Body"ssibilityVisibility="exclusive"
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
            details="Can be used to modify the file break behavior.  If evaluates to TRUE, the next file's text will be appended to the current file's text. If Empty or FALSE, the files do not merge. Can use variables, functions, and other objects in the selection using commands."
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
          slot="secondary-actions"
          variant="secondary"
          tone="critical"
          commandFor="leave-confirm-modal"
          command="--hide"
          onClick={confirmLeave}
        >
          Leave without saving
        </s-button>
        <s-button
          slot="secondary-actions"
          variant="auto"
          commandFor="leave-confirm-modal"
          command="--hide"
          onClick={saveTemplate}
        >
          Save Changes
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

      
      <s-modal id="delete-template-modal" heading="Delete template?">
        <s-text>
          "{pendingDeleteTemplate?.title || 'Untitled'}" will be permanently removed and cannot be
          recovered.
        </s-text>
        <s-button
          slot="primary-action"
          variant="primary"
          tone="critical"
          loading={deleting}
          commandFor="delete-template-modal"
          command="--hide"
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
        <s-button
          icon="refresh"
          loading={selectionLoading}
          disabled={selectionLoading}
          onClick={refreshSelectionView}
        >
          Refresh
        </s-button>
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
          Load Selected
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
                          {adminProductUrl(row.product.id, primaryDomain) ? (
                            <s-link
                              href={adminProductUrl(row.product.id, primaryDomain)!}
                              target="_blank"
                            >
                              <s-text type="strong">{row.product.title}</s-text>
                            </s-link>
                          ) : (
                            <s-text type="strong">{row.product.title}</s-text>
                          )}
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
          slot="secondary-actions"
          variant="secondary"
          tone="critical"
          commandFor="selection-leave-modal"
          command="--hide"
          onClick={backFromSelection}
        >
          Leave without saving
        </s-button>
        <s-button
          slot="secondary-actions"
          variant="auto"
          loading={selectionSaving}
          commandFor="selection-leave-modal"
          command="--hide"
          onClick={saveSelectionDraftAndLeave}
        >
          Save Changes
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
      <s-stack slot="header-actions" direction="inline" gap="base" justifyContent="space-between">
        
        <s-stack direction="inline" gap="base">
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
        <s-button icon="settings" accessibilityLabel="Settings" onClick={openSettings}>
          Settings
        </s-button>
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
                  <s-text color="subdued">
                    {formatSelectionCount(currentSelectionVariantCount, noteObjects.length)}{' '}
                    selected
                  </s-text>
                  <s-button icon="caret-down" commandFor="selections-menu">
                    Selections
                  </s-button>
                  
                  <s-menu id="selections-menu" accessibilityLabel="Product selections">
                    <s-section heading="Current">
                      <s-button onClick={() => openSelectionView('current')}>
                        Current Selection{' '}
                        {formatSelectionCount(currentSelectionVariantCount, noteObjects.length)}
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

          {renderProductPager()}

          
          {productsLoading ? <s-spinner accessibilityLabel="Loading products" /> : null}
          {displayedProducts.length === 0 && !productsLoading ? (
            <s-box padding="base">
              <s-text color="subdued">No products found.</s-text>
            </s-box>
          ) : (
            <s-stack gap="none">
              {displayedProducts.map((p, index) => [
                index > 0 ? <s-divider key={`divider-${p.id}`} /> : null,
                renderProductRow(p),
              ])}
            </s-stack>
          )}
          {displayedProducts.length > 0 ? renderProductPager() : null}
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

          
          {deleteError ? (
            <s-box padding="base">
              <s-banner tone="critical" heading="Could not delete template">
                <s-text>{deleteError}</s-text>
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
                      background={isSelected || hoveredTemplateId === tpl.id ? 'subdued' : undefined}
                      onMouseEnter={() => setHoveredTemplateId(tpl.id)}
                      onMouseLeave={() => setHoveredTemplateId((cur) => (cur === tpl.id ? null : cur))}
                      onClick={(e: any) => handleTemplateRowClick(e, tpl)}
                    >
                      <s-grid gridTemplateColumns="1fr auto" gap="small" alignItems="center">
                        <s-clickable inlineSize="100%">
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
        <s-text>
          "{pendingDeleteTemplate?.title || 'Untitled'}" will be permanently removed and cannot be
          recovered.
        </s-text>
        <s-button
          slot="primary-action"
          variant="primary"
          tone="critical"
          loading={deleting}
          commandFor="delete-template-modal"
          command="--hide"
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
  const historyLogNotes = useMemo<SelectionEntry[]>(
    () => historyEntries.filter((e: SelectionEntry) => isStandaloneNote(e)),
    [historyEntries],
  );
  const historyNoteById = useMemo<Record<string, string>>(() => {
    const map: Record<string, string> = {};
    for (const e of historyEntries) {
      if (!isStandaloneNote(e)) map[e.id] = e.note;
    }
    return map;
  }, [historyEntries]);
  const historyProductsWithNotes = useMemo<ProductData[]>(
    () => historyProducts.map((p: ProductData) => ({ ...p, note: historyNoteById[p.id] || '' })),
    [historyProducts, historyNoteById],
  );
  const historyOrderIndex = useMemo<Record<string, number>>(() => {
    const idx: Record<string, number> = {};
    historyEntries.forEach((e: SelectionEntry, i: number) => {
      idx[e.id] = historyEntries.length - 1 - i;
    });
    return idx;
  }, [historyEntries]);
  const historyCombinedAll = useMemo<SelectionRow[]>(
    () => combineSelectionRows(historyProductsWithNotes, historyLogNotes, historyOrderIndex),
    [historyProductsWithNotes, historyLogNotes, historyOrderIndex],
  );
  const historyRowsFiltered = useMemo<SelectionRow[]>(() => {
    const term = historySearch.trim();
    if (term === '') return historyCombinedAll;
    return historyCombinedAll.filter((row: SelectionRow) =>
      row.kind === 'product'
        ? productMatchesQuery(row.product, term)
        : noteMatchesQuery(row.note, term),
    );
  }, [historyCombinedAll, historySearch]);
  const renderSettingsView = () => (
    <s-page heading="Settings">
      <s-button slot="header-actions" icon="arrow-left" onClick={backToMain}>
        Back
      </s-button>
      <s-grid gridTemplateColumns="2fr 1fr" gap="base">
        <s-section heading="History" padding="none">
          <s-box padding="base">
            <s-stack gap="base">
              {historyError ? (
                <s-banner tone="critical" heading="Could not load history">
                  <s-text>{historyError}</s-text>
                </s-banner>
              ) : null}
              <s-search-field
                label="Search history"
                labelAccessibilityVisibility="exclusive"
                placeholder="Search history…"
                value={historySearch}
                onInput={(e: any) => setHistorySearch(e.currentTarget.value)}
              />
              <s-table loading={historyLoading}>
                <s-table-header-row>
                  <s-table-header listSlot="primary">Item</s-table-header>
                  <s-table-header>Handle</s-table-header>
                  <s-table-header>Qty</s-table-header>
                  <s-table-header>History</s-table-header>
                </s-table-header-row>
                <s-table-body>
                  {historyRowsFiltered.length === 0 && !historyLoading ? (
                    <s-table-row>
                      <s-table-cell>
                        <s-text color="subdued">
                          {historyCombinedAll.length === 0 ? 'No history yet.' : 'No items found.'}
                        </s-text>
                      </s-table-cell>
                      <s-table-cell />
                      <s-table-cell />
                      <s-table-cell />
                    </s-table-row>
                  ) : (
                    historyRowsFiltered.map((row: SelectionRow) => (
                      <s-table-row key={row.id}>
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
                              {adminProductUrl(row.product.id, primaryDomain) ? (
                                <s-link
                                  href={adminProductUrl(row.product.id, primaryDomain)!}
                                  target="_blank"
                                >
                                  <s-text type="strong">{row.product.title}</s-text>
                                </s-link>
                              ) : (
                                <s-text type="strong">{row.product.title}</s-text>
                              )}
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
                          <s-text>
                            {row.kind === 'product' ? row.product.note : row.note.note}
                          </s-text>
                        </s-table-cell>
                      </s-table-row>
                    ))
                  )}
                </s-table-body>
              </s-table>
            </s-stack>
          </s-box>
        </s-section>
        <s-section heading="Settings" padding="none">
          <s-box padding="base">
            <s-stack gap="base">
              <s-button commandFor="syntax-guide-modal" command="--show">
                Syntax Guide
              </s-button>
              <s-button onClick={openGlobalVarsPage}>Global Vars</s-button>
            </s-stack>
          </s-box>
        </s-section>
      </s-grid>

      <s-modal id="syntax-guide-modal" heading="Syntax Guide" size="large">
        <s-text-area
          label="Syntax guide"
          labelAccessibilityVisibility="exclusive"
          value={SYNTAX_GUIDE_TEXT}
          rows={24}
          readOnly
        />
        <s-button
          slot="primary-action"
          variant="primary"
          commandFor="syntax-guide-modal"
          command="--hide"
        >
          Close
        </s-button>
      </s-modal>
    </s-page>
  );
  const renderGlobalVarsView = () => (
    <s-page heading="Global Vars">
      <s-button slot="header-actions" icon="arrow-left" onClick={backFromGlobalVars}>
        Back
      </s-button>

      {globalVarError ? (
        <s-banner tone="critical" heading="Could not update global variables">
          <s-text>{globalVarError}</s-text>
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
              <s-heading>Global variables</s-heading>
              <s-button
                icon="plus"
                accessibilityLabel="Add global variable"
                commandFor="global-var-modal"
                command="--show"
                onClick={() => openGlobalVarModal(null)}
              >
                Add
              </s-button>
            </s-stack>
            <s-search-field
              label="Search global variables"
              labelAccessibilityVisibility="exclusive"
              placeholder="Search titles and values…"
              value={globalVarSearch}
              onInput={(e: any) => setGlobalVarSearch(e.currentTarget.value)}
            />
          </s-stack>
        </s-box>

        <s-table>
          <s-table-header-row>
            <s-table-header listSlot="primary">Title</s-table-header>
            <s-table-header>Value</s-table-header>
            <s-table-header>Order</s-table-header>
            <s-table-header>Remove</s-table-header>
          </s-table-header-row>
          <s-table-body>
            {globalVarsFiltered.length === 0 ? (
              <s-table-row>
                <s-table-cell>
                  <s-text color="subdued">
                    {globalVars.length === 0
                      ? 'No global variables yet. Use Add to create one.'
                      : 'No global variables found.'}
                  </s-text>
                </s-table-cell>
                <s-table-cell />
                <s-table-cell />
                <s-table-cell />
              </s-table-row>
            ) : (
              globalVarsFiltered.map((g: GlobalVarEntry) => {
                const isFirst = globalVars[0]?.id === g.id;
                const isLast = globalVars[globalVars.length - 1]?.id === g.id;
                return (
                  <s-table-row key={g.id}>
                    <s-table-cell>
                      <s-text type="strong">{g.title}</s-text>
                    </s-table-cell>
                    <s-table-cell>
                      <s-clickable
                        inlineSize="100%"
                        commandFor="global-var-modal"
                        command="--show"
                        onClick={() => openGlobalVarModal(g)}
                      >
                        <s-text color={g.body ? undefined : 'subdued'}>
                          {g.body ? globalVarBodyPreview(g.body) : 'Click to add a value…'}
                        </s-text>
                      </s-clickable>
                    </s-table-cell>
                    <s-table-cell>
                      
                      <s-stack direction="inline" gap="small-400" alignItems="center">
                        <s-button
                          icon="chevron-up"
                          variant="tertiary"
                          accessibilityLabel={`Move ${g.title} up`}
                          disabled={globalVarSearch.trim() !== '' || isFirst}
                          onClick={() => moveGlobalVar(g.id, -1)}
                        />
                        <s-button
                          icon="chevron-down"
                          variant="tertiary"
                          accessibilityLabel={`Move ${g.title} down`}
                          disabled={globalVarSearch.trim() !== '' || isLast}
                          onClick={() => moveGlobalVar(g.id, 1)}
                        />
                      </s-stack>
                    </s-table-cell>
                    <s-table-cell>
                      <s-button
                        icon="x"
                        variant="tertiary"
                        accessibilityLabel={`Delete ${g.title}`}
                        onClick={() => deleteGlobalVar(g.id)}
                      />
                    </s-table-cell>
                  </s-table-row>
                );
              })
            )}
          </s-table-body>
        </s-table>
      </s-section>

      <s-modal
        id="global-var-modal"
        heading={isNewGlobalVar ? 'New global variable' : 'Edit global variable'}
      >
        <s-stack gap="small">
          <s-text-field
            label="Title"
            value={globalVarTitleDraft}
            error={globalVarTitleError || undefined}
            onInput={(e: any) => setGlobalVarTitleDraft(e.currentTarget.value)}
          />
          {renderInsertButtons('global-')}
          <s-text-area
            label="Value"
            value={globalVarBodyDraft}
            rows={8}
            placeholder="What {{ $global:TITLE }} should evaluate to. Place {{ insert }} where you want to insert a variable, then choose it from the Insert menus above."
            onInput={(e: any) => setGlobalVarBodyDraft(e.currentTarget.value)}
          />
          {renderInsertMenus('global-', insertIntoGlobalBody, false)}
          <s-text color="subdued">
            Reference a global variable in any template with {'{{ $global:'}
            {globalVarTitleDraft.trim() || 'TITLE'}
            {' }}'}
          </s-text>
          
          <s-button variant="tertiary" onClick={clearGlobalVarDraft}>
            Clear
          </s-button>
        </s-stack>
        <s-button
          slot="primary-action"
          variant="primary"
          loading={globalVarSaving}
          commandFor="global-var-modal"
          command="--hide"
          onClick={saveGlobalVarEntry}
        >
          Save
        </s-button>
        <s-button
          slot="secondary-actions"
          variant="secondary"
          commandFor="global-var-modal"
          command="--hide"
        >
          Discard
        </s-button>
      </s-modal>
    </s-page>
  );
  if (view === 'editor') return renderEditorView();
  if (view === 'selection' && selectionSlot) return renderSelectionView();
  if (view === 'settings') return renderSettingsView();
  if (view === 'globals') return renderGlobalVarsView();
  return renderMainView();
}
export default (): void => render(<Extension />, document.body);

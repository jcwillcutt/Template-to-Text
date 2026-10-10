// Product search queries, evaluated in the app (the same text is also sent to Shopify, which understands the same
// operators). Pure functions -- no UI or Shopify dependencies -- so they are unit-tested.
//
//   red mug            words are ANDed (both must match)
//   red OR blue        OR (uppercase)
//   red AND blue       AND is optional
//   -red   NOT red     exclude
//   "red mug"          exact phrase (also 'red mug')
//   (red OR blue) mug  grouping
//   vendor:Acme        field filter: title handle vendor product_type tag sku barcode status, or
//                      metafields.NAMESPACE.KEY:value
//
// A plain word matches if it appears (case-insensitively) in ANY searchable field: title, handle, vendor, product
// type, tags, variant SKUs, the product's note, and every metafield value.

import type { ProductData } from '../domain/types';

export type SearchNode =
  | { t: 'term'; field: string | null; value: string }
  | { t: 'and' | 'or'; parts: SearchNode[] }
  | { t: 'not'; x: SearchNode };

type SearchToken =
  | { k: 'open' }
  | { k: 'close' }
  | { k: 'op'; v: 'OR' | 'AND' | 'NOT' }
  | { k: 'term'; field: string | null; value: string; negated: boolean };

function tokenizeSearch(raw: string): SearchToken[] {
  const tokens: SearchToken[] = [];
  let i = 0;
  const n = raw.length;
  const readQuoted = (quote: string): string => {
    // i points at the opening quote
    const end = raw.indexOf(quote, i + 1);
    const value = end === -1 ? raw.slice(i + 1) : raw.slice(i + 1, end);
    i = end === -1 ? n : end + 1;
    return value;
  };
  while (i < n) {
    const ch = raw[i];
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === '(') {
      tokens.push({ k: 'open' });
      i += 1;
      continue;
    }
    if (ch === ')') {
      tokens.push({ k: 'close' });
      i += 1;
      continue;
    }
    let negated = false;
    if (ch === '-' && i + 1 < n && !/\s/.test(raw[i + 1])) {
      if (raw[i + 1] === '(') {
        tokens.push({ k: 'op', v: 'NOT' });
        i += 1;
        continue;
      }
      negated = true;
      i += 1;
    }
    if (raw[i] === '"' || raw[i] === "'") {
      tokens.push({ k: 'term', field: null, value: readQuoted(raw[i]), negated });
      continue;
    }
    let start = i;
    while (i < n && !/[\s()]/.test(raw[i])) {
      // field:"quoted value" -- the colon is followed by a quote
      if (raw[i] === ':' && (raw[i + 1] === '"' || raw[i + 1] === "'")) break;
      i += 1;
    }
    const word = raw.slice(start, i);
    if (raw[i] === ':' && (raw[i + 1] === '"' || raw[i + 1] === "'")) {
      i += 1;
      tokens.push({ k: 'term', field: word.toLowerCase(), value: readQuoted(raw[i]), negated });
      continue;
    }
    if (!negated && (word === 'OR' || word === 'AND' || word === 'NOT')) {
      tokens.push({ k: 'op', v: word });
      continue;
    }
    const colon = word.indexOf(':');
    if (colon > 0 && colon < word.length - 1) {
      tokens.push({ k: 'term', field: word.slice(0, colon).toLowerCase(), value: word.slice(colon + 1), negated });
    } else if (word !== '') {
      tokens.push({ k: 'term', field: null, value: word, negated });
    } else {
      start = i; // defensive: always make progress
      i += 1;
    }
  }
  return tokens;
}

// Parse a search string. Never throws; unbalanced parentheses are tolerated. Returns null for an empty query.
export function parseSearchQuery(raw: string): SearchNode | null {
  const tokens = tokenizeSearch(raw);
  let pos = 0;
  const peek = (): SearchToken | undefined => tokens[pos];

  const parseOr = (): SearchNode | null => {
    const parts: SearchNode[] = [];
    const first = parseAnd();
    if (first) parts.push(first);
    while (peek() && peek()!.k === 'op' && (peek() as { v: string }).v === 'OR') {
      pos += 1;
      const next = parseAnd();
      if (next) parts.push(next);
    }
    if (parts.length === 0) return null;
    return parts.length === 1 ? parts[0] : { t: 'or', parts };
  };

  const parseAnd = (): SearchNode | null => {
    const parts: SearchNode[] = [];
    for (;;) {
      const tok = peek();
      if (!tok || tok.k === 'close' || (tok.k === 'op' && tok.v === 'OR')) break;
      if (tok.k === 'op' && tok.v === 'AND') {
        pos += 1;
        continue;
      }
      const unit = parseUnary();
      if (unit) parts.push(unit);
    }
    if (parts.length === 0) return null;
    return parts.length === 1 ? parts[0] : { t: 'and', parts };
  };

  const parseUnary = (): SearchNode | null => {
    const tok = peek();
    if (!tok) return null;
    if (tok.k === 'op' && tok.v === 'NOT') {
      pos += 1;
      const inner = parseUnary();
      return inner ? { t: 'not', x: inner } : null;
    }
    if (tok.k === 'open') {
      pos += 1;
      const inner = parseOr();
      if (peek() && peek()!.k === 'close') pos += 1;
      return inner;
    }
    if (tok.k === 'close') {
      pos += 1; // stray `)`
      return null;
    }
    pos += 1;
    if (tok.k === 'term') {
      const term: SearchNode = { t: 'term', field: tok.field, value: tok.value };
      return tok.negated ? { t: 'not', x: term } : term;
    }
    return null; // a stray AND/OR handled by the callers
  };

  const tree = parseOr();
  // Anything left over (e.g. a stray `)` followed by more words) is ANDed on, so no typed word is ever ignored.
  const rest: SearchNode[] = tree ? [tree] : [];
  while (pos < tokens.length) {
    const more = parseOr();
    if (more) rest.push(more);
    else pos += 1;
  }
  if (rest.length === 0) return null;
  return rest.length === 1 ? rest[0] : { t: 'and', parts: rest };
}

// ---------------------------------------------------------------------------------------------
// Matching. Mirrors the legacy plain search for unfielded words (substring over every searchable field).
function fieldValues(product: ProductData, field: string): string[] | null {
  switch (field) {
    case 'title':
      return [product.title];
    case 'handle':
      return [product.handle];
    case 'vendor':
      return [product.vendor];
    case 'product_type':
    case 'producttype':
    case 'type':
      return [product.productType];
    case 'tag':
      return product.tags;
    case 'sku':
      return product.variants.map((v) => v.sku || '').filter(Boolean);
    case 'barcode':
      return product.variants.map((v) => v.barcode || '').filter(Boolean);
    case 'status':
      return [product.status];
    default: {
      const m = /^metafields?\.([^.]+)\.(.+)$/.exec(field);
      if (m) return product.metafields.filter((mf) => mf.namespace.toLowerCase() === m[1] && mf.key.toLowerCase() === m[2]).map((mf) => mf.value);
      return null; // a filter only Shopify can evaluate (collection_id, created_at, inventory_total ...)
    }
  }
}

function plainHaystacks(product: ProductData): string[] {
  const hay: string[] = [product.title, product.handle, product.vendor, product.productType, product.note || '', ...product.tags];
  for (const variant of product.variants) if (variant.sku) hay.push(variant.sku);
  for (const mf of product.metafields) if (mf.value) hay.push(mf.value);
  return hay;
}

const EXACT_FIELDS = new Set(['vendor', 'product_type', 'producttype', 'type', 'tag', 'status']);

export function matchesSearchNode(product: ProductData, node: SearchNode): boolean {
  switch (node.t) {
    case 'and':
      return node.parts.every((p) => matchesSearchNode(product, p));
    case 'or':
      return node.parts.some((p) => matchesSearchNode(product, p));
    case 'not':
      return !matchesSearchNode(product, node.x);
    default: {
      const needle = node.value.toLowerCase();
      if (node.field === null) {
        if (needle === '') return true;
        return plainHaystacks(product).some((h) => (h || '').toLowerCase().includes(needle));
      }
      const values = fieldValues(product, node.field);
      // A filter only Shopify can evaluate matches nothing here (so it never adds products from the local cache).
      if (values === null) return false;
      if (EXACT_FIELDS.has(node.field)) return values.some((v) => (v || '').toLowerCase() === needle);
      return values.some((v) => (v || '').toLowerCase().includes(needle));
    }
  }
}

const parsedCache = new Map<string, SearchNode | null>();

export function matchesSearchQuery(product: ProductData, raw: string): boolean {
  let node = parsedCache.get(raw);
  if (node === undefined) {
    node = parseSearchQuery(raw);
    parsedCache.set(raw, node);
    if (parsedCache.size > 64) parsedCache.delete(parsedCache.keys().next().value as string);
  }
  return node === null ? true : matchesSearchNode(product, node);
}

// ---------------------------------------------------------------------------------------------
// Pasting a spreadsheet column (or row) into the search box.
export const MAX_PASTED_TERMS = 50;

// Pause after the last keystroke before the search runs.
export const SEARCH_DEBOUNCE_MS = 350;

// Quote a pasted value when it would otherwise be read as syntax (spaces, parentheses, a colon, a leading `-`, or
// the words OR / AND / NOT).
export function quoteSearchTerm(term: string): string {
  const clean = term.replace(/"/g, '');
  if (/[\s():'\\]/.test(clean) || clean.startsWith('-') || clean === 'OR' || clean === 'AND' || clean === 'NOT') return `"${clean}"`;
  return clean;
}

export function hasColumnSeparators(text: string): boolean {
  return /[\r\n\t]/.test(text);
}

// Spreadsheets copy a column as lines (a row as tab-separated cells). Turn that into an OR query, exactly as if the
// merchant had typed `a OR b OR c`. Returns null when the text has no line breaks or tabs (ordinary typing).
export function columnToOrQuery(pasted: string): { query: string; count: number; truncated: boolean } | null {
  if (!hasColumnSeparators(pasted)) return null;
  const seen = new Set<string>();
  const terms: string[] = [];
  for (let cell of pasted.split(/\r\n|\n|\r|\t/)) {
    cell = cell.trim();
    // A spreadsheet wraps cells containing quotes/newlines in double quotes and doubles inner quotes.
    if (cell.length >= 2 && cell.startsWith('"') && cell.endsWith('"')) cell = cell.slice(1, -1).replace(/""/g, '"').trim();
    if (cell === '') continue;
    const key = cell.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    terms.push(cell);
  }
  const truncated = terms.length > MAX_PASTED_TERMS;
  const used = terms.slice(0, MAX_PASTED_TERMS);
  return { query: used.map(quoteSearchTerm).join(' OR '), count: used.length, truncated };
}

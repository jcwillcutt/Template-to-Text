// Selection -> render rows/units helpers. Verbatim from the legacy engine.

import type { ProductData, SelectionEntry } from '../domain/types';
import { slugify } from '../format/helpers';

// Expand a single product into one "row" per variant: a shallow product clone whose `variants` array
// contains only that one variant, so `{{ variant.* }}` resolves to that variant. A product with no
// variants yields a single row (the product unchanged, variant tokens resolve to empty).
export function expandProductToRows(product: ProductData): ProductData[] {
  if (!product.variants || product.variants.length <= 1) {
    return [product];
  }
  return product.variants.map((variant) => ({ ...product, variants: [variant] }));
}

// Expand a list of selected products into rows (one entry per variant), preserving product order.
export function expandSelectionToRows(products: ProductData[]): ProductData[] {
  const rows: ProductData[] = [];
  for (const product of products) {
    for (const row of expandProductToRows(product)) {
      rows.push(row);
    }
  }
  return rows;
}

// Wrap a free-standing note entry (a SelectionEntry where isStandaloneNote is true) as a ProductData
// so it can be rendered through the exact same pipeline as a real product/variant row. Every
// product/variant-level field resolves to '' (matching the rule that a product/variant-level detail
// queried on a note returns an empty string), except `.note`, which carries the note's own text --
// so a template reads a note's content through the EXISTING {{ product.note }} token with no new
// template syntax, and every other {{ product.* }}/{{ variant.* }} token resolves to '' the same way
// it already does for any unset field.
export function noteToPseudoProduct(entry: SelectionEntry): ProductData {
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
export function noteFileSlug(entry: SelectionEntry): string {
  return slugify(entry.note.slice(0, 40));
}

// Give each base name (extension-less) in order a de-duplicated version, appending `_1`, `_2`, ...
// on collision -- computed up front so de-duplication is deterministic no matter which order the
// files are actually built in. Shared by every fileBreak mode that produces one file per unit
// (variant / product / note / object).
export function dedupeNames(baseNames: string[]): string[] {
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

// Determine which rows a foreach block should iterate over given skip options. Operates on the
// variant-expanded row list (one entry per variant), so skip_first/skip_last drop the first/last ROW.
// Generic (T, not hardcoded ProductData) since session 9 calls this with KindedRow[] as well.
export function foreachSelection<T>(rows: T[], skipFirst: boolean, skipLast: boolean): T[] {
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

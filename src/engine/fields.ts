// Token resolution: `{{ product.title }}`, `{{ variant.sku }}`, metafields, loop counters, variables,
// `selection.*` neighbours, and the retired-token markers. A token's dotted path is split ONCE at parse
// time; the per-render work is a closure call.

import type { MetafieldData, ProductData, VariantData } from '../domain/types';
import { PRODUCT_FIELD_DEFS, VARIANT_FIELD_DEFS } from './templates-catalog';
import { GLOBAL_PREFIX } from './lexicon';
import { deprecatedSyntaxMarker, globalNotExpandedMarker } from './markers';
import { scopeOf, type Ctx, type Scope } from './ast';

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

// `product.compareAtPrice` / `product.costPerItem` report the ACTIVE variant's value (the first variant
// outside a variant loop), so they read the scope's variant list rather than the row's.
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

export function metafieldValue(product: ProductData, namespace: string, key: string): string {
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

// Resolve an already-split path against a scope. This is the general (slow-path) resolver; compileField
// below specialises the common shapes. Order matters and mirrors the legacy resolver: variables first.
export function resolveParts(sc: Scope, parts: string[], ctx: Ctx): string {
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

// `selection.first/last/curr/next/prev.*`
function resolveSelection(parts: string[], ctx: Ctx, sc: Scope): string {
  const slot = parts[1];
  const rows = ctx.env.rows;
  let target: Scope;
  if (slot === 'first' || slot === 'last') {
    const list = rows.length > 0 ? rows : [sc.row];
    target = scopeOf(slot === 'first' ? list[0] : list[list.length - 1]);
  } else {
    // curr is always the row being rendered; next/prev are null at the ends, which resolves to ''.
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

// Compile a plain `{{ path }}` token (text already trimmed) into a resolver closure.
export function compileField(trimmed: string): (ctx: Ctx, sc: Scope) => string {
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

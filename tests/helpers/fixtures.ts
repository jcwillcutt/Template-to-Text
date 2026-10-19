// Product / variant / note builders shared by tests and benchmarks.
import type { ProductData, VariantData, SelectionEntry } from '../../src/domain/types';

export function makeVariant(i: number, overrides: Partial<VariantData> = {}): VariantData {
  return {
    id: `gid://shopify/ProductVariant/${1000 + i}`,
    title: `Var ${i}`,
    sku: `SKU-${i}`,
    price: (10 + i).toFixed(2),
    compareAtPrice: i % 3 === 0 ? (20 + i).toFixed(2) : null,
    costPerItem: i % 2 === 0 ? '4.00' : null,
    barcode: i % 4 === 0 ? `99${i}` : null,
    inventoryQuantity: i,
    selectedOptions: [{ name: 'Size', value: String(i) }],
    ...overrides,
  };
}

export interface MakeProductOpts extends Omit<Partial<ProductData>, 'variants' | 'metafields'> {
  variants?: number;
  metafields?: [string, string, string][];
}

export function makeProduct(n: number, opts: MakeProductOpts = {}): ProductData {
  const { variants = 1, tags, metafields, note, ...rest } = opts;
  const vs = Array.from({ length: variants }, (_, k) => makeVariant(n * 10 + k, { title: variants === 1 ? 'Default Title' : `V${k}` }));
  return {
    id: `gid://shopify/Product/${n}`,
    title: `Product ${n}`,
    handle: `product-${n}`,
    vendor: n % 2 ? 'Acme Co' : 'Beta Ltd',
    productType: n % 3 ? 'Mug' : 'Plate',
    tags: tags ?? [`t${n % 3}`, 'common'],
    status: 'active',
    description: `Description of product number ${n}, a fine item for everyday use.`,
    totalInventory: n * 2,
    imageUrl: null,
    priceMin: '10.00',
    priceMax: '20.00',
    currencyCode: 'USD',
    createdAt: '2026-01-02T03:04:05Z',
    updatedAt: '2026-02-03T04:05:06Z',
    variants: vs,
    allVariants: vs,
    metafields: (metafields ?? [['custom', 'material', 'Ceramic'], ['productspecs', 'serial', `S${n}`]]).map(([namespace, key, value]) => ({ namespace, key, value })),
    note: note ?? '',
    ...rest,
  };
}

export const makeProducts = (count: number, opts: MakeProductOpts = {}): ProductData[] =>
  Array.from({ length: count }, (_, i) => makeProduct(i + 1, opts));

export const makeNote = (text: string, n = 1): SelectionEntry => ({ id: `note-${n}`, note: text });

export const FIXED_NOW = new Date(2026, 2, 3, 6, 30, 7); // local time, stable for time= tokens

import { describe, expect, it } from 'vitest';
import { render, renderEach } from '../helpers/render';
import { makeProduct, makeProducts, FIXED_NOW } from '../helpers/fixtures';

const p = makeProduct(7, {
  variants: 3,
  tags: ['red', 'blue'],
  note: 'my note',
  metafields: [
    ['custom', 'material', 'Ceramic'],
    ['a.b', 'c.d', 'dotted'],
  ],
});

describe('plain fields', () => {
  it('product fields', () => {
    expect(render('{{ product.title }}|{{ product.handle }}|{{ product.vendor }}|{{ product.productType }}', { products: [p] })).toBe(
      'Product 7|product-7|Acme Co|Mug',
    );
    expect(render('{{ product.status }} {{ product.currencyCode }} {{ product.priceMin }}-{{ product.priceMax }}', { products: [p] })).toBe('active USD 10.00-20.00');
    expect(render('{{ product.tags }}|{{ product.totalInventory }}|{{ product.description }}', { products: [p] })).toBe(
      'red, blue|14|Description of product number 7, a fine item for everyday use.',
    );
    expect(render('{{ product.createdAt }} {{ product.updatedAt }}', { products: [p] })).toBe('2026-01-02T03:04:05Z 2026-02-03T04:05:06Z');
  });
  it('aliases and note spellings', () => {
    expect(render('{{ product.product_type }}', { products: [p] })).toBe('Mug');
    expect(render('{{ product.note }}|{{ product.notes }}|{{ products.note }}|{{ products.notes }}', { products: [p] })).toBe('my note|my note|my note|my note');
  });
  it('whitespace inside braces does not matter', () => {
    expect(render('{{product.title}} {{   product.title   }}', { products: [p] })).toBe('Product 7 Product 7');
  });
  it('unknown tokens render empty', () => {
    expect(render('[{{ nope }}][{{ product.nope }}][{{ a.b.c }}][{{ }}]', { products: [p] })).toBe('[][][][]');
  });
  it('null inventory renders empty', () => {
    expect(render('[{{ product.totalInventory }}]', { products: [{ ...p, totalInventory: null }] })).toBe('[]');
  });
  it('plain text and unbalanced braces pass through', () => {
    expect(render('a { b } c {{ unbalanced', { products: [p] })).toBe('a { b } c {{ unbalanced');
    expect(render('x }} y', { products: [p] })).toBe('x }} y');
  });
  it('shop tokens', () => {
    expect(render('{{ primaryDomain }} {{ selection.length }}', { products: makeProducts(3) })).toBe('shop.myshopify.com 3');
  });
});

describe('variant fields', () => {
  it('in selection mode a variant-row reads its own variant', () => {
    const out = render('{{#selection.foreach product, i=0}}{{ variant.title }}/{{ variant.sku }}/{{ variant.price }}/{{ variant.inventoryQuantity }};{{/selection.foreach}}', {
      products: [p],
    });
    expect(out).toBe('V0/SKU-70/80.00/70;V1/SKU-71/81.00/71;V2/SKU-72/82.00/72;');
  });
  it('compare-at and cost are variant-level; product.* reads the active variant', () => {
    const q = makeProduct(1, { variants: 2 });
    q.variants[0].compareAtPrice = '30.00';
    q.variants[0].costPerItem = '5.50';
    q.variants[1].compareAtPrice = null;
    expect(render('{{ product.compareAtPrice }}|{{ product.costPerItem }}|{{ variant.compareAtPrice }}', { products: [q], fileBreak: 'product' })).toBe('30.00|5.50|30.00');
    expect(render('{{#variants.foreach v}}[{{ product.compareAtPrice }}/{{ variant.barcode }}]{{/variants.foreach}}', { products: [q], fileBreak: 'product' })).toBe('[30.00/][/]');
  });
  it('product.length is the full variant count even inside a variant loop', () => {
    expect(render('{{ product.length }}|{{#variants.foreach v}}{{ product.length }}{{/variants.foreach}}', { products: [p], fileBreak: 'product' })).toBe('3|333');
  });
  it('a product with no variants resolves variant tokens to empty', () => {
    const none = { ...makeProduct(1), variants: [], allVariants: [] };
    expect(render('[{{ variant.sku }}][{{ product.length }}]', { products: [none], fileBreak: 'product' })).toBe('[][0]');
  });
});

describe('metafields', () => {
  it('namespace.key lookup', () => {
    expect(render('{{ product.metafield.custom.material }}', { products: [p] })).toBe('Ceramic');
  });
  it('a missing metafield is empty', () => {
    expect(render('[{{ product.metafield.custom.nothing }}]', { products: [p] })).toBe('[]');
  });
  it('keys may contain dots (everything after the namespace is the key)', () => {
    expect(render('{{ product.metafield.a.b.c.d }}', { products: [p] })).toBe('');
    const q = makeProduct(1, { metafields: [['ns', 'key.with.dots', 'ok']] });
    expect(render('{{ product.metafield.ns.key.with.dots }}', { products: [q] })).toBe('ok');
  });
});

describe('time tokens', () => {
  const at = new Date(2026, 2, 3, 6, 5, 7);
  const t = (f: string) => render(`{{ time=${f} }}`, { now: at });
  it('formats', () => {
    expect(t('MM/dd/yyyy')).toBe('03/03/2026');
    expect(t('h:mm tt')).toBe('6:05 AM');
    expect(t('dddd, MMMM d, yyyy')).toBe('Tuesday, March 3, 2026');
    expect(t('HH:mm:ss')).toBe('06:05:07');
    expect(t("yyyy-MM-dd 'at' H")).toBe('2026-03-03 at 6');
  });
  it('all files in one render share the same time', () => {
    const files = renderEach('{{ time=ss }}', makeProducts(3), { now: at });
    expect(new Set(files).size).toBe(1);
  });
});

describe('retired tokens are flagged, not silently blank', () => {
  it('old date tokens', () => {
    expect(render('{{ day }}', { products: [p] })).toContain('retired');
    expect(render('{{ month.name }}', { products: [p] })).toContain('retired');
    expect(render('{{ year.short }}', { products: [p] })).toContain('retired');
  });
  it('length= and backslash whitespace tokens', () => {
    expect(render('{{ length=abc }}', { products: [p] })).toContain('retired');
    expect(render('a{{ \\n }}b', { products: [p] })).toContain('retired');
    expect(render('a{{ \\t }}b', { products: [p] })).toContain('retired');
  });
});

describe('whitespace and comments', () => {
  it('/return and /space', () => {
    expect(render('a{{ /return }}b{{ /space }}c{{/return}}d', { products: [p] })).toBe('a\nb c\nd');
  });
  it('comments are removed, including multi-line and several', () => {
    expect(render('a{{ #comment }}x\ny{{ /comment }}b{{#comment}}z{{/comment}}c', { products: [p] })).toBe('abc');
  });
  it('an unclosed comment is inert text', () => {
    expect(render('a{{ #comment }}b', { products: [p] })).toBe('a{{ #comment }}b');
  });
});

describe('global variables', () => {
  it('are spliced into the template before it runs', () => {
    expect(render('Hi {{ $global:greet }}!', { globals: { greet: 'there' } })).toBe('Hi there!');
  });
  it('a global sees the template variables at its position', () => {
    expect(render('{{ x = 4 }}{{ $global:g }}', { globals: { g: '{{ = {{x}} * 2 }}' } })).toBe('8');
  });
  it('an undefined global shows a marker', () => {
    expect(render('{{ $global:nope }}')).toContain('no global variable named "nope"');
  });
  it('globals are read-only', () => {
    expect(render('{{ $global:g = 5 }}', { globals: { g: 'v' } })).toContain('read-only');
  });
  it('a global that references another global shows a marker (no nesting)', () => {
    expect(render('{{ $global:a }}', { globals: { a: '{{ $global:b }}', b: 'x' } })).toContain('was not expanded');
  });
});

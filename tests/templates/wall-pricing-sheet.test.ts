import { readFileSync } from 'fs';
import { describe, it, expect } from 'vitest';
import { render } from '../helpers/render';
import { makeProduct, makeProducts } from '../helpers/fixtures';

const TEMPLATE = readFileSync('templates/wall-pricing-sheet.html', 'utf8');
const count = (s: string, re: RegExp) => (s.match(re) || []).length;

describe('wall-pricing-sheet template', () => {
  it('makes one tag per product with no fixed page size', () => {
    const out = render(TEMPLATE, { products: makeProducts(45) });
    expect(count(out, /class="tag"/g)).toBe(45);
    expect(out).not.toContain('class="sheet"');
  });
  it('shows title, price and a QR link to willcuttguitar.com/products/<handle>', () => {
    const out = render(TEMPLATE, { products: [makeProduct(7, { title: 'Fishman Tuner', handle: 'fishman-tuner' })] });
    expect(out).toContain('>Fishman Tuner</div>');
    expect(out).toContain('class="price p1">$80.00<');
    expect(out).toContain('data=https%3A%2F%2Fwillcuttguitar.com%2Fproducts%2Ffishman-tuner"');
  });
  it('makes one tag per selected variant and names non-default variants', () => {
    const out = render(TEMPLATE, { products: [makeProduct(1, { variants: 2 })] });
    expect(count(out, /class="tag"/g)).toBe(2);
    expect(out).toContain('Product 1 - V0');
  });
  it('shrinks long titles and long prices instead of clipping them', () => {
    const long = 'x'.repeat(100);
    const out = render(TEMPLATE, { products: [makeProduct(1, { title: long }), makeProduct(2, { title: 'y'.repeat(200) }), makeProduct(3, { title: 'Short' })] });
    expect(out).toContain('class="title t3"');
    expect(out).toContain('class="title t4"');
    expect(out).toContain('class="title t1"');
  });
  it('renders no tags for an empty selection', () => {
    expect(count(render(TEMPLATE, { products: [] }), /class="tag"/g)).toBe(0);
  });
});

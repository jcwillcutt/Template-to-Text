import { readFileSync } from 'fs';
import { describe, it, expect } from 'vitest';
import { render } from '../helpers/render';
import { makeProduct, makeProducts } from '../helpers/fixtures';

const TEMPLATE = readFileSync('templates/wall-pricing-sheet.html', 'utf8');
const count = (s: string, re: RegExp) => (s.match(re) || []).length;

describe('wall-pricing-sheet template', () => {
  it('puts 40 tags on a sheet and starts a new sheet after that', () => {
    const out = render(TEMPLATE, { products: makeProducts(45) });
    expect(count(out, /class="tag"/g)).toBe(45);
    expect(count(out, /class="sheet"/g)).toBe(2);
  });
  it('exactly 40 products make one sheet', () => {
    expect(count(render(TEMPLATE, { products: makeProducts(40) }), /class="sheet"/g)).toBe(1);
  });
  it('shows title, price and a QR link to willcuttguitar.com/products/<handle>', () => {
    const out = render(TEMPLATE, { products: [makeProduct(7, { title: 'Fishman Tuner', handle: 'fishman-tuner' })] });
    expect(out).toContain('>Fishman Tuner</div>');
    expect(out).toContain('class="price">$80.00<');
    expect(out).toContain('data=https%3A%2F%2Fwillcuttguitar.com%2Fproducts%2Ffishman-tuner"');
  });
  it('makes one tag per selected variant and names non-default variants', () => {
    const out = render(TEMPLATE, { products: [makeProduct(1, { variants: 2 })] });
    expect(count(out, /class="tag"/g)).toBe(2);
    expect(out).toContain('Product 1 - V0');
  });
  it('renders nothing but the page shell for an empty selection', () => {
    expect(count(render(TEMPLATE, { products: [] }), /class="sheet"/g)).toBe(0);
  });
});

// Complexity guards. Wall-clock assertions are noisy, so these compare the SAME scenario at N and 4N inputs and
// allow generous slack: linear work gives ~4x, quadratic work gives ~16x. (Absolute speed lives in `npm run bench`.)
import { describe, expect, it } from 'vitest';
import { renderAll } from '../helpers/render';
import { makeProducts } from '../helpers/fixtures';

function time(fn: () => void, runs = 3): number {
  fn(); // warm up
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    fn();
    samples.push(performance.now() - t0);
  }
  return samples.sort((a, b) => a - b)[Math.floor(runs / 2)];
}

const ratio = (body: string, opts: Parameters<typeof renderAll>[1], n: number): number => {
  const small = makeProducts(n, { variants: 2 });
  const big = makeProducts(n * 4, { variants: 2 });
  const a = time(() => renderAll(body, { ...opts, products: small }));
  const b = time(() => renderAll(body, { ...opts, products: big }));
  return b / Math.max(a, 0.05);
};

describe('work grows linearly with the selection', () => {
  it('combined file over a selection loop', () => {
    const r = ratio('{{#selection.foreach p, i=0}}{{ #if={{ = {{i}}%4 }}==0 }}{{ /return }}{{ #else }},{{ /if }}{{ product.handle }}{{ variant.sku }}{{/selection.foreach}}', { fileBreak: 'selection' }, 1500);
    expect(r).toBeLessThan(9);
  });
  it('one file per variant', () => {
    expect(ratio('{{ product.title }} {{ variant.sku }} {{ #if={{ variant.inventoryQuantity }} > 5 }}hi{{ /if }}', { fileBreak: 'variant' }, 1000)).toBeLessThan(9);
  });
  it('Merge IF grouping (planning evaluates the condition between every pair)', () => {
    expect(ratio('{{ product.title }};', { fileBreak: 'product', merge: '{{ selection.next.product.vendor }} == {{ selection.curr.product.vendor }}' }, 1000)).toBeLessThan(9);
  });
  it('Merge IF over a selection loop split into many files', () => {
    expect(
      ratio('{{#selection.foreach p}}{{ product.handle }};{{/selection.foreach}}', { fileBreak: 'selection', merge: '{{ selection.next.product.productType }} == {{ selection.curr.product.productType }}' }, 600),
    ).toBeLessThan(9);
  });
});

describe('work does not depend on template size once parsed', () => {
  it('rendering many files of a long template re-uses one parse', () => {
    const line = 'L: {{ product.title }} {{ product.handle }} {{ = {{ product.totalInventory }} * 2 }}{{ /return }}';
    const long = line.repeat(120);
    const products = makeProducts(400);
    const t = time(() => renderAll(long, { products, fileBreak: 'product' }));
    // 400 files x 120 lines = 48,000 line-renders; parsing 400 times would take seconds.
    expect(t).toBeLessThan(2500);
  });
});

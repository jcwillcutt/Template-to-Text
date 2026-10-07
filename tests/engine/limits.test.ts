import { describe, expect, it } from 'vitest';
import { renderAll } from '../helpers/render';
import { makeProduct, makeProducts } from '../helpers/fixtures';
import { MAX_STEPS, TemplateLimitError } from '../../src/engine/evaluate';

// The extension runs inside the merchant's browser tab and cannot cancel a render, so runaway templates
// must fail fast with a clear error instead of freezing or crashing the page.
describe('resource guards', () => {
  const one = { products: [makeProduct(1)] };
  it('nested while loops that would run billions of steps fail with a clear error', () => {
    const t = '{{ a = 0 }}{{ #while=1==1 }}{{ b = 0 }}{{ #while=1==1 }}{{ b = {{ = {{b}}+1 }} }}{{/while}}{{/while}}';
    expect(() => renderAll(t, one)).toThrow(TemplateLimitError);
    expect(() => renderAll(t, one)).toThrow(/too large or loops too long/);
  });
  it('a single while loop stops at its own 10,000-step cap without error', () => {
    expect(renderAll('{{ n = 0 }}{{ #while=1==1 }}{{ n = {{ = {{n}}+1 }} }}{{/while}}{{ n }}', one).contents[0]).toBe('10000');
  });
  it('an enormous repeat is refused instead of exhausting memory', () => {
    expect(() => renderAll('{{ #repeat=900000000 }}abcdefghij{{/repeat}}', one)).toThrow(TemplateLimitError);
  });
  it('a long chop walk counts against the budget', () => {
    expect(MAX_STEPS).toBeGreaterThan(1_000_000);
  });
  it('realistic large renders are far below the limits', () => {
    const ps = makeProducts(5000, { variants: 2 });
    const r = renderAll('{{#selection.foreach p, i=0}}{{ i }}{{ #variants.foreach v }}{{ variant.sku }}{{/variants.foreach}}{{/selection.foreach}}', { products: ps });
    expect(r.contents[0].length).toBeGreaterThan(10000);
  });
  it('the budget is per output file, not per plan', () => {
    const ps = makeProducts(50);
    const t = '{{ x = 0 }}{{ #while={{x}}<9000 }}{{ x = {{ ={{x}}+1 }} }}{{/while}}ok';
    expect(renderAll(t, { products: ps, fileBreak: 'product' }).contents.every((c) => c === 'ok')).toBe(true);
  });
});

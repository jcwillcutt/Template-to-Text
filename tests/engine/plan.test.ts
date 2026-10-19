import { describe, expect, it } from 'vitest';
import { renderAll } from '../helpers/render';
import { runLegacy, runNext, normalizeLegacy, type RunOpts } from '../helpers/differential';
import { makeNote, makeProduct, makeProducts } from '../helpers/fixtures';
import { planOutputFiles, buildOutputFiles } from '../../src/engine/index';
import { FIXED_NOW } from '../helpers/fixtures';

const TS = '03-03-2026-06-30-07'; // FIXED_NOW formatted as MM-dd-yyyy-HH-mm-ss
const vendors = (vs: string[]) => vs.map((v, i) => makeProduct(i + 1, { vendor: v }));

describe('file break modes: counts and names', () => {
  const ps = makeProducts(3, { variants: 2 });
  it('variant: one file per variant, named handle_variant_template', () => {
    const r = renderAll('x', { products: ps, fileBreak: 'variant' });
    expect(r.count).toBe(6);
    expect(r.names[0]).toBe('product-1_v0_tpl.txt');
    expect(r.names[5]).toBe('product-3_v1_tpl.txt');
    expect(r.zipName).toBe(`tpl_zipped_${TS}.zip`);
  });
  it('product: one file per product', () => {
    const r = renderAll('{{ product.handle }}', { products: ps, fileBreak: 'product' });
    expect(r.count).toBe(3);
    expect(r.names).toEqual(['product-1_tpl.txt', 'product-2_tpl.txt', 'product-3_tpl.txt']);
    expect(r.contents).toEqual(['product-1', 'product-2', 'product-3']);
  });
  it('a single output file has no zip', () => {
    const r = renderAll('x', { products: [ps[0]], fileBreak: 'product' });
    expect(r.zipName).toBeNull();
    expect(r.names).toEqual(['product-1_tpl.txt']);
  });
  it('selection: one combined file', () => {
    const r = renderAll('x', { products: ps, fileBreak: 'selection' });
    expect(r.count).toBe(1);
    expect(r.names).toEqual([`${TS}_looped_tpl.txt`]);
    expect(r.zipName).toBeNull();
  });
  it('selection with exactly one product is named after its handle', () => {
    expect(renderAll('x', { products: [ps[0]], fileBreak: 'selection' }).names).toEqual(['product-1_tpl.txt']);
  });
  it('note: one file per note, named from the note text', () => {
    const r = renderAll('{{ product.note }}', { products: [], notes: [makeNote('Hello World!'), makeNote('Second', 2)], fileBreak: 'note' });
    expect(r.names).toEqual(['hello-world_tpl.txt', 'second_tpl.txt']);
    expect(r.contents).toEqual(['Hello World!', 'Second']);
  });
  it('object: products then notes', () => {
    const r = renderAll('{{ selection.curr.type }}', { products: ps.slice(0, 2), notes: [makeNote('n')], fileBreak: 'object' });
    expect(r.contents).toEqual(['product', 'product', 'note']);
  });
  it('duplicate names get _1, _2 suffixes', () => {
    const dup = [makeProduct(1), makeProduct(1), makeProduct(1)];
    expect(renderAll('x', { products: dup, fileBreak: 'product' }).names).toEqual(['product-1_tpl.txt', 'product-1_tpl_1.txt', 'product-1_tpl_2.txt']);
  });
  it('the title and extension are sanitised', () => {
    const plan = planOutputFiles('My: Odd/Title!', 'x', '..c$sv', [makeProduct(1)], [], 'product', '', 'd', FIXED_NOW, {});
    expect(plan.build(0).name).toBe('product-1_my-odd-title.csv');
    expect(planOutputFiles('', 'x', '', [makeProduct(1)], [], 'product', '', 'd', FIXED_NOW, {}).build(0).name).toBe('product-1_template.txt');
  });
});

describe('edge cases', () => {
  it('no file break selected refuses with an actionable error (count 1 so the caller surfaces it)', () => {
    const plan = planOutputFiles('t', 'x', 'txt', [makeProduct(1)], [], null, '', 'd', FIXED_NOW, {});
    expect(plan.count).toBe(1);
    expect(() => plan.build(0)).toThrow(/no file break selected/);
  });
  it('per-unit modes with nothing to render produce zero files', () => {
    for (const fb of ['variant', 'product', 'note', 'object'] as const) {
      const plan = planOutputFiles('t', 'x', 'txt', [], [], fb, '', 'd', FIXED_NOW, {});
      expect(plan.count).toBe(0);
      expect(() => plan.build(0)).toThrow(/No files to build/);
    }
  });
  it("'selection' with nothing selected still plans one file", () => {
    expect(planOutputFiles('t', 'x', 'txt', [], [], 'selection', '', 'd', FIXED_NOW, {}).count).toBe(1);
  });
  it('buildOutputFiles builds every file', () => {
    const out = buildOutputFiles('t', '{{ product.handle }}', 'txt', makeProducts(3), [], 'product', '', 'd', FIXED_NOW, {});
    expect(out.files.map((f) => f.content)).toEqual(['product-1', 'product-2', 'product-3']);
    expect(out.zipName).toBe(`t_zipped_${TS}.zip`);
  });
  it('files may be built in any order and more than once', () => {
    const plan = planOutputFiles('t', '{{ n }}{{ n = 1 }}{{ product.handle }}', 'txt', makeProducts(3), [], 'product', '', 'd', FIXED_NOW, {});
    const a = plan.build(2).content;
    const b = plan.build(0).content;
    expect(a).toBe('product-3');
    expect(b).toBe('product-1');
    expect(plan.build(2).content).toBe(a);
  });
});

describe('Merge IF', () => {
  const body = '{{#selection.foreach product}}{{ product.vendor }}:{{ product.handle }};{{/selection.foreach}}';
  const same = '{{ selection.next.product.vendor }} == {{ selection.curr.product.vendor }}';
  const ps = vendors(['A', 'A', 'B', 'B', 'B', 'C']);
  it("'selection' mode splits the first loop's items into files when the condition is TRUE between neighbours", () => {
    const r = renderAll(body, { products: ps, fileBreak: 'selection', merge: same });
    expect(r.count).toBe(3);
    expect(r.contents).toEqual(['A:product-1;A:product-2;', 'B:product-3;B:product-4;B:product-5;', 'C:product-6;']);
    expect(r.names).toEqual([`${TS}_looped_tpl_0.txt`, `${TS}_looped_tpl_1.txt`, `${TS}_looped_tpl_2.txt`]);
    expect(r.zipName).toBe(`tpl_zipped_${TS}.zip`);
  });
  it('an empty Merge IF keeps one combined file', () => {
    expect(renderAll(body, { products: ps, fileBreak: 'selection' }).count).toBe(1);
  });
  it('the loop counter restarts at its start value in every file', () => {
    const r = renderAll('{{#selection.foreach product, i=1}}{{ i }}{{/selection.foreach}}', { products: ps, fileBreak: 'selection', merge: same });
    expect(r.contents).toEqual(['12', '123', '1']);
  });
  it('selection.prev/next still see the true neighbours across file boundaries', () => {
    const r = renderAll('{{#selection.foreach product}}[{{ selection.prev.product.handle }}|{{ selection.next.product.handle }}]{{/selection.foreach}}', { products: ps.slice(0, 4), fileBreak: 'selection', merge: same });
    expect(r.contents[0]).toBe('[|product-2][product-1|product-3]');
    expect(r.contents[1]).toBe('[product-2|product-4][product-3|]');
  });
  it('per-unit modes append merged units into one file', () => {
    const r = renderAll('{{ product.handle }};', { products: ps, fileBreak: 'product', merge: same });
    expect(r.contents).toEqual(['product-1;product-2;', 'product-3;product-4;product-5;', 'product-6;']);
  });
  it('a non-empty Merge IF switches naming to the chunk convention even if nothing merges', () => {
    const r = renderAll('x', { products: vendors(['A', 'B']), fileBreak: 'product', merge: same });
    expect(r.names).toEqual([`${TS}_looped_tpl_0.txt`, `${TS}_looped_tpl_1.txt`]);
  });
  it('everything merging into one group gives a single looped file', () => {
    const r = renderAll('{{ product.handle }};', { products: vendors(['A', 'A', 'A']), fileBreak: 'product', merge: same });
    expect(r.count).toBe(1);
    expect(r.zipName).toBeNull();
    expect(r.names).toEqual([`${TS}_looped_tpl.txt`]);
    expect(r.contents[0]).toBe('product-1;product-2;product-3;');
  });
  it('a malformed condition never merges', () => {
    expect(renderAll('x', { products: vendors(['A', 'A']), fileBreak: 'product', merge: '1 ==' }).count).toBe(1 + 1);
  });
  it('conditions can use position tokens and equations', () => {
    // totalInventory is 2,4,6,8: merge a unit with the next one when the next one's inventory % 4 == 0
    const r = renderAll('{{ product.handle }};', { products: makeProducts(4), fileBreak: 'product', merge: '{{ = {{ selection.next.product.totalInventory }} % 4 }} == 0' });
    expect(r.contents).toEqual(['product-1;product-2;', 'product-3;product-4;']);
  });
});

describe('History source ids', () => {
  it('per-unit modes list each unit', () => {
    const plan = planOutputFiles('t', 'x', 'txt', makeProducts(3), [makeNote('n')], 'object', '', 'd', FIXED_NOW, {});
    expect(plan.sourceIdsByIndex).toEqual([['gid://shopify/Product/1'], ['gid://shopify/Product/2'], ['gid://shopify/Product/3'], ['note-1']]);
  });
  it("'selection' lists every iterated item, or the first row when there is no loop", () => {
    const ps = makeProducts(3);
    expect(planOutputFiles('t', '{{#selection.foreach p}}x{{/selection.foreach}}', 'txt', ps, [], 'selection', '', 'd', FIXED_NOW, {}).sourceIdsByIndex[0]).toHaveLength(3);
    expect(planOutputFiles('t', 'no loop {{ product.title }}', 'txt', ps, [], 'selection', '', 'd', FIXED_NOW, {}).sourceIdsByIndex).toEqual([['gid://shopify/Product/1']]);
  });
  it('merged groups list their members', () => {
    const plan = planOutputFiles('t', '{{#selection.foreach p}}x{{/selection.foreach}}', 'txt', vendors(['A', 'A', 'B']), [], 'selection', '{{ selection.next.product.vendor }} == {{ selection.curr.product.vendor }}', 'd', FIXED_NOW, {});
    expect(plan.sourceIdsByIndex).toEqual([['gid://shopify/Product/1', 'gid://shopify/Product/2'], ['gid://shopify/Product/3']]);
  });
});

// File counts, names, zip name and source ids are logic carried over from the legacy engine: they must be identical.
describe('planning matches the legacy engine exactly', () => {
  const base: RunOpts[] = [
    { products: makeProducts(4, { variants: 2 }), fileBreak: 'variant' },
    { products: makeProducts(4, { variants: 2 }), fileBreak: 'product' },
    { products: makeProducts(4, { variants: 2 }), fileBreak: 'selection' },
    { products: [makeProduct(1)], fileBreak: 'selection' },
    { products: makeProducts(3), notes: [makeNote('Alpha Beta'), makeNote('Alpha Beta', 2)], fileBreak: 'object' },
    { products: [], notes: [makeNote('x')], fileBreak: 'note' },
    { products: vendors(['A', 'A', 'B', 'C', 'C']), fileBreak: 'product', merge: '{{ selection.next.product.vendor }} == {{ selection.curr.product.vendor }}' },
    { products: vendors(['A', 'A', 'B', 'C', 'C']), fileBreak: 'selection', merge: '{{ selection.next.product.vendor }} == {{ selection.curr.product.vendor }}' },
    { products: [], fileBreak: 'variant' },
  ];
  base.forEach((o, i) => {
    it(`case ${i}: ${o.fileBreak}${o.merge ? ' + merge' : ''}`, () => {
      const body = '{{#selection.foreach product}}{{ product.handle }};{{/selection.foreach}}';
      const a = normalizeLegacy(runLegacy(body, o));
      const b = runNext(body, o);
      expect(b.count).toBe(a.count);
      expect(b.names).toEqual(a.names);
      expect(b.zipName).toBe(a.zipName);
      expect(b.sourceIds).toEqual(a.sourceIds);
      expect(b.contents).toEqual(a.contents);
    });
  });
});

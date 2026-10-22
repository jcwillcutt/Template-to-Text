import { describe, it, expect } from 'vitest';
import { planMultiTemplateDownload, type MultiTemplateInput } from '../../src/engine/index';
import { makeProducts, FIXED_NOW } from '../helpers/fixtures';

const tpl = (title: string, fileBreak: MultiTemplateInput['fileBreak'], body = '{{ product.title }}', extension = 'txt'): MultiTemplateInput => ({
  title,
  body,
  extension,
  fileBreak,
  mergeCondition: '',
});

function run(templates: MultiTemplateInput[], mode: 'grouped' | 'alternate', n = 2) {
  const plan = planMultiTemplateDownload(templates, makeProducts(n), [], 'shop.myshopify.com', FIXED_NOW, {}, mode);
  const entries = Array.from({ length: plan.count }, (_, i) => plan.build(i));
  return { plan, names: entries.map((e) => e.name), entries };
}

describe('multi-template downloads', () => {
  it('is named multiple-templates-<date time>.zip', () => {
    const { plan } = run([tpl('A', 'product'), tpl('B', 'product')], 'grouped');
    expect(plan.zipName).toBe('multiple-templates-03-03-2026-06-30-07.zip');
  });
  it('grouped: each template keeps the folder/files a single download would make', () => {
    const { names } = run([tpl('Tag', 'product'), tpl('Sheet', 'selection')], 'grouped');
    expect(names).toEqual([
      'tag_zipped_03-03-2026-06-30-07/product-1_tag.txt',
      'tag_zipped_03-03-2026-06-30-07/product-2_tag.txt',
      '03-03-2026-06-30-07_looped_sheet.txt',
    ]);
  });
  it('grouped: a single-file template sits at the root', () => {
    const { names } = run([tpl('A', 'product'), tpl('B', 'product')], 'grouped', 1);
    expect(names).toEqual(['product-1_a.txt', 'product-1_b.txt']);
  });
  it('alternate, same type: no subfolders, product 1 template 1, product 1 template 2, product 2 ...', () => {
    const { names, entries } = run([tpl('A', 'product', 'A:{{ product.title }}'), tpl('B', 'product', 'B:{{ product.title }}')], 'alternate');
    expect(names).toEqual(['1_product-1_a.txt', '2_product-1_b.txt', '3_product-2_a.txt', '4_product-2_b.txt']);
    expect(entries.map((e) => e.content)).toEqual(['A:Product 1', 'B:Product 1', 'A:Product 2', 'B:Product 2']);
    expect(names.some((n) => n.includes('/'))).toBe(false);
  });
  it('alternate, different types: one subfolder per type, same-type templates interleaved inside', () => {
    const { names } = run([tpl('A', 'product'), tpl('S', 'selection'), tpl('B', 'product')], 'alternate');
    expect(names).toEqual([
      'product-03-03-2026-06-30-07/1_product-1_a.txt',
      'product-03-03-2026-06-30-07/2_product-1_b.txt',
      'product-03-03-2026-06-30-07/3_product-2_a.txt',
      'product-03-03-2026-06-30-07/4_product-2_b.txt',
      'selection-03-03-2026-06-30-07/1_03-03-2026-06-30-07_looped_s.txt',
    ]);
  });
  it('pads sequence numbers so they sort', () => {
    const { names } = run([tpl('A', 'product'), tpl('B', 'product')], 'alternate', 6);
    expect(names[0].startsWith('01_')).toBe(true);
    expect(names[11].startsWith('12_')).toBe(true);
  });
  it('dedupes identical names', () => {
    const { names } = run([tpl('Same', 'selection'), tpl('Same', 'selection')], 'grouped');
    expect(new Set(names).size).toBe(2);
  });
  it('lists the source ids per file, aligned with the build order', () => {
    const { plan } = run([tpl('A', 'product'), tpl('B', 'product')], 'alternate');
    expect(plan.sourceIdsByIndex.map((ids) => ids[0])).toEqual([
      'gid://shopify/Product/1', 'gid://shopify/Product/1', 'gid://shopify/Product/2', 'gid://shopify/Product/2',
    ]);
  });
});

// Every worked example in `template-syntax-guide`, run against the engine. Where the guide's stated output
// does not match what the engine (old and new alike) actually does, the test asserts the real behaviour and
// says so -- those are documentation bugs (see docs/syntax-guide-audit.md).
import { describe, expect, it } from 'vitest';
import { render, renderAll } from '../helpers/render';
import { runLegacy, normalizeLegacy } from '../helpers/differential';
import { makeProduct } from '../helpers/fixtures';
import type { ProductData } from '../../src/domain/types';

const mug: ProductData = makeProduct(1, {
  title: 'Blue Mug',
  handle: 'blue-mug',
  vendor: 'Acme Co',
  description: 'The Best New Product',
  tags: ['kitchen', 'blue'],
  variants: 1,
  metafields: [['custom', 'material', 'Ceramic'], ['custom', 'color', 'Blue']],
});
mug.variants[0] = { ...mug.variants[0], sku: 'MUG-BLU-01', price: '12.00', compareAtPrice: '15.00' };
mug.allVariants = mug.variants;
const red: ProductData = { ...makeProduct(2, { title: 'Red Mug', handle: 'red-mug', vendor: 'Acme Co' }) };

const g = (t: string, products: ProductData[] = [mug], fileBreak: 'product' | 'selection' = 'product'): string => render(t, { products, fileBreak });

const cases: [string, string, string, ProductData[]?, ('product' | 'selection')?][] = [
  ['1. product + variant fields', '{{ product.title }} ({{ product.vendor }}) -- {{ variant.sku }}, ${{ variant.price }}', 'Blue Mug (Acme Co) -- MUG-BLU-01, $12.00'],
  ['2. metafield', '{{ product.metafield.custom.material }}', 'Ceramic'],
  ['3. time MM/dd/yyyy', '{{ time=MM/dd/yyyy }}', '03/03/2026'],
  ['3. time h:mm tt', '{{ time=h:mm tt }}', '6:30 AM'],
  ['3. time long', '{{ time=dddd, MMMM d, yyyy }}', 'Tuesday, March 3, 2026'],
  ['5. variable math', '{{ x = 3 }}\n{{ x = {{ ={{x}}*2 }} }}\nTotal: {{ x }}'.replace(/\n/g, ''), 'Total: 6'],
  ['5. chained replace in a variable', '{{ title = {{ #replace=&, replacement=and }}{{ product.title }}{{/replace}} }}{{ title = {{ #replace=u, replacement=U }}{{ title }}{{/replace}} }}{{ title }}', 'BlUe MUg'],
  ['6. booleans', '{{ TRUE != FALSE }}|{{ 3 > 2 }}|{{ {{ product.vendor }} == Acme Co }}', 'TRUE|TRUE|TRUE'],
  ['6. grouped condition', '{{ ({{x}} >= 10 && {{y}} < 5) || 1==1 }}', 'TRUE'],
  ['7. if / else', '{{ #if={{ product.totalInventory }} > 0 }}In stock{{ #else }}Out of stock{{ /if }}', 'In stock'],
  ['8a. variants loop', '{{ #variants.foreach v, l=0 }}{{ variant.title }}: {{ variant.price }}{{/variants.foreach}}', 'Default Title: 12.00'],
  ['8b. tags loop', '{{ #tags.foreach tag, i=0 }}#{{ tag }} {{/tags.foreach}}', '#kitchen #blue '],
  ['8c. selection loop', '{{ #selection.foreach product, i=0 }}{{ i }}. {{ product.title }} -- {{ product.handle }}\n{{/selection.foreach}}', '0. Blue Mug -- blue-mug\n1. Red Mug -- red-mug\n', [mug, red], 'selection'],
  ['8d. metafields loop', '{{ #metafields.foreach mf, i=0 }}{{ mf.namespace }}.{{ mf.key }}: {{ mf.value }}\n{{/metafields.foreach}}', 'custom.material: Ceramic\ncustom.color: Blue\n'],
  ['8e. while', '{{ x = 1 }}{{ #while={{x}}<5 }}{{ x }},{{ x = {{ ={{x}}+1 }} }}{{/while}}', '1,2,3,4,'],
  ['9. length', '{{ #length }}{{ product.title }}{{/length}}', '8'],
  ['9. chop', '{{ #chop={{ {{j}}==3 }}, direction=L, j=0 }}{{ product.title }}{{/chop}}', 'Blu'],
  ['9. replace', '{{ #replace=aba, replacement=y }}ababab{{/replace}}', 'ybab'],
  ['9. index', '{{ #index=-1 }}{{ product.title }}{{/index}}', 'g'],
  ['9. insert', '{{ #insert=0, drop=FALSE }}>> {{/insert}}Blue Mug', '>> Blue Mug'],
  ['9. wrap hard', '{{#wrap=3, max_wraps=0, hard=TRUE, delineator=, }}{{ product.description }}{{/wrap}}', 'The, Be,st ,New, Pr,odu,ct'],
  ['10. comment', 'a{{ #comment }}note to self{{ /comment }}b', 'ab'],
  ['11. selection tokens', '{{ selection.length }} {{ selection.first.product.handle }} {{ selection.last.product.handle }}', '2 blue-mug red-mug', [mug, red], 'selection'],
];

describe('syntax guide examples', () => {
  for (const [name, tpl, want, ps, fb] of cases) {
    it(name, () => {
      expect(g(tpl, ps ?? [mug], fb ?? 'product')).toBe(want);
    });
  }
});

describe('13. Merge IF example: keep appending while the next product has the same vendor', () => {
  it('merges neighbours with the same vendor into one file', () => {
    const other = makeProduct(3, { title: 'Other', handle: 'other', vendor: 'Beta Ltd' });
    const r = renderAll('{{ product.title }};', { products: [mug, red, other], fileBreak: 'product', merge: '{{ selection.next.product.vendor }} == {{ selection.curr.product.vendor }}' });
    expect(r.contents).toEqual(['Blue Mug;Red Mug;', 'Other;']);
  });
});

describe('guide examples whose stated output is NOT what the engine does (documentation bugs)', () => {
  it('6. `{{ product.vendor == Acme Co }}`: a bare field name inside an expression is just text, so this compares the words "product.vendor" and "Acme Co". Wrap the field: `{{ {{ product.vendor }} == Acme Co }}`', () => {
    expect(g('{{ product.vendor == Acme Co }}')).toBe('FALSE');
    expect(g('{{ {{ product.vendor }} == Acme Co }}')).toBe('TRUE');
  });
  it('9. repeat: `{{ product.sku }}` is not a product field (SKU lives on the variant), so the guide’s "SKU1;SKU1;SKU1" is really ";;"', () => {
    expect(g('{{ #repeat=3, delineator=; }}{{ product.sku }}{{/repeat}}')).toBe(';;');
    expect(g('{{ #repeat=3, delineator=; }}{{ variant.sku }}{{/repeat}}')).toBe('MUG-BLU-01;MUG-BLU-01;MUG-BLU-01');
  });
  it('9. replace: `{{ product.price }}` is not a field either (use variant.price / product.priceMin)', () => {
    expect(g('{{ #replace=$, replacement=&dollar; }}Was ${{ variant.price }} now ${{ variant.compareAtPrice }}!{{/replace}}')).toBe('Was &dollar;12.00 now &dollar;15.00!');
  });
  it('9. wrap: width 10 breaks "The Best New Product" into three rows, not "The Best New / Product"', () => {
    expect(g('{{#wrap=10, min_wraps=0, max_wraps=0, hard=FALSE, delineator={{ /return }}}}{{ product.description }}{{/wrap}}')).toBe('The Best\nNew\nProduct');
  });
  it('9. wrap: typed spaces around a delineator are trimmed, so ` / ` behaves as `/` (use {{ /space }} for padding)', () => {
    expect(g('{{#wrap=10, min_wraps=4, delineator= / }}{{ product.description }}{{/wrap}}')).toBe('The Best/New/Product/');
  });
});

describe('the examples that hold also hold on the legacy engine (no behaviour changed)', () => {
  const stable = cases.filter(([name]) => !['5. variable math', '7. if / else', '8e. while'].includes(name));
  for (const [name, tpl, , ps, fb] of stable) {
    it(name, () => {
      const o = { products: ps ?? [mug], fileBreak: (fb ?? 'product') as 'product' | 'selection' };
      const legacy = normalizeLegacy(runLegacy(tpl, o)).contents[0];
      expect(g(tpl, o.products, o.fileBreak)).toBe(legacy);
    });
  }
});

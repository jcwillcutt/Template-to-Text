import { describe, expect, it } from 'vitest';
import { render } from '../helpers/render';
import { makeProduct, makeProducts, makeNote } from '../helpers/fixtures';

const p = makeProduct(1, { variants: 3, tags: ['red', 'green', 'blue'], metafields: [['custom', 'a', '1'], ['custom', 'b', '2']] });
const opts = { products: [p], fileBreak: 'product' as const };

describe('variants.foreach', () => {
  it('iterates the in-scope variants with a counter', () => {
    expect(render('{{ #variants.foreach v, l=0 }}{{ l }}:{{ variant.title }};{{/variants.foreach}}', opts)).toBe('0:V0;1:V1;2:V2;');
  });
  it('counter start and custom counter name', () => {
    expect(render('{{ #variants.foreach v, k=5 }}{{ k }}{{/variants.foreach}}', opts)).toBe('567');
    expect(render('{{ #variants.foreach v, l={{ = 2*2 }} }}{{ l }}{{/variants.foreach}}', opts)).toBe('456');
  });
  it('aliases: variant.foreach and product.foreach (no label)', () => {
    expect(render('{{ #variant.foreach }}{{ variant.title }}{{/variant.foreach}}', opts)).toBe('V0V1V2');
    expect(render('{{ #product.foreach, l=0 }}{{ variant.title }}{{/product.foreach}}', opts)).toBe('V0V1V2');
  });
  it('only the selected variants are iterated', () => {
    const narrowed = { ...p, variants: [p.variants[0], p.variants[2]] };
    expect(render('{{ #variants.foreach v }}{{ variant.title }}{{/variants.foreach}}', { products: [narrowed], fileBreak: 'product' })).toBe('V0V2');
  });
  it('a product with no variants renders the body once', () => {
    const none = { ...p, variants: [], allVariants: [] };
    expect(render('{{ #variants.foreach v, l=3 }}[{{ l }}]{{/variants.foreach}}', { products: [none], fileBreak: 'product' })).toBe('[3]');
  });
  it('the retired tied parameter is flagged', () => {
    expect(render('{{ #variants.foreach v, tied=TRUE }}x{{/variants.foreach}}', opts)).toContain('tied parameter no longer does anything');
  });
  it('a nested variant loop iterates only the outer loop\'s current variant', () => {
    expect(render('{{ #variants.foreach a, l=0 }}{{ #variants.foreach b, l=0 }}{{ l }}{{/variants.foreach}}|{{/variants.foreach}}', opts)).toBe('0|0|0|'); // inside a row the active variant list is that single variant, so the inner loop runs once
  });
});

describe('tags.foreach / metafields.foreach', () => {
  it('tags', () => {
    expect(render('{{ #tags.foreach t, i=0 }}{{ i }}={{ tag }};{{/tags.foreach}}', opts)).toBe('0=red;1=green;2=blue;');
  });
  it('no tags renders nothing', () => {
    expect(render('[{{ #tags.foreach t }}x{{/tags.foreach}}]', { products: [{ ...p, tags: [] }], fileBreak: 'product' })).toBe('[]');
  });
  it('metafields expose namespace/key/value', () => {
    expect(render('{{ #metafields.foreach m, i=1 }}{{ i }}.{{ mf.namespace }}.{{ mf.key }}={{ mf.value }};{{/metafields.foreach}}', opts)).toBe('1.custom.a=1;2.custom.b=2;');
  });
  it('mf.* is empty outside the loop and restored after it', () => {
    expect(render('[{{ mf.key }}]{{ #metafields.foreach m }}{{ mf.key }}{{/metafields.foreach}}[{{ mf.key }}]', opts)).toBe('[]ab[]');
  });
});

describe('while', () => {
  it('counts with your own variable', () => {
    expect(render('{{ x = 1 }}{{ #while={{x}}<5 }}{{ x }},{{ x = {{ ={{x}}+1 }} }}{{/while}}', opts)).toBe('1,2,3,4,');
  });
  it('is capped at 10,000 steps', () => {
    expect(render('{{ n = 0 }}{{ #while=1==1 }}{{ n = {{ = {{n}}+1 }} }}{{/while}}{{ n }}', opts)).toBe('10000');
  });
  it('the legacy bounded form is flagged, not run', () => {
    expect(render('{{ #while=1==1, {{k}}=0<5 }}z{{/while}}', opts)).toContain('retired');
  });
  it('accepts the old no-hash opener', () => {
    expect(render('{{ x = 0 }}{{ while={{x}}<2 }}a{{ x = {{ ={{x}}+1 }} }}{{/while}}', opts)).toBe('aa');
  });
});

describe('break and skip', () => {
  it('skip discards the whole iteration, break also stops', () => {
    expect(render('{{ #tags.foreach t, i=0 }}{{ #if={{i}}==1 }}{{ skip }}{{ /if }}{{ tag }};{{/tags.foreach}}', opts)).toBe('red;blue;');
    expect(render('{{ #tags.foreach t, i=0 }}{{ #if={{i}}==1 }}{{ break }}{{ /if }}{{ tag }};{{/tags.foreach}}', opts)).toBe('red;');
  });
  it('text before the signal in the same iteration is discarded too', () => {
    expect(render('{{ #tags.foreach t, i=0 }}before-{{ tag }}-{{ #if={{i}}==1 }}{{ break }}{{ /if }}after;{{/tags.foreach}}', opts)).toBe('before-red-after;');
  });
  it('an inner loop consumes its own break; the outer loop continues', () => {
    expect(
      render('{{ #tags.foreach t, i=0 }}{{ tag }}:{{ #variants.foreach v, l=0 }}{{ #if={{l}}==1 }}{{ break }}{{ /if }}{{ variant.title }},{{/variants.foreach}};{{/tags.foreach}}', opts),
    ).toBe('red:V0,;green:V0,;blue:V0,;');
  });
  it('a break raised BEFORE an inner loop still stops the outer iteration', () => {
    expect(render('{{ #tags.foreach t, i=0 }}{{ break }}{{ #variants.foreach v }}x{{/variants.foreach}}{{/tags.foreach}}end', opts)).toBe('end');
  });
  it('break/skip in a while and a selection loop', () => {
    expect(render('{{ x = 0 }}{{ #while=1==1 }}{{ x = {{ ={{x}}+1 }} }}{{ #if={{x}}>3 }}{{ break }}{{ /if }}{{x}}{{/while}}', opts)).toBe('123');
    expect(render('{{#selection.foreach product, i=0}}{{ #if={{i}}==1 }}{{ skip }}{{ /if }}{{ product.handle }};{{/selection.foreach}}', { products: makeProducts(3) })).toBe('product-1;product-3;');
  });
  it('outside any loop they are inert and invisible', () => {
    expect(render('a{{ break }}b{{ skip }}c', opts)).toBe('abc');
  });
});

describe('text tools', () => {
  it('replace is literal, global and non-overlapping; replacement may be empty', () => {
    expect(render('{{ #replace=aba, replacement=y }}ababab{{/replace}}', opts)).toBe('ybab');
    expect(render('{{ #replace=a }}banana{{/replace}}', opts)).toBe('bnn');
    expect(render('{{ #replace=$, replacement=&dollar; }}Was $10{{/replace}}', opts)).toBe('Was &dollar;10');
    expect(render('{{ #replace=., replacement=! }}a.b.c{{/replace}}', opts)).toBe('a!b!c');
  });
  it('an empty search is a no-op', () => {
    expect(render('{{ #replace=, replacement=X }}abc{{/replace}}', opts)).toBe('abc');
  });
  it('search and replacement can be tokens', () => {
    expect(render('{{ s = a }}{{ r = Z }}{{ #replace={{ s }}, replacement={{ r }} }}banana{{/replace}}', opts)).toBe('bZnZnZ');
  });
  it('replacement can contain commas and whitespace tokens', () => {
    expect(render('{{ #replace=-, replacement=, }}a-b{{/replace}}', opts)).toBe('a,b');
    expect(render('{{ #replace=;, replacement={{ /return }} }}a;b{{/replace}}', opts)).toBe('a\nb');
  });
  it('repeat', () => {
    expect(render('{{ #repeat=3, delineator=; }}ab{{/repeat}}', opts)).toBe('ab;ab;ab');
    expect(render('{{ #repeat=1 }}x{{/repeat}}', opts)).toBe('x');
    expect(render('{{ #repeat=0 }}x{{/repeat}}', opts)).toBe('');
    expect(render('{{ #repeat=2.5 }}x{{/repeat}}', opts)).toBe('');
    expect(render('{{ #repeat={{ = 1+1 }}, delineator={{ /space }} }}x{{/repeat}}', opts)).toBe('x x');
  });
  it('index counts characters, negative from the end', () => {
    expect(render('{{ #index=0 }}hello{{/index}}{{ #index=-1 }}hello{{/index}}{{ #index=9 }}hello{{/index}}', opts)).toBe('ho');
  });
  it('index counts code points, not UTF-16 units', () => {
    expect(render('{{ #index=1 }}a😀b{{/index}}', opts)).toBe('😀');
  });
  it('insert splices into the surrounding text', () => {
    expect(render('Blue{{ #insert=0 }}>> {{/insert}}Mug', opts)).toBe('Blue>> Mug');
    expect(render('Blue Mug{{ #insert=-4 }}!{{/insert}}', opts)).toBe('Blue! Mug');
    expect(render('{{ #insert=99 }}X{{/insert}}abc', opts)).toBe('abcX');
    expect(render('{{ #insert=99, drop=TRUE }}X{{/insert}}abc', opts)).toBe('abc');
    expect(render('ab{{ #insert=1 }}-{{/insert}}cd', opts)).toBe('ab' + 'c-d');
  });
  it('length counts characters of the rendered, trimmed content', () => {
    expect(render('{{ #length }}{{ product.title }}{{/length}}', opts)).toBe('9');
    expect(render('{{ #length }}  hi  {{/length}}', opts)).toBe('2');
    expect(render('{{ #length }}😀😀{{/length}}', opts)).toBe('2');
  });
  it('chop keeps what comes before the condition first becomes true', () => {
    expect(render('{{ #chop={{ {{j}}==3 }}, direction=L, j=0 }}Blue Mug{{/chop}}', opts)).toBe('Blu');
    expect(render('{{ #chop={{ {{j}}==3 }}, direction=R, j=0 }}Blue Mug{{/chop}}', opts)).toBe('Mug');
    expect(render('{{ #chop={{ {{j}}==99 }} }}short{{/chop}}', opts)).toBe('short');
    expect(render('{{ #chop={{ {{j}}==2 }}, j=1 }}abcdef{{/chop}}', opts)).toBe('a');
  });
  it('trim is an alias for chop', () => {
    expect(render('{{ #trim={{ {{j}}==2 }} }}abcdef{{/trim}}', opts)).toBe('ab');
  });
  it('wrap', () => {
    expect(render('{{#wrap=10, delineator={{ /return }}}}The Best New Product{{/wrap}}', opts)).toBe('The Best\nNew\nProduct');
    // Typed spaces around a delineator are trimmed (the syntax guide's `delineator= / ` example is wrong); use /space.
    expect(render('{{#wrap=10, min_wraps=4, delineator= / }}The Best New Product{{/wrap}}', opts)).toBe('The Best/New/Product/');
    expect(render('{{#wrap=10, min_wraps=4, delineator={{ /space }}/{{ /space }}}}The Best New Product{{/wrap}}', opts)).toBe('The Best / New / Product / ');
    expect(render('{{#wrap=10, max_wraps=2, delineator=/}}The Best New Product{{/wrap}}', opts)).toBe('The Best/New Product');
    expect(render('{{#wrap=3, hard=TRUE, delineator=, }}The Best{{/wrap}}', opts)).toBe('The, Be,st');
  });
  it('wrap with an invalid width leaves the text alone', () => {
    expect(render('{{#wrap=abc}}hello world{{/wrap}}', opts)).toBe('hello world');
    expect(render('{{#wrap=0}}hello world{{/wrap}}', opts)).toBe('hello world');
  });
  it('tools nest', () => {
    expect(render('{{ #repeat=2, delineator=| }}{{ #replace=a, replacement=A }}banana{{/replace}}{{/repeat}}', opts)).toBe('bAnAnA|bAnAnA');
    expect(render('{{ #length }}{{ #repeat=3 }}ab{{/repeat}}{{/length}}', opts)).toBe('6');
  });
});

describe('selection.foreach', () => {
  const ps = makeProducts(4);
  it('iterates products with a counter', () => {
    expect(render('{{#selection.foreach product, i=0}}{{ i }}.{{ product.handle }};{{/selection.foreach}}', { products: ps })).toBe('0.product-1;1.product-2;2.product-3;3.product-4;');
  });
  it('counter start and name', () => {
    expect(render('{{#selection.foreach product, n=10}}{{ n }}{{/selection.foreach}}', { products: ps })).toBe('10111213');
    expect(render('{{#selection.foreach product, i={{ = 2+3 }}}}{{ i }}{{/selection.foreach}}', { products: ps })).toBe('5678');
  });
  it('skip_first / skip_last', () => {
    expect(render('{{#selection.foreach product, i=0, skip_first=TRUE}}{{ product.handle }};{{/selection.foreach}}', { products: ps })).toBe('product-2;product-3;product-4;');
    expect(render('{{#selection.foreach product, i=0, skip_last=TRUE}}{{ product.handle }};{{/selection.foreach}}', { products: ps })).toBe('product-1;product-2;product-3;');
    expect(render('{{#selection.foreach product, skip_first=TRUE, skip_last=TRUE}}{{ product.handle }};{{/selection.foreach}}', { products: ps })).toBe('product-2;product-3;');
  });
  it('skipping with a single row leaves nothing', () => {
    expect(render('[{{#selection.foreach product, skip_first=TRUE}}x{{/selection.foreach}}]', { products: [ps[0]] })).toBe('[]');
  });
  it('products.foreach and notes.foreach are separate spellings', () => {
    expect(render('{{#products.foreach p}}{{ product.handle }};{{/products.foreach}}', { products: ps })).toBe('product-1;product-2;product-3;product-4;');
    expect(render('{{#notes.foreach n, i=0}}{{ i }}={{ product.note }};{{/notes.foreach}}', { products: ps, notes: [makeNote('a'), makeNote('b', 2)] })).toBe('0=a;1=b;');
  });
  it('selection.foreach note(s) and object(s)', () => {
    const notes = [makeNote('N1'), makeNote('N2', 2)];
    expect(render('{{#selection.foreach notes}}{{ product.note }};{{/selection.foreach}}', { products: ps, notes })).toBe('N1;N2;');
    expect(render('{{#selection.foreach objects}}{{ selection.curr.type }};{{/selection.foreach}}', { products: ps.slice(0, 2), notes })).toBe('variant;variant;note;note;');
  });
  it('a variant-expanded selection iterates one row per variant', () => {
    const v = makeProduct(1, { variants: 2 });
    expect(render('{{#selection.foreach product}}{{ variant.title }};{{/selection.foreach}}', { products: [v] })).toBe('V0;V1;');
  });
  it('closing-tag label is optional', () => {
    expect(render('{{#selection.foreach product}}a{{/selection.foreach product}}b{{#selection.foreach}}c{{/selection.foreach}}', { products: [ps[0]] })).toBe('abc');
  });
  it('nested selection loops use their own counters', () => {
    expect(render('{{#selection.foreach a, i=0}}{{#selection.foreach b, j=0}}{{ i }}{{ j }} {{/selection.foreach}}|{{/selection.foreach}}', { products: ps.slice(0, 2) })).toBe('00 01 |10 11 |');
  });
  it('counts and prev/next position', () => {
    expect(render('{{#selection.foreach product}}{{ selection.prev.product.handle }}<{{ product.handle }}>{{ selection.next.product.handle }};{{/selection.foreach}}', { products: ps.slice(0, 3) })).toBe(
      '<product-1>product-2;product-1<product-2>product-3;product-2<product-3>;',
    );
  });
  it('position tokens after a loop describe the enclosing scope again', () => {
    expect(render('{{#selection.foreach product}}{{/selection.foreach}}[{{ selection.next.type }}]', { products: ps })).toBe('[]');
  });
  it('selection.first / last', () => {
    expect(render('{{ selection.first.product.handle }}..{{ selection.last.product.handle }}', { products: ps })).toBe('product-1..product-4');
    expect(render('{{ selection.first.note }}', { products: [{ ...ps[0], note: 'first!' }] })).toBe('first!');
  });
  it('a selection loop inside a while loop is flattened (iterates the single current row)', () => {
    expect(render('{{ x = 0 }}{{ #while={{x}}<2 }}{{#selection.foreach product}}[{{ product.handle }}]{{/selection.foreach}}{{ x = {{ ={{x}}+1 }} }}{{/while}}', { products: ps })).toBe('[product-1][product-1]');
  });
  it('the retired i=0<N chunk syntax is flagged', () => {
    expect(render('{{#selection.foreach product, i=0<2}}x{{/selection.foreach}}', { products: ps })).toContain('chunk-size syntax');
  });
  it('rendering with an empty selection does not throw', () => {
    expect(render('[{{ product.title }}][{{ selection.first.product.handle }}]{{#selection.foreach p}}x{{/selection.foreach}}', { products: [] })).toBe('[][]');
  });
});

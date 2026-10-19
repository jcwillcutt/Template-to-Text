// The new engine against the legacy engine (the oracle): same input, same output -- except for the documented,
// intentional fixes listed in `intentional divergences` below.
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { runLegacy, runNext, normalizeLegacy, type RunOpts } from '../helpers/differential';
import { makeNote, makeProduct } from '../helpers/fixtures';
import { templateArb, mergeArb } from '../helpers/template-gen';
import type { FileBreak, ProductData } from '../../src/domain/types';

const products: ProductData[] = [
  makeProduct(1, { variants: 2, tags: ['red', 'blue'], note: 'first note' }),
  makeProduct(2, { variants: 1, tags: [] }),
  makeProduct(3, { variants: 3, tags: ['a', 'b', 'c'], note: 'plain' }),
  makeProduct(4, { variants: 2, tags: ['x'], vendor: 'Acme Co' }),
];
const notes = [makeNote('note one'), makeNote('Note two!', 2)];
const modes: FileBreak[] = ['variant', 'product', 'selection', 'object', 'note'];

function same(body: string, o: RunOpts): void {
  const a = normalizeLegacy(runLegacy(body, o));
  const b = runNext(body, o);
  if (a.error || b.error) {
    // Both engines must agree on whether the render fails (the file-break/empty-selection errors).
    expect(Boolean(b.error), `${o.fileBreak}: ${JSON.stringify(body)} error legacy=${a.error} next=${b.error}`).toBe(Boolean(a.error));
    return;
  }
  expect(b, `${o.fileBreak} ${JSON.stringify(body)}`).toEqual(a);
}

describe('curated corpus: identical to legacy in every file-break mode', () => {
  const corpus = [
    'plain text only',
    '{{ product.title }}|{{ product.handle }}|{{ product.vendor }}|{{ product.productType }}|{{ product.tags }}|{{ product.totalInventory }}',
    '{{ variant.title }}|{{ variant.sku }}|{{ variant.price }}|{{ variant.compareAtPrice }}|{{ product.compareAtPrice }}|{{ product.length }}',
    '{{ product.metafield.custom.material }}|{{ product.metafield.productspecs.serial }}|{{ product.metafield.nope.nope }}',
    '{{ product.note }}|{{ product.notes }}|{{ products.note }}|{{ products.notes }}',
    '{{ x = 5 }}{{ x }}{{ = {{x}} * 2 }}{{ y = {{ = {{x}} + 1 }} }}{{ y }}',
    '{{ #if={{ product.totalInventory }} > 2 }}big{{ #else }}small{{ /if }}',
    '{{ #if=1==1 }}{{ #if=2==3 }}no{{ #else }}nested{{ /if }}{{ /if }}',
    '{{ #variants.foreach v, l=0 }}[{{ l }}:{{ variant.sku }}]{{/variants.foreach}}',
    '{{ #variants.foreach v, l=3 }}{{ l }}{{/variants.foreach}}',
    '{{ #tags.foreach t, i=0 }}{{ i }}={{ tag }};{{/tags.foreach}}',
    '{{ #metafields.foreach m, i=0 }}{{ mf.namespace }}.{{ mf.key }}={{ mf.value }};{{/metafields.foreach}}',
    '{{ #repeat=3, delineator=- }}ab{{/repeat}}',
    '{{ #replace=o, replacement=0 }}{{ product.title }} foo{{/replace}}',
    '{{ #chop={{ {{j}}==4 }}, j=0 }}{{ product.title }}{{/chop}}',
    '{{ #chop={{ {{j}}==4 }}, direction=R, j=0 }}{{ product.title }}{{/chop}}',
    '{{ #index=1 }}{{ product.title }}{{/index}}{{ #index=-1 }}{{ product.title }}{{/index}}',
    'a{{ #insert=2 }}XX{{/insert}}bcdef',
    '{{ #length }}{{ product.title }}{{/length}}',
    '{{#wrap=10, delineator={{ /return }}}}{{ product.description }}{{/wrap}}',
    '{{#wrap=5, hard=TRUE, delineator=|}}{{ product.title }}{{/wrap}}',
    '{{ x = 0 }}{{ #while={{x}}<3 }}{{ x }},{{ x = {{ ={{x}}+1 }} }}{{/while}}',
    '{{ time=MM/dd/yyyy h:mm tt }} {{ primaryDomain }} {{ selection.length }}',
    '{{ #comment }}hidden{{ /comment }}shown',
    'line1{{ /return }}line2{{ /space }}x',
    '{{ 3 > 2 }} {{ {{ product.vendor }} == Acme Co }}',
    '{{ selection.curr.type }}|{{ selection.next.product.title }}|{{ selection.prev.product.title }}|{{ selection.first.product.handle }}|{{ selection.last.product.handle }}',
    '{{#selection.foreach product, i=0}}{{ i }}:{{ product.title }}{{ variant.title }};{{/selection.foreach}}',
    '{{#selection.foreach product, i=0}}{{ #if={{ = {{ i }}%2 }} == 0 }}E{{ #else }}O{{ /if }}{{/selection.foreach}}',
    '{{#selection.foreach product, i=0, skip_first=TRUE, skip_last=TRUE}}{{ i }}{{/selection.foreach}}',
    '{{#notes.foreach n, i=0}}[{{ product.note }}]{{/notes.foreach}}',
    '{{#selection.foreach object, i=0}}<{{ selection.curr.type }}>{{/selection.foreach}}',
    '{{#selection.foreach product}}{{#selection.foreach inner}}{{ product.handle }},{{/selection.foreach}};{{/selection.foreach}}',
    '{{ \\n }}old',
    '{{ day }} {{ month.name }} {{ year.short }}',
    '{{ length=abc }}',
    '{{ x = 1 }}{{ #while=1==1, {{k}}=0<5 }}z{{/while}}',
    '{{#selection.foreach p, i=0<2}}x{{/selection.foreach}}',
    '{{ unknown }}|{{ product.nope }}|{{ foo.bar }}',
    '{{ #if={{ = 1/0 }} }}t{{ #else }}f{{ /if }}',
    '{{ #if={{ = i%4 }}==0 }}Z{{ /if }}',
    '{{ #repeat=2.5 }}x{{/repeat}}{{ #repeat=-1 }}y{{/repeat}}',
    '{{ #replace=, replacement=X }}abc{{/replace}}',
    '{{ #index=1 }}{{ #index=0 }}hello{{/index}}{{/index}}',
    '{{ #tags.foreach t }}{{ #variants.foreach v }}{{ tag }}{{ variant.sku }};{{/variants.foreach}}{{/tags.foreach}}',
    '{{ a = {{ #replace=a, replacement=b }}banana{{/replace}} }}{{ a }}',
    '{{ #if=1==1 }}A {{ product.handle }}',
    '{{ /if }}stray{{ #else }}',
    'unbalanced {{ product.title',
    '{{ }}{{}}{{   }}',
    '{{ $dollar = 1 }}{{ $dollar }}{{ my-var = 2 }}{{ my-var }}',
    '{{ repeat = 5 }}[{{ repeat }}]',
    '{{ product.title }}{{ product.title }}{{ product.title }}',
  ];
  corpus.forEach((body, n) => {
    it(`#${n}: ${body.slice(0, 70).replace(/\n/g, '⏎')}`, () => {
      for (const fileBreak of modes) same(body, { products, notes, fileBreak });
    });
  });
});

describe('Merge IF and globals', () => {
  it('merge conditions across modes', () => {
    const merges = [
      '{{ selection.next.product.vendor }} == {{ selection.curr.product.vendor }}',
      '{{ = {{ selection.next.product.totalInventory }} % 4 }} == 0',
      '{{ selection.curr.type }} == {{ selection.next.type }}',
      '1 ==',
      'TRUE',
    ];
    for (const merge of merges) for (const fileBreak of modes) {
      same('{{ product.title }};{{#selection.foreach p}}<{{ p }}{{ product.handle }}>{{/selection.foreach}}', { products, notes, fileBreak, merge });
    }
  });
  it('globals', () => {
    const globals = { g: 'G{{ product.handle }}', h: '{{ = 1 + 2 }}', n: '{{ $global:g }}' };
    for (const fileBreak of modes) same('{{ $global:g }}|{{ $global:h }}|{{ $global:n }}|{{ $global:missing }}|{{ $global:g = 2 }}', { products, notes, fileBreak, globals });
  });
});

describe('random templates (property test)', () => {
  it('match the legacy engine in every file-break mode', () => {
    for (const wrap of [true, false]) {
      fc.assert(
        fc.property(templateArb({ wrap }), mergeArb, fc.constantFrom(...modes), (body, merge, fileBreak) => {
          same(body, { products, notes, fileBreak, merge });
        }),
        { numRuns: Number(process.env.FUZZ_RUNS ?? 1500), seed: Number(process.env.FUZZ_SEED ?? 20260401) },
      );
    }
  });
  it('match with a different selection (single product, no variants, no notes)', () => {
    const single = [makeProduct(9, { variants: 1, tags: ['t'] })];
    fc.assert(
      fc.property(templateArb({ wrap: false }), fc.constantFrom(...modes), (body, fileBreak) => {
        same(body, { products: single, notes: [], fileBreak });
      }),
      { numRuns: Number(process.env.FUZZ_RUNS ?? 1000), seed: Number(process.env.FUZZ_SEED ?? 7) },
    );
  });
});

// ---------------------------------------------------------------------------------------------
// Where the new engine intentionally differs. Each case pins BOTH behaviours so a change is deliberate.
describe('intentional divergences from the legacy engine', () => {
  const o: RunOpts = { products: [makeProduct(3, { variants: 3 })], fileBreak: 'selection' };
  const L = (b: string) => normalizeLegacy(runLegacy(b, o)).contents[0];
  const N = (b: string) => runNext(b, o).contents[0];
  const cases: [string, string, string, string][] = [
    ['if reads a variable', '{{ x = 5 }}{{ #if={{ x }} > 3 }}Y{{ #else }}N{{ /if }}', 'N', 'Y'],
    ['if reads an equation over a variable', '{{ x = 5 }}{{ #if={{ = {{x}}*2 }} == 10 }}Y{{ #else }}N{{ /if }}', 'N', 'Y'],
    ['if inside a while loop reads its variable', '{{ n = 0 }}{{ #while={{n}}<3 }}{{ #if={{n}}==1 }}M{{ #else }}{{n}}{{ /if }}{{ n = {{ ={{n}}+1 }} }}{{/while}}', '012', '0M2'],
    ['variable assigned after a selection loop is read before it? (document order)', '{{ b = 100 }}{{#selection.foreach p, i=0}}{{ b }}{{/selection.foreach}}', '', '100100100'],
    ['note text containing braces is data, not template', '{{#notes.foreach n}}{{ product.note }}{{/notes.foreach}}', '', ''],
    ['NOT of an empty value', '{{ #if=!{{ product.note }} }}empty{{ #else }}has{{ /if }}', 'has', 'empty'],
    ['a value containing operators does not change the condition', '{{ #if={{ product.vendor }} == A && B }}m{{ #else }}n{{ /if }}', 'n', 'n'],
    ['break/skip outside a loop leave no control characters', 'a{{ break }}b{{ skip }}c', 'abc', 'abc'],
  ];
  it.each(cases)('%s', (_name, body, legacy, next) => {
    if (_name.startsWith('note text')) return; // exercised separately below
    expect(L(body)).toBe(legacy);
    expect(N(body)).toBe(next);
  });
  it('if inside a variants loop reads the counter', () => {
    const three: RunOpts = { products: [makeProduct(3, { variants: 3 })], fileBreak: 'product' };
    const body = '{{ #variants.foreach v, l=0 }}{{ #if={{ l }}==0 }}a{{ #else }}b{{ /if }}{{/variants.foreach}}';
    expect(normalizeLegacy(runLegacy(body, three)).contents[0]).toBe('bbb');
    expect(runNext(body, three).contents[0]).toBe('abb');
  });
  it('note text containing braces is data (legacy re-rendered it inside selection loops)', () => {
    const withNote: RunOpts = { products: [makeProduct(1)], notes: [makeNote('hi {{ product.handle }}')], fileBreak: 'selection' };
    const body = '{{#notes.foreach n}}[{{ product.note }}]{{/notes.foreach}}';
    expect(normalizeLegacy(runLegacy(body, withNote)).contents[0]).toBe('[hi product-1]'); // evaluated as template code
    expect(runNext(body, withNote).contents[0]).toBe('[hi {{ product.handle }}]');
  });
  it('rendering with an empty selection: legacy throws, the new engine renders blanks', () => {
    const empty: RunOpts = { products: [], fileBreak: 'selection' };
    expect(runLegacy('{{ product.title }}', empty).error).toBeTruthy();
    expect(runNext('[{{ product.title }}]', empty).contents[0]).toBe('[]');
  });
});

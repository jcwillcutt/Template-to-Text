// Random template generator for differential tests. It only produces constructs on which the legacy engine
// is known to be CORRECT, so any difference between the engines on its output is a real bug in the new one.
// Deliberately excluded (legacy bugs the new engine fixes on purpose, see docs/engine-rewrite.md):
//   * `#if` conditions that read variables assigned with `{{ x = .. }}` or loop counters other than the
//     selection-loop counter `i`;
//   * variables assigned before/after a selection loop and read on the other side of it;
//   * data containing `{{`/`}}`; `!` applied to a possibly-empty value.
import fc from 'fast-check';

const text = fc.stringMatching(/^[A-Za-z0-9 ,.;:\n-]{0,10}$/);

const fields = [
  '{{ product.title }}', '{{ product.handle }}', '{{ product.vendor }}', '{{ product.productType }}', '{{ product.tags }}',
  '{{ product.totalInventory }}', '{{ product.priceMin }}', '{{ product.description }}', '{{ product.note }}', '{{ product.length }}',
  '{{ variant.title }}', '{{ variant.sku }}', '{{ variant.price }}', '{{ variant.compareAtPrice }}', '{{ variant.inventoryQuantity }}',
  '{{ product.compareAtPrice }}', '{{ product.costPerItem }}',
  '{{ product.metafield.custom.material }}', '{{ product.metafield.productspecs.serial }}', '{{ product.metafield.nope.nope }}',
  '{{ selection.length }}', '{{ primaryDomain }}', '{{ selection.curr.type }}', '{{ selection.next.product.handle }}',
  '{{ selection.prev.product.title }}', '{{ selection.first.product.handle }}', '{{ selection.last.product.handle }}',
  '{{ selection.curr.note }}', '{{ time=MM/dd/yyyy h:mm tt }}', '{{ time=yyyy }}', '{{ nothing }}', '{{ /return }}', '{{ /space }}',
];

const simpleConds = [
  '{{ product.totalInventory }} > 4', '{{ product.totalInventory }} <= 4', '{{ product.vendor }} == Acme Co', '{{ product.vendor }} != Acme Co',
  '1 == 1', '1 == 2', '{{ = 2 + 3 }} == 5', '{{ product.productType }} == Mug', '{{ variant.inventoryQuantity }} >= 20',
  '({{ product.totalInventory }} > 2) && ({{ product.totalInventory }} < 9)', '{{ product.totalInventory }} < 3 || {{ product.vendor }} == Beta Ltd',
  '!({{ product.vendor }} == Acme Co)', '{{ product.metafield.custom.material }} == Ceramic', '{{ = {{ product.totalInventory }} % 4 }} == 0',
  '{{ product.note }}', '{{ product.metafield.nope.nope }}', '{{ product.title }} == {{ product.title }}', 'TRUE', 'FALSE', '0', '1',
];

export interface GenCtx {
  // The counter variable of the enclosing selection-style loop (`i` for selection/products loops, `k` for notes
  // loops), usable in conditions; null outside such loops.
  counter: string | null;
  // Inside a text tool or another wrap. The legacy engine applies wrap AFTER everything else, as a text
  // substitution over the rendered output, so a wrap tag inside replace/repeat/index/insert/length/chop (which
  // operate on that raw tag text) or inside another wrap is mangled. We don't generate those.
  inTextTool: boolean;
  // Inside a variants/tags/metafields/while loop. A selection loop nested in another loop is expanded BEFORE the
  // outer loop starts in the legacy engine, so counters they share (l, n, ...) don't interact there; in document
  // order they do. We don't generate that nesting.
  inLoop: boolean;
  depth: number;
}

// `wrap: true` generates wrap blocks but no insert blocks; `wrap: false` the opposite. The legacy engine applies wrap
// as a text substitution AFTER everything else, while insert splices into the text around it counting the raw
// (not yet wrapped) characters -- so the two only agree when they don't meet.
export function templateArb(opts: { wrap: boolean } = { wrap: true }): fc.Arbitrary<string> {
  const tie = (ctx: GenCtx): fc.Arbitrary<string> => {
    const next = { ...ctx, depth: ctx.depth + 1 };
    const leaf = fc.oneof({ weight: 3, arbitrary: text }, { weight: 4, arbitrary: fc.constantFrom(...fields) });
    if (ctx.depth >= 3) return leaf;
    const seq = (c: GenCtx): fc.Arbitrary<string> => fc.array(tie(c), { minLength: 1, maxLength: 4 }).map((a) => a.join(''));
    const c = ctx.counter;
    const conds = c ? [...simpleConds, `{{ ${c} }} == 1`, `{{ = {{ ${c} }} % 2 }} == 0`, `{{ ${c} }} > 0`] : simpleConds;
    const block = (open: fc.Arbitrary<string>, close: string, c: GenCtx = next) => fc.tuple(open, seq(c)).map(([o, inner]) => `${o}${inner}${close}`);
    return fc.oneof(
      { weight: 5, arbitrary: leaf },
      // if / else
      { weight: 4, arbitrary: fc.tuple(fc.constantFrom(...conds), seq(next), fc.option(seq(next), { nil: null })).map(([c, a, b]) => `{{ #if=${c} }}${a}${b === null ? '' : `{{ #else }}${b}`}{{ /if }}`) },
      { weight: 1, arbitrary: fc.tuple(fc.constantFrom(...conds), fc.constantFrom(...conds), seq(next), seq(next)).map(([c1, c2, a, b]) => `{{ #if=${c1} }}{{ #if=${c2} }}${a}{{ #else }}${b}{{ /if }}{{ #else }}${b}{{ /if }}`) },
      // text tools
      { weight: 2, arbitrary: block(fc.constantFrom('{{ #replace=a, replacement=A }}', '{{ #replace=o, replacement= }}', '{{ #replace=e }}', '{{ #replace=Product, replacement=P- }}'), '{{/replace}}', { ...next, inTextTool: true }) },
      { weight: 2, arbitrary: block(fc.constantFrom('{{ #repeat=2 }}', '{{ #repeat=3, delineator=; }}', '{{ #repeat=1 }}', '{{ #repeat=0 }}', '{{ #repeat={{ = 1+1 }}, delineator=, }}'), '{{/repeat}}', { ...next, inTextTool: true }) },
      { weight: 1, arbitrary: block(fc.constantFrom('{{ #index=0 }}', '{{ #index=2 }}', '{{ #index=-1 }}', '{{ #index=40 }}'), '{{/index}}', { ...next, inTextTool: true }) },
      { weight: opts.wrap ? 0 : 1, arbitrary: block(fc.constantFrom('{{ #insert=0 }}', '{{ #insert=3 }}', '{{ #insert=-2, drop=TRUE }}', '{{ #insert=99 }}'), '{{/insert}}', { ...next, inTextTool: true }) },
      { weight: 1, arbitrary: block(fc.constant('{{ #length }}'), '{{/length}}', { ...next, inTextTool: true }) },
      { weight: 2, arbitrary: block(fc.constantFrom('{{ #chop={{ {{j}}==3 }}, j=0 }}', '{{ #chop={{ {{j}}==2 }}, direction=R, j=0 }}', '{{ #chop={{ {{j}}>=4 }}, j=1 }}', '{{ #trim={{ {{j}}==5 }} }}'), '{{/chop}}', { ...next, inTextTool: true }) },
      { weight: ctx.inTextTool || !opts.wrap ? 0 : 2, arbitrary: block(fc.constantFrom('{{#wrap=10, delineator={{ /return }}}}', '{{#wrap=6, hard=TRUE, delineator=|}}', '{{#wrap=8, min_wraps=3, delineator=/}}', '{{#wrap=7, max_wraps=2, delineator={{ /return }}}}', '{{#wrap=x}}'), '{{/wrap}}', { ...next, inTextTool: true }) },
      // loops over the current product
      { weight: 2, arbitrary: block(fc.constantFrom('{{ #variants.foreach v, l=0 }}', '{{ #variants.foreach v, l=5 }}', '{{ #product.foreach }}'), '{{/variants.foreach}}', { ...next, inLoop: true }) },
      { weight: 1, arbitrary: fc.tuple(seq({ ...next, inLoop: true })).map(([a]) => `{{ #variants.foreach v, l=0 }}{{ l }}${a}{{ #if={{ product.totalInventory }} > 3 }}{{ skip }}{{ /if }}{{ variant.sku }}{{/variants.foreach}}`) },
      { weight: 2, arbitrary: block(fc.constantFrom('{{ #tags.foreach t, n=0 }}', '{{ #tags.foreach t, q=3 }}'), '{{/tags.foreach}}', { ...next, inLoop: true }) },
      { weight: 1, arbitrary: fc.constant('{{ #tags.foreach t, n=0 }}{{ n }}{{ tag }}{{ #if={{ product.totalInventory }} > 5 }}{{ break }}{{ /if }};{{/tags.foreach}}') },
      { weight: 1, arbitrary: block(fc.constantFrom('{{ #metafields.foreach m, n=0 }}', '{{ #metafields.foreach m, q=3 }}'), '{{/metafields.foreach}}', { ...next, inLoop: true }) },
      { weight: 1, arbitrary: fc.constant('{{ #metafields.foreach m, n=0 }}{{ mf.namespace }}.{{ mf.key }}={{ mf.value }};{{/metafields.foreach}}') },
      // while with its own counter (the condition reads the variable; the body has no #if over it)
      { weight: 1, arbitrary: seq({ ...ctx, depth: 9, inLoop: true }).map((a) => `{{ w = 0 }}{{ #while={{w}}<3 }}${a}{{ w = {{ ={{w}}+1 }} }}{{/while}}`) },
      // variables used within one flat sequence
      { weight: 2, arbitrary: fc.tuple(fc.constantFrom('{{ product.title }}', '{{ product.totalInventory }}', '7', 'abc'), fc.constantFrom('{{ v }}', '{{ = {{v}} * 2 }}', '{{ v }}-{{ v }}')).map(([a, b]) => `{{ v = ${a} }}${b}`) },
      // selection loops
      { weight: ctx.counter !== null || ctx.inLoop ? 0 : 3, arbitrary: fc.tuple(fc.constantFrom<[string, string]>(['{{#selection.foreach product, i=0}}', '{{/selection.foreach}}'], ['{{#selection.foreach product, i=1, skip_first=TRUE}}', '{{/selection.foreach}}'], ['{{#selection.foreach product, i=0, skip_last=TRUE}}', '{{/selection.foreach}}'], ['{{#selection.foreach objects, i=0}}', '{{/selection.foreach}}'], ['{{#products.foreach p}}', '{{/products.foreach}}'], ['{{#selection.foreach}}', '{{/selection.foreach product}}']), seq({ ...next, counter: 'i' })).map(([[o, c], inner]) => `${o}${inner}${c}`) },
      { weight: ctx.counter !== null || ctx.inLoop ? 0 : 1, arbitrary: seq({ ...next, counter: 'k' }).map((inner) => `{{#notes.foreach m, k=0}}{{ product.note }}{{ k }}${inner}{{/notes.foreach}}`) },
      { weight: 1, arbitrary: fc.constantFrom('{{ #comment }}hidden {{ product.title }}{{ /comment }}', '{{ #comment }}{{ /comment }}'.repeat(1)) },
    );
  };
  return fc
    .array(tie({ counter: null, inTextTool: false, inLoop: false, depth: 0 }), { minLength: 1, maxLength: 5 })
    .map((a) => a.join(''));
}

export const mergeArb = fc.constantFrom(
  '',
  '',
  '{{ selection.next.product.vendor }} == {{ selection.curr.product.vendor }}',
  '{{ selection.next.product.productType }} == {{ selection.curr.product.productType }}',
  '{{ = {{ selection.next.product.totalInventory }} % 4 }} == 0',
  '{{ selection.curr.type }} == {{ selection.next.type }}',
  '1 ==',
  'TRUE',
);

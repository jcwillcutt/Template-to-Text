import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { compileTemplate, parseCond, parseFull, parseInline } from '../../src/engine/parse';
import type { Node } from '../../src/engine/ast';
import { renderAll } from '../helpers/render';
import { makeProduct, makeProducts, makeNote } from '../helpers/fixtures';
import { isTemplateLimitError } from '../../src/engine/evaluate';

const kinds = (nodes: Node[]): string[] => nodes.map((n) => n.k);
const full = (t: string) => parseFull(t).root;

describe('structure', () => {
  it('text and tokens', () => {
    expect(kinds(full('a{{ product.title }}b'))).toEqual(['text', 'field', 'text']);
    expect(full('plain')).toEqual([{ k: 'text', s: 'plain' }]);
    expect(full('')).toEqual([]);
  });
  it('adjacent text is merged (literal echoes of unmatched tags join their neighbours)', () => {
    expect(full('a{{ /if }}b')).toEqual([{ k: 'text', s: 'a{{ /if }}b' }]);
  });
  it('token kinds', () => {
    expect(kinds(full('{{ }}{{ = 1 }}{{ time=yyyy }}{{ x = 1 }}{{ 1 == 1 }}{{ product.title }}{{ break }}{{ skip }}'))).toEqual(['empty', 'math', 'time', 'assign', 'bool', 'field', 'ctl', 'ctl']);
  });
  it('blocks nest', () => {
    const [node] = full('{{ #if=1==1 }}{{ #repeat=2 }}x{{/repeat}}{{ #else }}y{{ /if }}');
    expect(node.k).toBe('if');
    if (node.k === 'if') {
      expect(kinds(node.then)).toEqual(['repeat']);
      expect(node.otherwise).toEqual([{ k: 'text', s: 'y' }]);
    }
  });
  it('every block family parses', () => {
    const t = [
      '{{#if=1}}{{/if}}', '{{#chop=1}}{{/chop}}', '{{#trim=1}}{{/trim}}', '{{#repeat=1}}{{/repeat}}', '{{#replace=a}}{{/replace}}',
      '{{#while=1}}{{/while}}', '{{while=1}}{{/while}}', '{{#index=1}}{{/index}}', '{{#insert=1}}{{/insert}}', '{{#wrap=5}}{{/wrap}}', '{{#length}}{{/length}}',
      '{{#variants.foreach v}}{{/variants.foreach}}', '{{#variant.foreach}}{{/variant.foreach}}', '{{#product.foreach}}{{/product.foreach}}',
      '{{#tags.foreach t}}{{/tags.foreach}}', '{{#metafields.foreach m}}{{/metafields.foreach}}',
      '{{#selection.foreach p}}{{/selection.foreach}}', '{{#products.foreach p}}{{/products.foreach}}', '{{#notes.foreach n}}{{/notes.foreach}}',
    ];
    expect(kinds(full(t.join('')))).toEqual(['if', 'chop', 'chop', 'repeat', 'replace', 'while', 'while', 'index', 'insert', 'wrap', 'length', 'variants', 'variants', 'variants', 'tags', 'metafields', 'foreach', 'foreach', 'foreach']);
  });
  it('foreach kinds', () => {
    const kindOf = (t: string) => (full(t)[0] as any).kind;
    expect(kindOf('{{#selection.foreach product}}{{/selection.foreach}}')).toBe('rows');
    expect(kindOf('{{#selection.foreach}}{{/selection.foreach}}')).toBe('rows');
    expect(kindOf('{{#selection.foreach anything}}{{/selection.foreach}}')).toBe('rows');
    expect(kindOf('{{#selection.foreach OBJECTS}}{{/selection.foreach}}')).toBe('object');
    expect(kindOf('{{#selection.foreach notes}}{{/selection.foreach}}')).toBe('notes');
    expect(kindOf('{{#notes.foreach}}{{/notes.foreach}}')).toBe('notes');
    expect(kindOf('{{#products.foreach}}{{/products.foreach}}')).toBe('rows');
  });
  it('foreach options', () => {
    const n = full('{{#selection.foreach product, z=3, skip_first=TRUE, skip_last=FALSE}}{{/selection.foreach}}')[0] as any;
    expect(n).toMatchObject({ name: 'z', skipFirst: true, skipLast: false, deprecatedChunk: false });
    expect((full('{{#selection.foreach p, i=0<5}}{{/selection.foreach}}')[0] as any).deprecatedChunk).toBe(true);
  });
  it('firstForeach is the first in document order, including one nested in an if', () => {
    const c = parseFull('a{{ #if=1 }}{{#selection.foreach p}}one{{/selection.foreach}}{{ /if }}{{#selection.foreach q}}two{{/selection.foreach}}');
    expect(c.firstForeach?.body).toEqual([{ k: 'text', s: 'one' }]);
    expect(parseFull('none').firstForeach).toBeNull();
  });
  it('a foreach inside a while is flattened away (and so is never the first foreach)', () => {
    const c = parseFull('{{#while=1}}{{#selection.foreach p}}x{{/selection.foreach}}{{/while}}');
    expect(c.firstForeach).toBeNull();
    const w = c.root[0] as any;
    expect(w.k).toBe('while');
    expect(w.body).toEqual([{ k: 'text', s: 'x' }]);
  });
});

describe('malformed templates are echoed, never thrown', () => {
  const echo = (t: string) => renderAll(t, { products: [makeProduct(1)] }).contents[0];
  it('closing tags with no opener', () => {
    expect(echo('a{{ /if }}b{{/repeat}}c')).toBe('a{{ /if }}b{{/repeat}}c');
  });
  it('an opener with no closer', () => {
    expect(echo('{{ #repeat=2 }}x')).toBe('{{ #repeat=2 }}x');
    expect(echo('{{ #chop=1 }}{{ product.handle }}')).toBe('{{ #chop=1 }}product-1');
  });
  it('mismatched closers do not close the wrong block', () => {
    expect(echo('{{ #if=1==1 }}a{{/repeat}}b{{ /if }}')).toBe('a{{/repeat}}b');
  });
  it('crossing blocks: the closer binds to the nearest opener of its own kind; the other opener is echoed', () => {
    expect(echo('{{ #if=1==1 }}{{ #repeat=2 }}x{{ /if }}y{{/repeat}}')).toBe('{{ #repeat=2 }}xy{{/repeat}}');
  });
  it('a second else is literal', () => {
    expect(echo('{{ #if=1==2 }}a{{ #else }}b{{ #else }}c{{ /if }}')).toBe('b{{ #else }}c');
  });
  it('unbalanced braces', () => {
    expect(echo('{{ {{ a }}')).toBe('{{ ');
    // `{{{ x }}}` lexes as the token `{ x ` followed by a stray `}`; an extra closing brace after a token is literal.
    expect(echo('{{{ x }}}')).toBe('}');
    expect(echo('{{ product.handle }}}')).toBe('product-1}');
  });
});

describe('conditions are parsed structurally', () => {
  it('operators', () => {
    expect(parseCond('a == b')).toMatchObject({ c: 'cmp', op: '==' });
    expect(parseCond('a != b')).toMatchObject({ c: 'cmp', op: '!=' });
    expect(parseCond('a <= b')).toMatchObject({ c: 'cmp', op: '<=' });
    expect(parseCond('a < b')).toMatchObject({ c: 'cmp', op: '<' });
    expect(parseCond('a || b && c')).toMatchObject({ c: 'or' });
    expect(parseCond('a && b')).toMatchObject({ c: 'and' });
    expect(parseCond('!a')).toMatchObject({ c: 'not' });
    expect(parseCond('a')).toMatchObject({ c: 'truthy' });
    expect(parseCond('')).toEqual({ c: 'bad' });
    expect(parseCond('   ')).toEqual({ c: 'bad' });
  });
  it("`!=` is a comparison, not a negation", () => {
    expect(parseCond('!= 3')).toMatchObject({ c: 'cmp', op: '!=' });
  });
  it('operators inside a token are not operators of the condition', () => {
    expect(parseCond('{{ a == b }}')).toMatchObject({ c: 'truthy' });
    expect(parseCond('{{ a || b }} == 1')).toMatchObject({ c: 'cmp' });
  });
  it('parentheses group', () => {
    expect(parseCond('(a || b) && c')).toMatchObject({ c: 'and' });
    expect(parseCond('((a == b))')).toMatchObject({ c: 'cmp' });
    expect(parseCond('(a) || (b)')).toMatchObject({ c: 'or' });
  });
  it('constant operands are recognised', () => {
    const c = parseCond('1 == 1') as any;
    expect(c.l.constant).toBe('1 ');
    expect((parseCond('{{ x }} == 1') as any).l.constant).toBeNull();
  });
});

describe('inline parsing keeps block tags literal', () => {
  it('parameters never open blocks', () => {
    expect(parseInline('{{ #if=1 }}')).toEqual([{ k: 'text', s: '{{ #if=1 }}' }]);
  });
});

describe('compile cache', () => {
  it('returns the same parsed template for the same text', () => {
    expect(compileTemplate('{{ product.title }} cached', {})).toBe(compileTemplate('{{ product.title }} cached', {}));
  });
  it('is keyed by the globals the template actually references', () => {
    const a = compileTemplate('{{ $global:g }}', { g: '1' });
    expect(compileTemplate('{{ $global:g }}', { g: '1' })).toBe(a);
    expect(compileTemplate('{{ $global:g }}', { g: '2' })).not.toBe(a);
    // an unrelated global changing does not invalidate
    expect(compileTemplate('{{ $global:g }}', { g: '1', other: 'zzz' })).toBe(a);
  });
  it('whitespace tokens, comments and globals are applied before parsing', () => {
    expect(compileTemplate('a{{ /return }}{{#comment}}x{{/comment}}', {}).root).toEqual([{ k: 'text', s: 'a\u0001' }]);
  });
});

// ---------------------------------------------------------------------------------------------
// Totality: whatever text a merchant types, the engine returns a string (or a clear limit error), never a crash.
describe('totality (property tests)', () => {
  const pieces = [
    '{{', '}}', '{', '}', ' ', 'x', '=', '==', '!', '&&', '||', '<', '>', '(', ')', ',', '.', '#if=', '#else', '/if', '#repeat=2', '/repeat',
    '#chop=', '/chop', '#while=', '/while', '#variants.foreach v', '/variants.foreach', '#selection.foreach p', '/selection.foreach',
    '#tags.foreach', '/tags.foreach', '#replace=a,', 'replacement=b', '/replace', '#index=1', '/index', '#insert=1', '/insert', '#wrap=5', '/wrap',
    '#length', '/length', '#comment', '/comment', 'product.title', 'variant.sku', 'i', 'break', 'skip', 'time=yyyy', '$global:g', '/return', '/space',
    'delineator=', 'direction=R', 'skip_first=TRUE', '0', '1', '2', '5', 'abc', '\n',
  ];
  const messy = fc.array(fc.constantFrom(...pieces), { maxLength: 40 }).map((a) => a.join(''));
  const arbitrary = fc.oneof(messy, fc.string({ maxLength: 80 }), fc.string({ unit: 'binary', maxLength: 40 }));
  const products = [makeProduct(1, { variants: 2, tags: ['a', 'b'] }), makeProduct(2)];
  const notes = [makeNote('n')];

  it('parsing never throws', () => {
    fc.assert(fc.property(arbitrary, (t) => { parseFull(t); parseInline(t); parseCond(t); }), { numRuns: 3000 });
  });
  it('rendering never throws (all file-break modes)', () => {
    fc.assert(
      fc.property(arbitrary, fc.constantFrom('variant', 'product', 'selection', 'object', 'note'), (t, fb) => {
        try {
          renderAll(t, { products, notes, fileBreak: fb as any, globals: { g: 'G' } });
        } catch (e) {
          if (!isTemplateLimitError(e)) throw e;
        }
      }),
      { numRuns: 3000 },
    );
  });
  it('output is a function of the template: rendering twice gives identical files', () => {
    fc.assert(
      fc.property(messy, (t) => {
        let a, b;
        try { a = renderAll(t, { products, notes }); b = renderAll(t, { products, notes }); } catch { return; }
        expect(b).toEqual(a);
      }),
      { numRuns: 800 },
    );
  });
});

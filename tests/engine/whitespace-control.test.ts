// `{-{` removes the newline before a tag, `}-}` the newline after it (like Liquid's `{%-` / `-%}`).
import { describe, expect, it } from 'vitest';
import { applyWhitespaceControl } from '../../src/engine/lexicon';
import { render } from '../helpers/render';
import { makeProduct, makeProducts } from '../helpers/fixtures';

const one = { products: [makeProduct(1, { tags: ['a', 'b', 'c'] })] };

describe('applyWhitespaceControl (text level)', () => {
  it('{-{ removes the newline before the tag', () => {
    expect(applyWhitespaceControl('a\n{-{ x }}')).toBe('a{{ x }}');
    expect(applyWhitespaceControl('a\r\n{-{ x }}')).toBe('a{{ x }}');
  });
  it('}-} removes the newline after the tag', () => {
    expect(applyWhitespaceControl('{{ x }-}\nb')).toBe('{{ x }}b');
    expect(applyWhitespaceControl('{{ x }-}\r\nb')).toBe('{{ x }}b');
  });
  it('removes only ONE newline on each side', () => {
    expect(applyWhitespaceControl('a\n\n{-{ x }}')).toBe('a\n{{ x }}');
    expect(applyWhitespaceControl('{{ x }-}\n\nb')).toBe('{{ x }}\nb');
  });
  it('also removes the indentation between the newline and the tag, and trailing spaces before the newline', () => {
    expect(applyWhitespaceControl('a\n    {-{ x }}')).toBe('a{{ x }}');
    expect(applyWhitespaceControl('{{ x }-}  \t\nb')).toBe('{{ x }}b');
  });
  it('without an adjacent newline they are plain braces', () => {
    expect(applyWhitespaceControl('a {-{ x }} b')).toBe('a {{ x }} b');
    expect(applyWhitespaceControl('{{ x }-} b')).toBe('{{ x }} b');
    expect(applyWhitespaceControl('a\n b {-{ x }}')).toBe('a\n b {{ x }}');
  });
  it('both on one tag, and chained tags sharing a newline', () => {
    expect(applyWhitespaceControl('a\n{-{ x }-}\nb')).toBe('a{{ x }}b');
    expect(applyWhitespaceControl('{{ x }-}\n{-{ y }}')).toBe('{{ x }}{{ y }}');
  });
  it('is a no-op when neither marker is present', () => {
    const t = 'a\n{{ x }}\nb';
    expect(applyWhitespaceControl(t)).toBe(t);
  });
});

describe('in templates', () => {
  it('trims around a variable', () => {
    expect(render('A\n{-{ product.title }}\nB', one)).toBe('AProduct 1\nB');
    expect(render('A\n{{ product.title }-}\nB', one)).toBe('A\nProduct 1B');
    expect(render('A\n{-{ product.title }-}\nB', one)).toBe('AProduct 1B');
  });
  it('trims around block tags, so a multi-line block leaves no stray blank lines', () => {
    const body = ['{{ #tags.foreach t, i=0 }-}', '{{ tag }}{{ #if={{ i }} < 2 }},{{ /if }}', '{-{ /tags.foreach }}', 'end'].join('\n');
    expect(render(body, one)).toBe('a,b,c\nend');
  });
  it('without trimming the same template keeps its newlines (control case)', () => {
    const body = ['{{ #tags.foreach t, i=0 }}', '{{ tag }}', '{{ /tags.foreach }}'].join('\n');
    expect(render(body, one)).toBe('\na\n\nb\n\nc\n');
    const trimmed = ['{{ #tags.foreach t, i=0 }-}', '{{ tag }}', '{-{ /tags.foreach }}'].join('\n');
    expect(render(trimmed, one)).toBe('abc');
  });
  it('if/else blocks', () => {
    const body = 'x\n{{ #if=1==1 }-}\nyes\n{-{ #else }-}\nno\n{-{ /if }}\nz';
    expect(render(body, one)).toBe('x\nyes\nz');
  });
  it('works for a CSV row loop', () => {
    const body = 'h\n{{#selection.foreach p, i=0}-}\n{{ product.handle }}\n{-{/selection.foreach}}';
    // the newline after `h` is outside any trimmed tag, so it stays; each row has no newline of its own
    expect(render(body, { products: makeProducts(3) })).toBe('h\nproduct-1product-2product-3');
  });
  it('applies inside global variables and around {{ $global: }} references', () => {
    expect(render('a\n{-{ $global:g }}', { globals: { g: 'X' } })).toBe('aX');
    expect(render('{{ $global:g }-}\nb', { globals: { g: 'X' } })).toBe('Xb');
    expect(render('{{ $global:g }}', { globals: { g: 'p\n{-{ product.handle }-}\nq' } })).toBe('pproduct-1q');
  });
  it('a comment can be trimmed too', () => {
    expect(render('a\n{-{ #comment }}note{{ /comment }-}\nb', one)).toBe('ab');
  });
  it('whitespace tokens still produce real newlines next to trimming', () => {
    expect(render('a\n{-{ /return }}b', one)).toBe('a\nb');
  });
});

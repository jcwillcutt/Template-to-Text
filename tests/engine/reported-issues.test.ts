// Regression tests for the engine-side bug the owner reported ("if statements cannot use values derived from
// variables or equations"), including the real template and error output saved in Errors/.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { render, renderAll } from '../helpers/render';
import { runLegacy } from '../helpers/differential';
import { makeProduct, makeProducts } from '../helpers/fixtures';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const errorTemplate = fs.readFileSync(path.join(ROOT, 'Errors', 'if_math_error'), 'utf8');
const errorOutput = fs.readFileSync(path.join(ROOT, 'Errors', '08-21-2026-09-43-21_looped_quad-wrap-csv.csv'), 'utf8');

describe('Errors/if_math_error (the owner’s 4-products-per-row CSV template)', () => {
  const products = makeProducts(6, {
    metafields: [['productspecs', 'serial', 'SER'], ['custom', 'location', 'LOC']],
  });
  it('the saved template uses the retired `{{ \\n }}` token, which is flagged rather than silently dropped', () => {
    expect(errorTemplate).toContain('{{ \\n }}');
    const out = render(errorTemplate, { products });
    expect(out).toContain('the backslash-n whitespace token is retired');
  });
  it('with `{{ /return }}` it produces the 4-per-row grid and no raw tags', () => {
    const fixed = errorTemplate.replace('{{ \\n }}', '{{ /return }}');
    const out = render(fixed, { products });
    const lines = out.split('\n');
    expect(lines[0]).toBe('url1,serial1,loc1,url2,serial2,loc2,url3,serial3,loc3,url4,serial4,loc4');
    expect(lines[1]).toBe(
      'https://website.com/products/product-1,SER,LOC,https://website.com/products/product-2,SER,LOC,https://website.com/products/product-3,SER,LOC,https://website.com/products/product-4,SER,LOC',
    );
    expect(lines[2]).toBe('https://website.com/products/product-5,SER,LOC,https://website.com/products/product-6,SER,LOC');
    expect(out).not.toMatch(/\{\{|\}\}/);
  });
  it('the comment inside the template does not leak', () => {
    expect(render(errorTemplate.replace('{{ \\n }}', '{{ /return }}'), { products })).not.toContain('MOD ARITHMETIC');
  });
  it('the saved bad output (whole #if blocks echoed raw) is exactly what we must never produce again', () => {
    expect(errorOutput).toContain('{{ #if={{ = {{ i }}%4 }} == 0 }}');
    const out = render(errorTemplate.replace('{{ \\n }}', '{{ /return }}'), { products });
    expect(out).not.toContain('#if');
    expect(out).not.toContain('#else');
  });
});

describe('conditions built from variables and equations (the reported bug)', () => {
  const p = [makeProduct(3)];
  it.each([
    ['plain variable', '{{ x = 5 }}{{ #if={{ x }} > 3 }}Y{{ #else }}N{{ /if }}', 'Y'],
    ['equation over a variable', '{{ x = 5 }}{{ #if={{ = {{x}} * 2 }} == 10 }}Y{{ #else }}N{{ /if }}', 'Y'],
    ['variable holding an equation result', '{{ x = {{ = 6 / 2 }} }}{{ #if={{ x }} == 3 }}Y{{ #else }}N{{ /if }}', 'Y'],
    ['variable holding a field', '{{ v = {{ product.vendor }} }}{{ #if={{ v }} == Acme Co }}Y{{ #else }}N{{ /if }}', 'Y'],
    ['variable holding a boolean token', '{{ f = {{ 1 == 1 }} }}{{ #if={{ f }} }}Y{{ #else }}N{{ /if }}', 'Y'],
    ['variable compared with a variable', '{{ a = 4 }}{{ b = 4 }}{{ #if={{ a }} == {{ b }} }}Y{{ #else }}N{{ /if }}', 'Y'],
    ['&& across variables', '{{ a = 1 }}{{ b = 2 }}{{ #if={{ a }} == 1 && {{ b }} == 2 }}Y{{ #else }}N{{ /if }}', 'Y'],
    ['variable changed between two ifs', '{{ x = 1 }}{{ #if={{x}}==1 }}a{{ /if }}{{ x = 2 }}{{ #if={{x}}==2 }}b{{ /if }}{{ #if={{x}}==1 }}c{{ /if }}', 'ab'],
    ['while counter in a condition', '{{ n = 0 }}{{ #while={{n}}<3 }}{{ #if={{n}}==1 }}[mid]{{ #else }}{{n}}{{ /if }}{{ n = {{ = {{n}}+1 }} }}{{/while}}', '0[mid]2'],
    ['chop counter condition containing an if', '{{ #chop={{ {{j}}==2 }}, j=0 }}abcdef{{/chop}}', 'ab'],
  ])('%s', (_name, tpl, want) => {
    expect(render(tpl, { products: p })).toBe(want);
  });

  it('the old engine got these wrong (this is why the rewrite exists)', () => {
    const legacy = (t: string) => runLegacy(t, { products: p, fileBreak: 'selection' }).contents[0];
    expect(legacy('{{ x = 5 }}{{ #if={{ x }} > 3 }}Y{{ #else }}N{{ /if }}')).toBe('N');
    expect(legacy('{{ x = 5 }}{{ #if={{ = {{x}} * 2 }} == 10 }}Y{{ #else }}N{{ /if }}')).toBe('N');
  });
});

// Known limitation (accepted by the owner): block tools are not evaluated INSIDE a condition, equation or
// boolean token -- they stay literal text there. The supported pattern is to assign the block to a variable
// first and test the variable. Pinned here so a future change is deliberate.
describe('block tools inside conditions: assign to a variable first', () => {
  const p = [makeProduct(1)]; // handle "product-1" (9 characters)
  it('works through a variable', () => {
    expect(render('{{ n = {{ #length }}{{ product.handle }}{{/length}} }}[{{ n }}]{{ #if={{ n }} < 100 }}T{{ #else }}F{{ /if }}', { products: p })).toBe('[9]T');
    expect(render('{{ n = {{ #length }}{{ product.handle }}{{/length}} }}{{ #if={{ n }} > 100 }}T{{ #else }}F{{ /if }}', { products: p })).toBe('F');
    expect(render('{{ n = {{ #length }}{{ product.handle }}{{/length}} }}{{ = {{ n }} * 2 }}', { products: p })).toBe('18');
    expect(render('{{ s = {{ #replace=product, replacement=item }}{{ product.handle }}{{/replace}} }}{{ #if={{ s }} == item-1 }}T{{ #else }}F{{ /if }}', { products: p })).toBe('T');
  });
  it('a block written directly inside a condition is NOT run (it stays text, so the comparison is FALSE)', () => {
    expect(render('{{ #if={{ #length }}{{ product.handle }}{{/length}}<100 }}T{{ #else }}F{{ /if }}', { products: p })).toBe('F');
    expect(render('{{ {{ #length }}{{ product.handle }}{{/length}}<100 }}', { products: p })).toBe('FALSE');
  });
  it('the old engine behaves the same way for the direct form', () => {
    const legacy = (t: string) => runLegacy(t, { products: p, fileBreak: 'selection' }).contents[0];
    expect(legacy('{{ #if={{ #length }}{{ product.handle }}{{/length}}<100 }}T{{ #else }}F{{ /if }}')).toBe('F');
  });
});

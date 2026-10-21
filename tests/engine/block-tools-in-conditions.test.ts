import { describe, it, expect } from 'vitest';
import { render } from '../helpers/render';
import { makeProduct } from '../helpers/fixtures';

const r = (body: string) => render(body, { products: [makeProduct(1, { title: 'Blue Mug', handle: 'blue-mug' })] });

describe('block tools inside conditions', () => {
  it('#length in an #if comparison', () => {
    expect(r('{{ #if={{ #length }}{{ product.handle }}{{/length}} < 100 }}short{{ #else }}long{{/if}}')).toBe('short');
    expect(r('{{ #if={{ #length }}{{ product.handle }}{{/length}} > 100 }}long{{ #else }}short{{/if}}')).toBe('short');
    expect(r('{{ #if={{ #length }}{{ product.handle }}{{/length}} == 8 }}eight{{ #else }}no{{/if}}')).toBe('eight');
  });
  it('#replace result compared to a string', () => {
    expect(r('{{ #if={{ #replace=Blue, replacement=Red }}{{ product.title }}{{/replace}} == Red Mug }}y{{ #else }}n{{/if}}')).toBe('y');
  });
  it('combines with && / || and parentheses', () => {
    expect(r('{{ #if=({{ #length }}{{ product.title }}{{/length}} > 3) && {{ product.handle }} == blue-mug }}y{{ #else }}n{{/if}}')).toBe('y');
    expect(r('{{ #if={{ #length }}{{ product.title }}{{/length}} > 30 || {{ #length }}{{ product.handle }}{{/length}} < 3 }}y{{ #else }}n{{/if}}')).toBe('n');
  });
  it('block body containing operator characters does not confuse the condition', () => {
    expect(r('{{ #if={{ #replace=<, replacement=x }}a<b{{/replace}} == axb }}y{{ #else }}n{{/if}}')).toBe('y');
    expect(r('{{ #if={{ #replace=&&, replacement=x }}a&&b{{/replace}} == axb }}y{{ #else }}n{{/if}}')).toBe('y');
  });
  it('works as a boolean token and in while', () => {
    expect(r('{{ {{ #length }}{{ product.handle }}{{/length}} < 100 }}')).toBe('TRUE');
    expect(r('{{ n = 0 }}{{ #while={{ #length }}{{ n }}{{/length}} < 2 }}{{ n = {{ = {{ n }} + 1 }} }}{{/while}}{{ n }}')).toBe('10');
  });
  it('still works via a variable (old workaround)', () => {
    expect(r('{{ l = {{ #length }}{{ product.handle }}{{/length}} }}{{ #if={{ l }} < 100 }}y{{ #else }}n{{/if}}')).toBe('y');
  });
});

describe('block tools inside equations', () => {
  it('#length inside {{ = }}', () => {
    expect(r('{{ = {{ #length }}{{ product.handle }}{{/length}} * 2 }}')).toBe('16');
  });
});

import { describe, expect, it } from 'vitest';
import { render } from '../helpers/render';
import { makeProduct, makeProducts } from '../helpers/fixtures';

const one = { products: [makeProduct(3, { variants: 1 })] };

describe('variables', () => {
  it('assign then read', () => {
    expect(render('{{ x = 5 }}{{ x }}', one)).toBe('5');
  });
  it('assignment renders nothing; reads before assignment are empty', () => {
    expect(render('[{{ x }}]{{ x = 5 }}[{{ x }}]', one)).toBe('[][5]');
  });
  it('the seven shortcut names exist and start empty', () => {
    expect(render('{{ i }}{{ j }}{{ k }}{{ l }}{{ x }}{{ y }}{{ z }}|', one)).toBe('|');
  });
  it('any non-structural name works, including dollar-prefixed', () => {
    expect(render('{{ total = 1 }}{{ $t = 2 }}{{ my-var = 3 }}{{ total }}{{ $t }}{{ my-var }}', one)).toBe('123');
  });
  it('values are trimmed', () => {
    expect(render('{{ x =   hello   }}[{{ x }}]', one)).toBe('[hello]');
  });
  it('reserved words cannot be assigned (they stay inert)', () => {
    expect(render('{{ repeat = 5 }}[{{ repeat }}]', one)).toBe('[]');
  });
  it('the value can be a whole block (chained text tools)', () => {
    expect(
      render('{{ t = {{ #replace=a, replacement=A }}banana{{/replace}} }}{{ t = {{ #replace=n, replacement=N }}{{ t }}{{/replace}} }}{{ t }}', one),
    ).toBe('bANANA');
  });
  it('the value can contain an if-block', () => {
    expect(render('{{ s = {{ #if=1==1 }}yes{{ #else }}no{{ /if }} }}{{ s }}', one)).toBe('yes');
  });
  it('variables are fresh for every output file', () => {
    const r = render('{{ n }}{{ n = 1 }}', { products: makeProducts(2), fileBreak: 'selection' });
    expect(r).toBe('');
  });
});

describe('equations', () => {
  const eq = (e: string) => render(`{{ = ${e} }}`, one);
  it('arithmetic and precedence', () => {
    expect(eq('2+3*4')).toBe('14');
    expect(eq('(2+3)*4')).toBe('20');
    expect(eq('10-4-3')).toBe('3');
    expect(eq('2^3^2')).toBe('512');
    expect(eq('-2^2')).toBe('4'); // unary minus binds tighter than ^ in this grammar
    expect(eq('7%4')).toBe('3');
    expect(eq('7/2')).toBe('3.5');
    expect(eq('0.1+0.2')).toBe(String(0.1 + 0.2));
  });
  it('variables must be wrapped in braces', () => {
    expect(render('{{ x = 3 }}{{ = {{x}} + 1 }}', one)).toBe('4');
    expect(render('{{ x = 3 }}{{ = x + 1 }}', one)).toContain('unresolved variable "x"');
  });
  it('field tokens work inside equations; non-numeric reads as 0', () => {
    expect(render('{{ = {{ product.totalInventory }} * 2 }}', one)).toBe('12');
    expect(render('{{ = {{ product.title }} + 5 }}', one)).toBe('5');
    expect(render('{{ = {{ nothing }} + 5 }}', one)).toBe('5');
  });
  it('division by zero and malformed equations render empty', () => {
    expect(eq('1/0')).toBe('');
    expect(eq('1+')).toBe('');
    expect(eq('(1+2')).toBe('');
    expect(eq('')).toBe('');
  });
  it('nested equations', () => {
    expect(render('{{ = {{ = 2*3 }} + 1 }}', one)).toBe('7');
  });
});

describe('boolean tokens', () => {
  const b = (e: string) => render(`{{ ${e} }}`, one);
  it('literals and comparisons', () => {
    expect(b('3 > 2')).toBe('TRUE');
    expect(b('3 < 2')).toBe('FALSE');
    expect(b('3 >= 3')).toBe('TRUE');
    expect(b('3 <= 2')).toBe('FALSE');
    expect(b('3 == 3')).toBe('TRUE');
    expect(b('3 != 3')).toBe('FALSE');
    expect(b('TRUE != FALSE')).toBe('TRUE');
  });
  it('string comparison is case-sensitive', () => {
    expect(b('abc == abc')).toBe('TRUE');
    expect(b('abc == ABC')).toBe('FALSE');
  });
  it('numbers compare numerically even with different spelling', () => {
    expect(b('2.0 == 2')).toBe('TRUE');
    expect(b('10 > 9')).toBe('TRUE');
  });
  it('relational operators on non-numbers are FALSE', () => {
    expect(b('abc < abd')).toBe('FALSE');
  });
  it('&& || ! and parentheses', () => {
    expect(b('1==1 && 2==2')).toBe('TRUE');
    expect(b('1==2 || 2==2')).toBe('TRUE');
    expect(b('!(1==2)')).toBe('TRUE');
    expect(b('(1==1 || 1==2) && 3==4')).toBe('FALSE');
  });
  it('compares tokens', () => {
    expect(b('{{ product.vendor }} == Acme Co')).toBe('TRUE');
    expect(b('{{ product.totalInventory }} > 5')).toBe('TRUE');
  });
  it('a malformed boolean token renders empty', () => {
    expect(b('1 == 1 &&')).toBe('');
  });
});

describe('#if / #else', () => {
  it('basic branches', () => {
    expect(render('{{ #if=1==1 }}A{{ #else }}B{{ /if }}', one)).toBe('A');
    expect(render('{{ #if=1==2 }}A{{ #else }}B{{ /if }}', one)).toBe('B');
    expect(render('{{ #if=1==2 }}A{{ /if }}', one)).toBe('');
  });
  it('spacing variants of the tags', () => {
    expect(render('{{#if=1==1}}A{{#else}}B{{/if}}', one)).toBe('A');
    expect(render('{{  #if=1==1  }}A{{  #else  }}B{{  /if  }}', one)).toBe('A');
  });
  it('nesting, including else belonging to the innermost if', () => {
    expect(render('{{ #if=1==1 }}{{ #if=2==3 }}no{{ #else }}inner-else{{ /if }}{{ #else }}outer-else{{ /if }}', one)).toBe('inner-else');
    expect(render('{{ #if=1==2 }}x{{ #else }}{{ #if=1==1 }}deep{{ /if }}{{ /if }}', one)).toBe('deep');
  });
  it('truthiness of a bare operand', () => {
    expect(render('{{ #if=1 }}T{{ #else }}F{{ /if }}', one)).toBe('T');
    expect(render('{{ #if=0 }}T{{ #else }}F{{ /if }}', one)).toBe('F');
    expect(render('{{ #if=FALSE }}T{{ #else }}F{{ /if }}', one)).toBe('F');
    expect(render('{{ #if=false }}T{{ #else }}F{{ /if }}', one)).toBe('F');
    expect(render('{{ #if=hello }}T{{ #else }}F{{ /if }}', one)).toBe('T');
    expect(render('{{ #if={{ product.note }} }}T{{ #else }}F{{ /if }}', one)).toBe('F');
  });
  it('an empty or malformed condition is FALSE', () => {
    expect(render('{{ #if= }}T{{ #else }}F{{ /if }}', one)).toBe('F');
    expect(render('{{ #if=1==1 && }}T{{ #else }}F{{ /if }}', one)).toBe('F');
  });
  it('NOT of an empty value is TRUE', () => {
    expect(render('{{ #if=!{{ product.note }} }}empty{{ #else }}has note{{ /if }}', one)).toBe('empty');
    expect(render('{{ #if=!{{ product.title }} }}empty{{ #else }}has title{{ /if }}', one)).toBe('has title');
  });
  it('conditions use fields, equations and variables', () => {
    expect(render('{{ #if={{ product.totalInventory }} > 5 }}big{{ #else }}small{{ /if }}', one)).toBe('big');
    expect(render('{{ #if={{ = 2*3 }} == 6 }}six{{ /if }}', one)).toBe('six');
    expect(render('{{ #if=({{ = 1+1 }})*3 == 6 }}paren{{ /if }}', one)).toBe('paren');
  });
  it('a bare variable inside an equation inside a condition shows a marker', () => {
    expect(render('{{ x = 4 }}{{ #if={{ = x%2 }} == 0 }}even{{ #else }}odd{{ /if }}', one)).toContain('unresolved variable "x"');
  });
  it('stray else/close tags are literal text', () => {
    expect(render('a{{ #else }}b{{ /if }}c', one)).toBe('a{{ #else }}b{{ /if }}c');
  });
  it('an unclosed if is literal but its contents still render', () => {
    expect(render('{{ #if=1==1 }}A {{ product.handle }}', one)).toBe('{{ #if=1==1 }}A product-3');
  });
});

// The reported bug: conditions must see the CURRENT value of variables and equations over them.
describe('#if sees variables and equations (document order)', () => {
  it('variable in a condition', () => {
    expect(render('{{ x = 5 }}{{ #if={{ x }} > 3 }}big{{ #else }}small{{ /if }}', one)).toBe('big');
  });
  it('equation over a variable', () => {
    expect(render('{{ x = 5 }}{{ #if={{ = {{x}}*2 }} == 10 }}yes{{ #else }}no{{ /if }}', one)).toBe('yes');
  });
  it('variable derived from a product field', () => {
    expect(render('{{ n = {{ product.totalInventory }} }}{{ #if={{ n }} >= 6 }}ge{{ #else }}lt{{ /if }}', one)).toBe('ge');
  });
  it('variable derived from an equation', () => {
    expect(render('{{ n = {{ = 2+3 }} }}{{ #if={{ n }}==5 }}five{{ #else }}other{{ /if }}', one)).toBe('five');
  });
  it('a variable set inside an earlier branch', () => {
    expect(render('{{ #if=1==1 }}{{ n = 3 }}{{ /if }}{{ #if={{n}}==3 }}three{{ #else }}none{{ /if }}', one)).toBe('three');
  });
  it('a variable set inside the SAME branch it later gates', () => {
    expect(render('{{ #if=1==1 }}{{ n = 3 }}{{ #if={{n}}==3 }}three{{ /if }}{{ /if }}', one)).toBe('three');
  });
  it('a condition on a loop counter (selection loop, variants loop, tags loop, while loop)', () => {
    const p = makeProduct(1, { variants: 3, tags: ['a', 'b', 'c'] });
    expect(render('{{#selection.foreach product, i=0}}{{ #if={{ i }}==1 }}[one]{{ #else }}{{ i }}{{ /if }}{{/selection.foreach}}', { products: makeProducts(3) })).toBe('0[one]2');
    expect(render('{{ #variants.foreach v, l=0 }}{{ #if={{ l }}==1 }}[{{variant.title}}]{{ #else }}{{ l }}{{ /if }}{{/variants.foreach}}', { products: [p], fileBreak: 'product' })).toBe('0[V1]2');
    expect(render('{{ #tags.foreach t, i=0 }}{{ #if={{ = {{i}}%2 }}==0 }}E{{ #else }}O{{ /if }}{{/tags.foreach}}', { products: [p], fileBreak: 'product' })).toBe('EOE');
    expect(render('{{ x = 0 }}{{ #while={{x}}<4 }}{{ #if={{x}}==2 }}[two]{{ #else }}{{x}}{{ /if }}{{ x = {{ ={{x}}+1 }} }}{{/while}}', one)).toBe('01[two]3');
  });
  it('a running total across a selection loop gates correctly', () => {
    const ps = makeProducts(4); // totalInventory 2,4,6,8
    expect(
      render('{{ t = 0 }}{{#selection.foreach product, i=0}}{{ t = {{ = {{t}} + {{ product.totalInventory }} }} }}{{ #if={{t}} > 5 }}[{{t}}!]{{ #else }}[{{t}}]{{ /if }}{{/selection.foreach}}', { products: ps }),
    ).toBe('[2][6!][12!][20!]');
  });
  it('variables assigned before a selection loop are visible inside it, and after it', () => {
    expect(render('{{ base = 100 }}{{#selection.foreach product, i=0}}{{ = {{base}} + {{i}} }},{{/selection.foreach}}', { products: makeProducts(3) })).toBe('100,101,102,');
    expect(render('{{#selection.foreach product, i=0}}{{ last = {{ product.handle }} }}{{/selection.foreach}}{{ last }}', { products: makeProducts(3) })).toBe('product-3');
  });
  it('the CSV-grid template from the bug report (4 per row)', () => {
    const body =
      'h{{#selection.foreach product, i=0}}{{ #if={{ = {{ i }}%4 }} == 0 }}{{ /return }}{{ #else }},{{ /if }}{{ product.handle }}{{/selection.foreach product}}';
    expect(render(body, { products: makeProducts(6) })).toBe('h\nproduct-1,product-2,product-3,product-4\nproduct-5,product-6');
  });
});

describe('product data is data, not template code', () => {
  it('braces and operators inside values never change a condition', () => {
    const tricky = makeProduct(1, { vendor: 'A && B || (C', title: '{{ x = 99 }}' });
    expect(render('{{ #if={{ product.vendor }} == A && B || (C }}match{{ #else }}no{{ /if }}', { products: [tricky] })).toBe('match');
    expect(render('{{ product.title }}{{ x }}', { products: [tricky] })).toBe('{{ x = 99 }}');
  });
});

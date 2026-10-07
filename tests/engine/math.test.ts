import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { evaluateMathExpression } from '../../src/engine/math';
import { UNRESOLVED_VARIABLE_ERROR_PREFIX } from '../../src/engine/markers';
import { loadLegacyEngine } from '../helpers/legacy-oracle';

const ev = evaluateMathExpression;

describe('evaluateMathExpression', () => {
  it('numbers', () => {
    expect(ev('42')).toBe(42);
    expect(ev('  3.5  ')).toBe(3.5);
    expect(ev('.5')).toBe(0.5);
  });
  it('+ - * / % ^ with the usual precedence', () => {
    expect(ev('1+2*3')).toBe(7);
    expect(ev('(1+2)*3')).toBe(9);
    expect(ev('8/2/2')).toBe(2);
    expect(ev('10%4')).toBe(2);
    expect(ev('2*3%4')).toBe(2);
    expect(ev('2^10')).toBe(1024);
  });
  it('^ is exponentiation and right-associative (not XOR)', () => {
    expect(ev('2^3^2')).toBe(512);
    expect(ev('(2^3)^2')).toBe(64);
  });
  it('unary + and -', () => {
    expect(ev('-3')).toBe(-3);
    expect(ev('--3')).toBe(3);
    expect(ev('+4')).toBe(4);
    expect(ev('2*-3')).toBe(-6);
    expect(ev('-(1+2)')).toBe(-3);
  });
  it('division by zero is Infinity/NaN (callers reject non-finite results)', () => {
    expect(ev('1/0')).toBe(Infinity);
    expect(Number.isNaN(ev('0/0'))).toBe(true);
  });
  it('throws on malformed input', () => {
    for (const bad of ['', '1+', '(1+2', '1+2)', '1 2', '*3', '1 $ 2', '()']) {
      expect(() => ev(bad), bad).toThrow();
    }
  });
  it('a bare identifier throws a recognisable UNRESOLVED_VARIABLE error', () => {
    expect(() => ev('x+1')).toThrow(new RegExp('^' + UNRESOLVED_VARIABLE_ERROR_PREFIX + 'x$'));
    expect(() => ev('2*abc_1')).toThrow(UNRESOLVED_VARIABLE_ERROR_PREFIX + 'abc_1');
  });
  it('a version-like string reads as its numeric prefix (legacy quirk, relied on by comparisons)', () => {
    expect(ev('1.2.3')).toBe(1.2);
  });
});

describe('matches the legacy evaluator', () => {
  const legacy = loadLegacyEngine().evaluateMathExpression;
  const same = (s: string): void => {
    let a: unknown, b: unknown;
    try { a = legacy(s); } catch (e: any) { a = 'ERR:' + e.message; }
    try { b = ev(s); } catch (e: any) { b = 'ERR:' + e.message; }
    expect(b, s).toEqual(a);
  };
  it('on arbitrary expression-like strings', () => {
    fc.assert(fc.property(fc.stringMatching(/^[0-9a-z+\-*/%^(). ]{0,24}$/), same), { numRuns: 1500 });
  });
  it('on well-formed expressions', () => {
    const expr: fc.Arbitrary<string> = fc.letrec((tie) => ({
      expr: fc.oneof(
        { depthSize: 'small', maxDepth: 4 },
        fc.integer({ min: 0, max: 99 }).map(String),
        fc.tuple(tie('expr'), fc.constantFrom('+', '-', '*', '/', '%', '^'), tie('expr')).map(([a, o, b]) => `${a}${o}${b}`),
        tie('expr').map((e) => `(${e})`),
        tie('expr').map((e) => `-${e}`),
      ),
    })).expr;
    fc.assert(fc.property(expr, same), { numRuns: 1500 });
  });
});

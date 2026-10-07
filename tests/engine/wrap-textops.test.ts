import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { applyWordWrap, breakLineIntoRows, breakLineIntoHardChunks, parseWrapParams } from '../../src/engine/wrap';
import { applyIndex, applyInsert, applyRepeat, applyReplace } from '../../src/engine/textops';

describe('word wrap', () => {
  it('breaks on spaces; an over-long word overflows its line', () => {
    expect(applyWordWrap('The Best New Product', 10, 0, 0, '\n', false)).toBe('The Best\nNew\nProduct');
    expect(applyWordWrap('supercalifragilistic word', 5, 0, 0, '|', false)).toBe('supercalifragilistic|word');
  });
  it('min_wraps pads with empty rows; max_wraps caps rows', () => {
    expect(applyWordWrap('a b', 10, 3, 0, '|', false)).toBe('a b||');
    expect(applyWordWrap('aa bb cc dd', 2, 0, 2, '|', false)).toBe('aa|bb cc dd');
  });
  it('hard wrap splits on the exact width', () => {
    expect(applyWordWrap('abcdefgh', 3, 0, 0, '-', true)).toBe('abc-def-gh');
    expect(applyWordWrap('abcdefgh', 3, 0, 2, '-', true)).toBe('abc-defgh');
  });
  it('existing line breaks are respected', () => {
    expect(applyWordWrap('ab cd\nef', 3, 0, 0, '|', false)).toBe('ab|cd|ef');
  });
  it('an invalid width returns the text unchanged', () => {
    expect(applyWordWrap('x y', 0, 0, 0, '|', false)).toBe('x y');
    expect(applyWordWrap('x y', 1.5, 0, 0, '|', false)).toBe('x y');
  });
  it('hard wrapping never loses or adds characters', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 60 }), fc.integer({ min: 1, max: 9 }), (s, w) => {
        expect(breakLineIntoHardChunks(s, w, 0).join('')).toBe(s);
      }),
    );
  });
  it('soft wrapping keeps every word, in order, and respects the width unless a word is longer', () => {
    fc.assert(
      fc.property(fc.array(fc.stringMatching(/^[a-z]{1,8}$/), { minLength: 1, maxLength: 12 }), fc.integer({ min: 4, max: 20 }), (words, w) => {
        const rows = breakLineIntoRows(words.join(' '), w, 0);
        expect(rows.join(' ').split(' ')).toEqual(words);
        for (const r of rows) if (r.includes(' ')) expect(r.length).toBeLessThanOrEqual(w);
      }),
    );
  });
  it('parseWrapParams reads width, min/max, hard and a delineator that may contain commas', () => {
    expect(parseWrapParams('20, min_wraps=2, max_wraps=3, hard=TRUE, delineator=, ')).toEqual({ maxChars: 20, minWraps: 2, maxWraps: 3, delineator: ',', hard: true });
    expect(parseWrapParams('abc').maxChars).toBeNaN();
  });
});

describe('text tools (pure functions)', () => {
  it('applyIndex', () => {
    expect(applyIndex('abc', 0)).toBe('a');
    expect(applyIndex('abc', -1)).toBe('c');
    expect(applyIndex('abc', 3)).toBe('');
    expect(applyIndex('abc', -4)).toBe('');
    expect(applyIndex('abc', 1.5)).toBe('');
    expect(applyIndex('abc', null)).toBe('');
  });
  it('applyRepeat', () => {
    expect(applyRepeat('x', 3, ',')).toBe('x,x,x');
    expect(applyRepeat('x', 1, ',')).toBe('x');
    expect(applyRepeat('x', 0, ',')).toBe('');
    expect(applyRepeat('x', -2, ',')).toBe('');
    expect(applyRepeat('x', null, ',')).toBe('');
  });
  it('applyReplace', () => {
    expect(applyReplace('a-b-c', '-', '+')).toBe('a+b+c');
    expect(applyReplace('abc', '', 'X')).toBe('abc');
    expect(applyReplace('aaa', 'aa', 'b')).toBe('ba');
  });
  it('applyInsert', () => {
    expect(applyInsert('ab', 'cd', 'X', 1, false)).toBe('abcXd');
    expect(applyInsert('abcd', 'ef', 'X', -1, false)).toBe('abcXdef');
    expect(applyInsert('ab', 'cd', 'X', 9, false)).toBe('abcdX');
    expect(applyInsert('ab', 'cd', 'X', 9, true)).toBe('abcd');
    expect(applyInsert('ab', 'cd', 'X', -9, false)).toBe('Xabcd');
    expect(applyInsert('ab', 'cd', 'X', -9, true)).toBe('abcd');
    expect(applyInsert('ab', 'cd', 'X', null, false)).toBe('abcd');
  });
  it('replace(x, y) then replace(y, x) round-trips when y does not occur in the text', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[a-c ]{0,30}$/), (s) => {
        expect(applyReplace(applyReplace(s, 'a', '#'), '#', 'a')).toBe(s);
      }),
    );
  });
});

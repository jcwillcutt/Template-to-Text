import { describe, expect, it } from 'vitest';
import { DOUBLE_CLICK_MS, DUPLICATE_CLICK_MS, insertIntoText, registerClick, type ClickRecord } from '../../src/ui/interaction';

describe('insertIntoText (editor Insert menus)', () => {
  it('replaces every {{ insert }} placeholder', () => {
    expect(insertIntoText('a {{ insert }} b {{insert}} c', 'X')).toBe('a X b X c');
    expect(insertIntoText('{{   insert   }}', 'X')).toBe('X');
  });
  it('appends when there is no placeholder', () => {
    expect(insertIntoText('abc', 'X')).toBe('abcX');
    expect(insertIntoText('', 'X')).toBe('X');
  });
  it('works every time it is called (a shared /g regex used to make every second call append instead)', () => {
    let text = '{{ insert }}';
    text = insertIntoText(text, '1');
    expect(text).toBe('1');
    const again = 'p {{ insert }} q';
    for (let i = 0; i < 5; i++) expect(insertIntoText(again, 'T')).toBe('p T q');
  });
  it('inserts the token literally (no $-pattern expansion)', () => {
    expect(insertIntoText('{{ insert }}', "$& $1 $'")).toBe("$& $1 $'");
  });
});

describe('registerClick (double click detection)', () => {
  const run = (clicks: [string, number][]): boolean[] => {
    let last: ClickRecord | null = null;
    return clicks.map(([id, t]) => {
      const r = registerClick(last, id, t);
      last = r.next;
      return r.isDouble;
    });
  };
  it('two quick clicks on the same row are a double click', () => {
    expect(run([['a', 0], ['a', 120]])).toEqual([false, true]);
  });
  it('rapid clicks (well under the window) count', () => {
    expect(run([['a', 1000], ['a', 1030]])).toEqual([false, true]);
  });
  it('slow clicks are two single clicks', () => {
    expect(run([['a', 0], ['a', DOUBLE_CLICK_MS + 1]])).toEqual([false, false]);
  });
  it('clicks on different rows never pair', () => {
    expect(run([['a', 0], ['b', 50]])).toEqual([false, false]);
  });
  it('a double click is consumed: the third click starts a new pair', () => {
    expect(run([['a', 0], ['a', 100], ['a', 150], ['a', 200]])).toEqual([false, true, false, true]);
  });
  it('the same click delivered twice within milliseconds (real click + delegated click) is ignored, not a double click', () => {
    expect(run([['a', 0], ['a', 2]])).toEqual([false, false]);
    expect(DUPLICATE_CLICK_MS).toBeLessThan(60);
  });
  it('a duplicate does not reset the pair: a real second click shortly after still opens', () => {
    expect(run([['a', 0], ['a', 3], ['a', 150]])).toEqual([false, false, true]);
  });
  it('select-then-double-click sequence: first click selects, second opens', () => {
    expect(run([['x', 0], ['y', 600], ['y', 700]])).toEqual([false, false, true]);
  });
});

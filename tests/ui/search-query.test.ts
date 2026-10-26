import { describe, expect, it } from 'vitest';
import {
  MAX_PASTED_TERMS,
  columnToOrQuery,
  hasColumnSeparators,
  matchesSearchQuery,
  parseSearchQuery,
  quoteSearchTerm,
  searchQueryForShopify,
} from '../../src/ui/search-query';
import { makeProduct } from '../helpers/fixtures';

const mug = makeProduct(1, { title: 'Red Mug', handle: 'red-mug', vendor: 'Acme Co', productType: 'Mug', tags: ['kitchen', 'sale'], metafields: [['custom', 'location', 'Shelf A4'], ['custom', 'color', 'Crimson']] });
const plate = makeProduct(2, { title: 'Blue Plate', handle: 'blue-plate', vendor: 'Beta Ltd', productType: 'Plate', tags: ['kitchen'], metafields: [['custom', 'location', 'Shelf B1']] });
mug.variants[0].sku = 'MUG-001';
plate.variants[0].sku = 'PLT-002';
const q = (query: string, p = mug): boolean => matchesSearchQuery(p, query);

describe('plain words', () => {
  it('match case-insensitively as substrings of any searchable field', () => {
    expect(q('red')).toBe(true);
    expect(q('MUG')).toBe(true);
    expect(q('acme')).toBe(true);
    expect(q('kitchen')).toBe(true);
    expect(q('mug-001')).toBe(true);
  });
  it('metafield values are searched', () => {
    expect(q('crimson')).toBe(true);
    expect(q('B1')).toBe(false);
    expect(q('B1', plate)).toBe(true);
  });
  it('an empty query matches everything', () => {
    expect(q('')).toBe(true);
    expect(q('   ')).toBe(true);
    expect(parseSearchQuery('')).toBeNull();
  });
});

describe('AND (space or AND)', () => {
  it('all words must match, in any fields, in any order', () => {
    expect(q('red mug')).toBe(true);
    expect(q('mug red')).toBe(true);
    expect(q('red plate')).toBe(false);
    expect(q('red AND kitchen')).toBe(true);
    expect(q('red AND plate')).toBe(false);
    expect(q('shelf a4')).toBe(true); // "shelf" and "a4" both appear in the location metafield
  });
});

describe('OR', () => {
  it('any alternative may match', () => {
    expect(q('red OR plate')).toBe(true);
    expect(q('green OR plate')).toBe(false);
    expect(q('green OR blue OR red')).toBe(true);
  });
  it('lowercase "or" is an ordinary word, not an operator (product names contain it)', () => {
    expect(q('red or plate')).toBe(false);
  });
  it('binds looser than AND: a b OR c = (a b) OR c', () => {
    expect(q('red plate OR crimson')).toBe(true);
    expect(q('red plate OR zzz')).toBe(false);
  });
});

describe('NOT', () => {
  it('-word and NOT word exclude', () => {
    expect(q('kitchen -plate')).toBe(true);
    expect(q('kitchen -mug')).toBe(false);
    expect(q('kitchen NOT mug')).toBe(false);
    expect(q('NOT plate')).toBe(true);
    expect(q('-red')).toBe(false);
  });
  it('negating a group', () => {
    expect(q('-(red OR blue)')).toBe(false);
    expect(q('-(green OR blue)')).toBe(true);
  });
});

describe('phrases and quotes', () => {
  it('"quoted text" matches only as a contiguous phrase', () => {
    expect(q('"red mug"')).toBe(true);
    expect(q('"mug red"')).toBe(false);
    expect(q('"shelf a4"')).toBe(true);
    expect(q("'acme co'")).toBe(true);
  });
  it('operators inside quotes are plain text', () => {
    expect(q('"red OR plate"')).toBe(false);
  });
  it('an unterminated quote runs to the end instead of throwing', () => {
    expect(q('"red mu')).toBe(true);
  });
});

describe('parentheses', () => {
  it('group', () => {
    expect(q('(red OR blue) kitchen')).toBe(true);
    expect(q('(green OR blue) kitchen')).toBe(false);
    expect(q('kitchen (mug OR plate) -sale')).toBe(false);
    expect(q('kitchen (mug OR plate) -zzz')).toBe(true);
  });
  it('unbalanced parentheses never throw and never drop words', () => {
    expect(() => parseSearchQuery('(red OR')).not.toThrow();
    expect(q('(red mug')).toBe(true);
    expect(q('red) mug')).toBe(true);
    expect(q('red) plate')).toBe(false);
    expect(q(')))')).toBe(true);
  });
});

describe('field filters', () => {
  it('title / handle / sku match as substrings', () => {
    expect(q('title:mug')).toBe(true);
    expect(q('handle:red-mug')).toBe(true);
    expect(q('sku:mug-001')).toBe(true);
    expect(q('title:plate')).toBe(false);
  });
  it('vendor / product_type / tag / status must match exactly (case-insensitive)', () => {
    expect(q('vendor:"acme co"')).toBe(true);
    expect(q('vendor:acme')).toBe(false);
    expect(q('product_type:mug')).toBe(true);
    expect(q('tag:sale')).toBe(true);
    expect(q('tag:sal')).toBe(false);
    expect(q('status:active')).toBe(true);
    expect(q('status:draft')).toBe(false);
  });
  it('metafield filter', () => {
    expect(q('metafields.custom.location:"shelf a4"')).toBe(true);
    expect(q('metafields.custom.location:b1')).toBe(false);
  });
  it('combine with operators', () => {
    expect(q('vendor:"acme co" OR vendor:"beta ltd"')).toBe(true);
    expect(q('tag:kitchen -vendor:"beta ltd"')).toBe(true);
    expect(q('tag:kitchen -vendor:"beta ltd"', plate)).toBe(false);
  });
  it('filters only Shopify can evaluate match nothing locally (so the local cache never widens the result)', () => {
    expect(q('collection_id:123')).toBe(false);
    expect(q('inventory_total:>0')).toBe(false);
    expect(q('red collection_id:123')).toBe(false);
    expect(q('red OR collection_id:123')).toBe(true);
    expect(q('-collection_id:123')).toBe(true);
  });
});

describe('never throws, always terminates', () => {
  it('on arbitrary text', () => {
    const junk = ['', '(', ')', '""', "''", '-', '--x', 'OR', 'AND', 'NOT', 'OR OR OR', 'a:', ':a', 'a::b', '"', 'NOT NOT NOT x', '(((((', '- -', 'x:"', '\u0000', 'a\nb\tc'];
    for (const j of junk) expect(() => matchesSearchQuery(mug, j)).not.toThrow();
  });
});

describe('line breaks become OR (pasted column, barcode scanner, Enter)', () => {
  it('is only applied when the text contains a line break; tabs are not separators', () => {
    expect(hasColumnSeparators('red mug')).toBe(false);
    expect(columnToOrQuery('red mug')).toBeNull();
    expect(hasColumnSeparators('a\nb')).toBe(true);
    expect(hasColumnSeparators('a\r\nb')).toBe(true);
    expect(hasColumnSeparators('a\tb')).toBe(false);
    expect(columnToOrQuery('a\tb\tc')).toBeNull();
  });

  describe('a scanner: type the code, then Enter, repeatedly', () => {
    // Simulates the search box: the box content after each keystroke/scan goes through columnToOrQuery.
    const scan = (box: string, code: string): string => {
      const typed = box + code + '\n';
      return columnToOrQuery(typed)?.query ?? typed;
    };
    it('each Enter leaves " OR " ready for the next scan, so scans never run together', () => {
      let box = '';
      box = scan(box, '0123456789');
      expect(box).toBe('0123456789 OR ');
      box = scan(box, '9876543210');
      expect(box).toBe('0123456789 OR 9876543210 OR ');
      box = scan(box, '5551234567');
      expect(box).toBe('0123456789 OR 9876543210 OR 5551234567 OR ');
    });
    it('works with Windows line endings and carriage-return-only scanners', () => {
      expect(columnToOrQuery('ABC\r\n')?.query).toBe('ABC OR ');
      expect(columnToOrQuery('ABC\r')?.query).toBe('ABC OR ');
    });
    it('the finished box searches for exactly the scanned codes', () => {
      const box = scan(scan(scan('', 'MUG-001'), 'PLT-002'), 'nothing');
      expect(matchesSearchQuery(mug, box)).toBe(true);
      expect(matchesSearchQuery(plate, box)).toBe(true);
      expect(matchesSearchQuery(makeProduct(9, { title: 'Green', handle: 'green' }), box)).toBe(false);
    });
    it('Shopify never sees the dangling OR', () => {
      expect(searchQueryForShopify('a OR b OR ')).toBe('a OR b');
      expect(searchQueryForShopify('a OR b OR  OR ')).toBe('a OR b');
      expect(searchQueryForShopify('a')).toBe('a');
      expect(searchQueryForShopify(' OR ')).toBe('');
      expect(searchQueryForShopify('')).toBe('');
      expect(searchQueryForShopify('red AND ')).toBe('red');
    });
    it('a dangling OR does not change what matches locally', () => {
      expect(matchesSearchQuery(mug, 'MUG-001 OR ')).toBe(true);
      expect(matchesSearchQuery(plate, 'MUG-001 OR ')).toBe(false);
    });
    it('Enter on an ordinary typed search keeps the words as typed and just adds the OR', () => {
      expect(columnToOrQuery('red mug\n')?.query).toBe('red mug OR ');
    });
    it('Enter on an empty box clears it', () => {
      expect(columnToOrQuery('\n')?.query).toBe('');
      expect(columnToOrQuery('  \r\n')?.count).toBe(0);
    });
  });

  describe('a pasted column', () => {
    it('becomes a OR b OR c (Windows, Mac and Unix line endings)', () => {
      expect(columnToOrQuery('a\nb\nc')?.query).toBe('a OR b OR c');
      expect(columnToOrQuery('a\r\nb\r\nc')?.query).toBe('a OR b OR c');
      expect(columnToOrQuery('a\rb\rc')?.query).toBe('a OR b OR c');
    });
    it('a trailing line break (Excel adds one) keeps a trailing OR so scanning can continue', () => {
      expect(columnToOrQuery('a\r\nb\r\nc\r\n')?.query).toBe('a OR b OR c OR ');
    });
    it('drops blank cells and duplicates (case-insensitive), keeping the first order', () => {
      expect(columnToOrQuery('a\n\nB\nb\n  \nA\nc')?.query).toBe('a OR B OR c');
    });
    it('trims cells and removes the quotes spreadsheets add around special cells', () => {
      expect(columnToOrQuery('  a  \n"b ""x"" c"\nd')?.query).toBe('a OR "b x c" OR d');
      expect(columnToOrQuery('"red mug"\nblue')?.query).toBe('"red mug" OR blue');
    });
    it('quotes values that contain spaces or syntax so they stay one term', () => {
      expect(columnToOrQuery('red mug\nblue plate')?.query).toBe('"red mug" OR "blue plate"');
      expect(columnToOrQuery('a:b\n(x)\n-y\nOR\nplain')?.query).toBe('"a:b" OR "(x)" OR "-y" OR "OR" OR plain');
    });
    it('pasting a column after scans already in the box keeps them', () => {
      expect(columnToOrQuery('A OR B OR x\ny\nz')?.query).toBe('A OR B OR x OR y OR z');
    });
    it('the converted text matches exactly what the OR of the values matches', () => {
      const out = columnToOrQuery('Red Mug\nPLT-002\nnothing-here')!.query;
      expect(matchesSearchQuery(mug, out)).toBe(true);
      expect(matchesSearchQuery(plate, out)).toBe(true);
      expect(matchesSearchQuery(makeProduct(3, { title: 'Green Cup', handle: 'green-cup' }), out)).toBe(false);
    });
    it('is capped so a huge paste cannot produce an oversized query', () => {
      const big = Array.from({ length: 200 }, (_, i) => `SKU-${i}`).join('\n');
      const r = columnToOrQuery(big)!;
      expect(r.count).toBe(MAX_PASTED_TERMS);
      expect(r.truncated).toBe(true);
      expect(r.query.split(' OR ')).toHaveLength(MAX_PASTED_TERMS);
      expect(columnToOrQuery('a\nb')!.truncated).toBe(false);
    });
  });

  it('quoteSearchTerm leaves ordinary values alone', () => {
    expect(quoteSearchTerm('ABC-123')).toBe('ABC-123');
    expect(quoteSearchTerm('12345')).toBe('12345');
    expect(quoteSearchTerm('say "hi"')).toBe('"say hi"');
  });
});

import { exactSearchValues, variantMatchesSearch } from '../../src/ui/search-query';
describe('searched variant', () => {
  const v = { sku: 'ABC-1', barcode: '0123456789' };
  it('matches a variant whose sku or barcode equals a term exactly (case-insensitive)', () => {
    expect(variantMatchesSearch(v, exactSearchValues('abc-1'))).toBe(true);
    expect(variantMatchesSearch(v, exactSearchValues('0123456789'))).toBe(true);
    expect(variantMatchesSearch(v, exactSearchValues('sku:ABC-1'))).toBe(true);
    expect(variantMatchesSearch(v, exactSearchValues('zzz OR "ABC-1"'))).toBe(true);
  });
  it('does not match partial values, negated terms or empty fields', () => {
    expect(variantMatchesSearch(v, exactSearchValues('ABC'))).toBe(false);
    expect(variantMatchesSearch(v, exactSearchValues('-ABC-1'))).toBe(false);
    expect(variantMatchesSearch({ sku: null, barcode: '' }, exactSearchValues('abc'))).toBe(false);
    expect(variantMatchesSearch(v, exactSearchValues(''))).toBe(false);
  });
});

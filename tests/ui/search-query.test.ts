import { describe, expect, it } from 'vitest';
import {
  MAX_PASTED_TERMS,
  columnToOrQuery,
  hasColumnSeparators,
  matchesSearchQuery,
  parseSearchQuery,
  quoteSearchTerm,
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

describe('pasting a spreadsheet column', () => {
  it('is only converted when the text has line breaks or tabs', () => {
    expect(hasColumnSeparators('red mug')).toBe(false);
    expect(columnToOrQuery('red mug')).toBeNull();
    expect(hasColumnSeparators('a\nb')).toBe(true);
    expect(hasColumnSeparators('a\tb')).toBe(true);
  });
  it('a column becomes a OR b OR c (Excel / Google Sheets / Windows and Mac line endings)', () => {
    expect(columnToOrQuery('a\nb\nc')?.query).toBe('a OR b OR c');
    expect(columnToOrQuery('a\r\nb\r\nc\r\n')?.query).toBe('a OR b OR c');
    expect(columnToOrQuery('a\rb\rc')?.query).toBe('a OR b OR c');
  });
  it('a row of cells (tabs) works the same way', () => {
    expect(columnToOrQuery('a\tb\tc')?.query).toBe('a OR b OR c');
  });
  it('a single copied cell (with the trailing newline Excel adds) is just that value, with no OR', () => {
    expect(columnToOrQuery('SKU-1\r\n')?.query).toBe('SKU-1');
    expect(columnToOrQuery('SKU-1\r\n')?.count).toBe(1);
  });
  it('drops blank cells and duplicates (case-insensitive), keeping the first order', () => {
    expect(columnToOrQuery('a\n\nB\nb\n  \nA\nc')?.query).toBe('a OR B OR c');
  });
  it('trims cells and removes the quotes spreadsheets add around special cells', () => {
    expect(columnToOrQuery('  a  \n"b ""x"" c"\n')?.query).toBe('a OR "b x c"');
  });
  it('quotes values that contain spaces or syntax so they stay one term', () => {
    expect(columnToOrQuery('red mug\nblue plate')?.query).toBe('"red mug" OR "blue plate"');
    expect(columnToOrQuery('a:b\n(x)\n-y\nOR\nplain')?.query).toBe('"a:b" OR "(x)" OR "-y" OR "OR" OR plain');
  });
  it('the converted text, once parsed, matches exactly what the OR of the values matches', () => {
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
  it('an empty paste converts to an empty query', () => {
    expect(columnToOrQuery('\n\n')?.query).toBe('');
  });
  it('quoteSearchTerm leaves ordinary values alone', () => {
    expect(quoteSearchTerm('ABC-123')).toBe('ABC-123');
    expect(quoteSearchTerm('12345')).toBe('12345');
    expect(quoteSearchTerm('say "hi"')).toBe('"say hi"');
  });
});

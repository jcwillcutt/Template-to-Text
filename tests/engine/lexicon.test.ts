import { describe, expect, it } from 'vitest';
import {
  RESERVED_ASSIGNMENT_NAMES,
  RESERVED_KEYWORDS_IN_USE,
  IDENTIFIER_REGEX,
  ASSIGNMENT_REGEX,
  isVariableName,
  stripComments,
  templateNeedsSelectionObjects,
  applyWhitespaceTokens,
  restoreWhitespaceTokens,
  spliceGlobalVariables,
  NEWLINE_SENTINEL,
  SPACE_SENTINEL,
} from '../../src/engine/lexicon';
import { scanTopLevel, findMatchingClose, splitTopLevelCommas, hasBooleanOperator, topLevelEqualsIndex, topLevelLessThanIndex, unwrapChopCondition } from '../../src/engine/scan';

describe('reserved words', () => {
  it('every keyword used by a tag is protected from assignment', () => {
    for (const k of RESERVED_KEYWORDS_IN_USE) expect(RESERVED_ASSIGNMENT_NAMES.has(k), k).toBe(true);
  });
  it('no reserved word starts with $ (so $name is always collision-safe)', () => {
    for (const k of RESERVED_ASSIGNMENT_NAMES) expect(k[0]).not.toBe('$');
  });
  it('the guarantee covers every tag name the parser recognises', () => {
    for (const tag of ['if', 'else', 'while', 'chop', 'trim', 'repeat', 'replace', 'replacement', 'index', 'insert', 'length', 'wrap', 'comment', 'time', 'break', 'skip', 'tag', 'delineator', 'direction', 'drop', 'hard', 'min_wraps', 'max_wraps', 'skip_first', 'skip_last', 'tied']) {
      expect(RESERVED_ASSIGNMENT_NAMES.has(tag), tag).toBe(true);
    }
  });
});

describe('variable names', () => {
  it('accept anything without whitespace or structural characters', () => {
    for (const ok of ['x', 'total', 'my-var', '$x', 'é', '1abc', "it's", 'a?b', '_']) expect(isVariableName(ok), ok).toBe(true);
  });
  it('reject structural characters, whitespace and reserved words', () => {
    for (const bad of ['', 'a b', 'a.b', 'a=b', 'a<b', 'a>b', 'a!b', 'a&b', 'a|b', 'a,b', 'a(b', 'a)b', 'a{b', 'a}b', 'if', 'LENGTH', 'Time']) expect(isVariableName(bad), bad).toBe(false);
  });
  it('IDENTIFIER_REGEX and ASSIGNMENT_REGEX agree on the name grammar', () => {
    expect(IDENTIFIER_REGEX.test('abc')).toBe(true);
    expect(IDENTIFIER_REGEX.test('a b')).toBe(false);
    expect(ASSIGNMENT_REGEX.exec('abc = 5')?.[1]).toBe('abc');
    expect(ASSIGNMENT_REGEX.exec('abc == 5')).toBeNull();
    expect(ASSIGNMENT_REGEX.exec('abc')).toBeNull();
  });
});

describe('comments', () => {
  it('stripComments removes every block, across lines, leaving unclosed ones', () => {
    expect(stripComments('a{{#comment}}x{{/comment}}b{{ #comment }}\ny\n{{ /comment }}c')).toBe('abc');
    expect(stripComments('a{{#comment}}b')).toBe('a{{#comment}}b');
  });
  it('templateNeedsSelectionObjects: whether a template reads per-object data', () => {
    expect(templateNeedsSelectionObjects('hello {{ time=yyyy }}')).toBe(false);
    expect(templateNeedsSelectionObjects('{{ product.title }}')).toBe(true);
    expect(templateNeedsSelectionObjects('{{#selection.foreach p}}x{{/selection.foreach}}')).toBe(true);
    expect(templateNeedsSelectionObjects('{{ selection.first.note }}')).toBe(true);
    expect(templateNeedsSelectionObjects('{{ #comment }}{{ product.title }}{{ /comment }}static')).toBe(false);
  });
});

describe('whitespace tokens', () => {
  it('encode as sentinels and restore to real characters', () => {
    const enc = applyWhitespaceTokens('a{{ /return }}b{{/space}}c');
    expect(enc).toBe(`a${NEWLINE_SENTINEL}b${SPACE_SENTINEL}c`);
    expect(restoreWhitespaceTokens(enc)).toBe('a\nb c');
  });
  it('retired backslash spellings become markers', () => {
    expect(applyWhitespaceTokens('{{ \\n }}')).toContain('retired');
    expect(applyWhitespaceTokens('{{ \\t }}')).toContain('retired');
  });
});

describe('global splice', () => {
  it('replaces bare reads only, once, without recursion', () => {
    expect(spliceGlobalVariables('{{ $global:a }}|{{$global:b}}', { a: '1', b: '{{ $global:a }}' })).toBe('1|{{ $global:a }}');
    expect(spliceGlobalVariables('{{ $global:zzz }}', {})).toContain('no global variable named "zzz"');
    expect(spliceGlobalVariables('{{ $global:a = 1 }}', { a: 'x' })).toBe('{{ $global:a = 1 }}');
  });
});

describe('scanning primitives', () => {
  it('findMatchingClose balances nested braces', () => {
    expect(findMatchingClose('{{ a }} b', 0)).toBe(7);
    expect(findMatchingClose('{{ a {{ b }} c }} d', 0)).toBe(17);
    expect(findMatchingClose('{{ a', 0)).toBe(-1);
  });
  it('scanTopLevel reports each character with its brace depth (brace pairs themselves are skipped)', () => {
    const seen: string[] = [];
    scanTopLevel('a{{ b }}c', (i, depth) => (seen.push(`${'a{{ b }}c'[i]}${depth}`), false));
    expect(seen).toEqual(['a0', ' 1', 'b1', ' 1', 'c0']);
  });
  it('splitTopLevelCommas', () => {
    expect(splitTopLevelCommas('a, {{ b, c }}, d')).toEqual(['a', ' {{ b, c }}', ' d']);
  });
  it('hasBooleanOperator only counts top-level operators', () => {
    expect(hasBooleanOperator('a == b')).toBe(true);
    expect(hasBooleanOperator('{{ a == b }}')).toBe(false);
    expect(hasBooleanOperator('a')).toBe(false);
    expect(hasBooleanOperator('a && b')).toBe(true);
    expect(hasBooleanOperator('a < b')).toBe(true);
  });
  it('topLevelEqualsIndex skips comparison operators and nested tokens', () => {
    expect(topLevelEqualsIndex('i=0')).toBe(1);
    expect(topLevelEqualsIndex('a == b')).toBe(-1);
    expect(topLevelEqualsIndex('{{ a=b }}')).toBe(-1);
  });
  it('topLevelLessThanIndex', () => {
    expect(topLevelLessThanIndex('0<5')).toBe(1);
    expect(topLevelLessThanIndex('{{ a<b }}')).toBe(-1);
  });
  it('unwrapChopCondition strips grouping braces but keeps a lone field token', () => {
    expect(unwrapChopCondition('{{ {{j}}==3 }}')).toBe('{{j}}==3');
    expect(unwrapChopCondition('{{ product.title }}')).toBe('{{ product.title }}');
  });
});

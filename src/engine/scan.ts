// Brace-depth-aware text scanning primitives shared by the parser. Verbatim from the legacy engine.

// Find matching closing `}}` for an opening `{{` at openIndex, counting nested `{{`/`}}` pairs so an
// equation body may itself contain `{{ ... }}` tokens. Returns the index just past the closing `}}`,
// or -1 if unbalanced.
export function findMatchingClose(text: string, openIndex: number): number {
  let depth = 0;
  let i = openIndex;
  while (i < text.length - 1) {
    if (text[i] === '{' && text[i + 1] === '{') {
      depth += 1;
      i += 2;
      continue;
    }
    if (text[i] === '}' && text[i + 1] === '}') {
      depth -= 1;
      i += 2;
      if (depth === 0) {
        return i;
      }
      continue;
    }
    i += 1;
  }
  return -1;
}

// Shared brace-depth scanner underlying topLevelEqualsIndex, topLevelLessThanIndex,
// hasBooleanOperator, and splitTopLevelCommas below -- previously each of the four hand-rolled its
// own copy of this exact loop. Walks `text` from the start, treating `{{`/`}}` as nesting depth
// in/out markers (an unbalanced `}}` is clamped at depth 0, since callers scan arbitrary
// sub-expressions that are not themselves guaranteed to be balanced). `onChar(i, depth)` is called
// for every character that is not itself part of a `{{`/`}}` pair; returning true stops the scan
// and that index is returned, otherwise the scan runs to the end of `text` and -1 is returned.
export function scanTopLevel(text: string, onChar: (i: number, depth: number) => boolean): number {
  let depth = 0;
  let i = 0;
  while (i < text.length) {
    if (text[i] === '{' && text[i + 1] === '{') {
      depth += 1;
      i += 2;
      continue;
    }
    if (text[i] === '}' && text[i + 1] === '}') {
      if (depth > 0) depth -= 1;
      i += 2;
      continue;
    }
    if (onChar(i, depth)) {
      return i;
    }
    i += 1;
  }
  return -1;
}

// Index of the first `=` that sits outside any {{ }} group and is not part of a comparison operator
// (==, !=, <=, >=). Returns -1 when there is none.
export function topLevelEqualsIndex(text: string): number {
  return scanTopLevel(text, (i, depth) => {
    if (depth !== 0 || text[i] !== '=') return false;
    const prev = i > 0 ? text[i - 1] : '';
    const next = text[i + 1] || '';
    return next !== '=' && prev !== '=' && prev !== '!' && prev !== '<' && prev !== '>';
  });
}

// Index of the first `<` that sits outside any {{ }} group, used to split a loop counter value into
// its START and MAX (chunk size) parts. Returns -1 when there is none.
export function topLevelLessThanIndex(text: string): number {
  return scanTopLevel(text, (i, depth) => depth === 0 && text[i] === '<');
}

// Whether the token text contains a comparison or logical operator at brace depth 0, which makes it
// a BOOLEAN expression token (rendered as TRUE / FALSE) rather than a plain field token.
export function hasBooleanOperator(text: string): boolean {
  return (
    scanTopLevel(text, (i, depth) => {
      if (depth !== 0) return false;
      const two = text.slice(i, i + 2);
      return (
        two === '==' ||
        two === '!=' ||
        two === '<=' ||
        two === '>=' ||
        two === '&&' ||
        two === '||' ||
        text[i] === '<' ||
        text[i] === '>'
      );
    }) !== -1
  );
}

// Split a chop parameter string on commas that sit outside any {{ }} group, so a condition may
// contain commas inside nested tokens.
export function splitTopLevelCommas(text: string): string[] {
  const parts: string[] = [];
  let last = 0;
  scanTopLevel(text, (i, depth) => {
    if (depth === 0 && text[i] === ',') {
      parts.push(text.slice(last, i));
      last = i + 1;
    }
    return false;
  });
  parts.push(text.slice(last));
  return parts;
}

// Strip an outer {{ ... }} wrapper from a chop condition when the wrapper is just grouping (its
// inner text contains a nested token or a boolean/comparison operator), e.g. `{{ {{j}}==3 }}` or
// `{{{{j}} == 0}}`. A lone token such as `{{ product.title }}` is left intact so it still resolves.
export function unwrapChopCondition(rawCondition: string): string {
  let expr = rawCondition.trim();
  for (let guard = 0; guard < 5; guard++) {
    if (expr.slice(0, 2) !== '{{' || expr.slice(-2) !== '}}') break;
    if (findMatchingClose(expr, 0) !== expr.length) break;
    const inner = expr.slice(2, -2).trim();
    const isGroup =
      inner.includes('{{') ||
      inner.includes('==') ||
      inner.includes('!=') ||
      inner.includes('<') ||
      inner.includes('>') ||
      inner.includes('&&') ||
      inner.includes('||') ||
      inner.includes('!');
    if (!isGroup) break;
    expr = inner;
  }
  return expr;
}

// Template text -> Node[] (parsed ONCE per template, evaluated once per output file).
//
// Two parse modes mirror the two ways the legacy engine consumed text:
//   * full   -- block tags (`{{ #if=.. }}..{{ /if }}`, loops, text tools) are recognised and nested.
//               Used for the template body, block bodies and assignment values.
//   * inline -- only `{{ ... }}` tokens; block tags stay literal text. Used for tag parameters,
//               conditions and equations (the legacy `renderTemplateText`).
//
// Malformed input never throws: a closing tag with no opener, an `{{ #else }}` outside an `#if`, or an
// opener that is never closed are all kept as literal text, exactly as the legacy engine echoed them.

import type {
  ChopNode,
  Compiled,
  Cond,
  ForeachKind,
  ForeachNode,
  IfNode,
  Node,
  Operand,
} from './ast';
import {
  ASSIGNMENT_REGEX,
  GLOBAL_PREFIX,
  LENGTH_PREFIX_REGEX,
  RESERVED_ASSIGNMENT_NAMES,
  TIME_PREFIX_REGEX,
  applyWhitespaceTokens,
  isVariableName,
  spliceGlobalVariables,
  stripComments,
} from './lexicon';
import { compileField } from './fields';
import { deprecatedSyntaxMarker, globalReadOnlyMarker } from './markers';
import {
  findMatchingClose,
  hasBooleanOperator,
  splitTopLevelCommas,
  topLevelEqualsIndex,
  topLevelLessThanIndex,
  unwrapChopCondition,
} from './scan';
import { parseWrapParams } from './wrap';

// ---------------------------------------------------------------------------------------------
// Lexing: split text into literal runs and balanced `{{ ... }}` tokens.
type LexItem = { text: string } | { inner: string };

function lex(text: string): LexItem[] {
  const items: LexItem[] = [];
  let i = 0;
  let last = 0;
  while (i < text.length) {
    const open = text.indexOf('{{', i);
    if (open === -1) break;
    const close = findMatchingClose(text, open);
    if (close === -1) {
      // Unbalanced: this `{` is literal; keep scanning from the next character.
      i = open + 1;
      continue;
    }
    if (open > last) items.push({ text: text.slice(last, open) });
    items.push({ inner: text.slice(open + 2, close - 2) });
    i = close;
    last = close;
  }
  if (last < text.length) items.push({ text: text.slice(last) });
  return items;
}

function pushNode(seq: Node[], node: Node): void {
  const prev = seq[seq.length - 1];
  if (node.k === 'text' && prev && prev.k === 'text') {
    seq[seq.length - 1] = { k: 'text', s: prev.s + node.s };
  } else if (node.k !== 'text' || node.s !== '') {
    seq.push(node);
  }
}

// ---------------------------------------------------------------------------------------------
// Inline sequences and numeric expressions.
export function parseInline(text: string): Node[] {
  const out: Node[] = [];
  for (const item of lex(text)) {
    if ('text' in item) pushNode(out, { k: 'text', s: item.text });
    else pushNode(out, makeToken(item.inner));
  }
  return out;
}

// A tag-parameter expression that is resolved to a number at run time (the legacy resolveExprToNumber):
// null when empty, which callers read as "no value".
function numeric(expr: string): Node[] | null {
  const trimmed = expr.trim();
  return trimmed === '' ? null : parseInline(trimmed);
}

function operand(text: string): Operand {
  const nodes = parseInline(text);
  const constant = nodes.every((n) => n.k === 'text') ? nodes.map((n) => (n as { s: string }).s).join('') : null;
  return { nodes, constant };
}

// ---------------------------------------------------------------------------------------------
// Boolean conditions (structural; see ast.ts). Operators are found in the static text only -- tokens
// are skipped as atoms -- while parentheses group exactly as the legacy grammar did.
const BAD: Cond = { c: 'bad' };

// Visit each static character (not inside a `{{ }}` token, not a paren) with the current paren depth.
function scanStatic(text: string, visit: (i: number, depth: number) => boolean): number {
  let depth = 0;
  let i = 0;
  while (i < text.length) {
    if (text[i] === '{' && text[i + 1] === '{') {
      const end = findMatchingClose(text, i);
      if (end !== -1) {
        i = end;
        continue;
      }
    }
    const ch = text[i];
    if (ch === '(') {
      depth += 1;
    } else if (ch === ')') {
      if (depth > 0) depth -= 1;
    } else if (visit(i, depth)) {
      return i;
    }
    i += 1;
  }
  return -1;
}

function splitStatic(expr: string, op: string): string[] {
  const parts: string[] = [];
  let last = 0;
  let skipUntil = -1;
  scanStatic(expr, (i, depth) => {
    if (i < skipUntil) return false;
    if (depth === 0 && expr.startsWith(op, i)) {
      parts.push(expr.slice(last, i));
      last = i + op.length;
      skipUntil = last;
    }
    return false;
  });
  parts.push(expr.slice(last));
  return parts;
}

function isFullyParenthesized(expr: string): boolean {
  if (expr[0] !== '(' || expr[expr.length - 1] !== ')') return false;
  let depth = 0;
  let i = 0;
  while (i < expr.length) {
    if (expr[i] === '{' && expr[i + 1] === '{') {
      const end = findMatchingClose(expr, i);
      if (end !== -1) {
        i = end;
        continue;
      }
    }
    if (expr[i] === '(') depth += 1;
    else if (expr[i] === ')') {
      depth -= 1;
      if (depth === 0 && i < expr.length - 1) return false;
    }
    i += 1;
  }
  return depth === 0;
}

function findComparison(expr: string): { op: '==' | '!=' | '<' | '>' | '<=' | '>='; at: number; len: number } | null {
  let found: { op: '==' | '!=' | '<' | '>' | '<=' | '>='; at: number; len: number } | null = null;
  scanStatic(expr, (i, depth) => {
    if (depth !== 0) return false;
    const two = expr.slice(i, i + 2);
    if (two === '<=' || two === '>=' || two === '==' || two === '!=') {
      found = { op: two, at: i, len: 2 };
      return true;
    }
    if (expr[i] === '<' || expr[i] === '>') {
      found = { op: expr[i] as '<' | '>', at: i, len: 1 };
      return true;
    }
    return false;
  });
  return found;
}

export function parseCond(raw: string): Cond {
  const t = raw.trim();
  if (t === '') return BAD;
  const or = splitStatic(t, '||');
  if (or.length > 1) return { c: 'or', parts: or.map(parseCond) };
  const and = splitStatic(t, '&&');
  if (and.length > 1) return { c: 'and', parts: and.map(parseCond) };
  if (t[0] === '!' && t.slice(0, 2) !== '!=') return { c: 'not', x: parseCond(t.slice(1)) };
  if (isFullyParenthesized(t)) return parseCond(t.slice(1, -1));
  const cmp = findComparison(t);
  if (cmp) {
    return { c: 'cmp', op: cmp.op, l: operand(t.slice(0, cmp.at)), r: operand(t.slice(cmp.at + cmp.len)) };
  }
  return { c: 'truthy', x: operand(t) };
}

// ---------------------------------------------------------------------------------------------
// Single `{{ ... }}` tokens (everything that is not a block tag). The recognition ORDER matches the
// legacy renderTokenContent: block marker -> break/skip -> equation -> retired length= -> time= ->
// assignment -> boolean expression -> plain field/variable.
function textNode(s: string): Node {
  return { k: 'text', s };
}

export function makeToken(inner: string): Node {
  const trimmed = inner.trim();
  if (trimmed === '') return { k: 'empty' };
  if (trimmed[0] === '#' || trimmed[0] === '/') return textNode('{{' + inner + '}}');
  if (trimmed === 'break') return { k: 'ctl', v: 2 };
  if (trimmed === 'skip') return { k: 'ctl', v: 1 };
  if (trimmed[0] === '=') return { k: 'math', expr: parseInline(trimmed.slice(1)) };
  if (LENGTH_PREFIX_REGEX.test(trimmed)) {
    return textNode(deprecatedSyntaxMarker('the length=STRING token is retired -- use {{ #length }}STRING{{ /length }} instead'));
  }
  const timeMatch = TIME_PREFIX_REGEX.exec(trimmed);
  if (timeMatch) return { k: 'time', fmt: parseInline(trimmed.slice(timeMatch[0].length)) };
  const assign = ASSIGNMENT_REGEX.exec(trimmed);
  if (assign) {
    if (assign[1].indexOf(GLOBAL_PREFIX) === 0) return textNode(globalReadOnlyMarker(assign[1].slice(GLOBAL_PREFIX.length)));
    if (!RESERVED_ASSIGNMENT_NAMES.has(assign[1].toLowerCase())) {
      return { k: 'assign', name: assign[1], value: parseFull(trimmed.slice(assign[0].length)).root };
    }
  }
  if (hasBooleanOperator(trimmed)) return { k: 'bool', cond: parseCond(trimmed) };
  return { k: 'field', resolve: compileField(trimmed) };
}

// ---------------------------------------------------------------------------------------------
// Block tags.
type Family =
  | 'if'
  | 'chop'
  | 'repeat'
  | 'replace'
  | 'while'
  | 'index'
  | 'insert'
  | 'wrap'
  | 'variants'
  | 'tags'
  | 'metafields'
  | 'length'
  | 'selection'
  | 'products'
  | 'notes';

// Opening tags, tested against the token text with leading whitespace removed. The text after the match
// (params) keeps its trailing whitespace, like the legacy open-tag slice.
const OPENERS: { re: RegExp; fam: Family }[] = [
  { re: /^#if=/, fam: 'if' },
  { re: /^#(?:chop|trim)=/, fam: 'chop' },
  { re: /^#repeat=/, fam: 'repeat' },
  { re: /^#replace=/, fam: 'replace' },
  { re: /^#?while=/, fam: 'while' },
  { re: /^#index=/, fam: 'index' },
  { re: /^#insert=/, fam: 'insert' },
  { re: /^#wrap=/, fam: 'wrap' },
  { re: /^#(?:variants?\.foreach(?:\s+[^\s,{}]+)?|product\.foreach)/, fam: 'variants' },
  { re: /^#tags\.foreach(?:\s+[^\s,{}]+)?/, fam: 'tags' },
  { re: /^#metafields\.foreach(?:\s+[^\s,{}]+)?/, fam: 'metafields' },
  { re: /^#length\b/, fam: 'length' },
  { re: /^#selection\.foreach(?:\s+[^\s,{}]+)?/, fam: 'selection' },
  { re: /^#products\.foreach(?:\s+[^\s,{}]+)?/, fam: 'products' },
  { re: /^#notes\.foreach(?:\s+[^\s,{}]+)?/, fam: 'notes' },
];

// Closing tags, tested against the TRIMMED token text.
const CLOSERS: { re: RegExp; fam: Family }[] = [
  { re: /^\/if$/, fam: 'if' },
  { re: /^\/(?:chop|trim)$/, fam: 'chop' },
  { re: /^\/repeat$/, fam: 'repeat' },
  { re: /^\/replace$/, fam: 'replace' },
  { re: /^\/while$/, fam: 'while' },
  { re: /^\/index$/, fam: 'index' },
  { re: /^\/insert$/, fam: 'insert' },
  { re: /^\/wrap$/, fam: 'wrap' },
  { re: /^\/(?:variants?\.foreach|product\.foreach)$/, fam: 'variants' },
  { re: /^\/tags\.foreach$/, fam: 'tags' },
  { re: /^\/metafields\.foreach$/, fam: 'metafields' },
  { re: /^\/length$/, fam: 'length' },
  { re: /^\/selection\.foreach(?:\s+[^\s,{}]+)?$/, fam: 'selection' },
  { re: /^\/products\.foreach(?:\s+[^\s,{}]+)?$/, fam: 'products' },
  { re: /^\/notes\.foreach(?:\s+[^\s,{}]+)?$/, fam: 'notes' },
];

const SELECTION_FOREACH_KEYWORD = /^#selection\.foreach(?:\s+(product|products|object|objects|note|notes))?/i;

interface Frame {
  fam: Family;
  openInner: string;
  params: string;
  head: string; // the opener text (leading whitespace removed), for keyword lookups
  kids: Node[];
  elseInner: string | null;
  elseKids: Node[] | null;
}

function segmentsKV(raw: string, from = 0): { key: string; value: string }[] {
  const out: { key: string; value: string }[] = [];
  const segments = splitTopLevelCommas(raw);
  for (let k = from; k < segments.length; k++) {
    const eq = segments[k].indexOf('=');
    if (eq === -1) continue;
    out.push({ key: segments[k].slice(0, eq).trim(), value: segments[k].slice(eq + 1).trim() });
  }
  return out;
}

function counterParams(raw: string, defaultName: string): { name: string; start: Node[] | null; deprecatedTied: boolean } {
  let name = defaultName;
  let start: Node[] | null = null;
  let deprecatedTied = false;
  for (const { key, value } of segmentsKV(raw)) {
    if (key.toLowerCase() === 'tied') deprecatedTied = true;
    else if (isVariableName(key)) {
      name = key;
      start = numeric(value);
    }
  }
  return { name, start, deprecatedTied };
}

function buildChop(params: string, body: Node[]): ChopNode {
  const segments = splitTopLevelCommas(params);
  const condition = unwrapChopCondition(segments[0] || '');
  let direction: 'L' | 'R' = 'L';
  let counter = 'j';
  let start: Node[] | null = null;
  for (let k = 1; k < segments.length; k++) {
    const eq = segments[k].indexOf('=');
    if (eq === -1) continue;
    const key = segments[k].slice(0, eq).trim();
    const rawValue = segments[k].slice(eq + 1).trim();
    if (key.toLowerCase() === 'direction') direction = rawValue.toUpperCase() === 'R' ? 'R' : 'L';
    else if (isVariableName(key)) {
      counter = key;
      start = numeric(rawValue);
    }
  }
  return { k: 'chop', cond: condition.trim() === '' ? null : parseCond(condition), direction, counter, start, body };
}

function buildForeach(fam: Family, head: string, params: string, body: Node[]): ForeachNode {
  let kind: ForeachKind = 'rows';
  if (fam === 'notes') kind = 'notes';
  else if (fam === 'selection') {
    const keyword = head.match(SELECTION_FOREACH_KEYWORD)?.[1]?.toLowerCase();
    kind = keyword === 'object' || keyword === 'objects' ? 'object' : keyword === 'note' || keyword === 'notes' ? 'notes' : 'rows';
  }
  let skipFirst = false;
  let skipLast = false;
  let name = 'i';
  let startExpr = '0';
  let maxExpr = '';
  for (const segment of splitTopLevelCommas(params.replace(/^\s*,/, ''))) {
    const eq = topLevelEqualsIndex(segment);
    if (eq === -1) continue;
    const key = segment.slice(0, eq).trim();
    const value = segment.slice(eq + 1).trim();
    if (key === 'skip_first') skipFirst = value === 'TRUE';
    else if (key === 'skip_last') skipLast = value === 'TRUE';
    else if (isVariableName(key)) {
      name = key;
      const lt = topLevelLessThanIndex(value);
      if (lt === -1) startExpr = value;
      else {
        startExpr = value.slice(0, lt);
        maxExpr = value.slice(lt + 1);
      }
    }
  }
  return { k: 'foreach', kind, skipFirst, skipLast, name, start: numeric(startExpr), deprecatedChunk: maxExpr.trim() !== '', body };
}

function buildBlock(frame: Frame): Node {
  const { fam, params, kids } = frame;
  switch (fam) {
    case 'if': {
      const node: IfNode = { k: 'if', cond: parseCond(params), condText: params, then: kids, otherwise: frame.elseKids };
      return node;
    }
    case 'chop':
      return buildChop(params, kids);
    case 'repeat': {
      const delineatorMatch = params.match(/delineator\s*=/);
      let countPart = params;
      let delineator = '';
      if (delineatorMatch && delineatorMatch.index != null) {
        countPart = params.slice(0, delineatorMatch.index);
        delineator = params.slice(delineatorMatch.index + delineatorMatch[0].length).trim();
      }
      return { k: 'repeat', count: parseInline(countPart.replace(/,\s*$/, '').trim()), delineator, body: kids };
    }
    case 'replace': {
      const replacementMatch = params.match(/replacement\s*=/);
      let searchPart = params;
      let replacementPart = '';
      if (replacementMatch && replacementMatch.index != null) {
        searchPart = params.slice(0, replacementMatch.index);
        replacementPart = params.slice(replacementMatch.index + replacementMatch[0].length);
      }
      return {
        k: 'replace',
        search: parseInline(searchPart.replace(/,\s*$/, '').trim()),
        replacement: parseInline(replacementPart),
        body: kids,
      };
    }
    case 'index':
      return { k: 'index', position: parseInline(params.trim()), body: kids };
    case 'insert': {
      const segments = splitTopLevelCommas(params);
      let drop = false;
      for (let k = 1; k < segments.length; k++) {
        const eq = segments[k].indexOf('=');
        if (eq === -1) continue;
        if (segments[k].slice(0, eq).trim().toLowerCase() === 'drop') drop = segments[k].slice(eq + 1).trim().toUpperCase() === 'TRUE';
      }
      return { k: 'insert', position: parseInline((segments[0] || '').trim()), drop, body: kids };
    }
    case 'while': {
      const segments = splitTopLevelCommas(params);
      if (segments.length >= 2) return { k: 'while', cond: null, deprecated: true, body: kids };
      const condition = unwrapChopCondition(segments[0] || '');
      return { k: 'while', cond: condition.trim() === '' ? null : parseCond(condition), deprecated: false, body: kids };
    }
    case 'variants': {
      const { name, start, deprecatedTied } = counterParams(params, 'l');
      return { k: 'variants', name, start, deprecatedTied, body: kids };
    }
    case 'tags': {
      const { name, start } = counterParams(params, 'i');
      return { k: 'tags', name, start, body: kids };
    }
    case 'metafields': {
      const { name, start } = counterParams(params, 'i');
      return { k: 'metafields', name, start, body: kids };
    }
    case 'length':
      return { k: 'length', body: kids };
    case 'wrap': {
      const { maxChars, minWraps, maxWraps, delineator, hard } = parseWrapParams(params);
      const firstSegment = String(params).split(',')[0].trim();
      const valid = Number.isInteger(maxChars) && maxChars > 0 && firstSegment === String(maxChars);
      return { k: 'wrap', valid, maxChars, minWraps, maxWraps, delineator, hard, body: kids };
    }
    default:
      return buildForeach(fam, frame.head, params, kids);
  }
}

// ---------------------------------------------------------------------------------------------
// Full-mode parse.
export function parseFull(text: string): Compiled {
  const root: Node[] = [];
  const stack: Frame[] = [];
  const target = (): Node[] => {
    const top = stack[stack.length - 1];
    return top ? (top.elseKids ?? top.kids) : root;
  };
  const targetOf = (idx: number): Node[] => {
    const f = stack[idx - 1];
    return f ? (f.elseKids ?? f.kids) : root;
  };
  // An opener that never found its closer: echo it as text and splice its content into the parent.
  const unwind = (idx: number): void => {
    const frame = stack[idx];
    const into = targetOf(idx);
    pushNode(into, textNode('{{' + frame.openInner + '}}'));
    for (const n of frame.kids) pushNode(into, n);
    if (frame.elseKids) {
      pushNode(into, textNode('{{' + frame.elseInner + '}}'));
      for (const n of frame.elseKids) pushNode(into, n);
    }
  };

  for (const item of lex(text)) {
    if ('text' in item) {
      pushNode(target(), textNode(item.text));
      continue;
    }
    const inner = item.inner;
    const head = inner.replace(/^\s+/, '');
    const trimmed = inner.trim();

    if (head[0] === '#' || head.startsWith('while=')) {
      if (trimmed === '#else') {
        const top = stack[stack.length - 1];
        if (top && top.fam === 'if' && top.elseKids === null) {
          top.elseKids = [];
          top.elseInner = inner;
        } else {
          pushNode(target(), textNode('{{' + inner + '}}'));
        }
        continue;
      }
      const opener = OPENERS.find((o) => o.re.test(head));
      if (opener) {
        const m = head.match(opener.re) as RegExpMatchArray;
        const params = head.slice(m[0].length);
        // The legacy wrap tag only matched when its parameters contained no `}`.
        if (opener.fam === 'wrap' && params.includes('}')) {
          pushNode(target(), textNode('{{' + inner + '}}'));
        } else {
          stack.push({ fam: opener.fam, openInner: inner, params, head, kids: [], elseInner: null, elseKids: null });
        }
        continue;
      }
    } else if (trimmed[0] === '/') {
      const closer = CLOSERS.find((c) => c.re.test(trimmed));
      if (closer) {
        let idx = stack.length - 1;
        while (idx >= 0 && stack[idx].fam !== closer.fam) idx -= 1;
        if (idx < 0) {
          pushNode(target(), textNode('{{' + inner + '}}'));
        } else {
          for (let u = stack.length - 1; u > idx; u--) unwind(u);
          stack.length = idx + 1;
          const frame = stack.pop() as Frame;
          pushNode(target(), buildBlock(frame));
        }
        continue;
      }
    }
    pushNode(target(), makeToken(inner));
  }
  for (let u = stack.length - 1; u >= 0; u--) unwind(u);

  const flat = flattenForeachInsideWhile(root, false);
  return { root: flat, firstForeach: findFirstForeach(flat) };
}

// ---------------------------------------------------------------------------------------------
// Tree utilities.
function childSeqs(node: Node): Node[][] {
  switch (node.k) {
    case 'if':
      return node.otherwise ? [node.then, node.otherwise] : [node.then];
    case 'assign':
      return [node.value];
    case 'chop':
    case 'repeat':
    case 'replace':
    case 'index':
    case 'insert':
    case 'while':
    case 'variants':
    case 'tags':
    case 'metafields':
    case 'length':
    case 'wrap':
    case 'foreach':
      return [node.body];
    default:
      return [];
  }
}

// A selection-scope foreach may not sit inside a while loop (a while never steps through the selection):
// its tags are dropped and its body is inlined, as the legacy flattenForeachInsideWhile did.
function flattenForeachInsideWhile(seq: Node[], inWhile: boolean): Node[] {
  const out: Node[] = [];
  for (const node of seq) {
    if (node.k === 'foreach' && inWhile) {
      for (const n of flattenForeachInsideWhile(node.body, true)) pushNode(out, n);
      continue;
    }
    const nextInWhile = inWhile || node.k === 'while';
    switch (node.k) {
      case 'if':
        node.then = flattenForeachInsideWhile(node.then, inWhile);
        if (node.otherwise) node.otherwise = flattenForeachInsideWhile(node.otherwise, inWhile);
        break;
      case 'assign':
        node.value = flattenForeachInsideWhile(node.value, inWhile);
        break;
      case 'chop':
      case 'repeat':
      case 'replace':
      case 'index':
      case 'insert':
      case 'while':
      case 'variants':
      case 'tags':
      case 'metafields':
      case 'length':
      case 'wrap':
      case 'foreach':
        node.body = flattenForeachInsideWhile(node.body, nextInWhile);
        break;
      default:
        break;
    }
    pushNode(out, node);
  }
  return out;
}

function findFirstForeach(seq: Node[]): ForeachNode | null {
  for (const node of seq) {
    if (node.k === 'foreach') return node;
    for (const kids of childSeqs(node)) {
      const found = findFirstForeach(kids);
      if (found) return found;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Whole-template compile with a small cache: a download renders the same template for every file, and a
// preview re-renders it on every keystroke-debounce, so parsing once pays off immediately.
const CACHE_LIMIT = 24;
const cache = new Map<string, Compiled>();

export function compileTemplate(body: string, globalBodiesByTitle: Record<string, string>): Compiled {
  const referenced: [string, string][] = [];
  if (body.indexOf('$global:') !== -1) {
    for (const name of Object.keys(globalBodiesByTitle)) {
      if (body.indexOf(GLOBAL_PREFIX + name) !== -1) referenced.push([name, globalBodiesByTitle[name]]);
    }
  }
  const key = referenced.length === 0 ? body : body + '\u0000' + JSON.stringify(referenced);
  const hit = cache.get(key);
  if (hit) {
    // Refresh recency.
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const prepared = spliceGlobalVariables(stripComments(applyWhitespaceTokens(body)), globalBodiesByTitle);
  const compiled = parseFull(prepared);
  cache.set(key, compiled);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
  return compiled;
}

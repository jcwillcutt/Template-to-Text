// Evaluate a parsed template (Node[]) against a render context, in DOCUMENT ORDER and in ONE pass.
//
// Everything is evaluated left to right exactly once, so a variable assigned earlier in the template is
// visible to every later token, condition and loop -- including `{{ #if=.. }}` conditions (the legacy
// engine resolved all if-blocks up front, before any assignment ran) and variables set before a
// selection loop (the legacy engine expanded selection loops before everything else).

import type { ProductData } from '../domain/types';
import {
  scopeOf,
  type Cond,
  type Ctx,
  type ForeachNode,
  type KindedRow,
  type Node,
  type Operand,
  type RenderEnv,
  type RowKind,
  type Scope,
} from './ast';
import { formatDateTime } from './datetime';
import { restoreWhitespaceTokens } from './lexicon';
import { UNRESOLVED_VARIABLE_ERROR_PREFIX, deprecatedSyntaxMarker, unresolvedVariableMarker } from './markers';
import { evaluateMathExpression } from './math';
import { parseInline } from './parse';
import { foreachSelection, noteToPseudoProduct } from './rows';
import { applyIndex, applyInsert, applyRepeat, applyReplace } from './textops';
import { applyWordWrap } from './wrap';

// Hard safety cap on while-loop iterations.
export const MAX_WHILE_ITERATIONS = 10000;

// Reads the loop signal through a call so TypeScript doesn't narrow it to the 0 we just assigned.
const signalOf = (ctx: Ctx): number => ctx.ctl;

const MARKER_SNIPPET = 'unresolved variable "';

// Rendering against an empty selection (no row at all) must not throw: fields just come back blank.
export const EMPTY_ROW: ProductData = noteToPseudoProduct({ id: 'empty', note: '' });

// ---------------------------------------------------------------------------------------------
// Context.
export function createVarStore(): Map<string, string> {
  const store = new Map<string, string>();
  for (const name of ['i', 'j', 'k', 'l', 'x', 'y', 'z']) store.set(name, '');
  return store;
}

export function createEnv(rows: ProductData[], rowKind: RowKind, notes: { id: string; note: string }[]): RenderEnv {
  return { rows, rowKind, notes, items: new Map(), filtered: new Map() };
}

export function createCtx(
  env: RenderEnv,
  base: { now: Date; primaryDomain: string; selectionLength: number; currKind: RowKind; prev: KindedRow | null; next: KindedRow | null },
): Ctx {
  return {
    env,
    vars: createVarStore(),
    now: base.now,
    primaryDomain: base.primaryDomain,
    selectionLength: base.selectionLength,
    currKind: base.currKind,
    prev: base.prev,
    next: base.next,
    currentMetafield: null,
    ctl: 0,
    sawMarker: false,
    window: null,
  };
}

// Render a compiled template: evaluate, then turn the whitespace sentinels into real characters.
export function renderRoot(root: Node[], ctx: Ctx, sc: Scope): string {
  return restoreWhitespaceTokens(evalNodes(root, 0, ctx, sc, false));
}

// ---------------------------------------------------------------------------------------------
// Numbers and conditions.
function readVarNumber(vars: Map<string, string>, name: string): number {
  const num = parseFloat(vars.get(name) ?? '');
  return Number.isFinite(num) ? num : 0;
}

// A tag-parameter expression -> number (null when empty/invalid), like the legacy resolveExprToNumber.
function evalNumber(expr: Node[] | null, ctx: Ctx, sc: Scope): number | null {
  if (expr === null) return null;
  const resolved = evalNodes(expr, 0, ctx, sc, true);
  try {
    const value = evaluateMathExpression(resolved);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

const counterStart = (expr: Node[] | null, ctx: Ctx, sc: Scope): number => {
  const v = evalNumber(expr, ctx, sc);
  return v == null ? 0 : Math.round(v);
};

interface Reading {
  num: number | null;
  str: string;
}

function readString(str: string): Reading {
  const trimmed = str.trim();
  try {
    const num = evaluateMathExpression(trimmed);
    return { num: Number.isFinite(num) ? num : null, str: trimmed };
  } catch {
    return { num: null, str: trimmed };
  }
}

function readOperand(o: Operand, ctx: Ctx, sc: Scope): Reading {
  if (o.constant !== null) return o.pre ?? (o.pre = readString(o.constant));
  const s = evalNodes(o.nodes, 0, ctx, sc, false);
  if (s.indexOf(MARKER_SNIPPET) !== -1) ctx.sawMarker = true;
  return readString(s);
}

// Throws on a statically empty expression; callers treat that as FALSE.
function evalCond(c: Cond, ctx: Ctx, sc: Scope): boolean {
  switch (c.c) {
    case 'or':
      for (const p of c.parts) if (evalCond(p, ctx, sc)) return true;
      return false;
    case 'and':
      for (const p of c.parts) if (!evalCond(p, ctx, sc)) return false;
      return true;
    case 'not':
      return !evalCond(c.x, ctx, sc);
    case 'cmp': {
      const l = readOperand(c.l, ctx, sc);
      const r = readOperand(c.r, ctx, sc);
      const both = l.num != null && r.num != null;
      switch (c.op) {
        case '==':
          return both ? l.num === r.num : l.str === r.str;
        case '!=':
          return both ? l.num !== r.num : l.str !== r.str;
        case '<':
          return both ? (l.num as number) < (r.num as number) : false;
        case '>':
          return both ? (l.num as number) > (r.num as number) : false;
        case '<=':
          return both ? (l.num as number) <= (r.num as number) : false;
        default:
          return both ? (l.num as number) >= (r.num as number) : false;
      }
    }
    case 'truthy': {
      const v = readOperand(c.x, ctx, sc);
      if (v.num != null) return v.num !== 0;
      const lower = v.str.toLowerCase();
      return v.str !== '' && lower !== 'false' && lower !== '0';
    }
    default:
      throw new Error('Empty boolean expression');
  }
}

// FALSE for anything malformed.
function condTrue(c: Cond | null, ctx: Ctx, sc: Scope): boolean {
  if (c === null) return false;
  try {
    return evalCond(c, ctx, sc);
  } catch {
    return false;
  }
}

const codePointLength = (s: string): number => {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) i++;
    }
    n++;
  }
  return n;
};

// ---------------------------------------------------------------------------------------------
// The evaluator. `numeric` is true only inside an equation / numeric tag parameter, where a plain
// token must read as a number (empty or non-numeric -> 0).
export function evalNodes(nodes: Node[], from: number, ctx: Ctx, sc: Scope, numeric: boolean): string {
  let out = '';
  for (let n = from; n < nodes.length; n++) {
    const node = nodes[n];
    switch (node.k) {
      case 'text':
        out += node.s;
        break;
      case 'empty':
        if (numeric) out += '0';
        break;
      case 'field': {
        const raw = node.resolve(ctx, sc);
        if (numeric) {
          const parsed = parseFloat(raw);
          out += Number.isFinite(parsed) ? String(parsed) : '0';
        } else {
          out += raw;
        }
        break;
      }
      case 'math':
        out += evalMath(node.expr, ctx, sc, numeric);
        break;
      case 'time':
        out += formatDateTime(ctx.now, evalNodes(node.fmt, 0, ctx, sc, false));
        break;
      case 'assign':
        ctx.vars.set(node.name, evalNodes(node.value, 0, ctx, sc, false).trim());
        break;
      case 'bool': {
        let result: boolean | null = null;
        try {
          result = evalCond(node.cond, ctx, sc);
        } catch {
          /* malformed -> blank */
        }
        if (result === null) out += numeric ? '0' : '';
        else out += numeric ? (result ? '1' : '0') : result ? 'TRUE' : 'FALSE';
        break;
      }
      case 'ctl':
        if (node.v > ctx.ctl) ctx.ctl = node.v;
        break;
      case 'if': {
        ctx.sawMarker = false;
        let result = false;
        try {
          result = evalCond(node.cond, ctx, sc);
        } catch {
          result = false;
        }
        if (ctx.sawMarker) {
          // Part of the condition never evaluated (a bare variable in an equation). Show the failure
          // where the block's output would have gone instead of silently choosing a branch.
          ctx.sawMarker = false;
          out += evalNodes(parseInline(node.condText), 0, ctx, sc, false);
        } else if (result) {
          out += evalNodes(node.then, 0, ctx, sc, false);
        } else if (node.otherwise) {
          out += evalNodes(node.otherwise, 0, ctx, sc, false);
        }
        break;
      }
      case 'chop': {
        const jStart = counterStart(node.start, ctx, sc);
        const inner = evalNodes(node.body, 0, ctx, sc, false);
        const chars = Array.from(inner);
        let kept = 0;
        while (kept < chars.length) {
          ctx.vars.set(node.counter, String(jStart + kept));
          if (condTrue(node.cond, ctx, sc)) break;
          kept += 1;
        }
        if (kept >= chars.length) out += inner;
        else if (node.direction === 'R') out += chars.slice(chars.length - kept).join('');
        else out += chars.slice(0, kept).join('');
        break;
      }
      case 'repeat': {
        const count = evalNumber(node.count.length ? node.count : null, ctx, sc);
        out += applyRepeat(evalNodes(node.body, 0, ctx, sc, false), count, node.delineator);
        break;
      }
      case 'replace': {
        const search = evalNodes(node.search, 0, ctx, sc, false).trim();
        const replacement = evalNodes(node.replacement, 0, ctx, sc, false).trim();
        out += applyReplace(evalNodes(node.body, 0, ctx, sc, false), search, replacement);
        break;
      }
      case 'index': {
        const position = evalNumber(node.position.length ? node.position : null, ctx, sc);
        out += applyIndex(evalNodes(node.body, 0, ctx, sc, false), position);
        break;
      }
      case 'insert': {
        // Splices its content into the text AROUND it: the rest of this sequence is rendered here and
        // everything is returned together.
        const position = evalNumber(node.position.length ? node.position : null, ctx, sc);
        const inner = evalNodes(node.body, 0, ctx, sc, false);
        const after = evalNodes(nodes, n + 1, ctx, sc, false);
        return applyInsert(out, after, inner, position, node.drop);
      }
      case 'length':
        out += String(codePointLength(evalNodes(node.body, 0, ctx, sc, false).trim()));
        break;
      case 'wrap': {
        const inner = evalNodes(node.body, 0, ctx, sc, false);
        out += node.valid
          ? applyWordWrap(
              restoreWhitespaceTokens(inner),
              node.maxChars,
              node.minWraps,
              node.maxWraps,
              restoreWhitespaceTokens(node.delineator),
              node.hard,
            )
          : inner;
        break;
      }
      case 'while':
        out += evalWhile(node, ctx, sc);
        break;
      case 'variants':
        out += evalVariants(node, ctx, sc);
        break;
      case 'tags':
        out += evalTags(node, ctx, sc);
        break;
      case 'metafields':
        out += evalMetafields(node, ctx, sc);
        break;
      case 'foreach':
        out += evalForeach(node, ctx, sc);
        break;
    }
  }
  return out;
}

function evalMath(expr: Node[], ctx: Ctx, sc: Scope, numeric: boolean): string {
  const expression = evalNodes(expr, 0, ctx, sc, true);
  try {
    const value = evaluateMathExpression(expression);
    if (Number.isFinite(value)) return String(value);
  } catch (err: unknown) {
    // A bare (forgotten-braces) variable inside the equation shows a visible marker. In a numeric context
    // text can't appear, so it falls through to 0.
    const message = err && typeof (err as Error).message === 'string' ? (err as Error).message : '';
    if (!numeric && message.indexOf(UNRESOLVED_VARIABLE_ERROR_PREFIX) === 0) {
      return unresolvedVariableMarker(message.slice(UNRESOLVED_VARIABLE_ERROR_PREFIX.length));
    }
  }
  return numeric ? '0' : '';
}

// ---------------------------------------------------------------------------------------------
// Loops. All of them share one protocol: `ctx.ctl` is cleared before each iteration; if the iteration
// raised {{ skip }} or {{ break }} its whole output is discarded, and break also ends the loop. The
// signal is local to the iteration (the previous value is restored afterwards).
function evalWhile(node: Extract<Node, { k: 'while' }>, ctx: Ctx, sc: Scope): string {
  if (node.deprecated) {
    return deprecatedSyntaxMarker(
      'the old while form with a tag-bound counter (condition, comma, counter assignment) is ' +
        'retired -- write a hash-while token with just the boolean condition, and declare/' +
        'increment your own counter variable in the body instead',
    );
  }
  const saved = ctx.ctl;
  let out = '';
  for (let step = 0; step < MAX_WHILE_ITERATIONS; step++) {
    if (node.cond !== null && !condTrue(node.cond, ctx, sc)) break;
    ctx.ctl = 0;
    const rendered = evalNodes(node.body, 0, ctx, sc, false);
    const signal = signalOf(ctx);
    if (signal === 0) out += rendered;
    if (signal === 2) break;
  }
  ctx.ctl = saved;
  return out;
}

function evalVariants(node: Extract<Node, { k: 'variants' }>, ctx: Ctx, sc: Scope): string {
  const start = counterStart(node.start, ctx, sc);
  const prefix = node.deprecatedTied
    ? deprecatedSyntaxMarker(
        'the tied parameter no longer does anything -- a variant loop always follows the current ' +
          'variant selection now; remove it',
      )
    : '';
  const iterated = sc.variants && sc.variants.length > 0 ? sc.variants : sc.row.allVariants;
  if (!iterated || iterated.length === 0) {
    // No variants: the body renders once, with the counter at its start value.
    ctx.vars.set(node.name, String(start));
    return prefix + evalNodes(node.body, 0, ctx, sc, false);
  }
  const saved = ctx.ctl;
  let out = prefix;
  for (let index = 0; index < iterated.length; index++) {
    ctx.vars.set(node.name, String(index === 0 ? start : readVarNumber(ctx.vars, node.name) + 1));
    ctx.ctl = 0;
    const rendered = evalNodes(node.body, 0, ctx, { row: sc.row, variants: [iterated[index]] }, false);
    const signal = signalOf(ctx);
    if (signal === 0) out += rendered;
    if (signal === 2) break;
  }
  ctx.ctl = saved;
  return out;
}

function evalTags(node: Extract<Node, { k: 'tags' }>, ctx: Ctx, sc: Scope): string {
  const start = counterStart(node.start, ctx, sc);
  const tags = sc.row.tags || [];
  const saved = ctx.ctl;
  let out = '';
  for (let index = 0; index < tags.length; index++) {
    ctx.vars.set(node.name, String(index === 0 ? start : readVarNumber(ctx.vars, node.name) + 1));
    ctx.vars.set('tag', tags[index]);
    ctx.ctl = 0;
    const rendered = evalNodes(node.body, 0, ctx, sc, false);
    const signal = signalOf(ctx);
    if (signal === 0) out += rendered;
    if (signal === 2) break;
  }
  ctx.ctl = saved;
  return out;
}

function evalMetafields(node: Extract<Node, { k: 'metafields' }>, ctx: Ctx, sc: Scope): string {
  const start = counterStart(node.start, ctx, sc);
  const metafields = sc.row.metafields || [];
  const savedMetafield = ctx.currentMetafield;
  const saved = ctx.ctl;
  let out = '';
  for (let index = 0; index < metafields.length; index++) {
    ctx.vars.set(node.name, String(index === 0 ? start : readVarNumber(ctx.vars, node.name) + 1));
    ctx.currentMetafield = metafields[index];
    ctx.ctl = 0;
    const rendered = evalNodes(node.body, 0, ctx, sc, false);
    const signal = signalOf(ctx);
    if (signal === 0) out += rendered;
    if (signal === 2) break;
  }
  ctx.currentMetafield = savedMetafield;
  ctx.ctl = saved;
  return out;
}

// ---------------------------------------------------------------------------------------------
// Selection-scope loops (`selection.foreach` / `products.foreach` / `notes.foreach`).
export function foreachFullItems(kind: ForeachNode['kind'], env: RenderEnv): KindedRow[] {
  let list = env.items.get(kind);
  if (!list) {
    const notes = (): KindedRow[] => env.notes.map((n) => ({ row: noteToPseudoProduct(n), kind: 'note' as RowKind }));
    const rows = (): KindedRow[] => env.rows.map((row) => ({ row, kind: env.rowKind }));
    list = kind === 'notes' ? notes() : kind === 'object' ? [...rows(), ...notes()] : rows();
    env.items.set(kind, list);
  }
  return list;
}

// The (skip-filtered) list a foreach node iterates. Cached per plan.
export function foreachFilteredItems(node: ForeachNode, env: RenderEnv): KindedRow[] {
  let filtered = env.filtered.get(node);
  if (!filtered) {
    filtered = foreachSelection(foreachFullItems(node.kind, env), node.skipFirst, node.skipLast);
    env.filtered.set(node, filtered);
  }
  return filtered;
}

function evalForeach(node: ForeachNode, ctx: Ctx, sc: Scope): string {
  const env = ctx.env;
  const full = foreachFullItems(node.kind, env);
  const resolveRow = full[0]?.row ?? env.rows[0] ?? EMPTY_ROW;
  const startIndex = counterStart(node.start, ctx, scopeOf(resolveRow));
  const filtered = foreachFilteredItems(node, env);
  const win = ctx.window && ctx.window.node === node ? ctx.window : null;
  const from = win ? win.from : 0;
  const to = win ? win.to : filtered.length;

  const savedKind = ctx.currKind;
  const savedPrev = ctx.prev;
  const savedNext = ctx.next;
  const savedCtl = ctx.ctl;
  let out = node.deprecatedChunk
    ? deprecatedSyntaxMarker(
        'the i=START<MAX chunk-size syntax on a foreach tag is retired -- use this template’s ' +
          'Merge IF setting instead to control how objects are grouped into files',
      )
    : '';
  for (let idx = from, within = 0; idx < to; idx++, within++) {
    ctx.vars.set(node.name, String(within === 0 ? startIndex : readVarNumber(ctx.vars, node.name) + 1));
    const item = filtered[idx];
    ctx.currKind = item.kind;
    ctx.prev = idx > 0 ? filtered[idx - 1] : null;
    ctx.next = idx < filtered.length - 1 ? filtered[idx + 1] : null;
    ctx.ctl = 0;
    const rendered = evalNodes(node.body, 0, ctx, scopeOf(item.row), false);
    const signal = signalOf(ctx);
    if (signal === 0) out += rendered;
    if (signal === 2) break;
  }
  ctx.currKind = savedKind;
  ctx.prev = savedPrev;
  ctx.next = savedNext;
  ctx.ctl = savedCtl;
  return out;
}

// Merge IF: is this condition TRUE for this row? (FALSE for anything empty or malformed.)
export function evalConditionTrue(cond: Cond | null, ctx: Ctx, sc: Scope): boolean {
  return condTrue(cond, ctx, sc);
}

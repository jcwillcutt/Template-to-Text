// Engine data model: the parsed template tree, boolean-condition tree and the per-render context.
//
// A template is parsed ONCE into `Node[]` (see parse.ts) and then evaluated once per output file
// (see evaluate.ts). Nothing here depends on the product data, so a parsed template can be reused for
// every file in a download, and for every preview of the same template text.

import type { MetafieldData, ProductData, SelectionEntry, VariantData } from '../domain/types';

// What kind of thing a rendered row/unit is; exposed as {{ selection.curr/next/prev.type }}.
export type RowKind = 'product' | 'variant' | 'note';

// A row/unit paired with its kind -- what selection.next / selection.prev resolve against.
export interface KindedRow {
  row: ProductData;
  kind: RowKind;
}

// The product a token resolves against plus the ACTIVE variant list. Inside a variant loop the list is
// the single iterated variant, which is what `{{ variant.* }}` reads; `product.length` still reads the
// row's full variant list. A lightweight replacement for the legacy engine's per-iteration product clone.
export interface Scope {
  row: ProductData;
  variants: VariantData[];
}

export const scopeOf = (row: ProductData): Scope => ({ row, variants: row.variants });

// ---------------------------------------------------------------------------------------------
// Boolean conditions. Parsed STRUCTURALLY from the template text: the operators live in the static
// text, and every `{{ ... }}` token (or run of text) is an operand whose value is only looked up when
// the condition is evaluated. (The legacy engine substituted token values into the text first and
// then parsed the result, so a product title containing `&&`, `(` or `==` could change the meaning
// of a condition.)
export interface Operand {
  nodes: Node[];
  // Set when the operand is plain text with no tokens -- resolved once at parse time.
  constant: string | null;
  // Cached numeric/string reading of a constant operand (filled lazily by the evaluator).
  pre?: { num: number | null; str: string };
}

export type Cond =
  | { c: 'or' | 'and'; parts: Cond[] }
  | { c: 'not'; x: Cond }
  | { c: 'cmp'; op: '==' | '!=' | '<' | '>' | '<=' | '>='; l: Operand; r: Operand }
  | { c: 'truthy'; x: Operand }
  // A statically empty expression (`{{ #if= }}`, `a &&`): evaluating it throws, which every caller
  // treats as FALSE -- the legacy behavior.
  | { c: 'bad' };

// ---------------------------------------------------------------------------------------------
// Template nodes.
export interface FieldNode {
  k: 'field';
  resolve: (ctx: Ctx, sc: Scope) => string;
}

export interface IfNode {
  k: 'if';
  cond: Cond;
  // Raw condition text; parsed lazily as plain tokens only to echo the failing condition when it
  // contains an unresolved-variable marker.
  condText: string;
  then: Node[];
  otherwise: Node[] | null;
}

export interface ChopNode {
  k: 'chop';
  cond: Cond | null;
  direction: 'L' | 'R';
  counter: string;
  start: Node[] | null;
  body: Node[];
}

export interface RepeatNode {
  k: 'repeat';
  count: Node[];
  delineator: string;
  body: Node[];
}

export interface ReplaceNode {
  k: 'replace';
  search: Node[];
  replacement: Node[];
  body: Node[];
}

export interface IndexNode {
  k: 'index';
  position: Node[];
  body: Node[];
}

export interface InsertNode {
  k: 'insert';
  position: Node[];
  drop: boolean;
  body: Node[];
}

export interface WhileNode {
  k: 'while';
  // null = empty condition (always TRUE up to the safety cap).
  cond: Cond | null;
  // The retired bounded form: renders a marker instead of looping.
  deprecated: boolean;
  body: Node[];
}

export interface VariantLoopNode {
  k: 'variants';
  name: string;
  start: Node[] | null;
  deprecatedTied: boolean;
  body: Node[];
}

export interface TagsLoopNode {
  k: 'tags';
  name: string;
  start: Node[] | null;
  body: Node[];
}

export interface MetafieldsLoopNode {
  k: 'metafields';
  name: string;
  start: Node[] | null;
  body: Node[];
}

export interface LengthNode {
  k: 'length';
  body: Node[];
}

export interface WrapNode {
  k: 'wrap';
  valid: boolean;
  maxChars: number;
  minWraps: number;
  maxWraps: number;
  delineator: string;
  hard: boolean;
  body: Node[];
}

export type ForeachKind = 'rows' | 'notes' | 'object';

export interface ForeachNode {
  k: 'foreach';
  kind: ForeachKind;
  skipFirst: boolean;
  skipLast: boolean;
  name: string;
  start: Node[] | null;
  deprecatedChunk: boolean;
  body: Node[];
}

export type Node =
  | { k: 'text'; s: string }
  // `{{ }}`: renders '' (or '0' in a numeric context).
  | { k: 'empty' }
  | { k: 'math'; expr: Node[] }
  | { k: 'time'; fmt: Node[] }
  | { k: 'assign'; name: string; value: Node[] }
  | { k: 'bool'; cond: Cond }
  | FieldNode
  // `{{ break }}` (2) / `{{ skip }}` (1).
  | { k: 'ctl'; v: 1 | 2 }
  | IfNode
  | ChopNode
  | RepeatNode
  | ReplaceNode
  | IndexNode
  | InsertNode
  | WhileNode
  | VariantLoopNode
  | TagsLoopNode
  | MetafieldsLoopNode
  | LengthNode
  | WrapNode
  | ForeachNode;

// A parsed, ready-to-run template.
export interface Compiled {
  root: Node[];
  // The first selection-scope foreach in document order (the one the Merge IF condition partitions into
  // files), or null.
  firstForeach: ForeachNode | null;
}

// ---------------------------------------------------------------------------------------------
// Render context.

// Data that is the same for every file of one plan, shared by the per-file contexts.
export interface RenderEnv {
  // The variant-expanded rows (or the single unit row in per-unit modes): what `selection.first/last`
  // and selection-scope foreach loops iterate.
  rows: ProductData[];
  rowKind: RowKind;
  notes: SelectionEntry[];
  // Per-plan caches so a multi-file render doesn't rebuild the iterated lists for every file.
  items: Map<ForeachKind, KindedRow[]>;
  filtered: Map<ForeachNode, KindedRow[]>;
}

export interface Ctx {
  env: RenderEnv;
  // The shared, mutable variable store for ONE output file.
  vars: Map<string, string>;
  now: Date;
  primaryDomain: string;
  selectionLength: number;
  currKind: RowKind;
  prev: KindedRow | null;
  next: KindedRow | null;
  currentMetafield: MetafieldData | null;
  // {{ break }} / {{ skip }} raised in the current loop iteration: 0 none, 1 skip, 2 break.
  ctl: 0 | 1 | 2;
  // Set when an operand resolved to an unresolved-variable marker (see evaluate.ts / evalIf).
  sawMarker: boolean;
  // Window onto the first selection-scope foreach's items, when Merge IF split that list into files.
  window: { node: ForeachNode; from: number; to: number } | null;
}

// Editor menu snippets + the product/variant field catalogs that drive both the "Insert variable" menu and the
// {{ product.* }} / {{ variant.* }} resolvers. Verbatim from the legacy engine.

import type { ProductData, VariantData } from '../domain/types';

// ----------------------------------------------------------------------------------------------
// TEMPLATE ENGINE -- snippet catalog, date tokens, comment & whitespace passes
// The literal strings inserted by the editor's "Insert variable" / "Insert special" menus, plus
// the two pre-processing passes (stripComments, applyWhitespaceTokens/restoreWhitespaceTokens)
// that run before and after the token substitution pipeline further down.
// ----------------------------------------------------------------------------------------------
// Single source of truth for every plain (non-metafield) product field: its resolver key (matched
// in `{{ product.KEY }}`), the "Insert variable" menu label, any accepted alias key, and the
// resolver itself. PRODUCT_FIELD_TOKENS (the menu) and productFieldValue (the actual `{{
// product.* }}` resolver, further down) are both generated from this one list below, so a field can
// never exist in the menu without being resolvable, or be resolvable without appearing in the menu.
export interface ProductFieldDef {
  key: string;
  label: string;
  aliases?: string[];
  resolve: (product: ProductData) => string;
}

export const PRODUCT_FIELD_DEFS: ProductFieldDef[] = [
  { key: 'title', label: 'Product title', resolve: (p) => p.title },
  { key: 'handle', label: 'Product handle', resolve: (p) => p.handle },
  { key: 'vendor', label: 'Product vendor', resolve: (p) => p.vendor },
  {
    key: 'productType',
    label: 'Product type',
    aliases: ['product_type'],
    resolve: (p) => p.productType,
  },
  { key: 'status', label: 'Product status', resolve: (p) => p.status },
  { key: 'description', label: 'Product description', resolve: (p) => p.description },
  { key: 'tags', label: 'Product tags', resolve: (p) => p.tags.join(', ') },
  {
    key: 'totalInventory',
    label: 'Total inventory',
    resolve: (p) => (p.totalInventory == null ? '' : String(p.totalInventory)),
  },
  { key: 'priceMin', label: 'Min price', resolve: (p) => p.priceMin },
  { key: 'priceMax', label: 'Max price', resolve: (p) => p.priceMax },
  // Compare at price and cost per item live on the variant; at product level they resolve against
  // the row's ACTIVE variant (the product's first variant outside a variant loop).
  {
    key: 'compareAtPrice',
    label: 'Compare at price',
    resolve: (p) => p.variants[0]?.compareAtPrice || '',
  },
  { key: 'costPerItem', label: 'Cost per item', resolve: (p) => p.variants[0]?.costPerItem || '' },
  { key: 'currencyCode', label: 'Currency code', resolve: (p) => p.currencyCode },
  { key: 'createdAt', label: 'Created at', resolve: (p) => p.createdAt },
  { key: 'updatedAt', label: 'Updated at', resolve: (p) => p.updatedAt },
  // 'note' (singular) is the canonical key as of session 7, per explicit direction ("everything
  // should be note, like {{ product.note }}") -- 'notes' kept as an alias so any already-saved
  // template using the old {{ product.notes }} spelling keeps rendering unchanged.
  { key: 'note', label: 'Product note', aliases: ['notes'], resolve: (p) => p.note || '' },
];

export const PRODUCT_FIELD_TOKENS: { token: string; label: string }[] = PRODUCT_FIELD_DEFS.map((f) => ({
  token: `{{ product.${f.key} }}`,
  label: f.label,
}));

// Same idea for variant fields: VARIANT_FIELD_TOKENS and variantFieldValue are both generated from
// this one list.
export interface VariantFieldDef {
  key: string;
  label: string;
  resolve: (variant: VariantData) => string;
}

export const VARIANT_FIELD_DEFS: VariantFieldDef[] = [
  { key: 'title', label: 'Variant title', resolve: (v) => v.title },
  { key: 'sku', label: 'Variant SKU', resolve: (v) => v.sku || '' },
  { key: 'price', label: 'Variant price', resolve: (v) => v.price || '' },
  {
    key: 'compareAtPrice',
    label: 'Variant compare at price',
    resolve: (v) => v.compareAtPrice || '',
  },
  { key: 'costPerItem', label: 'Variant cost per item', resolve: (v) => v.costPerItem || '' },
  { key: 'barcode', label: 'Variant barcode', resolve: (v) => v.barcode || '' },
  {
    key: 'inventoryQuantity',
    label: 'Variant inventory',
    resolve: (v) => (v.inventoryQuantity == null ? '' : String(v.inventoryQuantity)),
  },
];

export const VARIANT_FIELD_TOKENS: { token: string; label: string }[] = VARIANT_FIELD_DEFS.map((f) => ({
  token: `{{ variant.${f.key} }}`,
  label: f.label,
}));

export const FOREACH_BLOCK =
  '{{#selection.foreach product, i=0}}\n{{ product.title }} , {{ product.handle }}\n{{/selection.foreach product}}';

// Snippet inserted by the "If block" menu option. The condition defaults to {{ =0 }} (which resolves
// to the number 0, i.e. FALSE) so the author can replace it with their own boolean expression.
export const IF_BLOCK = '{{ #if={{ =0 }} }}\n{{ /if }}';

// Snippet inserted by the "Chop block" menu option. Keeps the characters iterated over BEFORE the
// condition first becomes true; `direction` picks which end the walk starts from and `j` is the
// starting value of the step counter exposed as {{ j }} inside the condition.
export const CHOP_BLOCK = '{{ #chop={{ {{j}}==3 }}, direction=L, j=1 }}\n{{/chop}}';

// Snippet inserted by the "String length" menu option: renders the character count of its content.
// Block form (session 10) -- see LENGTH_OPEN_SOURCE's comment for why this replaced {{ length=... }}.
export const LENGTH_TOKEN = '{{ #length }}{{ product.title }}{{/length}}';

// Snippets inserted by the date/time menu options (session 9) -- see formatDateTime's comment for
// the full JungleDocs-style token table these format strings are written in.
export const DATE_TOKEN = '{{ time=MM/dd/yyyy }}';

export const TIME_TOKEN = '{{ time=h:mm tt }}';

export const DATE_TIME_TOKEN = '{{ time=MM/dd/yyyy h:mm tt }}';

export const WEEKDAY_DATE_TOKEN = '{{ time=dddd, MMMM d, yyyy }}';

// Snippet inserted by the "Repeat block" menu option: outputs its inner content N times, joined by
// the delineator (empty by default).
export const REPEAT_BLOCK = '{{ #repeat=2, delineator= }}\n{{/repeat}}';

// Snippet inserted by the "Replace block" menu option (session 13): substitutes every occurrence of
// SEARCH with REPLACEMENT in the rendered inner content.
export const REPLACE_BLOCK = '{{ #replace=SEARCH, replacement=REPLACEMENT }}\n{{/replace}}';

// Snippet inserted by the "While loop" menu option: a loop that re-tests a boolean condition every
// step (up to a hard MAX_WHILE_ITERATIONS safety cap) and does not step through the product
// selection. It MUST be closed with {{/while}}. This is the new, recommended `{{ #while=BOOL }}`
// form (session 6) -- no counter is bound by the tag itself; the example below declares and steps
// its own ordinary variable, exactly as any other counter would be. (The old
// `{{ while=BOOL, {{ k }} = MIN<MAX }}` form, with a tag-bound counter, still works for any
// already-saved template -- see WHILE_OPEN_SOURCE's comment.)
export const WHILE_BLOCK = '{{ x = 1 }}\n{{ #while={{x}}<5 }}\n{{ x = {{ ={{x}}+1 }} }}\n{{/while}}';

// Snippet inserted by the "Index" menu option: returns a single character of its inner content.
export const INDEX_BLOCK = '{{ #index=0 }}\n{{/index}}';

// Snippet inserted by the "Insert block" menu option: splices its inner content into the surrounding
// rendered output at a character position relative to the block.
export const INSERT_BLOCK = '{{ #insert=0, drop=FALSE }}\n{{/insert}}';

// Snippet inserted by the "Variant foreach" menu option: steps through the current product/row's
// variants. `variants.foreach` is the new, recommended spelling (session 6) -- the old
// `product.foreach` spelling (no label slot) still works forever as a plain alias. The label after
// `variants.foreach` (here `v`) is purely cosmetic, like `selection.foreach`'s trailing word -- the
// loop item is always read via the existing `{{ variant.* }}` tokens, not the label.
export const VARIANT_LOOP_BLOCK =
  '{{ #variants.foreach v, l=0 }}\n{{ variant.title }}\n{{/variants.foreach}}';

// Snippet inserted by the "Notes foreach" menu option (new, session 6): steps through the
// selection's free-standing notes. Every {{ product.* }}/{{ variant.* }} token except
// {{ product.note }} resolves to '' for a note, same rule as every other per-unit render of a note
// (see noteToPseudoProduct).
export const NOTES_LOOP_BLOCK = '{{ #notes.foreach note, i=0 }}\n{{ product.note }}\n{{/notes.foreach}}';

// Snippet inserted by the "Tags foreach" menu option (new, session 6): steps through the current
// product/row's tags. Each iteration's tag text is read via the fixed {{ tag }} token (not the
// label after `tags.foreach`, which is cosmetic, same as every other foreach source).
export const TAGS_LOOP_BLOCK = '{{ #tags.foreach tag, i=0 }}\n{{ tag }}\n{{/tags.foreach}}';

// Snippet inserted by the "Metafields foreach" menu option (new, session 10): steps through the
// current product/row's metafields. Each iteration's namespace/key/value are read via the fixed
// {{ mf.namespace }}/{{ mf.key }}/{{ mf.value }} tokens (not the label after `metafields.foreach`,
// which is cosmetic, same as every other foreach source).
export const METAFIELDS_LOOP_BLOCK =
  '{{ #metafields.foreach mf, i=0 }}\n{{ mf.namespace }}.{{ mf.key }}: {{ mf.value }}\n{{/metafields.foreach}}';

// Snippet inserted by the "Boolean equation" menu option.
export const BOOLEAN_TOKEN = '{{ TRUE != FALSE }}';

// Snippets inserted by the "Break" / "Skip" menu options (new, session 6) -- see BREAK_SENTINEL's
// comment for the full mechanism. Almost always used inside an if-block's branch, so the inserted
// snippet wraps one to be immediately useful rather than a bare token the author must wrap
// themselves.
export const BREAK_TOKEN_BLOCK = '{{ #if={{ =0 }} }}\n{{ break }}\n{{ /if }}';

export const SKIP_TOKEN_BLOCK = '{{ #if={{ =0 }} }}\n{{ skip }}\n{{ /if }}';

export const WRAP_BLOCK = '{{#wrap=80, min_wraps=0, max_wraps=0, hard=FALSE, delineator=}}\n{{/wrap}}';

export const COMMENT_BLOCK = '{{ #comment }}\n\n{{ /comment }}';

// The literal menu snippets inserted for the New line / Space options: `{{ /return }}` and
// `{{ /space }}`, the canonical spellings as of session 7.
export const NEWLINE_TOKEN_SNIPPET = '{{ /return }}';

export const SPACE_TOKEN_SNIPPET = '{{ /space }}';

// The variable names offered in the Variables menu, as convenient shortcuts -- variables are NOT
// limited to these seven. Any name that (a) contains no whitespace, (b) contains none of the
// characters listed above IDENTIFIER_REGEX (they're reserved by the surrounding token grammar), and
// (c) is not a protected tag keyword (RESERVED_ASSIGNMENT_NAMES) can be read with `{{ name }}`,
// written with `{{ name = VALUE }}`, and used as the counter of a foreach / variant foreach / chop /
// while block. A name starting with `$` (e.g. `$x`) never needs to be checked against (c) at all --
// see the `$`-sigil policy check next to RESERVED_ASSIGNMENT_NAMES.
export const VARIABLE_NAMES = ['i', 'j', 'k', 'l', 'x', 'y', 'z'];

// Snippet inserted by the "Assign variable" menu option.
export const ASSIGN_TOKEN = '{{ x = }}';

// Snippet inserted by the "Assign variable ($, collision-safe)" menu option (session 14, roadmap.md
// item 17): same shape as ASSIGN_TOKEN above, just with the guaranteed-collision-proof `$` sigil --
// see the module-load policy check next to RESERVED_ASSIGNMENT_NAMES for why this is safe forever.
export const ASSIGN_TOKEN_DOLLAR = '{{ $x = }}';

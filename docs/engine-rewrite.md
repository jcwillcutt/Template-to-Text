# Engine rewrite: what changed, what didn't, how it was verified

The template engine (everything that turns `{{ ... }}` text plus a product selection into files) was rewritten as a
**parse-once / evaluate-once** interpreter. Everything else (UI, storage) is unchanged and still lives in the one
shipped file; see `DEVELOPMENT.md` for how the modules are concatenated.

## Why

| Problem in the legacy engine | Effect |
|---|---|
| Rendering was ~6 whole-string passes **per output file**: `#if` resolution, then regex searches for ten block kinds, then token substitution, then selection-loop expansion, then wrap, then whitespace. Each pass re-scanned (and re-copied) the template text. | CPU and garbage proportional to *template size x number of files*. |
| `#if` blocks were resolved **before** anything else ran. | A condition could not see a variable assigned earlier, nor a loop counter of a `variants`/`tags`/`metafields`/`while` loop: **the reported bug**. |
| Selection loops were expanded textually **before** the rest of the template, and the expanded output was then rendered a second time. | Variables set before a loop were invisible inside it; note/product text containing `{{ }}` was evaluated as template code. |
| Boolean conditions were built by substituting values into the text and then parsing the result. | A product value containing `&&`, `(`, `==` could change a condition's meaning. |
| `partitionByMergeCondition` rebuilt the full row list for every neighbouring pair. | O(n^2) planning for Merge IF. |
| No resource limits. | A nested `while`, or `{{ #repeat=900000000 }}`, hangs or crashes the tab. |

## How it works now

```
template text ──► whitespace tokens, comments, globals (3 regexes, once)
              ──► parse ──► Node[]            (once per template text; cached)
Node[] + context ──► evaluate ──► string      (once per output file, one left-to-right pass)
```

* **Parse (`engine/parse.ts`)**: one scan of the text. Block tags are matched with a stack; a closer binds to the
  nearest opener of its kind, and anything that doesn't match (stray closer, `#else` outside an `#if`, unclosed
  opener) is kept as literal text, exactly as the legacy engine echoed it. Every tag parameter (`i=0`, `delineator=`,
  conditions, equations...) is parsed here too, so nothing is re-parsed per file or per loop iteration. Conditions
  become a small tree (`or / and / not / cmp / truthy`) whose operands are token sequences.
* **Evaluate (`engine/evaluate.ts`)**: a single recursive walk in document order against a per-file context
  (variables `Map`, loop signal, neighbours for `selection.prev/next`). No regexes, no string re-scanning. A product is
  not cloned per variant-loop iteration (a two-field `Scope` is used instead).
* **Plan (`engine/plan.ts`)**: same file-count / naming / zip / Merge IF logic as before, now on the new evaluator,
  with the per-plan iterated lists cached and the quadratic Merge IF row-list rebuild removed.
* **Guards**: at most 3,000,000 loop steps per output file (`while`, variants/tags/metafields, selection loops, chop
  steps) and 50M characters from one `repeat`; exceeding either throws `TemplateLimitError` with a plain-language
  message that the existing "could not be generated" banner shows. A single `while` still has its own 10,000-step cap.

## Performance (`npm run bench`, Node 22, same machine, medians)

| Scenario | Legacy | New | Speed-up |
|---|---:|---:|---:|
| Combined CSV, 4,000 products (loop + `#if` + math) | 184 ms | 18 ms | 10x |
| Combined, 1,000 products x 3 variants, nested variant loop | 152 ms | 5 ms | 30x |
| One file per variant, 4,000 files | 163 ms | 19 ms | 9x |
| One file per product, 1,000 files, 40-line template | 824 ms | 54 ms | 15x |
| `while` loop, 5,000 iterations | 174 ms | 16 ms | 11x (output differs by design: legacy mis-evaluated the `#if`) |
| Merge IF grouping, 1,500 products | 130 ms | 41 ms | 3x |
| replace / wrap / repeat / chop, 800 files | 123 ms | 9 ms | 14x |

Peak heap growth during a run is comparable: lower in the combined/loop scenarios (e.g. 15 MB -> 0 MB for the `while` case), slightly higher where one small context is built per output file (per-variant files 10 -> 16 MB, Merge IF 1 -> 9 MB), and never above 16 MB in any scenario here.

**Why this answers the "would a rewrite slow it down?" worry:** the legacy cost was re-scanning template text per
file; the new cost is one parse (cached across files *and* across preview re-renders of the same text) plus a tree
walk. Per-file cost no longer depends on how long the template text is, only on what actually executes
(`tests/engine/scaling.test.ts` pins both properties).

**On the old-Chrome crashes:** modern V8 handles the legacy engine at these sizes without trouble, so the engine alone
is unlikely to be the crash; older engines run the regex-heavy legacy passes several times slower and allocate far more
short-lived strings, which the rewrite removes. The engine is also now guarded against the two real ways it could
hang a tab (runaway loops / giant repeat) and `tests/build/compat.test.ts` keeps it free of post-ES2019 APIs. To
find the actual crash we need the Chrome version and the console error / "Aw, Snap" code; likely UI-side suspects
are the product table (rows render a text field and a checkbox per variant) and holding up to 3,000 cached products
with 100 variants x 50 metafields each. See `suggestions.md`.

## Compatibility: how it was verified

1. **Differential tests** against the real legacy engine (loaded from the untouched root file): 50 curated templates x
   5 file-break modes, Merge IF and globals, and random templates from a grammar restricted to constructs where the
   legacy engine is correct -- 2 x 1,500 per run in `npm test`; 3 seeds x 10,000 each were run as a soak (all
   identical). Compared per output file: content, name, count, zip name, source ids.
2. **Behaviour tests** with hand-written expected outputs for every feature, and the syntax guide's own examples.
3. **Totality property tests**: arbitrary strings (including binary) never crash parsing or rendering.

Things deliberately kept identical, quirks included: the retired-syntax markers, `trim`/`chop` alias, the `while=`
opener without `#`, label words after `.foreach`, `{{ #insert }}` splicing into the *surrounding* text (including
across the edges of an `#if` branch), sentinel-based whitespace tokens, delineator trimming, numeric reading of
`1.2.3` as `1.2`, the `selection.foreach` skip rule for single rows, and every file-naming rule.

## Intentional behaviour changes

Each is pinned in both directions in `tests/engine/differential.test.ts` ("intentional divergences") or
`reported-issues.test.ts`. None changes a template that behaved correctly before.

| # | Change | Legacy behaviour | New behaviour | Risk |
|---|---|---|---|---|
| 1 | `#if` is evaluated in document order | Condition saw stale variables / counters (the reported bug) | Sees current values | A template that *accidentally relied* on a stale value changes. Very unlikely; the old result was wrong. |
| 2 | Selection loops are evaluated in place | Expanded first: variables assigned before a loop were not visible inside it | Visible | Same reasoning. |
| 3 | Text is data | Note/product text containing `{{ ... }}` was re-evaluated inside selection loops (e.g. a note `hi {{ product.handle }}` rendered `hi product-1`) | Printed literally | A template that used notes as mini-templates. Tell me if that is a feature. |
| 4 | Conditions are parsed from the template, not from substituted values | `&&`, `||`, `(`, `==` inside a *value* changed the logic; `!` of an empty value was always FALSE | Values are values; `!` of empty is TRUE | Only affects values containing operator characters. |
| 5 | `{{ break }}` / `{{ skip }}` outside a loop | Left invisible U+0003/U+0004 characters in the file | Nothing | None. |
| 6 | Empty selection | `{{ product.x }}` with nothing selected threw (the UI blocks this case) | Renders blanks | None. |
| 7 | Nested/enclosed wrap | Wrap blocks were regex-matched on the output; nesting, or a wrap inside replace/repeat/index/length/chop, was mangled | Wrap nests and composes like every other block | None. |
| 8 | Limits | Hang / out-of-memory | `TemplateLimitError` | None. |
| 9 | Malformed crossing blocks | Undefined (depended on regex order) | Closer binds to the nearest opener of its kind; leftovers echoed | None. |
| 10 | `{{ product.constructor }}` etc. | Looked up `Object.prototype` | Empty | None. |

## Not done (and why)

* **UI fixes** (row click, double click, table overflow): unchanged in `src/ui/`; they need verification in a Shopify
  dev store. The designs are in `known-issues.md`.
* **Concurrent-save protection** (`compareDigest`): dropped per the owner's decision.
* **A second front-end syntax** (Liquid): see below.

## Liquid, evaluated

*"There is no library to pull."* There is: [`liquidjs`](https://github.com/harttle/liquidjs) (MIT, pure JS, no `eval`,
runs in the browser; 10.x browser bundle is **123 KB minified / 32 KB gzipped** -- measured). Shopify's own
`@shopify/liquid-html-parser` is a *parser/linter* only (no renderer). So a dependency does exist; the question is
whether it is the right trade:

| | Keep `{{ }}` language (now AST engine) | Switch to Liquid (liquidjs) |
|---|---|---|
| Existing templates | Work as saved | **All break** (`{{ #if=.. }}` vs `{% if %}`, `{{ x = 5 }}` vs `{% assign %}`); needs a migrator or a dual mode |
| Language docs / familiarity | Own syntax guide to maintain | Public docs, merchants may already know Liquid |
| Code you own | ~1,900 lines (parse, evaluate, fields, ast, plan; the whole engine is 3,500 lines vs 4,075 before) | ~300 lines of glue **plus** all file-splitting features still custom: file break, Merge IF, `selection.prev/next`, wrap/chop/insert tools (as filters/tags), whitespace sentinels, marker system |
| Bundle size | 0 | +123 KB min (+ the whole bundle must stay one file; check the Admin extension size limit, the file is already 382 KB source) |
| Speed | Measured above | liquidjs is a tree-walking interpreter with a similar profile (parse once, render many); not benchmarked here |
| Safety | Step budget and output caps now built in | liquidjs has `parseLimit` / `renderLimit` / `memoryLimit` options |

Recommendation: **don't swap the engine now.** The expensive part of the project is not parsing; it is the
file-splitting model, which Liquid does not provide. Because the new engine is a clean `Node[]` interpreter, a Liquid
*front-end* (a second parser that emits the same nodes: `{% if %}`->`if`, `{% for x in tags %}`->`tags`,
`{{ a | replace: .. }}`->`replace`) can be added later, selectable per template, without a dependency and with identical
speed. That gives merchants Liquid syntax *and* keeps every saved template working. If you want that, the work is
`parse-liquid.ts` (~400 lines) plus a per-template `syntax` field; none of the evaluator changes.

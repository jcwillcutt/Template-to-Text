# Development guide

The shipped artefact is **one file**. The repository keeps it as modules so it can be tested, and a build step
concatenates them. The original single-file sources in the repo root (`template-to-text.tsx`, `t2t2_bugs.tsx`,
`template-syntax-guide`, `Errors/`) are untouched and are used only as reference material and as the test oracle.

```
npm install
npm test            # unit + behaviour + differential + build tests (vitest)
npm run typecheck   # strict type-check of src/engine, src/domain, src/format, tests
npm run build       # writes dist/template-to-text.tsx  <- the single file to deploy
npm run bench       # old vs. new engine timings (add `-- legacy` for only the old one)
```

`dist/template-to-text.tsx` has **all comments and blank lines removed** (comments stay in `src/`), so its line numbers
are as small as possible; compiler errors from the host refer to that stripped file. Comments are found as syntax-tree
trivia, never by text matching, so strings, template literals (e.g. the syntax guide) and JSX text are untouched;
`tests/build/bundle.test.ts` proves the stripped file has the same syntax tree as the commented build.

## Layout

```
src/
  domain/types.ts            product / variant / template / selection data types
  storage/                   shop-metafield constants, GraphQL, JSON <-> typed data
  format/helpers.ts          slugify, sanitizeExtension, display helpers
  engine/                    the template engine (pure TypeScript, no UI, no Shopify)
    lexicon.ts  scan.ts      reserved words, identifier grammar, brace-aware scanning
    parse.ts                 text -> AST (parsed once; cached)
    ast.ts                   node / condition / context types
    evaluate.ts              AST + context -> text (one pass, document order, resource guards)
    fields.ts                {{ product.* }} / {{ variant.* }} / metafield / selection.* resolution
    math.ts  datetime.ts  wrap.ts  textops.ts  zip.ts  rows.ts  markers.ts
    plan.ts                  file planning: counts, names, Merge IF grouping, zip names
    templates-catalog.ts     editor menu snippets + field catalogs
    index.ts                 what the UI imports (test / typecheck entry; not shipped)
  ui/                        Extension.tsx (all views), syntax guide, search, formatting helpers
scripts/build.mjs            concatenates src/ -> dist/template-to-text.tsx
scripts/bench.ts             performance comparison
tests/                       see docs/testing.md
```

## The single-file rule

All modules share ONE scope in the bundle, so:

1. Use normal `import { x } from './y'` / `export function ...` while authoring; `scripts/build.mjs` strips relative
   imports and `export` modifiers, hoists/merges external imports (`preact`), and keeps the single
   `export default`.
2. **Top-level names must be unique across the whole project.** The build fails with the clashing name.
3. No `export { a, b }` or `export * from` (they can't be flattened safely) -- use inline `export`.
4. Order matters only for load-time constants; the order is the `ORDER` array in `scripts/build.mjs`. A new module
   must be added there (a test fails if a file in `src/` is neither listed nor the `engine/index.ts` entry point).
5. Don't import from `src/engine/index.ts` inside `src/` (it is not part of the bundle). Import the defining module.

`tests/build/bundle.test.ts` proves the output is a faithful single file: no leftover module syntax, only `preact`
imports, exactly one default export, every identifier resolves (the only free name is the Shopify `shopify` global),
and the engine inside the bundle renders identically to the one imported from `src/`.

## Adding a template feature

1. Parse it in `engine/parse.ts` (a new opener/closer pair in `OPENERS`/`CLOSERS`, a node type in `ast.ts`).
2. Evaluate it in `engine/evaluate.ts`. Loops must follow the loop protocol (`ctx.ctl`, `tick(ctx)` for the step
   budget).
3. If it introduces a keyword, add it to `RESERVED_ASSIGNMENT_NAMES` and `RESERVED_KEYWORDS_IN_USE`
   (`engine/lexicon.ts`); `tests/engine/lexicon.test.ts` checks the pair stays consistent.
4. Add behaviour tests (`tests/engine/*.test.ts`), the syntax-guide entry (`template-syntax-guide` is legacy; the
   in-app copy is `src/ui/syntax-guide.tsx`), and a case in the generator (`tests/helpers/template-gen.ts`) if the
   legacy engine had the feature.

## Compatibility

`tests/build/compat.test.ts` keeps the engine to ES2019-level APIs (no `.at()`, `replaceAll`, `structuredClone`,
lookbehind, logical assignment, ...) because older Chrome versions are in use.

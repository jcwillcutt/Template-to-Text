# Template to Text: suggestions (UI, structure, code)

Companion to `known-issues.md` (the four owner-reported bugs, with root causes). This file is everything else, ranked by value for effort.
Priority: **P0** do now · **P1** next · **P2** when convenient. Effort: S (<½ day) · M (1-2 days) · L (week+).

What I could and couldn't verify: I ran the template engine headlessly in Node (the engine functions are pure; `docs/repro/build-and-run.sh` stubs `preact`). I **could not** run the UI (needs Shopify admin), and shopify.dev was unreachable, so Polaris prop names are marked **[verify]**.

---

## 0. Orientation: what the app is

- One file, `template-to-text.tsx` (9.6k lines, 450 KB): Admin UI extension in Preact using Polaris `s-*` web components.
- ~4.5k lines of template engine (`{{ }}` language: variables, math, `#if`, loops, replace/chop/wrap…), ~1k lines of storage/parsing, a 450-line syntax guide embedded as JSX, and a ~4k-line `Extension()` component holding all state and all five views (main, editor, selection, settings, globals) plus History.
- Storage: **unstructured shop metafields** (no definition), JSON. Templates sharded over 10 metafields, 6 public selection slots, globals, history log. Keep it that way (see known-issues, terminology note).
- The repo has no `package.json`, `tsconfig`, `shopify.app.toml`, extension config, tests, or CI. The root has a stale copy (`t2t2_bugs.tsx`) and the README is two lines.

---

## 1. UI suggestions

| # | Pri | Eff | Suggestion |
|---|-----|-----|-----------|
| U1 | P0 | M | **Fix product table overflow** (known-issues §1): slim the Product cell, move note + variant checkboxes out of the cell, declare `listSlot`s, make the 2fr/1fr page grid responsive. Delete the blank-`<s-text>` alignment hack (`:8945-8983`). |
| U2 | P0 | S | **Whole-row click selection with hover** for products, templates, selection rows (known-issues §2). |
| U3 | P0 | S | **Double-click template → editor**; Enter key parity (known-issues §3). |
| U4 | P1 | S | **Primary action on the template row.** The main flow is *pick template → Download/Preview*. Add a visible "Edit" affordance next to `⋯` (the editor is only reachable through a 3-item menu today) so double-click isn't the only discoverable path. |
| U5 | P1 | S | **Selected-count + sticky action bar.** Show "N products · M notes selected" with Clear / Review selection / Download next to the template list so the user never scrolls to find the action. |
| U6 | P1 | M | **Select across pages.** Selection already persists across pages; make that visible ("12 selected on other pages") and add "Select all matching search" (currently bulk buttons only act on the current page, `:6578-6600`). Cap at `SELECTION_MAX_PRODUCTS` (4000) with a clear message. |
| U7 | P1 | S | **Search UX.** Search applies on submit (`handleSearch`); add debounce-as-you-type, a clear (×) button, and a visible "searching metafields client-side only searches loaded products" note, since metafield search silently only covers the cache (`LOADED_PRODUCTS_CACHE_LIMIT = 3000`). |
| U8 | P1 | M | **Editor: live preview beside the editor** (side-by-side at wide widths), line numbers / error list. Errors are currently inline markers like `[[ unresolved variable … ]]` in output; add an "Issues" list above the preview that collects them with the token that caused them. |
| U9 | P1 | S | **Editor: validate before save.** Warn on unbalanced `{{`/`}}`, unclosed blocks, unknown/retired tokens (`{{ \n }}`, `{{ length= }}`, `{{ day }}` …) with the migration hint. The retired-syntax markers exist at render time; surface them at edit time. |
| U10 | P2 | S | **Template list niceties:** show file-break mode as a small badge, "last used" / "duplicate template" action, drag to reorder pinned. Sorting menu exists (`template-sort-menu`). |
| U11 | P2 | S | **Empty / loading states:** replace bare `<s-spinner>` with skeleton rows; "No templates yet" should link to starter templates (CSV per-product, packing slip, combined sheet) seeded from the syntax guide examples. |
| U12 | P2 | M | **Selection view:** inline-edit notes, bulk "remove checked", drag-reorder instead of up/down arrows ("Order" column). Same overflow caution as U1 (6 columns: Use/Item/Handle/Qty/Note/Order/Remove, `:8491-8631`). |
| U13 | P2 | S | **Consistent confirmations:** download confirm modal, delete modal, and the several error banners use three different patterns; use one toast/banner helper. |
| U14 | P2 | M | **Syntax guide:** make it searchable and add copy buttons on every example. It's 450 lines of hand-written JSX that duplicates `template-syntax-guide` (see C5). |

---

## 2. Structure suggestions

| # | Pri | Eff | Suggestion |
|---|-----|-----|-----------|
| S1 | P0 | S | **Add project scaffolding**: `package.json`, `tsconfig.json` (strict), ESLint + Prettier, and the Shopify app/extension config (`shopify.app.toml`, `shopify.extension.toml`) so the project builds and deploys from the repo. Today the repo is a loose source file; reviewers can't compile or test it. |
| S2 | P0 | S | **Delete `t2t2_bugs.tsx`** (stale 7.2k-line copy, differs from the main file in ~2.7k diff lines) and move `Errors/` into `tests/fixtures/`. Two near-identical giant files invites editing the wrong one. |
| S3 | P0 | M | **Extract the template engine into its own module(s) and test it.** It is pure TypeScript (I ran it in Node unchanged). Suggested layout:
```
src/
  engine/        tokens.ts  vars.ts  math.ts  boolean.ts  blocks/{if,loops,text}.ts  render.ts  plan.ts  zip.ts
  storage/       templates.ts  selections.ts  globals.ts  history.ts  graphql.ts
  ui/            MainView  EditorView  SelectionView  SettingsView  GlobalsView  HistoryView  SyntaxGuide  hooks/
  index.tsx
tests/engine/*.test.ts   tests/fixtures/*
```
Why first: every bug in known-issues §4 was found *and* fixed only by running the engine; the file header itself says two items were "deliberately left open … with no compiler/test harness available to verify a change against". A test suite removes that blocker. |
| S4 | P1 | M | **Split `Extension()`** (~4k lines, one component, 100+ `useState`/handlers) into per-view components plus hooks: `useTemplates` (read/mutate/write with shard handling), `useProducts` (query, paging, cache), `useSelection` (current + 6 public slots, notes, variant subsets), `useDownloads`, `useHistory`. The in-code comment says state is "read across view boundaries"; that is what a context/store solves (a small `useReducer` + context, or `@preact/signals`). |
| S5 | P1 | S | **Move the changelog out of source.** ~Hundreds of lines of "session N BUG FIXED…" narrative comments (e.g. `:3435-3457`, `:3580-3609`, `:1-28`) sit above the code they describe. Keep one-line "why" comments; move history to `CHANGELOG.md`/commit messages. The header also references `Documentation/Claude Docs/architecture-notes.md`, which isn't in the repo; either add it or drop the reference. |
| S6 | P1 | S | **Rewrite the README** (what it is, install/dev/deploy, storage model, how to run engine tests, link to syntax guide). |
| S7 | P2 | S | Add CI: typecheck, lint, engine tests on every PR. |
| S8 | P2 | S | Single source of truth for the syntax guide (see C5). |

---

## 3. Storage & data suggestions

Storage choice is right for the stated requirement (definition-less shop metafields readable by all staff). Hardening:

| # | Pri | Eff | Suggestion |
|---|-----|-----|-----------|
| D1 | P1 | M | **Optimistic concurrency.** `mutateTemplateList` (`:6100`) re-reads then writes all 10 shards in one `metafieldsSet`, which narrows but doesn't close the race when two staff save at once (last writer wins, silently dropping the other's template). `metafieldsSet` accepts `compareDigest` per metafield **[verify on current API version]**; read each shard's digest, send it back, retry on `STALE_OBJECT`. |
| D2 | P1 | S | **Write only changed shards.** Today every save rewrites all 10 (to clear stale ones). Diff against what was read and write only shards whose JSON changed, plus clear removed ones. Smaller payloads, fewer conflicts. |
| D3 | P1 | M | **Schema version field** in each shard / templates JSON (`{v:2, templates:[…]}`) instead of inferring from missing fields (`fileBreak: null`, `pinnedAt: null`, legacy `sidekick.templates`). Makes future migrations explicit and testable. |
| D4 | P1 | S | **Export / import templates as JSON** (backup and move between shops) given the ~1.2 MB hard cap and no other recovery path. Also warn at ~80% capacity, not only at overflow. |
| D5 | P2 | S | **History log cap** (`HISTORY_SAFE_BYTES` 120 KB, 4000 entries) is a single metafield rewritten on every download; batch writes or coalesce within a session. |
| D6 | P2 | S | Products query fetches `variants(first: 100)` and `metafields(first: 50)` for **every** product on **every** page (`:190-234`). Products with >100 variants or >50 metafields are silently truncated; paging 25 at a time with that nesting is query-cost heavy. Fetch the heavy fields lazily for selected products only (the code already refetches by id in chunks of 50 for selections) and add a visible truncation warning. |

---

## 4. Code suggestions (template engine and app)

| # | Pri | Eff | Suggestion |
|---|-----|-----|-----------|
| C1 | P0 | S | **Apply `docs/patches/lazy-if-evaluation.patch`** (known-issues §4), then delete `applyIfBlocks`. Add the 8 cases in `docs/repro/if_cases.js` as permanent tests. |
| C2 | P1 | M | **One evaluation model.** Today the engine is several passes (if-blocks → block finder → plain tokens → wrap → whitespace restore) with sentinels (`BREAK_SENTINEL`, whitespace sentinels) and per-block re-scans, which is exactly where the `#if` ordering bug came from. Move to *parse once into an AST* (text | token | block{kind, params, children, else}) and *evaluate once* in document order against `ctx`. This also deletes `enclosingTokenEnd`, `findNextRenderBlock`'s ten `find*Block` regex scans, and the O(n²) re-scan the file header admits to. Do after S3 so tests guard the rewrite. |
| C3 | P1 | M | **Unify the two boolean grammars** (the file header calls this out as left open): `evaluateBooleanExpression` (for `#if`/`while`/`chop`) and the `{{ A == B }}` token path (`hasBooleanOperator`, `:2183`) share semantics but not code. Single parser, one set of operators, and the same visible-error behaviour. |
| C4 | P1 | S | **Typed variable values.** `ctx.vars` is `Record<string,string>`; numbers round-trip through strings (`String(value)` → `parseFloat`), and truthiness is `'0'/'false'` string matching. Store `string | number | boolean` and compare by type. Also makes `<`/`>` on non-numbers a defined behaviour (currently silently FALSE). |
| C5 | P1 | S | **Generate the syntax guide once.** The same text exists in `template-syntax-guide` (18 KB) and as JSX in the component (`:5211-5660`); they already differ in details. Keep one structured source (markdown or data) and render both. |
| C6 | P1 | S | **Add `{{ #elseif=COND }}`** and `!`-prefixed/word aliases (`and`/`or`/`not`) for readability. Chains are currently only expressible by nesting. |
| C7 | P1 | S | **Error surfacing.** Failures render inline `[[ … ]]` markers into the file. Keep them, but also return structured diagnostics from the engine (`{ message, tokenStart, tokenEnd }[]`) so the editor can show/jump to them (U8/U9) and Download can refuse to write a file containing markers without confirmation. |
| C8 | P1 | S | **Don't swallow errors.** Several `try { … } catch { return '' }` paths (e.g. math at `:2108`, boolean token at `:2175`, `applyIfBlocks` `:3553`) turn real mistakes into silent empty output, the same failure class as the original `#if` regex bug. Prefer a diagnostic. |
| C9 | P2 | M | **Performance guards.** `while` has a 10,000-step cap but nested loops multiply it; add a total-steps budget and output-size cap per file so a bad template can't freeze the admin tab. |
| C10 | P2 | S | **Reserved words.** `RESERVED_ASSIGNMENT_NAMES` / `RESERVED_KEYWORDS_IN_USE` are hand-maintained in parallel with the tag regexes (acknowledged in the code at `:1864`). Derive them from one `BLOCK_REGISTRY`; the `$name` collision-safe form is a good escape hatch to keep. |
| C11 | P2 | S | Strict TS: `any` is used throughout event handlers (`(e: any)`) and GraphQL results; add types for the GraphQL responses (generate from the Admin API schema) and Polaris event targets. |
| C12 | P2 | S | **Accessibility pass**: labels on all icon buttons exist (good); add keyboard handling for row-click (U2) and announce selection count changes. |

---

## 5. Suggested order of work

1. Apply the `#if` patch; add S1 scaffolding + S2 cleanup + C1 tests (all small, unblock everything).
2. U1 / U2 / U3 (the owner's UI bugs) - they touch the same two tables, so do them together.
3. S3 engine extraction + test suite, then C2/C3 (AST + single boolean grammar) behind those tests.
4. D1-D4 storage hardening.
5. S4 split `Extension()`; remaining UI polish.

## 6. Open questions for the owner

- Should whole-row click on a product *toggle* selection (click again to deselect) or only select? (Proposed: toggle.)
- Should double-click on a template also work on touch (two taps)? The timer approach handles it.
- OK to deprecate `{{ \n }}` sample in `Errors/if_math_error`, or should it be auto-migrated to `{{ /return }}` on load?
- Is there a build/deploy config outside this repo (`shopify.app.toml`, scopes)? Needed to confirm which API version and scopes `metafieldsSet`/`compareDigest` run under.

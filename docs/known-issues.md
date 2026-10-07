# Known issues (reported by the app owner)

Status key: **Verified** = reproduced by running the code; **Diagnosed** = root cause read from the code, not run (the UI can't run outside Shopify admin); **Fix ready** = a tested patch exists in this repo.

The source is a single Admin UI extension: `template-to-text.tsx` (Preact + Polaris `s-*` web components).
Line numbers below refer to commit `571da09`.

Docs on shopify.dev were unreachable from the sandbox this review ran in (egress blocked), so any claim below about a Polaris component's props is from memory and marked **[verify]**.

---

## 1. Product list text always overflows; user must scroll right to see Handle / Qty

**Status:** Diagnosed (UI), fix proposed.

**Where:** main view, product table, `template-to-text.tsx:8854-8989`, inside a `2fr 1fr` grid (`:8729`).

**Likely cause.** Several things stack up in the narrow left column:
- The *Product* cell holds thumbnail + title + (when selected) a full-width note text field + a checkbox per variant (`:8896-8944`). A text field has a large intrinsic min-width, so the cell, and therefore the table, can't shrink.
- *Handle* and *Qty* are plain columns after it. Once the table is wider than its container, `s-table` scrolls horizontally and they fall off the right edge.
- The table has `listSlot="primary"` on Product only; no other header declares a `listSlot`, so the component has no instruction for how to collapse into its stacked list layout when narrow. **[verify]** The "newest update" the owner noticed is probably a change in how `s-table` decides between table and list presentation (`variant` default, container-width breakpoint).
- `:8945-8951` aligns Handle/Qty with the Product cell by padding them with blank `<s-text> </s-text>` lines to mimic the height of the note/variant stack. That is brittle and adds height, but doesn't cause the width problem.

**Proposed fix (in order of preference):**
1. **Take the note field and variant checkboxes out of the table cell.** Render them in a detail row/panel under the selected product (or in the Selection view, which already has a note column). The Product cell then contains only thumbnail + title and can ellipsize, and the blank-spacer hack disappears.
2. **Give every header a `listSlot`** so narrow layouts degrade gracefully: Product `primary`, Handle `secondary`, Qty `inline` **[verify slot names against the current `s-table` reference]**, and/or set `variant="list"` explicitly for this narrow column instead of relying on `auto`.
3. **Make the page grid responsive** instead of a fixed `2fr 1fr` (`:8729`): stack Templates under Products below a container width, e.g. `gridTemplateColumns="@container (inline-size > 900px) 2fr 1fr, 1fr"` **[verify container-query syntax]**.
4. Truncate long handles (`s-text` with a max inline size / `truncate`-style prop **[verify]**) so one long handle can't widen everything.

Do (1)+(2) first; (3) is a cheap safety net.

---

## 2. Clicking anywhere in a product or template row should select it (with hover highlight); title link still navigates

**Status:** Diagnosed, fix proposed. Not yet implemented.

**Today.** Products: only the small `s-checkbox` (`:8890`) toggles selection. Templates: only the `s-clickable` wrapping the title text selects (`:9111-9121`), so the empty space and the `.ext` badge area of the row do nothing. Selected template has `background="subdued"`, but there is no hover state.

**Proposed fix.**
- **Products.** Put the click handler on the row. Two options:
  - `s-table-row` `clickDelegate={checkboxId}` **[verify: believed to exist; delegates row clicks to the element with that id and gives the row hover styling natively]**. Give each checkbox a stable `id={`sel-${p.id}`}`.
  - Fallback: `onClick` on `s-table-row`, ignoring clicks that began on interactive children:
    ```ts
    const onRowClick = (e: any, p: ProductData) => {
      if (e.target.closest?.('s-link, s-checkbox, s-text-field, s-button, a, input')) return;
      toggleProduct(p, !selectedProducts[p.id]);
    };
    ```
    Keep the existing "ignore a change that reports the current state" guard in `toggleProduct` (`:6499`); it already protects against echo loops.
- **Title link** keeps `href` + `target="_blank"`; the `closest('s-link')` check above is what stops it from also toggling.
- **Templates.** Make the whole row the click target: move `onClick` from the inner `s-clickable` onto an `s-clickable` that wraps the entire `s-grid` (row), and leave only the `⋯` menu button outside the clickable (or `stopPropagation` on it).
- **Hover highlight.** Admin UI extensions can't ship CSS. Options: native row hover from `clickDelegate` **[verify]**; for the template list use `s-clickable`'s own hover styling **[verify]**, or track `hoveredId` via `onMouseEnter/onMouseLeave` and set `background="subdued"` (selected) vs a lighter token for hover. A tiny `useHover(id)` helper is enough.
- Apply the same row-click behaviour to the Selection view table (`:8503-8626`), where rows currently have a "Use" checkbox.
- Accessibility: whole-row click must stay reachable by keyboard; keep the checkbox as the focusable control and don't remove its `accessibilityLabel`.

---

## 3. Rapid double-click on a template should open the editor

**Status:** Diagnosed, fix proposed. Not yet implemented.

**Today.** `onClick={() => setSelectedTemplateId(tpl.id)}` (`:9113`); `openEditTemplate` (`:6690`) is only reachable from the `⋯` menu. There is no double-click handling anywhere (`grep dblclick` finds nothing).

**Why not just `onDoubleClick`.** The first click sets state and re-renders the list (the selected row's `background`/`type` change), and web-component wrappers don't always forward `dblclick` **[verify]**. Detecting the pair yourself is more robust:

```ts
const lastTplClick = useRef<{ id: string; t: number } | null>(null);
const onTemplateClick = (tpl: TemplateData) => {
  const now = Date.now();
  const last = lastTplClick.current;
  lastTplClick.current = { id: tpl.id, t: now };
  if (last && last.id === tpl.id && now - last.t < 350) {
    lastTplClick.current = null;
    openEditTemplate(tpl);
    return;
  }
  setSelectedTemplateId(tpl.id);
};
```
- A `ref`, not state, so the second click sees the first click's timestamp even if the re-render hasn't flushed.
- Make sure `openEditTemplate` switches `view` to `'editor'` itself (check `:6690-6705`); the double-click must not leave the user on the main view.
- Add keyboard parity: `Enter` on a focused/selected template opens the editor.

---

## 4. `{{ #if }}` can't use values derived from variables or equations

**Status:** **Verified**, **Fix ready** (`docs/patches/lazy-if-evaluation.patch`).

### Reproduce
```
docs/repro/build-and-run.sh        # needs tsc + node; no Shopify required
```
On current code, 7 of 8 cases fail:
```
FAIL  var in condition              "small"   expected "big"        {{ x = 5 }}{{ #if={{ x }} > 3 }}…
FAIL  equation of var               "no"      expected "yes"        {{ x = 5 }}{{ #if={{ = {{x}}*2 }} == 10 }}…
FAIL  var derived from product, foreach   "--A-"  expected "-A-A"   (reads the PREVIOUS product's value)
FAIL  running total                 "[0][1][3][6!]" expected "[0][1][3!][6!]"
FAIL  while counter                 "0123"    expected "01[two]3"
PASS  foreach counter (always worked)
```
Loop counters of `selection.foreach` work only because `expandForeachBlocks` substitutes `i` into the text *before* rendering; any variable set with `{{ x = … }}` does not.

### Root cause
`renderTokens` (`:3638`) begins with `const withIf = applyIfBlocks(text, …)` - it resolves **every** `#if` block in the text up front, before the single document-order scanner (`renderTemplateText`) has executed any `{{ x = … }}` assignment in that text. So a condition reading `{{ x }}` sees the value left over from the previous pass (empty on first use, last iteration's value inside loops). Equations fail for the same reason because the variable inside `{{ = {{x}}*2 }}` is stale. The code's own doc comment says tokens "are evaluated in document order"; `#if` is the one construct that breaks that rule.

### Fix
Remove the up-front pass and treat `#if` as one more block kind inside the `renderTokens` dispatch loop: render the plain text before the `#if` first (running assignments), *then* evaluate the condition against the live `ctx.vars`, then render only the chosen branch recursively (so assignments inside a branch also run in order). It reuses the existing `findIfBlock`, `enclosingTokenEnd`, and unresolved-variable marker logic. See the patch (~35 lines). After the patch all 8 cases pass, plus these extra cases which also pass: variable set inside an earlier `#if`; `#if` nested inside an assignment value; condition built from a `#replace` result.

Follow-ups once the patch is in: delete the now-unused `applyIfBlocks` (`:3518`) and fix the comments that reference it (`:2100, 2145, 2247, 2256, 2265, 2320, 3605`).

### Related, from the same investigation
- **`Errors/if_math_error` uses `{{ \n }}`**, which is a retired token (the engine renders `[[ deprecated syntax removed … use the /return token ]]`). That sample template should use `{{ /return }}`. Aside from that, its `{{ #if={{ = {{ i }}%4 }} == 0 }}` condition works on current code (it's a foreach counter). The saved CSV in `Errors/` is old output from before session 6's regex fix, where whole `#if` blocks were echoed verbatim; it should be turned into a regression fixture (see suggestions).
- No `{{ #elseif }}`; chains require nesting.
- `<`, `>`, `<=`, `>=` between non-numeric strings silently return FALSE; `==` falls back to string equality. Consider a visible marker (as for unresolved variables) or a documented lexicographic comparison.
- Variables are stored as strings (`ctx.vars: Record<string,string>`), so `{{ #if={{ x }} }}` truthiness relies on string heuristics (`'0'`, `'false'`).

---

## Terminology note on storage ("unstructured metaobjects")

Metaobjects always require a **definition** (a schema), so a metaobject can't be "unstructured". The *unstructured* storage primitive in Shopify is a **metafield without a definition**, and that is what the app already does: templates are JSON in up to 10 shop-owned metafields `template_to_text.template_0..9` (`:156-169`, written at `:6068-6082`), selections and globals likewise. This is consistent with the requirement that all staff can read templates regardless of metaobject permissions, so **don't migrate templates to metaobjects**. See `docs/suggestions.md` §3 for storage hardening.

---

## Status update

* **#4 (`#if` with variables/equations): fixed in the new engine** (`src/engine/`, shipped via `dist/template-to-text.tsx`).
  Reproduction, tests and the cause are in `tests/engine/reported-issues.test.ts` and `docs/engine-rewrite.md`.
  The old patch (`docs/patches/lazy-if-evaluation.patch`) is kept for reference; it targets the legacy file, which is
  untouched.
* **#1-#3 implemented in `src/ui/Extension.tsx`** (unverified in a live Shopify admin; pure logic is unit-tested, the
  wiring is pinned by `tests/ui/wiring.test.ts`):
  * **#1 overflow:** the main product list is now a stack of rows (title, handle, note and variants in one flexible
    column; quantity in its own) instead of a 4-column `s-table`; pager above and below.
  * **#2 row click + hover:** clicking anywhere on a product row or a template row selects it, with a `subdued`
    background on hover; the title link, checkbox, note field and variant checkboxes keep their own behaviour.
  * **#3 double click:** two clicks on the same template within 400 ms open the editor (ref-tracked, so rapid clicks
    are caught). The `...` menu buttons are excluded.
  * Not changed: the Selection view's table (Use/Item/Handle/Qty/Note/Order/Remove) may overflow the same way and has
    no row click.

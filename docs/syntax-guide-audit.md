# Syntax-guide audit

Every worked example in `template-syntax-guide` was run (`tests/engine/syntax-guide.test.ts`) on both the legacy and
the new engine. **23 of the 28 examples hold exactly as written.** The 5 below don't -- on either engine -- so the
guide (and its in-app copy in `src/ui/syntax-guide.tsx`) is what is wrong, not the engine. Behaviour was deliberately
*not* changed to match the text, because saved templates may rely on it.

| § | Guide says | Actually happens | Suggested guide fix |
|---|---|---|---|
| 6 | `{{ product.vendor == Acme Co }}` is a valid condition | A bare field name inside an expression is just text: it compares the words `product.vendor` and `Acme Co` -> `FALSE`. | Show `{{ {{ product.vendor }} == Acme Co }}` and say fields must be wrapped in their own `{{ }}` inside expressions (same rule the guide already states for variables in equations). |
| 9 Repeat | `{{ #repeat=3, delineator=; }}{{ product.sku }}{{/repeat}}` -> `SKU1;SKU1;SKU1` | `product.sku` is not a field (SKU is per-variant): result is `;;`. | Use `{{ variant.sku }}`. |
| 9 Replace | `Was ${{ product.price }} now ${{ product.compareAtPrice }}!` | `product.price` is not a field (use `variant.price`, or `product.priceMin`). | Use `variant.price`. |
| 9 Wrap | `{{#wrap=10, ...delineator={{ /return }}}}` on "The Best New Product" -> `The Best New / Product` | Width 10 breaks before "New": `The Best` / `New` / `Product`. | Fix the sample output (or use width 12). |
| 9 Wrap | `delineator= / ` -> `The Best /New /Product//` | Typed spaces around a delineator are **trimmed**: result is `The Best/New/Product/`. | Say so, and show `delineator={{ /space }}/{{ /space }}` for a padded separator. |

## Ambiguities worth documenting (behaviour is correct, text is silent)

* A `{{ #repeat=N }}` count that is not a whole number >= 1 renders nothing; `N=1` renders the content once.
* `{{ #index=N }}`, `{{ #insert=N }}`, `{{ #length }}` count **characters (code points)**, not UTF-16 units, so emoji count as one.
* `{{ #wrap }}` parameters cannot contain `}`; a delineator that needs a token must use `{{ /return }}`/`{{ /space }}`,
  which are substituted before the tag is read. Wrap blocks nest properly in the new engine (the old one matched the
  first closing tag).
* `{{ #if }}` conditions see variables **as of that point in the template** -- the guide's "document order" promise
  (§5) now holds for conditions too (previously it did not; see `engine-rewrite.md`).
* `!` in front of an empty value is TRUE (so `{{ #if=!{{ product.note }} }}` means "has no note").
* Unknown field names (`{{ product.nope }}`) render empty, deliberately; a *retired* token renders a visible
  `[[ deprecated syntax removed -- ... ]]` marker instead.
* Inside a loop, `{{ break }}`/`{{ skip }}` discard the **whole** iteration's output (text before the tag too), not just
  what follows it.

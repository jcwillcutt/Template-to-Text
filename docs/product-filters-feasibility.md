# Feasibility: a Shopify-style "Add filter" menu for the product search

**Status: discussion only. Nothing here is built.** The goal: a dropdown of filter types (collection, vendor,
product type, tag, status, metafields ...). Choosing a type reveals its possible values; ticking values applies the
filter, like the filters bar on Shopify's own Products page.

## Short answer

Feasible for most filter types, in stages. The cheap, reliable part is **collection, vendor, product type, tag and
status**. **Metafields** are the hard part, for reasons that come from Shopify, not from this app. A first version
that covers the reliable types is about 2-3 days of work; metafields are a separate, optional second step.

## How it would work (design that fits what exists)

Filters would not be a second search system. Each ticked value is **written into the search box as query text**, the
same way a pasted spreadsheet column becomes `a OR b OR c`:

```
vendor:"Acme Co" OR vendor:"Beta Ltd"      <- two vendors ticked (OR within one filter)
tag:sale                                   <- AND between different filters
collection_id:123456
```

Reasons: the merchant can see and edit exactly what is applied; it reuses the search that already runs (Shopify's
server query plus the local evaluator in `search-query.ts`); paging, live search and "Select all shown" keep working
unchanged; and nothing new has to be stored.

UI: a button "Add filter" opens a menu of filter types (`s-menu`). Choosing one opens a popover (`s-popover`) with a
search field and a checklist (`s-checkbox` / `s-choice-list`) of values. Applied filters show as removable chips
(`s-chip`) under the search box. All of these components are in the admin extension component set (checked in
`@shopify/ui-extensions`).

## Per filter type

| Filter | Where the values come from | Applied as | Confidence |
|---|---|---|---|
| **Collection** | `collections(first, query)` | `collection_id:N` | High |
| **Vendor** | `shop.productVendors` | `vendor:"..."` | High |
| **Product type** | `shop.productTypes` | `product_type:"..."` | High |
| **Tag** | `shop.productTags` | `tag:"..."` | High |
| **Status** (active / draft / archived) | fixed list | `status:active` | High |
| **Inventory** (in stock / out of stock) | fixed list | `inventory_total:>0` / `=0` | Medium |
| **Metafield, with a definition** | `metafieldDefinitions(ownerType: PRODUCT)` for the list of metafields; values are the problem (below) | `metafields.NAMESPACE.KEY:"value"` | **Low-Medium** |
| **Metafield, without a definition** | none | local text match only | Low |

(Query field names are Shopify's search syntax; I could not open shopify.dev from this environment, so each one must
be confirmed against the live API before it is relied on. A short spike on a dev store settles that in an hour.)

## The hard part: metafields

1. **There is no "list the distinct values of this metafield" call.** Collections, vendors, types and tags have
   dedicated lists. For a metafield the only ways to get its values are: (a) a definition that restricts values to
   choices (a "list of choices" or boolean metafield), which gives the list for free; (b) scanning products and
   collecting the values, which is slow on a large catalog and cost-limited; or (c) letting the merchant type the
   value instead of picking it. I would do (a) and (c): choices when the definition has them, otherwise a text box.
2. **Server-side metafield filtering has conditions.** Shopify documents filtering products by metafield value, but
   only for metafields whose definition has filtering enabled, and with exact, case-sensitive matches. A metafield
   without a definition, or with filtering switched off, cannot be filtered on the server at all.
3. **What the app does today for metafields still applies:** a plain word is matched against every metafield value of
   the products *already loaded this session*. That keeps working for everything the server cannot filter, but it
   cannot see products that were never loaded. The filter menu should say which of the two a metafield filter used.

## Other risks and costs

* **Big lists.** A shop can have thousands of tags or vendors. The popover needs search-as-you-type and paging
  (`first: 50` plus a cursor), not one giant checklist.
* **API cost and permissions.** Each opened filter is one extra GraphQL call (cached after the first open). Reading
  collections and metafield definitions uses the same product-read access the app already has; I expect no new scope,
  but I cannot confirm that from here.
* **Remote-DOM UI limits.** Popovers/menus inside the admin sandbox only get the events listed in the component
  definitions (no hover/paste events, as found with the row-click and paste work). The design above uses only
  click/change events. Nested menu-then-popover behaviour needs a quick check in a real admin.
* **Query length.** Many ticked values make a long query. The pasted-column feature already caps at 50 terms; the same
  cap would apply.
* **Quoting.** Values with spaces/colons/quotes must be quoted correctly; `quoteSearchTerm` (already written and
  tested) does this.
* **No Shopify-style saved views** (named, reusable filter sets) in the first version.

## Suggested stages

1. **Spike (about 2 h):** against your dev store confirm the exact query names for collection / vendor / type / tag /
   status / inventory and the metafield syntax, and whether metafield filtering works for your definitions.
2. **Stage 1 (about 2-3 days):** the menu, popover with search and paging, chips, composition into the search box,
   for collection, vendor, product type, tag, status, inventory.
3. **Stage 2 (about 1-2 days, optional):** metafield filters (choice lists from definitions; typed values otherwise),
   with a visible note when a filter is server-side versus local-cache-only.

## Questions for you

* Which filters do you actually use most? (That decides whether Stage 2 is worth it.)
* Are your metafields defined (with a definition) and, if so, is filtering enabled on them in Settings > Custom data?
  If they are undefined metafields, server-side filtering is not possible and we would rely on the local text match.
* Should several ticked values in one filter mean OR (Shopify's behaviour) -- and between different filters AND?
  (That is what I assumed above.)
* OK to show the filters as editable text in the search box (as above), or do you want them hidden behind chips only?

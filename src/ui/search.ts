// ----------------------------------------------------------------------------------------------
// CLIENT-SIDE PRODUCT SEARCH -- simple substring matching, including metafields
// RETIRED (session 9), per explicit direction: this used to also offer an advanced boolean query
// language (`{{ }}`, `&&`, `||`, `!` -- an OR/AND/NOT grammar over double-brace-delimited groups,
// structurally the same shape as the template if/boolean grammar above but a separate
// implementation with different leaves: substring match vs. numeric/string comparison). It's gone,
// not just hidden: on top of adding real complexity to the search UI, it turned out not to deliver
// what it was actually built for -- combined AND/OR/NOT queries across several metafields at once.
// The reason is architectural, not a parser bug: this app has no server-side full-text index over
// metafield values, so ANY client-side query (boolean or plain) can only match against
// `allLoadedProducts` -- whatever has already been paged/searched into the session cache (see
// LOADED_PRODUCTS_CACHE_LIMIT) -- never the shop's full catalog. A plain substring term still
// degrades usefully in that situation, since the server's own indexed search (`serverQueryFor`,
// also removed) handles the common case and the client-side union only supplements it. A boolean
// expression has no such fallback: `isAdvancedSearch` detects it and sends `query: null` to the
// server outright (there's no Shopify search syntax for arbitrary metafield AND/OR/NOT), so it
// depended ENTIRELY on the product already being in the local cache -- which, for a rare
// metafield combination on a product the merchant hadn't already scrolled past, it usually wasn't.
// What remains (`productMatchesQuery` below) still does everything the plain/simple search path
// always did, including checking every metafield value -- partial string matches on metafields are
// unaffected by this removal; only the `&&`/`||`/`!` combinator syntax is gone.
// ----------------------------------------------------------------------------------------------
// Case-insensitive substring test of a single query term against one product's searchable
// fields: title, handle, vendor, productType, every tag, every variant SKU, and EVERY metafield
// value (which covers the custom location metafields regardless of their stored namespace/key).
function productMatchesQuery(product: ProductData, rawQuery: string): boolean {
  const query = rawQuery.trim().toLowerCase();
  if (query === '') return true;
  const haystacks: string[] = [
    product.title,
    product.handle,
    product.vendor,
    product.productType,
    // The note typed for this product inside a selection is searchable too.
    product.note || '',
    ...product.tags,
  ];
  for (const variant of product.variants) {
    if (variant.sku) haystacks.push(variant.sku);
  }
  for (const mf of product.metafields) {
    if (mf.value) haystacks.push(mf.value);
  }
  return haystacks.some((h) => (h || '').toLowerCase().includes(query));
}


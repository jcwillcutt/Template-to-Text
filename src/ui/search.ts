// Client-side product search: supplements Shopify's own search with products already loaded this session, so a
// word that only appears in a metafield value (which Shopify's text search does not index) still finds them.
// The query language (AND / OR / NOT / "phrases" / parentheses / field:value) is implemented in search-query.ts.
function productMatchesQuery(product: ProductData, rawQuery: string): boolean {
  return matchesSearchQuery(product, rawQuery);
}

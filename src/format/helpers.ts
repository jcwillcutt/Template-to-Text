// Compact display of a product's total inventory for the Qty table column. A product with no
// inventory tracking (null totalInventory) shows an em dash instead of a number.
// ----------------------------------------------------------------------------------------------
// FORMATTING HELPERS -- small pure display/string utilities
// ----------------------------------------------------------------------------------------------
export function formatQty(totalInventory: number | null): string {
  return totalInventory == null ? '—' : String(totalInventory);
}

// One-line preview of a global variable's value for the Global Vars list table (session 23):
// collapses any internal whitespace/newlines to single spaces (so a multi-line value never breaks
// the table row's height) and truncates with an ellipsis past 80 characters.
export function globalVarBodyPreview(body: string): string {
  const collapsed = body.replace(/\s+/g, ' ').trim();
  return collapsed.length > 80 ? `${collapsed.slice(0, 80)}…` : collapsed;
}

// Session 24, per explicit direction: a selection's displayed count is "(v/n)" -- v variants, n
// notes -- rather than a plain product/object count. n=0 omits the note half entirely ("(v)"); any
// n>0 always shows both halves, even when v=0 ("(0/n)"), so v=n=0 reads as "(0)".
export function formatSelectionCount(variantCount: number, noteCount: number): string {
  return noteCount === 0 ? `(${variantCount})` : `(${variantCount}/${noteCount})`;
}

// Builds a link to a product's Shopify Admin edit page from its GraphQL gid
// ("gid://shopify/Product/123...") and the shop's primary domain host (the same value exposed as
// {{ primaryDomain }}), for the product-selection table's "click the title to open the product
// page in a new tab" link. Returns null when either piece isn't available yet (primaryDomain
// hasn't loaded, or the id isn't in the expected gid shape) so the caller can fall back to plain,
// unlinked text instead of rendering a broken link.
export function adminProductUrl(productId: string, primaryDomain: string): string | null {
  if (!primaryDomain) return null;
  const match = /\/Product\/(\d+)$/.exec(productId);
  if (!match) return null;
  return `https://${primaryDomain}/admin/products/${match[1]}`;
}

export function slugify(input: string): string {
  const s = input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || 'template';
}

export function sanitizeExtension(ext: string): string {
  const cleaned = (ext || '').replace(/^\.+/, '').replace(/[^a-zA-Z0-9]/g, '');
  return cleaned || 'txt';
}


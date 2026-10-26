// The UI needs Shopify's runtime to run, so these are source-level wiring checks: they pin the structure the
// UI fixes depend on (a regression here means a fix was undone), alongside the pure helpers tested separately.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const src = fs.readFileSync(path.resolve(import.meta.dirname, '..', '..', 'src', 'ui', 'Extension.tsx'), 'utf8');
const between = (a: string, b: string): string => {
  const i = src.indexOf(a);
  expect(i, a).toBeGreaterThan(-1);
  return src.slice(i, src.indexOf(b, i));
};

describe('global variable editor has the template editor Insert menus', () => {
  const modal = between('id="global-var-modal"', '</s-modal>');
  it('shows both Insert buttons and both menus inside the modal', () => {
    expect(modal).toContain("renderInsertButtons('global-')");
    expect(modal).toContain("renderInsertMenus('global-', insertIntoGlobalBody, false)");
  });
  it('inserts into the global value draft, not the template body', () => {
    expect(src).toMatch(/const insertIntoGlobalBody = [\s\S]{0,80}setGlobalVarBodyDraft\(\(prev\) => insertIntoText\(prev, token\)\)/);
  });
  it('the template editor uses the very same menus (so they cannot drift apart)', () => {
    expect(src).toContain("{renderInsertButtons('')}");
    expect(src).toContain("{renderInsertMenus('', insertVariable, true)}");
    expect(src.match(/id=\{`\$\{prefix\}insert-variable-menu`\}/g)).toHaveLength(1);
  });
  it('menu ids are unique per editor', () => {
    expect(src).toContain('commandFor={`${prefix}insert-variable-menu`}');
    expect(src).toContain('commandFor={`${prefix}insert-special-menu`}');
  });
  it('a global cannot reference another global, so the Global variables section is only for templates', () => {
    expect(src).toContain('withGlobals && globalVars.length > 0');
  });
  it('offers the whitespace-control snippets', () => {
    expect(src).toContain('TRIM_BEFORE_SNIPPET');
    expect(src).toContain('TRIM_AFTER_SNIPPET');
  });
});

// Shopify's admin UI components deliver click events only for interactive elements (s-clickable, s-button,
// s-checkbox, ...). Layout containers such as s-box have NO event props, so handlers placed on them never fire --
// which is exactly how an earlier version broke row clicks. Whole-row click + hover is done with the supported
// `s-table-row clickDelegate` pattern (Shopify's own index-table example).
describe('rows are clickable through clickDelegate, not through layout-container events', () => {
  it('no mouse/click handlers on s-box', () => {
    expect(src).not.toMatch(/<s-box[^>]*\bonClick=/);
    expect(src).not.toMatch(/<s-box[^>]*\bonMouse(Enter|Leave)=/);
    expect(src).not.toMatch(/\bhovered(Product|Template)Id\b/);
  });
});

describe('product list', () => {
  const row = between('const renderProductRow', 'const handleTemplateRowClick');
  it('is a table with a Product column and a Qty column (no separate Handle column to overflow)', () => {
    const list = between('{renderProductPager()}', '{displayedProducts.length > 0 ? renderProductPager()');
    expect(list).toContain('<s-table loading={productsLoading}>');
    expect(list).toContain('<s-table-header listSlot="primary">Product</s-table-header>');
    expect(list).not.toContain('>Handle<');
  });
  it('the row delegates its click to the selection checkbox, so anywhere on the row selects it', () => {
    expect(row).toContain('<s-table-row key={p.id} clickDelegate={checkboxId}>');
    expect(row).toContain('id={checkboxId}');
    expect(row).toContain("rowDomId('product-select', p.id)");
  });
  it('the title is still a link to the admin product page', () => {
    expect(row).toContain('<s-link href={url} onClick={(e: any) => e.stopPropagation()}>');
  });
  it('title, handle, note and variants share one flexible column', () => {
    expect(row).toContain('gridTemplateColumns="auto 1fr"');
  });
  it('the pager is shown above and below the list', () => {
    expect(src.match(/renderProductPager\(\)/g)).toHaveLength(2);
  });
});

describe('template list', () => {
  const list = between('const renderTemplateRow', 'const renderMainView');
  it('every row delegates to the clickable holding its name, and that clickable handles the click', () => {
    expect(list).toContain('<s-table-row key={tpl.id} clickDelegate={selectId}>');
    expect(list).toContain('<s-clickable id={selectId} onClick={() => handleTemplateRowClick(tpl)}>');
    expect(list).toContain("rowDomId('template-select', tpl.id)");
  });
  it('a click selects and a double click opens the editor, via a ref-tracked click record', () => {
    const handler = between('const handleTemplateRowClick', 'const openEditTemplate');
    expect(handler).toContain('registerClick(before, tpl.id, Date.now())');
    expect(handler).toContain('openEditTemplate(tpl)');
  });
  it('a click toggles the template in a multi-selection; a double click undoes that toggle before opening the editor', () => {
    const handler = between('const handleTemplateRowClick', 'const openEditTemplate');
    expect(handler).toContain('prev.includes(tpl.id) ? prev.filter((id: string) => id !== tpl.id) : [...prev, tpl.id]');
    expect(handler).toContain('templateWasSelectedRef.current');
    expect(handler).toContain('if (before !== null && click.next === before) return;');
  });
  it('the actions button and menu live in their own cell (secondary actions)', () => {
    expect(list).toContain('commandFor={`tpl-menu-${tpl.id}`}');
  });
});

describe('product search box', () => {
  it('is a multi-line field (a one-line input flattens pasted line breaks) wired to the live, paste-aware handler', () => {
    const box = between('<s-text-area\n                  label="Search products"', '<s-button onClick={runSearch}>');
    expect(box).toContain('onInput={(e: any) => handleSearchInput(e.currentTarget.value)}');
    // No onChange: it fires on blur, so the first click on a product started a search that reloaded the list under
    // the click and swallowed it.
    expect(box).not.toContain('onChange');
  });
  it('typing searches after a pause; a paste converts to OR and searches immediately', () => {
    const handler = between('const handleSearchInput', 'useEffect(');
    expect(handler).toContain('columnToOrQuery(raw)');
    expect(handler).toContain('applySearchNow(text)');
    expect(handler).toContain('setTimeout(');
    expect(handler).toContain('SEARCH_DEBOUNCE_MS');
  });
  it('the search sent to Shopify never carries a dangling OR from a scan', () => {
    const apply = between('const applySearchNow', 'const runSearch');
    expect(apply).toContain('searchQueryForShopify(text)');
  });
  it('a pending search is cancelled on unmount and replaced by a newer one', () => {
    expect(src).toContain('clearTimeout(searchTimerRef.current)');
  });
  it('the Tab snippet is offered in the Insert menu', () => {
    expect(src).toContain('TAB_TOKEN_SNIPPET');
  });
});

describe('refresh and selection variants', () => {
  it('Refresh Page re-reads products from Shopify instead of the cache, including selected products', () => {
    expect(src).toMatch(/await fetchProducts\(null, 'forward', appliedSearch, true\);\s*await refreshSelectedProductData\(\);/);
    expect(src).toContain('loadProductsByIds(ids, true)');
    expect(src).toContain('skipCache ? undefined : loadedProductsRef.current.byId[id]');
  });
  it('the Selection view shows lists every variant of a multi-variant product with a checkbox for the included ones', () => {
    expect(src).toContain('setSelectionDraftVariant(row.product.id, v.id, e.currentTarget.checked)');
  });
});

describe('multi-template download and selection view controls', () => {
  it('downloads several selected templates through planMultiTemplateDownload using the Download Settings mode', () => {
    expect(src).toContain('planMultiTemplateDownload(');
    expect(src).toContain('downloadMode,');
    expect(src).toContain('<s-choice value="grouped"');
    expect(src).toContain('<s-choice value="alternate"');
    expect(src).toContain('Group downloads by Template');
    expect(src).toContain('Alternate Templates Every Selection');
  });
  it('Settings has a Download Settings button opening the modal', () => {
    const settings = between('const renderSettingsView', 'const renderGlobalVarsView');
    expect(settings).toContain('commandFor="download-settings-modal"');
    expect(settings).toContain('Download Settings');
  });
  it('the Selection view has no remove-X buttons, offers Clear Selected, checkboxes everywhere, and a Reorder toggle after Save', () => {
    const view = between('const renderSelectionView', 'const renderMainView');
    expect(view).not.toContain('icon="x"');
    expect(view).not.toContain('Clear Selection');
    expect(view).toContain('Clear Selected');
    expect(view).toContain('onClick={clearCheckedFromSelectionDraft}');
    expect(view).not.toContain('isPublicSelection ? <s-table-header>Use');
    expect(view.indexOf('Save\n        </s-button>')).toBeLessThan(view.indexOf('Reorder\n        </s-button>'));
    expect(view).toContain("variant={reorderMode ? 'primary' : undefined}");
    expect(view).toContain('{reorderMode ? (');
    expect(view).toContain('{reorderMode ? <s-table-header>Order</s-table-header> : null}');
  });
  it('the reorder arrows start hidden every time a selection opens', () => {
    expect(src).toMatch(/setReorderMode\(false\);\s*setView\('selection'\);/);
  });
});

describe('product title links', () => {
  it('open the product through an in-admin shopify:// link without a new browser tab, and do not toggle the row', () => {
    expect(src).not.toContain('target="_blank"');
    expect(src.match(/onClick=\{\(e: any\) => e\.stopPropagation\(\)\}/g)?.length).toBeGreaterThanOrEqual(3);
  });
});

describe('template folders, move and copy', () => {
  const storage = fs.readFileSync(path.resolve(import.meta.dirname, '..', '..', 'src', 'storage', 'parsing.ts'), 'utf8');
  it('Add opens a menu offering a template or a folder; a folder asks for its name in a popup', () => {
    expect(src).toContain('commandFor="template-add-menu"');
    expect(src).toContain('Add template');
    expect(src).toContain('Add folder');
    expect(src).toContain('<s-modal id="folder-name-modal"');
  });
  it('a folder shows its bold name with a triple-dots menu (rename, delete) and expands its templates on click, indented', () => {
    expect(src).toContain("rowDomId('folder-toggle', folder.id)");
    expect(src).toContain('Rename folder');
    expect(src).toContain('Delete folder');
    expect(src).toContain('if (open) for (const tpl of item.list) rows.push(renderTemplateRow(tpl, true));');
    expect(src).toContain('{renderTemplateRows()}');
    expect(src).toContain("paddingInlineStart={indented ? 'large' : 'none'}");
  });
  it('the template menu has Move (a folder checklist; unchecking returns it to the main list) and Copy template', () => {
    expect(src).toContain('commandFor="move-template-modal"');
    expect(src).toContain('moveTemplateToFolder(movingTemplateId, inFolder ? null : folder.id)');
    expect(src).toContain('Copy template');
    expect(src).toContain('const title = `${template.title} Copy`;');
    expect(src).toMatch(/\.\.\.\(template\.folderId \? \{ folderId: template\.folderId \} : \{\}\)/);
  });
  it('deleting a folder moves its templates to the main list; editing a template keeps its folder', () => {
    expect(src).toContain('const { folderId: _removed, ...rest } = t;');
    expect(src).toContain('// Editing a template keeps it in its folder.');
  });
  it('the folder is stored on the template only when set', () => {
    expect(storage).toContain('...(t.folderId ? { folderId: t.folderId } : {})');
  });
});

describe('searched variant highlight', () => {
  it('shades the variant whose sku or barcode equals the search', () => {
    expect(src).toContain('variantMatchesSearch(v, searchedValues)');
    expect(src).toContain("'strong' : 'transparent'");
  });
});

describe('folder menu: add/remove selected templates', () => {
  it('has both buttons wired to the selected templates', () => {
    expect(src).toContain('onClick={() => addSelectedToFolder(folder.id)}');
    expect(src).toContain('onClick={() => removeSelectedFromFolder(folder.id)}');
    const add = between('const addSelectedToFolder', 'const removeSelectedFromFolder');
    expect(add).toContain('picked.has(t.id) && t.folderId !== folderId ? { ...t, folderId } : t');
    const remove = between('const removeSelectedFromFolder', '// A new template with');
    expect(remove).toContain('!picked.has(t.id) || t.folderId !== folderId');
  });
});

describe('folder pinning and icon', () => {
  it('a folder can be pinned from its menu and shows a large bold arrow beside a bold name', () => {
    expect(src).toContain('onClick={() => toggleFolderPin(folder)}');
    expect(src).toContain("<s-heading>{open ? '▼' : '▶'}</s-heading>");
    expect(src).toContain('<s-text type="strong">{folder.name}</s-text>');
    expect(src).not.toContain('📁');
    expect(src).not.toContain('📂');
  });
});

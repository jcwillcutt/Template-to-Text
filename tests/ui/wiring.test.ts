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
    expect(row).toContain('<s-link href={url} target="_blank">');
  });
  it('title, handle, note and variants share one flexible column', () => {
    expect(row).toContain('gridTemplateColumns="auto 1fr"');
  });
  it('the pager is shown above and below the list', () => {
    expect(src.match(/renderProductPager\(\)/g)).toHaveLength(2);
  });
});

describe('template list', () => {
  const list = between('templateGroups.list.map((tpl) => {', '</s-menu>');
  it('every row delegates to the clickable holding its name, and that clickable handles the click', () => {
    expect(list).toContain('<s-table-row key={tpl.id} clickDelegate={selectId}>');
    expect(list).toContain('<s-clickable id={selectId} onClick={() => handleTemplateRowClick(tpl)}>');
    expect(list).toContain("rowDomId('template-select', tpl.id)");
  });
  it('a click selects and a double click opens the editor, via a ref-tracked click record', () => {
    const handler = between('const handleTemplateRowClick', 'const openEditTemplate');
    expect(handler).toContain('registerClick(lastTemplateClickRef.current, tpl.id, Date.now())');
    expect(handler).toContain('openEditTemplate(tpl)');
    expect(handler).toContain('setSelectedTemplateId(tpl.id)');
  });
  it('the actions button and menu live in their own cell (secondary actions)', () => {
    expect(list).toContain('commandFor={`tpl-menu-${tpl.id}`}');
  });
});

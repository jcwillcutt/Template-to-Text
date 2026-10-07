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

describe('product list', () => {
  const row = between('const renderProductRow', 'const handleTemplateRowClick');
  it('is no longer an s-table (its Handle/Qty columns overflowed the column)', () => {
    expect(between('{renderProductPager()}', '{displayedProducts.length > 0 ? renderProductPager()')).not.toContain('<s-table');
  });
  it('a click anywhere on the row toggles it, except on interactive children', () => {
    expect(row).toContain('onClick={(e: any) => {');
    expect(row).toContain('if (isInteractiveTarget(e.target)) return;');
    expect(row).toContain('toggleProduct(p, !isSelected)');
  });
  it('highlights on hover', () => {
    expect(row).toContain("background={hoveredProductId === p.id ? 'subdued' : undefined}");
    expect(row).toContain('onMouseEnter');
    expect(row).toContain('onMouseLeave');
  });
  it('the title is still a link to the admin product page', () => {
    expect(row).toContain('<s-link href={url} target="_blank">');
  });
  it('title, handle, note and variants share one flexible column; quantity is its own column', () => {
    expect(row).toContain('gridTemplateColumns="auto 1fr auto"');
  });
  it('the pager is shown above and below the list', () => {
    expect(src.match(/renderProductPager\(\)/g)).toHaveLength(2);
  });
});

describe('template list', () => {
  const list = between('templateGroups.list.map((tpl, index) => {', '</s-menu>');
  it('selects on a click anywhere on the row and highlights on hover', () => {
    expect(list).toContain('onClick={(e: any) => handleTemplateRowClick(e, tpl)}');
    expect(list).toContain("isSelected || hoveredTemplateId === tpl.id ? 'subdued' : undefined");
  });
  it('the inner clickable no longer selects by itself (it would double-count clicks)', () => {
    expect(list).not.toContain('onClick={() => setSelectedTemplateId(tpl.id)}');
  });
  it('a double click opens the editor, using a ref-tracked click record', () => {
    const handler = between('const handleTemplateRowClick', 'const openEditTemplate');
    expect(handler).toContain('registerClick(lastTemplateClickRef.current, tpl.id, Date.now())');
    expect(handler).toContain('openEditTemplate(tpl)');
    expect(handler).toContain("isInteractiveTarget(e.target, 's-button, s-menu, a')");
  });
});

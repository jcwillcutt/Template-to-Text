// Small rendering helpers for behavior tests (new engine only).
import type { FileBreak, ProductData, SelectionEntry } from '../../src/domain/types';
import { planOutputFiles } from '../../src/engine/index';
import { FIXED_NOW, makeProduct } from './fixtures';

export interface RenderOpts {
  products?: ProductData[];
  notes?: SelectionEntry[];
  fileBreak?: FileBreak;
  merge?: string;
  globals?: Record<string, string>;
  now?: Date;
}

export function renderAll(body: string, o: RenderOpts = {}): { contents: string[]; names: string[]; zipName: string | null; count: number } {
  const plan = planOutputFiles(
    'Tpl',
    body,
    'txt',
    o.products ?? [makeProduct(1)],
    o.notes ?? [],
    o.fileBreak ?? 'selection',
    o.merge ?? '',
    'shop.myshopify.com',
    o.now ?? FIXED_NOW,
    o.globals ?? {},
  );
  const contents: string[] = [];
  const names: string[] = [];
  for (let i = 0; i < plan.count; i++) {
    const f = plan.build(i);
    contents.push(f.content);
    names.push(f.name);
  }
  return { contents, names, zipName: plan.zipName, count: plan.count };
}

// Render a body once over the given products in 'selection' mode and return the single file.
export function render(body: string, o: RenderOpts = {}): string {
  const r = renderAll(body, { fileBreak: 'selection', ...o });
  if (r.count !== 1) throw new Error(`expected 1 file, got ${r.count}`);
  return r.contents[0];
}

// Render once per product ('product' mode) and return the contents.
export const renderEach = (body: string, products: ProductData[], o: RenderOpts = {}): string[] =>
  renderAll(body, { fileBreak: 'product', products, ...o }).contents;

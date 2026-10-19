// Run the same template through the legacy engine (the oracle) and the new engine and compare.
import type { FileBreak, ProductData, SelectionEntry } from '../../src/domain/types';
import { loadLegacyEngine } from './legacy-oracle';
import * as next from '../../src/engine/index';
import { FIXED_NOW } from './fixtures';

export interface RunOpts {
  products: ProductData[];
  notes?: SelectionEntry[];
  fileBreak?: FileBreak;
  merge?: string;
  globals?: Record<string, string>;
  title?: string;
  ext?: string;
  now?: Date;
}

export interface RunResult {
  count: number;
  zipName: string | null;
  names: string[];
  contents: string[];
  sourceIds: string[][];
  error?: string;
}

type Engine = { planOutputFiles: (...a: any[]) => any };

export function run(engine: Engine, body: string, o: RunOpts): RunResult {
  try {
    const plan = engine.planOutputFiles(
      o.title ?? 'My Template',
      body,
      o.ext ?? 'txt',
      o.products,
      o.notes ?? [],
      o.fileBreak ?? 'product',
      o.merge ?? '',
      'shop.myshopify.com',
      o.now ?? FIXED_NOW,
      o.globals ?? {},
    );
    const names: string[] = [];
    const contents: string[] = [];
    for (let i = 0; i < plan.count; i++) {
      const f = plan.build(i);
      names.push(f.name);
      contents.push(f.content);
    }
    return { count: plan.count, zipName: plan.zipName, names, contents, sourceIds: plan.sourceIdsByIndex };
  } catch (e: any) {
    return { count: -1, zipName: null, names: [], contents: [], sourceIds: [], error: String(e?.message ?? e) };
  }
}

export const runLegacy = (body: string, o: RunOpts): RunResult => run(loadLegacyEngine(), body, o);
export const runNext = (body: string, o: RunOpts): RunResult => run(next, body, o);

// The legacy engine leaves invisible loop-signal control characters (U+0003/U+0004) in output when
// {{ break }}/{{ skip }} is used outside a loop; the new engine does not emit them.
export const stripControl = (s: string): string => s.replace(/[\u0003\u0004]/g, '');

export function normalizeLegacy(r: RunResult): RunResult {
  return { ...r, contents: r.contents.map(stripControl) };
}

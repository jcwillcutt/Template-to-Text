// Output-file planning: how many files a template + selection produces, what they are called, and a lazy
// builder that renders exactly one file on demand. The download button and the editor preview both go
// through this, so a preview always matches what a download would produce.

import type { FileBreak, ProductData, SelectionEntry } from '../domain/types';
import { sanitizeExtension, slugify } from '../format/helpers';
import { scopeOf, type Cond, type KindedRow, type RowKind } from './ast';
import {
  EMPTY_ROW,
  createCtx,
  createEnv,
  evalConditionTrue,
  foreachFilteredItems,
  renderRoot,
} from './evaluate';
import { compileTemplate, parseCond } from './parse';
import {
  dedupeNames,
  expandSelectionToRows,
  noteFileSlug,
  noteToPseudoProduct,
} from './rows';
import { formatTimestamp, type ZipEntry } from './zip';

// The full set of output files for a template + product selection. `zipName` is null when the output is a
// single file, otherwise it is the name of the ZIP archive that packages the files.
export interface OutputFiles {
  files: ZipEntry[];
  zipName: string | null;
}

// A LAZY plan of the output files (see the file comment).
export interface FilePlan {
  count: number;
  zipName: string | null;
  build: (index: number) => ZipEntry;
  // The object (product/variant/note) id(s) each planned file actually reads, index-aligned with `build`.
  // Only used for History logging. May contain duplicates within one file's list.
  sourceIdsByIndex: string[][];
}

// One renderable unit for a per-unit fileBreak mode, plus its extension-less base filename.
interface RenderUnit {
  row: ProductData;
  kind: RowKind;
  baseName: string;
}

function productUnits(products: ProductData[], titleSlug: string): RenderUnit[] {
  return products.map((p) => ({
    row: { ...p, variants: p.variants.length > 0 ? p.variants : p.allVariants },
    kind: 'product' as RowKind,
    baseName: `${p.handle}_${titleSlug}`,
  }));
}

function noteUnits(notes: SelectionEntry[], titleSlug: string): RenderUnit[] {
  return notes.map((n) => ({
    row: noteToPseudoProduct(n),
    kind: 'note' as RowKind,
    baseName: `${noteFileSlug(n)}_${titleSlug}`,
  }));
}

// Partition an ordered list of rows into contiguous groups by evaluating the Merge IF condition between
// every adjacent pair: TRUE merges the next item into the current group; FALSE, an unparseable condition
// or an empty condition starts a new group. Every evaluation gets a fresh variable store -- this is a
// planning-phase decision, separate from any real render.
export function partitionByMergeCondition(
  items: KindedRow[],
  mergeCondition: string,
  selectionLength: number,
  primaryDomain: string,
  now: Date,
): number[][] {
  const groups: number[][] = [];
  if (items.length === 0) return groups;
  const text = mergeCondition.trim();
  const cond: Cond | null = text === '' ? null : parseCond(text);
  // One shared list of rows for every probe (the legacy engine rebuilt it per pair: O(n^2)).
  const env = createEnv(
    items.map((it) => it.row),
    'variant',
    [],
  );
  let current: number[] = [0];
  for (let i = 0; i < items.length - 1; i++) {
    let merge = false;
    if (cond !== null) {
      const ctx = createCtx(env, {
        now,
        primaryDomain,
        selectionLength,
        currKind: items[i].kind,
        prev: i > 0 ? items[i - 1] : null,
        next: items[i + 1],
      });
      merge = evalConditionTrue(cond, ctx, scopeOf(items[i].row));
    }
    if (merge) {
      current.push(i + 1);
    } else {
      groups.push(current);
      current = [i + 1];
    }
  }
  groups.push(current);
  return groups;
}

// COMBINED ('selection' file break): the template body runs once over the whole selection, optionally
// split into several files by Merge IF over the first selection loop's items.
function planCombined(
  body: string,
  products: ProductData[],
  notes: SelectionEntry[],
  mergeCondition: string,
  selectionLength: number,
  primaryDomain: string,
  now: Date,
  globalBodiesByTitle: Record<string, string>,
): { fileCount: number; render: (fileIndex: number | null) => string; sourceIdsByIndex: string[][] } {
  const rows = expandSelectionToRows(products);
  const first = rows[0] ?? EMPTY_ROW;
  const compiled = compileTemplate(body, globalBodiesByTitle);
  const env = createEnv(rows, 'variant', notes);

  const iteratedItems = compiled.firstForeach ? foreachFilteredItems(compiled.firstForeach, env) : null;
  const groups = iteratedItems
    ? partitionByMergeCondition(iteratedItems, mergeCondition, selectionLength, primaryDomain, now)
    : null;
  // An EMPTY Merge IF means exactly one file for 'selection' mode (grouping is opt-in).
  const grouped = mergeCondition.trim() !== '' && groups != null && groups.length > 1;
  const fileCount = grouped ? (groups as number[][]).length : 1;

  const sourceIdsByIndex: string[][] = grouped
    ? (groups as number[][]).map((g) => g.map((i) => (iteratedItems as KindedRow[])[i].row.id))
    : [iteratedItems ? iteratedItems.map((item) => item.row.id) : first !== EMPTY_ROW ? [first.id] : []];

  const render = (fileIndex: number | null): string => {
    // Every output file starts from a FRESH variable store, so one file never leaks values into the next.
    const ctx = createCtx(env, { now, primaryDomain, selectionLength, currKind: 'variant', prev: null, next: null });
    const group = grouped && fileIndex != null ? (groups as number[][])[fileIndex] : null;
    if (group && compiled.firstForeach) {
      ctx.window = { node: compiled.firstForeach, from: group[0], to: group[group.length - 1] + 1 };
    }
    return renderRoot(compiled.root, ctx, scopeOf(first));
  };

  return { fileCount, render, sourceIdsByIndex };
}

export function planOutputFiles(
  templateTitle: string,
  templateBody: string,
  templateExtension: string,
  products: ProductData[],
  notes: SelectionEntry[],
  fileBreak: FileBreak | null,
  mergeCondition: string,
  primaryDomain: string,
  now: Date,
  globalBodiesByTitle: Record<string, string>,
): FilePlan {
  // A template whose file break was never explicitly chosen is refused rather than guessed. `count: 1`
  // (not 0) guarantees `build` is called once, so the throw reaches the caller's try/catch and surfaces
  // the "could not be generated" banner instead of nothing happening.
  if (fileBreak === null) {
    return {
      count: 1,
      zipName: null,
      build: () => {
        throw new Error(
          'This template has no file break selected. Open it in the editor and choose one under ' +
            'File break before downloading or previewing it.',
        );
      },
      sourceIdsByIndex: [],
    };
  }
  const ext = sanitizeExtension(templateExtension);
  const titleSlug = slugify(templateTitle);
  const timestamp = formatTimestamp(now);
  // {{ selection.length }} is the number of PRODUCTS selected, regardless of file break and notes.
  const selectionLength = products.length;

  if (fileBreak === 'selection') {
    const combined = planCombined(
      templateBody,
      products,
      notes,
      mergeCondition,
      selectionLength,
      primaryDomain,
      now,
      globalBodiesByTitle,
    );
    if (combined.fileCount <= 1) {
      const name =
        products.length === 1
          ? `${products[0].handle}_${titleSlug}.${ext}`
          : `${timestamp}_looped_${titleSlug}.${ext}`;
      return {
        count: 1,
        zipName: null,
        build: () => ({ name, content: combined.render(null) }),
        sourceIdsByIndex: combined.sourceIdsByIndex,
      };
    }
    return {
      count: combined.fileCount,
      zipName: `${titleSlug}_zipped_${timestamp}.zip`,
      build: (index: number) => ({
        name: `${timestamp}_looped_${titleSlug}_${index}.${ext}`,
        content: combined.render(index),
      }),
      sourceIdsByIndex: combined.sourceIdsByIndex,
    };
  }

  // Every other mode renders one unit -- a variant row, a whole product, a note, or products then notes.
  const compiled = compileTemplate(templateBody, globalBodiesByTitle);
  let units: RenderUnit[];
  if (fileBreak === 'variant') {
    units = expandSelectionToRows(products).map((row) => {
      const rowVariant = row.variants[0];
      const variantSuffix = rowVariant ? `_${slugify(rowVariant.title)}` : '';
      return { row, kind: 'variant' as RowKind, baseName: `${row.handle}${variantSuffix}_${titleSlug}` };
    });
  } else if (fileBreak === 'product') {
    units = productUnits(products, titleSlug);
  } else if (fileBreak === 'note') {
    units = noteUnits(notes, titleSlug);
  } else {
    // 'object': every product (selection order), then every note (selection order).
    units = [...productUnits(products, titleSlug), ...noteUnits(notes, titleSlug)];
  }

  if (units.length === 0) {
    return {
      count: 0,
      zipName: null,
      build: () => {
        throw new Error('No files to build for this selection and file-break mode.');
      },
      sourceIdsByIndex: [],
    };
  }

  // A non-empty Merge IF switches ALL naming to the chunked-file convention, so a template's naming scheme
  // can't flip-flop depending on what a runtime merge decision happens to do.
  const kindedUnits: KindedRow[] = units.map((u) => ({ row: u.row, kind: u.kind }));
  const merging = mergeCondition.trim() !== '';
  const groups = partitionByMergeCondition(kindedUnits, mergeCondition, selectionLength, primaryDomain, now);
  const renderUnit = (unitIndex: number): string => {
    const current = kindedUnits[unitIndex];
    // Each unit is rendered with itself as the whole selection; its true neighbours feed selection.prev/next.
    const ctx = createCtx(createEnv([current.row], current.kind, []), {
      now,
      primaryDomain,
      selectionLength,
      currKind: current.kind,
      prev: unitIndex > 0 ? kindedUnits[unitIndex - 1] : null,
      next: unitIndex < kindedUnits.length - 1 ? kindedUnits[unitIndex + 1] : null,
    });
    return renderRoot(compiled.root, ctx, scopeOf(current.row));
  };
  const renderGroup = (group: number[]): string => {
    let out = '';
    for (const unitIndex of group) out += renderUnit(unitIndex);
    return out;
  };

  if (!merging) {
    if (units.length === 1) {
      const { baseName } = units[0];
      return {
        count: 1,
        zipName: null,
        build: () => ({ name: `${baseName}.${ext}`, content: renderGroup([0]) }),
        sourceIdsByIndex: [[units[0].row.id]],
      };
    }
    const names = dedupeNames(units.map((u) => u.baseName)).map((base) => `${base}.${ext}`);
    return {
      count: units.length,
      zipName: `${titleSlug}_zipped_${timestamp}.zip`,
      build: (index: number) => ({ name: names[index], content: renderGroup([index]) }),
      sourceIdsByIndex: units.map((u) => [u.row.id]),
    };
  }
  if (groups.length === 1) {
    const name = `${timestamp}_looped_${titleSlug}.${ext}`;
    return {
      count: 1,
      zipName: null,
      build: () => ({ name, content: renderGroup(groups[0]) }),
      sourceIdsByIndex: [groups[0].map((i) => kindedUnits[i].row.id)],
    };
  }
  return {
    count: groups.length,
    zipName: `${titleSlug}_zipped_${timestamp}.zip`,
    build: (index: number) => ({
      name: `${timestamp}_looped_${titleSlug}_${index}.${ext}`,
      content: renderGroup(groups[index]),
    }),
    sourceIdsByIndex: groups.map((g) => g.map((i) => kindedUnits[i].row.id)),
  };
}

// Build every planned file at once (used by the editor preview).
export function buildOutputFiles(
  templateTitle: string,
  templateBody: string,
  templateExtension: string,
  products: ProductData[],
  notes: SelectionEntry[],
  fileBreak: FileBreak | null,
  mergeCondition: string,
  primaryDomain: string,
  now: Date,
  globalBodiesByTitle: Record<string, string>,
): OutputFiles {
  const plan = planOutputFiles(
    templateTitle,
    templateBody,
    templateExtension,
    products,
    notes,
    fileBreak,
    mergeCondition,
    primaryDomain,
    now,
    globalBodiesByTitle,
  );
  const files: ZipEntry[] = [];
  for (let index = 0; index < plan.count; index++) files.push(plan.build(index));
  return { files, zipName: plan.zipName };
}

// Yield control back to the browser so it can paint between generated files. The extension sandbox has no
// Web Workers, so this is how generation stays responsive and reports progress.
export function yieldToBrowser(): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

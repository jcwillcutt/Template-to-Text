// Downloading several templates at once: one ZIP that either groups the output by template or interleaves the
// templates object by object. Built on planOutputFiles, so every file is exactly what a single-template download
// would produce.

import type { FileBreak, ProductData, SelectionEntry } from '../domain/types';
import { planOutputFiles, type FilePlan } from './plan';
import { formatTimestamp, type ZipEntry } from './zip';

export type MultiDownloadMode = 'grouped' | 'alternate';

export interface MultiTemplateInput {
  title: string;
  body: string;
  extension: string;
  fileBreak: FileBreak | null;
  mergeCondition: string;
}

interface Slot {
  plan: number;
  file: number;
  // Folder (with trailing slash) the file goes into, '' for the archive root.
  folder: string;
  // Text put in front of the file's own name ('' or a zero-padded sequence number).
  prefix: string;
}

export function planMultiTemplateDownload(
  templates: MultiTemplateInput[],
  products: ProductData[],
  notes: SelectionEntry[],
  primaryDomain: string,
  now: Date,
  globalBodiesByTitle: Record<string, string>,
  mode: MultiDownloadMode,
): FilePlan {
  const timestamp = formatTimestamp(now);
  const plans = templates
    .map((t) => ({
      type: t.fileBreak ?? 'unset',
      plan: planOutputFiles(t.title, t.body, t.extension, products, notes, t.fileBreak, t.mergeCondition, primaryDomain, now, globalBodiesByTitle),
    }))
    .filter((p) => p.plan.count > 0);

  const slots: Slot[] = [];
  if (mode === 'grouped') {
    plans.forEach((p, plan) => {
      const folder = p.plan.zipName ? p.plan.zipName.replace(/\.zip$/i, '') + '/' : '';
      for (let file = 0; file < p.plan.count; file++) slots.push({ plan, file, folder, prefix: '' });
    });
  } else {
    const types: string[] = [];
    for (const p of plans) if (types.indexOf(p.type) === -1) types.push(p.type);
    for (const type of types) {
      const members: number[] = [];
      plans.forEach((p, i) => {
        if (p.type === type) members.push(i);
      });
      const folder = types.length > 1 ? `${type}-${timestamp}/` : '';
      const total = members.reduce((sum, m) => sum + plans[m].plan.count, 0);
      const width = String(total).length;
      let seq = 0;
      const most = Math.max(...members.map((m) => plans[m].plan.count));
      for (let file = 0; file < most; file++) {
        for (const m of members) {
          if (file >= plans[m].plan.count) continue;
          seq += 1;
          slots.push({ plan: m, file, folder, prefix: String(seq).padStart(width, '0') + '_' });
        }
      }
    }
  }

  const used = new Set<string>();
  const uniqueName = (name: string): string => {
    if (!used.has(name)) {
      used.add(name);
      return name;
    }
    const dot = name.lastIndexOf('.');
    const stem = dot > name.lastIndexOf('/') ? name.slice(0, dot) : name;
    const ext = dot > name.lastIndexOf('/') ? name.slice(dot) : '';
    let n = 1;
    while (used.has(`${stem}_${n}${ext}`)) n += 1;
    const unique = `${stem}_${n}${ext}`;
    used.add(unique);
    return unique;
  };

  return {
    count: slots.length,
    zipName: `multiple-templates-${timestamp}.zip`,
    build: (index: number): ZipEntry => {
      const slot = slots[index];
      const entry = plans[slot.plan].plan.build(slot.file);
      return { name: uniqueName(slot.folder + slot.prefix + entry.name), content: entry.content };
    },
    sourceIdsByIndex: slots.map((s) => plans[s.plan].plan.sourceIdsByIndex[s.file] || []),
  };
}

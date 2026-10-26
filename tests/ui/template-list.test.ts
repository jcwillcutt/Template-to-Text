import { describe, it, expect } from 'vitest';
import { orderTemplateList } from '../../src/ui/template-list';
import type { TemplateData, TemplateFolder } from '../../src/domain/types';

const t = (id: string, o: Partial<TemplateData> = {}): TemplateData => ({
  id, title: id, body: '', extension: 'txt', pinned: false, pinnedAt: null, fileBreak: 'product', mergeCondition: '', ...o,
});
const label = (items: ReturnType<typeof orderTemplateList>): string[] =>
  items.map((i) => (i.kind === 'template' ? i.tpl.id : `[${i.folder.id}:${i.list.map((x) => x.id).join(',')}]`));

describe('orderTemplateList', () => {
  const folders: TemplateFolder[] = [{ id: 'F1', name: 'F1' }, { id: 'F2', name: 'F2' }];
  it('puts pinned templates first, then unpinned folders, then the other templates', () => {
    const list = [t('a'), t('b', { pinned: true, pinnedAt: 5 }), t('c', { folderId: 'F1' }), t('d')];
    expect(label(orderTemplateList(list, folders, '', 'old-new'))).toEqual(['b', '[F1:c]', '[F2:]', 'a', 'd']);
  });
  it('a pinned folder sorts among the pinned templates by pin time (newest first)', () => {
    const list = [t('a', { pinned: true, pinnedAt: 10 }), t('b', { pinned: true, pinnedAt: 1 }), t('c')];
    const pinnedFolders: TemplateFolder[] = [{ id: 'F1', name: 'F1', pinned: true, pinnedAt: 5 }, { id: 'F2', name: 'F2' }];
    expect(label(orderTemplateList(list, pinnedFolders, '', 'old-new'))).toEqual(['a', '[F1:]', 'b', '[F2:]', 'c']);
  });
  it('a pinned template inside a folder stays inside that folder, pinned first', () => {
    const list = [t('a', { folderId: 'F1' }), t('b', { folderId: 'F1', pinned: true, pinnedAt: 1 }), t('c')];
    expect(label(orderTemplateList(list, folders, '', 'old-new'))).toEqual(['[F1:b,a]', '[F2:]', 'c']);
  });
  it('a template whose folder is gone appears in the main list', () => {
    expect(label(orderTemplateList([t('a', { folderId: 'GONE' })], [], '', 'old-new'))).toEqual(['a']);
  });
  it('a search shows one flat list of matches', () => {
    const list = [t('apple', { folderId: 'F1' }), t('banana'), t('apricot', { pinned: true, pinnedAt: 1 })];
    expect(label(orderTemplateList(list, folders, 'ap', 'a-z'))).toEqual(['apple', 'apricot'].sort());
  });
  it('applies the chosen sort to unpinned templates', () => {
    const list = [t('b'), t('a'), t('c')];
    expect(label(orderTemplateList(list, [], '', 'a-z'))).toEqual(['a', 'b', 'c']);
    expect(label(orderTemplateList(list, [], '', 'new-old'))).toEqual(['c', 'a', 'b']);
  });
});
